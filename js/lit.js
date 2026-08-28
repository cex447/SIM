import { getTripBundle } from "./gtfs.js?v=3.23.0";
import {
  countdownState,
  formatCountdown,
  formatDeparture
} from "./time.js?v=3.23.0";
import {
  countdownRedThreshold,
  isSpecialCountdownStation,
  locateOperationalTarget,
  parentCode
} from "./operations.js?v=3.23.0";
import {
  cachedPlatform,
  clearPlatform,
  fetchIsicStation,
  fixedPlatformFor,
  matchContextToRows,
  normalizePlatformValue,
  rememberPlatform
} from "./isic.js?v=3.23.0";

const MANUAL_SCROLL_HOLD_MS = 2500;
const LIT_PLATFORM_NEAR_MS = 10000;
const LIT_PLATFORM_FAR_MS = 10000;
const LIT_PLATFORM_NEAR_COUNT = 3;
const LIT_PLATFORM_FAR_COUNT = 1;
const SVG_NS = "http://www.w3.org/2000/svg";

/*
 * El indicador móvil de LIT conserva velocidad lineal constante, pero desde
 * Beta 3.10.0 circula al doble de velocidad que en 3.8.0. El número de líneas
 * de interestación solo modifica la duración total del recorrido, nunca la
 * velocidad del triángulo.
 */
const PLASTIC_ARROW_REFERENCE_MS = 2500;
const LIT_REFERENCE_TRAVEL_PX = 36;
const LIT_POINTER_SPEED_MULTIPLIER = 2;
const LIT_POINTER_SPEED_PX_PER_SECOND =
  (LIT_REFERENCE_TRAVEL_PX / (PLASTIC_ARROW_REFERENCE_MS / 1000)) *
  LIT_POINTER_SPEED_MULTIPLIER;

const $ = selector => document.querySelector(selector);

let movingPointerLayer = null;
let movingPointerAnimation = null;
let movingPointerKey = "";

function stationName(stop) {
  return String(stop?.stop_name || stop?.stop_id || "")
    .toLocaleUpperCase("ca-ES");
}

function stationCode(stop) {
  return parentCode(stop);
}

function setPlatformCode(item, code, platform = null) {
  const cell = item?.querySelector?.(".platform-code");
  if (!cell) return;

  const base = cell.querySelector(".platform-base");
  const slot = cell.querySelector(".platform-slot");
  const normalized = normalizePlatformValue(platform);
  if (base) base.textContent = code || "";
  if (slot) slot.textContent = normalized === null ? "" : String(normalized);
  cell.dataset.platform = normalized === null ? "" : String(normalized);
}


function parityOf(train) {
  const last = Number(String(train?.circulation || "").slice(-1));
  return Number.isFinite(last) && last % 2 === 0 ? "even" : "odd";
}

function segmentData(S, from, to) {
  return (S.network?.segments || []).find(segment =>
    (segment.from === from && segment.to === to) ||
    (segment.from === to && segment.to === from)
  ) || null;
}

function itemVisible(item, context) {
  if (typeof item === "string") return true;
  if (!item || typeof item !== "object") return false;

  if (item.parity && item.parity !== context.parity) return false;
  if (item.from && item.from !== context.from) return false;
  if (item.to && item.to !== context.to) return false;
  if (item.line && item.line !== context.line) return false;

  return true;
}

function itemText(item) {
  return typeof item === "string" ? item : String(item?.text || "");
}

function collectTechnicalLines(segment, context) {
  if (!segment) return [];

  const lines = [];

  /*
   * Cuando exista segment.signaling se renderiza como PRIMERA línea técnica,
   * alineada con el código/vía. Si no hay dato, no se reserva una línea vacía.
   */
  const signaling = Array.isArray(segment.signaling)
    ? segment.signaling
    : segment.signaling
      ? [segment.signaling]
      : [];

  for (const item of signaling) {
    if (!itemVisible(item, context)) continue;
    const text = itemText(item);
    if (text) lines.push({ type: "signaling", text });
  }

  if (segment.grade || segment.length) {
    lines.push({
      type: "geometry",
      text: [segment.grade, segment.length].filter(Boolean).join(" ")
    });
  }

  for (const item of segment.technical || []) {
    if (!itemVisible(item, context)) continue;
    const text = itemText(item);
    if (text) lines.push({ type: "technical", text });
  }

  return lines;
}

