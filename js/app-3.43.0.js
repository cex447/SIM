import {
  fetchPositioning,
  normalizeTrain
} from "./fgc-api-3.43.0.js";

import {
  wirePLASTIC,
  renderPLASTIC,
  tickPLASTIC,
  revealSearchedTrain,
  MODULE_VERSION as PLASTIC_MODULE_VERSION
} from "./plastic-3.43.0.js";

import {
  wireTORNS,
  renderTORNS,
  tickTORNS,
  MODULE_VERSION as TORNS_MODULE_VERSION
} from "./torns-3.43.0.js";

import {
  clearLIT,
  focusCurrentLIT,
  loadLIT,
  tickLIT,
  MODULE_VERSION as LIT_MODULE_VERSION
} from "./lit-3.43.0.js";

import {
  wireISIC,
  renderISIC,
  refreshISIC,
  syncISICQuery,
  tickISIC,
  MODULE_VERSION as ISIC_MODULE_VERSION
} from "./isic-view-3.43.0.js";

import { updateOccupancy } from "./occupancy-3.43.0.js";
import { BackgroundAudio } from "./audio-3.43.0.js";
import {
  displayTurnFor,
  effectiveServiceReference,
  serviceTypeFromReference,
  MODULE_VERSION as TURNS_MODULE_VERSION
} from "./turns-3.43.0.js";

import {
  calendarDateKey,
  operationalDate,
  resolveOperationalService,
  serviceCalendarUrl,
  MODULE_VERSION as SERVICE_CALENDAR_MODULE_VERSION
} from "./service-calendar-3.43.0.js";

import { setupViewports, activateViewport } from "./viewport-3.43.0.js";
import {
  initCTC, enterCTC, leaveCTC, updateCTC, ctcDiagnostic,
  requestCTCStationFocus, requestCTCTrainFocus,
  MODULE_VERSION as CTC_MODULE_VERSION
} from "./ctc-3.43.0.js";

const APP_MODULE_VERSION = "3.43.0";

