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
  const width = Math.max(
    layer.scrollWidth || 0,
    layer.offsetWidth || 0,
    view.clientWidth || 1
  );
  const height = Math.max(
    layer.scrollHeight || 0,
    layer.offsetHeight || 0,
    view.clientHeight || 1
  );
  return { width, height };
}

function syncGeometry(state) {
  const { view, layer, spacer } = state;
  if (!view.isConnected) return;

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
    minScale: Number(view.dataset.viewportMin || 0.60),
    maxScale: Number(view.dataset.viewportMax || 3.50),
    pointers: new Map(),
    pan: null,
    pinch: null,
    moved: false,
    suppressClick: false,
    resizeObserver: null
  };
  states.set(view, state);

  const centerOfPointers = () => {
    const points = [...state.pointers.values()];
    const rect = view.getBoundingClientRect();
    if (points.length < 2) return null;
    return {
      x: ((points[0].x + points[1].x) / 2) - rect.left,
      y: ((points[0].y + points[1].y) / 2) - rect.top
    };
  };

  const distanceOfPointers = () => {
    const points = [...state.pointers.values()];
    if (points.length < 2) return 0;
    return Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
  };

  const beginPinch = () => {
    if (state.pointers.size < 2) return;
    const center = centerOfPointers();
    if (!center) return;
    state.pinch = {
      distance: Math.max(1, distanceOfPointers()),
      startScale: state.scale,
      logicalX: (view.scrollLeft + center.x) / state.scale,
      logicalY: (view.scrollTop + center.y) / state.scale
    };
    state.pan = null;
  };

  view.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    state.moved = false;
    try { view.setPointerCapture(event.pointerId); } catch {}

    if (state.pointers.size === 1) {
      state.pan = {
        x: event.clientX,
        y: event.clientY,
        left: view.scrollLeft,
        top: view.scrollTop
      };
      state.pinch = null;
    } else if (state.pointers.size === 2) {
      beginPinch();
    }
  }, { passive: true });

  view.addEventListener('pointermove', event => {
    if (!state.pointers.has(event.pointerId)) return;
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (state.pointers.size >= 2 && state.pinch) {
      const center = centerOfPointers();
      if (!center) return;
      const ratio = distanceOfPointers() / state.pinch.distance;
      const next = clamp(state.pinch.startScale * ratio, state.minScale, state.maxScale);
      if (Math.abs(next - state.scale) > 0.001) state.moved = true;
      state.scale = next;
      syncGeometry(state);
      view.scrollLeft = state.pinch.logicalX * next - center.x;
      view.scrollTop = state.pinch.logicalY * next - center.y;
      event.preventDefault();
      return;
    }

    if (state.pointers.size === 1 && state.pan) {
      const dx = event.clientX - state.pan.x;
      const dy = event.clientY - state.pan.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) state.moved = true;
      view.scrollLeft = state.pan.left - dx;
      view.scrollTop = state.pan.top - dy;
      if (state.moved) event.preventDefault();
    }
  }, { passive: false });

  const endPointer = event => {
    state.pointers.delete(event.pointerId);
    try { view.releasePointerCapture(event.pointerId); } catch {}

    if (state.moved) {
      state.suppressClick = true;
      setTimeout(() => { state.suppressClick = false; }, 80);
    }

    if (state.pointers.size === 1) {
      const remaining = [...state.pointers.values()][0];
      state.pan = {
        x: remaining.x,
        y: remaining.y,
        left: view.scrollLeft,
        top: view.scrollTop
      };
      state.pinch = null;
    } else if (state.pointers.size === 0) {
      state.pan = null;
      state.pinch = null;
    } else {
      beginPinch();
    }
  };

  view.addEventListener('pointerup', endPointer, { passive: true });
  view.addEventListener('pointercancel', endPointer, { passive: true });

  view.addEventListener('click', event => {
    if (!state.suppressClick) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

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
  /* Inicializamos sólo la vista visible. Las ocultas se miden al entrar para
     evitar geometrías 0×0 en Safari/iOS. */
  document.querySelectorAll('.view.active').forEach(ensureWrapped);
}

export function activateViewport(viewOrSelector) {
  const view = selectorToView(viewOrSelector);
  if (!view) return null;
  const state = ensureWrapped(view);
  requestAnimationFrame(() => syncGeometry(state));
  return state;
}

export function refreshViewport(viewOrSelector) {
  const view = selectorToView(viewOrSelector);
  if (!view) return null;
  const state = ensureWrapped(view);
  syncGeometry(state);
  return state;
}

export function setViewportScale(viewOrSelector, scale, { anchorX = null, anchorY = null } = {}) {
  const view = selectorToView(viewOrSelector);
  if (!view) return null;
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
  if (!view) return;
  const state = ensureWrapped(view);
  if (scale !== null) state.scale = clamp(scale, state.minScale, state.maxScale);
  syncGeometry(state);
  view.scrollLeft = Math.max(0, x * state.scale - view.clientWidth * alignX);
  view.scrollTop = Math.max(0, y * state.scale - view.clientHeight * alignY);
}

export function resetViewport(viewOrSelector, { scale = 1 } = {}) {
  const view = selectorToView(viewOrSelector);
  if (!view) return;
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
