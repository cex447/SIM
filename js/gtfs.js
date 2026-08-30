import { resolveGtfsTimestamp } from "./time.js?v=3.30.0";

const CACHE = {
  index: null,
  text: new Map(),
  trips: null,
  stops: null,
  tripTimes: new Map(),
  scheduleIndex: null,
  serviceDates: new Map()
};

function parseCSVLine(line) {
  const out = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  out.push(current);
  return out;
}

function headerOf(text) {
  const first = text
    .split(/\r?\n/, 1)[0]
    .replace(/^\uFEFF/, "");

  return parseCSVLine(first).map(value => value.trim());
}

function rowObject(header, line) {
  const values = parseCSVLine(line);
  const row = {};

  header.forEach((name, index) => {
    row[name] = values[index] ?? "";
  });

  return row;
}

export async function loadGtfsFileIndex(indexUrl) {
  if (CACHE.index) return CACHE.index;

  const separator = indexUrl.includes("?") ? "&" : "?";
  const response = await fetch(
    `${indexUrl}${separator}_ts=${Date.now()}`,
    { cache: "no-store" }
  );

  if (!response.ok) throw new Error(`GTFS index HTTP ${response.status}`);

  const json = await response.json();
  const index = {};

  for (const record of json.results || []) {
    const file = record.file;
    if (file?.filename && file?.url) index[file.filename] = file.url;
  }

  CACHE.index = index;
  return index;
}

async function textFile(indexUrl, name, { optional = false } = {}) {
  if (CACHE.text.has(name)) return CACHE.text.get(name);

  const index = await loadGtfsFileIndex(indexUrl);
  if (!index[name]) {
    if (optional) return null;
    throw new Error(`No existe ${name}`);
  }

  const separator = index[name].includes("?") ? "&" : "?";
  const response = await fetch(
    `${index[name]}${separator}_ts=${Date.now()}`,
    { cache: "no-store" }
  );

  if (!response.ok) {
    if (optional) return null;
    throw new Error(`${name} HTTP ${response.status}`);
  }

  const text = await response.text();
  CACHE.text.set(name, text);
  return text;
}

async function getTripsMap(indexUrl) {
  if (CACHE.trips) return CACHE.trips;

  const text = await textFile(indexUrl, "trips.txt");
  const header = headerOf(text);
  const map = new Map();

  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line) continue;
    const row = rowObject(header, line);
    if (row.trip_id) map.set(row.trip_id, row);
  }

  CACHE.trips = map;
  return map;
}

async function getStopsMap(indexUrl) {
  if (CACHE.stops) return CACHE.stops;

  const text = await textFile(indexUrl, "stops.txt");
  const header = headerOf(text);
  const map = new Map();

  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line) continue;
    const row = rowObject(header, line);

    if (row.stop_id) {
      map.set(row.stop_id, {
        id: row.stop_id,
        name: row.stop_name || row.stop_id,
        parent: row.parent_station || parentCode(row.stop_id),
        platform: row.platform_code || ""
      });
    }
  }

  CACHE.stops = map;
  return map;
}

async function buildScheduleIndex(indexUrl) {
  if (CACHE.scheduleIndex) return CACHE.scheduleIndex;

  const [text, stops] = await Promise.all([
    textFile(indexUrl, "stop_times.txt"),
    getStopsMap(indexUrl)
  ]);

  const header = headerOf(text);
  const stationRows = new Map();
  const tripRows = new Map();
  const bounds = new Map();

  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line) continue;
    const row = rowObject(header, line);
    if (!row.trip_id || !row.stop_id) continue;

    const stop = stops.get(row.stop_id);
    const station = stop?.parent || parentCode(row.stop_id);
    const enriched = {
      ...row,
      stop_name: stop?.name || row.stop_id,
      parent_station: station,
      platform_code: stop?.platform || ""
    };

    if (!stationRows.has(station)) stationRows.set(station, []);
    stationRows.get(station).push(enriched);

    if (!tripRows.has(row.trip_id)) tripRows.set(row.trip_id, []);
    tripRows.get(row.trip_id).push(enriched);

    const seq = Number(row.stop_sequence);
    const bound = bounds.get(row.trip_id) || { first:null, last:null };
    if (!bound.first || seq < Number(bound.first.stop_sequence)) bound.first = enriched;
    if (!bound.last || seq > Number(bound.last.stop_sequence)) bound.last = enriched;
    bounds.set(row.trip_id, bound);
  }

  for (const [tripId, rows] of tripRows) {
    rows.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
    CACHE.tripTimes.set(tripId, rows);
  }

  for (const rows of stationRows.values()) {
    rows.sort((a, b) => {
      const sa = String(a.departure_time || a.arrival_time || "");
      const sb = String(b.departure_time || b.arrival_time || "");
      return sa.localeCompare(sb);
    });
  }

  CACHE.scheduleIndex = { stationRows, tripRows, bounds };
  return CACHE.scheduleIndex;
}