function createPointerSvg({ moving = false, delayed = false } = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 18 18");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("pointer-marker");
  if (moving) svg.classList.add("moving");
  if (delayed) svg.classList.add("delayed");

  const polygon = document.createElementNS(SVG_NS, "polygon");

  /*
   * Geometría estrictamente equilátera. Con lado 14, la altura es
   * 14·√3/2 = 12,124355..., por lo que los tres ángulos son 60°.
   */
  if (moving) {
    /* En marcha: triángulo equilátero de contorno apuntando hacia abajo. */
    polygon.setAttribute("points", "2,2 16,2 9,14.12435565");
    polygon.setAttribute("fill", "none");
  } else {
    /* Estacionado: triángulo equilátero relleno apuntando hacia la derecha. */
    polygon.setAttribute("points", "2,2 14.12435565,9 2,16");
    polygon.setAttribute("fill", "currentColor");
  }

  polygon.setAttribute("stroke", "currentColor");
  polygon.setAttribute("stroke-width", "1.8");
  polygon.setAttribute("stroke-linejoin", "miter");
  polygon.setAttribute("shape-rendering", "geometricPrecision");

  svg.appendChild(polygon);
  return svg;
}

function clearStationPointers() {
  document.querySelectorAll(".lit-item .pointer").forEach(cell => {
    cell.replaceChildren();
  });
}

function removeMovingPointer() {
  movingPointerAnimation?.cancel();
  movingPointerAnimation = null;
  movingPointerLayer?.remove();
  movingPointerLayer = null;
  movingPointerKey = "";
}

function setStationaryPointer(item, delayed) {
  removeMovingPointer();
  clearStationPointers();

  const cell = item?.querySelector(".pointer");
  if (!cell) return;
  cell.replaceChildren(createPointerSvg({ moving: false, delayed }));
}

function movingPointerGeometry(targetIndex) {
  const route = $("#litRoute");
  if (!route) return null;

  const targetCell = document.querySelector(
    `.lit-item[data-i="${targetIndex}"] .pointer`
  );

  const fromIndex = Math.max(0, targetIndex - 1);
  const fromCell = document.querySelector(
    `.lit-item[data-i="${fromIndex}"] .pointer`
  );

  if (!targetCell || !fromCell) return null;

  const routeRect = route.getBoundingClientRect();
  const fromRect = fromCell.getBoundingClientRect();
  const targetRect = targetCell.getBoundingClientRect();

  const startX = fromRect.left + fromRect.width / 2 - routeRect.left;
  const startY = fromRect.top + fromRect.height / 2 - routeRect.top;
  const endY = targetRect.top + targetRect.height / 2 - routeRect.top;

  return {
    route,
    fromIndex,
    startX,
    startY,
    distance: endY - startY
  };
}

function setMovingPointer(targetIndex, delayed) {
  clearStationPointers();

  const geometry = movingPointerGeometry(targetIndex);
  if (!geometry) {
    removeMovingPointer();
    return;
  }

  const roundedDistance = Math.round(geometry.distance * 10) / 10;
  const key = `${geometry.fromIndex}:${targetIndex}:${roundedDistance}`;

  if (movingPointerLayer && movingPointerKey === key) {
    movingPointerLayer
      .querySelector(".pointer-marker")
      ?.classList.toggle("delayed", delayed);
    return;
  }

  removeMovingPointer();

  const layer = document.createElement("div");
  layer.className = "lit-moving-pointer";
  layer.setAttribute("aria-hidden", "true");
  layer.style.left = `${geometry.startX}px`;
  layer.style.top = `${geometry.startY}px`;

  const marker = createPointerSvg({ moving: true, delayed });
  layer.appendChild(marker);
  geometry.route.appendChild(layer);

  movingPointerLayer = layer;
  movingPointerKey = key;

  const distance = Math.max(0, geometry.distance);
  const duration = Math.max(
    350,
    (distance / LIT_POINTER_SPEED_PX_PER_SECOND) * 1000
  );

  if (distance <= 0 || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
    marker.style.transform = `translate3d(0, ${distance}px, 0)`;
    return;
  }

  movingPointerAnimation = marker.animate(
    [
      { transform: "translate3d(0, 0, 0)" },
      { transform: `translate3d(0, ${distance}px, 0)` }
    ],
    {
      duration,
      easing: "linear",
      fill: "none",
      iterations: Infinity
    }
  );
}

