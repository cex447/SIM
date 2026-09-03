export const MODULE_VERSION = "3.41.0";
import { getTripBundle } from "./gtfs-3.41.0.js";
import { occupancyFingerprint, updateOccupancy } from "./occupancy-3.41.0.js";
import { countdownState, formatOperationalCountdown } from "./time-3.41.0.js";
import {
  isOriginHold,
  parentCode
} from "./operations-3.41.0.js";
import {
  cachedPlatform,
  clearPlatform,
  fetchIsicStation,
  fixedPlatformFor,
  fallbackPlatformFor,
  matchContextsToRows,
  normalizePlatformValue,
  rememberPlatform
} from "./isic-3.41.0.js";
import { displayTurnFor } from "./turns-3.41.0.js";

const FAMILY_ORDER = Object.freeze(["A", "D", "F", "B", "L"]);
/* Mateixa velocitat lineal que el triangle mòbil de LIT:
   36 px en 2,5 s, duplicada des de Beta 3.10.0 = 28,8 px/s. */
const PLASTIC_DELAY_TICKER_SPEED_PX_PER_SECOND = 28.8;
const LINE_BY_FAMILY = Object.freeze({ A: "L6", D: "S1", F: "S2", B: "L7", L: "L12" });
const familyRank = new Map(FAMILY_ORDER.map((family, index) => [family, index]));

const rowNodes = new Map();
const lineGroups = new Map();
const tripContextCache = new Map();
let onSelectTrainHandler = null;
let platformRefreshRunning = false;
let platformRefreshAt = 0;
const filterUi = { lines:new Map(), units:new Map(), all:null };
let delayTickerAnimation = null;
let delayTickerKey = "";
let delayContextPrimeKey = "";

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createFilterDelayMarker() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 18 18");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("plastic-filter-delay-marker");

  const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  /* Exactament la mateixa geometria que el triangle estacionat de LIT. */
  polygon.setAttribute("points", "2,2 14.12435565,9 2,16");
  polygon.setAttribute("fill", "currentColor");
  polygon.setAttribute("stroke", "currentColor");
  polygon.setAttribute("stroke-width", "1.8");
  polygon.setAttribute("stroke-linejoin", "miter");
  polygon.setAttribute("shape-rendering", "geometricPrecision");
  svg.appendChild(polygon);
  /* SVGElement.hidden no se refleja de forma fiable como atributo en Safari.
     El marcador nace oculto mediante atributo real y CSS por defecto. */
  svg.setAttribute("hidden", "hidden");
  return svg;
}

function setFilterDelayMarkerVisible(marker, visible) {
  if (!marker) return;

  marker.classList.toggle("is-visible", Boolean(visible));
  if (visible) marker.removeAttribute("hidden");
  else marker.setAttribute("hidden", "hidden");
}

function wrapFilterControl(button, { type, key, delayMarker = true } = {}) {
  const wrapper = make("div", `plastic-filter-stat plastic-filter-stat-${type}`);
  const marker = delayMarker ? createFilterDelayMarker() : null;
  const count = make("span", "plastic-filter-count", "0");

  if (marker) {
    const touchTarget = button.querySelector(".plastic-filter-touch-target");
    if (touchTarget) touchTarget.appendChild(marker);
    else wrapper.appendChild(marker);
  }
  wrapper.append(button, count);

  const model = { wrapper, button, count, marker };
  if (type === "line") filterUi.lines.set(key, model);
  if (type === "unit") filterUi.units.set(key, model);
  if (type === "all") filterUi.all = model;
  return wrapper;
}

function uniqueUnitCount(trains) {
  return new Set((trains || []).map(train => train?.unit).filter(Boolean)).size;
}

function filterCountText(count) {
  return String(count);
}

function updateFilterSummary(S) {
  const trains = S.trains || [];
  /* Los indicadores de filtro comparten exactamente el mismo criterio que
     el ticker: en_hora=false no basta si el retraso no puede cuantificarse.
     Sólo un +1 o superior confirmado activa el triángulo. */
  const delayed = delayedEntries(S).map(entry => entry.train);
  const delayedFamilies = new Set(delayed.map(train => train.family));
  const delayedSeries = new Set(delayed.map(train => String(train.unit || "").slice(0, 3)));

  for (const family of FAMILY_ORDER) {
    const model = filterUi.lines.get(family);
    if (!model) continue;
    model.count.textContent = filterCountText(uniqueUnitCount(trains.filter(train => train.family === family)));
    setFilterDelayMarkerVisible(model.marker, delayedFamilies.has(family));
  }

  for (const series of S.config.allowedUnitSeries || []) {
    const model = filterUi.units.get(series);
    if (!model) continue;
    model.count.textContent = filterCountText(uniqueUnitCount(
      trains.filter(train => String(train.unit || "").startsWith(`${series}.`))
    ));
    setFilterDelayMarkerVisible(model.marker, delayedSeries.has(series));
  }

  if (filterUi.all) {
    filterUi.all.count.textContent = filterCountText(uniqueUnitCount(trains));
  }
}

