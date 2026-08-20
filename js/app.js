import {
  fetchPositioning,
  normalizeTrain
} from "./fgc-api.js?v=3.4.0";

import {
  wirePUV,
  renderPUV,
  revealSearchedTrain
} from "./puv.js?v=3.4.0";

import {
  clearLIT,
  loadLIT,
  tickLIT
} from "./lit.js?v=3.4.0";

import {
  updateOccupancy
} from "./occupancy.js?v=3.4.0";

import {
  BackgroundAudio
} from "./audio.js?v=3.4.0";

const S = {
  config: null,
  network: null,

  trains: [],
  rawCount: 0,
  apiTotal: null,

  lastFetch: null,
  lastError: null,
  lastLatencyMs: null,

  activeView: "puv",
  selected: null,

  puvFilters: {
    lines: new Set(),
    units: new Set()
  },

  query: {
    code: "",
    state: "empty",
    train: null,
    requestId: 0
  }
};

const $ = selector => document.querySelector(selector);

let refreshTimer = null;
let activeController = null;
let refreshRunning = false;
let refreshPromise = null;
let audio = null;

function setupClock() {
  const tick = () => {
    $("#clock").textContent = new Date().toLocaleTimeString(
      "es-ES",
      { hour12: false }
    );
  };

  tick();
  setInterval(tick, 1000);
}

async function loadStaticData() {
  const [configResponse, networkResponse] = await Promise.all([
    fetch("data/config.json?v=3.4.0", { cache: "no-store" }),
    fetch("data/network.json?v=3.0.0", { cache: "no-store" })
  ]);

  if (!configResponse.ok) {
    throw new Error(`config.json HTTP ${configResponse.status}`);
  }

  S.config = await configResponse.json();

  if (networkResponse.ok) {
    S.network = await networkResponse.json();
  } else {
    S.network = { segments: [] };
  }
}

function hideQueryMeta() {
  $("#queryMeta").hidden = true;
  $("#queryStatus").hidden = true;
  $("#queryUnit").hidden = true;
  $("#queryOccupancy").hidden = true;
}

function renderQuery() {
  const meta = $("#queryMeta");
  const status = $("#queryStatus");
  const unit = $("#queryUnit");
  const occupancy = $("#queryOccupancy");
  const input = $("#circulationInput");

  input.classList.remove("delayed-text");
  unit.classList.remove("delayed-text");

  if (!S.query.code || S.query.state === "empty") {
    hideQueryMeta();
    return;
  }

  meta.hidden = false;

  if (S.query.state === "loading") {
    status.textContent = "CARREGANT";
    status.hidden = false;
    unit.hidden = true;
    occupancy.hidden = true;
    return;
  }

  if (S.query.state === "inactive") {
    status.textContent = "CIRCULACIÓ NO ACTIVA";
    status.hidden = false;
    unit.hidden = true;
    occupancy.hidden = true;
    return;
  }

  const train = S.query.train;

  if (!train) {
    hideQueryMeta();
    return;
  }

  status.hidden = true;

  unit.textContent = train.unit;
  unit.hidden = false;

  occupancy.hidden = false;
  updateOccupancy(occupancy, train.occupancy);

  if (train.onTime === false) {
    input.classList.add("delayed-text");
    unit.classList.add("delayed-text");
  }
}

function clearSearch({ clearInput = true } = {}) {
  S.query.requestId += 1;
  S.query.code = "";
  S.query.state = "empty";
  S.query.train = null;

  if (clearInput) {
    $("#circulationInput").value = "";
  }

  renderQuery();
  clearLIT(S);
  renderPUV(S);
}

async function ensureFreshPositioning() {
  const age = S.lastFetch
    ? Date.now() - S.lastFetch.getTime()
    : Infinity;

  if (age <= S.config.refreshMs) {
    return;
  }

  await refreshPositioning({ reschedule: false });
}

function findTrain(code) {
  return S.trains.find(
    train => train.circulation === code
  ) || null;
}

async function resolveQuery(code) {
  const requestId = ++S.query.requestId;

  S.query.code = code;
  S.query.state = "loading";
  S.query.train = null;
  renderQuery();

  try {
    await ensureFreshPositioning();
  } catch {
    // La búsqueda puede seguir usando el último snapshot válido.
  }

  if (
    requestId !== S.query.requestId ||
    S.query.code !== code
  ) {
    return;
  }

  const train = findTrain(code);

  if (!train) {
    S.query.state = "inactive";
    S.query.train = null;
    renderQuery();
    clearLIT(S);
    renderPUV(S);
    return;
  }

  S.query.state = "active";
  S.query.train = train;
  renderQuery();
  renderPUV(S);

  if (S.activeView === "puv") {
    revealSearchedTrain(S);
  }

  if (S.activeView === "lit") {
    S.query.state = "loading";
    renderQuery();

    try {
      const loaded = await loadLIT(S, code, train);

      if (
        requestId === S.query.requestId &&
        S.query.code === code
      ) {
        const currentTrain = findTrain(code);

        if (!currentTrain) {
          S.query.state = "inactive";
          S.query.train = null;
          clearLIT(S);
        } else {
          S.query.state = loaded ? "active" : S.query.state;
          S.query.train = currentTrain;
        }

        renderQuery();
      }
    } catch (error) {
      S.lastError = String(error?.message || error);

      if (
        requestId === S.query.requestId &&
        S.query.code === code
      ) {
        S.query.state = "active";
        S.query.train = train;
        renderQuery();
      }
    }
  }
}

