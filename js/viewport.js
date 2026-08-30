/*
 * SIM+ Beta 3.29.0 · saneamiento de viewport.
 *
 * PLASTIC, iSIC, LIT y SIV:
 *   - ningún zoom de aplicación;
 *   - ningún zoom nativo de página Safari;
 *   - ningún desplazamiento horizontal;
 *   - sólo scroll vertical nativo;
 *   - ASCENDENTS / DESCENDENTS son una única cabecera real sticky, sin clones.
 *
 * CTC:
 *   - el zoom nativo de Safari también se bloquea;
 *   - su propio motor táctil recibe los eventos y modifica exclusivamente
 *     el viewBox SVG, con pan X/Y y pinch internos.
 */

const states = new Map();
let globalListenersInstalled = false;

function selectorToView(viewOrSelector) {
  if (!viewOrSelector) return null;
  if (typeof viewOrSelector === "string") return document.querySelector(viewOrSelector);
  return viewOrSelector;
}

function isManagedView(view) {
  return Boolean(view && view.classList?.contains("view") && !view.classList.contains("ctc-view"));
}

function lockHorizontal(view) {
  if (view && view.scrollLeft !== 0) view.scrollLeft = 0;
}

function plasticFilterHeight(view) {
  if (view?.id !== "view-plastic") return 0;
  const filters = view.querySelector(":scope > .plastic-filters");
  if (!filters?.isConnected) return 0;
  return Math.max(0, Math.round(filters.getBoundingClientRect().height));
}

function syncStickyTop(state) {
  const top = plasticFilterHeight(state.view);
  state.stickyTop = top;
  state.view.style.setProperty("--direction-sticky-top", `${top}px`);
  lockHorizontal(state.view);
}

/*
 * Safari/iOS puede ampliar la página aunque el viewport declare
 * user-scalable=no. Por eso cancelamos el gesto nativo en document.
 *
 * IMPORTANTE: preventDefault NO detiene la propagación. Los touch events
 * siguen llegando al stage de CTC, cuyo motor procesa el pinch y el pan
 * sobre el viewBox. Lo único que anulamos es la acción nativa del navegador.
 */
function preventNativePinch(event) {
  if (event.touches && event.touches.length > 1) event.preventDefault();
}

function preventNativeGesture(event) {
  event.preventDefault();
}

function preventNonCTCWheelZoom(event) {
  if (!event.ctrlKey) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest?.("#ctcMapStage")) return;
  event.preventDefault();
}

function refreshAll() {
  for (const state of states.values()) syncStickyTop(state);
}

function installGlobalListeners() {
  if (globalListenersInstalled) return;
  globalListenersInstalled = true;

  /* index.html instala este guard antes del primer paint. Este fallback cubre
     ejecuciones del módulo fuera de index.html (tests o integraciones). */
  if (!window.__SIM_NATIVE_PINCH_GUARD__) {
    window.__SIM_NATIVE_PINCH_GUARD__ = true;
    document.addEventListener("touchstart", preventNativePinch, { passive:false, capture:true });
    document.addEventListener("touchmove", preventNativePinch, { passive:false, capture:true });
    document.addEventListener("gesturestart", preventNativeGesture, { passive:false, capture:true });
    document.addEventListener("gesturechange", preventNativeGesture, { passive:false, capture:true });
    document.addEventListener("gestureend", preventNativeGesture, { passive:false, capture:true });
  }
  document.addEventListener("wheel", preventNonCTCWheelZoom, { passive:false, capture:true });

  window.addEventListener("resize", () => requestAnimationFrame(refreshAll), { passive:true });
  window.addEventListener("orientationchange", () => {
    requestAnimationFrame(() => requestAnimationFrame(refreshAll));
  }, { passive:true });
}

function ensureVerticalOnly(view) {
  if (!isManagedView(view)) return null;
  if (states.has(view)) return states.get(view);

  const state = {
    view,
    stickyTop:0,
    resizeObserver:null
  };
  states.set(view, state);

  view.classList.add("vertical-only-viewport");
  view.dataset.zoom = "1.000";
  view.style.setProperty("--viewport-scale", "1");
  lockHorizontal(view);
  syncStickyTop(state);

  view.addEventListener("scroll", () => lockHorizontal(view), { passive:true });

  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(() => syncStickyTop(state));
    ro.observe(view);
    const filters = view.id === "view-plastic"
      ? view.querySelector(":scope > .plastic-filters")
      : null;
    if (filters) ro.observe(filters);
    state.resizeObserver = ro;
  }

  return state;
}

export function setupViewports() {
  installGlobalListeners();
  document.querySelectorAll(".view:not(.ctc-view)").forEach(ensureVerticalOnly);
}

export function activateViewport(viewOrSelector) {
  const view = selectorToView(viewOrSelector);
  const state = ensureVerticalOnly(view);
  if (!state) return null;

  /* Decisión de producto vigente: no recordar scroll entre módulos. */
  view.scrollTop = 0;
  lockHorizontal(view);
  requestAnimationFrame(() => syncStickyTop(state));
  return state;
}

export function refreshViewport(viewOrSelector) {
  const view = selectorToView(viewOrSelector);
  const state = ensureVerticalOnly(view);
  if (!state) return null;
  syncStickyTop(state);
  return state;
}

export function setViewportScale(viewOrSelector) {
  const view = selectorToView(viewOrSelector);
  if (isManagedView(view)) {
    ensureVerticalOnly(view);
    lockHorizontal(view);
  }
  return 1;
}

export function focusViewportPoint(viewOrSelector, _x, y, { alignY = 0.5 } = {}) {
  const view = selectorToView(viewOrSelector);
  if (!isManagedView(view)) return;
  ensureVerticalOnly(view);
  view.scrollLeft = 0;
  view.scrollTop = Math.max(0, Number(y || 0) - view.clientHeight * alignY);
}

export function resetViewport(viewOrSelector) {
  const view = selectorToView(viewOrSelector);
  if (!isManagedView(view)) return;
  ensureVerticalOnly(view);
  view.scrollLeft = 0;
  view.scrollTop = 0;
}

export function viewportState(viewOrSelector) {
  const view = selectorToView(viewOrSelector);
  if (!isManagedView(view)) return null;
  const state = ensureVerticalOnly(view);
  return {
    scale:1,
    scrollLeft:0,
    scrollTop:view.scrollTop,
    minScale:1,
    maxScale:1,
    engine:"vertical-only-native-sticky-329",
    plasticFiltersFixed:view.id === "view-plastic",
    horizontalLocked:true,
    nativePagePinchBlocked:true,
    zoomEnabled:false,
    stickyTop:state.stickyTop
  };
}
