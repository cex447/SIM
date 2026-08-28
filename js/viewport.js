const states = new Map();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function selectorToView(viewOrSelector) {
  if (!viewOrSelector) return null;
  if (typeof viewOrSelector === "string") return document.querySelector(viewOrSelector);
  return viewOrSelector;
}

function touchDistance(touches) {
  const a = touches[0];
  const b = touches[1];
  return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
}

function touchCenter(view, touches) {
  const a = touches[0];
  const b = touches[1];
  const rect = view.getBoundingClientRect();
  return {
    x: ((a.clientX + b.clientX) / 2) - rect.left,
    y: ((a.clientY + b.clientY) / 2) - rect.top
  };
}

/*
 * BETA 3.21.0 · PLASTIC / iSIC / LIT / SIV
 *
 * Se elimina por completo la combinación transform:scale() + spacer usada en
 * 3.16–3.20. En Safari/iOS esa arquitectura separaba visualmente elementos
 * sticky del resto de la vista durante el pinch: filtros, iconos y filas podían
 * acabar en sistemas de coordenadas distintos.
 *
 * La nueva escala usa la propiedad CSS `zoom`, que participa en la maquetación.
 * Todos los elementos de una vista se escalan como un único documento y los
 * `position:sticky` continúan anclados al scroll de la propia vista.
 *
 *  - 1 dedo: scroll nativo, sin intervención de SIM+.
 *  - 2 dedos: pinch determinista con una referencia inmutable al inicio.
 *  - CTC: NO pasa por este módulo; conserva su viewBox vectorial independiente.
 */

function normalizeLegacyWrapper(view) {
  const legacySpacer = view.querySelector(":scope > .zoom-spacer");
  const legacyLayer = legacySpacer?.querySelector(":scope > .zoom-layer");
  if (!legacySpacer || !legacyLayer) return;

  const fragment = document.createDocumentFragment();
  while (legacyLayer.firstChild) fragment.appendChild(legacyLayer.firstChild);
  legacySpacer.remove();
  view.appendChild(fragment);
}

function ensureLayer(view) {
  normalizeLegacyWrapper(view);

  let layer = view.querySelector(":scope > .zoom-layer");
  if (layer) return layer;

  const children = [...view.childNodes];
  layer = document.createElement("div");
  layer.className = "zoom-layer";
  for (const child of children) layer.appendChild(child);
  view.appendChild(layer);
  return layer;
}

function applyScale(state) {
  if (!state.view.isConnected) return;
  state.layer.style.zoom = String(state.scale);
  state.layer.style.transform = "none";
  state.view.dataset.zoom = state.scale.toFixed(3);
}

function ensureWrapped(view) {
  if (states.has(view)) return states.get(view);

  const layer = ensureLayer(view);
  const state = {
    view,
    layer,
    scale:1,
    minScale:Number(view.dataset.viewportMin || 0.75),
    maxScale:Number(view.dataset.viewportMax || 2.5),
    pinch:null
  };
  states.set(view, state);
  applyScale(state);

  view.addEventListener("touchstart", event => {
    if (event.touches.length !== 2) return;
    const distance = touchDistance(event.touches);
    if (!Number.isFinite(distance) || distance < 8) return;

    const center = touchCenter(view, event.touches);
    state.pinch = {
      distance,
      startScale:state.scale,
      logicalX:(view.scrollLeft + center.x) / state.scale,
      logicalY:(view.scrollTop + center.y) / state.scale
    };
    event.preventDefault();
  }, { passive:false });

  view.addEventListener("touchmove", event => {
    if (event.touches.length !== 2 || !state.pinch) return;

    const distance = touchDistance(event.touches);
    if (!Number.isFinite(distance) || distance < 8) return;
    const ratio = distance / state.pinch.distance;
    if (!Number.isFinite(ratio) || ratio <= 0) return;

    const center = touchCenter(view, event.touches);
    const next = clamp(state.pinch.startScale * ratio, state.minScale, state.maxScale);
    state.scale = next;
    applyScale(state);

    /* Mantener bajo los dedos el mismo punto lógico durante todo el gesto. */
    view.scrollLeft = state.pinch.logicalX * next - center.x;
    view.scrollTop = state.pinch.logicalY * next - center.y;
    event.preventDefault();
  }, { passive:false });

  const finishPinch = event => {
    if (!event.touches || event.touches.length < 2) state.pinch = null;
  };
  view.addEventListener("touchend", finishPinch, { passive:true });
  view.addEventListener("touchcancel", finishPinch, { passive:true });

  /* Safari puede emitir GestureEvent paralelamente. Se anula para que no haya
     un segundo motor de escala actuando sobre la misma vista. */
  for (const name of ["gesturestart", "gesturechange", "gestureend"]) {
    view.addEventListener(name, event => event.preventDefault(), { passive:false });
  }

  view.addEventListener("wheel", event => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();

    const rect = view.getBoundingClientRect();
    const anchorX = event.clientX - rect.left;
    const anchorY = event.clientY - rect.top;
    const logicalX = (view.scrollLeft + anchorX) / state.scale;
    const logicalY = (view.scrollTop + anchorY) / state.scale;
    const factor = Math.exp(-event.deltaY * 0.002);

    state.scale = clamp(state.scale * factor, state.minScale, state.maxScale);
    applyScale(state);
    view.scrollLeft = logicalX * state.scale - anchorX;
    view.scrollTop = logicalY * state.scale - anchorY;
  }, { passive:false });

  return state;
}

