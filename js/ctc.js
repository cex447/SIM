import { focusViewportPoint, viewportState, refreshViewport } from './viewport.js?v=3.16.0';
import { getTripBundle } from './gtfs.js?v=3.16.0';
import { resolveGtfsTimestamp } from './time.js?v=3.16.0';
import { parentCode } from './operations.js?v=3.16.0';

let initialized = false;
let active = false;
let routesPromise = null;
let motionPromise = null;
let motionGeometry = null;
let animationFrame = 0;
let latestState = null;

const tripCache = new Map();
let tripLoadQueue = Promise.resolve();
const motionStates = new Map();
const markerNodes = new Map();

const LINE_STATIONS = Object.freeze({
  L6: ['PC','PR','GR','SG','MN','BN','TT','SR'],
  L7: ['PC','PR','GR','PM','PD','EP','TB'],
  L12: ['SR','RE'],
  S1: ['PC','PR','GR','SG','MN','BN','TT','SR','PF','VL','LP','LF','VD','SC','MS','HG','RB','FN','TR','VP','EN','NA'],
  S2: ['PC','PR','GR','SG','MN','BN','TT','SR','PF','VL','LP','LF','VD','SC','VO','SJ','BT','UN','SQ','CF','PJ','CT','NO','PN']
});

const $ = selector => document.querySelector(selector);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function loadJson(url, label) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  return response.json();
}

async function loadRouteCatalog() {
  if (!routesPromise) {
    routesPromise = loadJson('data/ctc-routes.json?v=3.16.0', 'ctc-routes.json');
  }
  return routesPromise;
}

async function loadMotionGeometry() {
  if (!motionPromise) {
    motionPromise = loadJson('data/ctc-motion.json?v=3.16.0', 'ctc-motion.json')
      .then(value => {
        motionGeometry = value;
        return value;
      });
  }
  return motionPromise;
}

function initialScale(S, view) {
  const cfg = S.config?.ctc || {};
  const portrait = window.matchMedia?.('(orientation: portrait)').matches;
  const logicalWidth = portrait
    ? Number(cfg.defaultLogicalWidthPortrait || 1250)
    : Number(cfg.defaultLogicalWidthLandscape || 2300);
  const scale = view.clientWidth / Math.max(1, logicalWidth);
  const min = Number(view.dataset.viewportMin || 0.08);
  const max = Number(view.dataset.viewportMax || 4);
  return Math.min(max, Math.max(min, scale));
}

function directionKey(train) {
  return train?.ascending ? 'asc' : 'desc';
}

function stationPoint(station, train) {
  const entry = motionGeometry?.stations?.[String(station || '').toUpperCase()];
  if (!entry) return null;
  return entry[directionKey(train)] || entry.asc || entry.desc || null;
}

function explicitPath(from, to, train) {
  const key = `${from}>${to}|${directionKey(train)}`;
  return motionGeometry?.paths?.[key] || null;
}

function pathFor(from, to, train) {
  if (!from || !to || !motionGeometry) return null;
  const direct = explicitPath(from, to, train);
  if (Array.isArray(direct) && direct.length >= 2) return direct;

  const a = stationPoint(from, train);
  const b = stationPoint(to, train);
  if (!a || !b) return null;
  return [a, b];
}

function pointAlongPath(points, progress) {
  if (!Array.isArray(points) || !points.length) return null;
  if (points.length === 1) return { x: points[0][0], y: points[0][1] };

  const lengths = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    const length = Math.hypot(dx, dy);
    lengths.push(length);
    total += length;
  }

  if (total <= 0) return { x: points[0][0], y: points[0][1] };
  let remaining = clamp(progress, 0, 1) * total;

  for (let i = 0; i < lengths.length; i += 1) {
    const length = lengths[i];
    if (remaining <= length || i === lengths.length - 1) {
      const ratio = length > 0 ? remaining / length : 0;
      return {
        x: points[i][0] + (points[i + 1][0] - points[i][0]) * ratio,
        y: points[i][1] + (points[i + 1][1] - points[i][1]) * ratio
      };
    }
    remaining -= length;
  }

  const last = points[points.length - 1];
  return { x: last[0], y: last[1] };
}

function parseGtfsSeconds(value) {
  const match = String(value || '').trim().match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] || 0);
}

