import { decodeCirculation } from "./fgc-api.js?v=3.24.0";
import {
  getStationCatalog,
  getStationDepartures,
  getTripBundle
} from "./gtfs.js?v=3.24.0";
import { updateOccupancy } from "./occupancy.js?v=3.24.0";
import { countdownState, formatCountdown, resolveGtfsTimestamp } from "./time.js?v=3.24.0";
import { locateOperationalTarget, parentCode, countdownRedThreshold } from "./operations.js?v=3.24.0";
import {
  fetchIsicStation,
  fixedPlatformFor,
  matchContextsToRows,
  normalizePlatformValue,
  rememberPlatform
} from "./isic.js?v=3.24.0";

const FAMILY_ORDER = Object.freeze(["A", "D", "F", "B", "L"]);
const LINE_BY_FAMILY = Object.freeze({ A:"L6", D:"S1", F:"S2", B:"L7", L:"L12" });
const MAX_ROWS_PER_LINE_DIRECTION = 4;

const $ = selector => document.querySelector(selector);
let onSelectTrainHandler = null;
let catalogPromise = null;

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function unitCountText(count) {
  return `${count} ${count === 1 ? "UT" : "UTs"}`;
}

/* iSIC: a partir de 59:00 la cronometría pasa a h:mm:ss.
   Ej.: 72:01 -> 1:12:01. Por debajo de 59 min se conserva m:ss. */
function formatISICCountdown(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 59 * 60) return formatCountdown(total);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/* Máximo de cuatro circulaciones por combinación línea + sentido.
   El límite se aplica DESPUÉS de fusionar horario, tiempo real e iSIC para que
   las cuatro sean siempre las más próximas cronológicamente. */
function limitPerLineDirection(items) {
  const counts = new Map();
  return [...items]
    .sort((a,b) => a.targetMs - b.targetMs || a.circulation.localeCompare(b.circulation))
    .filter(item => {
      const key = `${item.line}:${item.ascending ? "asc" : "desc"}`;
      const count = counts.get(key) || 0;
      if (count >= MAX_ROWS_PER_LINE_DIRECTION) return false;
      counts.set(key, count + 1);
      return true;
    });
}

/* BETA 3.24.0 · una circulación sólo puede existir una vez en iSIC.
   GTFS puede devolver el mismo número de circulación desde más de un service_id
   y, además, la recuperación live puede aportar el mismo tren por otra vía. La
   deduplicación se realiza ANTES de matching, contadores y límite 4×línea×sentido. */
function mergeDuplicateCirculation(a, b) {
  if (!a) return b;
  if (!b) return a;

  const aPlatform = normalizePlatformValue(a.platform);
  const bPlatform = normalizePlatformValue(b.platform);
  const withPlatform = aPlatform !== null ? a : (bPlatform !== null ? b : null);
  const withLive = a.live ? a : (b.live ? b : null);
  const chronological = Number(a.targetMs) <= Number(b.targetMs) ? a : b;
  const preferred = withPlatform || withLive || chronological;
  const live = a.live || b.live || null;
  const platformRecord = withPlatform || preferred;
  const id = live?.id || preferred.id || chronological.id;

  return {
    ...chronological,
    ...preferred,
    id,
    key:id || preferred.key || chronological.key,
    circulation:preferred.circulation || chronological.circulation,
    live,
    targetMs:chronological.targetMs,
    departure:chronological.departure,
    platform:normalizePlatformValue(platformRecord.platform),
    isicTime:platformRecord.isicTime ?? preferred.isicTime ?? chronological.isicTime ?? null,
    platformMode:platformRecord.platformMode ?? preferred.platformMode ?? null,
    source:withPlatform ? platformRecord.source : preferred.source
  };
}

function dedupeByCirculation(items) {
  const map = new Map();
  for (const item of items || []) {
    const circulation = String(item?.circulation || "").toUpperCase();
    if (!circulation) continue;
    map.set(circulation, mergeDuplicateCirculation(map.get(circulation), item));
  }
  return [...map.values()].sort((a,b) =>
    a.targetMs - b.targetMs || a.circulation.localeCompare(b.circulation)
  );
}

