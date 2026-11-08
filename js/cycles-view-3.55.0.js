export const MODULE_VERSION = "3.55.0";

import {
  cycleCurrentMovement,
  cycleUnit,
  movementTimes,
  operationalMinute
} from "./cycles-data-3.55.0.js";
import {
  createOperationalTrainRow,
  updateOperationalTrainRow,
  tickOperationalTrainRow
} from "./plastic-3.55.0.js";

const models = new Map();
let selectedCycle = "";
let lastAutoFocus = "";

function familyForLine(line) {
  return ({ S1:"D", S2:"F", L6:"A", L7:"B", L12:"L" })[line] || "";
}

function syntheticTrain(S, cycle, movement) {
  const circulation = String(movement?.circulacion || "").toUpperCase();
  const live = (S.trains || []).find(train => train.circulation === circulation);
  if (live) return live;
  const line = String(movement?.linea_o_ambito || "").toUpperCase();
  return {
    id:"",
    circulation,
    unit:cycleUnit(S, cycle.ciclo),
    family:familyForLine(line),
    line,
    origin:"",
    destination:"",
    stationed:null,
    nextStop:null,
    ascending:Number(circulation.slice(1)) % 2 === 1,
    onTime:null,
    occupancy:null
  };
}

function ensureModel(S, cycle, movement) {
  let model = models.get(cycle.ciclo);
  const train = syntheticTrain(S, cycle, movement);
  if (!model) {
    model = createOperationalTrainRow(train, {
      className:"cycles-trainrow",
      onSelectTrain:() => {
        selectedCycle = cycle.ciclo;
        renderCYCLES(S);
      }
    });
    models.set(cycle.ciclo, model);
  }
  updateOperationalTrainRow(model, train, S);
  model.row.dataset.cycle = cycle.ciclo;
  model.cycle.textContent = cycle.ciclo;
  if (!model.lineIcon) {
    model.lineIcon = document.createElement("img");
    model.lineIcon.className = "cycles-line-icon";
    model.lineIcon.alt = "";
    model.lineIcon.setAttribute("aria-hidden", "true");
    model.row.appendChild(model.lineIcon);
  }
  const line = train.line || String(movement?.linea_o_ambito || "").toUpperCase();
  model.lineIcon.src = S.config?.lineAssets?.[line] || "";
  model.lineIcon.hidden = !model.lineIcon.src;
  if (!movement?.circulacion) {
    model.circulation.textContent = "—";
    model.cycle.textContent = cycle.ciclo;
  }
  return model;
}

function lineIcon(S, movement) {
  const line = String(movement?.linea_o_ambito || "").toUpperCase();
  const src = S.config?.lineAssets?.[line] || "";
  if (!src) return document.createElement("span");
  const image = document.createElement("img");
  image.className = "schedule-line-icon";
  image.src = src;
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  return image;
}

function movementRow(S, cycle, movement, current) {
  const row = document.createElement("button");
  row.type = "button";
  const live = (S.trains || []).find(train => train.circulation === movement.circulacion);
  const delayed = current && live?.onTime === false;
  row.className = `schedule-row cycle-schedule-row${current ? " is-current" : ""}${delayed ? " delayed-row" : ""}`;
  const times = movementTimes(movement);
  const unit = cycleUnit(S, cycle.ciclo);
  const turn = movement.turno ? `Q${String(movement.turno).replace(/^Q/, "")}` : "";
  const values = [
    currentMarker(current),
    lineIcon(S, movement),
    text("schedule-code", movement.circulacion || "—"),
    text("schedule-unit", unit),
    text("schedule-turn", turn),
    text("schedule-time", times.end && times.end !== times.start ? `${times.start}–${times.end}` : times.start)
  ];
  row.append(...values);
  return row;
}

function currentMarker(current) {
  if (!current) return text("schedule-current-marker", "");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 18 18");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("schedule-current-marker");
  const triangle = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  triangle.setAttribute("points", "2,2 14.12435565,9 2,16");
  triangle.setAttribute("fill", "currentColor");
  triangle.setAttribute("stroke", "currentColor");
  triangle.setAttribute("stroke-width", "1.8");
  triangle.setAttribute("stroke-linejoin", "miter");
  svg.appendChild(triangle);
  return svg;
}

function text(className, value) {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = value || "";
  return node;
}

function renderDetail(S, cycle) {
  const overview = document.querySelector("#cyclesOverview");
  const detail = document.querySelector("#cyclesDetail");
  const title = document.querySelector("#cyclesDetailTitle");
  const list = document.querySelector("#cyclesDetailList");
  if (!overview || !detail || !title || !list) return;
  overview.hidden = true;
  detail.hidden = false;
  title.textContent = cycle.ciclo;
  const minute = operationalMinute(new Date(), Number(S.config?.serviceDayCutoverHour) || 3);
  const current = cycleCurrentMovement(cycle, new Date(), Number(S.config?.serviceDayCutoverHour) || 3);
  list.replaceChildren(...cycle.movements.map(movement =>
    movementRow(S, cycle, movement, movement === current)
  ));
  const focusKey = `${S.operationalService?.dateKey}:${cycle.ciclo}:${current?.circulacion || minute}`;
  if (focusKey !== lastAutoFocus) {
    lastAutoFocus = focusKey;
    requestAnimationFrame(() => list.querySelector(".is-current")?.scrollIntoView({ block:"center" }));
  }
}

export function wireCYCLES(S) {
  document.querySelector("#cyclesBack")?.addEventListener("click", () => {
    selectedCycle = "";
    lastAutoFocus = "";
    renderCYCLES(S);
  });
}

export function renderCYCLES(S) {
  const overview = document.querySelector("#cyclesOverview");
  const detail = document.querySelector("#cyclesDetail");
  const list = document.querySelector("#cyclesList");
  const count = document.querySelector("#cyclesCount");
  if (!overview || !detail || !list || !count) return;
  const cycles = S.cycles?.cycles || [];
  const selected = selectedCycle ? S.cycles?.byCode?.get(selectedCycle) : null;
  if (selected) {
    renderDetail(S, selected);
    return;
  }
  overview.hidden = false;
  detail.hidden = true;
  count.textContent = `${cycles.length} ${cycles.length === 1 ? "CICLE" : "CICLES"}`;
  const active = new Set();
  for (const cycle of cycles) {
    const movement = cycleCurrentMovement(cycle, new Date(), Number(S.config?.serviceDayCutoverHour) || 3);
    const model = ensureModel(S, cycle, movement);
    list.appendChild(model.row);
    active.add(cycle.ciclo);
  }
  for (const [code, model] of models) {
    if (!active.has(code)) model.row.remove();
  }
}

export function tickCYCLES(S) {
  if (S.activeView !== "cycles") return;
  if (selectedCycle) return;
  for (const model of models.values()) {
    const circulation = model.row.dataset.circulation;
    const live = (S.trains || []).find(train => train.circulation === circulation);
    if (live) tickOperationalTrainRow(model, live, S);
  }
}