function clearDelayTickerAnimation() {
  delayTickerAnimation?.cancel();
  delayTickerAnimation = null;
  delayTickerKey = "";
}

function ensurePlasticStatusStructure() {
  const status = document.querySelector("#plasticStatus");
  if (!status) return null;

  if (status.dataset.enhancedStatus !== "1") {
    clearDelayTickerAnimation();
    status.replaceChildren();
    status.dataset.enhancedStatus = "1";

    const updated = make("span", "plastic-status-updated");
    const delayGroup = make("span", "plastic-delay-group");
    delayGroup.hidden = true;
    const separator = make("span", "plastic-delay-separator", "·");
    const count = make("span", "plastic-delay-count");
    const windowNode = make("span", "plastic-delay-window");
    const track = make("span", "plastic-delay-track");
    const copyA = make("span", "plastic-delay-copy");
    const copyB = make("span", "plastic-delay-copy");
    copyB.setAttribute("aria-hidden", "true");
    track.append(copyA, copyB);
    windowNode.appendChild(track);
    delayGroup.append(separator, count, windowNode);
    status.append(updated, delayGroup);
  }

  return {
    status,
    updated:status.querySelector(".plastic-status-updated"),
    delayGroup:status.querySelector(".plastic-delay-group"),
    count:status.querySelector(".plastic-delay-count"),
    windowNode:status.querySelector(".plastic-delay-window"),
    track:status.querySelector(".plastic-delay-track"),
    copyA:status.querySelectorAll(".plastic-delay-copy")[0],
    copyB:status.querySelectorAll(".plastic-delay-copy")[1]
  };
}

function setPlainPlasticStatus(status, text, error = false) {
  clearDelayTickerAnimation();
  if (!status) return;
  status.removeAttribute("data-enhanced-status");
  status.replaceChildren(document.createTextNode(text));
  status.classList.toggle("error", Boolean(error));
}

function startDelayTicker(refs, key) {
  if (!refs?.track || !refs.windowNode) return;
  if (delayTickerKey === key && delayTickerAnimation) return;

  clearDelayTickerAnimation();
  delayTickerKey = key;

  requestAnimationFrame(() => {
    if (delayTickerKey !== key) return;
    const first = refs.copyA?.getBoundingClientRect();
    const windowRect = refs.windowNode.getBoundingClientRect();
    const distance = Math.max(0, Number(first?.width) || 0);

    /* Si el text cap íntegrament, es manté estàtic. Si no, es duplica i
       circula exactament a 28,8 px/s, la velocitat lineal del triangle LIT. */
    if (!distance || distance <= Math.max(0, windowRect.width - 2) ||
        window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      refs.copyB.hidden = true;
      refs.track.style.transform = "translate3d(0,0,0)";
      return;
    }

    refs.copyB.hidden = false;
    const duration = Math.max(1000, (distance / PLASTIC_DELAY_TICKER_SPEED_PX_PER_SECOND) * 1000);
    delayTickerAnimation = refs.track.animate(
      [
        { transform:"translate3d(0,0,0)" },
        { transform:`translate3d(-${distance}px,0,0)` }
      ],
      { duration, easing:"linear", iterations:Infinity }
    );
  });
}

function delayedEntries(S) {
  const unique = new Map();
  for (const train of S.trains || []) {
    if (train.onTime !== false || unique.has(train.circulation)) continue;
    unique.set(train.circulation, train);
  }
  return [...unique.values()]
    .sort(sortTrains)
    .map(train => ({ train, minutes:delayMinutes(cachedTripContext(train), train) }))
    .filter(entry => Number.isFinite(entry.minutes) && entry.minutes >= 1);
}

export function delayTickerEntryText(S, train, minutes) {
  const turn = displayTurnFor(
    S.turnAssignments,
    train.circulation,
    train.id
  );
  /* Un único espacio, idéntico, separa circulación, turno y retraso. */
  return `${train.circulation} ${turn} +${minutes}`;
}

