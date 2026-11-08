import { resolverTurnos } from "./torns-resolver.mjs";

export const MODULE_VERSION = "3.55.0";

let cachedMasterName = "";
let cachedMaster = null;

function joinUrl(baseUrl, fileName) {
  return `${String(baseUrl || "data/torns").replace(/\/$/, "")}/${encodeURIComponent(fileName)}`;
}

async function readJson(url, { optional = false } = {}) {
  const response = await fetch(url, { cache:"no-store" });
  if (optional && response.status === 404) return null;
  if (!response.ok) throw new Error(`TORNS ${url}: HTTP ${response.status}`);
  return response.json();
}

/* El máster se conserva en memoria. El índice y las capas se vuelven a leer:
   retirar el JSON de una circular revierte su efecto sin contaminar el máster. */
export async function loadTornsSources({
  baseUrl = "data/torns",
  indexFile = "indice-turnos.json",
  forceMaster = false
} = {}) {
  const index = await readJson(joinUrl(baseUrl, indexFile));
  if (!index?.master || !Array.isArray(index?.modificaciones)) {
    throw new Error("Índice TORNS no válido");
  }

  if (forceMaster || !cachedMaster || cachedMasterName !== index.master) {
    cachedMaster = await readJson(joinUrl(baseUrl, index.master));
    cachedMasterName = index.master;
  }

  const circulars = [];
  for (const fileName of index.modificaciones) {
    const circular = await readJson(joinUrl(baseUrl, fileName), { optional:true });
    if (circular) circulars.push(circular);
  }

  return { index, master:cachedMaster, circulars };
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function resolveTornsSources(sources, operationalService) {
  if (!sources?.master || !operationalService?.rawCode) return null;
  const service = Number(operationalService.rawCode);
  if (!Number.isFinite(service) || Math.floor(service / 100) > 9) return null;
  const familyKey = String(Math.floor(service / 100) * 100).padStart(3, "0");
  if (!sources.master?.servicios?.[familyKey]) return null;

  const state = resolverTurnos(sources.master, sources.circulars, {
    servicio:service,
    fecha:dateKey(operationalService.date)
  });

  const byCirculation = new Map();
  const byRawTurn = new Map();
  for (const turn of state.turnos) {
    const rawTurn = String(turn.codigo_abreviado || turn.codigo || "")
      .toUpperCase()
      .replace(/^Q/, "");
    if (!/^[A-Z0-9]{3}$/.test(rawTurn)) continue;
    byRawTurn.set(rawTurn, turn);

    for (const activity of turn.contenido || []) {
      const circulation = String(activity.circulacion || "").toUpperCase();
      if (!circulation || activity.rol !== "conductor") continue;
      if (!byCirculation.has(circulation)) byCirculation.set(circulation, []);
      byCirculation.get(circulation).push({
        rawTurn,
        fullTurn:turn.codigo,
        activity
      });
    }
  }

  state.byCirculation = byCirculation;
  state.byRawTurn = byRawTurn;
  return state;
}

/* Los minutos del paquete pertenecen al día natural de inicio del turno.
   Entre 00:00 y 02:59 seguimos en el servicio ferroviario anterior. */
export function operationalMinute(now = new Date(), cutoverHour = 3) {
  const minute = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  return now.getHours() < cutoverHour ? minute + 1440 : minute;
}

export function rawTurnFromResolved(state, circulation, now = new Date(), cutoverHour = 3) {
  const rows = state?.byCirculation?.get(String(circulation || "").toUpperCase()) || [];
  if (!rows.length) return null;
  if (rows.length === 1) return rows[0].rawTurn;

  const minute = operationalMinute(now, cutoverHour);
  /* El final es exclusivo: si un relevo entrega la circulación a las 21:37,
     desde las 21:37 corresponde ya al turno cuyo tramo empieza entonces. */
  const active = rows.find(({ activity }) =>
    minute >= Number(activity.minuto_salida) && minute < Number(activity.minuto_llegada)
  );
  if (active) return active.rawTurn;

  const distance = ({ activity }) => Math.min(
    Math.abs(minute - Number(activity.minuto_salida)),
    Math.abs(minute - Number(activity.minuto_llegada))
  );
  return [...rows].sort((a, b) => distance(a) - distance(b))[0].rawTurn;
}
