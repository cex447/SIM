import { getTripBundle } from "./gtfs.js?v=3.5.1";

const SPECIAL_BLINK_THRESHOLD = new Set(["PC", "MN", "BN", "SR"]);
const MANUAL_SCROLL_HOLD_MS = 2500;

const $ = selector => document.querySelector(selector);

function parentCode(stop) {
  if (stop?.parent_station) return String(stop.parent_station);

  return String(stop?.stop_id || "")
    .replace(/\d+$/, "");
}

function formatDeparture(value) {
  if (!value) return " --:--";

  const [hours, minutes] = String(value).split(":");
  const hour = Number(hours) % 24;

  return `${hour < 10 ? " " : ""}${hour}:${minutes}`;
}

function stationName(stop) {
  return String(stop?.stop_name || stop?.stop_id || "")
    .toLocaleUpperCase("ca-ES");
}

function platformCode(stop) {
  return String(stop?.stop_id || "");
}

function parityOf(train) {
  const last = Number(
    String(train?.circulation || "").slice(-1)
  );

  return Number.isFinite(last) && last % 2 === 0
    ? "even"
    : "odd";
}

function segmentData(S, from, to) {
  return (S.network?.segments || []).find(
    segment =>
      (segment.from === from && segment.to === to) ||
      (segment.from === to && segment.to === from)
  ) || null;
}

function technicalItemVisible(item, context) {
  if (typeof item === "string") return true;
  if (!item || typeof item !== "object") return false;

  if (
    item.parity &&
    item.parity !== context.parity
  ) {
    return false;
  }

  if (
    item.from &&
    item.from !== context.from
  ) {
    return false;
  }

  if (
    item.to &&
    item.to !== context.to
  ) {
    return false;
  }

  if (
    item.line &&
    item.line !== context.line
  ) {
    return false;
  }

  return true;
}

function technicalText(item) {
  return typeof item === "string"
    ? item
    : String(item?.text || "");
}

function technicalLines(segment, context) {
  if (!segment) return [];

  const lines = [];

  if (segment.grade || segment.length) {
    lines.push(
      [segment.grade, segment.length]
        .filter(Boolean)
        .join(" ")
    );
  }

  for (const item of segment.technical || []) {
    if (!technicalItemVisible(item, context)) {
      continue;
    }

    const text = technicalText(item);

    if (text) lines.push(text);
  }

  return lines;
}

function createStationRow(stop, index) {
  const row = document.createElement("div");
  row.className = "lit-row";
  row.dataset.i = String(index);
  row.dataset.code = parentCode(stop);

  const pointer = document.createElement("div");
  pointer.className = "pointer";
  pointer.setAttribute("aria-hidden", "true");

  const timeStack = document.createElement("div");
  timeStack.className = "time-stack";

  const time = document.createElement("div");
  time.className = "time";
  time.textContent = formatDeparture(
    stop.departure_time || stop.arrival_time
  );

  const platform = document.createElement("div");
  platform.className = "platform-code";
  platform.textContent = platformCode(stop);

  timeStack.append(time, platform);

  const station = document.createElement("div");
  station.className = "station-name";
  station.textContent = stationName(stop);

  const count = document.createElement("div");
  count.className = "count";

  row.append(
    pointer,
    timeStack,
    station,
    count
  );

  return row;
}

