import { getTripBundle } from "./gtfs.js?v=3.10.0";
import {
  countdownState,
  formatCountdown,
  formatDeparture
} from "./time.js?v=3.10.0";
import {
  countdownRedThreshold,
  isSpecialCountdownStation,
  locateOperationalTarget,
  parentCode
} from "./operations.js?v=3.10.0";

const MANUAL_SCROLL_HOLD_MS = 2500;
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

function platformCode(stop) {
  return String(stop?.stop_id || "");
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
  svg.setAttribute("viewBox", moving ? "0 0 18 20" : "0 0 20 18");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("pointer-marker");
  if (moving) svg.classList.add("moving");
  if (delayed) svg.classList.add("delayed");

  const polygon = document.createElementNS(SVG_NS, "polygon");

  if (moving) {
    /* En marcha: triángulo de contorno apuntando hacia abajo. */
    polygon.setAttribute("points", "1,2 17,2 9,18");
    polygon.setAttribute("fill", "none");
  } else {
    /* Estacionado: triángulo relleno apuntando hacia la derecha. */
    polygon.setAttribute("points", "2,1 18,9 2,17");
    polygon.setAttribute("fill", "currentColor");
  }

  polygon.setAttribute("stroke", "currentColor");
  polygon.setAttribute("stroke-width", "2");
  polygon.setAttribute("stroke-linejoin", "round");

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
  platform.textContent = platformCode(stop);

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
    autoScrolling: false
  };

  const bundle = await getTripBundle(S.config.gtfsZipIndexUrl, liveTrain.id);

  if (S.query?.code !== circulation || S.query?.state === "inactive") {
    return false;
  }

  S.selected.trip = bundle.trip;
  S.selected.stops = bundle.times;

  render(S);
  updateCurrent(S, true);
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

  const item = document.querySelector(`.lit-item[data-i="${location.targetIndex}"]`);
  if (!item) return;

  if (!force && performance.now() < (S.selected.manualHoldUntil || 0)) return;

  const key = `${location.type}:${location.targetIndex}`;
  if (!force && key === S.selected.lastFollowKey) return;

  S.selected.autoScrolling = true;

  item.scrollIntoView({
    block: "center",
    behavior: force ? "auto" : "smooth"
  });

  S.selected.lastFollowKey = key;

  setTimeout(() => {
    if (S.selected) S.selected.autoScrolling = false;
  }, 320);
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
}
