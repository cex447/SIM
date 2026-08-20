const CACHE = {
  index: null,
  text: new Map(),
  trips: null,
  stops: null,
  tripTimes: new Map()
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
  if (CACHE.index) {
    return CACHE.index;
  }

  const separator = indexUrl.includes("?") ? "&" : "?";
  const response = await fetch(
    `${indexUrl}${separator}_ts=${Date.now()}`,
    { cache: "no-store" }
  );

  if (!response.ok) {
    throw new Error(`GTFS index HTTP ${response.status}`);
  }

  const json = await response.json();
  const index = {};

  for (const record of json.results || []) {
    const file = record.file;

    if (file?.filename && file?.url) {
      index[file.filename] = file.url;
    }
  }

  CACHE.index = index;
  return index;
}

async function textFile(indexUrl, name) {
  if (CACHE.text.has(name)) {
    return CACHE.text.get(name);
  }

  const index = await loadGtfsFileIndex(indexUrl);

  if (!index[name]) {
    throw new Error(`No existe ${name}`);
  }

  const separator = index[name].includes("?") ? "&" : "?";
  const response = await fetch(
    `${index[name]}${separator}_ts=${Date.now()}`,
    { cache: "no-store" }
  );

  if (!response.ok) {
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

    if (row.trip_id) {
      map.set(row.trip_id, row);
    }
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
        name: row.stop_name || row.stop_id,
        parent: row.parent_station || row.stop_id,
        platform: row.platform_code || ""
      });
    }
  }

  CACHE.stops = map;
  return map;
}

async function getStopTimes(indexUrl, tripId) {
  if (CACHE.tripTimes.has(tripId)) {
    return CACHE.tripTimes.get(tripId);
  }

  const text = await textFile(indexUrl, "stop_times.txt");
  const header = headerOf(text);
  const rows = [];

  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line || !line.includes(tripId)) continue;

    const row = rowObject(header, line);

    if (row.trip_id === tripId) {
      rows.push(row);
    }
  }

  rows.sort(
    (a, b) => Number(a.stop_sequence) - Number(b.stop_sequence)
  );

  CACHE.tripTimes.set(tripId, rows);
  return rows;
}

export async function getTripBundle(indexUrl, tripId) {
  const [trips, stops, times] = await Promise.all([
    getTripsMap(indexUrl),
    getStopsMap(indexUrl),
    getStopTimes(indexUrl, tripId)
  ]);

  const trip = trips.get(tripId);

  if (!trip) {
    throw new Error("trip_id no trobat a trips.txt");
  }

  if (!times.length) {
    throw new Error("trip_id sense parades a stop_times.txt");
  }

  return {
    trip,
    times: times.map(time => {
      const stop = stops.get(time.stop_id);

      return {
        ...time,
        stop_name: stop?.name || time.stop_id,
        parent_station: stop?.parent || parentCode(time.stop_id),
        platform_code: stop?.platform || ""
      };
    })
  };
}

function parentCode(stopId) {
  return String(stopId || "").replace(/\d+$/, "");
}
