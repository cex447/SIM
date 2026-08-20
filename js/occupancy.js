const CAR_ORDER = Object.freeze([
  ["mi", "MI"],
  ["m1", "M1"],
  ["m2", "M2"],
  ["ri", "RI"]
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

export function readOccupancy(raw = {}) {
  const read = key => {
    const value = raw[`ocupacio_${key}_percent`];

    if (value === null || value === undefined || value === "") {
      return null;
    }

    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };

  return {
    mi: read("mi"),
    m1: read("m1"),
    m2: read("m2"),
    ri: read("ri")
  };
}

export function occupancyFingerprint(occupancy) {
  return CAR_ORDER
    .map(([key]) => occupancy?.[key] ?? "x")
    .join("|");
}

export function updateOccupancy(container, occupancy, { compact = false } = {}) {
  if (!container) return;

  container.classList.toggle("occupancy-compact", compact);

  if (container.children.length !== CAR_ORDER.length) {
    container.replaceChildren();

    for (const [, label] of CAR_ORDER) {
      const car = document.createElement("span");
      car.className = "occ-car occ-unknown";
      car.dataset.car = label;
      car.setAttribute("aria-hidden", "true");
      container.appendChild(car);
    }
  }

  const parts = [];

  CAR_ORDER.forEach(([key, label], index) => {
    const percent = occupancy?.[key] ?? null;
    const car = container.children[index];
    const cls = `occ-${level(percent)}`;

    car.className = `occ-car ${cls}`;
    car.dataset.value = percent === null ? "" : String(percent);

    parts.push(
      percent === null
        ? `${label}: sense dada`
        : `${label}: ${Math.round(percent)}%`
    );
  });

  container.setAttribute("aria-label", `Ocupació. ${parts.join(", ")}`);
}