async function getStopTimes(indexUrl, tripId) {
  if (CACHE.tripTimes.has(tripId)) return CACHE.tripTimes.get(tripId);

  if (CACHE.scheduleIndex) {
    const rows = CACHE.scheduleIndex.tripRows.get(tripId) || [];
    CACHE.tripTimes.set(tripId, rows);
    return rows;
  }

  const text = await textFile(indexUrl, "stop_times.txt");
  const header = headerOf(text);
  const stops = await getStopsMap(indexUrl);
  const rows = [];

  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line || !line.includes(tripId)) continue;
    const row = rowObject(header, line);

    if (row.trip_id === tripId) {
      const stop = stops.get(row.stop_id);
      rows.push({
        ...row,
        stop_name: stop?.name || row.stop_id,
        parent_station: stop?.parent || parentCode(row.stop_id),
        platform_code: stop?.platform || ""
      });
    }
  }

  rows.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
  CACHE.tripTimes.set(tripId, rows);
  return rows;
}

function dateKeyFor(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function serviceDateKeys(nowMs = Date.now()) {
  const now = new Date(nowMs);
  const keys = [dateKeyFor(now)];

  /* El servicio BV puede continuar después de medianoche con horas GTFS
     >=24:00. Antes de las 04:00 conservamos también el día de servicio
     anterior para no perder los últimos trenes nocturnos. */
  if (now.getHours() < 4) {
    const previous = new Date(now);
    previous.setDate(previous.getDate() - 1);
    keys.push(dateKeyFor(previous));
  }
  return keys;
}

async function activeServiceIds(indexUrl, nowMs = Date.now()) {
  const keys = serviceDateKeys(nowMs);
  const cacheKey = keys.join("+");
  if (CACHE.serviceDates.has(cacheKey)) return CACHE.serviceDates.get(cacheKey);

  /*
   * BETA 3.30.0
   * GTFS permite definir el servicio ordinario en calendar.txt y modificarlo
   * con calendar_dates.txt. Las betas anteriores consultaban únicamente
   * calendar_dates.txt: en días con alguna excepción añadida podían filtrar
   * accidentalmente TODO el servicio ordinario y dejar estaciones como
   * PC/PR/GR sin candidatos aunque hubiera trenes circulando.
   */
  const [calendarText, datesText] = await Promise.all([
    textFile(indexUrl, "calendar.txt", { optional:true }),
    textFile(indexUrl, "calendar_dates.txt", { optional:true })
  ]);

  if (!calendarText && !datesText) {
    CACHE.serviceDates.set(cacheKey, null);
    return null;
  }

  const calendarRows = [];
  if (calendarText) {
    const header = headerOf(calendarText);
    for (const line of calendarText.split(/\r?\n/).slice(1)) {
      if (!line) continue;
      const row = rowObject(header, line);
      if (row.service_id) calendarRows.push(row);
    }
  }

  const exceptionsByDate = new Map();
  if (datesText) {
    const header = headerOf(datesText);
    for (const line of datesText.split(/\r?\n/).slice(1)) {
      if (!line) continue;
      const row = rowObject(header, line);
      const key = String(row.date || "");
      if (!key || !row.service_id) continue;
      if (!exceptionsByDate.has(key)) exceptionsByDate.set(key, []);
      exceptionsByDate.get(key).push(row);
    }
  }

  const weekdayField = key => {
    const y = Number(key.slice(0,4));
    const m = Number(key.slice(4,6));
    const d = Number(key.slice(6,8));
    const day = new Date(y, m - 1, d, 12, 0, 0).getDay();
    return ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][day];
  };

  const union = new Set();
  let hasPositiveEvidence = false;

  for (const key of keys) {
    const active = new Set();

    if (calendarRows.length) {
      const weekday = weekdayField(key);
      for (const row of calendarRows) {
        const start = String(row.start_date || "00000000");
        const end = String(row.end_date || "99999999");
        if (key < start || key > end) continue;
        if (String(row[weekday] || "0") === "1") active.add(row.service_id);
      }
      hasPositiveEvidence = true;
    }

    const exceptions = exceptionsByDate.get(key) || [];
    for (const row of exceptions) {
      if (String(row.exception_type) === "1") {
        active.add(row.service_id);
        hasPositiveEvidence = true;
      } else if (String(row.exception_type) === "2") {
        active.delete(row.service_id);
      }
    }

    for (const id of active) union.add(id);
  }

  /* Si sólo existe calendar_dates y no hay ninguna entrada aplicable hoy,
     evitamos inventar que no hay servicio: null significa "no filtrar". */
  const value = hasPositiveEvidence ? union : null;
  CACHE.serviceDates.set(cacheKey, value);
  return value;
}