function normalizeStationInput(value) {
  return String(value || "")
    .replace(/[^a-zA-Z]/g, "")
    .slice(0, 2)
    .toUpperCase();
}

async function stationCatalog(S) {
  if (!catalogPromise) catalogPromise = getStationCatalog(S.config.gtfsZipIndexUrl);
  return catalogPromise;
}

function liveByTrip(S, tripId, circulation) {
  return (S.trains || []).find(train => train.id === tripId) ||
    (S.trains || []).find(train => train.circulation === circulation) || null;
}

async function delayAdjustmentForLive(S, live, nowMs) {
  if (!live || live.onTime !== false) return 0;

  try {
    const bundle = await getTripBundle(S.config.gtfsZipIndexUrl, live.id);
    const location = locateOperationalTarget(bundle.times, live);
    if (!location || location.final) return 0;

    const stop = bundle.times[location.targetIndex];
    const reference = location.type === "moving"
      ? (stop.arrival_time || stop.departure_time)
      : (stop.departure_time || stop.arrival_time);
    const state = countdownState(reference, nowMs);
    if (!state) return 0;
    return Math.max(0, -state.diffMs / 60000);
  } catch {
    return 0;
  }
}

function buildScheduleRecord(S, departure) {
  const circulation = decodeCirculation(departure.trip_id);
  if (!circulation) return null;

  const family = circulation[0];
  const line = LINE_BY_FAMILY[family];
  if (!line || !S.config.allowedLines.includes(line)) return null;

  const effectiveOrigin = departure.firstStop?.code || "";
  const effectiveDestination = departure.lastStop?.code || "";
  const live = liveByTrip(S, departure.trip_id, circulation);

  return {
    key:departure.trip_id,
    id:departure.trip_id,
    circulation,
    family,
    line,
    ascending:Number(circulation.slice(-1)) % 2 === 1,
    station:departure.station,
    departure:departure.departure_time || departure.arrival_time,
    targetMs:departure.targetMs,
    headsign:departure.trip_headsign || "",
    effectiveOrigin,
    effectiveDestination,
    destinationName:departure.lastStop?.name || departure.trip_headsign || "",
    live,
    source:"schedule"
  };
}


async function buildLiveStationRecord(S, live, station, nowMs) {
  if (!live?.id || !live?.circulation) return null;
  if (String(live.stationed || "") !== station && String(live.nextStop || "") !== station) return null;

  try {
    const bundle = await getTripBundle(S.config.gtfsZipIndexUrl, live.id);
    const times = bundle.times || [];
    const stationStop = times.find(stop => parentCode(stop) === station);
    if (!stationStop) return null;

    const first = times[0] || null;
    const last = times[times.length - 1] || null;
    const departure = stationStop.departure_time || stationStop.arrival_time;
    const targetMs = resolveGtfsTimestamp(departure, nowMs);
    const family = live.circulation[0];
    const line = LINE_BY_FAMILY[family] || live.line;
    if (!line || !S.config.allowedLines.includes(line)) return null;

    return {
      key:live.id,
      id:live.id,
      circulation:live.circulation,
      family,
      line,
      ascending:Boolean(live.ascending),
      station,
      departure,
      targetMs:targetMs ?? nowMs,
      headsign:bundle.trip?.trip_headsign || "",
      effectiveOrigin:first ? parentCode(first) : (live.origin || ""),
      effectiveDestination:last ? parentCode(last) : (live.destination || ""),
      destinationName:last?.stop_name || bundle.trip?.trip_headsign || "",
      live,
      source:"live"
    };
  } catch {
    return null;
  }
}

async function mergeLiveStationRecords(S, records, station, nowMs) {
  const base = dedupeByCirculation(records);
  const known = new Set(base.map(record => record.circulation));
  const related = (S.trains || []).filter(train =>
    String(train.stationed || "") === station || String(train.nextStop || "") === station
  );
  const recovered = await Promise.all(
    related
      .filter(train => !known.has(train.circulation))
      .map(train => buildLiveStationRecord(S, train, station, nowMs))
  );
  return dedupeByCirculation([...base, ...recovered.filter(Boolean)]);
}


