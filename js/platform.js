/*
 * SIM+ · via de sortida a PLASTIC
 *
 * La via només es mostra mentre la circulació continua estacionada a l'origen.
 * Fonts, per ordre de prioritat:
 *   1) regles operatives fixes aprovades;
 *   2) monitor públic iSIC/Geotren de l'estació d'origen.
 *
 * iSIC no mostra el número de circulació. Per això SIM+ identifica la sortida
 * combinant línia + destí i, quan hi ha més d'una coincidència possible,
 * utilitza el camp de temps restant d'iSIC únicament com a clau de matching
 * contra l'hora de sortida programada. Aquest temps NO substitueix ni modifica
 * les cronometries de SIM+.
 *
 * Si iSIC no permet obtenir una coincidència prou fiable, SIM+ no inventa cap
 * via: conserva breument l'últim valor vàlid i després deixa la cel·la buida.
 */

const platformByTrip = new Map();
const stationDocumentCache = new Map();
const VALID_LINES = new Set(["L6", "L7", "L12", "S1", "S2"]);

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

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsToken(text, token) {
  const needle = normalize(token);
  if (!needle) return false;
  return new RegExp(`(^|[^A-Z0-9])${escapeRegExp(needle)}([^A-Z0-9]|$)`).test(
    normalize(text)
  );
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

function relativeMinutesFromText(text) {
  const value = normalize(text);
  if (!value) return null;

  if (/\b(?:SORTINT|SORTIENDO|SALIENDO|DEPARTING|NOW)\b/.test(value)) {
    return 0;
  }

  if (/\b(?:MENYS|MENOS|LESS)\s+(?:D['’]?|DE\s+|THAN\s+)?1\s*MIN/.test(value)) {
    return 0;
  }

  const match = value.match(/\b(\d{1,3})\s*(?:MIN|MINS|MINUT|MINUTS|MINUTO|MINUTOS|MINUTE|MINUTES)\b/);
  return match ? Number(match[1]) : null;
}

function parseGtfsSeconds(value) {
  const parts = String(value || "").trim().split(":").map(Number);
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

function expectedMinutesUntilDeparture(value, nowMs = Date.now()) {
  const seconds = parseGtfsSeconds(value);
  if (seconds === null) return null;

  const candidates = [-1, 0, 1].map(dayOffset =>
    localMidnight(nowMs, dayOffset) + seconds * 1000
  );
  const target = candidates.reduce((best, candidate) =>
    Math.abs(candidate - nowMs) < Math.abs(best - nowMs) ? candidate : best
  );

  /* iSIC mostra minuts sencers. Per al matching ens interessa l'ordre de
     magnitud, no reproduir la seva regla exacta d'arrodoniment. */
  return Math.max(0, (target - nowMs) / 60000);
}

function normalizedDestinations(context) {
  return [
    context.headsign,
    context.destinationName,
    context.destination
  ]
    .map(normalize)
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);
}

function lineMatches(text, context) {
  const line = normalize(context.line);
  return Boolean(line && containsToken(text, line));
}

function destinationMatches(text, context) {
  const haystack = normalize(text);
  const names = normalizedDestinations(context);

  /* Els noms complets/headsign tenen prioritat sobre el codi curt d'estació,
     perquè iSIC mostra noms com "Sarrià" i no necessàriament "SR". */
  const longNames = names.filter(value => value.length >= 3);
  if (longNames.some(value => haystack.includes(value))) return true;

  const code = normalize(context.destination);
  return Boolean(code && containsToken(haystack, code));
}

function standalonePlatformFromElement(element) {
  if (!element) return null;

  for (const name of [
    "data-platform", "data-via", "data-track", "data-andana",
    "platform", "via", "track"
  ]) {
    const raw = element.getAttribute?.(name);
    const match = String(raw || "").match(/^\s*(\d{1,2})\s*$/);
    if (match) return match[1];
  }

  const labelledDescendant = element.querySelector?.(
    '[class*="via" i],[id*="via" i],[class*="platform" i],[id*="platform" i],[class*="track" i],[id*="track" i],[class*="andana" i],[id*="andana" i]'
  );

  if (labelledDescendant) {
    const match = String(labelledDescendant.textContent || "").match(/\b(\d{1,2})\b/);
    if (match) return match[1];
  }

  const labelled = platformFromText(element.textContent || "");
  if (labelled) return labelled;

  /* La pantalla iSIC real té una capçalera "Via" i a cada fila la cel·la
     conté només el número (p. ex. 2). Busquem una fulla numèrica començant
     pel final de la fila, evitant confondre-la amb "8 min". */
  const leaves = [...element.querySelectorAll?.("*") || []]
    .filter(node => node.children?.length === 0)
    .reverse();

  for (const node of leaves) {
    const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
    const match = text.match(/^(\d{1,2})$/);
    if (!match) continue;
    const value = Number(match[1]);
    if (value >= 1 && value <= 20) return match[1];
  }

  return null;
}

function candidateFromElement(element, context) {
  const text = String(element?.textContent || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 1200) return null;
  if (!lineMatches(text, context) || !destinationMatches(text, context)) return null;

  const platform = standalonePlatformFromElement(element);
  if (!platform) return null;

  return {
    platform,
    text,
    relativeMinutes: relativeMinutesFromText(text),
    length: text.length
  };
}

function tokenValue(element) {
  if (!element) return "";
  const text = String(element.textContent || "").replace(/\s+/g, " ").trim();
  if (text) return text;
  return String(
    element.getAttribute?.("alt") ||
    element.getAttribute?.("aria-label") ||
    element.getAttribute?.("title") ||
    ""
  ).replace(/\s+/g, " ").trim();
}

function leafTokens(document) {
  return [...document.querySelectorAll("body *")]
    .filter(element => element.children.length === 0)
    .map(tokenValue)
    .filter(Boolean);
}

function candidatesFromTokens(document, context) {
  const tokens = leafTokens(document);
  const out = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = normalize(tokens[index]);
    if (!VALID_LINES.has(token)) continue;
    if (token !== normalize(context.line)) continue;

    let end = Math.min(tokens.length, index + 14);
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      if (VALID_LINES.has(normalize(tokens[cursor]))) {
        end = cursor;
        break;
      }
    }

    const slice = tokens.slice(index, end);
    const text = slice.join(" ");
    if (!destinationMatches(text, context)) continue;

    let platform = platformFromText(text);
    if (!platform) {
      for (let cursor = slice.length - 1; cursor >= 1; cursor -= 1) {
        const match = String(slice[cursor]).trim().match(/^(\d{1,2})$/);
        if (!match) continue;
        const value = Number(match[1]);
        if (value >= 1 && value <= 20) {
          platform = match[1];
          break;
        }
      }
    }

    if (!platform) continue;
    out.push({
      platform,
      text,
      relativeMinutes: relativeMinutesFromText(text),
      length: text.length
    });
  }

  return out;
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  const out = [];

  for (const candidate of candidates) {
    const key = `${candidate.platform}|${normalize(candidate.text)}|${candidate.relativeMinutes ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }

  return out;
}

function chooseCandidate(candidates, context) {
  const list = uniqueCandidates(candidates);
  if (!list.length) return null;
  if (list.length === 1) return list[0].platform;

  const expected = expectedMinutesUntilDeparture(
    context.departure,
    Number(context.nowMs) || Date.now()
  );

  if (expected !== null) {
    const timed = list
      .filter(candidate => Number.isFinite(candidate.relativeMinutes))
      .map(candidate => ({
        ...candidate,
        delta: Math.abs(candidate.relativeMinutes - expected)
      }))
      .sort((a, b) => a.delta - b.delta || a.length - b.length);

    if (timed.length) {
      const best = timed[0];
      const second = timed[1];

      /* ±3 min cobreix l'arrodoniment del monitor i petites diferències entre
         l'hora programada i el compte enrere operacional. Si dues files són
         pràcticament igual d'apropades, preferim no assignar una via errònia. */
      if (best.delta <= 3 && (!second || second.delta - best.delta >= 0.75)) {
        return best.platform;
      }
    }
  }

  /* Si diverses estructures DOM representen en realitat la mateixa sortida i
     totes indiquen la mateixa via, la coincidència és segura. */
  const platforms = [...new Set(list.map(candidate => candidate.platform))];
  if (platforms.length === 1) return platforms[0];

  return null;
}

export function parseIsicPlatform(html, context) {
  const raw = String(html || "");
  if (!raw.trim()) return null;

  /* Compatibilitat amb respostes JSON/HTML que portin una clau explícita de
     via prop de la línia/destí. No pressuposem que iSIC mostri circulació. */
  const line = normalize(context.line);
  const destinations = normalizedDestinations(context).filter(value => value.length >= 3);
  if (line && destinations.length) {
    const upper = normalize(raw);
    for (const destination of destinations) {
      let offset = upper.indexOf(destination);
      while (offset >= 0) {
        const slice = raw.slice(Math.max(0, offset - 800), offset + 1200);
        if (containsToken(slice, line)) {
          const keyed = slice.match(
            /["']?(?:via|v[ií]a|platform|track|andana)["']?\s*[:=]\s*["']?(\d{1,2})\b/i
          );
          if (keyed) return keyed[1];
        }
        offset = upper.indexOf(destination, offset + destination.length);
      }
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

  const candidates = [];
  for (const element of document.querySelectorAll(selector)) {
    const candidate = candidateFromElement(element, context);
    if (candidate) candidates.push(candidate);
  }

  /* Fallback per a iSIC quan la pantalla està construïda com una graella de
     camps de text sense un contenidor de fila semàntic. */
  candidates.push(...candidatesFromTokens(document, context));

  return chooseCandidate(candidates, context);
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
      line: train.line,
      departure: context.departure,
      headsign: context.headsign,
      destinationName: context.destinationName,
      destination: train.destination,
      nowMs: Date.now()
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
