import {
  occupancyFingerprint,
  updateOccupancy
} from "./occupancy.js?v=3.4.0";

const FAMILY_ORDER = Object.freeze(["A", "D", "F", "B", "L"]);

const LINE_BY_FAMILY = Object.freeze({
  A: "L6",
  D: "S1",
  F: "S2",
  B: "L7",
  L: "L12"
});

const familyRank = new Map(
  FAMILY_ORDER.map((family, index) => [family, index])
);

const rowNodes = new Map();
const lineGroups = new Map();

function make(tag, className, text) {
  const node = document.createElement(tag);

  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;

  return node;
}

function unitRank(unit) {
  const match = String(unit || "").match(/^(\d{3})\.(\d{2})$/);

  if (!match) return Number.MAX_SAFE_INTEGER;

  return Number(match[1]) * 100 + Number(match[2]);
}

function sortTrains(a, b) {
  const familyDiff =
    (familyRank.get(a.family) ?? 99) -
    (familyRank.get(b.family) ?? 99);

  if (familyDiff) return familyDiff;

  const unitDiff = unitRank(a.unit) - unitRank(b.unit);

  if (unitDiff) return unitDiff;

  return a.circulation.localeCompare(
    b.circulation,
    "es",
    { numeric: true }
  );
}

function passesFilters(S, train) {
  if (
    S.puvFilters.lines.size &&
    !S.puvFilters.lines.has(train.family)
  ) {
    return false;
  }

  if (
    S.puvFilters.units.size &&
    !S.puvFilters.units.has(train.unit.slice(0, 3))
  ) {
    return false;
  }

  return true;
}

function syncFilterVisuals(S) {
  document
    .querySelectorAll("#lineFilters [data-family]")
    .forEach(button => {
      const selected =
        S.puvFilters.lines.size === 0 ||
        S.puvFilters.lines.has(button.dataset.family);

      button.classList.toggle("selected", selected);
      button.classList.toggle("dimmed", !selected);
      button.setAttribute("aria-pressed", String(selected));
    });

  document
    .querySelectorAll("#utFilters [data-series]")
    .forEach(button => {
      const selected =
        S.puvFilters.units.has(button.dataset.series);

      button.classList.toggle("selected", selected);
      button.classList.toggle("dimmed", !selected);
      button.setAttribute("aria-pressed", String(selected));
    });

  const allButton = document.querySelector("#clearPuvFilters");
  const allSelected = S.puvFilters.units.size === 0;

  allButton.classList.toggle("selected", allSelected);
  allButton.classList.toggle("dimmed", !allSelected);
  allButton.setAttribute("aria-pressed", String(allSelected));
}

function lineButton(S, family) {
  const line = LINE_BY_FAMILY[family];
  const button = make("button", "line-filter selected");
  button.type = "button";
  button.dataset.family = family;
  button.setAttribute("aria-pressed", "true");
  button.setAttribute("aria-label", line);

  const image = document.createElement("img");
  image.src = S.config.lineAssets?.[line] || "";
  image.alt = line;
  image.decoding = "async";

  const fallback = make("span", "line-fallback", line);
  fallback.hidden = true;

  image.addEventListener("error", () => {
    image.hidden = true;
    fallback.hidden = false;
  });

  button.append(image, fallback);

  button.addEventListener("click", () => {
    const set = S.puvFilters.lines;

    if (set.size === 0) {
      set.add(family);
    } else if (set.has(family)) {
      set.delete(family);
    } else {
      set.add(family);
    }

    if (set.size === FAMILY_ORDER.length) {
      set.clear();
    }

    syncFilterVisuals(S);
    renderPUV(S);
  });

  return button;
}

function unitButton(S, series) {
  const button = make(
    "button",
    "text-filter ut-filter dimmed",
    series
  );

  button.type = "button";
  button.dataset.series = series;
  button.setAttribute("aria-pressed", "false");

  button.addEventListener("click", () => {
    const set = S.puvFilters.units;

    if (set.has(series)) {
      set.delete(series);
    } else {
      set.add(series);
    }

    if (set.size === S.config.allowedUnitSeries.length) {
      set.clear();
    }

    syncFilterVisuals(S);
    renderPUV(S);
  });

  return button;
}