async function buildMatchContexts(S, records, station, nowMs) {
  return Promise.all(records.map(async record => {
    const delayAdjustmentMinutes = await delayAdjustmentForLive(S, record.live, nowMs);
    return {
      key:record.key,
      id:record.id,
      circulation:record.circulation,
      line:record.line,
      onTime:record.live?.onTime ?? null,
      station,
      effectiveOrigin:record.effectiveOrigin,
      departure:record.departure,
      delayAdjustmentMinutes,
      originHold:Boolean(
        record.live &&
        station === record.effectiveOrigin &&
        String(record.live.stationed || "") === record.effectiveOrigin
      )
    };
  }));
}

function routeCells(row, item) {
  const live = item.live;
  const stationed = Boolean(live?.stationed);

  row.state.textContent = "est.";
  row.state.classList.toggle("state-spacer", !stationed);

  if (live) {
    row.current.textContent = stationed
      ? (live.stationed || item.station)
      : (live.nextStop || item.station);
    row.arrow.textContent = "→";
    row.arrow.className = stationed
      ? "route-arrow route-arrow-placeholder"
      : "route-arrow moving";
  } else {
    row.current.textContent = item.station;
    row.arrow.textContent = "→";
    row.arrow.className = "route-arrow route-arrow-placeholder";
  }

  row.destination.replaceChildren();
  const code = make("strong", "station-token destination-code", item.effectiveDestination || "—");
  row.destination.appendChild(code);
}

function createRow(S, item) {
  const button = make("button", "trainrow isic-trainrow");
  button.type = "button";
  button.dataset.tripId = item.id;
  button.dataset.circulation = item.circulation;

  const row = {
    button,
    unit:make("span", "train-unit"),
    circulation:make("span", "train-circulation"),
    occupancy:make("span", "occupancy occupancy-compact"),
    state:make("span", "train-state state-token"),
    current:make("span", "train-current station-token"),
    arrow:make("span", "route-arrow"),
    destination:make("span", "train-destination"),
    operational:make("span", "plastic-operational"),
    countdown:make("span", "plastic-countdown")
  };

  button.append(
    row.unit, row.circulation, row.occupancy, row.state, row.current,
    row.arrow, row.destination, row.operational, row.countdown
  );

  const live = item.live;
  const delayed = live?.onTime === false;
  row.unit.textContent = live?.unit || "";
  row.circulation.textContent = item.circulation;

  if (live?.unit) {
    updateOccupancy(row.occupancy, live.occupancy, {
      compact:true,
      delayed,
      unit:live.unit
    });
  } else {
    row.occupancy.replaceChildren();
    row.occupancy.removeAttribute("aria-label");
  }

  button.classList.toggle("delayed-row", delayed);
  routeCells(row, item);

  const platform = normalizePlatformValue(item.platform);
  if (platform !== null) {
    row.operational.textContent = `VÍA ${platform}`;
    row.operational.classList.toggle("red", delayed);
  } else {
    row.operational.textContent = "";
  }

  const state = countdownState(item.departure, Date.now());
  if (state) {
    const red = state.overdue || state.seconds <= countdownRedThreshold(item.station);
    row.countdown.textContent = state.overdue ? "0:00" : formatISICCountdown(state.seconds);
    row.countdown.classList.toggle("red", red);
    row.countdown.classList.toggle("overdue", state.overdue);
  }

  if (live && onSelectTrainHandler) {
    button.addEventListener("click", () => onSelectTrainHandler(item.circulation));
  } else {
    button.setAttribute("aria-disabled", "true");
  }

  return button;
}

function lineHeading(S, family, count) {
  const heading = make("div", "plastic-line-heading");
  const line = LINE_BY_FAMILY[family];
  const image = document.createElement("img");
  image.src = S.config.lineAssets?.[line] || "";
  image.alt = line;
  image.decoding = "async";
  image.loading = "lazy";

  const fallback = make("span", "plastic-line-fallback", line);
  fallback.hidden = true;
  image.addEventListener("error", () => {
    image.hidden = true;
    fallback.hidden = false;
  });

  heading.append(image, fallback, make("span", "line-group-count", unitCountText(count)));
  return heading;
}

