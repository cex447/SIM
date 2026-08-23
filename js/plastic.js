import { getTripBundle } from "./gtfs.js?v=3.8.0";
import { occupancyFingerprint, updateOccupancy } from "./occupancy.js?v=3.8.0";
import { countdownState, formatCountdown } from "./time.js?v=3.8.0";
import {
  countdownRedThreshold,
  isOriginHold,
  parentCode
} from "./operations.js?v=3.8.0";

const FAMILY_ORDER = Object.freeze(["A", "D", "F", "B", "L"]);
const LINE_BY_FAMILY = Object.freeze({ A: "L6", D: "S1", F: "S2", B: "L7", L: "L12" });
const familyRank = new Map(FAMILY_ORDER.map((family, index) => [family, index]));

const rowNodes = new Map();
const lineGroups = new Map();
const originScheduleCache = new Map();
let onSelectTrainHandler = null;

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}


function unitRank(unit) {
  const match = String(unit || "").match(/^(\d{3})\.(\d{2})$/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return Number(match[1]) * 100 + Number(match[2]);
}

function sortTrains(a, b) {
  const familyDiff = (familyRank.get(a.family) ?? 99) - (familyRank.get(b.family) ?? 99);
  if (familyDiff) return familyDiff;

  const unitDiff = unitRank(a.unit) - unitRank(b.unit);
  if (unitDiff) return unitDiff;

  return a.circulation.localeCompare(b.circulation, "es", { numeric: true });
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

  button.append(image, fallback);

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

  return button;
}

function unitButton(S, series) {
  const button = make("button", "text-filter ut-filter dimmed");
  button.appendChild(make("span", "plate-label", series));
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

  return button;
}

export function wirePLASTIC(S, { onSelectTrain } = {}) {
  onSelectTrainHandler = onSelectTrain || null;

  const lineBox = document.querySelector("#lineFilters");
  const unitBox = document.querySelector("#utFilters");
  const allButton = document.querySelector("#clearPlasticFilters");

  lineBox.replaceChildren(...FAMILY_ORDER.map(family => lineButton(S, family)));
  unitBox.replaceChildren(...S.config.allowedUnitSeries.map(series => unitButton(S, series)));

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

function createTrainRow(direction, train) {
  const row = make("button", "trainrow");
  row.type = "button";
  row.dataset.tripId = train.id;
  row.dataset.circulation = train.circulation;

  const unit = make("span", "train-unit");
  const circulation = make("span", "train-circulation");
  const occupancy = make("span", "occupancy occupancy-compact");
  const where = make("span", "train-where");
  const countdown = make("span", "plastic-countdown");
  countdown.hidden = true;

  row.append(unit, circulation, occupancy, where, countdown);

  row.addEventListener("click", () => {
    if (onSelectTrainHandler) onSelectTrainHandler(train.circulation);
  });

  const model = {
    row,
    unit,
    circulation,
    occupancy,
    where,
    countdown,
    fingerprint: "",
    tripId: train.id
  };

  rowNodes.set(rowKey(direction, train), model);
  return model;
}

function fingerprint(train) {
  return [
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

function appendStation(where, code) {
  where.appendChild(make("strong", "station-token", code || "—"));
}

function appendRouteArrow(where, moving) {
  const arrow = make("span", `route-arrow${moving ? " moving" : ""}`, "→");
  arrow.setAttribute("aria-hidden", "true");
  where.appendChild(arrow);
}

function updateWhere(model, train) {
  model.where.replaceChildren();

  if (train.stationed) {
    model.where.appendChild(make("strong", "state-token", "est."));
    model.where.appendChild(document.createTextNode(" "));
    appendStation(model.where, train.stationed);
    model.where.appendChild(document.createTextNode(" "));

    /*
     * Estacionado: no se muestra flecha. Conservamos exactamente su caja
     * para que la estación de destino no cambie de posición al pasar a marcha.
     */
    const reservedArrow = make("span", "route-arrow route-arrow-placeholder", "→");
    reservedArrow.setAttribute("aria-hidden", "true");
    model.where.appendChild(reservedArrow);

    model.where.appendChild(document.createTextNode(" "));
    appendStation(model.where, train.destination);
    return;
  }

  // En movimiento se oculta “est.”, pero se conserva exactamente su anchura.
  model.where.appendChild(make("strong", "state-token state-spacer", "est."));
  model.where.appendChild(document.createTextNode(" "));
  appendStation(model.where, train.nextStop);
  model.where.appendChild(document.createTextNode(" "));
  appendRouteArrow(model.where, true);
  model.where.appendChild(document.createTextNode(" "));
  appendStation(model.where, train.destination);
}


async function ensureOriginDeparture(S, train) {
  if (!train?.id) return null;

  const cached = originScheduleCache.get(train.id);
  if (cached?.state === "ready") return cached.departure;
  if (cached?.state === "failed") return null;
  if (cached?.promise) return cached.promise;

  const promise = getTripBundle(S.config.gtfsZipIndexUrl, train.id)
    .then(bundle => {
      const origin = String(train.origin || "");
      const stop = bundle.times.find((candidate, index) =>
        parentCode(candidate) === origin &&
        (index === 0 || Number(candidate.stop_sequence) === 1)
      ) || bundle.times.find(candidate => parentCode(candidate) === origin);

      const departure = stop?.departure_time || stop?.arrival_time || null;
      originScheduleCache.set(train.id, { state: "ready", departure });
      return departure;
    })
    .catch(error => {
      console.warn("SIM+ PLASTIC: no s'ha pogut carregar la sortida de capçalera", train.circulation, error);
      originScheduleCache.set(train.id, { state: "failed", departure: null });
      return null;
    });

  originScheduleCache.set(train.id, { state: "pending", promise });
  return promise;
}

function updateOriginCountdown(model, train) {
  const cached = originScheduleCache.get(train.id);
  const departure = cached?.state === "ready" ? cached.departure : null;

  if (!isOriginHold(train) || !departure) {
    model.countdown.hidden = true;
    model.countdown.textContent = "";
    model.countdown.className = "plastic-countdown";
    return;
  }

  const state = countdownState(departure, Date.now());
  if (!state) {
    model.countdown.hidden = true;
    return;
  }

  const threshold = countdownRedThreshold(train.origin);
  const red = train.onTime === false || state.overdue || state.seconds <= threshold;

  model.countdown.hidden = false;
  model.countdown.textContent = state.overdue ? "0:00" : formatCountdown(state.seconds);
  model.countdown.className = "plastic-countdown";
  model.countdown.classList.toggle("red", red);
  model.countdown.classList.toggle("overdue", state.overdue);
}

function updateTrainRow(model, train, S) {
  const fp = fingerprint(train);
  const isTarget = S.query?.code === train.circulation;
  model.row.classList.toggle("search-target", isTarget);

  if (model.fingerprint !== fp) {
    model.fingerprint = fp;
    model.unit.textContent = train.unit;
    model.circulation.textContent = train.circulation;

    const delayed = train.onTime === false;
    model.row.classList.toggle("delayed-row", delayed);
    model.unit.classList.toggle("delayed-text", delayed);
    model.circulation.classList.toggle("delayed-text", delayed);

    updateOccupancy(model.occupancy, train.occupancy, { compact: true, delayed });
    updateWhere(model, train);
  }

  if (isOriginHold(train)) {
    ensureOriginDeparture(S, train).then(() => {
      const live = (S.trains || []).find(item => item.id === train.id);
      if (live) updateOriginCountdown(model, live);
    });
  }

  updateOriginCountdown(model, train);
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

function statusText(S, count) {
  if (S.lastError && !S.lastFetch) return "DADES NO DISPONIBLES";

  if (S.lastError && S.lastFetch) {
    return `DADES CONSERVADES ${S.lastFetch.toLocaleTimeString("es-ES", { hour12: false })}`;
  }

  if (!S.lastFetch) return "ESPERANT DADES";

  return `ACTUALITZAT ${S.lastFetch.toLocaleTimeString("es-ES", { hour12: false })} · ${unitCountText(count)}`;
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
      updateTrainRow(model, train, S);
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
  const filtered = (S.trains || [])
    .filter(train => passesFilters(S, train))
    .sort(sortTrains);

  const asc = filtered.filter(train => train.ascending);
  const desc = filtered.filter(train => !train.ascending);
  const empty = emptyMessage(S);

  setEmpty("asc", asc.length === 0, empty);
  setEmpty("desc", desc.length === 0, empty);

  reconcileDirection(S, "asc", asc);
  reconcileDirection(S, "desc", desc);

  document.querySelector("#ascCount").textContent = unitCountText(asc.length);
  document.querySelector("#descCount").textContent = unitCountText(desc.length);

  const status = document.querySelector("#plasticStatus");
  status.textContent = statusText(S, filtered.length);
  status.classList.toggle("error", Boolean(S.lastError));

  syncFilterVisuals(S);
}

export function tickPLASTIC(S) {
  for (const model of rowNodes.values()) {
    const train = (S.trains || []).find(item => item.id === model.tripId);
    if (!train) continue;
    updateOriginCountdown(model, train);
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