export function wirePUV(S) {
  const lineBox = document.querySelector("#lineFilters");
  const unitBox = document.querySelector("#utFilters");
  const allButton = document.querySelector("#clearPuvFilters");

  lineBox.replaceChildren(
    ...FAMILY_ORDER.map(family => lineButton(S, family))
  );

  unitBox.replaceChildren(
    ...S.config.allowedUnitSeries.map(
      series => unitButton(S, series)
    )
  );

  allButton.addEventListener("click", () => {
    S.puvFilters.units.clear();
    syncFilterVisuals(S);
    renderPUV(S);
  });

  syncFilterVisuals(S);
}

function groupKey(direction, family) {
  return `${direction}:${family}`;
}

function ensureLineGroup(S, direction, family) {
  const key = groupKey(direction, family);

  if (lineGroups.has(key)) {
    return lineGroups.get(key);
  }

  const host = document.querySelector(
    direction === "asc" ? "#ascList" : "#descList"
  );

  const group = make("section", "puv-line-group");
  group.dataset.family = family;

  const heading = make("div", "puv-line-heading");
  const line = LINE_BY_FAMILY[family];

  const image = document.createElement("img");
  image.src = S.config.lineAssets?.[line] || "";
  image.alt = line;
  image.decoding = "async";
  image.loading = "lazy";

  const fallback = make("span", "puv-line-fallback", line);
  fallback.hidden = true;

  image.addEventListener("error", () => {
    image.hidden = true;
    fallback.hidden = false;
  });

  heading.append(image, fallback);

  const rows = make("div", "puv-line-rows");

  group.append(heading, rows);
  host.appendChild(group);

  const model = { group, rows };
  lineGroups.set(key, model);

  return model;
}

function rowKey(direction, train) {
  return `${direction}:${train.id}`;
}

function createTrainRow(direction, train) {
  const row = make("div", "trainrow");
  row.dataset.tripId = train.id;
  row.dataset.circulation = train.circulation;

  const unit = make("span", "train-unit");
  const circulation = make("span", "train-circulation");

  const occupancy = make("div", "occupancy occupancy-compact");
  updateOccupancy(occupancy, train.occupancy, { compact: true });

  const where = make("span", "train-where");

  row.append(unit, circulation, occupancy, where);

  const model = {
    row,
    unit,
    circulation,
    occupancy,
    where,
    fingerprint: ""
  };

  rowNodes.set(rowKey(direction, train), model);
  return model;
}

function fingerprint(train) {
  return [
    train.unit,
    train.circulation,
    train.stationed || "",
    train.nextStop || "",
    train.destination || "",
    train.onTime === null ? "?" : String(train.onTime),
    occupancyFingerprint(train.occupancy)
  ].join("|");
}

function appendStation(where, code) {
  where.appendChild(
    make("strong", "station-token", code || "—")
  );
}

function updateWhere(model, train) {
  model.where.replaceChildren();

  if (train.stationed) {
    model.where.appendChild(
      make("strong", "state-token", "est.")
    );
    model.where.appendChild(document.createTextNode(" "));
    appendStation(model.where, train.stationed);
    model.where.appendChild(document.createTextNode(" → "));
    appendStation(model.where, train.destination);
    return;
  }

  model.where.appendChild(
    make("strong", "state-token", "dir.")
  );
  model.where.appendChild(document.createTextNode(" "));
  appendStation(model.where, train.nextStop);
  model.where.appendChild(document.createTextNode(" → "));
  appendStation(model.where, train.destination);
}

