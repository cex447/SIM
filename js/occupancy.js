/*
 * SIM+ · ocupación por coche
 *
 * Regla visual vigente:
 * - UT 112 / 113 / 115: 4 coches (M1, MI, RI, M2).
 * - UT 114: 3 coches (M1, coche central, M2). Para la 114, MI y RI se
 *   condensan en el coche central para conservar la información disponible.
 *
 * El número de cuadros depende SIEMPRE de la serie, aunque no exista dato de
 * ocupación: en ese caso se dibujan los cuadros vacíos con su contorno.
 */

const FOUR_CAR_DISPLAY = Object.freeze([
  ["m1", "M1"],
  ["mi", "MI"],
  ["ri", "RI"],
  ["m2", "M2"]
]);

const THREE_CAR_DISPLAY = Object.freeze([
  ["m1", "M1"],
  ["middle", "CENTRE"],
  ["m2", "M2"]
]);

function unitSeries(unit) {
  const match = String(unit || "").match(/^(112|113|114|115)(?:\.|$)/);
  return match?.[1] || null;
}

function displayCars(unit) {
  return unitSeries(unit) === "114" ? THREE_CAR_DISPLAY : FOUR_CAR_DISPLAY;
}

function level(percent) {
  if (percent === null || percent === undefined || Number.isNaN(Number(percent))) {
    return "unknown";
  }

  const value = Number(percent);
  if (value < 25) return "low";
  if (value < 50) return "medium";
  if (value < 75) return "high";
  return "critical";
}

function meanAvailable(...values) {
  const valid = values
    .filter(value => value !== null && value !== undefined && Number.isFinite(Number(value)))
    .map(Number);

  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

export function readOccupancy(raw = {}) {
  const read = key => {
    const value = raw[`ocupacio_${key}_percent`];
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };

  const mi = read("mi");
  const ri = read("ri");

  return {
    m1: read("m1"),
    mi,
    ri,
    middle: meanAvailable(mi, ri),
    m2: read("m2")
  };
}

export function occupancyFingerprint(occupancy) {
  return ["m1", "mi", "ri", "middle", "m2"]
    .map(key => occupancy?.[key] ?? "x")
    .join("|");
}

export function updateOccupancy(
  container,
  occupancy,
  { compact = false, delayed = false, unit = "" } = {}
) {
  if (!container) return;

  const cars = displayCars(unit);
  const series = unitSeries(unit) || "unknown";

  container.classList.toggle("occupancy-compact", compact);
  container.classList.toggle("delayed", delayed);
  container.dataset.series = series;

  const currentLabels = [...container.children]
    .map(child => child.dataset.car || "")
    .join("|");
  const wantedLabels = cars.map(([, label]) => label).join("|");

  if (container.children.length !== cars.length || currentLabels !== wantedLabels) {
    container.replaceChildren();

    for (const [, label] of cars) {
      const car = document.createElement("span");
      car.className = "occ-car occ-unknown";
      car.dataset.car = label;
      car.setAttribute("aria-hidden", "true");
      container.appendChild(car);
    }
  }

  const parts = [];

  cars.forEach(([key, label], index) => {
    const percent = occupancy?.[key] ?? null;
    const car = container.children[index];
    car.className = `occ-car occ-${level(percent)}`;
    car.dataset.value = percent === null ? "" : String(percent);

    parts.push(
      percent === null
        ? `${label}: sense dada`
        : `${label}: ${Math.round(percent)}%`
    );
  });

  container.setAttribute("aria-label", `Ocupació. ${parts.join(", ")}`);
}