function renderDirection(S, direction, items) {
  const host = $(direction === "asc" ? "#isicAscList" : "#isicDescList");
  const empty = $(direction === "asc" ? "#isicAscEmpty" : "#isicDescEmpty");
  host.replaceChildren();

  const grouped = new Map(FAMILY_ORDER.map(family => [family, []]));
  for (const item of items) grouped.get(item.family)?.push(item);

  for (const family of FAMILY_ORDER) {
    const groupItems = grouped.get(family);
    if (!groupItems.length) continue;

    groupItems.sort((a, b) => a.targetMs - b.targetMs || a.circulation.localeCompare(b.circulation));
    const group = make("section", "plastic-line-group");
    group.appendChild(lineHeading(S, family, groupItems.length));
    const rows = make("div", "plastic-line-rows");
    groupItems.forEach(item => rows.appendChild(createRow(S, item)));
    group.appendChild(rows);
    host.appendChild(group);
  }

  /* El antiguo mensaje global de lista vacía desaparece de iSIC.
     El estado sin servicio se expresa sólo en el encabezado de cada sentido. */
  empty.hidden = true;
  empty.textContent = "";
}

export function renderISIC(S) {
  const state = S.isicView;
  const status = $("#isicStatus");
  const directions = $("#isicDirections");
  const ascDirection = $("#isicAscDirection");
  const descDirection = $("#isicDescDirection");
  const ascLabel = $("#isicAscLabel");
  const ascCount = $("#isicAscCount");
  const descCount = $("#isicDescCount");

  if (!state?.station) {
    status.textContent = "INTRODUEIX EL CODI D'ESTACIÓ";
    status.classList.remove("error");
    directions.classList.remove("no-service");
    ascDirection.hidden = false;
    descDirection.hidden = false;
    ascLabel.textContent = "ASCENDENTS";
    const descLabel = $("#isicDescLabel");
    if (descLabel) descLabel.textContent = "DESCENDENTS";
    ascCount.hidden = false;
    descCount.hidden = false;
    renderDirection(S, "asc", []);
    renderDirection(S, "desc", []);
    ascCount.textContent = "0 UTs";
    descCount.textContent = "0 UTs";
    return;
  }

  if (state.state === "invalid") {
    status.textContent = "ESTACIÓ NO VÀLIDA";
    status.classList.add("error");
    renderDirection(S, "asc", []);
    renderDirection(S, "desc", []);
    return;
  }

  if (state.state === "loading" && !state.items.length) {
    status.textContent = "CARREGANT iSIC";
    status.classList.remove("error");
  } else if (state.lastError) {
    status.textContent = state.lastFetch
      ? `DADES CONSERVADES ${state.lastFetch.toLocaleTimeString("es-ES", {hour12:false})}`
      : "iSIC NO DISPONIBLE";
    status.classList.add("error");
  } else if (state.lastFetch) {
    status.textContent = `ACTUALITZAT ${state.lastFetch.toLocaleTimeString("es-ES", {hour12:false})}`;
    status.classList.remove("error");
  } else {
    status.textContent = "ESPERANT DADES";
    status.classList.remove("error");
  }

  const items = state.items || [];
  const asc = items.filter(item => item.ascending);
  const desc = items.filter(item => !item.ascending);
  const descLabel = $("#isicDescLabel");

  /*
   * BETA 3.24.0 · el estado se decide por sentido.
   * Un matcher vacío ya NO significa "sin servicio". Si la imagen oficial
   * contiene filas que todavía no hemos podido identificar, evitamos afirmar
   * ausencia de servicio. Cuando GTFS/live sí han sido resueltos, un sentido
   * realmente vacío se rotula explícitamente.
   */
  const canDeclareNoService = state.state === "ready" && !state.lastError && !state.unmatchedOfficialService;
  const ascNoService = canDeclareNoService && asc.length === 0;
  const descNoService = canDeclareNoService && desc.length === 0;

  directions.classList.remove("no-service");
  ascDirection.hidden = false;
  descDirection.hidden = false;
  ascLabel.textContent = ascNoService ? "ASCENDENTS: SENSE SERVEI COMERCIAL" : "ASCENDENTS";
  if (descLabel) descLabel.textContent = descNoService ? "DESCENDENTS: SENSE SERVEI COMERCIAL" : "DESCENDENTS";
  ascCount.hidden = ascNoService;
  descCount.hidden = descNoService;

  renderDirection(S, "asc", asc);
  renderDirection(S, "desc", desc);
  ascCount.textContent = unitCountText(asc.length);
  descCount.textContent = unitCountText(desc.length);
}

