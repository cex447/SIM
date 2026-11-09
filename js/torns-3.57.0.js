export const MODULE_VERSION = "3.57.0";

import {
  compareTurns,
  displayTurnCode,
  normalizeRawTurn,
  rawTurnFor,
  TURN_GROUP_ORDER,
  turnGroupFor,
  turnPeriodFor
} from "./turns-3.55.0.js";
import {
  createOperationalTrainRow,
  delayedEntries,
  primeDelayedEntries,
  tickOperationalTrainRow,
  updateOperationalTrainRow
} from "./plastic-3.55.0.js";
import {
  cycleForCirculation,
  cycleUnit,
  operationalMinute
} from "./cycles-data-3.56.0.js";

const GROUP_LABELS = Object.freeze({
  PC:"PL. CATALUNYA", SR:"SARRIÀ", RB:"RUBÍ", NA:"TERRASSA", PN:"SABADELL"
});
const overviewModels = new Map();
const affectationModels = new Map();
const selectedModels = new Map();
const filterModels = new Map();
let allFilterModel = null;
let onOpenLITHandler = null;
let onOpenCTCHandler = null;
let lastAutoFocus = "";
let affectationsPrimeKey = "";

const make = (tag, className, value) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
};

function turnCatalog(S) {
  return S.turnAssignments?._resolvedTorns?.byRawTurn || new Map();
}

function currentMinute(S, now = new Date()) {
  return operationalMinute(now, Number(S.config?.serviceDayCutoverHour) || 3);
}

function inferTerminal(circulation, atDestination = true) {
  const code = String(circulation || "").toUpperCase();
  const number = Number(code.slice(1));
  if (!Number.isFinite(number)) return "";
  const odd = number % 2 === 1;
  const terminals = {
    A:odd ? ["PC","SR"] : ["SR","PC"],
    B:odd ? ["PC","TB"] : ["TB","PC"],
    L:odd ? ["SR","RE"] : ["RE","SR"],
    D:odd ? ["PC","NA"] : ["NA","PC"],
    F:odd ? ["PC","PN"] : ["PN","PC"]
  }[code[0]];
  return terminals ? terminals[atDestination ? 1 : 0] : "";
}

function activityOrigin(activity) {
  return activity?.origen || activity?.zona || inferTerminal(activity?.circulacion, false);
}

function activityDestination(activity) {
  return activity?.destino || activity?.zona || inferTerminal(activity?.circulacion, true);
}

function boundaryThreshold(base, edge) {
  if (edge === "start") {
    if (base === "RC") return 23;
    if (base === "NA" || base === "PN") return 19;
    return 15;
  }
  if (base === "RC") return 18;
  if (base === "NA") return 16;
  return 15;
}

function effectiveTurnBase(turn) {
  const raw = normalizeRawTurn(turn?.codigo_abreviado || turn?.codigo || "");
  return raw && /^[A-Z0-9]S[0-9]$/.test(raw) ? "SR" : (turn?.base || "");
}

function interval(kind, place, start, end) {
  return {
    kind:"interval",
    label:kind,
    place:place || "",
    minuto_salida:start,
    minuto_llegada:end,
    salida:minuteText(start),
    llegada:minuteText(end)
  };
}

