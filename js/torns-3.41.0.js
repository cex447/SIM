export const MODULE_VERSION = "3.41.0";

import {
  compareTurns,
  displayTurnCode,
  normalizeRawTurn,
  rawTurnFor,
  TURN_GROUP_ORDER,
  turnGroupFor,
  turnPeriodFor
} from "./turns-3.41.0.js";

import {
  createOperationalTrainRow,
  tickOperationalTrainRow,
  updateOperationalTrainRow
} from "./plastic-3.41.0.js";

const rowModels = new Map();
const filterModels = new Map();
let onOpenLITHandler = null;
let onOpenCTCHandler = null;

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function activityRank(train) {
  if (train?.stationed && String(train.stationed) === String(train.origin || "")) return 3;
  if (!train?.stationed && train?.nextStop) return 2;
  if (train?.stationed) return 1;
  return 0;
}

function preferCandidate(current, candidate) {
  if (!current) return candidate;
  const rankDiff = activityRank(candidate) - activityRank(current);
  if (rankDiff) return rankDiff > 0 ? candidate : current;

  /* En un relevo de circulación excepcionalmente solapado, la numeración
     superior suele ser la circulación que acaba de entrar en servicio. */
  return candidate.circulation.localeCompare(
    current.circulation,
    "es",
    { numeric:true, sensitivity:"base" }
  ) > 0 ? candidate : current;
}

export function activeTurnEntries(S) {
  const byTurn = new Map();

  for (const train of S.trains || []) {
    const rawTurn = rawTurnFor(
      S.turnAssignments,
      train.circulation,
      train.id
    );
    if (!rawTurn) continue;

    const group = turnGroupFor(rawTurn);
    const period = turnPeriodFor(rawTurn);
    if (!group || !period) continue;

    const previous = byTurn.get(rawTurn);
    const selectedTrain = preferCandidate(previous?.train || null, train);
    byTurn.set(rawTurn, {
      rawTurn,
      turn:displayTurnCode(rawTurn),
      group,
      period,
      train:selectedTrain
    });
  }

  return [...byTurn.values()].sort((a, b) => compareTurns(a.rawTurn, b.rawTurn));
}

function countText(count) {
  return `${count} ${count === 1 ? "TORN" : "TORNS"}`;
}

export function normalizeTurnQueryInput(value) {
  let text = String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (text && !text.startsWith("Q")) text = `Q${text}`;
  return text.slice(0, 4);
}

export function selectedTORNSCirculation(S) {
  if (S.tornsView?.state !== "active") return "";
  return String(S.tornsView.selectedCirculation || "").toUpperCase();
}

function resolveTurnQuery(S) {
  const rawTurn = normalizeRawTurn(S.tornsView.code);
  if (!rawTurn) {
    S.tornsView.state = S.tornsView.code.length >= 4 ? "unavailable" : "empty";
    S.tornsView.selectedCirculation = "";
    return null;
  }

  const entry = activeTurnEntries(S).find(candidate => candidate.rawTurn === rawTurn) || null;
  S.tornsView.state = entry ? "active" : "unavailable";
  S.tornsView.selectedCirculation = entry?.train?.circulation || "";
  return entry;
}

function renderQueryMeta(S, selectedEntry = null) {
  const meta = document.querySelector("#tornsQueryMeta");
  const status = document.querySelector("#tornsQueryStatus");
  const unit = document.querySelector("#tornsQueryUnit");
  if (!meta || !status || !unit) return;

  status.hidden = true;
  unit.hidden = true;
  unit.classList.remove("delayed-text");

  if (S.tornsView.state === "empty") {
    meta.hidden = true;
    return;
  }

  meta.hidden = false;
  if (S.tornsView.state === "unavailable" || !selectedEntry) {
    status.textContent = "TORN NO DISPONIBLE";
    status.hidden = false;
    return;
  }

  unit.textContent = selectedEntry.train.unit || "";
  unit.classList.toggle("delayed-text", selectedEntry.train.onTime === false);
  unit.hidden = false;
}

function syncFilterVisuals(S) {
  for (const group of TURN_GROUP_ORDER) {
    const model = filterModels.get(group);
    if (!model) continue;
    const selected = S.tornsFilters.stations.size === 0 ||
      S.tornsFilters.stations.has(group);
    model.button.classList.toggle("selected", selected);
    model.button.classList.toggle("dimmed", !selected);
    model.button.setAttribute("aria-pressed", String(selected));
  }
}

function createStationFilter(S, group) {
  const wrapper = make("div", "torns-filter-stat");
  const button = make("button", "torns-filter-button selected", group);
  const count = make("span", "torns-filter-count", "0");

  button.type = "button";
  button.dataset.tornsGroup = group;
  button.setAttribute("aria-label", `Filtrar torns ${group}`);
  button.setAttribute("aria-pressed", "true");

  button.addEventListener("click", () => {
    const stations = S.tornsFilters.stations;
    if (stations.size === 0) stations.add(group);
    else if (stations.has(group)) stations.delete(group);
    else stations.add(group);

    if (stations.size === TURN_GROUP_ORDER.length) stations.clear();
    syncFilterVisuals(S);
    renderTORNS(S);
  });

  wrapper.append(button, count);
  const model = { wrapper, button, count };
  filterModels.set(group, model);
  return wrapper;
}

function setQueryFromTurn(S, turn) {
  const rawTurn = normalizeRawTurn(turn);
  if (!rawTurn) return;

  const code = displayTurnCode(rawTurn);
  const input = document.querySelector("#turnInput");
  if (input) input.value = code;
  S.tornsView.code = code;
  resolveTurnQuery(S);
  renderTORNS(S);
}