async function resolveStation(S, code) {
  const requestId = ++S.isicView.requestId;
  S.isicView.station = code;
  S.isicView.stationName = "";
  S.isicView.state = "loading";
  S.isicView.lastError = null;
  S.isicView.unmatchedOfficialService = false;
  $("#stationName").textContent = "";
  renderISIC(S);

  try {
    const catalog = await stationCatalog(S);
    if (requestId !== S.isicView.requestId) return;

    const name = catalog.get(code);
    const bvStation = (S.network?.segments || []).some(segment =>
      segment.from === code || segment.to === code
    );
    if (!name || !bvStation) {
      S.isicView.state = "invalid";
      S.isicView.items = [];
      renderISIC(S);
      return;
    }

    S.isicView.stationName = name;
    $("#stationName").textContent = name.toLocaleUpperCase("ca-ES");
    await refreshISIC(S, { force:true });
  } catch (error) {
    if (requestId !== S.isicView.requestId) return;
    S.isicView.lastError = String(error?.message || error);
    S.isicView.state = "error";
    renderISIC(S);
  }
}

function clearStationQueryState(S, code = "") {
  S.isicView.requestId += 1;
  S.isicView.station = code;
  S.isicView.stationName = "";
  S.isicView.state = "empty";
  S.isicView.items = [];
  S.isicView.lastError = null;
  S.isicView.unmatchedOfficialService = false;
  $("#stationName").textContent = "";
  renderISIC(S);
}

export async function syncISICQuery(S, { blur = false } = {}) {
  const input = $("#stationInput");
  if (!input) return;

  const code = normalizeStationInput(input.value);
  input.value = code;

  if (code.length < 2) {
    if (S.isicView.station || S.isicView.state !== "empty") {
      clearStationQueryState(S, code);
    }
    return;
  }

  if (S.isicView.station !== code || ["empty", "invalid", "error"].includes(S.isicView.state)) {
    await resolveStation(S, code);
  } else {
    if (S.isicView.stationName) {
      $("#stationName").textContent = S.isicView.stationName.toLocaleUpperCase("ca-ES");
    }
    renderISIC(S);
  }

  if (blur) input.blur();
}

export function wireISIC(S, { onSelectTrain } = {}) {
  onSelectTrainHandler = onSelectTrain || null;
  const input = $("#stationInput");
  if (!input) return;

  const handle = () => {
    syncISICQuery(S, { blur:normalizeStationInput(input.value).length === 2 });
  };

  input.addEventListener("input", handle);
  input.addEventListener("change", handle);
  input.addEventListener("blur", handle);
}

