import { getTripBundle } from './gtfs.js?v=3.20.0';
import { resolveGtfsTimestamp } from './time.js?v=3.20.0';
import { parentCode } from './operations.js?v=3.20.0';
import { cachedPlatform, normalizePlatformValue } from './isic.js?v=3.20.0';

let initialized = false;
let active = false;
let routesPromise = null;
let motionPromise = null;
let stationHitPromise = null;
let motionGeometry = null;
let stationHitGeometry = null;
let animationFrame = 0;
let latestState = null;
let interactionsWired = false;
let svgLayersReady = false;
let onSelectTrainHandler = null;
let onSelectStationHandler = null;

const tripCache = new Map();
let tripLoadQueue = Promise.resolve();
const motionStates = new Map();
const markerNodes = new Map();
const stationPlatformMemory = new Map();

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAP_WIDTH = 6566.92;
const MAP_HEIGHT = 4954.34;
const TAP_MOVE_THRESHOLD = 7;
const TRAIN_FONT_SIZE = 8.35;     // referencia visual compacta aprobada (imagen D026 correcta)
const TRAIN_CODE_WIDTH = 22.5;     // placa principal más ceñida al identificador
const TRAIN_HEIGHT = 8.35;         // menos aire vertical; misma altura para el bloque +N
const TRAIN_HIT_WIDTH = 26.5;
const TRAIN_HIT_HEIGHT = 12.5;
const TRAIN_TEXT_Y = -1.82;        // compensación óptica Futura/Canal+: centra el glifo visible

const LINE_STATIONS = Object.freeze({
  L6: ['PC','PR','GR','SG','MN','BN','TT','SR'],
  L7: ['PC','PR','GR','PM','PD','EP','TB'],
  L12: ['SR','RE'],
  S1: ['PC','PR','GR','SG','MN','BN','TT','SR','PF','VL','LP','LF','VD','SC','MS','HG','RB','FN','TR','VP','EN','NA'],
  S2: ['PC','PR','GR','SG','MN','BN','TT','SR','PF','VL','LP','LF','VD','SC','VO','SJ','BT','UN','SQ','CF','PJ','CT','NO','PN']
});

const $ = selector => document.querySelector(selector);

