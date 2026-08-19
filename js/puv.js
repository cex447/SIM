/*
 * SIM+ — PUV live renderer
 *
 * Reglas:
 * - Ascendentes = circulación impar.
 * - Descendentes = circulación par.
 * - Orden de líneas: A, D, F, B, L.
 * - Dentro de cada línea: UT en orden numérico.
 * - Filtros de línea y serie combinables y multiselección.
 * - Si en_hora == false: parpadean SOLO la UT y, si existe,
 *   el código de estacionamiento.
 * - No se reconstruye todo el DOM en cada refresco.
 */

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

function el(tag, className, text) {
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
  const lineDiff =
    (familyRank.get(a.family) ?? 99) -
    (familyRank.get(b.family) ?? 99);

  if (lineDiff) return lineDiff;

  const unitDiff = unitRank(a.unit) - unitRank(b.unit);
  if (unitDiff) return unitDiff;

  return a.circulation.localeCompare(b.circulation, "es", {
    numeric: true
  });
}

function activeFilters(S) {
  return S.puvFilters || {
    lines: new Set(),
    units: new Set()
  };
}

function selectedUnitSeries(S) {
  return activeFilters(S).units;
}

function selectedFamilies(S) {
  return activeFilters(S).lines;
}

function passesFilters(S, train) {
  const filters = activeFilters(S);

  if (filters.lines.size && !filters.lines.has(train.family)) {
    return false;
  }

  if (
    filters.units.size &&
    !filters.units.has(train.unit.slice(0, 3))
  ) {
    return false;
  }

  return true;
}

function statusText(S, count) {
  if (S.lastError && !S.lastFetch) {
    return "DADES NO DISPONIBLES";
  }

  if (S.lastError && S.lastFetch) {
    return `DADES CONSERVADES · ${S.lastFetch.toLocaleTimeString("es-ES", {
      hour12: false
    })}`;
  }

  if (!S.lastFetch) return "ESPERANT DADES…";

  return `ACTUALITZAT ${S.lastFetch.toLocaleTimeString("es-ES", {
    hour12: false
  })} · ${count} UT`;
}

function updateFilterVisuals(S) {
  const filters = activeFilters(S);

  document
    .querySelectorAll("#lineFilters [data-family]")
    .forEach(button => {
      const family = button.dataset.family;
      const allEffective = filters.lines.size === 0;
      const selected = allEffective || filters.lines.has(family);

      button.classList.toggle("selected", selected);
      button.classList.toggle("dimmed", !selected);
      button.setAttribute("aria-pressed", String(selected));
    });

  document
    .querySelectorAll("#utFilters [data-series]")
    .forEach(button => {
      const series = button.dataset.series;
      const allEffective = filters.units.size === 0;
      const selected = allEffective || filters.units.has(series);

      button.classList.toggle("selected", selected);
      button.classList.toggle("dimmed", !selected);
      button.setAttribute("aria-pressed", String(selected));
    });

  const clear = document.querySelector("#clearPuvFilters");
  if (clear) {
    clear.classList.toggle(
      "filters-clear-active",
      filters.lines.size > 0 || filters.units.size > 0
    );
  }
}

function makeLineFilter(S, family) {
  const line = LINE_BY_FAMILY[family];
  const button = el("button", "line-filter selected");
  button.type = "button";
  button.dataset.family = family;
  button.setAttribute("aria-label", line);
  button.setAttribute("aria-pressed", "true");

  const image = document.createElement("img");
  image.src = S.config.lineAssets?.[line] || "";
  image.alt = line;
  image.decoding = "async";
  image.loading = "eager";

  button.appendChild(image);

  button.addEventListener("click", () => {
    const set = selectedFamilies(S);

    if (set.has(family)) {
      set.delete(family);
    } else {
      set.add(family);
    }

    /*
     * Cuando todos han quedado elegidos manualmente, equivale a "sin filtro":
     * volvemos al estado vacío para que el modelo permanezca simple.
     */
    if (set.size === FAMILY_ORDER.length) {
      set.clear();
    }

    updateFilterVisuals(S);
    renderPUV(S);
  });

  return button;
}

function makeUnitFilter(S, series) {
  const button = el("button", "ut-filter selected", series);
  button.type = "button";
  button.dataset.series = series;
  button.setAttribute("aria-label", `UT${series}`);
  button.setAttribute("aria-pressed", "true");

  button.addEventListener("click", () => {
    const set = selectedUnitSeries(S);

    if (set.has(series)) {
      set.delete(series);
    } else {
      set.add(series);
    }

    if (set.size === S.config.allowedUnitSeries.length) {
      set.clear();
    }

    updateFilterVisuals(S);
    renderPUV(S);
  });

  return button;
}

