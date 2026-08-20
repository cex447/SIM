import { getTripBundle } from "./gtfs.js?v=3.4.1";

const SPECIAL_RED_THRESHOLD = new Set(["PC", "MN", "TT", "SR"]);
const MANUAL_SCROLL_HOLD_MS = 2500;

const $ = selector => document.querySelector(selector);

function hhmm(value) {
  if (!value) return " --:--";

  const [hours, minutes] = String(value).split(":");
  const hour = Number(hours) % 24;

  return `${hour < 10 ? " " : ""}${hour}:${minutes}`;
}

function parentCode(stopId) {
  return String(stopId || "").replace(/\d+$/, "");
}

function segmentData(S, from, to) {
  const list = S.network?.segments || [];

  return list.find(
    segment =>
      (segment.from === from && segment.to === to) ||
      (segment.from === to && segment.to === from)
  ) || null;
}

function stationDisplay(stop) {
  /*
   * El LIT actual trabaja con el identificador operativo/plataforma
   * (SR1, PF1, VL1...). Conservamos ese comportamiento.
   */
  return stop.stop_id || stop.stop_name || "";
}

function createStationRow(stop, index) {
  const row = document.createElement("div");
  row.className = "lit-row";
  row.dataset.i = String(index);
  row.dataset.code = parentCode(stop.stop_id);

  const pointer = document.createElement("div");
  pointer.className = "pointer";
  pointer.setAttribute("aria-hidden", "true");

  const time = document.createElement("div");
  time.className = "time";
  time.textContent = hhmm(stop.arrival_time);

  const station = document.createElement("div");
  station.className = "station-code";
  station.textContent = stationDisplay(stop);

  const count = document.createElement("div");
  count.className = "count";

  row.append(pointer, time, station, count);
  return row;
}

function technicalLines(segment) {
  const lines = [];

  if (segment?.grade || segment?.length) {
    lines.push(
      [segment?.grade, segment?.length]
        .filter(Boolean)
        .join(" ")
    );
  }

  if (Array.isArray(segment?.technical)) {
    for (const item of segment.technical) {
      if (item) lines.push(String(item));
    }
  }

  return lines;
}

function createInterstation(segment) {
  const inter = document.createElement("div");
  inter.className = "inter";

  const spacerPointer = document.createElement("div");
  const spacerTime = document.createElement("div");
  const content = document.createElement("div");
  content.className = "technical";
  const spacerCount = document.createElement("div");

  const lines = technicalLines(segment);

  if (!lines.length) {
    const line = document.createElement("div");
    line.className = "inter-line";
    line.textContent = "";
    content.appendChild(line);
  } else {
    lines.forEach((text, index) => {
      const line = document.createElement("div");
      line.className = index === 0
        ? "inter-line inter-primary"
        : "inter-line inter-secondary";
      line.textContent = text;
      content.appendChild(line);
    });
  }

  inter.append(
    spacerPointer,
    spacerTime,
    content,
    spacerCount
  );

  return inter;
}

function createSeparator() {
  const separator = document.createElement("div");
  separator.className = "separator";
  return separator;
}

export function clearLIT(S) {
  const route = $("#litRoute");

  route.replaceChildren();

  if (S.selected) {
    S.selected = null;
  }
}

export async function loadLIT(S, circulation, liveTrain) {
  if (!circulation || !liveTrain?.id) {
    clearLIT(S);
    return false;
  }

  S.selected = {
    circulation,
    live: liveTrain,
    stops: [],
    lastIndex: null,
    manualHoldUntil: 0,
    autoScrolling: false
  };

  try {
    const bundle = await getTripBundle(
      S.config.gtfsZipIndexUrl,
      liveTrain.id
    );

    // Si mientras cargaba se ha buscado otra circulación, no pintamos ésta.
    if (
      S.query?.code !== circulation ||
      S.query?.state === "inactive"
    ) {
      return false;
    }

    S.selected.trip = bundle.trip;
    S.selected.stops = bundle.times;

    render(S);
    updateCurrent(S, true);

    return true;
  } catch (error) {
    if (S.query?.code === circulation) {
      const route = $("#litRoute");
      route.replaceChildren();

      const message = document.createElement("div");
      message.className = "empty";
      message.textContent = `ERROR LIT · ${String(error?.message || error)}`;
      route.appendChild(message);
    }

    throw error;
  }
}