export async function getTripBundle(indexUrl, tripId) {
  const [trips, times] = await Promise.all([
    getTripsMap(indexUrl),
    getStopTimes(indexUrl, tripId)
  ]);

  const trip = trips.get(tripId);
  if (!trip) throw new Error("trip_id no trobat a trips.txt");
  if (!times.length) throw new Error("trip_id sense parades a stop_times.txt");

  return { trip, times };
}

export async function getStationCatalog(indexUrl) {
  const stops = await getStopsMap(indexUrl);
  const catalog = new Map();

  for (const stop of stops.values()) {
    const code = String(stop.parent || "").toUpperCase();
    if (!code) continue;
    if (!catalog.has(code)) catalog.set(code, stop.name || code);
  }

  return catalog;
}

export async function getStationDepartures(
  indexUrl,
  stationCode,
  nowMs = Date.now(),
  { fromMinutes = -5, toMinutes = 180, limit = 60 } = {}
) {
  const station = String(stationCode || "").trim().toUpperCase();
  if (!station) return [];

  const [{ stationRows, bounds }, trips, services] = await Promise.all([
    buildScheduleIndex(indexUrl),
    getTripsMap(indexUrl),
    activeServiceIds(indexUrl, nowMs)
  ]);

  const rows = stationRows.get(station) || [];
  const out = [];

  for (const row of rows) {
    const trip = trips.get(row.trip_id);
    if (!trip) continue;
    if (services && trip.service_id && !services.has(trip.service_id)) continue;

    const departure = row.departure_time || row.arrival_time;
    const targetMs = resolveGtfsTimestamp(departure, nowMs);
    if (targetMs === null) continue;
    const deltaMinutes = (targetMs - nowMs) / 60000;
    if (deltaMinutes < fromMinutes || deltaMinutes > toMinutes) continue;

    const bound = bounds.get(row.trip_id) || {};
    out.push({
      trip_id: row.trip_id,
      stop_id: row.stop_id,
      stop_sequence: row.stop_sequence,
      arrival_time: row.arrival_time,
      departure_time: row.departure_time,
      station,
      stop_name: row.stop_name,
      trip_headsign: trip.trip_headsign || "",
      route_id: trip.route_id || "",
      service_id: trip.service_id || "",
      targetMs,
      deltaMinutes,
      firstStop: bound.first ? {
        code: parentCode(bound.first),
        name: bound.first.stop_name || "",
        departure_time: bound.first.departure_time || bound.first.arrival_time || null
      } : null,
      lastStop: bound.last ? {
        code: parentCode(bound.last),
        name: bound.last.stop_name || "",
        arrival_time: bound.last.arrival_time || bound.last.departure_time || null
      } : null
    });
  }

  out.sort((a, b) => a.targetMs - b.targetMs || Number(a.stop_sequence) - Number(b.stop_sequence));
  return out.slice(0, Math.max(1, limit));
}

function parentCode(stopId) {
  if (stopId?.parent_station) return String(stopId.parent_station);
  return String(stopId?.stop_id || stopId || "").replace(/\d+$/, "");
}