export function wirePUV(S) {
  S.puvFilters = S.puvFilters || {
    lines: new Set(),
    units: new Set()
  };

  const lineBox = document.querySelector("#lineFilters");
  const unitBox = document.querySelector("#utFilters");
  const clear = document.querySelector("#clearPuvFilters");

  lineBox.replaceChildren(
    ...FAMILY_ORDER.map(family => makeLineFilter(S, family))
  );

  unitBox.replaceChildren(
    ...S.config.allowedUnitSeries.map(series => makeUnitFilter(S, series))
  );

  clear.addEventListener("click", () => {
    S.puvFilters.lines.clear();
    S.puvFilters.units.clear();
    updateFilterVisuals(S);
    renderPUV(S);
  });

  updateFilterVisuals(S);
}

function groupKey(direction, family) {
  return `${direction}:${family}`;
}

function ensureLineGroup(S, direction, family) {
  const key = groupKey(direction, family);
  if (lineGroups.has(key)) return lineGroups.get(key);

  const host = document.querySelector(
    direction === "asc" ? "#ascList" : "#descList"
  );

  const group = el("section", "puv-line-group");
  group.dataset.family = family;

  const heading = el("div", "puv-line-heading");
  const line = LINE_BY_FAMILY[family];

  const image = document.createElement("img");
  image.src = S.config.lineAssets?.[line] || "";
  image.alt = line;
  image.decoding = "async";
  image.loading = "lazy";

  heading.appendChild(image);

  const rows = el("div", "puv-line-rows");

  group.append(heading, rows);
  host.appendChild(group);

  const model = { group, heading, rows };
  lineGroups.set(key, model);

  return model;
}

function rowKey(direction, train) {
  return `${direction}:${train.id}`;
}

function createTrainRow(direction, train) {
  const row = el("div", "trainrow puv-row-enter");
  row.dataset.tripId = train.id;

  const unit = el("span", "train-unit");
  const circulation = el("span", "train-circulation");
  const where = el("span", "train-where");

  row.append(unit, circulation, where);

  rowNodes.set(rowKey(direction, train), {
    row,
    unit,
    circulation,
    where,
    fingerprint: ""
  });

  requestAnimationFrame(() => {
    row.classList.remove("puv-row-enter");
  });

  return rowNodes.get(rowKey(direction, train));
}

function trainFingerprint(train) {
  return [
    train.unit,
    train.circulation,
    train.stationed || "",
    train.nextStop || "",
    train.destination || "",
    train.onTime === null ? "?" : String(train.onTime)
  ].join("|");
}

function updateTrainRow(model, train) {
  const fingerprint = trainFingerprint(train);
  if (model.fingerprint === fingerprint) return;

  model.fingerprint = fingerprint;
  model.unit.textContent = train.unit;
  model.circulation.textContent = train.circulation;

  model.row.classList.toggle("delayed", train.onTime === false);
  model.row.classList.toggle("is-stationed", Boolean(train.stationed));

  model.where.replaceChildren();

  if (train.stationed) {
    model.where.append(
      document.createTextNode("estacionat "),
      el("span", "train-station", train.stationed),
      document.createTextNode(` → ${train.destination || "—"}`)
    );
  } else {
    model.where.append(
      document.createTextNode(
        `direcció ${train.nextStop || "—"} → ${train.destination || "—"}`
      )
    );
  }
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

      updateTrainRow(model, train);

      // appendChild reordena el nodo existente sin recrearlo.
      group.rows.appendChild(model.row);
    }
  }

  for (const [key, model] of rowNodes) {
    if (!key.startsWith(direction + ":")) continue;
    if (activeRowKeys.has(key)) continue;

    model.row.remove();
    rowNodes.delete(key);
  }
}

function emptyMessage(S) {
  const units = [...selectedUnitSeries(S)].sort();

  if (units.length === 1) {
    return `ACTUALMENT NO CIRCULEN UT${units[0]}`;
  }

  if (units.length > 1) {
    return `ACTUALMENT NO CIRCULEN ${units.map(x => `UT${x}`).join(" / ")}`;
  }

  return "ACTUALMENT NO CIRCULEN UNITATS AMB AQUESTS CONDICIONANTS";
}

function setDirectionEmpty(direction, empty, text) {
  const host = document.querySelector(
    direction === "asc" ? "#ascEmpty" : "#descEmpty"
  );

  host.hidden = !empty;
  host.textContent = empty ? text : "";
}

export function renderPUV(S) {
  const filtered = (S.trains || [])
    .filter(train => passesFilters(S, train))
    .sort(sortTrains);

  const asc = filtered.filter(train => train.ascending);
  const desc = filtered.filter(train => !train.ascending);

  const emptyText = emptyMessage(S);

  setDirectionEmpty("asc", asc.length === 0, emptyText);
  setDirectionEmpty("desc", desc.length === 0, emptyText);

  reconcileDirection(S, "asc", asc);
  reconcileDirection(S, "desc", desc);

  const status = document.querySelector("#puvStatus");
  status.textContent = statusText(S, filtered.length);
  status.classList.toggle("error", Boolean(S.lastError));

  updateFilterVisuals(S);
}