function createStationItem(S, stop, nextStop, index, isLast) {
  const item = document.createElement("article");
  item.className = "lit-item";
  item.dataset.i = String(index);
  item.dataset.code = parentCode(stop);

  const main = document.createElement("div");
  main.className = "lit-main-row";

  const pointer = document.createElement("div");
  pointer.className = "pointer";

  const time = document.createElement("div");
  time.className = "time";
  time.textContent = formatDeparture(stop.departure_time || stop.arrival_time);

  const name = document.createElement("div");
  name.className = "station-name";
  name.textContent = stationName(stop);

  const count = document.createElement("div");
  count.className = "count";

  main.append(pointer, time, name, count);
  item.appendChild(main);

  const sub = document.createElement("div");
  sub.className = "lit-sub-row";

  const pointerSpacer = document.createElement("div");

  const platform = document.createElement("div");
  platform.className = "platform-code";
  const platformInner = document.createElement("span");
  platformInner.className = "platform-code-inner";
  const platformBase = document.createElement("span");
  platformBase.className = "platform-base";
  platformBase.textContent = stationCode(stop);
  const platformSlot = document.createElement("span");
  platformSlot.className = "platform-slot";
  platformInner.append(platformBase, platformSlot);
  platform.appendChild(platformInner);

  const technical = document.createElement("div");
  technical.className = "technical";

  if (!isLast && nextStop) {
    const from = parentCode(stop);
    const to = parentCode(nextStop);
    const segment = segmentData(S, from, to);
    const context = {
      from,
      to,
      parity: parityOf(S.selected?.live),
      line: S.selected?.live?.line || null
    };

    const lines = collectTechnicalLines(segment, context);

    for (const lineData of lines) {
      const line = document.createElement("div");
      line.className = `inter-line inter-${lineData.type}`;
      line.textContent = lineData.text;
      technical.appendChild(line);
    }

    if (!lines.length) {
      console.warn(`SIM+ LIT: sense dades d'interestació ${from}-${to}`);
    }
  }

  sub.append(pointerSpacer, platform, technical);
  item.appendChild(sub);

  if (!isLast) {
    const separator = document.createElement("div");
    separator.className = "separator";
    item.appendChild(separator);
  }

  return item;
}

export function clearLIT(S) {
  removeMovingPointer();
  $("#litRoute")?.replaceChildren();
  if (S.selected) S.selected = null;
}

export async function loadLIT(S, circulation, liveTrain) {
  if (!circulation || !liveTrain?.id) {
    clearLIT(S);
    return false;
  }

  S.selected = {
    circulation,
    live: liveTrain,
    stops: [],
    lastFollowKey: null,
    manualHoldUntil: 0,
    autoScrolling: false,
    platforms: new Map(),
    platformAttempts: new Map(),
    platformRefreshRunning: false
  };

  const bundle = await getTripBundle(S.config.gtfsZipIndexUrl, liveTrain.id);

  if (S.query?.code !== circulation || S.query?.state === "inactive") {
    return false;
  }

  S.selected.trip = bundle.trip;
  S.selected.stops = bundle.times;

  render(S);
  seedKnownPlatforms(S);
  updateCurrent(S, true);
  refreshLITPlatforms(S, { force:true });
  return true;
}

function render(S) {
  const box = $("#litRoute");
  const fragment = document.createDocumentFragment();
  const stops = S.selected?.stops || [];

  removeMovingPointer();
  box.replaceChildren();

  stops.forEach((stop, index) => {
    fragment.appendChild(
      createStationItem(S, stop, stops[index + 1], index, index === stops.length - 1)
    );
  });

  box.appendChild(fragment);

  if (box.dataset.scrollBound !== "true") {
    box.addEventListener("scroll", () => {
      if (!S.selected || S.selected.autoScrolling) return;
      S.selected.manualHoldUntil = performance.now() + MANUAL_SCROLL_HOLD_MS;
    }, { passive: true });

    box.dataset.scrollBound = "true";
  }
}

