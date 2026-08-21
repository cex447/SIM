/* SIM+ Beta 3.5.1 — núcleo PUV sin dependencias externas. */

const FAMILY_BY_CODE = Object.freeze({
  "6f2":"A", "6c2":"B", "622":"L", "6a2":"D", "682":"F"
});

const LINE_BY_FAMILY = Object.freeze({
  A:"L6", B:"L7", L:"L12", D:"S1", F:"S2"
});

const CIRC_D1 = Object.freeze({
  "7e":"0", "6e":"1", "5e":"2", "4e":"3",
  "3e":"4", "2e":"5", "1e":"6", "0e":"7"
});

const CIRC_D2 = Object.freeze({
  "30":"0", "20":"1", "10":"2", "00":"3", "70":"4",
  "60":"5", "50":"6", "40":"7", "b0":"8", "a0":"9"
});

const CIRC_D3 = Object.freeze({
  "2":"0", "3":"1", "0":"2", "1":"3", "6":"4",
  "7":"5", "4":"6", "5":"7", "a":"8", "b":"9"
});

const UNIT_SERIES = Object.freeze({"5":"112","4":"113","3":"114","2":"115"});
const UNIT_D1 = Object.freeze({"02":"0","03":"1","00":"2","01":"3"});
const UNIT_D2 = Object.freeze({
  "74":"0","75":"1","76":"2","77":"3","70":"4",
  "71":"5","72":"6","73":"7","7c":"8","7d":"9"
});

function get(row, ...names) {
  for (const name of names) {
    const value = row?.[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function readPercent(row, key) {
  const raw = row?.[`ocupacio_${key}_percent`];
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function readOccupancy(row = {}) {
  return {
    mi: readPercent(row, "mi"),
    m1: readPercent(row, "m1"),
    m2: readPercent(row, "m2"),
    ri: readPercent(row, "ri")
  };
}

export function findUnitHex(row, prefix = "1f2cc") {
  const preferred = [row?.ut, row?.ud, row?.vehicle_id];
  for (const value of preferred) {
    if (typeof value === "string" && value.startsWith(prefix)) return value;
  }
  for (const value of Object.values(row || {})) {
    if (typeof value === "string" && value.startsWith(prefix)) return value;
  }
  return null;
}

export function decodeUnit(raw) {
  const s = String(raw || "");
  if (!s.startsWith("1f2cc") || s.length < 12) return null;
  const series = UNIT_SERIES[s[5]];
  const d1 = UNIT_D1[s.slice(8, 10)];
  const d2 = UNIT_D2[s.slice(10, 12)];
  return series && d1 !== undefined && d2 !== undefined
    ? `${series}.${d1}${d2}`
    : null;
}

export function decodeCirculation(id) {
  const s = String(id || "");
  if (!s.includes("|")) return null;
  const tail = s.split("|").pop();
  if (!tail || tail.length < 10) return null;
  const family = FAMILY_BY_CODE[tail.slice(0, 3)];
  const d1 = CIRC_D1[tail.slice(5, 7)];
  const d2 = CIRC_D2[tail.slice(7, 9)];
  const d3 = CIRC_D3[tail.slice(9, 10)];
  return family && d1 !== undefined && d2 !== undefined && d3 !== undefined
    ? `${family}${d1}${d2}${d3}`
    : null;
}

export function firstNextStop(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    const hit = raw.find(item => item?.parada);
    return hit ? String(hit.parada) : null;
  }
  if (typeof raw === "object") return raw.parada ? String(raw.parada) : null;
  const first = String(raw).trim().split(";")[0]?.trim();
  if (!first) return null;
  try {
    const parsed = JSON.parse(first);
    return parsed?.parada ? String(parsed.parada) : null;
  } catch {
    const match = first.match(/["']?parada["']?\s*:\s*["']?([^"',}]+)["']?/i);
    return match ? match[1].trim() : null;
  }
}

function parseOnTime(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim().toLowerCase();
  if (["true","1","yes","si","sí"].includes(s)) return true;
  if (["false","0","no"].includes(s)) return false;
  return null;
}

export function normalizeTrain(row, cfg) {
  const id = String(get(row, "id", "trip_id") || "");
  if (!id.startsWith(cfg.idPrefix)) return null;

  const circulation = decodeCirculation(id);
  if (!circulation) return null;

  const family = circulation[0];
  const line = LINE_BY_FAMILY[family];
  if (!line || !cfg.allowedLines.includes(line)) return null;

  const rawUnit = findUnitHex(row, cfg.udPrefix);
  if (!rawUnit) return null;
  const unit = decodeUnit(rawUnit);
  if (!unit || !cfg.allowedUnitSeries.includes(unit.slice(0, 3))) return null;

  const origin = get(row, "origen", "origin");
  const destination = get(row, "desti", "destino", "destination");
  const stationed = get(row, "estacionado_en", "estacionat_a", "stationed_at");
  const nextRaw = get(row, "properes_parades", "proximas_paradas", "next_stops");

  if (line === "L12") {
    const valid = new Set(["SR", "RE"]);
    if (!valid.has(String(origin || "")) || !valid.has(String(destination || ""))) {
      return null;
    }
  }

  return {
    raw: row,
    id,
    circulation,
    family,
    line,
    rawUnit,
    unit,
    origin: origin ? String(origin) : null,
    destination: destination ? String(destination) : null,
    stationed: stationed ? String(stationed) : null,
    nextRaw,
    nextStop: firstNextStop(nextRaw),
    onTime: parseOnTime(get(row, "en_hora", "on_time")),
    occupancy: readOccupancy(row),
    ascending: Number(circulation.slice(-1)) % 2 === 1
  };
}

function cacheBusted(url) {
  const u = new URL(url, window.location.href);
  u.searchParams.set("_ts", String(Date.now()));
  if (!u.searchParams.has("limit")) u.searchParams.set("limit", "100");
  return u.toString();
}

export async function fetchPositioning(url, { signal } = {}) {
  const response = await fetch(cacheBusted(url), {
    cache: "no-store",
    signal,
    headers: { Accept: "application/json" }
  });
  if (!response.ok) throw new Error(`FGC HTTP ${response.status}`);
  const json = await response.json();
  return {
    rows: Array.isArray(json.results) ? json.results : [],
    total: Number.isFinite(Number(json.total_count)) ? Number(json.total_count) : null
  };
}
