/* SIM+ Beta 3.4.1 — PUV crítico, sin importaciones. */

const FAMILY_ORDER = Object.freeze(["A", "D", "F", "B", "L"]);
const LINE_BY_FAMILY = Object.freeze({A:"L6",D:"S1",F:"S2",B:"L7",L:"L12"});
const LINE_ASSETS = Object.freeze({
  L6:"https://www.fgc.cat/wp-content/uploads/2020/06/l-6.png",
  S1:"https://www.fgc.cat/wp-content/uploads/2020/06/s-1.png",
  S2:"https://www.fgc.cat/wp-content/uploads/2020/06/s-2.png",
  L7:"https://www.fgc.cat/wp-content/uploads/2020/06/l-7.png",
  L12:"https://www.fgc.cat/wp-content/uploads/2020/06/l-12.png"
});
const familyRank = new Map(FAMILY_ORDER.map((family, index) => [family, index]));
const rowNodes = new Map();
const lineGroups = new Map();

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function occLevel(percent) {
  if (percent === null || percent === undefined || Number.isNaN(Number(percent))) return "unknown";
  const v = Number(percent);
  if (v < 25) return "low";
  if (v < 50) return "medium";
  if (v < 75) return "high";
  return "critical";
}

export function paintOccupancy(container, occupancy, compact = false) {
  if (!container) return;
  container.className = compact ? "occupancy occupancy-compact" : "occupancy";
  const order = [["mi","MI"],["m1","M1"],["m2","M2"],["ri","RI"]];
  if (container.children.length !== 4) {
    container.replaceChildren(...order.map(([,label]) => {
      const car = make("span", "occ-car occ-unknown");
      car.dataset.car = label;
      car.setAttribute("aria-hidden", "true");
      return car;
    }));
  }
  const aria = [];
  order.forEach(([key,label], index) => {
    const percent = occupancy?.[key] ?? null;
    const car = container.children[index];
    car.className = `occ-car occ-${occLevel(percent)}`;
    aria.push(percent === null ? `${label}: sense dada` : `${label}: ${Math.round(percent)}%`);
  });
  container.setAttribute("aria-label", `Ocupació. ${aria.join(", ")}`);
}

function occupancyFingerprint(occupancy) {
  return ["mi","m1","m2","ri"].map(key => occupancy?.[key] ?? "x").join("|");
}

function unitRank(unit) {
  const match = String(unit || "").match(/^(\d{3})\.(\d{2})$/);
  return match ? Number(match[1]) * 100 + Number(match[2]) : Number.MAX_SAFE_INTEGER;
}

function sortTrains(a, b) {
  return ((familyRank.get(a.family) ?? 99) - (familyRank.get(b.family) ?? 99))
    || (unitRank(a.unit) - unitRank(b.unit))
    || a.circulation.localeCompare(b.circulation, "es", { numeric: true });
}

function passesFilters(S, train) {
  if (S.puvFilters.lines.size && !S.puvFilters.lines.has(train.family)) return false;
  if (S.puvFilters.units.size && !S.puvFilters.units.has(train.unit.slice(0, 3))) return false;
  return true;
}

function syncFilterVisuals(S) {
  document.querySelectorAll("#lineFilters [data-family]").forEach(button => {
    const selected = S.puvFilters.lines.size === 0 || S.puvFilters.lines.has(button.dataset.family);
    button.classList.toggle("selected", selected);
    button.classList.toggle("dimmed", !selected);
    button.setAttribute("aria-pressed", String(selected));
  });

  document.querySelectorAll("#utFilters [data-series]").forEach(button => {
    const selected = S.puvFilters.units.has(button.dataset.series);
    button.classList.toggle("selected", selected);
    button.classList.toggle("dimmed", !selected);
    button.setAttribute("aria-pressed", String(selected));
  });

  const allButton = document.querySelector("#clearPuvFilters");
  const allSelected = S.puvFilters.units.size === 0;
  if (allButton) {
    allButton.classList.toggle("selected", allSelected);
    allButton.classList.toggle("dimmed", !allSelected);
    allButton.setAttribute("aria-pressed", String(allSelected));
  }
}

export function wirePUV(S) {
  document.querySelectorAll("#lineFilters [data-family]").forEach(button => {
    if (button.dataset.wired === "1") return;
    button.dataset.wired = "1";
    button.addEventListener("click", () => {
      const family = button.dataset.family;
      const set = S.puvFilters.lines;
      if (set.size === 0) set.add(family);
      else if (set.has(family)) set.delete(family);
      else set.add(family);
      if (set.size === FAMILY_ORDER.length) set.clear();
      syncFilterVisuals(S);
      renderPUV(S);
    });
  });

  document.querySelectorAll("#utFilters [data-series]").forEach(button => {
    if (button.dataset.wired === "1") return;
    button.dataset.wired = "1";
    button.addEventListener("click", () => {
      const series = button.dataset.series;
      const set = S.puvFilters.units;
      if (set.has(series)) set.delete(series);
      else set.add(series);
      if (set.size === S.config.allowedUnitSeries.length) set.clear();
      syncFilterVisuals(S);
      renderPUV(S);
    });
  });

  const allButton = document.querySelector("#clearPuvFilters");
  if (allButton && allButton.dataset.wired !== "1") {
    allButton.dataset.wired = "1";
    allButton.addEventListener("click", () => {
      S.puvFilters.units.clear();
      syncFilterVisuals(S);
      renderPUV(S);
    });
  }
  syncFilterVisuals(S);
}

function groupKey(direction, family) { return `${direction}:${family}`; }