const S = {
  config: null,
  network: { segments: [] },
  turnAssignments: { servicios: {} },
  turnAssignmentsError: null,
  serviceCalendars: new Map(),
  specialTurnCalendars: new Map(),
  serviceCalendarRetryAfter: new Map(),
  serviceCalendarError: null,
  specialTurnCalendarError: null,
  operationalService: null,
  initialized: false,

  trains: [],
  rawCount: 0,
  apiTotal: null,

  lastFetch: null,
  lastError: null,
  lastLatencyMs: null,

  activeView: "plastic",
  selected: null,

  plasticFilters: {
    lines: new Set(),
    units: new Set()
  },

  tornsFilters: {
    stations: new Set()
  },

  tornsView: {
    code: "",
    state: "empty",
    selectedCirculation: ""
  },

  isicView: {
    station: "",
    stationName: "",
    state: "empty",
    requestId: 0,
    items: [],
    lastFetch: null,
    lastAttempt: 0,
    lastError: null,
    refreshRunning: false,
    refreshPromise: null
  },

  ctc: {
    initialized: false,
    routes: null,
    routeError: null,
    motionError: null
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
let serviceCalendarPromise = null;
let serviceCalendarPromiseYear = null;

function syncClockReserve() {
  const clock = $("#clock");
  if (!clock) return;

  const width = Math.ceil(clock.getBoundingClientRect().width);
  document.documentElement.style.setProperty("--clock-reserve", `${width}px`);
}

function setupClock() {
  const tick = () => {
    const now = new Date();
    $("#clock").textContent = now.toLocaleTimeString(
      "es-ES",
      { hour12: false }
    );
    syncClockReserve();
    if (S.config) ensureOperationalService(now);
  };

  tick();
  setInterval(tick, 1000);

  window.addEventListener("resize", syncClockReserve, { passive: true });

  if ("ResizeObserver" in window) {
    new ResizeObserver(syncClockReserve).observe($("#clock"));
  }

  document.fonts?.ready?.then(syncClockReserve).catch(() => {});
}

function renderOperationalService() {
  const node = $("#serviceToday");
  if (!node) return;

  const code = S.operationalService?.displayCode || "—";
  node.textContent = code;
  node.setAttribute(
    "aria-label",
    code === "—"
      ? "Servei operacional no disponible"
      : `Servei operacional ${code}`
  );
}

function rerenderAfterServiceChange() {
  if (!S.initialized) return;
  renderQuery();
  renderPLASTIC(S);
  renderISIC(S);
  renderTORNS(S);
  /* El cambio de día ferroviario también puede cambiar el conjunto horario
     de una estación iSIC que ya estaba abierta. No esperamos al siguiente
     refresco periódico: reconstruimos la lista con el nuevo servicio. */
  if (S.activeView === "isic") refreshISIC(S, { force:true });
}

async function ensureOperationalService(
  now = new Date(),
  { rerender = true } = {}
) {
  if (!S.config) return null;

  const cutoverHour = Number(S.config.serviceDayCutoverHour) || 3;
  const date = operationalDate(now, cutoverHour);
  const year = date.getFullYear();
  const dateKey = calendarDateKey(date);

  const calendarFilesMissing =
    !S.serviceCalendars.has(year) || !S.specialTurnCalendars.has(year);
  const retryAllowed = Date.now() >= (S.serviceCalendarRetryAfter.get(year) || 0);

  if (calendarFilesMissing && retryAllowed) {
    if (serviceCalendarPromise && serviceCalendarPromiseYear === year) {
      await serviceCalendarPromise;
    } else {
      serviceCalendarPromiseYear = year;
      serviceCalendarPromise = (async () => {
        const url = serviceCalendarUrl(S.config.serviceCalendarUrlTemplate, year);
        const specialUrl = serviceCalendarUrl(
          S.config.specialTurnAssignmentsUrlTemplate ||
            "data/sim-turnos-especiales-{year}.json",
          year
        );
        const [response, specialResult] = await Promise.all([
          fetch(url, { cache:"no-store" }),
          fetch(specialUrl, { cache:"no-store" })
            .then(specialResponse => ({ response:specialResponse, error:null }))
            .catch(error => ({ response:null, error }))
        ]);
        if (!response.ok) throw new Error(`calendari ${year} HTTP ${response.status}`);
        const calendar = await response.json();
        if (Number(calendar?.year) !== year || !calendar?.services) {
          throw new Error(`calendari ${year} no vàlid`);
        }
        S.serviceCalendars.set(year, calendar);
        S.serviceCalendarRetryAfter.delete(year);
        S.serviceCalendarError = null;

        try {
          if (!specialResult.response?.ok) {
            throw specialResult.error || new Error(
              `torns especials ${year} HTTP ${specialResult.response?.status || "—"}`
            );
          }
          const specialCalendar = await specialResult.response.json();
          if (Number(specialCalendar?.year) !== year) {
            throw new Error(`torns especials ${year} no vàlids`);
          }
          S.specialTurnCalendars.set(year, specialCalendar);
          S.specialTurnCalendarError = null;
        } catch (error) {
          /* Es un archivo opcional: su ausencia nunca impide arrancar SIM. */
          S.specialTurnCalendars.set(year, { year, dates:{} });
          S.specialTurnCalendarError = String(error?.message || error);
        }
      })().catch(error => {
        S.serviceCalendarError = String(error?.message || error);
        /* Si al cambiar de año todavía no se ha publicado su fichero, SIM
           continúa funcionando sin inundar el servidor con una petición por
           segundo. Se volverá a comprobar automáticamente en cinco minutos. */
        S.serviceCalendarRetryAfter.set(year, Date.now() + 5 * 60 * 1000);
      }).finally(() => {
        serviceCalendarPromise = null;
        serviceCalendarPromiseYear = null;
      });
      await serviceCalendarPromise;
    }
  }

  const calendar = S.serviceCalendars.get(year) || null;
  const next = resolveOperationalService(
    calendar,
    S.turnAssignments,
    now,
    cutoverHour
  );

  if (/^[67]/.test(next.rawCode || "")) {
    /* Los 6xx/7xx nunca heredan el bloque ordinario del catálogo general. */
    next.assignmentKey = null;
    const specialCalendar = S.specialTurnCalendars.get(year) || {};
    const datedAssignments = specialCalendar?.dates?.[dateKey] ||
      (
        specialCalendar?.date === dateKey
          ? specialCalendar?.circulations
          : null
      );
    if (datedAssignments && typeof datedAssignments === "object") {
      const specialKey = `special:${dateKey}`.toLowerCase();
      S.turnAssignments.servicios[specialKey] = datedAssignments;
      next.assignmentKey = specialKey;
      next.specialAssignments = true;
    }
  }
  const previousSignature = [
    S.operationalService?.dateKey || "",
    S.operationalService?.rawCode || "",
    S.operationalService?.assignmentKey || ""
  ].join("|");
  const nextSignature = [
    next.dateKey,
    next.rawCode || "",
    next.assignmentKey || ""
  ].join("|");

  S.operationalService = next;
  renderOperationalService();

  if (rerender && previousSignature !== nextSignature) {
    rerenderAfterServiceChange();
  }
  return next;
}

async function loadStaticData() {
  const configResponse = await fetch("data/config-3.43.0.json", { cache: "no-store" });

  if (!configResponse.ok) {
    throw new Error(`config.json HTTP ${configResponse.status}`);
  }

  S.config = await configResponse.json();

  const turnsUrl =
    S.config.turnAssignmentsUrl || "data/sim-turnos-servicios-3.43.0.json";
  const [networkResponse, turnsResult] = await Promise.all([
    fetch("data/network-3.43.0.json", { cache: "no-store" }),
    fetch(turnsUrl, { cache: "no-store" })
      .then(response => ({ response, error:null }))
      .catch(error => ({ response:null, error }))
  ]);

  S.network = networkResponse.ok
    ? await networkResponse.json()
    : { segments: [] };

  try {
    if (!turnsResult.response?.ok) {
      throw turnsResult.error || new Error(
        `turnos HTTP ${turnsResult.response?.status || "—"}`
      );
    }
    S.turnAssignments = await turnsResult.response.json();
    S.turnAssignmentsError = null;
  } catch (error) {
    S.turnAssignments = { servicios: {} };
    S.turnAssignmentsError = String(error?.message || error);
  }

  await ensureOperationalService(new Date(), { rerender:false });
}


function syncQueryBars(view = S.activeView) {
  const litBar = $("#litQueryBar");
  const isicBar = $("#isicQueryBar");
  const ctcBar = $("#ctcQueryBar");
  const tornsBar = $("#tornsQueryBar");
  const tornsFilters = $("#tornsFiltersBar");

  if (litBar) litBar.hidden = view !== "lit";
  if (isicBar) isicBar.hidden = view !== "isic";
  if (ctcBar) ctcBar.hidden = view !== "ctc";
  if (tornsBar) tornsBar.hidden = view !== "torns";
  if (tornsFilters) tornsFilters.hidden = view !== "torns";

  /* Safari/iOS puede conservar el valor de un input al cambiar de vista.
     Ocultamos también el foco para que nunca quede visible ni activo el
     campo perteneciente a otro módulo. */
  if (view !== "lit") $("#circulationInput")?.blur();
  if (view !== "isic") $("#stationInput")?.blur();
  if (view !== "ctc") $("#ctcStationInput")?.blur();
  if (view !== "torns") $("#turnInput")?.blur();
}

function hideQueryMeta() {
  /* El camp de circulació forma part de la mateixa retícula que torn, UT i
     ocupació. La retícula continua visible i només se n'oculten les dades. */
  $("#queryMeta").hidden = false;
  $("#queryStatus").hidden = true;
  $("#queryUnit").hidden = true;
  $("#queryTurn").hidden = true;
  $("#queryOccupancy").hidden = true;
  $("#queryDelay").hidden = true;
}

function renderQuery() {
  const meta = $("#queryMeta");
  const status = $("#queryStatus");
  const unit = $("#queryUnit");
  const turn = $("#queryTurn");
  const occupancy = $("#queryOccupancy");
  const delay = $("#queryDelay");
  const input = $("#circulationInput");

  input.classList.remove("delayed-text");
  unit.classList.remove("delayed-text");
  turn.classList.remove("delayed-text");

  if (!S.query.code || S.query.state === "empty") {
    hideQueryMeta();
    return;
  }

  meta.hidden = false;

  if (S.query.state === "loading") {
    status.textContent = "CARREGANT";
    status.hidden = false;
    unit.hidden = true;
    turn.hidden = true;
    occupancy.hidden = true;
    delay.hidden = true;
    return;
  }

  if (S.query.state === "inactive") {
    status.textContent = "CIRCULACIÓ NO ACTIVA";
    status.hidden = false;
    unit.hidden = true;
    turn.hidden = true;
    occupancy.hidden = true;
    delay.hidden = true;
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

  turn.textContent = displayTurnFor(
    S.turnAssignments,
    train.circulation,
    effectiveServiceReference(S, train.id)
  );
  turn.hidden = false;

  occupancy.hidden = false;
  updateOccupancy(occupancy, train.occupancy, {
    delayed: train.onTime === false,
    unit: train.unit
  });

  /* El valor +N de LIT lo actualiza lit.js cada segundo con el contexto
     operacional de la circulación. Aquí solo fijamos su visibilidad base. */
  delay.hidden = train.onTime !== false;
  if (delay.hidden) delay.textContent = "";

  if (train.onTime === false) {
    input.classList.add("delayed-text");
    unit.classList.add("delayed-text");
    turn.classList.add("delayed-text");
  }
}

function clearSearch({ clearInput = true, rerenderPlastic = true } = {}) {
  S.query.requestId += 1;
  S.query.code = "";
  S.query.state = "empty";
  S.query.train = null;

  if (clearInput) $("#circulationInput").value = "";

  renderQuery();
  clearLIT(S);
  if (rerenderPlastic) renderPLASTIC(S);
}

async function ensureFreshPositioning() {
  const age = S.lastFetch
    ? Date.now() - S.lastFetch.getTime()
    : Infinity;

  if (age <= S.config.refreshMs) return;
  await refreshPositioning({ reschedule: false });
}

function findTrain(code) {
  return S.trains.find(train => train.circulation === code) || null;
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
    // Se puede seguir con el último snapshot válido de posicionamiento.
  }

  if (requestId !== S.query.requestId || S.query.code !== code) return;

  const train = findTrain(code);

  if (!train) {
    S.query.state = "inactive";
    S.query.train = null;
    renderQuery();
    clearLIT(S);
    renderPLASTIC(S);
    return;
  }

  S.query.state = "active";
  S.query.train = train;
  renderQuery();
  renderPLASTIC(S);

  if (S.activeView === "plastic") {
    revealSearchedTrain(S);
    return;
  }

  if (S.activeView !== "lit") return;

  S.query.state = "loading";
  renderQuery();

  try {
    const loaded = await loadLIT(S, code, train);

    if (requestId !== S.query.requestId || S.query.code !== code) return;

    const currentTrain = findTrain(code);

    if (!currentTrain) {
      /* Beta 3.32: una ausencia transitoria del snapshot de posicionament no
         destruye un LIT que ya se ha cargado. Conservamos itinerario y estado
         funcional; cuando reaparezca la circulación, el live se resincroniza. */
      S.query.state = "inactive";
      S.query.train = null;
    } else {
      S.query.state = loaded ? "active" : S.query.state;
      S.query.train = currentTrain;
    }

    renderQuery();
  } catch (error) {
    S.lastError = String(error?.message || error);

    if (requestId === S.query.requestId && S.query.code === code) {
      S.query.state = "active";
      S.query.train = train;
      renderQuery();
    }
  }
}

function setupSearch() {
  const input = $("#circulationInput");

  input.addEventListener("pointerdown", () => {
    if (!input.value && !S.query.code) return;
    clearSearch({ clearInput:true, rerenderPlastic:true });
  });

  input.addEventListener("input", () => {
    const value = input.value
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 4)
      .toUpperCase();

    input.value = value;

    if (value.length < 4) {
      S.query.requestId += 1;
      S.query.code = value;
      S.query.state = "empty";
      S.query.train = null;
      renderQuery();
      clearLIT(S);
      renderPLASTIC(S);
      return;
    }

    resolveQuery(value);

    /* En iPhone, una vez introducidos los 4 caracteres liberamos pantalla. */
    input.blur();
  });
}

async function activateView(name, { clearQuery = false } = {}) {
  if (name === S.activeView) return;

  const previousView = S.activeView;
  if (previousView === "ctc" && name !== "ctc") leaveCTC();

  if (clearQuery) {
    clearSearch({ rerenderPlastic: false });
  }

  S.activeView = name;
  document.documentElement.dataset.view = name;
  syncQueryBars(name);

  document.querySelectorAll(".tab").forEach(button => {
    button.classList.toggle("active", button.dataset.view === name);
  });

  document.querySelectorAll(".view").forEach(view => {
    view.classList.toggle("active", view.id === `view-${name}`);
  });

  /* Conservamos contenido/selección, pero no persistimos el scroll vertical. */
  if (name !== "ctc") {
    const targetView = $(`#view-${name}`);
    if (targetView) targetView.scrollTop = 0;
    activateViewport(`#view-${name}`);
  }

  if (name === "siv") {
    audio?.enterSIV();
  } else {
    audio?.leaveSIV();
  }

  if (name === "plastic") renderPLASTIC(S);
  if (name === "isic") {
    /* Sincroniza el valor visual del campo con el estado interno.
       Safari puede restaurar un valor sin disparar el evento input. */
    await syncISICQuery(S);
    renderISIC(S);
    refreshISIC(S);
  }
  if (name === "ctc") enterCTC(S);
  if (name === "lit") focusCurrentLIT(S);
  if (name === "torns") renderTORNS(S);
}

async function openCirculationFromPlastic(code) {
  $("#circulationInput").value = code;
  await activateView("lit", { clearQuery: false });
  await resolveQuery(code);
}

async function openStationFromCTC(code) {
  const input = $("#stationInput");
  if (!input) return;
  input.value = String(code || "").toUpperCase().slice(0, 2);
  await activateView("isic");
  await syncISICQuery(S, { blur:true });
}

async function openCTCFromLIT() {
  const code = String(S.selected?.circulation || S.query?.code || "").toUpperCase();
  if (!code) return;
  requestCTCTrainFocus(code);
  await activateView("ctc", { clearQuery:false });
}

async function openCTCFromISIC() {
  const code = String(S.isicView?.station || $("#stationInput")?.value || "").toUpperCase();
  if (!code) return;
  requestCTCStationFocus(code);
  await activateView("ctc", { clearQuery:false });
}

async function openCirculationInCTC(code) {
  const circulation = String(code || "").toUpperCase();
  if (!circulation) return;
  requestCTCTrainFocus(circulation);
  await activateView("ctc", { clearQuery:false });
}

function setupContextualCTCButtons() {
  $("#litCtcButton")?.addEventListener("click", openCTCFromLIT);
  $("#isicCtcButton")?.addEventListener("click", openCTCFromISIC);
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
  for (const train of trains) map.set(train.id, train);
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
  if (!S.query.code || S.query.code.length !== 4) return;

  const live = findTrain(S.query.code);

  if (!live) {
    S.query.state = "inactive";
    S.query.train = null;
    renderQuery();

    /* Beta 3.32: no borrar LIT por una ausencia transitoria en un refresco.
       El usuario sólo pierde el LIT al introducir/borrar explícitamente otra
       circulación. */
    return;
  }

  S.query.train = live;
  if (S.query.state !== "loading") S.query.state = "active";
  renderQuery();

  if (S.selected?.circulation === live.circulation) {
    S.selected.live = live;
  }
}

async function refreshPositioning({ reschedule = true } = {}) {
  if (refreshRunning) return refreshPromise;
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
      S.lastLatencyMs = Math.round(performance.now() - started);
      S.lastError = null;

      syncActiveQueryAfterRefresh();
      updateCTC(S, Date.now());
      if (S.activeView === "plastic") renderPLASTIC(S);
      if (S.activeView === "isic") refreshISIC(S);
      if (S.activeView === "torns") renderTORNS(S);
    } catch (error) {
      if (error?.name !== "AbortError") {
        S.lastError = String(error?.message || error);
        if (S.activeView === "plastic") renderPLASTIC(S);
      }
    } finally {
      clearTimeout(timeoutId);
      refreshRunning = false;
      refreshPromise = null;

      if (reschedule) scheduleNext(S.config.refreshMs);
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

  window.addEventListener("online", () => refreshPositioning());

  window.addEventListener("offline", () => {
    S.lastError = "sense connexió";
    renderPLASTIC(S);
  });
}

function setupDiagnostics() {
  const hotspot = $("#diagHotspot");
  const dialog = $("#diag");
  let holdTimer = null;

  const open = () => {
    const audioState = audio?.state?.() || {};

    $("#diagText").textContent = [
      "SIM+ Beta 3.43.0",
      `APP: ${APP_MODULE_VERSION}`,
      `PLASTIC: ${PLASTIC_MODULE_VERSION}`,
      `TORNS vista: ${TORNS_MODULE_VERSION}`,
      `iSIC: ${ISIC_MODULE_VERSION}`,
      `CTC: ${CTC_MODULE_VERSION}`,
      `LIT: ${LIT_MODULE_VERSION}`,
      `TORNS dades: ${TURNS_MODULE_VERSION}`,
      `Calendari: ${SERVICE_CALENDAR_MODULE_VERSION}`,
      `Vista: ${S.activeView}`,
      `Registres API: ${S.rawCount}`,
      `BV vàlids: ${S.trains.length}`,
      `Última consulta: ${
        S.lastFetch
          ? S.lastFetch.toLocaleTimeString("es-ES", { hour12: false })
          : "—"
      }`,
      `Latència: ${S.lastLatencyMs === null ? "—" : `${S.lastLatencyMs} ms`}`,
      `Refresc: ${S.config.refreshMs} ms`,
      `Consulta: ${S.query.code || "—"}`,
      `Estat consulta: ${S.query.state}`,
      `Dia ferroviari: ${S.operationalService?.dateKey || "—"}`,
      `Servei calendari: ${S.operationalService?.displayCode || "—"}`,
      `Servei torns: ${
        S.operationalService?.assignmentKey ||
        (S.operationalService?.rawCode
          ? `${S.operationalService.rawCode} (sense quadre)`
          : serviceTypeFromReference(S.query.train?.id || S.trains[0]?.id)) ||
        "—"
      }`,
      `Error calendari: ${S.serviceCalendarError || "—"}`,
      `Torns especials: ${S.operationalService?.specialAssignments ? "sí" : "no"}`,
      `Error torns especials: ${S.specialTurnCalendarError || "—"}`,
      `Error torns: ${S.turnAssignmentsError || "—"}`,
      `Estació iSIC: ${S.isicView.station || "—"}`,
      `Nom iSIC: ${S.isicView.stationName || "—"}`,
      `Error iSIC: ${S.isicView.lastError || "—"}`,
      `CTC rutes catalogades: ${ctcDiagnostic(S).routes}`,
      `CTC circulant: ${ctcDiagnostic(S).moving}`,
      `CTC estacionades: ${ctcDiagnostic(S).stationed}`,
      `CTC marcadors: ${ctcDiagnostic(S).markers}`,
      `CTC estacions sensibles: ${ctcDiagnostic(S).stations}`,
      `CTC zoom: ${ctcDiagnostic(S).viewport?.scale?.toFixed?.(2) || "—"}`,
      `Error CTC rutes: ${ctcDiagnostic(S).routeError || "—"}`,
      `Error CTC moviment: ${ctcDiagnostic(S).motionError || "—"}`,
      `Error CTC estacions: ${ctcDiagnostic(S).stationHitError || "—"}`,
      `MP3 detectats: ${audioState.tracks ?? 0}`,
      `Àudio carregat: ${audioState.loaded ? "sí" : "no"}`,
      `Àudio reproduint: ${audioState.playing ? "sí" : "no"}`,
      `Error: ${S.lastError || "—"}`
    ].join("\n");

    dialog.showModal();
  };

  const start = () => { holdTimer = setTimeout(open, 900); };
  const cancel = () => { clearTimeout(holdTimer); };

  hotspot.addEventListener("pointerdown", start);
  hotspot.addEventListener("pointerup", cancel);
  hotspot.addEventListener("pointercancel", cancel);
  hotspot.addEventListener("pointerleave", cancel);

  $("#closeDiag").addEventListener("click", () => dialog.close());
}

function setupAudio() {
  audio = new BackgroundAudio(S.config.audio || {});
  audio.init();

  $("#brandAudioToggle").addEventListener("click", event => {
    event.stopPropagation();
    audio.toggleByUser();
  });
}

async function init() {
  setupClock();
  await loadStaticData();

  setupViewports();
  await initCTC(S, {
    onSelectTrain: openCirculationFromPlastic,
    onSelectStation: openStationFromCTC
  });

  setupTabs();
  setupContextualCTCButtons();
  setupSearch();
  setupDiagnostics();
  wirePLASTIC(S, { onSelectTrain: openCirculationFromPlastic });
  wireISIC(S, { onSelectTrain: openCirculationFromPlastic });
  wireTORNS(S, {
    onOpenLIT:openCirculationFromPlastic,
    onOpenCTC:openCirculationInCTC
  });
  setupConnectivity();
  setupAudio();

  S.initialized = true;

  document.documentElement.dataset.view = S.activeView;
  syncQueryBars(S.activeView);
  renderQuery();
  renderPLASTIC(S);
  renderISIC(S);
  renderTORNS(S);

  await refreshPositioning();

  setInterval(() => {
    tickLIT(S);
    tickPLASTIC(S);
    tickISIC(S);
    tickTORNS(S);
  }, 250);
}

init().catch(error => {
  S.lastError = String(error?.message || error);

  const status = $("#plasticStatus");
  if (status) {
    status.textContent = "ERROR D'INICIALITZACIÓ";
    status.classList.add("error");
  }

  console.error(error);
});
