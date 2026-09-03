export const MODULE_VERSION = "3.42.0";

/*
 * El primer carácter posterior al prefijo BV 6c4bdae codifica el tipo de
 * servicio. Es la misma tabla de dígitos ya observada en los identificadores
 * de circulación de FGC. El resultado coincide directamente con las claves
 * del catálogo de turnos: 0, 100, 200, 300, 400, 500, 800 y 900.
 */
const SERVICE_BY_CODE = Object.freeze({
  "2":"0",
  "3":"100",
  "0":"200",
  "1":"300",
  "6":"400",
  "7":"500",
  "a":"800",
  "b":"900"
});

const SERVICE_VALUES = new Set(Object.values(SERVICE_BY_CODE));
const CIRCULATION_RE = /^[ABDFL][0-9]{3}$/;
const RAW_TURN_RE = /^[A-Z0-9]{3}$/;

export const TURN_GROUP_ORDER = Object.freeze(["PC", "SR", "RB", "NA", "PN"]);
export const TURN_LETTER_ORDER = Object.freeze(["P", "S", "R", "N", "F"]);

/*
 * Los cinco grupos de TORNS están codificados por el primer carácter del
 * turno. Los turnos ordinarios usan 0–4 y los especiales la letra equivalente.
 */
const TURN_GROUP_BY_PREFIX = Object.freeze({
  "0":"PC", P:"PC",
  "1":"SR", S:"SR",
  "2":"RB", R:"RB",
  "3":"NA", N:"NA",
  "4":"PN", F:"PN"
});

const TURN_LETTER_RANK = new Map(
  TURN_LETTER_ORDER.map((letter, index) => [letter, index])
);

export function serviceTypeFromReference(reference) {
  const value = String(reference || "").trim().toLowerCase();
  if (!value) return null;

  if (SERVICE_VALUES.has(value)) return value;

  const serviceId = value.split("|")[0];
  const match = serviceId.match(/^6c4bdae([230167ab])/);
  return match ? (SERVICE_BY_CODE[match[1]] || null) : null;
}

/* El calendario anual es la autoridad. Si existe un código diario pero no
   tiene correspondencia en el catálogo (servicios especiales 6xx/7xx), se
   conserva ese código sin recurrir al identificador vivo: el resultado debe
   ser Q? hasta que se publique el cuadro especial de turnos. */
export function effectiveServiceReference(S, fallbackReference = null) {
  const operational = S?.operationalService;
  if (operational?.rawCode) {
    return operational.assignmentKey || operational.rawCode;
  }
  return fallbackReference;
}

export function rawTurnFor(assignments, circulation, serviceReference) {
  const code = String(circulation || "").trim().toUpperCase();
  if (!CIRCULATION_RE.test(code) || code[1] === "8") return null;

  const directReference = String(serviceReference || "").trim().toLowerCase();
  const service = Object.prototype.hasOwnProperty.call(
    assignments?.servicios || {},
    directReference
  )
    ? directReference
    : serviceTypeFromReference(serviceReference);
  if (!service) return null;

  const raw = String(assignments?.servicios?.[service]?.[code] || "")
    .trim()
    .toUpperCase()
    .replace(/^Q(?=[A-Z0-9]{3}$)/, "");

  return RAW_TURN_RE.test(raw) ? raw : null;
}

export function displayTurnFor(assignments, circulation, serviceReference) {
  const raw = rawTurnFor(assignments, circulation, serviceReference);
  return raw ? `Q${raw}` : "Q?";
}

export function normalizeRawTurn(value) {
  let code = String(value || "").trim().toUpperCase();
  if (code.startsWith("Q")) code = code.slice(1);
  return RAW_TURN_RE.test(code) ? code : null;
}

export function displayTurnCode(value) {
  const raw = normalizeRawTurn(value);
  return raw ? `Q${raw}` : "Q?";
}

export function turnGroupFor(value) {
  const raw = normalizeRawTurn(value);
  return raw ? (TURN_GROUP_BY_PREFIX[raw[0]] || null) : null;
}

export function turnPeriodFor(value) {
  const raw = normalizeRawTurn(value);
  if (!raw || !/[0-9]/.test(raw[2])) return null;
  return Number(raw[2]) % 2 === 1 ? "mati" : "tarda";
}

export function compareTurns(a, b) {
  const left = normalizeRawTurn(a) || "";
  const right = normalizeRawTurn(b) || "";
  const leftNumeric = /^[0-9]/.test(left);
  const rightNumeric = /^[0-9]/.test(right);

  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  if (leftNumeric) return Number(left) - Number(right);

  const prefixDiff =
    (TURN_LETTER_RANK.get(left[0]) ?? 99) -
    (TURN_LETTER_RANK.get(right[0]) ?? 99);
  if (prefixDiff) return prefixDiff;

  const suffixDiff = Number(left.slice(1)) - Number(right.slice(1));
  return suffixDiff || left.localeCompare(right, "es", { numeric:true });
}