function segmentDurationMs(stops, from, to) {
  if (!Array.isArray(stops) || !from || !to) return null;
  for (let i = 1; i < stops.length; i += 1) {
    if (parentCode(stops[i - 1]) !== from || parentCode(stops[i]) !== to) continue;
    const departure = parseGtfsSeconds(stops[i - 1].departure_time || stops[i - 1].arrival_time);
    const arrival = parseGtfsSeconds(stops[i].arrival_time || stops[i].departure_time);
    if (departure === null || arrival === null) return null;
    let seconds = arrival - departure;
    if (seconds < 0) seconds += 24 * 3600;
    if (seconds <= 0) return null;
    return seconds * 1000;
  }
  return null;
}

function previousScheduledStation(stops, target) {
  if (!Array.isArray(stops) || !target) return null;
  for (let i = 1; i < stops.length; i += 1) {
    if (parentCode(stops[i]) === target) return parentCode(stops[i - 1]);
  }
  return null;
}

function previousNetworkStation(train, target) {
  const route = LINE_STATIONS[train?.line] || [];
  const index = route.indexOf(String(target || '').toUpperCase());
  if (index < 0) return null;
  const previousIndex = train?.ascending ? index - 1 : index + 1;
  return route[previousIndex] || null;
}

function targetScheduledStop(stops, target) {
  if (!Array.isArray(stops) || !target) return null;
  return stops.find(stop => parentCode(stop) === target) || null;
}

function ensureTrip(S, train) {
  if (!train?.id) return Promise.resolve(null);
  const cached = tripCache.get(train.id);
  if (cached?.state === 'ready') return Promise.resolve(cached.value);
  if (cached?.state === 'pending') return cached.promise;
  if (cached?.state === 'failed') return Promise.resolve(null);

  /* Serializamos la primera carga de contextos: así trips/stops/stop_times se
     descargan una sola vez y las siguientes circulaciones reutilizan caché. */
  const promise = tripLoadQueue
    .then(() => getTripBundle(S.config.gtfsZipIndexUrl, train.id))
    .then(bundle => {
      tripCache.set(train.id, { state: 'ready', value: bundle });
      return bundle;
    })
    .catch(error => {
      console.warn('SIM+ CTC: context GTFS no disponible', train.circulation, error);
      tripCache.set(train.id, { state: 'failed', value: null });
      return null;
    });

  tripLoadQueue = promise.then(() => null, () => null);
  tripCache.set(train.id, { state: 'pending', promise });
  return promise;
}

function cachedTrip(train) {
  const entry = tripCache.get(train?.id);
  return entry?.state === 'ready' ? entry.value : null;
}

function scheduledDepartureMs(stops, from, nowMs) {
  const stop = targetScheduledStop(stops, from);
  const value = stop?.departure_time || stop?.arrival_time;
  return value ? resolveGtfsTimestamp(value, nowMs) : null;
}

function makeStationState(train, station, nowMs) {
  return {
    circulation: train.circulation,
    tripId: train.id,
    line: train.line,
    mode: 'station',
    station,
    from: station,
    to: null,
    startMs: nowMs,
    durationMs: null,
    train,
    updatedAt: nowMs
  };
}

function makeMovingState(train, from, to, startMs, durationMs, nowMs, startSource = 'observed') {
  return {
    circulation: train.circulation,
    tripId: train.id,
    line: train.line,
    mode: 'moving',
    station: null,
    from,
    to,
    startMs,
    durationMs,
    startSource,
    train,
    updatedAt: nowMs
  };
}

function inferMovingStart(train, stops, from, nowMs) {
  /* Si CTC observa la salida en directo, el instante del snapshot es T0.
     Al abrir CTC con un tren ya en marcha, sólo usamos el horario para
     reconstruir T0 cuando FGC lo marca en hora. Un tren retrasado arranca
     desde el primer snapshot observado para no inventar minutos de demora. */
  if (train.onTime !== true) return nowMs;
  const scheduled = scheduledDepartureMs(stops, from, nowMs);
  if (!Number.isFinite(scheduled)) return nowMs;
  const maxLookback = 20 * 60 * 1000;
  if (scheduled > nowMs || nowMs - scheduled > maxLookback) return nowMs;
  return scheduled;
}

