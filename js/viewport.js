const states = new Map();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function selectorToView(viewOrSelector) {
  if (!viewOrSelector) return null;
  if (typeof viewOrSelector === 'string') return document.querySelector(viewOrSelector);
  return viewOrSelector;
}

function naturalSize(state) {
  const { view, layer } = state;
  return {
    width: Math.max(layer.scrollWidth || 0, layer.offsetWidth || 0, view.clientWidth || 1),
    height: Math.max(layer.scrollHeight || 0, layer.offsetHeight || 0, view.clientHeight || 1)
  };
}

function syncGeometry(state) {
  const { view, layer, spacer } = state;
  if (!view.isConnected || view.clientWidth <= 0 || view.clientHeight <= 0) return;

  const size = naturalSize(state);
  spacer.style.width = `${Math.max(view.clientWidth || 1, Math.ceil(size.width * state.scale))}px`;
  spacer.style.height = `${Math.max(view.clientHeight || 1, Math.ceil(size.height * state.scale))}px`;
  layer.style.transform = `scale(${state.scale})`;
  view.dataset.zoom = state.scale.toFixed(3);
}

function ensureWrapped(view) {
  if (states.has(view)) return states.get(view);

  let spacer = view.querySelector(':scope > .zoom-spacer');
  let layer = spacer?.querySelector(':scope > .zoom-layer');

  if (!spacer || !layer) {
    const children = [...view.childNodes];
    spacer = document.createElement('div');
    spacer.className = 'zoom-spacer';
    layer = document.createElement('div');
    layer.className = 'zoom-layer';
    spacer.appendChild(layer);
    for (const child of children) layer.appendChild(child);
    view.appendChild(spacer);
  }

  const state = {
    view,
    spacer,
    layer,
    scale: 1,
    minScale: Number(view.dataset.viewportMin || 0.75),
    maxScale: Number(view.dataset.viewportMax || 2.5),
    pinch: null,
    gesture: null,
    resizeObserver: null
  };
  states.set(view, state);

  const touchDistance = touches => {
    const [a, b] = touches;
    return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
  };

  const touchCenter = touches => {
    const [a, b] = touches;
    const rect = view.getBoundingClientRect();
    return {
      x: ((a.clientX + b.clientX) / 2) - rect.left,
      y: ((a.clientY + b.clientY) / 2) - rect.top
    };
  };

  /*
   * PLASTIC / iSIC / LIT / SIV: zoom de documento estable en iOS.
   * Un dedo queda íntegramente en manos del scroll nativo de Safari.
   * En Safari usamos GestureEvent; en navegadores que no lo exponen,
   * usamos TouchEvent como fallback. Nunca ejecutamos ambos motores a la vez.
   */
  const supportsGestureEvents = 'ongesturestart' in window;

  if (supportsGestureEvents) {
    view.addEventListener('gesturestart', event => {
      const rect = view.getBoundingClientRect();
      const anchorX = Number.isFinite(event.clientX) ? event.clientX - rect.left : view.clientWidth / 2;
      const anchorY = Number.isFinite(event.clientY) ? event.clientY - rect.top : view.clientHeight / 2;
      state.gesture = {
        startScale: state.scale,
        logicalX: (view.scrollLeft + anchorX) / state.scale,
        logicalY: (view.scrollTop + anchorY) / state.scale,
        anchorX,
        anchorY
      };
      event.preventDefault();
    }, { passive: false });

    view.addEventListener('gesturechange', event => {
      if (!state.gesture) return;
      const next = clamp(state.gesture.startScale * Number(event.scale || 1), state.minScale, state.maxScale);
      state.scale = next;
      syncGeometry(state);
      view.scrollLeft = state.gesture.logicalX * next - state.gesture.anchorX;
      view.scrollTop = state.gesture.logicalY * next - state.gesture.anchorY;
      event.preventDefault();
    }, { passive: false });

    view.addEventListener('gestureend', event => {
      state.gesture = null;
      event.preventDefault();
    }, { passive: false });
  } else {
    view.addEventListener('touchstart', event => {
      if (event.touches.length !== 2) return;
      const touches = [...event.touches];
      const center = touchCenter(touches);
      state.pinch = {
        distance: Math.max(1, touchDistance(touches)),
        startScale: state.scale,
        logicalX: (view.scrollLeft + center.x) / state.scale,
        logicalY: (view.scrollTop + center.y) / state.scale
      };
      event.preventDefault();
    }, { passive: false });

    view.addEventListener('touchmove', event => {
      if (event.touches.length !== 2 || !state.pinch) return;
      const touches = [...event.touches];
      const center = touchCenter(touches);
      const ratio = touchDistance(touches) / state.pinch.distance;
      const next = clamp(state.pinch.startScale * ratio, state.minScale, state.maxScale);
      state.scale = next;
      syncGeometry(state);
      view.scrollLeft = state.pinch.logicalX * next - center.x;
      view.scrollTop = state.pinch.logicalY * next - center.y;
      event.preventDefault();
    }, { passive: false });

    const endPinch = event => {
      if (event.touches?.length < 2) state.pinch = null;
    };
    view.addEventListener('touchend', endPinch, { passive: true });
    view.addEventListener('touchcancel', endPinch, { passive: true });
  }

  view.addEventListener('wheel', event => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const rect = view.getBoundingClientRect();
    const anchorX = event.clientX - rect.left;
    const anchorY = event.clientY - rect.top;
    const logicalX = (view.scrollLeft + anchorX) / state.scale;
    const logicalY = (view.scrollTop + anchorY) / state.scale;
    const factor = Math.exp(-event.deltaY * 0.002);
    const next = clamp(state.scale * factor, state.minScale, state.maxScale);
    state.scale = next;
    syncGeometry(state);
    view.scrollLeft = logicalX * next - anchorX;
    view.scrollTop = logicalY * next - anchorY;
  }, { passive: false });

  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => {
      /* Las vistas ocultas no se miden. Al volver a ellas activateViewport()
         recalcula la geometría conservando scale/scroll propios. */
      if (view.offsetParent !== null || view.classList.contains('active')) syncGeometry(state);
    });
    ro.observe(layer);
    ro.observe(view);
    state.resizeObserver = ro;
  }

  requestAnimationFrame(() => syncGeometry(state));
  return state;
}

