export const MODULE_VERSION = "3.42.0";

import {
  compareTurns,
  displayTurnCode,
  effectiveServiceReference,
  normalizeRawTurn,
  rawTurnFor,
  TURN_GROUP_ORDER,
  turnGroupFor,
  turnPeriodFor
} from "./turns-3.42.0.js";

import {
  createOperationalTrainRow,
  delayedEntries,
  delayTickerEntryText,
  tickOperationalTrainRow,
  updateOperationalTrainRow
} from "./plastic-3.42.0.js";

const GROUP_PREFIXES = Object.freeze({
  PC:Object.freeze(["0", "P"]),
  SR:Object.freeze(["1", "S"]),
  RB:Object.freeze(["2", "R"]),
  NA:Object.freeze(["3", "N"]),
  PN:Object.freeze(["4", "F"])
});
const TICKER_SPEED_PX_PER_SECOND = 28.8;

const rowModels = new Map();
const filterModels = new Map();
const periodGroupModels = new Map();
let onOpenLITHandler = null;
let onOpenCTCHandler = null;
let delayTickerAnimation = null;
let delayTickerKey = "";
let lastDelayTick = 0;

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
      effectiveServiceReference(S, train.id)
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

function clearDelayTickerAnimation() {
  delayTickerAnimation?.cancel();
  delayTickerAnimation = null;
  delayTickerKey = "";
}

function startDelayTicker(track, windowNode, copyA, copyB, key) {
  if (!track || !windowNode || !copyA || !copyB) return;
  if (delayTickerKey === key && delayTickerAnimation) return;

  clearDelayTickerAnimation();
  delayTickerKey = key;

  requestAnimationFrame(() => {
    if (delayTickerKey !== key) return;
    const distance = Math.max(0, copyA.getBoundingClientRect().width || 0);
    const windowWidth = Math.max(0, windowNode.getBoundingClientRect().width || 0);
    if (!distance || distance <= Math.max(0, windowWidth - 2) ||
        window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      copyB.hidden = true;
      track.style.transform = "translate3d(0,0,0)";
      return;
    }

    copyB.hidden = false;
    const duration = Math.max(1000, (distance / TICKER_SPEED_PX_PER_SECOND) * 1000);
    delayTickerAnimation = track.animate(
      [
        { transform:"translate3d(0,0,0)" },
        { transform:`translate3d(-${distance}px,0,0)` }
      ],
      { duration, easing:"linear", iterations:Infinity }
    );
  });
}

function renderDelayTicker(S) {
  const group = document.querySelector("#tornsDelayGroup");
  const count = document.querySelector("#tornsDelayCount");
  const windowNode = group?.querySelector(".torns-delay-window");
  const track = document.querySelector("#tornsDelayTrack");
  const copies = group?.querySelectorAll(".torns-delay-copy") || [];
  if (!group || !count || !track || copies.length < 2) return false;

  const entries = delayedEntries(S);
  if (!entries.length) {
    group.hidden = true;
    clearDelayTickerAnimation();
    return false;
  }

  group.hidden = false;
  count.textContent = `${entries.length}:`;
  const text = entries
    .map(({ train, minutes }) => delayTickerEntryText(S, train, minutes))
    .join("   ");
  const loopText = `${text}   `;
  copies[0].hidden = false;
  copies[0].textContent = loopText;
  copies[1].textContent = loopText;

  const key = entries.map(({ train, minutes }) =>
    delayTickerEntryText(S, train, minutes)
  ).join("|");
  startDelayTicker(track, windowNode, copies[0], copies[1], key);
  return true;
}