function reconcileTrain(S, train, nowMs) {
  const previous = motionStates.get(train.circulation) || null;
  const trip = cachedTrip(train);
  const stops = trip?.times || [];

  if (train.stationed) {
    const station = String(train.stationed).toUpperCase();
    const next = makeStationState(train, station, nowMs);
    if (previous && previous.mode !== 'station') next.resyncUntil = nowMs + 450;
    motionStates.set(train.circulation, next);
    return;
  }

  const to = String(train.nextStop || '').toUpperCase();
  if (!to) {
    if (previous) {
      previous.train = train;
      previous.updatedAt = nowMs;
      previous.line = train.line;
    }
    return;
  }

  if (previous?.mode === 'moving' && previous.to === to) {
    previous.train = train;
    previous.updatedAt = nowMs;
    previous.line = train.line;
    if (!previous.durationMs && stops.length) {
      previous.durationMs = segmentDurationMs(stops, previous.from, previous.to);
    }
    if (previous.startSource === 'unknown' && stops.length && train.onTime === true) {
      previous.startMs = inferMovingStart(train, stops, previous.from, nowMs);
      previous.startSource = 'schedule';
    }
    return;
  }

  let from = null;
  let startMs = nowMs;
  let startSource = 'unknown';

  if (previous?.mode === 'station') {
    from = previous.station;
    startSource = 'departure-observed';
  } else if (previous?.mode === 'moving' && previous.to && previous.to !== to) {
    /* El cambio de properes_parades confirma que el tren ha alcanzado/pasado
       la estación que antes era objetivo, aunque no hayamos capturado un
       snapshot estacionado. */
    from = previous.to;
    startSource = 'pass-observed';
  }

  if (!from && stops.length) from = previousScheduledStation(stops, to);
  if (!from) from = previousNetworkStation(train, to);
  if (!from) return;

  const durationMs = stops.length ? segmentDurationMs(stops, from, to) : null;
  if (startSource === 'unknown' && stops.length && train.onTime === true) {
    startMs = inferMovingStart(train, stops, from, nowMs);
    startSource = 'schedule';
  }

  motionStates.set(
    train.circulation,
    makeMovingState(train, from, to, startMs, durationMs, nowMs, startSource)
  );
}

function markerFor(train) {
  let marker = markerNodes.get(train.circulation);
  if (marker) return marker;

  marker = document.createElement('div');
  marker.className = `ctc-train ctc-line-${train.line}`;
  marker.dataset.circulation = train.circulation;
  marker.innerHTML = '<span class="ctc-train-code"></span><span class="ctc-train-delay" hidden></span>';
  $('#ctcTrainLayer')?.appendChild(marker);
  markerNodes.set(train.circulation, marker);
  return marker;
}

function delayMinutes(state, nowMs) {
  const train = state?.train;
  if (train?.onTime !== false) return null;
  const trip = cachedTrip(train);
  const stops = trip?.times || [];
  const station = state.mode === 'station' ? state.station : state.to;
  const stop = targetScheduledStop(stops, station);
  if (!stop) return null;

  const reference = state.mode === 'station'
    ? (stop.departure_time || stop.arrival_time)
    : (stop.arrival_time || stop.departure_time);
  const targetMs = resolveGtfsTimestamp(reference, nowMs);
  if (!Number.isFinite(targetMs)) return null;
  return Math.max(0, Math.floor(Math.max(0, nowMs - targetMs) / 60000));
}

function positionForState(state, nowMs) {
  if (!state?.train) return null;
  if (state.mode === 'station') {
    const point = stationPoint(state.station, state.train);
    return point ? { x: point[0], y: point[1], waiting: false } : null;
  }

  const points = pathFor(state.from, state.to, state.train);
  if (!points) return null;

  let progress = 0;
  let waiting = false;
  if (Number.isFinite(state.durationMs) && state.durationMs > 0) {
    const raw = (nowMs - state.startMs) / state.durationMs;
    const hold = Number(motionGeometry?.holdProgress || 0.975);
    if (raw >= 1) {
      progress = hold;
      waiting = true;
    } else {
      progress = clamp(raw, 0, hold);
    }
  }

  const point = pointAlongPath(points, progress);
  return point ? { ...point, waiting } : null;
}