function createInterstation(
  S,
  from,
  to,
  segmentIndex
) {
  const segment = segmentData(S, from, to);

  const inter = document.createElement("div");
  inter.className = "inter";
  inter.dataset.segmentIndex = String(segmentIndex);
  inter.dataset.from = from;
  inter.dataset.to = to;

  const pointer = document.createElement("div");
  pointer.className = "inter-pointer";

  const spacerTime = document.createElement("div");

  const content = document.createElement("div");
  content.className = "technical";

  const spacerCount = document.createElement("div");

  const context = {
    from,
    to,
    parity: parityOf(S.selected?.live),
    line: S.selected?.live?.line || null
  };

  const lines = technicalLines(
    segment,
    context
  );

  for (const [index, text] of lines.entries()) {
    const line = document.createElement("div");

    line.className =
      index === 0
        ? "inter-line inter-primary"
        : "inter-line inter-secondary";

    line.textContent = text;
    content.appendChild(line);
  }

  if (!lines.length) {
    console.warn(
      `SIM+ LIT: sense dades d'interestació ${from}-${to}`
    );
  }

  inter.append(
    pointer,
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
  $("#litRoute")?.replaceChildren();

  if (S.selected) {
    S.selected = null;
  }
}

export async function loadLIT(
  S,
  circulation,
  liveTrain
) {
  if (!circulation || !liveTrain?.id) {
    clearLIT(S);
    return false;
  }

  S.selected = {
    circulation,
    live: liveTrain,
    stops: [],
    lastFollowKey: null,
    manualHoldUntil: 0,
    autoScrolling: false
  };

  const bundle = await getTripBundle(
    S.config.gtfsZipIndexUrl,
    liveTrain.id
  );

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
}

function render(S) {
  const box = $("#litRoute");
  const fragment =
    document.createDocumentFragment();
  const stops = S.selected?.stops || [];

  box.replaceChildren();

  stops.forEach((stop, index) => {
    fragment.appendChild(
      createStationRow(stop, index)
    );

    if (index >= stops.length - 1) return;

    const from = parentCode(stop);
    const to = parentCode(stops[index + 1]);

    fragment.appendChild(
      createInterstation(
        S,
        from,
        to,
        index
      )
    );

    fragment.appendChild(
      createSeparator()
    );
  });

  box.appendChild(fragment);

  box.addEventListener(
    "scroll",
    () => {
      if (
        !S.selected ||
        S.selected.autoScrolling
      ) {
        return;
      }

      S.selected.manualHoldUntil =
        performance.now() +
        MANUAL_SCROLL_HOLD_MS;
    },
    { passive: true }
  );
}

function locateTrain(S) {
  const stops = S.selected?.stops || [];
  const live = S.selected?.live;

  if (!stops.length || !live) {
    return null;
  }

  if (live.stationed) {
    const index = stops.findIndex(
      stop =>
        parentCode(stop) ===
        String(live.stationed)
    );

    if (index >= 0) {
      return {
        type: "stationed",
        stationIndex: index,
        followIndex: index
      };
    }
  }

  if (live.nextStop) {
    const nextIndex = stops.findIndex(
      stop =>
        parentCode(stop) ===
        String(live.nextStop)
    );

    if (nextIndex >= 0) {
      return {
        type: "moving",
        nextIndex,
        previousIndex:
          nextIndex > 0
            ? nextIndex - 1
            : null,
        followIndex: nextIndex
      };
    }
  }

  return null;
}

function serviceTimeDiffSeconds(timeValue) {
  if (!timeValue) return null;

  const [hours, minutes, seconds = "0"] =
    String(timeValue)
      .split(":")
      .map(Number);

  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds)
  ) {
    return null;
  }

  const now = new Date();
  const target = new Date(now);

  target.setHours(
    hours % 24,
    minutes,
    seconds,
    0
  );

  let diff = Math.floor(
    (target.getTime() - now.getTime()) /
    1000
  );

  /*
   * Los servicios que continúan tras medianoche
   * pueden llegar como 24:xx / 25:xx.
   * Elegimos la ocurrencia temporal más cercana.
   */
  if (diff < -43200) diff += 86400;
  if (diff > 43200) diff -= 86400;

  return diff;
}

function clearPointers() {
  document
    .querySelectorAll(".lit-row")
    .forEach(row => {
      row.classList.remove(
        "current-station",
        "next-station"
      );

      row.querySelector(".pointer")
        ?.replaceChildren();
    });

  document
    .querySelectorAll(".inter")
    .forEach(inter => {
      inter.classList.remove(
        "current-interstation"
      );

      inter.querySelector(".inter-pointer")
        ?.replaceChildren();
    });
}

function clearCountdowns() {
  document
    .querySelectorAll(".count")
    .forEach(node => {
      node.textContent = "";
      node.className = "count";
    });
}

function setTriangle(cell, moving) {
  if (!cell) return;

  const marker =
    document.createElement("span");

  marker.className = moving
    ? "pointer-marker moving"
    : "pointer-marker";

  marker.textContent = "▶";

  cell.replaceChildren(marker);
}

function setStationTriangle(row, moving = false) {
  setTriangle(
    row?.querySelector(".pointer"),
    moving
  );
}