export function setupViewports() {
  /* Las vistas ocultas se inicializan sólo al entrar. CTC usa viewBox propio. */
  document.querySelectorAll(".view.active:not(.ctc-view)").forEach(ensureWrapped);
}

export function activateViewport(viewOrSelector) {
  const view = selectorToView(viewOrSelector);
  if (!view || view.classList.contains("ctc-view")) return null;
  const state = ensureWrapped(view);
  applyScale(state);
  return state;
}

export function refreshViewport(viewOrSelector) {
  const view = selectorToView(viewOrSelector);
  if (!view || view.classList.contains("ctc-view")) return null;
  const state = ensureWrapped(view);
  applyScale(state);
  return state;
}

export function setViewportScale(viewOrSelector, scale, { anchorX = null, anchorY = null } = {}) {
  const view = selectorToView(viewOrSelector);
  if (!view || view.classList.contains("ctc-view")) return null;
  const state = ensureWrapped(view);
  const x = anchorX ?? view.clientWidth / 2;
  const y = anchorY ?? view.clientHeight / 2;
  const logicalX = (view.scrollLeft + x) / state.scale;
  const logicalY = (view.scrollTop + y) / state.scale;
  state.scale = clamp(scale, state.minScale, state.maxScale);
  applyScale(state);
  view.scrollLeft = logicalX * state.scale - x;
  view.scrollTop = logicalY * state.scale - y;
  return state.scale;
}

export function focusViewportPoint(viewOrSelector, x, y, { scale = null, alignX = 0.5, alignY = 0.5 } = {}) {
  const view = selectorToView(viewOrSelector);
  if (!view || view.classList.contains("ctc-view")) return;
  const state = ensureWrapped(view);
  if (scale !== null) state.scale = clamp(scale, state.minScale, state.maxScale);
  applyScale(state);
  view.scrollLeft = Math.max(0, x * state.scale - view.clientWidth * alignX);
  view.scrollTop = Math.max(0, y * state.scale - view.clientHeight * alignY);
}

export function resetViewport(viewOrSelector, { scale = 1 } = {}) {
  const view = selectorToView(viewOrSelector);
  if (!view || view.classList.contains("ctc-view")) return;
  const state = ensureWrapped(view);
  state.scale = clamp(scale, state.minScale, state.maxScale);
  applyScale(state);
  view.scrollLeft = 0;
  view.scrollTop = 0;
}

export function viewportState(viewOrSelector) {
  const view = selectorToView(viewOrSelector);
  const state = view ? states.get(view) : null;
  if (!state) return null;
  return {
    scale:state.scale,
    scrollLeft:state.view.scrollLeft,
    scrollTop:state.view.scrollTop,
    minScale:state.minScale,
    maxScale:state.maxScale,
    engine:"css-zoom"
  };
}