function renderFrame(S, nowMs = Date.now()) {
  const liveCodes = new Set((S.trains || []).map(train => train.circulation));

  for (const train of S.trains || []) {
    const state = motionStates.get(train.circulation);
    if (!state) continue;
    state.train = train;

    const position = positionForState(state, nowMs);
    if (!position) continue;

    const marker = markerFor(train);
    marker.className = `ctc-train ctc-line-${train.line}`;
    marker.classList.toggle('ctc-awaiting-confirmation', Boolean(position.waiting));
    marker.classList.toggle('ctc-resync', Number(state.resyncUntil || 0) > nowMs);
    marker.style.setProperty('--ctc-x', `${position.x}px`);
    marker.style.setProperty('--ctc-y', `${position.y}px`);

    const code = marker.querySelector('.ctc-train-code');
    const delay = marker.querySelector('.ctc-train-delay');
    if (code) code.textContent = train.circulation;

    const minutes = delayMinutes(state, nowMs);
    if (delay) {
      delay.hidden = minutes === null;
      delay.textContent = minutes === null ? '' : `+${minutes}`;
    }
  }

  for (const [code, marker] of markerNodes) {
    if (liveCodes.has(code)) continue;
    marker.remove();
    markerNodes.delete(code);
    motionStates.delete(code);
  }
}

function animationLoop() {
  if (!active || !latestState) {
    animationFrame = 0;
    return;
  }
  renderFrame(latestState, Date.now());
  animationFrame = requestAnimationFrame(animationLoop);
}

function startAnimation() {
  if (animationFrame || !active) return;
  animationFrame = requestAnimationFrame(animationLoop);
}

function stopAnimation() {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = 0;
}

export async function initCTC(S) {
  const view = $('#view-ctc');
  const vector = $('#ctcMapVector');
  if (!view || !vector) return;

  S.ctc ||= {
    initialized: false,
    routes: null,
    routeError: null,
    motionError: null
  };

  try {
    const [routes, geometry] = await Promise.all([
      loadRouteCatalog(),
      loadMotionGeometry()
    ]);
    S.ctc.routes = routes;
    S.ctc.motion = geometry;
    S.ctc.routeError = null;
    S.ctc.motionError = null;
  } catch (error) {
    S.ctc.motionError = String(error?.message || error);
  }
}

export function updateCTC(S, nowMs = Date.now()) {
  latestState = S;
  if (!motionGeometry) return;

  const liveCodes = new Set();
  for (const train of S.trains || []) {
    liveCodes.add(train.circulation);

    /* Mientras CTC no está visible seguimos capturando cambios reales de
       estación/próxima parada, pero no cargamos GTFS ni animamos nada. */
    if (active) {
      ensureTrip(S, train).then(() => {
        /* Reconciliamos de nuevo al llegar el GTFS para obtener duración exacta
           sin reiniciar T0 si el estado ya estaba en movimiento. */
        reconcileTrain(S, train, Date.now());
        if (active) renderFrame(S, Date.now());
      });
    }

    reconcileTrain(S, train, nowMs);
  }

  for (const code of [...motionStates.keys()]) {
    if (!liveCodes.has(code)) motionStates.delete(code);
  }

  if (active) {
    renderFrame(S, nowMs);
    startAnimation();
  }
}

export function enterCTC(S) {
  const view = $('#view-ctc');
  if (!view) return;
  active = true;
  latestState = S;
  refreshViewport(view);

  if (!initialized) {
    initialized = true;
    if (S.ctc) S.ctc.initialized = true;

    const cfg = S.config?.ctc || {};
    const focus = cfg.defaultFocus || { x: 820, y: 2558 };
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        focusViewportPoint(view, Number(focus.x || 820), Number(focus.y || 2558), {
          scale: initialScale(S, view),
          alignX: Number(focus.alignX ?? 0.36),
          alignY: Number(focus.alignY ?? 0.5)
        });
      });
    });
  }

  updateCTC(S);
  startAnimation();
}

export function leaveCTC() {
  active = false;
  stopAnimation();
}

export function ctcDiagnostic(S) {
  const state = viewportState('#view-ctc');
  const moving = [...motionStates.values()].filter(item => item.mode === 'moving').length;
  const stationed = [...motionStates.values()].filter(item => item.mode === 'station').length;
  return {
    initialized,
    routes: Array.isArray(S.ctc?.routes?.routes) ? S.ctc.routes.routes.length : 0,
    routeError: S.ctc?.routeError || null,
    motionError: S.ctc?.motionError || null,
    moving,
    stationed,
    markers: markerNodes.size,
    viewport: state
  };
}
