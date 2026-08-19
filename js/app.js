import {
  fetchPositioning,
  normalizeTrain
} from "./fgc-api.js?v=3.2.0";

import {
  wirePUV,
  renderPUV
} from "./puv.js?v=3.2.0";

import {
  loadLIT,
  tickLIT
} from "./lit.js?v=3.1.0";

const S = {
  config: null,
  network: null,

  trains: [],
  rawCount: 0,
  apiTotal: null,

  lastFetch: null,
  lastError: null,
  lastLatencyMs: null,

  activeView: "lit",
  selected: null,
  puvFilters: {
    lines: new Set(),
    units: new Set()
  }
};

const $ = selector => document.querySelector(selector);

let refreshTimer = null;
let activeController = null;
let refreshRunning = false;

async function loadStaticData() {
  const [configResponse, networkResponse] = await Promise.all([
    fetch("data/config.json?v=3.2.0", { cache: "no-store" }),
    fetch("data/network.json?v=3.1.0", { cache: "no-store" })
  ]);

  if (!configResponse.ok) {
    throw new Error(`config.json HTTP ${configResponse.status}`);
  }

  if (!networkResponse.ok) {
    throw new Error(`network.json HTTP ${networkResponse.status}`);
  }

  S.config = await configResponse.json();
  S.network = await networkResponse.json();
}

function setupClock() {
  const tick = () => {
    $("#clock").textContent = new Date().toLocaleTimeString("es-ES", {
      hour12: false
    });
  };

  tick();
  setInterval(tick, 1000);
}

function showView(name) {
  S.activeView = name;

  document.querySelectorAll(".tab").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.view === name
    );
  });

  document.querySelectorAll(".view").forEach(view => {
    view.classList.toggle(
      "active",
      view.id === `view-${name}`
    );
  });
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach(button => {
    button.addEventListener("click", () => {
      showView(button.dataset.view);
    });
  });
}

function setupLIT() {
  const input = $("#circulationInput");
  const button = $("#loadLit");

  const load = () => {
    const circulation = input.value
      .trim()
      .toUpperCase();

    if (!circulation) return;

    loadLIT(S, circulation);
  };

  input.addEventListener("input", () => {
    input.value = input.value
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 4)
      .toUpperCase();
  });

  input.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      load();
    }
  });

  button.addEventListener("click", load);
}

function setupDiagnostics() {
  const hotspot = $("#diagHotspot");
  const dialog = $("#diag");
  let holdTimer = null;

  const open = () => {
    $("#diagText").textContent = [
      "SIM+ Beta 3.2",
      `Vista: ${S.activeView}`,
      `Registres API llegits: ${S.rawCount}`,
      `Total API: ${S.apiTotal ?? "—"}`,
      `BV vàlids: ${S.trains.length}`,
      `Última consulta: ${
        S.lastFetch
          ? S.lastFetch.toLocaleTimeString("es-ES", { hour12: false })
          : "—"
      }`,
      `Latència: ${
        S.lastLatencyMs === null ? "—" : `${S.lastLatencyMs} ms`
      }`,
      `Error: ${S.lastError || "—"}`,
      `LIT: ${S.selected?.circulation || "—"}`
    ].join("\n");

    dialog.showModal();
  };

  const start = () => {
    holdTimer = setTimeout(open, 900);
  };

  const cancel = () => {
    clearTimeout(holdTimer);
  };

  hotspot.addEventListener("pointerdown", start);
  hotspot.addEventListener("pointerup", cancel);
  hotspot.addEventListener("pointercancel", cancel);
  hotspot.addEventListener("pointerleave", cancel);

  $("#closeDiag").addEventListener("click", () => dialog.close());
}

function dedupeByTripId(trains) {
  const map = new Map();

  for (const train of trains) {
    map.set(train.id, train);
  }

  return [...map.values()];
}

function scheduleNext(delay = S.config.refreshMs) {
  clearTimeout(refreshTimer);

  if (document.hidden) return;

  refreshTimer = setTimeout(() => {
    refreshPositioning();
  }, delay);
}

async function refreshPositioning({ immediateRetry = false } = {}) {
  if (refreshRunning || document.hidden) return;

  refreshRunning = true;

  activeController?.abort();
  activeController = new AbortController();

  const timeoutId = setTimeout(
    () => activeController.abort(),
    S.config.requestTimeoutMs
  );

  const started = performance.now();

  try {
    const result = await fetchPositioning(
      S.config.positioningUrl,
      S.config,
      { signal: activeController.signal }
    );

    S.rawCount = result.rows.length;
    S.apiTotal = result.total;

    S.trains = dedupeByTripId(
      result.rows
        .map(row => normalizeTrain(row, S.config))
        .filter(Boolean)
    );

    S.lastFetch = new Date();
    S.lastLatencyMs = Math.round(performance.now() - started);
    S.lastError = null;

    renderPUV(S);

    if (S.selected?.circulation) {
      const live = S.trains.find(
        train => train.circulation === S.selected.circulation
      );

      if (live) {
        S.selected.live = live;
        $("#utTop").textContent = live.unit;
      }
    }
  } catch (error) {
    if (error?.name !== "AbortError") {
      S.lastError = String(error?.message || error);
      renderPUV(S);
    }
  } finally {
    clearTimeout(timeoutId);
    refreshRunning = false;

    scheduleNext(
      immediateRetry
        ? Math.min(1000, S.config.refreshMs)
        : S.config.refreshMs
    );
  }
}

function setupConnectivity() {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearTimeout(refreshTimer);
      activeController?.abort();
      return;
    }

    refreshPositioning({ immediateRetry: true });
  });

  window.addEventListener("online", () => {
    refreshPositioning({ immediateRetry: true });
  });

  window.addEventListener("offline", () => {
    S.lastError = "Sense connexió";
    renderPUV(S);
  });
}

async function init() {
  await loadStaticData();

  setupClock();
  setupTabs();
  setupLIT();
  wirePUV(S);
  setupDiagnostics();
  setupConnectivity();

  renderPUV(S);

  // Primera consulta inmediata, sin esperar al primer intervalo.
  await refreshPositioning();

  // El contador de LIT necesita más resolución que la consulta FGC.
  setInterval(() => tickLIT(S), 250);
}

init().catch(error => {
  S.lastError = String(error?.message || error);

  const status = $("#puvStatus");
  if (status) {
    status.textContent = "ERROR D'INICIALITZACIÓ";
    status.classList.add("error");
  }

  console.error(error);
});