function clearOperationalState() {
  document.querySelectorAll(".lit-item").forEach(item => {
    item.classList.remove("current", "moving", "stationed", "delayed-target");

    const time = item.querySelector(".time");
    time?.classList.remove("delayed-text");

    const count = item.querySelector(".count");
    if (count) {
      count.textContent = "";
      count.className = "count";
    }
  });
}

function updateTargetCountdown(S, location, item, stop) {
  const count = item?.querySelector(".count");
  const time = item?.querySelector(".time");
  if (!count || !time || !stop || location.final) return;

  const departure = stop.departure_time || stop.arrival_time;
  const state = countdownState(departure, Date.now());
  if (!state) return;

  const delayed = S.selected?.live?.onTime === false;
  const urgent = state.seconds <= countdownRedThreshold(parentCode(stop));
  const red = delayed || state.overdue || urgent;

  count.textContent = state.overdue ? "0:00" : formatCountdown(state.seconds);
  count.classList.toggle("red", red);
  count.classList.toggle("overdue", state.overdue);

  const specialBlink =
    location.type === "stationed" &&
    isSpecialCountdownStation(parentCode(stop)) &&
    !state.overdue &&
    state.seconds <= 13;

  const zeroBlink = location.type === "stationed" && state.overdue;
  count.classList.toggle("blink", specialBlink || zeroBlink);

  /* En retraso, hora objetivo y cronometría rojas; nombre normal. */
  time.classList.toggle("delayed-text", delayed);
  item.classList.toggle("delayed-target", delayed);
}


function updateHeaderDelay(S, location) {
  const delay = $("#queryDelay");
  if (!delay) return;

  const delayed = S.selected?.live?.onTime === false;
  if (!delayed || !location || location.final) {
    delay.hidden = true;
    delay.textContent = "";
    return;
  }

  const stop = S.selected?.stops?.[location.targetIndex];
  if (!stop) {
    delay.hidden = true;
    delay.textContent = "";
    return;
  }

  /*
   * Igual que en PLASTIC, +N solo existe si posicionament-dels-trens
   * marca en_hora=false y se expresa exclusivamente en minutos enteros.
   * En marcha usamos la llegada prevista de la estación objetivo; estando
   * estacionado usamos su salida prevista. Así evitamos convertir el tiempo
   * normal de recorrido de la interestación en falso retraso.
   */
  const reference = location.type === "moving"
    ? (stop.arrival_time || stop.departure_time)
    : (stop.departure_time || stop.arrival_time);
  const state = countdownState(reference, Date.now());

  if (!state) {
    delay.hidden = true;
    delay.textContent = "";
    return;
  }

  const minutes = Math.max(0, Math.floor(Math.max(0, -state.diffMs) / 60000));
  delay.textContent = `+${minutes}`;
  delay.hidden = false;
}

function maybeAutoScroll(S, location, force) {
  if (!S.selected || !location) return;

  const view = $("#view-lit");

  /*
   * Regla operativa Beta 3.16.0:
   * - estacionado: la estación actual queda arriba;
   * - circulando: queda arriba la estación que el tren acaba de dejar.
   *
   * locateOperationalTarget() señala, en marcha, la PRÓXIMA estación. Por
   * eso el ancla visual es targetIndex - 1. El triángulo móvil mantiene su
   * lógica propia y sigue representando la interestación hacia targetIndex.
   */
  const followIndex = location.type === "moving"
    ? Math.max(0, Number(location.targetIndex) - 1)
    : Number(location.targetIndex);

  const item = document.querySelector(`.lit-item[data-i="${followIndex}"]`);
  if (!view || !item || !Number.isInteger(followIndex)) return;

  if (!force && performance.now() < (S.selected.manualHoldUntil || 0)) return;

  const key = `${location.type}:${location.targetIndex}:anchor:${followIndex}`;
  if (!force && key === S.selected.lastFollowKey) return;

  S.selected.autoScrolling = true;
  S.selected.lastFollowKey = key;

  /*
   * No usamos scrollIntoView: en Safari/iOS puede escoger el viewport de la
   * página en vez del contenedor interno de LIT. Calculamos directamente el
   * scrollTop del #view-lit para colocar el ancla EXACTAMENTE arriba.
   */
  const placeAtTop = () => {
    if (!S.selected || S.selected.lastFollowKey !== key) return;
    const viewRect = view.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const top = Math.max(0, view.scrollTop + itemRect.top - viewRect.top);
    view.scrollTop = top;
  };

  placeAtTop();
  requestAnimationFrame(() => {
    placeAtTop();
    requestAnimationFrame(() => {
      placeAtTop();
      if (S.selected && S.selected.lastFollowKey === key) {
        S.selected.autoScrolling = false;
      }
    });
  });
}

