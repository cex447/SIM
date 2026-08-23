/*
 * SIM+ · ocupación por coche
 *
 * FGC expone cuatro campos históricos (M1, MI, RI, M2), pero las UT que
 * representamos en SIM+ son composiciones de tres coches. Para no perder
 * información, MI y RI se condensan en el coche central: si existen ambos,
 * se muestra su media; si sólo existe uno, se usa ese valor.
 */
const DISPLAY_CARS = Object.freeze([
  ["m1", "M1"],
  ["middle", "CENTRE"],
  ["m2", "M2"]
]);

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
    middle: meanAvailable(mi, ri),
    m2: read("m2"),
    /* Conservamos los campos fuente por si se necesitan en diagnóstico. */
    mi,
    ri
  };
}

export function occupancyFingerprint(occupancy) {
  return DISPLAY_CARS.map(([key]) => occupancy?.[key] ?? "x").join("|");
}

export function updateOccupancy(container, occupancy, { compact = false, delayed = false } = {}) {
  if (!container) return;

  container.classList.toggle("occupancy-compact", compact);
  container.classList.toggle("delayed", delayed);

  if (container.children.length !== DISPLAY_CARS.length) {
    container.replaceChildren();

    for (const [, label] of DISPLAY_CARS) {
      const car = document.createElement("span");
      car.className = "occ-car occ-unknown";
      car.dataset.car = label;
      car.setAttribute("aria-hidden", "true");
      container.appendChild(car);
    }
  }

  const parts = [];

  DISPLAY_CARS.forEach(([key, label], index) => {
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