export function setupViewports() {
  /* Sólo se envuelve la vista visible. Las demás se inicializan al entrar,
     evitando medidas 0×0 en Safari/iOS. CTC usa su propio viewBox y nunca
     pasa por este motor. */
  document.querySelectorAll('.view.active:not(.ctc-view)').forEach(ensureWrapped);
}

export function activateViewport(viewOrSelector) {
  const view = selectorToView(viewOrSelector);
  if (!view || view.classList.contains('ctc-view')) return null;
  const state = ensureWrapped(view);
  requestAnimationFrame(() => syncGeometry(state));
  return state;
}

export function refreshViewport(viewOrSelector) {
  const view = selectorToView(viewOrSelector);
  if (!view || view.classList.contains('ctc-view')) return null;
  const state = ensureWrapped(view);
  syncGeometry(state);
  return state;
}

export function setViewportScale(viewOrSelector, scale, { anchorX = null, anchorY = null } = {}) {
  const view = selectorToView(viewOrSelector);
  if (!view || view.classList.contains('ctc-view')) return null;
  const state = ensureWrapped(view);
  const x = anchorX ?? view.clientWidth / 2;
  const y = anchorY ?? view.clientHeight / 2;
  const logicalX = (view.scrollLeft + x) / state.scale;
  const logicalY = (view.scrollTop + y) / state.scale;
  state.scale = clamp(scale, state.minScale, state.maxScale);
  syncGeometry(state);
  view.scrollLeft = logicalX * state.scale - x;
  view.scrollTop = logicalY * state.scale - y;
  return state.scale;
}

export function focusViewportPoint(viewOrSelector, x, y, { scale = null, alignX = 0.5, alignY = 0.5 } = {}) {
  const view = selectorToView(viewOrSelector);
  if (!view || view.classList.contains('ctc-view')) return;
  const state = ensureWrapped(view);
  if (scale !== null) state.scale = clamp(scale, state.minScale, state.maxScale);
  syncGeometry(state);
  view.scrollLeft = Math.max(0, x * state.scale - view.clientWidth * alignX);
  view.scrollTop = Math.max(0, y * state.scale - view.clientHeight * alignY);
}

export function resetViewport(viewOrSelector, { scale = 1 } = {}) {
  const view = selectorToView(viewOrSelector);
  if (!view || view.classList.contains('ctc-view')) return;
  const state = ensureWrapped(view);
  state.scale = clamp(scale, state.minScale, state.maxScale);
  syncGeometry(state);
  view.scrollLeft = 0;
  view.scrollTop = 0;
}

export function viewportState(viewOrSelector) {
  const view = selectorToView(viewOrSelector);
  const state = view ? states.get(view) : null;
  if (!state) return null;
  return {
    scale: state.scale,
    scrollLeft: state.view.scrollLeft,
    scrollTop: state.view.scrollTop,
    minScale: state.minScale,
    maxScale: state.maxScale
  };
}
