export const MODULE_VERSION = "3.54.0";

import {
  cycleCurrentMovement,
  cycleUnit,
  movementTimes,
  operationalMinute
} from "./cycles-data-3.54.0.js";
import {
  createOperationalTrainRow,
  updateOperationalTrainRow,
  tickOperationalTrainRow
} from "./plastic-3.54.0.js";

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
  row.className = `schedule-row cycle-schedule-row${current ? " is-current" : ""}`;
  const times = movementTimes(movement);
  const unit = cycleUnit(S, cycle.ciclo);
  const turn = movement.turno ? `Q${String(movement.turno).replace(/^Q/, "")}` : "";
  const route = movement.funcion || movement.linea_o_ambito || "";
  const values = [
    lineIcon(S, movement),
    text("schedule-turn", turn),
    text("schedule-code", movement.circulacion || "—"),
    text("schedule-unit", unit),
    text("schedule-place", route.replaceAll("_", " ")),
    text("schedule-time", times.end && times.end !== times.start ? `${times.start}–${times.end}` : times.start)
  ];
  row.append(...values);
  return row;
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
