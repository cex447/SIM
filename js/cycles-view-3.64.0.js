export const MODULE_VERSION = "3.64.0";

import {
  cycleCurrentMovement,
  cycleForCirculation,
  cycleUnit,
  movementTimes,
  operationalMinute
} from "./cycles-data-3.56.0.js";
import {
  createOperationalTrainRow,
  delayedEntries,
  updateOperationalTrainRow,
  tickOperationalTrainRow
} from "./plastic-3.64.0.js";
import { updateOccupancy } from "./occupancy-3.55.0.js";
import { displayTurnFor, effectiveServiceReference } from "./turns-3.55.0.js";

const models = new Map();
let selectedCycle = "";
let lastAutoFocus = "";
let onOpenLITHandler = null;

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
  if (!model.routeSummary) {
    model.routeSummary = document.createElement("span");
    model.routeSummary.className = "cycles-route-summary";
    model.row.appendChild(model.routeSummary);
  }
  if (train.stationed) {
    model.routeSummary.textContent = `est. ${train.stationed}`;
  } else {
    const from = model.current.textContent || train.origin || "";
    const to = model.destination.textContent || train.destination || "";
    model.routeSummary.textContent = from && to ? `${from} - ${to}` : (to || from || "");
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

function resolvedCurrentMovement(S, cycle) {
  const live = (S.trains || []).find(train =>
    cycleForCirculation(S, train.circulation) === cycle.ciclo
  );
  if (live) {
    const observed = cycle.movements.find(movement =>
      String(movement.circulacion || "").toUpperCase() === live.circulation
    );
    if (observed) return observed;
  }
  return cycleCurrentMovement(cycle, new Date(), Number(S.config?.serviceDayCutoverHour) || 3);
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
    text("schedule-time", times.start && times.end ? `${times.start}–${times.end}` : (times.start || times.end))
  ];
  row.append(...values);
  if (movement?.circulacion) {
    row.addEventListener("click", () => onOpenLITHandler?.(movement.circulacion));
  }
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

function movementTurn(S, movement, live) {
  if (live) {
    return displayTurnFor(
      S.turnAssignments,
      live.circulation,
      effectiveServiceReference(S, live.id)
    );
  }
  const raw = String(movement?.turno || "").toUpperCase().replace(/^Q/, "");
  return raw ? `Q${raw}` : "";
}

function renderDetailSummary(S, cycle, movement) {
  const host = document.querySelector("#cyclesDetailSummary");
  if (!host) return;
  const circulation = String(movement?.circulacion || "").toUpperCase();
  const live = (S.trains || []).find(train => train.circulation === circulation) || null;
  const delayed = live
    ? delayedEntries(S).find(entry => entry.train.circulation === live.circulation)
    : null;

  const occupancy = text("cycles-summary-occupancy occupancy", "");
  updateOccupancy(occupancy, live?.occupancy || null, {
    unit:live?.unit || cycleUnit(S, cycle.ciclo),
    delayed:false
  });

  const delay = text("cycles-summary-delay", delayed ? `+${delayed.minutes}` : "");
  delay.classList.toggle("is-empty", !delay.textContent);
  host.replaceChildren(
    text("cycles-summary-cycle", cycle.ciclo),
    text("cycles-summary-turn", movementTurn(S, movement, live)),
    text("cycles-summary-circulation", circulation || "—"),
    text("cycles-summary-unit", live?.unit || cycleUnit(S, cycle.ciclo)),
    delay,
    occupancy
  );
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
  const current = resolvedCurrentMovement(S, cycle);
  renderDetailSummary(S, cycle, current);
  detail.dataset.currentCirculation = String(current?.circulacion || "").toUpperCase();
  list.replaceChildren(...cycle.movements.map(movement =>
    movementRow(S, cycle, movement, movement === current)
  ));
  const focusKey = `${S.operationalService?.dateKey}:${cycle.ciclo}:${current?.circulacion || minute}`;
  if (focusKey !== lastAutoFocus) {
    lastAutoFocus = focusKey;
    requestAnimationFrame(() => list.querySelector(".is-current")?.scrollIntoView({ block:"center" }));
  }
}

export function wireCYCLES(S, { onOpenLIT = null } = {}) {
  onOpenLITHandler = onOpenLIT;
  document.querySelector("#cyclesBack")?.addEventListener("click", () => {
    selectedCycle = "";
    lastAutoFocus = "";
    renderCYCLES(S);
  });
}

export function openCycleDetail(S, cycleCode) {
  const normalized = String(cycleCode || "").toUpperCase();
  if (!S.cycles?.byCode?.has(normalized)) return false;
  selectedCycle = normalized;
  lastAutoFocus = "";
  renderCYCLES(S);
  return true;
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
    const movement = resolvedCurrentMovement(S, cycle);
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
  if (selectedCycle) {
    const cycle = S.cycles?.byCode?.get(selectedCycle);
    if (!cycle) return;
    const current = resolvedCurrentMovement(S, cycle);
    const detail = document.querySelector("#cyclesDetail");
    const currentCode = String(current?.circulacion || "").toUpperCase();
    if (detail?.dataset.currentCirculation !== currentCode) renderDetail(S, cycle);
    else renderDetailSummary(S, cycle, current);
    return;
  }
  for (const model of models.values()) {
    const circulation = model.row.dataset.circulation;
    const live = (S.trains || []).find(train => train.circulation === circulation);
    if (live) {
      tickOperationalTrainRow(model, live, S);
      if (model.routeSummary) {
        if (live.stationed) model.routeSummary.textContent = `est. ${live.stationed}`;
        else {
          const from = model.current.textContent || live.origin || "";
          const to = model.destination.textContent || live.destination || "";
          model.routeSummary.textContent = from && to ? `${from} - ${to}` : (to || from || "");
        }
      }
    }
  }
}
