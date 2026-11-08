export const MODULE_VERSION = "3.55.0";

const cache = new Map();

function familyFor(rawCode) {
  const value = Number(rawCode);
  if (!Number.isFinite(value)) return null;
  const family = Math.floor(value / 100) * 100;
  return [0,100,200,300,400,500,800,900].includes(family) ? family : null;
}

function fileFor(family) {
  return `ciclos-material-bv07-${String(family).padStart(3, "0")}.json`;
}

function flattenCycles(data) {
  const result = [];
  for (const cycle of data?.ciclos || []) {
    const movements = (cycle.tramos || [])
      .flatMap(segment => (segment.movimientos || []).map(movement => ({
        ...movement,
        tramo:segment.tramo,
        ciclo:cycle.ciclo
      })))
      .sort((a, b) =>
        Number(a.minuto_operativo) - Number(b.minuto_operativo) ||
        Number(a.orden) - Number(b.orden)
      );
    result.push({ ...cycle, movements });
  }
  return result.sort((a, b) => a.ciclo.localeCompare(b.ciclo, "es", { numeric:true }));
}

export async function loadCyclesForService(rawCode, baseUrl = "data/cycles") {
  const family = familyFor(rawCode);
  if (family === null) return null;
  if (cache.has(family)) return cache.get(family);
  const promise = fetch(`${String(baseUrl).replace(/\/$/, "")}/${fileFor(family)}`, {
    cache:"no-store"
  }).then(async response => {
    if (!response.ok) throw new Error(`cicles ${family} HTTP ${response.status}`);
    const data = await response.json();
    if (Number(data?.servicio) !== family || !Array.isArray(data?.ciclos)) {
      throw new Error(`cicles ${family} no vàlids`);
    }
    const cycles = flattenCycles(data);
    const byCode = new Map(cycles.map(cycle => [cycle.ciclo, cycle]));
    const byCirculation = new Map(
      Object.entries(data.indice_por_circulacion || {}).map(([code, record]) => [
        code.toUpperCase(),
        String(record?.ciclo || "").toUpperCase()
      ])
    );
    return { family, data, cycles, byCode, byCirculation };
  });
  cache.set(family, promise);
  try {
    const value = await promise;
    cache.set(family, value);
    return value;
  } catch (error) {
    cache.delete(family);
    throw error;
  }
}

function storageKey(state) {
  const date = state?.operationalService?.dateKey || "unknown";
  const family = state?.cycles?.family ?? "unknown";
  return `simplus:cycle-units:${date}:${family}`;
}

export function restoreCycleUnitAssignments(state) {
  const key = storageKey(state);
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "{}");
    state.cycleUnits = new Map(Object.entries(parsed));
  } catch {
    state.cycleUnits = new Map();
  }
  return state.cycleUnits;
}

function persistCycleUnitAssignments(state) {
  try {
    localStorage.setItem(storageKey(state), JSON.stringify(Object.fromEntries(state.cycleUnits || [])));
  } catch { /* Safari privado puede impedir localStorage; la sesión sigue operativa. */ }
}

export function cycleForCirculation(state, circulation) {
  return state?.cycles?.byCirculation?.get(String(circulation || "").toUpperCase()) || "";
}

export function cycleUnit(state, cycleCode) {
  return state?.cycleUnits?.get(String(cycleCode || "").toUpperCase())?.unit || "";
}

export function observeCycleUnits(state, trains = state?.trains || []) {
  if (!state?.cycles) return false;
  if (!(state.cycleUnits instanceof Map)) restoreCycleUnitAssignments(state);
  let changed = false;
  const now = Date.now();
  for (const train of trains) {
    const cycle = cycleForCirculation(state, train?.circulation);
    const unit = String(train?.unit || "");
    if (!cycle || !unit) continue;
    const previous = state.cycleUnits.get(cycle);
    /* Una UT física no puede ocupar dos ciclos a la vez. Una observación
       nueva retira cualquier asociación anterior de esa misma unidad. */
    for (const [otherCycle, record] of state.cycleUnits) {
      if (otherCycle !== cycle && record?.unit === unit) {
        state.cycleUnits.delete(otherCycle);
        changed = true;
      }
    }
    if (previous?.unit === unit) continue;
    state.cycleUnits.set(cycle, { unit, observedAt:now, circulation:train.circulation });
    changed = true;
  }
  if (changed) persistCycleUnitAssignments(state);
  return changed;
}

export function operationalMinute(now = new Date(), cutoverHour = 3) {
  const value = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  return now.getHours() < cutoverHour ? value + 1440 : value;
}

export function cycleCurrentMovement(cycle, now = new Date(), cutoverHour = 3) {
  const movements = cycle?.movements || [];
  if (!movements.length) return null;
  const minute = operationalMinute(now, cutoverHour);
  const exact = movements.find(movement => {
    const start = Number(movement.minuto_operativo);
    const endText = movement.horario_lit?.hora_fin || movement.hora_fin;
    if (!endText) return false;
    const [h, m] = String(endText).split(":").map(Number);
    let end = h * 60 + m;
    if (end < start) end += 1440;
    return minute >= start && minute < end;
  });
  if (exact) return exact;
  return movements.find(movement => Number(movement.minuto_operativo) >= minute) || movements.at(-1);
}

export function movementTimes(movement) {
  const start = movement?.horario_lit?.hora_inicio || movement?.hora || "";
  const end = movement?.horario_lit?.hora_fin || movement?.hora_fin || "";
  return { start, end };
}