function estimateDelayAdjustmentMinutes(S, nowMs = Date.now()) {
  const live = S.selected?.live;
  if (live?.onTime !== false) return 0;

  const location = locateOperationalTarget(S.selected?.stops || [], live);
  if (!location || location.final) return 0;
  const stop = S.selected.stops[location.targetIndex];
  if (!stop) return 0;

  const reference = location.type === "moving"
    ? (stop.arrival_time || stop.departure_time)
    : (stop.departure_time || stop.arrival_time);
  const state = countdownState(reference, nowMs);
  if (!state) return 0;
  return Math.max(0, -state.diffMs / 60000);
}

function applySelectedPlatform(S, index, platform, source = "isic") {
  const normalized = normalizePlatformValue(platform);
  if (!S.selected || normalized === null) return;
  S.selected.platforms.set(index, {
    platform:normalized,
    source,
    confirmedAt:Date.now()
  });
  const stop = S.selected.stops[index];
  const item = document.querySelector(`.lit-item[data-i="${index}"]`);
  setPlatformCode(item, parentCode(stop), normalized);
}

function clearSelectedPlatform(S, index) {
  if (!S.selected) return;
  const existing = S.selected.platforms.get(index);
  if (existing?.source === "fixed") return;
  S.selected.platforms.delete(index);
  const stop = S.selected.stops[index];
  const item = document.querySelector(`.lit-item[data-i="${index}"]`);
  setPlatformCode(item, parentCode(stop), null);
}

function seedKnownPlatforms(S) {
  if (!S.selected?.stops?.length || !S.selected?.live) return;

  const stops = S.selected.stops;
  const live = S.selected.live;
  const effectiveOrigin = parentCode(stops[0]);

  stops.forEach((stop, index) => {
    const station = parentCode(stop);

    const fixed = fixedPlatformFor({
      line:live.line,
      station,
      effectiveOrigin
    });
    if (fixed) {
      rememberPlatform(live.id, station, fixed.platform, "fixed", { circulation:live.circulation });
      applySelectedPlatform(S, index, fixed.platform, "fixed");
      return;
    }

    const cached = cachedPlatform(live.id, station, S.config.isic?.staleMs || 30000);
    if (normalizePlatformValue(cached?.platform) !== null) applySelectedPlatform(S, index, cached.platform, cached.source || "isic");
  });
}

async function queryLITStationPlatform(S, index, force = false) {
  const selected = S.selected;
  if (!selected?.stops?.[index] || !selected.live) return;

  const stop = selected.stops[index];
  const station = parentCode(stop);
  const effectiveOrigin = parentCode(selected.stops[0]);
  const fixed = fixedPlatformFor({
    line:selected.live.line,
    station,
    effectiveOrigin
  });

  /* Las reglas operativas fijas se aplican incluso en destino final.
     Ejemplo: L12 RE→SR debe terminar mostrando SR4. */
  if (fixed) {
    rememberPlatform(selected.live.id, station, fixed.platform, "fixed", { circulation:selected.live.circulation });
    applySelectedPlatform(S, index, fixed.platform, "fixed");
    return;
  }

  if (index >= selected.stops.length - 1) return; // sin regla fija no inferimos vía final

  const selectionKey = `${selected.live.id}|${selected.circulation}`;

  try {
    const parsed = await fetchIsicStation(S.config.isic, station, { force });
    if (!S.selected || `${S.selected.live?.id}|${S.selected.circulation}` !== selectionKey) return;

    const delayAdjustmentMinutes = estimateDelayAdjustmentMinutes(S, parsed.fetchedAt);
    const context = {
      key:selected.live.id,
      id:selected.live.id,
      circulation:selected.circulation,
      line:selected.live.line,
      onTime:selected.live.onTime,
      station,
      effectiveOrigin,
      departure:stop.departure_time || stop.arrival_time,
      delayAdjustmentMinutes,
      originHold:index === 0 && String(selected.live.stationed || "") === effectiveOrigin
    };

    const match = matchContextToRows(context, parsed.rows, parsed.fetchedAt);
    if (normalizePlatformValue(match?.platform) !== null && (match.status === "safe" || match.status === "safe-delay")) {
      rememberPlatform(selected.live.id, station, match.platform, "isic", {
        circulation:selected.circulation,
        row:match.row,
        assessment:match.assessment,
        imageFetchedAt:parsed.fetchedAt
      });
      applySelectedPlatform(S, index, match.platform, "isic");
    } else {
      clearPlatform(selected.live.id, station);
      clearSelectedPlatform(S, index);
    }
  } catch (error) {
    console.warn(`SIM+ LIT: iSIC ${station}`, error);
    const cached = cachedPlatform(selected.live.id, station, S.config.isic?.staleMs || 30000);
    if (normalizePlatformValue(cached?.platform) !== null) applySelectedPlatform(S, index, cached.platform, cached.source || "isic");
  }
}