function setupSearch() {
  const input = $("#circulationInput");

  input.addEventListener("input", () => {
    const value = input.value
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 4)
      .toUpperCase();

    input.value = value;

    if (value.length < 4) {
      S.query.requestId += 1;
      S.query.code = value;
      S.query.state = value ? "empty" : "empty";
      S.query.train = null;
      renderQuery();
      clearLIT(S);
      renderPUV(S);
      return;
    }

    resolveQuery(value);
  });
}

async function activateView(name, { clearQuery = true } = {}) {
  if (name === S.activeView) return;

  if (clearQuery) {
    clearSearch();
  }

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

  if (name === "ema") {
    audio?.enterEMA();
  } else {
    audio?.leaveEMA();
  }
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach(button => {
    button.addEventListener("click", () => {
      activateView(button.dataset.view);
    });
  });
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

function syncActiveQueryAfterRefresh() {
  if (!S.query.code || S.query.code.length !== 4) {
    return;
  }

  const live = findTrain(S.query.code);

  if (!live) {
    S.query.state = "inactive";
    S.query.train = null;
    renderQuery();

    if (S.selected?.circulation === S.query.code) {
      clearLIT(S);
    }

    return;
  }

  S.query.train = live;

  if (S.query.state !== "loading") {
    S.query.state = "active";
  }

  renderQuery();

  if (S.selected?.circulation === live.circulation) {
    S.selected.live = live;
  }
}

async function refreshPositioning({ reschedule = true } = {}) {
  if (refreshRunning) {
    return refreshPromise;
  }

  if (document.hidden) return null;

  refreshRunning = true;

  activeController?.abort();
  activeController = new AbortController();

  const timeoutId = setTimeout(
    () => activeController.abort(),
    S.config.requestTimeoutMs
  );

  const started = performance.now();

  refreshPromise = (async () => {
    try {
      const result = await fetchPositioning(
        S.config.positioningUrl,
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
      S.lastLatencyMs = Math.round(
        performance.now() - started
      );
      S.lastError = null;

      syncActiveQueryAfterRefresh();
      renderPUV(S);
    } catch (error) {
      if (error?.name !== "AbortError") {
        S.lastError = String(error?.message || error);
        renderPUV(S);
      }
    } finally {
      clearTimeout(timeoutId);
      refreshRunning = false;
      refreshPromise = null;

      if (reschedule) {
        scheduleNext(S.config.refreshMs);
      }
    }
  })();

  return refreshPromise;
}

function setupConnectivity() {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearTimeout(refreshTimer);
      activeController?.abort();
      return;
    }

    refreshPositioning();
  });

  window.addEventListener("online", () => {
    refreshPositioning();
  });

  window.addEventListener("offline", () => {
    S.lastError = "sense connexió";
    renderPUV(S);
  });
}

function setupDiagnostics() {
  const hotspot = $("#diagHotspot");
  const dialog = $("#diag");
  let holdTimer = null;

  const open = () => {
    const audioState = audio?.state?.() || {};

    $("#diagText").textContent = [
      "SIM+ Beta 3.4",
      `Vista: ${S.activeView}`,
      `Registres API: ${S.rawCount}`,
      `BV vàlids: ${S.trains.length}`,
      `Última consulta: ${
        S.lastFetch
          ? S.lastFetch.toLocaleTimeString(
              "es-ES",
              { hour12: false }
            )
          : "—"
      }`,
      `Latència: ${
        S.lastLatencyMs === null
          ? "—"
          : `${S.lastLatencyMs} ms`
      }`,
      `Refresc: ${S.config.refreshMs} ms`,
      `Consulta: ${S.query.code || "—"}`,
      `Estat consulta: ${S.query.state}`,
      `MP3 detectats: ${audioState.tracks ?? 0}`,
      `Àudio reproduint: ${audioState.playing ? "sí" : "no"}`,
      `Error: ${S.lastError || "—"}`
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

  $("#closeDiag").addEventListener(
    "click",
    () => dialog.close()
  );
}

function setupAudio() {
  audio = new BackgroundAudio(S.config.audio || {});
  audio.init();

  const brand = $("#brandAudioToggle");

  brand.addEventListener("click", event => {
    event.stopPropagation();
    audio.toggleByUser();
  });

  const unlock = event => {
    if (event.target.closest("#brandAudioToggle")) return;

    setTimeout(() => {
      if (S.activeView !== "ema") {
        audio.unlockFromUserGesture();
      }
    }, 0);
  };

  document.addEventListener("pointerup", unlock, {
    passive: true
  });
}

async function init() {
  setupClock();

  await loadStaticData();

  setupTabs();
  setupSearch();
  setupDiagnostics();
  wirePUV(S);
  setupConnectivity();
  setupAudio();

  renderQuery();
  renderPUV(S);

  await refreshPositioning();

  setInterval(() => {
    tickLIT(S);
  }, 250);
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
