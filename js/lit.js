import { getTripBundle } from "./gtfs.js?v=3.7.1";
import {
  countdownState,
  formatCountdown,
  formatDeparture
} from "./time.js?v=3.7.1";
import {
  countdownRedThreshold,
  isSpecialCountdownStation,
  locateOperationalTarget,
  parentCode
} from "./operations.js?v=3.7.1";

const MANUAL_SCROLL_HOLD_MS = 2500;
const SVG_NS = "http://www.w3.org/2000/svg";

const $ = selector => document.querySelector(selector);


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
   * Preparado para la futura señalización: cuando exista segment.signaling,
   * se renderizará como PRIMERA línea técnica, alineada con el código/vía.
   * Mientras no haya datos, no se reserva ninguna línea vacía.
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

function createPointerSvg(moving) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 20 18");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("pointer-marker");
  if (moving) svg.classList.add("moving");

  const polygon = document.createElementNS(SVG_NS, "polygon");
  polygon.setAttribute("points", "1,1 19,9 1,17");
  polygon.setAttribute("stroke", "currentColor");
  polygon.setAttribute("stroke-width", "2");
  polygon.setAttribute("stroke-linejoin", "round");
  polygon.setAttribute("fill", moving ? "none" : "currentColor");

  svg.appendChild(polygon);
  return svg;
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
    item.querySelector(".pointer")?.replaceChildren();

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

  /*
   * En retraso, el rojo temporal afecta a la HORA de la estación objetivo y
   * a su cronometría. El nombre de estación permanece en color normal.
   */
  time.classList.toggle("delayed-text", delayed);
  item.classList.toggle("delayed-target", delayed);
}

function setPointer(item, moving) {
  const cell = item?.querySelector(".pointer");
  if (!cell) return;
  cell.replaceChildren(createPointerSvg(moving));
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
  if (!location) return;

  const item = document.querySelector(`.lit-item[data-i="${location.targetIndex}"]`);
  const stop = S.selected.stops[location.targetIndex];

  if (item) {
    item.classList.add("current", location.type);
    setPointer(item, location.type === "moving");
    updateTargetCountdown(S, location, item, stop);
  }

  maybeAutoScroll(S, location, forceScroll);
}

export function tickLIT(S) {
  updateCurrent(S, false);
}