function ensureRow(S, entry) {
  let model = rowModels.get(entry.rawTurn);
  if (!model) {
    model = createOperationalTrainRow(entry.train, {
      className:"torns-trainrow",
      onSelectTrain:(_circulation, turn) => setQueryFromTurn(S, turn)
    });
    rowModels.set(entry.rawTurn, model);
  }

  updateOperationalTrainRow(model, entry.train, S);
  model.row.dataset.rawTurn = entry.rawTurn;
  return model;
}

function setEmpty(period, empty) {
  const node = document.querySelector(period === "mati" ? "#tornsMatiEmpty" : "#tornsTardaEmpty");
  if (!node) return;
  node.hidden = !empty;
  node.textContent = empty ? "ACTUALMENT NO HI HA TORNS AMB AQUESTS CONDICIONANTS" : "";
}

function reconcilePeriod(S, period, entries, queryActive) {
  const host = document.querySelector(period === "mati" ? "#tornsMatiList" : "#tornsTardaList");
  const count = document.querySelector(period === "mati" ? "#tornsMatiCount" : "#tornsTardaCount");
  const direction = document.querySelector(period === "mati" ? "#tornsMatiDirection" : "#tornsTardaDirection");
  if (!host || !count || !direction) return;

  direction.hidden = queryActive && entries.length === 0;
  count.textContent = countText(entries.length);
  setEmpty(period, !queryActive && entries.length === 0);

  const activeTurns = new Set(entries.map(entry => entry.rawTurn));
  for (const entry of entries) {
    const model = ensureRow(S, entry);
    host.appendChild(model.row);
  }

  for (const [rawTurn, model] of rowModels) {
    if (turnPeriodFor(rawTurn) !== period || activeTurns.has(rawTurn)) continue;
    model.row.remove();
  }
}

function placeLITAction(selectedEntry) {
  const action = document.querySelector("#tornsLitAction");
  const button = document.querySelector("#tornsLitButton");
  if (!action || !button) return;

  const available = Boolean(selectedEntry?.train?.circulation);
  action.hidden = !available;
  if (!available) return;

  const model = rowModels.get(selectedEntry.rawTurn);
  if (model?.row?.parentNode) model.row.insertAdjacentElement("afterend", action);
  button.dataset.circulation = selectedEntry.train.circulation;
}

export function wireTORNS(S, { onOpenLIT = null, onOpenCTC = null } = {}) {
  onOpenLITHandler = onOpenLIT;
  onOpenCTCHandler = onOpenCTC;

  const filters = document.querySelector("#tornsStationFilters");
  filters?.replaceChildren(...TURN_GROUP_ORDER.map(group => createStationFilter(S, group)));

  const input = document.querySelector("#turnInput");
  input?.addEventListener("input", () => {
    const code = normalizeTurnQueryInput(input.value);
    input.value = code;
    S.tornsView.code = code;
    resolveTurnQuery(S);
    renderTORNS(S);

    if (code.length === 4) input.blur();
  });

  document.querySelector("#tornsLitButton")?.addEventListener("click", () => {
    const circulation = selectedTORNSCirculation(S);
    if (circulation && onOpenLITHandler) onOpenLITHandler(circulation);
  });

  document.querySelector("#tornsCtcButton")?.addEventListener("click", () => {
    const circulation = selectedTORNSCirculation(S);
    if (circulation && onOpenCTCHandler) onOpenCTCHandler(circulation);
  });

  syncFilterVisuals(S);
}

export function renderTORNS(S) {
  const selectedEntry = resolveTurnQuery(S);
  renderQueryMeta(S, selectedEntry);

  const allEntries = activeTurnEntries(S);
  const counts = new Map(TURN_GROUP_ORDER.map(group => [group, 0]));
  for (const entry of allEntries) counts.set(entry.group, (counts.get(entry.group) || 0) + 1);
  for (const group of TURN_GROUP_ORDER) {
    const model = filterModels.get(group);
    if (model) {
      const count = counts.get(group) || 0;
      model.count.textContent = String(count);
      model.button.setAttribute(
        "aria-label",
        `Filtrar torns ${group}: ${count} ${count === 1 ? "torn actiu" : "torns actius"}`
      );
    }
  }

  const queryActive = S.tornsView.state === "active" && Boolean(selectedEntry);
  const queryUnavailable = S.tornsView.state === "unavailable";
  const directions = document.querySelector("#tornsDirections");
  if (directions) {
    directions.hidden = queryUnavailable;
    directions.classList.toggle("single-result", queryActive);
  }

  let visible = queryActive ? [selectedEntry] : allEntries;
  if (!queryActive && S.tornsFilters.stations.size) {
    visible = visible.filter(entry => S.tornsFilters.stations.has(entry.group));
  }
  visible.sort((a, b) => compareTurns(a.rawTurn, b.rawTurn));

  reconcilePeriod(S, "mati", visible.filter(entry => entry.period === "mati"), queryActive);
  reconcilePeriod(S, "tarda", visible.filter(entry => entry.period === "tarda"), queryActive);
  placeLITAction(queryActive ? selectedEntry : null);
  syncFilterVisuals(S);
}

export function tickTORNS(S) {
  if (S.activeView !== "torns") return;
  for (const model of rowModels.values()) {
    const train = (S.trains || []).find(candidate => candidate.id === model.tripId);
    if (train) tickOperationalTrainRow(model, train, S);
  }
}