export async function refreshLITPlatforms(S, { force = false } = {}) {
  const selected = S.selected;
  if (!selected?.stops?.length || !selected.live || !S.config?.isic?.enabled) return;
  if (S.activeView !== "lit" && !force) return;
  if (selected.platformRefreshRunning) return;

  const location = locateOperationalTarget(selected.stops, selected.live);
  if (!location) return;

  const anchor = Math.max(0, location.targetIndex);
  const now = Date.now();
  const near = [];
  const far = [];

  for (let offset = 0; offset < LIT_PLATFORM_NEAR_COUNT; offset += 1) {
    const index = anchor + offset;
    if (index < selected.stops.length - 1) near.push(index);
  }
  for (let offset = LIT_PLATFORM_NEAR_COUNT;
       offset < LIT_PLATFORM_NEAR_COUNT + LIT_PLATFORM_FAR_COUNT;
       offset += 1) {
    const index = anchor + offset;
    if (index < selected.stops.length - 1) far.push(index);
  }

  const due = [];
  for (const index of near) {
    const last = selected.platformAttempts.get(index) || 0;
    if (force || now - last >= LIT_PLATFORM_NEAR_MS) due.push(index);
  }
  for (const index of far) {
    const last = selected.platformAttempts.get(index) || 0;
    if (force || now - last >= LIT_PLATFORM_FAR_MS) due.push(index);
  }

  if (!due.length) return;
  selected.platformRefreshRunning = true;

  try {
    /* Seqüencial per no descarregar diverses captures PNG alhora. */
    for (const index of due) {
      if (!S.selected || S.selected !== selected) break;
      selected.platformAttempts.set(index, Date.now());
      await queryLITStationPlatform(S, index, force);
    }
  } finally {
    if (S.selected === selected) selected.platformRefreshRunning = false;
  }
}

export function focusCurrentLIT(S) {
  if (!S.selected?.stops?.length) return;
  updateCurrent(S, true);
}


export function updateCurrent(S, forceScroll = false) {
  if (!S.selected?.stops?.length) return;

  const live = (S.trains || []).find(
    train => train.circulation === S.selected.circulation
  );

  if (live) S.selected.live = live;

  const location = locateOperationalTarget(S.selected.stops, S.selected.live);
  clearOperationalState();

  if (!location) {
    clearStationPointers();
    removeMovingPointer();
    updateHeaderDelay(S, null);
    return;
  }

  const item = document.querySelector(`.lit-item[data-i="${location.targetIndex}"]`);
  const stop = S.selected.stops[location.targetIndex];
  const delayed = S.selected?.live?.onTime === false;

  updateHeaderDelay(S, location);

  if (item) {
    item.classList.add("current", location.type);

    if (location.type === "moving") {
      setMovingPointer(location.targetIndex, delayed);
    } else {
      setStationaryPointer(item, delayed);
    }

    updateTargetCountdown(S, location, item, stop);
  }

  maybeAutoScroll(S, location, forceScroll);
}

export function tickLIT(S) {
  updateCurrent(S, false);
  refreshLITPlatforms(S);
}
