/*
 * SIM+ · via de sortida a PLASTIC
 *
 * La via només es mostra mentre la circulació continua estacionada a l'origen.
 * Fonts, per ordre de prioritat:
 *   1) regles operatives fixes aprovades;
 *   2) monitor públic iSIC/Geotren de l'estació d'origen.
 *
 * Si iSIC no permet obtenir una coincidència prou fiable, SIM+ no inventa cap
 * via: conserva breument l'últim valor i després deixa la cel·la buida.
 */

const platformByTrip = new Map();
const stationDocumentCache = new Map();

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function hhmm(value) {
  const match = String(value || "").match(/(\d{1,2}):(\d{2})/);
  if (!match) return "";
  return `${String(Number(match[1]) % 24).padStart(2, "0")}:${match[2]}`;
}

function fixedPlatform(train) {
  const origin = String(train?.origin || "").toUpperCase();
  const line = String(train?.line || "").toUpperCase();

  if (origin === "TB") return { platform: "1", source: "fixed-rule" };
  if (origin === "SR" && line === "L12") {
    return { platform: "4", source: "fixed-rule" };
  }

  return null;
}

function platformFromText(text) {
  const value = String(text || "");
  const labelled = value.match(
    /\b(?:V[IÍ]A|VIA|PLATFORM|TRACK|ANDANA)\s*(?:N(?:Ú|U)M(?:ERO)?\.?\s*)?[:#-]?\s*(\d{1,2})\b/i
  );
  return labelled?.[1] || null;
}

function platformFromElement(element) {
  if (!element) return null;

  for (const name of [
    "data-platform", "data-via", "data-track", "data-andana",
    "platform", "via", "track"
  ]) {
    const raw = element.getAttribute?.(name);
    const match = String(raw || "").match(/\b(\d{1,2})\b/);
    if (match) return match[1];
  }

  const labelledDescendant = element.querySelector?.(
    '[class*="via" i],[id*="via" i],[class*="platform" i],[id*="platform" i],[class*="track" i],[id*="track" i],[class*="andana" i],[id*="andana" i]'
  );

  if (labelledDescendant) {
    const match = String(labelledDescendant.textContent || "").match(/\b(\d{1,2})\b/);
    if (match) return match[1];
  }

  return platformFromText(element.textContent || "");
}

function scoreCandidate(text, context) {
  const haystack = normalize(text);
  let score = 0;

  const circulation = normalize(context.circulation);
  const departure = hhmm(context.departure);
  const headsign = normalize(context.headsign);
  const destination = normalize(context.destination);

  if (circulation && new RegExp(`(^|[^A-Z0-9])${circulation}([^A-Z0-9]|$)`).test(haystack)) {
    score += 10;
  }

  if (departure && haystack.includes(departure)) score += 5;

  if (headsign && headsign.length >= 3 && haystack.includes(headsign)) {
    score += 4;
  }

  if (destination && new RegExp(`(^|[^A-Z0-9])${destination}([^A-Z0-9]|$)`).test(haystack)) {
    score += 1;
  }

  return score;
}

export function parseIsicPlatform(html, context) {
  const raw = String(html || "");
  if (!raw.trim()) return null;

  /* JSON/HTML embebido: si aparece la circulación, buscamos una clave de via
     únicamente en su entorno inmediato. */
  const circulation = String(context.circulation || "");
  if (circulation) {
    const upper = raw.toUpperCase();
    let offset = upper.indexOf(circulation.toUpperCase());

    while (offset >= 0) {
      const keyedSlice = raw.slice(Math.max(0, offset - 600), offset + 800);
      const keyed = keyedSlice.match(
        /["']?(?:via|v[ií]a|platform|track|andana)["']?\s*[:=]\s*["']?(\d{1,2})\b/i
      );
      if (keyed) return keyed[1];

      /* En HTML visible exigimos proximidad estrecha a la circulación para
         evitar tomar la vía de la fila vecina del monitor. */
      const labelledSlice = raw.slice(Math.max(0, offset - 220), offset + 320);
      const labelled = platformFromText(labelledSlice);
      if (labelled) return labelled;
      offset = upper.indexOf(circulation.toUpperCase(), offset + circulation.length);
    }
  }

  if (typeof DOMParser === "undefined") return null;

  const document = new DOMParser().parseFromString(raw, "text/html");
  const selector = [
    "tr", "li", "article",
    '[class*="train" i]', '[class*="tren" i]',
    '[class*="trip" i]', '[class*="sortida" i]', '[class*="departure" i]',
    '[class*="row" i]', '[class*="item" i]'
  ].join(",");

  const candidates = [...document.querySelectorAll(selector)];
  let best = null;

  for (const element of candidates) {
    const text = String(element.textContent || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 1200) continue;

    const platform = platformFromElement(element);
    if (!platform) continue;

    const score = scoreCandidate(text, context);
    if (!best || score > best.score) best = { score, platform };
  }

  /* Una coincidència per circulació és concloent; hora+destí/capçalera també
     és prou discriminant per a un monitor d'una única estació. */
  if (best && best.score >= 5) return best.platform;
  return null;
}

function stationUrl(config, station) {
  const template = String(
    config?.urlTemplate || "https://geotren.fgc.cat/isic/{station}"
  );

  return template.replace(
    "{station}",
    encodeURIComponent(String(station || "").toLowerCase())
  );
}

async function fetchStationDocument(config, station) {
  const url = stationUrl(config, station);
  const now = Date.now();
  const refreshMs = Math.max(1000, Number(config?.refreshMs) || 5000);
  const existing = stationDocumentCache.get(url);

  if (existing?.text && now < existing.expiresAt) return existing.text;
  if (existing?.promise) return existing.promise;

  const promise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(1000, Number(config?.timeoutMs) || 5000)
    );

    try {
      const separator = url.includes("?") ? "&" : "?";
      const response = await fetch(`${url}${separator}_ts=${Date.now()}`, {
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8" }
      });

      if (!response.ok) throw new Error(`iSIC HTTP ${response.status}`);
      const text = await response.text();
      stationDocumentCache.set(url, {
        text,
        expiresAt: Date.now() + refreshMs,
        promise: null
      });
      return text;
    } finally {
      clearTimeout(timeout);
    }
  })().catch(error => {
    stationDocumentCache.set(url, {
      text: existing?.text || "",
      expiresAt: 0,
      promise: null
    });
    throw error;
  });

  stationDocumentCache.set(url, {
    text: existing?.text || "",
    expiresAt: existing?.expiresAt || 0,
    promise
  });

  return promise;
}