export async function refreshISIC(S, { force = false } = {}) {
  const state = S.isicView;
  if (!state?.station || state.station.length !== 2 || state.state === "invalid") return;
  if (S.activeView !== "isic" && !force) return;
  if (state.refreshRunning) return state.refreshPromise;

  const interval = Math.max(10000, Number(S.config.isic?.viewRefreshMs) || 10000);
  if (!force && state.lastAttempt && Date.now() - state.lastAttempt < interval) return;

  state.lastAttempt = Date.now();
  state.refreshRunning = true;
  const requestId = state.requestId;

  state.refreshPromise = (async () => {
    const nowMs = Date.now();
    let parsed = null;
    let isicError = null;

    let scheduled = dedupeByCirculation((await getStationDepartures(
      S.config.gtfsZipIndexUrl,
      state.station,
      nowMs,
      { fromMinutes:-180, toMinutes:180, limit:500 }
    ))
      .map(departure => buildScheduleRecord(S, departure))
      .filter(Boolean));


    /* Recuperación en tiempo real: si el filtro de calendario GTFS o cualquier
       índice de estación omite una circulación que FGC confirma estacionada o
       aproximándose a la estación, la reconstruimos desde su trip_id real. */
    const departures = await mergeLiveStationRecords(S, scheduled, state.station, nowMs);

    try {
      parsed = await fetchIsicStation(S.config.isic, state.station, { force });
    } catch (error) {
      isicError = error;
    }

    if (requestId !== state.requestId) return;

    const matchedItems = [];
    const matchedIds = new Set();

    if (parsed) {
      const contexts = await buildMatchContexts(S, departures, state.station, parsed.fetchedAt);
      const matches = matchContextsToRows(contexts, parsed.rows, parsed.fetchedAt);

      for (const record of departures) {
        const match = matches.get(record.key);
        const platform = normalizePlatformValue(match?.platform);
        if (platform === null || (match.status !== "safe" && match.status !== "safe-delay")) continue;

        matchedIds.add(record.id);
        matchedItems.push({
          ...record,
          platform,
          isicTime:match.row?.time || null,
          platformMode:match.row?.platformMode || null,
          source:"isic"
        });

        /* Compartimos la vía confirmada con PLASTIC/LIT/CTC. Guardamos tanto
           el trip_id de horario como el trip_id live cuando difieren. */
        const cacheIds = new Set([record.id, record.live?.id].filter(Boolean));
        for (const tripId of cacheIds) {
          rememberPlatform(tripId, state.station, platform, "isic", {
            circulation:record.circulation,
            row:match.row,
            assessment:match.assessment,
            imageFetchedAt:parsed.fetchedAt
          });
        }
      }
    }

    /* BETA 3.24.0: el límite es por línea + sentido, no por sentido global.
       Se conservan como máximo las cuatro circulaciones cronológicamente más
       próximas de cada combinación (L6/S1/S2/L7/L12 × asc/desc). */
    const extras = departures
      .filter(record => {
        if (matchedIds.has(record.id)) return false;
        if (record.live && (record.live.stationed === state.station || record.live.nextStop === state.station)) return true;
        return record.targetMs >= nowMs - 60000;
      })
      .sort((a, b) => a.targetMs - b.targetMs)
      .map(record => {
        const fixed = fixedPlatformFor({
          line:record.line,
          station:record.station,
          effectiveOrigin:record.effectiveOrigin
        });
        return {
          ...record,
          platform:fixed?.platform ?? null,
          source:fixed ? "fixed" : record.source
        };
      });

    const uniqueItems = dedupeByCirculation([...matchedItems, ...extras]);
    state.items = limitPerLineDirection(uniqueItems);

    /* Si el iSIC oficial muestra servicio pero no hemos logrado materializar ni
       una circulación, NO afirmamos "SENSE SERVEI COMERCIAL". */
    state.unmatchedOfficialService = Boolean(parsed?.rows?.length && state.items.length === 0);
    state.lastFetch = parsed ? new Date(parsed.fetchedAt) : new Date();
    state.lastError = isicError ? String(isicError?.message || isicError) : null;
    state.state = "ready";
    renderISIC(S);
  })().catch(error => {
    if (requestId === state.requestId) {
      state.lastError = String(error?.message || error);
      state.state = "error";
      renderISIC(S);
    }
  }).finally(() => {
    if (requestId === state.requestId) {
      state.refreshRunning = false;
      state.refreshPromise = null;
    }
  });

  return state.refreshPromise;
}

export function tickISIC(S) {
  if (S.activeView !== "isic") return;
  refreshISIC(S);

  /* La cronometria visible pot canviar sense reconstruir tota la consulta. */
  document.querySelectorAll("#view-isic .isic-trainrow").forEach(button => {
    const tripId = button.dataset.tripId;
    const item = S.isicView.items.find(candidate => candidate.id === tripId);
    if (!item) return;
    const cell = button.querySelector(".plastic-countdown");
    const state = countdownState(item.departure, Date.now());
    if (!cell || !state) return;
    const red = state.overdue || state.seconds <= countdownRedThreshold(item.station);
    cell.textContent = state.overdue ? "0:00" : formatISICCountdown(state.seconds);
    cell.classList.toggle("red", red);
    cell.classList.toggle("overdue", state.overdue);
  });
}