const ctcViewport = {
  scale: 1,
  minScale: 0.08,
  maxScale: 6,
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  initialized: false,
  pointers: new Map(),
  pan: null,
  pinch: null,
  gestureMoved: false,
  hadPinch: false,
  tapTarget: null,
  resizeObserver: null
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function svgElement(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function ctcSvg() {
  return $('#ctcMapVector > svg');
}

function ctcView() {
  return $('#view-ctc');
}

function effectiveMapSize(S = latestState) {
  const cfg = S?.config?.ctc || {};
  return {
    width: Number(cfg.mapWidth || MAP_WIDTH),
    height: Number(cfg.mapHeight || MAP_HEIGHT)
  };
}

async function loadJson(url, label) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  return response.json();
}

async function loadRouteCatalog() {
  if (!routesPromise) routesPromise = loadJson('data/ctc-routes.json?v=3.20.0', 'ctc-routes.json');
  return routesPromise;
}

async function loadMotionGeometry() {
  if (!motionPromise) {
    motionPromise = loadJson('data/ctc-motion.json?v=3.20.0', 'ctc-motion.json')
      .then(value => {
        motionGeometry = value;
        return value;
      });
  }
  return motionPromise;
}

async function loadStationHitGeometry() {
  if (!stationHitPromise) {
    stationHitPromise = loadJson('data/ctc-stations.json?v=3.20.0', 'ctc-stations.json')
      .then(value => {
        stationHitGeometry = value;
        return value;
      });
  }
  return stationHitPromise;
}

function initialScale(S, view) {
  const cfg = S.config?.ctc || {};
  const portrait = window.matchMedia?.('(orientation: portrait)').matches;
  const logicalWidth = portrait
    ? Number(cfg.defaultLogicalWidthPortrait || 1250)
    : Number(cfg.defaultLogicalWidthLandscape || 2300);
  const scale = view.clientWidth / Math.max(1, logicalWidth);
  return clamp(scale, ctcViewport.minScale, ctcViewport.maxScale);
}

function clampAxis(origin, span, limit) {
  if (span >= limit) return (limit - span) / 2;
  return clamp(origin, 0, limit - span);
}

function applyCTCViewBox({ preserveCenter = false } = {}) {
  const view = ctcView();
  const svg = ctcSvg();
  if (!view || !svg || view.clientWidth <= 0 || view.clientHeight <= 0) return;

  const map = effectiveMapSize();
  const oldCenterX = ctcViewport.x + (ctcViewport.width || 0) / 2;
  const oldCenterY = ctcViewport.y + (ctcViewport.height || 0) / 2;

  const width = view.clientWidth / Math.max(0.0001, ctcViewport.scale);
  const height = view.clientHeight / Math.max(0.0001, ctcViewport.scale);

  if (preserveCenter && ctcViewport.width > 0 && ctcViewport.height > 0) {
    ctcViewport.x = oldCenterX - width / 2;
    ctcViewport.y = oldCenterY - height / 2;
  }

  ctcViewport.width = width;
  ctcViewport.height = height;
  ctcViewport.x = clampAxis(ctcViewport.x, width, map.width);
  ctcViewport.y = clampAxis(ctcViewport.y, height, map.height);

  svg.setAttribute('viewBox', `${ctcViewport.x} ${ctcViewport.y} ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  view.dataset.zoom = ctcViewport.scale.toFixed(3);
}

function focusCTCPoint(x, y, { scale = null, alignX = 0.5, alignY = 0.5 } = {}) {
  const view = ctcView();
  if (!view || view.clientWidth <= 0 || view.clientHeight <= 0) return;
  if (scale !== null) ctcViewport.scale = clamp(scale, ctcViewport.minScale, ctcViewport.maxScale);

  const width = view.clientWidth / ctcViewport.scale;
  const height = view.clientHeight / ctcViewport.scale;
  ctcViewport.width = width;
  ctcViewport.height = height;
  ctcViewport.x = Number(x) - width * alignX;
  ctcViewport.y = Number(y) - height * alignY;
  applyCTCViewBox();
}

function mapPointAtClient(clientX, clientY) {
  const view = ctcView();
  if (!view) return null;
  const rect = view.getBoundingClientRect();
  return {
    x: ctcViewport.x + (clientX - rect.left) / ctcViewport.scale,
    y: ctcViewport.y + (clientY - rect.top) / ctcViewport.scale
  };
}

function actionTarget(node) {
  let current = node instanceof Element ? node : null;
  while (current) {
    if (current.dataset?.ctcAction) return current;
    if (current === ctcSvg()) break;
    current = current.parentElement;
  }
  return null;
}

function pointerCenter() {
  const points = [...ctcViewport.pointers.values()];
  if (points.length < 2) return null;
  return {
    x: (points[0].x + points[1].x) / 2,
    y: (points[0].y + points[1].y) / 2
  };
}

function pointerDistance() {
  const points = [...ctcViewport.pointers.values()];
  if (points.length < 2) return 0;
  return Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
}

function beginPinch() {
  const center = pointerCenter();
  if (!center || ctcViewport.pointers.size < 2) return;
  const anchor = mapPointAtClient(center.x, center.y);
  if (!anchor) return;

  ctcViewport.pinch = {
    distance: Math.max(1, pointerDistance()),
    startScale: ctcViewport.scale,
    anchorMapX: anchor.x,
    anchorMapY: anchor.y
  };
  ctcViewport.pan = null;
  ctcViewport.gestureMoved = true;
  ctcViewport.hadPinch = true;
  ctcViewport.tapTarget = null;
}

function performCTCAction(target) {
  if (!target) return;
  const action = target.dataset.ctcAction;
  if (action === 'train') {
    const code = String(target.dataset.circulation || '').toUpperCase();
    if (code && onSelectTrainHandler) {
      Promise.resolve(onSelectTrainHandler(code)).catch(error => {
        console.warn('SIM+ CTC: no se pudo abrir LIT', code, error);
      });
    }
    return;
  }
  if (action === 'station') {
    const code = String(target.dataset.station || '').toUpperCase();
    if (code && onSelectStationHandler) {
      Promise.resolve(onSelectStationHandler(code)).catch(error => {
        console.warn('SIM+ CTC: no se pudo abrir iSIC', code, error);
      });
    }
  }
}

function wireCTCInteractions() {
  if (interactionsWired) return;
  const view = ctcView();
  if (!view) return;
  interactionsWired = true;

  const beginOneFingerPan = point => {
    ctcViewport.pan = {
      startX: point.x,
      startY: point.y,
      originX: ctcViewport.x,
      originY: ctcViewport.y
    };
    ctcViewport.pinch = null;
  };

  view.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    ctcViewport.pointers.set(event.pointerId, { x:event.clientX, y:event.clientY });

    if (ctcViewport.pointers.size === 1) {
      ctcViewport.gestureMoved = false;
      ctcViewport.hadPinch = false;
      ctcViewport.tapTarget = actionTarget(event.target);
      beginOneFingerPan({ x:event.clientX, y:event.clientY });
    } else if (ctcViewport.pointers.size === 2) {
      beginPinch();
    }

    try { view.setPointerCapture(event.pointerId); } catch {}
    event.preventDefault();
  }, { passive:false });

  view.addEventListener('pointermove', event => {
    if (!ctcViewport.pointers.has(event.pointerId)) return;
    ctcViewport.pointers.set(event.pointerId, { x:event.clientX, y:event.clientY });

    if (ctcViewport.pointers.size >= 2 && ctcViewport.pinch) {
      const center = pointerCenter();
      if (!center) return;
      const ratio = pointerDistance() / ctcViewport.pinch.distance;
      const nextScale = clamp(
        ctcViewport.pinch.startScale * ratio,
        ctcViewport.minScale,
        ctcViewport.maxScale
      );
      ctcViewport.scale = nextScale;

      const viewRect = view.getBoundingClientRect();
      const localX = center.x - viewRect.left;
      const localY = center.y - viewRect.top;
      ctcViewport.width = view.clientWidth / nextScale;
      ctcViewport.height = view.clientHeight / nextScale;
      ctcViewport.x = ctcViewport.pinch.anchorMapX - localX / nextScale;
      ctcViewport.y = ctcViewport.pinch.anchorMapY - localY / nextScale;
      applyCTCViewBox();
      event.preventDefault();
      return;
    }

    if (ctcViewport.pointers.size === 1 && ctcViewport.pan) {
      const dx = event.clientX - ctcViewport.pan.startX;
      const dy = event.clientY - ctcViewport.pan.startY;
      if (Math.hypot(dx, dy) > TAP_MOVE_THRESHOLD) {
        ctcViewport.gestureMoved = true;
        ctcViewport.tapTarget = null;
      }
      ctcViewport.x = ctcViewport.pan.originX - dx / ctcViewport.scale;
      ctcViewport.y = ctcViewport.pan.originY - dy / ctcViewport.scale;
      applyCTCViewBox();
      event.preventDefault();
    }
  }, { passive:false });

  const finishPointer = event => {
    const wasLast = ctcViewport.pointers.size === 1;
    ctcViewport.pointers.delete(event.pointerId);
    try { view.releasePointerCapture(event.pointerId); } catch {}

    if (wasLast && !ctcViewport.gestureMoved && !ctcViewport.hadPinch) {
      performCTCAction(ctcViewport.tapTarget);
    }

    if (ctcViewport.pointers.size === 1) {
      const remaining = [...ctcViewport.pointers.values()][0];
      beginOneFingerPan(remaining);
      ctcViewport.gestureMoved = true;
      ctcViewport.tapTarget = null;
    } else if (ctcViewport.pointers.size === 0) {
      ctcViewport.pan = null;
      ctcViewport.pinch = null;
      ctcViewport.tapTarget = null;
      ctcViewport.hadPinch = false;
    } else {
      beginPinch();
    }
  };

  view.addEventListener('pointerup', finishPointer, { passive:true });
  view.addEventListener('pointercancel', finishPointer, { passive:true });

  view.addEventListener('wheel', event => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const anchor = mapPointAtClient(event.clientX, event.clientY);
    if (!anchor) return;
    const rect = view.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const nextScale = clamp(
      ctcViewport.scale * Math.exp(-event.deltaY * 0.002),
      ctcViewport.minScale,
      ctcViewport.maxScale
    );
    ctcViewport.scale = nextScale;
    ctcViewport.width = view.clientWidth / nextScale;
    ctcViewport.height = view.clientHeight / nextScale;
    ctcViewport.x = anchor.x - localX / nextScale;
    ctcViewport.y = anchor.y - localY / nextScale;
    applyCTCViewBox();
  }, { passive:false });

  if ('ResizeObserver' in window) {
    ctcViewport.resizeObserver = new ResizeObserver(() => {
      if (view.offsetParent !== null || view.classList.contains('active')) {
        applyCTCViewBox({ preserveCenter:true });
      }
    });
    ctcViewport.resizeObserver.observe(view);
  }
}

function directionKey(train) {
  return train?.ascending ? 'asc' : 'desc';
}

function platformMemoryKey(circulation, station) {
  return `${String(circulation || '').toUpperCase()}|${String(station || '').toUpperCase()}`;
}

function clearStationPlatformMemory(circulation) {
  const prefix = `${String(circulation || '').toUpperCase()}|`;
  for (const key of [...stationPlatformMemory.keys()]) {
    if (key.startsWith(prefix)) stationPlatformMemory.delete(key);
  }
}

function platformInfoFromNumber(station, train, platform, source = 'default') {
  const code = String(station || '').toUpperCase();
  const normalized = normalizePlatformValue(platform);
  if (!code || normalized === null || !motionGeometry) return null;
  const circuit = motionGeometry?.platformCircuits?.[code]?.[String(normalized)];
  const point = circuit ? motionGeometry?.circuitPoints?.[circuit] : null;
  if (!circuit || !Array.isArray(point) || point.length < 2) return null;
  return { station:code, platform:normalized, circuit, point, source };
}

function confirmedPlatformInfo(station, train) {
  const code = String(station || '').toUpperCase();
  if (!code || !train?.id || !motionGeometry) return null;

  /* CTC no genera consultas iSIC. Reutiliza únicamente vías ya confirmadas
     por la caché compartida de PLASTIC/LIT/iSIC. */
  const staleMs = Number(latestState?.config?.isic?.staleMs || 30000);
  const cached = cachedPlatform(train.id, code, staleMs);
  const platform = normalizePlatformValue(cached?.platform);
  if (platform !== null) {
    const info = platformInfoFromNumber(code, train, platform, cached?.source || 'isic');
    if (info) {
      stationPlatformMemory.set(platformMemoryKey(train.circulation, code), {
        ...info,
        tripId:train.id,
        rememberedAt:Date.now()
      });
      return info;
    }
  }

  /* Mientras la misma circulación/trip siga viva conservamos la última vía
     realmente confirmada. Es imprescindible para que una salida desde PC4,
     por ejemplo, siga naciendo en PC4 después de dejar de estar estacionada. */
  const remembered = stationPlatformMemory.get(platformMemoryKey(train.circulation, code));
  if (
    remembered?.tripId === train.id &&
    Date.now() - Number(remembered.rememberedAt || 0) < 2 * 60 * 60 * 1000 &&
    Array.isArray(remembered.point)
  ) return remembered;

  return null;
}

function defaultPlatformInfo(station, train) {
  const code = String(station || '').toUpperCase();
  const entry = motionGeometry?.defaultPlatforms?.[code];
  if (!entry) return null;
  const value = entry[directionKey(train)];
  return platformInfoFromNumber(code, train, value, 'operational-default');
}

function platformInfo(station, train, { allowDefault = false } = {}) {
  return confirmedPlatformInfo(station, train) || (allowDefault ? defaultPlatformInfo(station, train) : null);
}

function confirmedPlatformPoint(station, train) {
  return platformInfo(station, train)?.point || null;
}

function stationPoint(station, train, { preferConfirmedPlatform = false } = {}) {
  const code = String(station || '').toUpperCase();
  const direction = directionKey(train);

  /* Una vía real conocida tiene prioridad absoluta sobre cualquier regla
     nominal. Las reglas de línea (L7/GR, L12/SR...) siguen siendo el segundo
     nivel y los puntos por sentido son únicamente el fallback. */
  if (preferConfirmedPlatform) {
    const confirmed = confirmedPlatformPoint(code, train);
    if (confirmed) return confirmed;
  }

  const override = motionGeometry?.lineStationOverrides?.[train?.line]?.[code];
  if (override) {
    const point = override[direction] || override.asc || override.desc || null;
    if (Array.isArray(point) && point.length >= 2) return point;
  }

  const entry = motionGeometry?.stations?.[code];
  if (!entry) return null;
  return entry[direction] || entry.asc || entry.desc || null;
}

function platformSegmentPath(from, to, train, state) {
  const key = `${from}>${to}|${directionKey(train)}`;
  const rule = motionGeometry?.platformSegmentPaths?.[key];
  if (!rule) return null;

  if (rule.from) {
    const platform = normalizePlatformValue(state?.fromPlatform ?? defaultPlatformInfo(from, train)?.platform);
    const path = platform !== null ? rule.from[String(platform)] : null;
    if (Array.isArray(path) && path.length >= 2) return path;
  }

  if (rule.to) {
    const platform = normalizePlatformValue(state?.toPlatform ?? defaultPlatformInfo(to, train)?.platform);
    const path = platform !== null ? rule.to[String(platform)] : null;
    if (Array.isArray(path) && path.length >= 2) return path;
  }

  return null;
}

function pathFor(from, to, train, state = null) {
  if (!from || !to || !motionGeometry) return null;
  const key = `${from}>${to}|${directionKey(train)}`;

  /* Una geometría específica de línea tiene máxima prioridad (L7/L12). */
  const linePath = motionGeometry?.linePaths?.[train?.line]?.[key];
  if (Array.isArray(linePath) && linePath.length >= 2) return linePath;

  /* Después, si conocemos la vía real de origen/destino, usamos la ruta
     completa que parte/termina exactamente sobre su circuito. */
  const platformPath = platformSegmentPath(from, to, train, state);
  if (Array.isArray(platformPath) && platformPath.length >= 2) return platformPath;

  const direct = motionGeometry?.paths?.[key];
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

  const promise = tripLoadQueue
    .then(() => getTripBundle(S.config.gtfsZipIndexUrl, train.id))
    .then(bundle => {
      tripCache.set(train.id, { state:'ready', value:bundle });
      return bundle;
    })
    .catch(error => {
      console.warn('SIM+ CTC: contexto GTFS no disponible', train.circulation, error);
      tripCache.set(train.id, { state:'failed', value:null });
      return null;
    });

  tripLoadQueue = promise.then(() => null, () => null);
  tripCache.set(train.id, { state:'pending', promise });
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

function applyPlatformInfoToStationState(state, info) {
  if (!state || !info) return state;
  state.platform = info.platform;
  state.circuit = info.circuit;
  state.platformPoint = info.point;
  state.platformSource = info.source || null;
  return state;
}

function makeStationState(train, station, nowMs, info = null) {
  const state = {
    circulation:train.circulation,
    tripId:train.id,
    line:train.line,
    mode:'station',
    station,
    from:station,
    to:null,
    startMs:nowMs,
    durationMs:null,
    train,
    updatedAt:nowMs,
    platform:null,
    circuit:null,
    platformPoint:null,
    platformSource:null
  };
  return applyPlatformInfoToStationState(state, info);
}

function makeMovingState(
  train,
  from,
  to,
  startMs,
  durationMs,
  nowMs,
  startSource = 'observed',
  { fromInfo = null, toInfo = null } = {}
) {
  return {
    circulation:train.circulation,
    tripId:train.id,
    line:train.line,
    mode:'moving',
    station:null,
    from,
    to,
    startMs,
    durationMs,
    startSource,
    train,
    updatedAt:nowMs,
    fromPlatform:fromInfo?.platform ?? null,
    fromCircuit:fromInfo?.circuit ?? null,
    toPlatform:toInfo?.platform ?? null,
    toCircuit:toInfo?.circuit ?? null
  };
}

function inferMovingStart(train, stops, from, nowMs) {
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
    const confirmed = platformInfo(station, train, { allowDefault:false });
    const inherited = previous?.mode === 'station' && previous.station === station && previous.platform !== null
      ? {
          station,
          platform:previous.platform,
          circuit:previous.circuit,
          point:previous.platformPoint,
          source:previous.platformSource || 'remembered-state'
        }
      : null;
    const next = makeStationState(train, station, nowMs, confirmed || inherited);
    if (previous && previous.mode !== 'station') next.resyncUntil = nowMs + 450;
    motionStates.set(train.circulation, next);
    return;
  }

  const to = String(train.nextStop || '').toUpperCase();
  if (!to) {
    /* Si el snapshot actual ya no confirma ni estacionamiento ni próxima
       parada, no conservamos una posición anterior. */
    motionStates.delete(train.circulation);
    clearStationPlatformMemory(train.circulation);
    const marker = markerNodes.get(train.circulation);
    if (marker) {
      marker.group.remove();
      markerNodes.delete(train.circulation);
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

    /* La vía de destino puede aparecer en la caché iSIC durante la marcha. */
    if (previous.toPlatform === null) {
      const toInfo = platformInfo(to, train, { allowDefault:true });
      if (toInfo) {
        previous.toPlatform = toInfo.platform;
        previous.toCircuit = toInfo.circuit;
      }
    }
    return;
  }

  let from = null;
  let startMs = nowMs;
  let startSource = 'unknown';
  let fromInfo = null;

  if (previous?.mode === 'station') {
    from = previous.station;
    startSource = 'departure-observed';
    fromInfo = previous.platform !== null
      ? {
          station:from,
          platform:previous.platform,
          circuit:previous.circuit,
          point:previous.platformPoint,
          source:previous.platformSource || 'station-state'
        }
      : platformInfo(from, train, { allowDefault:true });
  } else if (previous?.mode === 'moving' && previous.to && previous.to !== to) {
    from = previous.to;
    startSource = 'pass-observed';
    fromInfo = previous.toPlatform !== null
      ? platformInfoFromNumber(from, train, previous.toPlatform, 'previous-target')
      : platformInfo(from, train, { allowDefault:true });
  }

  if (!from && stops.length) from = previousScheduledStation(stops, to);
  if (!from) from = previousNetworkStation(train, to);
  if (!from) return;

  if (!fromInfo) fromInfo = platformInfo(from, train, { allowDefault:true });
  const toInfo = platformInfo(to, train, { allowDefault:true });

  const durationMs = stops.length ? segmentDurationMs(stops, from, to) : null;
  if (startSource === 'unknown' && stops.length && train.onTime === true) {
    startMs = inferMovingStart(train, stops, from, nowMs);
    startSource = 'schedule';
  }

  motionStates.set(
    train.circulation,
    makeMovingState(train, from, to, startMs, durationMs, nowMs, startSource, { fromInfo, toInfo })
  );
}

function lineColor(line) {
  return latestState?.config?.ctc?.lineColors?.[line] || '#777';
}

function ensureSvgLayers() {
  if (svgLayersReady) return;
  const svg = ctcSvg();
  if (!svg) return;

  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.style.maxWidth = 'none';
  svg.style.display = 'block';

  let stationLayer = svg.querySelector('#ctcStationHitLayer');
  if (!stationLayer) {
    stationLayer = svgElement('g', { id:'ctcStationHitLayer', class:'ctc-station-hit-layer' });
    svg.appendChild(stationLayer);
  }

  let trainLayer = svg.querySelector('#ctcTrainSvgLayer');
  if (!trainLayer) {
    trainLayer = svgElement('g', { id:'ctcTrainSvgLayer', class:'ctc-train-svg-layer' });
    svg.appendChild(trainLayer);
  }

  const legacyLayer = $('#ctcTrainLayer');
  if (legacyLayer) legacyLayer.hidden = true;

  svgLayersReady = true;
  renderStationHitboxes();
}

function renderStationHitboxes() {
  const svg = ctcSvg();
  const layer = svg?.querySelector('#ctcStationHitLayer');
  if (!layer || !stationHitGeometry?.stations) return;

  layer.replaceChildren();
  const padding = Number(stationHitGeometry.hitPadding ?? 1.25);

  for (const [code, box] of Object.entries(stationHitGeometry.stations)) {
    const x = Number(box.x) - padding;
    const y = Number(box.y) - padding;
    const width = Number(box.w) + padding * 2;
    const height = Number(box.h) + padding * 2;
    if (![x,y,width,height].every(Number.isFinite)) continue;

    const hit = svgElement('rect', {
      x,
      y,
      width,
      height,
      class:'ctc-station-hit',
      'data-ctc-action':'station',
      'data-station':code,
      'aria-label':`iSIC ${code}`
    });
    const title = svgElement('title');
    title.textContent = `iSIC ${code}`;
    hit.appendChild(title);
    layer.appendChild(hit);
  }
}

function markerFor(train) {
  let marker = markerNodes.get(train.circulation);
  if (marker) return marker;

  ensureSvgLayers();
  const layer = ctcSvg()?.querySelector('#ctcTrainSvgLayer');
  if (!layer) return null;

  const group = svgElement('g', {
    class:`ctc-train-svg ctc-line-${train.line}`,
    'data-ctc-action':'train',
    'data-circulation':train.circulation
  });

  const codeRect = svgElement('rect', {
    x:-TRAIN_CODE_WIDTH / 2,
    y:-TRAIN_HEIGHT / 2,
    width:TRAIN_CODE_WIDTH,
    height:TRAIN_HEIGHT,
    class:'ctc-train-code-bg'
  });
  const codeText = svgElement('text', {
    x:0,
    y:TRAIN_TEXT_Y,
    class:'ctc-train-code-text',
    'text-anchor':'middle',
    'dominant-baseline':'central',
    'alignment-baseline':'central'
  });
  codeText.textContent = train.circulation;

  const delayRect = svgElement('rect', {
    x:TRAIN_CODE_WIDTH / 2,
    y:-TRAIN_HEIGHT / 2,
    width:0,
    height:TRAIN_HEIGHT,
    class:'ctc-train-delay-bg',
    hidden:'hidden'
  });
  const delayText = svgElement('text', {
    x:TRAIN_CODE_WIDTH / 2,
    y:TRAIN_TEXT_Y,
    class:'ctc-train-delay-text',
    'text-anchor':'middle',
    'dominant-baseline':'central',
    'alignment-baseline':'central',
    hidden:'hidden'
  });

  const hitRect = svgElement('rect', {
    x:-TRAIN_HIT_WIDTH / 2,
    y:-TRAIN_HIT_HEIGHT / 2,
    width:TRAIN_HIT_WIDTH,
    height:TRAIN_HIT_HEIGHT,
    class:'ctc-train-hit',
    'data-ctc-action':'train',
    'data-circulation':train.circulation
  });

  group.append(codeRect, codeText, delayRect, delayText, hitRect);
  layer.appendChild(group);

  marker = { group, codeRect, codeText, delayRect, delayText, hitRect };
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

  const minutes = Math.floor(Math.max(0, nowMs - targetMs) / 60000);
  return minutes >= 1 ? minutes : null;
}

function positionForState(state, nowMs) {
  if (!state?.train) return null;
  if (state.mode === 'station') {
    const confirmed = platformInfo(state.station, state.train, { allowDefault:false });
    if (confirmed) applyPlatformInfoToStationState(state, confirmed);

    const point = Array.isArray(state.platformPoint)
      ? state.platformPoint
      : stationPoint(state.station, state.train, { preferConfirmedPlatform:true });
    return point ? { x:point[0], y:point[1], waiting:false } : null;
  }

  /* Si conocemos posteriormente la vía de destino, la incorporamos sin
     generar ninguna consulta nueva desde CTC. */
  if (state.toPlatform === null) {
    const toInfo = platformInfo(state.to, state.train, { allowDefault:true });
    if (toInfo) {
      state.toPlatform = toInfo.platform;
      state.toCircuit = toInfo.circuit;
    }
  }

  const points = pathFor(state.from, state.to, state.train, state);
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

function updateMarkerVisual(marker, train, state, position, nowMs) {
  if (!marker) return;
  const { group, codeRect, codeText, delayRect, delayText, hitRect } = marker;

  group.setAttribute('class', `ctc-train-svg ctc-line-${train.line}${position.waiting ? ' ctc-awaiting-confirmation' : ''}${Number(state.resyncUntil || 0) > nowMs ? ' ctc-resync' : ''}`);
  group.removeAttribute('transform');
  group.style.transform = `translate(${position.x}px, ${position.y}px)`;
  group.dataset.circulation = train.circulation;
  hitRect.dataset.circulation = train.circulation;

  codeRect.setAttribute('fill', lineColor(train.line));
  codeText.textContent = train.circulation;

  const minutes = delayMinutes(state, nowMs);
  if (minutes === null) {
    delayRect.setAttribute('hidden', 'hidden');
    delayText.setAttribute('hidden', 'hidden');
    delayRect.setAttribute('width', '0');
    delayText.textContent = '';
    return;
  }

  const label = `+${minutes}`;
  const delayWidth = Math.max(8, label.length * (TRAIN_FONT_SIZE * 0.54) + 3.2);
  delayRect.removeAttribute('hidden');
  delayText.removeAttribute('hidden');
  delayRect.setAttribute('x', TRAIN_CODE_WIDTH / 2);
  delayRect.setAttribute('width', delayWidth);
  delayRect.setAttribute('fill', latestState?.config?.ctc?.delayColor || '#FF2C2C');
  delayText.setAttribute('x', TRAIN_CODE_WIDTH / 2 + delayWidth / 2);
  delayText.textContent = label;
}

function renderFrame(S, nowMs = Date.now()) {
  ensureSvgLayers();
  const liveCodes = new Set((S.trains || []).map(train => train.circulation));

  for (const train of S.trains || []) {
    const state = motionStates.get(train.circulation);
    if (!state) continue;
    state.train = train;

    const position = positionForState(state, nowMs);
    if (!position) continue;

    const marker = markerFor(train);
    updateMarkerVisual(marker, train, state, position, nowMs);
  }

  for (const [code, marker] of markerNodes) {
    if (liveCodes.has(code)) continue;
    marker.group.remove();
    markerNodes.delete(code);
    motionStates.delete(code);
    clearStationPlatformMemory(code);
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

export async function initCTC(S, { onSelectTrain = null, onSelectStation = null } = {}) {
  const view = ctcView();
  const vector = $('#ctcMapVector');
  if (!view || !vector) return;

  onSelectTrainHandler = onSelectTrain || null;
  onSelectStationHandler = onSelectStation || null;

  ctcViewport.minScale = Number(view.dataset.viewportMin || 0.08);
  ctcViewport.maxScale = Number(view.dataset.viewportMax || 6);

  S.ctc ||= {
    initialized:false,
    routes:null,
    routeError:null,
    motionError:null,
    stationHitError:null
  };

  try {
    S.ctc.routes = await loadRouteCatalog();
    S.ctc.routeError = null;
  } catch (error) {
    S.ctc.routeError = String(error?.message || error);
  }

  try {
    S.ctc.motion = await loadMotionGeometry();
    S.ctc.motionError = null;
  } catch (error) {
    S.ctc.motionError = String(error?.message || error);
  }

  try {
    S.ctc.stationHits = await loadStationHitGeometry();
    S.ctc.stationHitError = null;
  } catch (error) {
    S.ctc.stationHitError = String(error?.message || error);
  }

  ensureSvgLayers();
  renderStationHitboxes();
  wireCTCInteractions();
}

export function updateCTC(S, nowMs = Date.now()) {
  latestState = S;
  if (!motionGeometry) return;

  const liveCodes = new Set();
  for (const train of S.trains || []) {
    liveCodes.add(train.circulation);

    if (active) {
      ensureTrip(S, train).then(() => {
        reconcileTrain(S, train, Date.now());
        if (active) renderFrame(S, Date.now());
      });
    }

    reconcileTrain(S, train, nowMs);
  }

  for (const code of [...motionStates.keys()]) {
    if (!liveCodes.has(code)) {
      motionStates.delete(code);
      clearStationPlatformMemory(code);
    }
  }

  if (active) {
    renderFrame(S, nowMs);
    startAnimation();
  }
}

export function enterCTC(S) {
  const view = ctcView();
  if (!view) return;
  active = true;
  latestState = S;
  ensureSvgLayers();
  wireCTCInteractions();

  requestAnimationFrame(() => {
    if (!ctcViewport.initialized) {
      const cfg = S.config?.ctc || {};
      const focus = cfg.defaultFocus || { x:820, y:2558 };
      ctcViewport.scale = initialScale(S, view);
      focusCTCPoint(Number(focus.x || 820), Number(focus.y || 2558), {
        scale:ctcViewport.scale,
        alignX:Number(focus.alignX ?? 0.19),
        alignY:Number(focus.alignY ?? 0.25)
      });
      ctcViewport.initialized = true;
      initialized = true;
      if (S.ctc) S.ctc.initialized = true;
    } else {
      applyCTCViewBox({ preserveCenter:true });
    }

    updateCTC(S);
    startAnimation();
  });
}

export function leaveCTC() {
  active = false;
  stopAnimation();
}

export function ctcDiagnostic(S) {
  const moving = [...motionStates.values()].filter(item => item.mode === 'moving').length;
  const stationed = [...motionStates.values()].filter(item => item.mode === 'station').length;
  return {
    initialized,
    routes:Array.isArray(S.ctc?.routes?.routes) ? S.ctc.routes.routes.length : 0,
    routeError:S.ctc?.routeError || null,
    motionError:S.ctc?.motionError || null,
    stationHitError:S.ctc?.stationHitError || null,
    moving,
    stationed,
    markers:markerNodes.size,
    stations:Object.keys(stationHitGeometry?.stations || {}).length,
    viewport:{
      scale:ctcViewport.scale,
      x:ctcViewport.x,
      y:ctcViewport.y,
      width:ctcViewport.width,
      height:ctcViewport.height,
      minScale:ctcViewport.minScale,
      maxScale:ctcViewport.maxScale
    }
  };
}