function setInterstationTriangle(inter) {
  setTriangle(
    inter?.querySelector(".inter-pointer"),
    true
  );
}

function updateStationedCountdown(
  stop,
  row
) {
  const count = row?.querySelector(".count");
  if (!count) return;

  const diff = serviceTimeDiffSeconds(
    stop?.departure_time ||
    stop?.arrival_time
  );

  if (diff === null) return;

  const code = parentCode(stop);
  const special =
    SPECIAL_BLINK_THRESHOLD.has(code);

  /*
   * La cronometría solo existe con el tren estacionado.
   * Empieza a 0:59 y permanece en 0:00 hasta que
   * posicionamiento indique que el tren ha salido.
   */
  if (diff > 59) return;

  if (diff >= 0) {
    count.textContent =
      `0:${String(diff).padStart(2, "0")}`;

    if (special && diff <= 13) {
      count.classList.add(
        "red",
        "blink"
      );
    } else if (diff <= 9) {
      count.classList.add("red");
    }

    return;
  }

  count.textContent = "0:00";
  count.classList.add(
    "red",
    "blink"
  );
}

function followTargetNode(location) {
  if (!location) return null;

  if (location.type === "stationed") {
    return document.querySelector(
      `.lit-row[data-i="${location.stationIndex}"]`
    );
  }

  if (location.previousIndex !== null) {
    return document.querySelector(
      `.inter[data-segment-index="${location.previousIndex}"]`
    );
  }

  return document.querySelector(
    `.lit-row[data-i="${location.nextIndex}"]`
  );
}

function followKey(location) {
  if (!location) return "none";

  return location.type === "stationed"
    ? `S:${location.stationIndex}`
    : `M:${location.nextIndex}`;
}

function maybeAutoScroll(
  S,
  location,
  force
) {
  if (!S.selected) return;

  const node = followTargetNode(location);
  if (!node) return;

  if (
    !force &&
    performance.now() <
      (S.selected.manualHoldUntil || 0)
  ) {
    return;
  }

  const key = followKey(location);

  /*
   * Solo se recentra cuando cambia la posición lógica
   * (estación / próxima estación), no cada 250 ms.
   */
  if (
    !force &&
    key === S.selected.lastFollowKey
  ) {
    return;
  }

  S.selected.autoScrolling = true;

  node.scrollIntoView({
    block: "center",
    behavior: force ? "auto" : "smooth"
  });

  S.selected.lastFollowKey = key;

  setTimeout(() => {
    if (S.selected) {
      S.selected.autoScrolling = false;
    }
  }, 320);
}

export function updateCurrent(
  S,
  forceScroll = false
) {
  if (!S.selected?.stops?.length) return;

  const live = (S.trains || []).find(
    train =>
      train.circulation ===
      S.selected.circulation
  );

  if (live) {
    S.selected.live = live;
  }

  const location = locateTrain(S);

  clearPointers();
  clearCountdowns();

  if (!location) return;

  if (location.type === "stationed") {
    const row = document.querySelector(
      `.lit-row[data-i="${location.stationIndex}"]`
    );

    row?.classList.add(
      "current-station"
    );

    setStationTriangle(row, false);

    updateStationedCountdown(
      S.selected.stops[
        location.stationIndex
      ],
      row
    );
  } else {
    const nextRow =
      document.querySelector(
        `.lit-row[data-i="${location.nextIndex}"]`
      );

    nextRow?.classList.add(
      "next-station"
    );

    const inter =
      location.previousIndex !== null
        ? document.querySelector(
            `.inter[data-segment-index="${location.previousIndex}"]`
          )
        : null;

    /*
     * Posición real de la circulación:
     * si posicionament-dels-trens indica una próxima parada,
     * el tren está en la interestación inmediatamente anterior.
     * El triángulo se sitúa por tanto EN la interestación,
     * no sobre la estación siguiente.
     */
    if (inter) {
      inter.classList.add(
        "current-interstation"
      );
      setInterstationTriangle(inter);
    } else {
      setStationTriangle(nextRow, true);
    }
  }

  maybeAutoScroll(
    S,
    location,
    forceScroll
  );
}

export function tickLIT(S) {
  updateCurrent(S, false);
}