function render(S) {
  const box = $("#litRoute");
  const fragment = document.createDocumentFragment();
  const stops = S.selected?.stops || [];

  box.replaceChildren();

  stops.forEach((stop, index) => {
    fragment.appendChild(createStationRow(stop, index));

    if (index >= stops.length - 1) {
      return;
    }

    const from = parentCode(stop.stop_id);
    const to = parentCode(stops[index + 1].stop_id);
    const segment = segmentData(S, from, to);

    fragment.appendChild(createInterstation(segment));
    fragment.appendChild(createSeparator());
  });

  box.appendChild(fragment);

  box.addEventListener(
    "scroll",
    () => {
      if (!S.selected || S.selected.autoScrolling) return;

      S.selected.manualHoldUntil =
        performance.now() + MANUAL_SCROLL_HOLD_MS;
    },
    { passive: true }
  );
}

function currentIndex(S) {
  const stops = S.selected?.stops || [];
  const live = S.selected?.live;

  if (!stops.length) return 0;

  if (live?.stationed) {
    const index = stops.findIndex(
      stop =>
        parentCode(stop.stop_id) === String(live.stationed)
    );

    if (index >= 0) return index;
  }

  const next = live?.nextStop;

  if (next) {
    const index = stops.findIndex(
      stop => parentCode(stop.stop_id) === next
    );

    if (index > 0) return index - 1;
    if (index === 0) return 0;
  }

  return 0;
}

function secondsTo(time) {
  if (!time) return null;

  const [hour, minute, second = "0"] =
    String(time).split(":").map(Number);

  const now = new Date();
  const target = new Date(now);

  target.setHours(hour % 24, minute, second, 0);

  let diff = Math.floor((target - now) / 1000);

  // GTFS puede expresar la jornada nocturna como 24:xx/25:xx.
  if (diff < -43200) diff += 86400;
  if (diff > 43200) diff -= 86400;

  return diff;
}

function setPointer(row, moving) {
  const pointer = row?.querySelector(".pointer");

  if (!pointer) return;

  pointer.replaceChildren();

  const marker = document.createElement("span");
  marker.className = moving
    ? "pointer-marker moving"
    : "pointer-marker";

  pointer.appendChild(marker);
}

function clearPointers() {
  document.querySelectorAll(".lit-row").forEach(row => {
    row.classList.remove("current");
    row.querySelector(".pointer")?.replaceChildren();
  });
}

function updateCountdown(S, row, stop) {
  const count = row?.querySelector(".count");

  if (!count) return;

  count.className = "count";
  count.textContent = "";

  const targetTime = stop?.departure_time || stop?.arrival_time;
  const diff = secondsTo(targetTime);

  if (diff === null) return;

  const code = parentCode(stop.stop_id);
  const redThreshold = SPECIAL_RED_THRESHOLD.has(code) ? 13 : 9;

  if (diff >= 0 && diff <= 59) {
    count.textContent = `0:${String(diff).padStart(2, "0")}`;

    if (diff <= redThreshold) {
      count.classList.add("red");
    }

    return;
  }

  if (diff < 0 && diff > -3600) {
    count.textContent = "0:00";
    count.classList.add("red", "blink");
  }
}

function maybeAutoScroll(S, row, force) {
  if (!row || !S.selected) return;

  const now = performance.now();

  if (
    !force &&
    now < (S.selected.manualHoldUntil || 0)
  ) {
    return;
  }

  if (!force && S.selected.lastIndex === Number(row.dataset.i)) {
    return;
  }

  S.selected.autoScrolling = true;

  row.scrollIntoView({
    block: "center",
    behavior: force ? "auto" : "smooth"
  });

  S.selected.lastIndex = Number(row.dataset.i);

  setTimeout(() => {
    if (S.selected) {
      S.selected.autoScrolling = false;
    }
  }, 350);
}

export function updateCurrent(S, forceScroll = false) {
  if (!S.selected?.stops?.length) return;

  const live = (S.trains || []).find(
    train => train.circulation === S.selected.circulation
  );

  if (live) {
    S.selected.live = live;
  }

  const index = currentIndex(S);
  const row = document.querySelector(
    `.lit-row[data-i="${index}"]`
  );

  clearPointers();

  if (row) {
    row.classList.add("current");
    setPointer(row, !S.selected.live?.stationed);
  }

  maybeAutoScroll(S, row, forceScroll);

  document.querySelectorAll(".count").forEach(node => {
    node.textContent = "";
    node.className = "count";
  });

  updateCountdown(
    S,
    row,
    S.selected.stops[index]
  );
}

export function tickLIT(S) {
  updateCurrent(S, false);
}
