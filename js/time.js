/*
 * SIM+ · utilidades temporales GTFS
 *
 * GTFS permite horas >= 24:00:00. Para una circulación ACTIVA no hace falta
 * adivinar el día de servicio con reglas de medianoche: resolvemos la
 * ocurrencia (ayer/hoy/mañana) más próxima a la hora actual.
 */

export function parseGtfsSeconds(value) {
  if (!value) return null;

  const parts = String(value).trim().split(":").map(Number);
  if (parts.length < 2 || parts.length > 3) return null;

  const [hours, minutes, seconds = 0] = parts;
  if (
    !Number.isFinite(hours) || hours < 0 ||
    !Number.isFinite(minutes) || minutes < 0 || minutes > 59 ||
    !Number.isFinite(seconds) || seconds < 0 || seconds > 59
  ) {
    return null;
  }

  return hours * 3600 + minutes * 60 + seconds;
}

function localMidnight(nowMs, dayOffset) {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  return date.getTime();
}

export function resolveGtfsTimestamp(value, nowMs = Date.now()) {
  const seconds = parseGtfsSeconds(value);
  if (seconds === null) return null;

  const candidates = [-1, 0, 1].map(dayOffset =>
    localMidnight(nowMs, dayOffset) + seconds * 1000
  );

  return candidates.reduce((best, candidate) =>
    Math.abs(candidate - nowMs) < Math.abs(best - nowMs)
      ? candidate
      : best
  );
}

export function countdownState(value, nowMs = Date.now()) {
  const targetMs = resolveGtfsTimestamp(value, nowMs);
  if (targetMs === null) return null;

  const diffMs = targetMs - nowMs;
  const overdue = diffMs < 0;
  const seconds = overdue
    ? 0
    : Math.max(0, Math.ceil(diffMs / 1000));

  return { targetMs, diffMs, overdue, seconds };
}

export function formatCountdown(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;

  /* Formato compacto genérico usado por LIT. */
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

/* PLASTIC + iSIC: hasta 58:59 se muestra m:ss.
   Desde 59:00 inclusive, h:mm:ss para evitar minutos de tres cifras y
   mantener una columna temporal compacta y legible. */
export function formatOperationalCountdown(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  if (seconds < 59 * 60) return formatCountdown(seconds);

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function formatDeparture(value) {
  if (!value) return " --:--";

  const [hours, minutes] = String(value).split(":");
  const hour = Number(hours) % 24;
  if (!Number.isFinite(hour)) return " --:--";

  return `${hour < 10 ? " " : ""}${hour}:${minutes}`;
}