function primeDelayContexts(S) {
  const missing = (S.trains || []).filter(train =>
    train.onTime === false && !cachedTripContext(train)
  );
  if (!missing.length) {
    delayContextPrimeKey = "";
    return;
  }

  const key = missing.map(train => train.id).sort().join("|");
  if (!key || key === delayContextPrimeKey) return;
  delayContextPrimeKey = key;

  Promise.all(missing.map(train => ensureTripContext(S, train))).finally(() => {
    if (delayContextPrimeKey === key) delayContextPrimeKey = "";
    if (S.activeView === "plastic") {
      updateFilterSummary(S);
      renderPlasticStatus(S);
    }
  });
}

function renderPlasticStatus(S) {
  const status = document.querySelector("#plasticStatus");
  if (!status) return;

  if (S.lastError && !S.lastFetch) {
    setPlainPlasticStatus(status, "DADES NO DISPONIBLES", true);
    return;
  }
  if (S.lastError && S.lastFetch) {
    setPlainPlasticStatus(
      status,
      `DADES CONSERVADES ${S.lastFetch.toLocaleTimeString("es-ES", { hour12:false })}`,
      true
    );
    return;
  }
  if (!S.lastFetch) {
    setPlainPlasticStatus(status, "ESPERANT DADES", false);
    return;
  }

  const refs = ensurePlasticStatusStructure();
  if (!refs) return;
  refs.status.classList.remove("error");
  refs.updated.textContent = `ACTUALITZAT ${S.lastFetch.toLocaleTimeString("es-ES", { hour12:false })}`;

  const entries = delayedEntries(S);
  if (!entries.length) {
    refs.delayGroup.hidden = true;
    clearDelayTickerAnimation();
    primeDelayContexts(S);
    return;
  }

  refs.delayGroup.hidden = false;
  refs.count.textContent = `${unitCountText(entries.length)}:`;
  const tickerText = entries
    .map(({ train, minutes }) => delayTickerEntryText(S, train, minutes))
    .join("   ");
  const loopText = `${tickerText}   `;
  refs.copyA.hidden = false;
  refs.copyA.textContent = loopText;
  refs.copyB.textContent = loopText;

  const key = entries.map(({ train, minutes }) => {
    const turn = displayTurnFor(S.turnAssignments, train.circulation, train.id);
    return `${train.circulation}:${turn}:${minutes}`;
  }).join("|");
  startDelayTicker(refs, key);
  primeDelayContexts(S);
}


