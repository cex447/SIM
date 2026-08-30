import { getTripBundle } from "./gtfs.js?v=3.30.0";
import { occupancyFingerprint, updateOccupancy } from "./occupancy.js?v=3.30.0";
import { countdownState, formatOperationalCountdown } from "./time.js?v=3.30.0";
import {
  countdownRedThreshold,
  isOriginHold,
  parentCode
} from "./operations.js?v=3.30.0";
import {
  cachedPlatform,
  clearPlatform,
  fetchIsicStation,
  fixedPlatformFor,
  matchContextsToRows,
  normalizePlatformValue,
  rememberPlatform
} from "./isic.js?v=3.30.0";

const FAMILY_ORDER = Object.freeze(["A", "D", "F", "B", "L"]);
const LINE_BY_FAMILY = Object.freeze({ A: "L6", D: "S1", F: "S2", B: "L7", L: "L12" });
const familyRank = new Map(FAMILY_ORDER.map((family, index) => [family, index]));

const rowNodes = new Map();
const lineGroups = new Map();
const tripContextCache = new Map();
let onSelectTrainHandler = null;
let platformRefreshRunning = false;
let platformRefreshAt = 0;

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
  const state = make("span", "train-state state-token");
  const current = make("span", "train-current station-token");
  const arrow = make("span", "route-arrow");
  arrow.setAttribute("aria-hidden", "true");
  const destination = make("span", "train-destination");
  const operational = make("span", "plastic-operational");
  const countdown = make("span", "plastic-countdown");

  row.append(
    unit,
    circulation,
    occupancy,
    state,
    current,
    arrow,
    destination,
    operational,
    countdown
  );

  row.addEventListener("click", () => {
    if (onSelectTrainHandler) onSelectTrainHandler(train.circulation);
  });

  const model = {
    row,
    unit,
    circulation,
    occupancy,
    state,
    current,
    arrow,
    destination,
    operational,
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

function setDestination(cell, code, parenthesized = false) {
  cell.replaceChildren();
  const station = make(
    "strong",
    `station-token destination-code${parenthesized ? " parenthesized" : ""}`,
    code || "—"
  );
  cell.appendChild(station);
}

function updateRouteCells(model, train, context = null) {
  const stationed = Boolean(train.stationed);

  model.state.textContent = "est.";
  model.state.classList.toggle("state-spacer", !stationed);

  model.current.textContent = stationed
    ? (train.stationed || "—")
    : (train.nextStop || "—");

  model.arrow.textContent = "→";
  model.arrow.className = stationed
    ? "route-arrow route-arrow-placeholder"
    : "route-arrow moving";

  const destination = context?.effectiveDestination || train.destination || "—";
  setDestination(model.destination, destination, stationed);
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

  const threshold = countdownRedThreshold(origin);
  const red = state.overdue || state.seconds <= threshold;

  model.countdown.textContent = state.overdue ? "0:00" : formatOperationalCountdown(state.seconds);
  model.countdown.className = "plastic-countdown";
  model.countdown.classList.toggle("red", red);
  model.countdown.classList.toggle("overdue", state.overdue);
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
    const platform = normalizePlatformValue(result?.platform);
    if (platform === null) return;

    model.operational.textContent = `VÍA ${platform}`;
    model.operational.dataset.source = result.source || "unknown";
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
    if (context) updateRouteCells(model, train, context);
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
        station:context.effectiveOrigin,
        effectiveOrigin:context.effectiveOrigin
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
        const contexts = items.map(({ train, context }) => ({
          key:train.id,
          id:train.id,
          circulation:train.circulation,
          line:train.line,
          onTime:train.onTime,
          station,
          effectiveOrigin:context.effectiveOrigin,
          departure:context.departure,
          originHold:true
        }));

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

    updateRouteCells(model, live, context);
    updateOriginCountdown(model, live);
    updateOperationalFromCache(model, live, S);
    refreshOriginPlatforms(S);
  });
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

    updateOccupancy(model.occupancy, train.occupancy, {
      compact: true,
      delayed,
      unit: train.unit
    });
    updateRouteCells(model, train);
  }

  updateOriginCountdown(model, train);
  updateOperationalFromCache(model, train, S);
  ensureOperationalData(model, train, S);
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

  const status = document.querySelector("#plasticStatus");
  status.textContent = statusText(S, filtered.length);
  status.classList.toggle("error", Boolean(S.lastError));

  syncFilterVisuals(S);
  /* Les vies d'origen via iSIC només es consulten mentre PLASTIC és visible.
     CTC reutilitza posicionament FGC i no genera trànsit extra al Worker. */
  if (S.activeView === "plastic") refreshOriginPlatforms(S);
}

export function tickPLASTIC(S) {
  for (const model of rowNodes.values()) {
    const train = (S.trains || []).find(item => item.id === model.tripId);
    if (!train) continue;
    updateOriginCountdown(model, train);
    updateOperationalFromCache(model, train, S);
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