export function cachedOriginPlatform(train) {
  const fixed = fixedPlatform(train);
  if (fixed) return fixed;

  const cached = platformByTrip.get(train?.id);
  if (!cached) return null;

  const staleMs = Math.max(5000, Number(cached.staleMs) || 30000);
  if (Date.now() - cached.updatedAt > staleMs) return null;

  return { platform: cached.platform, source: cached.source };
}

export async function resolveOriginPlatform(S, train, context = {}) {
  const fixed = fixedPlatform(train);
  if (fixed) return fixed;

  if (!train?.id || !train?.origin || S?.config?.isic?.enabled === false) {
    return null;
  }

  const cfg = S?.config?.isic || {};
  const staleMs = Math.max(5000, Number(cfg.staleMs) || 30000);
  const cached = platformByTrip.get(train.id);
  const refreshMs = Math.max(1000, Number(cfg.refreshMs) || 5000);

  if (cached && Date.now() - cached.updatedAt < refreshMs) {
    return { platform: cached.platform, source: cached.source };
  }

  try {
    const html = await fetchStationDocument(cfg, train.origin);
    const platform = parseIsicPlatform(html, {
      circulation: train.circulation,
      departure: context.departure,
      headsign: context.headsign,
      destination: train.destination
    });

    if (!platform) {
      if (cached && Date.now() - cached.updatedAt <= staleMs) {
        return { platform: cached.platform, source: cached.source };
      }
      return null;
    }

    const result = {
      platform: String(platform),
      source: "iSIC",
      updatedAt: Date.now(),
      staleMs
    };
    platformByTrip.set(train.id, result);
    return { platform: result.platform, source: result.source };
  } catch (error) {
    console.warn(
      "SIM+ PLASTIC: no s'ha pogut consultar la via iSIC",
      train.circulation,
      error
    );

    if (cached && Date.now() - cached.updatedAt <= staleMs) {
      return { platform: cached.platform, source: cached.source };
    }
    return null;
  }
}