function unitRank(unit) {
  const match = String(unit || "").match(/^(\d{3})\.(\d{2})$/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return Number(match[1]) * 100 + Number(match[2]);
}

function sortTrains(a, b) {
  const familyDiff = (familyRank.get(a.family) ?? 99) - (familyRank.get(b.family) ?? 99);
  if (familyDiff) return familyDiff;

  /* Dentro de cada línea comercial, PLASTIC se ordena por número de
     circulación. La UT queda únicamente como desempate estable. */
  const circulationDiff = a.circulation.localeCompare(
    b.circulation,
    "es",
    { numeric:true, sensitivity:"base" }
  );
  if (circulationDiff) return circulationDiff;

  return unitRank(a.unit) - unitRank(b.unit);
}

function passesFilters(S, train) {
  if (S.plasticFilters.lines.size && !S.plasticFilters.lines.has(train.family)) return false;
  if (S.plasticFilters.units.size && !S.plasticFilters.units.has(train.unit.slice(0, 3))) return false;
  return true;
}

function syncFilterVisuals(S) {
  document.querySelectorAll("#lineFilters [data-family]").forEach(button => {
    const selected = S.plasticFilters.lines.size === 0 || S.plasticFilters.lines.has(button.dataset.family);
    button.classList.toggle("selected", selected);
    button.classList.toggle("dimmed", !selected);
    button.setAttribute("aria-pressed", String(selected));
  });

  document.querySelectorAll("#utFilters [data-series]").forEach(button => {
    const selected = S.plasticFilters.units.has(button.dataset.series);
    button.classList.toggle("selected", selected);
    button.classList.toggle("dimmed", !selected);
    button.setAttribute("aria-pressed", String(selected));
  });

  const allButton = document.querySelector("#clearPlasticFilters");
  const allSelected = S.plasticFilters.units.size === 0;
  allButton.classList.toggle("selected", allSelected);
  allButton.classList.toggle("dimmed", !allSelected);
  allButton.setAttribute("aria-pressed", String(allSelected));
}

function lineButton(S, family) {
  const line = LINE_BY_FAMILY[family];
  const button = make("button", "line-filter selected");
  button.type = "button";
  button.dataset.family = family;
  button.setAttribute("aria-pressed", "true");
  button.setAttribute("aria-label", line);

  const image = document.createElement("img");
  image.src = S.config.lineAssets?.[line] || "";
  image.alt = line;
  image.decoding = "async";

  const fallback = make("span", "line-fallback", line);
  fallback.hidden = true;

  image.addEventListener("error", () => {
    image.hidden = true;
    fallback.hidden = false;
  });

  const touchTarget = make("span", "plastic-filter-touch-target");
  touchTarget.append(image, fallback);
  button.appendChild(touchTarget);

  button.addEventListener("click", () => {
    const set = S.plasticFilters.lines;

    if (set.size === 0) {
      set.add(family);
    } else if (set.has(family)) {
      set.delete(family);
    } else {
      set.add(family);
    }

    if (set.size === FAMILY_ORDER.length) set.clear();

    syncFilterVisuals(S);
    renderPLASTIC(S);
  });

  return wrapFilterControl(button, { type:"line", key:family, delayMarker:true });
}

function unitButton(S, series) {
  const button = make("button", "text-filter ut-filter dimmed");
  button.appendChild(make("span", "plate-label plastic-filter-touch-target", series));
  button.type = "button";
  button.dataset.series = series;
  button.setAttribute("aria-pressed", "false");

  button.addEventListener("click", () => {
    const set = S.plasticFilters.units;

    if (set.size === 0) {
      set.add(series);
    } else if (set.has(series)) {
      set.delete(series);
    } else {
      set.add(series);
    }

    if (set.size === S.config.allowedUnitSeries.length) set.clear();

    syncFilterVisuals(S);
    renderPLASTIC(S);
  });

  return wrapFilterControl(button, { type:"unit", key:series, delayMarker:true });
}

export function wirePLASTIC(S, { onSelectTrain } = {}) {
  onSelectTrainHandler = onSelectTrain || null;

  const lineBox = document.querySelector("#lineFilters");
  const unitBox = document.querySelector("#utFilters");
  const allButton = document.querySelector("#clearPlasticFilters");

  lineBox.replaceChildren(...FAMILY_ORDER.map(family => lineButton(S, family)));
  unitBox.replaceChildren(...S.config.allowedUnitSeries.map(series => unitButton(S, series)));

  if (!allButton.closest(".plastic-filter-stat")) {
    const parent = allButton.parentNode;
    const next = allButton.nextSibling;
    const wrapper = wrapFilterControl(allButton, { type:"all", key:"all", delayMarker:false });
    parent?.insertBefore(wrapper, next);
  }

  allButton.addEventListener("click", () => {
    S.plasticFilters.units.clear();
    syncFilterVisuals(S);
    renderPLASTIC(S);
  });

  syncFilterVisuals(S);
}

function unitCountText(count) {
  return `${count} ${count === 1 ? "UT" : "UTs"}`;
}

function groupKey(direction, family) {
  return `${direction}:${family}`;
}

function rowKey(direction, train) {
  return `${direction}:${train.id}`;
}

function ensureLineGroup(S, direction, family) {
  const key = groupKey(direction, family);
  if (lineGroups.has(key)) return lineGroups.get(key);

  const host = document.querySelector(direction === "asc" ? "#ascList" : "#descList");
  const group = make("section", "plastic-line-group");
  group.dataset.family = family;

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

  const count = make("span", "line-group-count", "0 UTs");
  heading.append(image, fallback, count);

  const rows = make("div", "plastic-line-rows");
  group.append(heading, rows);
  host.appendChild(group);

  const model = { group, rows, count };
  lineGroups.set(key, model);
  return model;
}

export function createOperationalTrainRow(
  train,
  { onSelectTrain = null, className = "" } = {}
) {
  const row = make("button", `trainrow${className ? ` ${className}` : ""}`);
  row.type = "button";
  row.dataset.tripId = train.id;
  row.dataset.circulation = train.circulation;

  const unit = make("span", "train-unit");
  const circulation = make("span", "train-circulation");
  const turn = make("span", "train-turn");
  const occupancy = make("span", "occupancy occupancy-compact");
  const current = make("span", "train-current station-token");
  const arrow = make("span", "route-arrow");
  arrow.setAttribute("aria-hidden", "true");
  const destination = make("span", "train-destination");
  const operational = make("span", "plastic-operational");
  const countdown = make("span", "plastic-countdown");

  row.append(
    unit,
    circulation,
    turn,
    occupancy,
    current,
    arrow,
    destination,
    operational,
    countdown
  );

  row.addEventListener("click", () => {
    if (onSelectTrain) {
      onSelectTrain(row.dataset.circulation || "", row.dataset.turn || "");
    }
  });

  const model = {
    row,
    unit,
    circulation,
    turn,
    occupancy,
    current,
    arrow,
    destination,
    operational,
    countdown,
    fingerprint: "",
    tripId: train.id
  };

  return model;
}

function createTrainRow(direction, train) {
  const model = createOperationalTrainRow(train, {
    onSelectTrain:circulation => {
      if (onSelectTrainHandler) onSelectTrainHandler(circulation);
    }
  });
  rowNodes.set(rowKey(direction, train), model);
  return model;
}

function fingerprint(train) {
  return [
    train.id,
    train.unit,
    train.circulation,
    train.origin || "",
    train.stationed || "",
    train.nextStop || "",
    train.destination || "",
    train.onTime === null ? "?" : String(train.onTime),
    occupancyFingerprint(train.occupancy)
  ].join("|");
}

function setDestination(cell, code, stationed = false) {
  cell.replaceChildren();
  const station = make(
    "strong",
    `station-token destination-code${stationed ? " stationed" : ""}`,
    code || "—"
  );
  cell.appendChild(station);
}

function networkStationPath(network, origin, destination) {
  const from = String(origin || "").toUpperCase();
  const to = String(destination || "").toUpperCase();
  if (!from || !to) return [];
  if (from === to) return [from];

  const graph = new Map();
  for (const segment of network?.segments || []) {
    const a = String(segment?.from || "").toUpperCase();
    const b = String(segment?.to || "").toUpperCase();
    if (!a || !b) continue;
    if (!graph.has(a)) graph.set(a, []);
    if (!graph.has(b)) graph.set(b, []);
    graph.get(a).push(b);
    graph.get(b).push(a);
  }

  const queue = [[from]];
  const visited = new Set([from]);
  while (queue.length) {
    const path = queue.shift();
    const last = path[path.length - 1];
    for (const candidate of graph.get(last) || []) {
      if (visited.has(candidate)) continue;
      const nextPath = [...path, candidate];
      if (candidate === to) return nextPath;
      visited.add(candidate);
      queue.push(nextPath);
    }
  }
  return [];
}

export function movingSegment(train, context = null, network = null) {
  const next = String(train?.nextStop || "").toUpperCase();
  if (!next) return { current:"", next:"" };

  const scheduledStops = context?.times || [];
  const nextIndex = scheduledStops.findIndex(stop => parentCode(stop) === next);
  if (nextIndex > 0) {
    return { current:parentCode(scheduledStops[nextIndex - 1]), next };
  }

  /* Mientras llega GTFS, la red BV (un árbol sin atajos ambiguos) permite
     mostrar ya el tramo inmediato. En cuanto existe contexto horario, éste
     conserva siempre la prioridad. */
  const path = networkStationPath(network, train?.origin, train?.destination);
  const networkIndex = path.indexOf(next);
  const current = networkIndex > 0 ? path[networkIndex - 1] : "";
  return { current, next };
}

function updateRouteCells(model, train, context = null, network = null) {
  const stationed = Boolean(train.stationed);

  const segment = movingSegment(train, context, network);
  model.current.textContent = stationed ? "" : (segment.current || "");
  model.current.classList.toggle("state-spacer", stationed || !segment.current);

  model.arrow.textContent = "→";
  model.arrow.className = stationed
    ? "route-arrow route-arrow-placeholder"
    : "route-arrow moving";

  setDestination(
    model.destination,
    stationed ? (train.stationed || "—") : (segment.next || "—"),
    stationed
  );
}

async function ensureTripContext(S, train) {
  if (!train?.id) return null;

  const cached = tripContextCache.get(train.id);
  if (cached?.state === "ready") return cached.value;
  if (cached?.state === "failed") return null;
  if (cached?.promise) return cached.promise;

  const promise = getTripBundle(S.config.gtfsZipIndexUrl, train.id)
    .then(bundle => {
      const firstStop = bundle.times[0] || null;
      const destinationStop = bundle.times[bundle.times.length - 1] || null;
      const effectiveOrigin = parentCode(firstStop);
      const effectiveDestination = parentCode(destinationStop);

      const value = {
        departure: firstStop?.departure_time || firstStop?.arrival_time || null,
        headsign: bundle.trip?.trip_headsign || "",
        destinationName: destinationStop?.stop_name || bundle.trip?.trip_headsign || "",
        effectiveOrigin,
        effectiveDestination,
        times: bundle.times
      };

      tripContextCache.set(train.id, { state: "ready", value });
      return value;
    })
    .catch(error => {
      console.warn(
        "SIM+ PLASTIC: no s'ha pogut carregar el context horari",
        train.circulation,
        error
      );
      tripContextCache.set(train.id, { state: "failed", value: null });
      return null;
    });

  tripContextCache.set(train.id, { state: "pending", promise });
  return promise;
}

function cachedTripContext(train) {
  const cached = tripContextCache.get(train?.id);
  return cached?.state === "ready" ? cached.value : null;
}

function operationalReferenceTime(context, train) {
  if (!context?.times?.length) return null;

  if (train.stationed) {
    const stop = context.times.find(candidate =>
      parentCode(candidate) === String(train.stationed)
    );
    return stop?.departure_time || stop?.arrival_time || null;
  }

  if (train.nextStop) {
    const stop = context.times.find(candidate =>
      parentCode(candidate) === String(train.nextStop)
    );
    return stop?.arrival_time || stop?.departure_time || null;
  }

  return null;
}

function delayMinutes(context, train) {
  if (train.onTime !== false) return null;
  const reference = operationalReferenceTime(context, train);
  if (!reference) return null;

  const state = countdownState(reference, Date.now());
  if (!state) return null;
  return Math.max(0, Math.floor(Math.max(0, -state.diffMs) / 60000));
}

function updateOriginCountdown(model, train) {
  const context = cachedTripContext(train);
  const departure = context?.departure || null;
  const origin = context?.effectiveOrigin || train.origin;

  if (!isOriginHold(train, origin) || !departure) {
    model.countdown.textContent = "";
    model.countdown.className = "plastic-countdown";
    return;
  }

  const state = countdownState(departure, Date.now());
  if (!state) {
    model.countdown.textContent = "";
    model.countdown.className = "plastic-countdown";
    return;
  }

  // PLASTIC: el rojo queda reservado exclusivamente a retraso real
  // confirmado por Posicionament dels trens (onTime === false).
  // Los umbrales de cuenta atrás y 0:00 no cambian de color por sí solos.
  const delayed = train.onTime === false;

  model.countdown.textContent = state.overdue ? "0:00" : formatOperationalCountdown(state.seconds);
  model.countdown.className = "plastic-countdown";
  model.countdown.classList.toggle("red", delayed);
  model.countdown.removeAttribute("data-overdue");
}

function updateOperationalFromCache(model, train, S) {
  model.operational.textContent = "";
  model.operational.className = "plastic-operational";
  model.operational.removeAttribute("data-source");

  const context = cachedTripContext(train);
  const origin = context?.effectiveOrigin || train.origin;

  if (context && isOriginHold(train, origin)) {
    const result = cachedPlatform(
      train.id,
      origin,
      S.config.isic?.staleMs || 30000
    );
    let platform = normalizePlatformValue(result?.platform);
    let source = result?.source || "unknown";

    if (platform === null) {
      const fallback = fallbackPlatformFor({
        line:train.line,
        circulation:train.circulation,
        ascending:Boolean(train.ascending),
        station:origin,
        effectiveOrigin:origin,
        effectiveDestination:context?.effectiveDestination || train.destination || "",
        isOrigin:true,
        isFinal:Boolean(context?.effectiveDestination && origin === context.effectiveDestination)
      });
      platform = normalizePlatformValue(fallback?.platform);
      source = fallback?.source || source;
    }
    if (platform === null) return;

    model.operational.textContent = `VÍA ${platform}`;
    model.operational.dataset.source = source;
    model.operational.classList.toggle("red", train.onTime === false);
    return;
  }

  if (train.onTime !== false) return;

  const minutes = delayMinutes(context, train);
  if (minutes === null) return;

  model.operational.textContent = `+${minutes}`;
  model.operational.classList.add("red", "delay-minutes");
}

function refreshVisibleOperational(S) {
  for (const model of rowNodes.values()) {
    const train = (S.trains || []).find(item => item.id === model.tripId);
    if (!train) continue;
    const context = cachedTripContext(train);
    if (context) updateRouteCells(model, train, context, S.network);
    updateOriginCountdown(model, train);
    updateOperationalFromCache(model, train, S);
  }
}

async function refreshOriginPlatforms(S, { force = false } = {}) {
  if (platformRefreshRunning || !S.config?.isic?.enabled) return;

  const interval = Math.max(10000, Number(S.config.isic?.refreshMs) || 10000);
  if (!force && Date.now() - platformRefreshAt < interval) return;

  platformRefreshRunning = true;
  platformRefreshAt = Date.now();

  try {
    const trains = S.trains || [];
    const pairs = await Promise.all(
      trains.map(async train => ({ train, context:await ensureTripContext(S, train) }))
    );

    const groups = new Map();

    for (const { train, context } of pairs) {
      if (!context?.effectiveOrigin || !isOriginHold(train, context.effectiveOrigin)) continue;

      const fixed = fixedPlatformFor({
        line:train.line,
        circulation:train.circulation,
        ascending:Boolean(train.ascending),
        station:context.effectiveOrigin,
        effectiveOrigin:context.effectiveOrigin,
        effectiveDestination:context.effectiveDestination,
        isOrigin:true,
        isFinal:context.effectiveOrigin === context.effectiveDestination
      });

      if (fixed) {
        rememberPlatform(train.id, context.effectiveOrigin, fixed.platform, "fixed", {
          circulation:train.circulation,
          reason:fixed.reason
        });
        continue;
      }

      if (!groups.has(context.effectiveOrigin)) groups.set(context.effectiveOrigin, []);
      groups.get(context.effectiveOrigin).push({ train, context });
    }

    await Promise.all([...groups.entries()].map(async ([station, items]) => {
      try {
        const parsed = await fetchIsicStation(S.config.isic, station, { force });
        const contexts = items.map(({ train, context }) => {
          const fallback = fallbackPlatformFor({
            line:train.line,
            circulation:train.circulation,
            ascending:Boolean(train.ascending),
            station,
            effectiveOrigin:context.effectiveOrigin,
            effectiveDestination:context.effectiveDestination,
            isOrigin:true,
            isFinal:context.effectiveOrigin === context.effectiveDestination
          });
          return {
            key:train.id,
            id:train.id,
            circulation:train.circulation,
            line:train.line,
            onTime:train.onTime,
            ascending:Boolean(train.ascending),
            station,
            effectiveOrigin:context.effectiveOrigin,
            effectiveDestination:context.effectiveDestination,
            isOrigin:true,
            isFinal:context.effectiveOrigin === context.effectiveDestination,
            platformHint:fallback?.platform ?? null,
            departure:context.departure,
            originHold:true
          };
        });

        const matches = matchContextsToRows(contexts, parsed.rows, parsed.fetchedAt);
        for (const { train } of items) {
          const match = matches.get(train.id);
          if (normalizePlatformValue(match?.platform) !== null && (match.status === "safe" || match.status === "safe-delay")) {
            rememberPlatform(train.id, station, match.platform, "isic", {
              circulation:train.circulation,
              row:match.row,
              assessment:match.assessment,
              imageFetchedAt:parsed.fetchedAt
            });
          } else {
            /* Captura iSIC válida pero sin correspondencia segura: nunca
               conservamos una vía anterior como si siguiera confirmada. */
            clearPlatform(train.id, station);
          }
        }
      } catch (error) {
        /* En error de red mantenemos únicamente la caché muy reciente; la
           función cachedPlatform aplica staleMs y luego la oculta. */
        console.warn(`SIM+ PLASTIC: iSIC ${station}`, error);
      }
    }));
  } finally {
    platformRefreshRunning = false;
    refreshVisibleOperational(S);
  }
}

function ensureOperationalData(model, train, S) {
  const needsContext = Boolean(train?.id);
  if (!needsContext) return;

  ensureTripContext(S, train).then(context => {
    const live = (S.trains || []).find(item => item.id === train.id);
    if (!live || !context) return;

    updateRouteCells(model, live, context, S.network);
    updateOriginCountdown(model, live);
    updateOperationalFromCache(model, live, S);
    refreshOriginPlatforms(S);
  });
}

export function updateOperationalTrainRow(model, train, S) {
  model.tripId = train.id;
  model.row.dataset.tripId = train.id;
  model.row.dataset.circulation = train.circulation;
  model.row.dataset.turn = displayTurnFor(
    S.turnAssignments,
    train.circulation,
    train.id
  );

  const fp = fingerprint(train);
  const isTarget = S.query?.code === train.circulation;
  model.row.classList.toggle("search-target", isTarget);

  if (model.fingerprint !== fp) {
    model.fingerprint = fp;
    model.unit.textContent = train.unit;
    model.circulation.textContent = train.circulation;
    model.turn.textContent = displayTurnFor(
      S.turnAssignments,
      train.circulation,
      train.id
    );

    const delayed = train.onTime === false;
    model.row.classList.toggle("delayed-row", delayed);
    model.unit.classList.toggle("delayed-text", delayed);
    model.circulation.classList.toggle("delayed-text", delayed);
    model.turn.classList.toggle("delayed-text", delayed);

    updateOccupancy(model.occupancy, train.occupancy, {
      compact: true,
      delayed,
      unit: train.unit
    });
    updateRouteCells(model, train, null, S.network);
  }

  updateOriginCountdown(model, train);
  updateOperationalFromCache(model, train, S);
  ensureOperationalData(model, train, S);
}

export function tickOperationalTrainRow(model, train, S) {
  updateOriginCountdown(model, train);
  updateOperationalFromCache(model, train, S);
}

function emptyMessage(S) {
  const units = [...S.plasticFilters.units].sort();

  if (units.length === 1) return `ACTUALMENT NO CIRCULEN UT${units[0]}`;
  if (units.length > 1) {
    return `ACTUALMENT NO CIRCULEN ${units.map(series => `UT${series}`).join(" / ")}`;
  }

  return "ACTUALMENT NO CIRCULEN UNITATS AMB AQUESTS CONDICIONANTS";
}

function setEmpty(direction, empty, text) {
  const host = document.querySelector(direction === "asc" ? "#ascEmpty" : "#descEmpty");
  host.hidden = !empty;
  host.textContent = empty ? text : "";
}

function reconcileDirection(S, direction, trains) {
  const grouped = new Map(FAMILY_ORDER.map(family => [family, []]));
  for (const train of trains) grouped.get(train.family)?.push(train);

  const activeRowKeys = new Set();

  for (const family of FAMILY_ORDER) {
    const lineTrains = grouped.get(family);
    const group = ensureLineGroup(S, direction, family);
    group.count.textContent = unitCountText(lineTrains.length);

    if (!lineTrains.length) {
      group.group.hidden = true;
      continue;
    }

    group.group.hidden = false;

    for (const train of lineTrains) {
      const key = rowKey(direction, train);
      activeRowKeys.add(key);

      const model = rowNodes.get(key) || createTrainRow(direction, train);
      updateOperationalTrainRow(model, train, S);
      group.rows.appendChild(model.row);
    }
  }

  for (const [key, model] of rowNodes) {
    if (!key.startsWith(`${direction}:`)) continue;
    if (activeRowKeys.has(key)) continue;

    model.row.remove();
    rowNodes.delete(key);
  }
}

export function renderPLASTIC(S) {
  const allTrains = (S.trains || []).slice().sort(sortTrains);
  const filtered = allTrains
    .filter(train => passesFilters(S, train))
    .sort(sortTrains);

  const asc = filtered.filter(train => train.ascending);
  const desc = filtered.filter(train => !train.ascending);
  const empty = emptyMessage(S);

  /*
   * “SENSE SERVEI COMERCIAL” solo corresponde a ausencia real de servicio
   * BV tras una consulta válida; no se activa porque un filtro deje 0 filas.
   */
  const noCommercialService =
    Boolean(S.lastFetch) && !S.lastError && allTrains.length === 0;

  const directions = document.querySelector(".plastic-directions");
  const ascDirection = document.querySelector("#ascDirection");
  const descDirection = document.querySelector("#descDirection");
  const ascLabel = document.querySelector("#ascLabel");
  const ascCount = document.querySelector("#ascCount");

  directions?.classList.toggle("no-service", noCommercialService);
  if (ascLabel) ascLabel.textContent = noCommercialService
    ? "SENSE SERVEI COMERCIAL"
    : "ASCENDENTS";
  if (ascCount) ascCount.hidden = noCommercialService;
  if (ascDirection) ascDirection.hidden = false;
  if (descDirection) descDirection.hidden = noCommercialService;

  if (noCommercialService) {
    setEmpty("asc", false, "");
    setEmpty("desc", false, "");
    reconcileDirection(S, "asc", []);
    reconcileDirection(S, "desc", []);
  } else {
    setEmpty("asc", asc.length === 0, empty);
    setEmpty("desc", desc.length === 0, empty);
    reconcileDirection(S, "asc", asc);
    reconcileDirection(S, "desc", desc);

    document.querySelector("#ascCount").textContent = unitCountText(asc.length);
    document.querySelector("#descCount").textContent = unitCountText(desc.length);
  }

  updateFilterSummary(S);
  renderPlasticStatus(S);

  syncFilterVisuals(S);
  /* Les vies d'origen via iSIC només es consulten mentre PLASTIC és visible.
     CTC reutilitza posicionament FGC i no genera trànsit extra al Worker. */
  if (S.activeView === "plastic") refreshOriginPlatforms(S);
}

export function tickPLASTIC(S) {
  for (const model of rowNodes.values()) {
    const train = (S.trains || []).find(item => item.id === model.tripId);
    if (!train) continue;
    tickOperationalTrainRow(model, train, S);
  }
}

export function revealSearchedTrain(S) {
  const code = S.query?.code;
  if (!code || S.activeView !== "plastic") return;

  requestAnimationFrame(() => {
    const row = document.querySelector(`.trainrow[data-circulation="${CSS.escape(code)}"]`);
    if (row) row.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}