function updateTrainRow(model, train, S) {
  const fp = fingerprint(train);
  const isTarget = S.query?.code === train.circulation;

  model.row.classList.toggle("search-target", isTarget);

  if (model.fingerprint === fp) {
    return;
  }

  model.fingerprint = fp;

  model.unit.textContent = train.unit;
  model.circulation.textContent = train.circulation;

  const delayed = train.onTime === false;

  model.unit.classList.toggle("delayed-text", delayed);
  model.circulation.classList.toggle("delayed-text", delayed);

  updateOccupancy(
    model.occupancy,
    train.occupancy,
    { compact: true }
  );

  updateWhere(model, train);
}

function reconcileDirection(S, direction, trains) {
  const grouped = new Map(
    FAMILY_ORDER.map(family => [family, []])
  );

  for (const train of trains) {
    grouped.get(train.family)?.push(train);
  }

  const activeRowKeys = new Set();

  for (const family of FAMILY_ORDER) {
    const lineTrains = grouped.get(family);
    const group = ensureLineGroup(S, direction, family);

    if (!lineTrains.length) {
      group.group.hidden = true;
      continue;
    }

    group.group.hidden = false;

    for (const train of lineTrains) {
      const key = rowKey(direction, train);
      activeRowKeys.add(key);

      const model =
        rowNodes.get(key) ||
        createTrainRow(direction, train);

      updateTrainRow(model, train, S);

      // Reordena el nodo existente sin reconstruir la fila.
      group.rows.appendChild(model.row);
    }
  }

  for (const [key, model] of rowNodes) {
    if (!key.startsWith(`${direction}:`)) continue;
    if (activeRowKeys.has(key)) continue;

    model.row.remove();
    rowNodes.delete(key);
  }
}

function emptyMessage(S) {
  const units = [...S.puvFilters.units].sort();

  if (units.length === 1) {
    return `ACTUALMENT NO CIRCULEN UT${units[0]}`;
  }

  if (units.length > 1) {
    return `ACTUALMENT NO CIRCULEN ${units
      .map(series => `UT${series}`)
      .join(" / ")}`;
  }

  return "ACTUALMENT NO CIRCULEN UNITATS AMB AQUESTS CONDICIONANTS";
}

function setEmpty(direction, empty, text) {
  const host = document.querySelector(
    direction === "asc" ? "#ascEmpty" : "#descEmpty"
  );

  host.hidden = !empty;
  host.textContent = empty ? text : "";
}

function statusText(S, count) {
  if (S.lastError && !S.lastFetch) {
    return "DADES NO DISPONIBLES";
  }

  if (S.lastError && S.lastFetch) {
    return `DADES CONSERVADES ${S.lastFetch.toLocaleTimeString(
      "es-ES",
      { hour12: false }
    )}`;
  }

  if (!S.lastFetch) {
    return "ESPERANT DADES";
  }

  return `ACTUALITZAT ${S.lastFetch.toLocaleTimeString(
    "es-ES",
    { hour12: false }
  )} · ${count} UT`;
}

export function renderPUV(S) {
  const filtered = (S.trains || [])
    .filter(train => passesFilters(S, train))
    .sort(sortTrains);

  const asc = filtered.filter(train => train.ascending);
  const desc = filtered.filter(train => !train.ascending);
  const empty = emptyMessage(S);

  setEmpty("asc", asc.length === 0, empty);
  setEmpty("desc", desc.length === 0, empty);

  reconcileDirection(S, "asc", asc);
  reconcileDirection(S, "desc", desc);

  const status = document.querySelector("#puvStatus");
  status.textContent = statusText(S, filtered.length);
  status.classList.toggle("error", Boolean(S.lastError));

  syncFilterVisuals(S);
}

export function revealSearchedTrain(S) {
  const code = S.query?.code;

  if (!code || S.activeView !== "puv") {
    return;
  }

  requestAnimationFrame(() => {
    const row = document.querySelector(
      `.trainrow[data-circulation="${CSS.escape(code)}"]`
    );

    if (row) {
      row.scrollIntoView({
        block: "center",
        behavior: "smooth"
      });
    }
  });
}