function renderQueryMeta(S, selectedEntry = null) {
  const meta = document.querySelector("#tornsQueryMeta");
  const status = document.querySelector("#tornsQueryStatus");
  const unit = document.querySelector("#tornsQueryUnit");
  const ctcButton = document.querySelector("#tornsCtcButton");
  if (!meta || !status || !unit) return;

  status.hidden = true;
  unit.hidden = true;
  unit.classList.remove("delayed-text");
  const queryActive = S.tornsView.state === "active" && Boolean(selectedEntry);
  if (ctcButton) ctcButton.hidden = !queryActive;

  if (S.tornsView.state === "unavailable" ||
      (S.tornsView.state !== "empty" && !selectedEntry)) {
    status.textContent = "TORN NO DISPONIBLE";
    status.hidden = false;
    document.querySelector("#tornsDelayGroup")?.setAttribute("hidden", "");
    clearDelayTickerAnimation();
    meta.hidden = false;
    return;
  }

  if (queryActive) {
    unit.textContent = selectedEntry.train.unit || "";
    unit.classList.toggle("delayed-text", selectedEntry.train.onTime === false);
    unit.hidden = false;
  }

  const hasDelays = renderDelayTicker(S);
  meta.hidden = !queryActive && !hasDelays;
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

function syncRowLineIcon(S, model, train) {
  let icon = model.lineIcon;
  if (!icon) {
    icon = document.createElement("img");
    icon.className = "torns-line-icon";
    icon.decoding = "async";
    icon.setAttribute("aria-hidden", "true");
    model.row.appendChild(icon);
    model.lineIcon = icon;
  }
  icon.src = S.config.lineAssets?.[train.line] || "";
  icon.alt = "";
  icon.hidden = !icon.src;
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
  syncRowLineIcon(S, model, entry.train);
  model.row.dataset.rawTurn = entry.rawTurn;
  return model;
}

function emptyMessage(period) {
  return period === "mati"
    ? "ACTUALMENT NO HI HA TORNS DE MATÍ"
    : "ACTUALMENT NO HI HA TORNS DE TARDA";
}

function setEmpty(period, empty) {
  const node = document.querySelector(period === "mati" ? "#tornsMatiEmpty" : "#tornsTardaEmpty");
  if (!node) return;
  node.hidden = !empty;
  node.textContent = empty ? emptyMessage(period) : "";
}

function ensurePeriodGroup(period, group) {
  const key = `${period}:${group}`;
  if (periodGroupModels.has(key)) return periodGroupModels.get(key);

  const host = document.querySelector(period === "mati" ? "#tornsMatiList" : "#tornsTardaList");
  const section = make("section", "torns-prefix-group");
  section.dataset.tornsGroup = group;
  const heading = make("div", "torns-prefix-heading");
  const prefixes = GROUP_PREFIXES[group] || ["?", "?"];
  const label = make("span", "torns-prefix-label", `${prefixes[0]}  ${prefixes[1]}`);
  const count = make("span", "torns-prefix-count", "0 TORNS");
  const rows = make("div", "torns-prefix-rows");
  heading.append(label, count);
  section.append(heading, rows);
  host?.appendChild(section);

  const model = { section, count, rows };
  periodGroupModels.set(key, model);
  return model;
}

function reconcilePeriod(S, period, entries, queryActive) {
  const count = document.querySelector(period === "mati" ? "#tornsMatiCount" : "#tornsTardaCount");
  const direction = document.querySelector(period === "mati" ? "#tornsMatiDirection" : "#tornsTardaDirection");
  if (!count || !direction) return;

  direction.hidden = queryActive && entries.length === 0;
  count.textContent = countText(entries.length);
  setEmpty(period, !queryActive && entries.length === 0);

  const grouped = new Map(TURN_GROUP_ORDER.map(group => [group, []]));
  for (const entry of entries) grouped.get(entry.group)?.push(entry);
  const activeTurns = new Set(entries.map(entry => entry.rawTurn));

  for (const group of TURN_GROUP_ORDER) {
    const groupEntries = grouped.get(group).sort((a, b) => compareTurns(a.rawTurn, b.rawTurn));
    const model = ensurePeriodGroup(period, group);
    model.count.textContent = countText(groupEntries.length);
    model.section.hidden = groupEntries.length === 0;
    for (const entry of groupEntries) {
      model.rows.appendChild(ensureRow(S, entry).row);
    }
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

function clearTurnQuery(S) {
  const input = document.querySelector("#turnInput");
  if (input) input.value = "";
  S.tornsView.code = "";
  S.tornsView.state = "empty";
  S.tornsView.selectedCirculation = "";
  renderTORNS(S);
}

export function wireTORNS(S, { onOpenLIT = null, onOpenCTC = null } = {}) {
  onOpenLITHandler = onOpenLIT;
  onOpenCTCHandler = onOpenCTC;

  const filters = document.querySelector("#tornsStationFilters");
  filters?.replaceChildren(...TURN_GROUP_ORDER.map(group => createStationFilter(S, group)));

  const input = document.querySelector("#turnInput");
  input?.addEventListener("pointerdown", () => {
    if (!input.value && S.tornsView.state === "empty") return;
    clearTurnQuery(S);
  });
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

  const now = Date.now();
  if (now - lastDelayTick >= 1000) {
    lastDelayTick = now;
    renderQueryMeta(S, resolveTurnQuery(S));
  }
}