function ensureLineGroup(direction, family) {
  const key = groupKey(direction, family);
  if (lineGroups.has(key)) return lineGroups.get(key);
  const host = document.querySelector(direction === "asc" ? "#ascList" : "#descList");
  const group = make("section", "puv-line-group");
  group.dataset.family = family;
  const heading = make("div", "puv-line-heading");
  const line = LINE_BY_FAMILY[family];
  const image = document.createElement("img");
  image.src = LINE_ASSETS[line];
  image.alt = line;
  image.decoding = "async";
  const fallback = make("span", "puv-line-fallback", line);
  fallback.hidden = true;
  image.addEventListener("error", () => { image.hidden = true; fallback.hidden = false; });
  heading.append(image, fallback);
  const rows = make("div", "puv-line-rows");
  group.append(heading, rows);
  host.appendChild(group);
  const model = { group, rows };
  lineGroups.set(key, model);
  return model;
}

function rowKey(direction, train) { return `${direction}:${train.id}`; }

function createTrainRow(direction, train) {
  const row = make("div", "trainrow");
  row.dataset.tripId = train.id;
  row.dataset.circulation = train.circulation;
  const unit = make("span", "train-unit");
  const circulation = make("span", "train-circulation");
  const occupancy = make("div", "occupancy occupancy-compact");
  const where = make("span", "train-where");
  row.append(unit, circulation, occupancy, where);
  const model = { row, unit, circulation, occupancy, where, fingerprint: "" };
  rowNodes.set(rowKey(direction, train), model);
  return model;
}

function fingerprint(train) {
  return [train.unit, train.circulation, train.stationed || "", train.nextStop || "",
    train.destination || "", train.onTime === null ? "?" : String(train.onTime),
    occupancyFingerprint(train.occupancy)].join("|");
}

function stationNode(code) { return make("strong", "station-token", code || "—"); }

function updateWhere(model, train) {
  model.where.replaceChildren();
  const state = make("strong", "state-token", train.stationed ? "est." : "dir.");
  const first = train.stationed || train.nextStop;
  model.where.append(state, document.createTextNode(" "), stationNode(first),
    document.createTextNode(" → "), stationNode(train.destination));
}

function updateTrainRow(model, train, S) {
  const fp = fingerprint(train);
  model.row.classList.toggle("search-target", S.query?.code === train.circulation);
  if (model.fingerprint === fp) return;
  model.fingerprint = fp;
  model.unit.textContent = train.unit;
  model.circulation.textContent = train.circulation;
  const delayed = train.onTime === false;
  model.unit.classList.toggle("delayed-text", delayed);
  model.circulation.classList.toggle("delayed-text", delayed);
  paintOccupancy(model.occupancy, train.occupancy, true);
  updateWhere(model, train);
}

function reconcileDirection(S, direction, trains) {
  const grouped = new Map(FAMILY_ORDER.map(family => [family, []]));
  for (const train of trains) grouped.get(train.family)?.push(train);
  const activeKeys = new Set();

  for (const family of FAMILY_ORDER) {
    const lineTrains = grouped.get(family);
    const group = ensureLineGroup(direction, family);
    group.group.hidden = lineTrains.length === 0;
    if (!lineTrains.length) continue;
    for (const train of lineTrains) {
      const key = rowKey(direction, train);
      activeKeys.add(key);
      const model = rowNodes.get(key) || createTrainRow(direction, train);
      updateTrainRow(model, train, S);
      group.rows.appendChild(model.row);
    }
  }

  for (const [key, model] of rowNodes) {
    if (key.startsWith(`${direction}:`) && !activeKeys.has(key)) {
      model.row.remove();
      rowNodes.delete(key);
    }
  }
}

function emptyMessage(S) {
  const units = [...S.puvFilters.units].sort();
  if (units.length === 1) return `ACTUALMENT NO CIRCULEN UT${units[0]}`;
  if (units.length > 1) return `ACTUALMENT NO CIRCULEN ${units.map(x => `UT${x}`).join(" / ")}`;
  return "ACTUALMENT NO CIRCULEN UNITATS AMB AQUESTS CONDICIONANTS";
}

function setEmpty(direction, empty, text) {
  const node = document.querySelector(direction === "asc" ? "#ascEmpty" : "#descEmpty");
  if (!node) return;
  node.hidden = !empty;
  node.textContent = empty ? text : "";
}

function statusText(S, count) {
  if (S.lastError && !S.lastFetch) return "DADES NO DISPONIBLES";
  if (S.lastError && S.lastFetch) return `DADES CONSERVADES ${S.lastFetch.toLocaleTimeString("es-ES", {hour12:false})}`;
  if (!S.lastFetch) return "ESPERANT DADES";
  return `ACTUALITZAT ${S.lastFetch.toLocaleTimeString("es-ES", {hour12:false})} · ${count} UT`;
}

export function renderPUV(S) {
  const filtered = (S.trains || []).filter(train => passesFilters(S, train)).sort(sortTrains);
  const asc = filtered.filter(train => train.ascending);
  const desc = filtered.filter(train => !train.ascending);
  const empty = emptyMessage(S);
  setEmpty("asc", asc.length === 0, empty);
  setEmpty("desc", desc.length === 0, empty);
  reconcileDirection(S, "asc", asc);
  reconcileDirection(S, "desc", desc);
  const status = document.querySelector("#puvStatus");
  if (status) {
    status.textContent = statusText(S, filtered.length);
    status.classList.toggle("error", Boolean(S.lastError));
  }
  syncFilterVisuals(S);
}

export function revealSearchedTrain(S) {
  const code = S.query?.code;
  if (!code || S.activeView !== "puv") return;
  requestAnimationFrame(() => {
    const safe = window.CSS?.escape ? CSS.escape(code) : code.replace(/[^A-Z0-9_-]/g, "");
    const row = document.querySelector(`.trainrow[data-circulation="${safe}"]`);
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}
