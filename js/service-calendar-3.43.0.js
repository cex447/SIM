export const MODULE_VERSION = "3.43.0";

export const DEFAULT_SERVICE_DAY_CUTOVER_HOUR = 3;

function validDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

export function operationalDate(
  now = new Date(),
  cutoverHour = DEFAULT_SERVICE_DAY_CUTOVER_HOUR
) {
  const date = validDate(now);
  const hour = Math.max(0, Math.min(23, Number(cutoverHour) || 0));

  /* El día ferroviario termina a las 03:00. Usamos calendario local, no una
     resta UTC, para que los cambios de hora de marzo/octubre no desplacen la
     fecha operacional. */
  if (date.getHours() < hour) date.setDate(date.getDate() - 1);
  date.setHours(12, 0, 0, 0);
  return date;
}

export function calendarDateKey(date) {
  const value = validDate(date);
  const day = String(value.getDate()).padStart(2, "0");
  const month = String(value.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${value.getFullYear()}`;
}

export function normalizeCalendarServiceCode(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  return text.padStart(3, "0");
}

export function displayCalendarServiceCode(value) {
  const normalized = normalizeCalendarServiceCode(value);
  return normalized ? String(Number(normalized)) : "—";
}

export function serviceAssignmentKey(value, assignments) {
  const normalized = normalizeCalendarServiceCode(value);
  if (!normalized) return null;

  const services = assignments?.servicios || {};
  const exact = String(Number(normalized));
  if (Object.prototype.hasOwnProperty.call(services, exact)) return exact;

  const block = String(Math.floor(Number(normalized) / 100) * 100);
  return Object.prototype.hasOwnProperty.call(services, block) ? block : null;
}

export function serviceCalendarUrl(template, year) {
  return String(template || "data/servei-calendari-{year}.json")
    .replaceAll("{year}", String(year));
}

export function resolveOperationalService(
  calendar,
  assignments,
  now = new Date(),
  cutoverHour = DEFAULT_SERVICE_DAY_CUTOVER_HOUR
) {
  const date = operationalDate(now, cutoverHour);
  const dateKey = calendarDateKey(date);
  const rawCode = normalizeCalendarServiceCode(calendar?.services?.[dateKey]);

  return {
    date,
    dateKey,
    year:date.getFullYear(),
    rawCode,
    displayCode:displayCalendarServiceCode(rawCode),
    assignmentKey:serviceAssignmentKey(rawCode, assignments)
  };
}