function minuteText(value) {
  const minute = Number(value);
  const normalized = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2,"0")}:${String(Math.floor(normalized % 60)).padStart(2,"0")}`;
}

export function turnTimeline(turn) {
  const activities = [...(turn?.contenido || [])]
    .sort((a, b) => Number(a.minuto_salida) - Number(b.minuto_salida));
  if (!activities.length) return [];
  const rows = [];
  const first = activities[0];
  const base = effectiveTurnBase(turn);
  const startGap = Number(first.minuto_salida) - Number(turn.minuto_inicio);
  if (startGap > 0) {
    rows.push(interval(
      startGap > boundaryThreshold(base, "start") ? "DESCANS" : "TOMA",
      base,
      Number(turn.minuto_inicio),
      Number(first.minuto_salida)
    ));
  }
  activities.forEach((activity, index) => {
    rows.push({ ...activity, kind:"activity" });
    const next = activities[index + 1];
    if (!next) return;
    const gap = Number(next.minuto_salida) - Number(activity.minuto_llegada);
    if (gap > 15) {
      rows.push(interval(
        "DESCANS",
        activityDestination(activity) || activityOrigin(next),
        Number(activity.minuto_llegada),
        Number(next.minuto_salida)
      ));
    }
  });
  const last = activities.at(-1);
  const endGap = Number(turn.minuto_fin) - Number(last.minuto_llegada);
  if (endGap > 0) {
    rows.push(interval(
      endGap > boundaryThreshold(base, "end") ? "DESCANS" : "DEJE",
      base,
      Number(last.minuto_llegada),
      Number(turn.minuto_fin)
    ));
  }
  return rows;
}

function currentTimelineItem(turn, minute) {
  return turnTimeline(turn).find(item =>
    minute >= Number(item.minuto_salida) && minute < Number(item.minuto_llegada)
  ) || null;
}

function turnIsOnDuty(turn, minute) {
  return minute >= Number(turn.minuto_inicio) && minute < Number(turn.minuto_fin);
}

function liveForActivity(S, activity) {
  if (!activity?.circulacion || activity.rol !== "conductor") return null;
  return (S.trains || []).find(train => train.circulation === activity.circulacion) || null;
}

function activityLabel(activity) {
  if (!activity) return "";
  if (activity.tipo === "taxi") return "TAXI";
  if (activity.tipo === "maniobra_sin_codigo") return activity.texto || "MBRA.";
  return [activity.circulacion || activity.texto || "", activity.anotacion || ""]
    .filter(Boolean).join(" ");
}

function activityRole(activity) {
  if (activity?.tipo === "taxi") return "VIATGER";
  if (activity?.rol === "viajero") return "VIATGER";
  if (activity?.rol === "acompanamiento") return "ACOMP.";
  if (activity?.tipo?.startsWith("maniobra")) return "MANIOBRA";
  if (activity?.categoria_codigo === "material_vacio") return "BUIT";
  return "";
}

function syntheticTrain(S, activity) {
  const circulation = String(activity?.circulacion || "").toUpperCase();
  const cycle = cycleForCirculation(S, circulation);
  const line = activity?.linea || "";
  return {
    id:"",
    circulation,
    unit:cycleUnit(S, cycle),
    family:circulation[0] || "",
    line,
    origin:activityOrigin(activity),
    destination:activityDestination(activity),
    stationed:null,
    nextStop:null,
    ascending:Number(circulation.slice(1)) % 2 === 1,
    onTime:null,
    occupancy:null
  };
}

function syncLineIcon(S, model, activity, live) {
  if (!model.lineIcon) {
    model.lineIcon = make("img", "torns-line-icon");
    model.lineIcon.alt = "";
    model.lineIcon.setAttribute("aria-hidden", "true");
    model.row.appendChild(model.lineIcon);
  }
  const line = live?.line || activity?.linea || "";
  model.lineIcon.src = S.config?.lineAssets?.[line] || "";
  model.lineIcon.hidden = !model.lineIcon.src;
}

function syncRouteSummary(model, activity, train, live) {
  if (!model.routeSummary) {
    model.routeSummary = make("span", "torns-route-summary");
    model.row.appendChild(model.routeSummary);
  }
  if (live?.stationed) {
    model.routeSummary.textContent = `est. ${live.stationed}`;
  } else if (live) {
    const from = model.current.textContent || activityOrigin(activity);
    const to = model.destination.textContent || activityDestination(activity);
    model.routeSummary.textContent = [from, to].filter(Boolean).join(" → ");
  } else {
    const from = activityOrigin(activity);
    const to = activityDestination(activity);
    model.routeSummary.textContent = from && to ? `${from} → ${to}` : (to || from || "");
  }
}

function openTurnDetail(S, rawTurn) {
  const code = displayTurnCode(rawTurn);
  S.tornsView.code = code;
  S.tornsView.state = "active";
  const input = document.querySelector("#turnInput");
  if (input) input.value = code;
  lastAutoFocus = "";
  renderTORNS(S);
}

function ensureActivityRow(S, rawTurn, turn, activity, map = overviewModels, prefix = "main") {
  const key = `${prefix}:${rawTurn}`;
  const live = liveForActivity(S, activity);
  const train = live || syntheticTrain(S, activity);
  let model = map.get(key);
  if (!model) {
    model = createOperationalTrainRow(train, {
      className:prefix === "affect" ? "torns-trainrow torns-affectation-row" : "torns-trainrow",
      onSelectTrain:prefix === "selected" ? null : () => openTurnDetail(S, rawTurn)
    });
    map.set(key, model);
  }
  updateOperationalTrainRow(model, train, S);
  model.turn.textContent = displayTurnCode(rawTurn);
  model.row.dataset.turn = displayTurnCode(rawTurn);
  if (!live) {
    model.circulation.textContent = activityLabel(activity) || "—";
    model.current.textContent = activityRole(activity);
    model.arrow.textContent = activityOrigin(activity) && activityDestination(activity) ? "→" : "";
    model.arrow.className = "route-arrow";
    model.destination.textContent = activityDestination(activity) || activity.zona || "";
    model.operational.textContent = "";
    setTimeRange(model.countdown, activity);
  }
  syncLineIcon(S, model, activity, live);
  syncRouteSummary(model, activity, train, live);
  /* TORNS muestra la franja del contenido del turno. La cuenta atrás de
     PLASTIC no sustituye nunca las horas de inicio y fin aquí. */
  if (prefix !== "affect") {
    model.tornsTime = timeRange(activity);
    model.tornsActivity = activity;
    model.countdown.className = "plastic-countdown torns-activity-time";
    setTimeRange(model.countdown, activity);
  }
  return model;
}

function statusOverviewRow(S, rawTurn, item) {
  const row = make("button", "trainrow torns-trainrow torns-status-row");
  row.type = "button";
  row.addEventListener("click", () => openTurnDetail(S, rawTurn));
  row.append(
    make("span", "train-turn", displayTurnCode(rawTurn)),
    make("span", "torns-status-label", item?.kind === "interval" ? item.label : (activityLabel(item) || "")),
    make("span", "torns-status-place", item?.kind === "interval" ? item.place : detailAction(item)),
    timeRangeNode("torns-status-time", item)
  );
  return row;
}

function activeTurnEntries(S) {
  const minute = currentMinute(S);
  const result = [];
  for (const [rawTurn, turn] of turnCatalog(S)) {
    if (!turnIsOnDuty(turn, minute)) continue;
    const group = turnGroupFor(rawTurn);
    const period = turnPeriodFor(rawTurn);
    if (!group || !period) continue;
    const item = currentTimelineItem(turn, minute);
    result.push({ rawTurn, turn, group, period, item, live:liveForActivity(S, item) });
  }
  /* Los servicios especiales 6xx/7xx conservan su cuadro fechado anterior:
     si no existe catálogo horario, se siguen mostrando sus trenes visibles. */
  if (!turnCatalog(S).size) {
    for (const train of S.trains || []) {
      const rawTurn = rawTurnFor(S.turnAssignments, train.circulation, S.operationalService?.assignmentKey || S.operationalService?.rawCode);
      const group = turnGroupFor(rawTurn);
      const period = turnPeriodFor(rawTurn);
      if (!rawTurn || !group || !period || result.some(entry => entry.rawTurn === rawTurn)) continue;
      const item = {
        kind:"activity", id:`special:${train.circulation}`, tipo:"tren", rol:"conductor",
        circulacion:train.circulation, salida:"", llegada:"",
        minuto_salida:minute - 1, minuto_llegada:minute + 1, linea:train.line
      };
      result.push({ rawTurn, turn:null, group, period, item, live:train });
    }
  }
  return result.sort((a, b) => compareTurns(a.rawTurn, b.rawTurn));
}

function countText(count) { return `${count} ${count === 1 ? "TORN" : "TORNS"}`; }

export function normalizeTurnQueryInput(value) {
  let text = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (text && !text.startsWith("Q")) text = `Q${text}`;
  return text.slice(0, 4);
}

function selectedTurn(S) {
  const raw = normalizeRawTurn(S.tornsView.code);
  if (!raw) return null;
  const catalogued = turnCatalog(S).get(raw);
  if (catalogued) return catalogued;
  if (turnCatalog(S).size) return null;
  const train = (S.trains || []).find(candidate =>
    rawTurnFor(
      S.turnAssignments,
      candidate.circulation,
      S.operationalService?.assignmentKey || S.operationalService?.rawCode
    ) === raw
  );
  if (!train) return null;
  const minute = currentMinute(S);
  return {
    codigo:displayTurnCode(raw), codigo_abreviado:displayTurnCode(raw),
    base:turnGroupFor(raw), minuto_inicio:minute - 1, minuto_fin:minute + 1,
    contenido:[{
      id:`special:${train.circulation}`, tipo:"tren", rol:"conductor",
      circulacion:train.circulation, salida:"", llegada:"",
      minuto_salida:minute - 1, minuto_llegada:minute + 1, linea:train.line
    }]
  };
}

export function selectedTORNSCirculation(S) {
  const turn = selectedTurn(S);
  const item = turn ? currentTimelineItem(turn, currentMinute(S)) : null;
  return item?.circulacion || "";
}

function resolveTurnQuery(S) {
  if (!S.tornsView.code) {
    S.tornsView.state = "empty";
    S.tornsView.selectedCirculation = "";
    return null;
  }
  const turn = selectedTurn(S);
  S.tornsView.state = turn ? "active" : (S.tornsView.code.length >= 4 ? "unavailable" : "empty");
  const item = turn ? currentTimelineItem(turn, currentMinute(S)) : null;
  S.tornsView.selectedCirculation = item?.circulacion || "";
  return turn;
}

function renderQueryMeta(S, turn) {
  const meta = document.querySelector("#tornsQueryMeta");
  const status = document.querySelector("#tornsQueryStatus");
  const unit = document.querySelector("#tornsQueryUnit");
  const ctc = document.querySelector("#tornsCtcButton");
  if (!meta || !status || !unit) return;
  status.hidden = true; unit.hidden = true; ctc.hidden = true;
  if (S.tornsView.state === "unavailable") {
    status.textContent = "TORN NO DISPONIBLE"; status.hidden = false; meta.hidden = false; return;
  }
  if (!turn) { meta.hidden = true; return; }
  const item = currentTimelineItem(turn, currentMinute(S));
  const live = liveForActivity(S, item);
  const cycle = cycleForCirculation(S, item?.circulacion);
  unit.textContent = live?.unit || cycleUnit(S, cycle) || "";
  unit.hidden = !unit.textContent;
  ctc.hidden = !live;
  meta.hidden = false;
}

function syncFilterVisuals(S) {
  for (const group of TURN_GROUP_ORDER) {
    const model = filterModels.get(group); if (!model) continue;
    const selected = S.tornsFilters.stations.has(group);
    model.button.classList.toggle("selected", selected);
    model.button.classList.toggle("dimmed", !selected);
  }
  if (allFilterModel) {
    const selected = S.tornsFilters.stations.size === 0;
    allFilterModel.button.classList.toggle("selected", selected);
    allFilterModel.button.classList.toggle("dimmed", !selected);
  }
}

function filterControl(S, group) {
  const wrapper = make("div", "plastic-filter-stat torns-filter-stat");
  const button = make("button", "text-filter torns-filter-button dimmed");
  button.type = "button";
  button.appendChild(make("span", "plate-label", group || "TOTS"));
  const count = make("span", "plastic-filter-count torns-filter-count", "0");
  button.addEventListener("click", () => {
    if (!group) S.tornsFilters.stations.clear();
    else if (S.tornsFilters.stations.size === 0) S.tornsFilters.stations.add(group);
    else if (S.tornsFilters.stations.has(group)) S.tornsFilters.stations.delete(group);
    else S.tornsFilters.stations.add(group);
    if (S.tornsFilters.stations.size === TURN_GROUP_ORDER.length) S.tornsFilters.stations.clear();
    renderTORNS(S);
  });
  wrapper.append(button, count);
  const model = { wrapper, button, count };
  if (group) filterModels.set(group, model); else allFilterModel = model;
  return wrapper;
}

function normalizedClock(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : "";
}

function timeParts(item) {
  let start = normalizedClock(item?.salida);
  let end = normalizedClock(item?.llegada);
  const code = String(item?.circulacion || "").toUpperCase();
  const isEvenSarriaMove = /^V\d*[02468]$/.test(code) &&
    String(item?.zona || "").toUpperCase() === "SR" &&
    String(item?.tipo || "").startsWith("maniobra");
  if (start && end === start && isEvenSarriaMove) {
    const [hour, minute] = start.split(":").map(Number);
    const next = (hour * 60 + minute + 1) % 1440;
    end = `${String(Math.floor(next / 60)).padStart(2,"0")}:${String(next % 60).padStart(2,"0")}`;
  }
  return { start, end };
}

function timeRange(item) {
  const { start, end } = timeParts(item);
  if (start && end) return `${start}–${end}`;
  return start || end;
}

function setTimeRange(node, item) {
  const { start, end } = timeParts(item);
  node.classList.add("torns-time-range");
  node.replaceChildren(
    make("span", "torns-time-start", start),
    make("span", "torns-time-separator", start && end ? "–" : ""),
    make("span", "torns-time-end", end)
  );
  node.dataset.hasTime = start || end ? "true" : "false";
  return node;
}

function timeRangeNode(className, item) {
  return setTimeRange(make("span", className), item);
}

function detailAction(item) {
  if (!item) return "";
  if (item.kind === "interval") return [item.label, item.place].filter(Boolean).join(" ");
  if (item.tipo === "taxi") return "TAXI";
  if (item.rol === "viajero" || item.rol === "acompanamiento") return "VIATGER";
  return "";
}

function currentMarker(current) {
  if (!current) return make("span", "schedule-current-marker", "");
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

function detailActivityRow(S, item, current) {
  const row = make("button", `schedule-row torns-schedule-row${current ? " is-current" : ""}`);
  row.type = "button";
  if (item.kind === "interval") {
    row.className = `schedule-row schedule-interval${current ? " is-current" : ""}`;
    row.append(
      currentMarker(current),
      make("span", "schedule-kind", item.label),
      make("span", "schedule-place", item.place),
      timeRangeNode("schedule-time", item)
    );
    return row;
  }
  const lineIcon = make("img", "schedule-line-icon");
  lineIcon.alt = "";
  lineIcon.src = S.config?.lineAssets?.[item.linea] || "";
  lineIcon.hidden = !lineIcon.src;
  const circulation = activityLabel(item) || "—";
  const cycle = cycleForCirculation(S, item.circulacion);
  row.append(
    currentMarker(current),
    lineIcon,
    make("span", "schedule-code", circulation),
    make("span", "schedule-unit", cycleUnit(S, cycle)),
    make("span", "schedule-cycle", cycle),
    make("span", "schedule-action", detailAction(item)),
    timeRangeNode("schedule-time", item)
  );
  if (item.circulacion) row.addEventListener("click", () => onOpenLITHandler?.(item.circulacion));
  return row;
}

function renderDetail(S, turn) {
  const directions = document.querySelector("#tornsDirections");
  const affects = document.querySelector("#tornsAfectacions");
  const detail = document.querySelector("#tornsDetail");
  const list = document.querySelector("#tornsDetailList");
  const currentHost = document.querySelector("#tornsCurrentRow");
  const lit = document.querySelector("#tornsLitButton");
  directions.hidden = true; affects.hidden = true; detail.hidden = false;
  const minute = currentMinute(S);
  const current = currentTimelineItem(turn, minute);
  const timeline = turnTimeline(turn);
  const rawTurn = normalizeRawTurn(turn.codigo_abreviado || turn.codigo) || "";
  if (current?.kind === "activity" && current.circulacion) {
    currentHost.replaceChildren(ensureActivityRow(S, rawTurn, turn, current, selectedModels, "selected").row);
  } else {
    currentHost.replaceChildren(statusOverviewRow(S, rawTurn, current));
  }
  list.replaceChildren(...timeline.map(item => detailActivityRow(S, item, item === current)));
  lit.hidden = !current?.circulacion;
  lit.onclick = () => current?.circulacion && onOpenLITHandler?.(current.circulacion);
  const key = `${S.operationalService?.dateKey}:${turn.codigo}:${current?.id || current?.label || "none"}`;
  if (key !== lastAutoFocus) {
    lastAutoFocus = key;
    requestAnimationFrame(() => list.querySelector(".is-current")?.scrollIntoView({ block:"center" }));
  }
}

function renderAffectations(S, entries) {
  const section = document.querySelector("#tornsAfectacions");
  const count = document.querySelector("#tornsAfectacionsCount");
  const list = document.querySelector("#tornsAfectacionsList");
  const affected = [];
  for (const { train } of delayedEntries(S)) {
    const raw = rawTurnFor(S.turnAssignments, train.circulation, S.operationalService?.rawCode);
    const entry = entries.find(candidate => candidate.rawTurn === raw);
    if (entry) affected.push({ ...entry, live:train, item:{ ...entry.item, circulacion:train.circulation, rol:"conductor" } });
  }
  section.hidden = affected.length === 0;
  count.textContent = countText(affected.length);
  list.replaceChildren(...affected.map(entry => ensureActivityRow(S, entry.rawTurn, entry.turn, entry.item, affectationModels, "affect").row));
}

function renderPeriod(S, period, entries) {
  const host = document.querySelector(period === "mati" ? "#tornsMatiList" : "#tornsTardaList");
  const count = document.querySelector(period === "mati" ? "#tornsMatiCount" : "#tornsTardaCount");
  const empty = document.querySelector(period === "mati" ? "#tornsMatiEmpty" : "#tornsTardaEmpty");
  count.textContent = countText(entries.length);
  empty.hidden = entries.length > 0;
  empty.textContent = entries.length ? "" : `ACTUALMENT NO HI HA TORNS DE ${period === "mati" ? "MATÍ" : "TARDA"}`;
  host.replaceChildren();
  for (const group of TURN_GROUP_ORDER) {
    const groupEntries = entries.filter(entry => entry.group === group);
    if (!groupEntries.length) continue;
    const section = make("section", "torns-prefix-group");
    const heading = make("div", "torns-prefix-heading");
    heading.append(make("span", "torns-prefix-label", GROUP_LABELS[group]), make("span", "torns-prefix-count", countText(groupEntries.length)));
    const rows = make("div", "torns-prefix-rows");
    for (const entry of groupEntries) {
      if (entry.item?.kind === "activity" && entry.item.circulacion) {
        rows.appendChild(ensureActivityRow(S, entry.rawTurn, entry.turn, entry.item).row);
      } else rows.appendChild(statusOverviewRow(S, entry.rawTurn, entry.item));
    }
    section.append(heading, rows); host.appendChild(section);
  }
}

function primeAffectations(S) {
  const key = (S.trains || []).filter(t => t.onTime === false).map(t => t.id).sort().join("|");
  if (!key || key === affectationsPrimeKey) return;
  const pending = primeDelayedEntries(S); if (!pending) return;
  affectationsPrimeKey = key;
  pending.finally(() => { affectationsPrimeKey = ""; if (S.activeView === "torns") renderTORNS(S); });
}

export function wireTORNS(S, { onOpenLIT = null, onOpenCTC = null } = {}) {
  onOpenLITHandler = onOpenLIT; onOpenCTCHandler = onOpenCTC;
  document.querySelector("#tornsStationFilters")?.replaceChildren(
    ...TURN_GROUP_ORDER.map(group => filterControl(S, group)), filterControl(S, null)
  );
  const input = document.querySelector("#turnInput");
  input?.addEventListener("pointerdown", event => {
    if (!input.value && S.tornsView.state === "empty") return;
    event.preventDefault(); input.focus({ preventScroll:true }); input.value = "";
    S.tornsView.code = ""; S.tornsView.state = "empty"; lastAutoFocus = ""; renderTORNS(S);
  });
  input?.addEventListener("input", () => {
    const code = normalizeTurnQueryInput(input.value); input.value = code; S.tornsView.code = code;
    resolveTurnQuery(S); renderTORNS(S); if (code.length === 4) input.blur();
  });
  document.querySelector("#tornsCtcButton")?.addEventListener("click", () => {
    const code = selectedTORNSCirculation(S); if (code) onOpenCTCHandler?.(code);
  });
  syncFilterVisuals(S);
}

export function renderTORNS(S) {
  const selected = resolveTurnQuery(S);
  renderQueryMeta(S, selected);
  const directions = document.querySelector("#tornsDirections");
  const detail = document.querySelector("#tornsDetail");
  if (selected) { renderDetail(S, selected); return; }
  detail.hidden = true; directions.hidden = S.tornsView.state === "unavailable";
  if (S.tornsView.state === "unavailable") {
    document.querySelector("#tornsAfectacions").hidden = true; return;
  }
  let entries = activeTurnEntries(S);
  const counts = new Map(TURN_GROUP_ORDER.map(group => [group, 0]));
  entries.forEach(entry => counts.set(entry.group, (counts.get(entry.group) || 0) + 1));
  for (const group of TURN_GROUP_ORDER) filterModels.get(group).count.textContent = String(counts.get(group) || 0);
  allFilterModel.count.textContent = String(entries.length);
  if (S.tornsFilters.stations.size) entries = entries.filter(entry => S.tornsFilters.stations.has(entry.group));
  renderAffectations(S, entries);
  renderPeriod(S, "mati", entries.filter(entry => entry.period === "mati"));
  renderPeriod(S, "tarda", entries.filter(entry => entry.period === "tarda"));
  syncFilterVisuals(S); primeAffectations(S);
}

export function tickTORNS(S) {
  if (S.activeView !== "torns") return;
  for (const model of [...overviewModels.values(), ...affectationModels.values()]) {
    const train = (S.trains || []).find(candidate => candidate.id === model.tripId);
    if (train) {
      tickOperationalTrainRow(model, train, S);
      if (model.tornsTime) {
        model.countdown.className = "plastic-countdown torns-activity-time";
        setTimeRange(model.countdown, model.tornsActivity);
        syncRouteSummary(model, model.tornsActivity, train, train);
      }
    }
  }
}
