/*
 * SIM+ Beta 3.28.0 · viewport vertical nativo + cabeceras de sentido desacopladas.
 *
 * PLASTIC, iSIC, LIT y SIV:
 *   - sin zoom;
 *   - sin desplazamiento horizontal;
 *   - sólo scroll vertical nativo;
 *   - ASCENDENTS / DESCENDENTS se pintan en una capa independiente del flujo,
 *     con X y escala constantes y push-off calculado únicamente en Y.
 *
 * CTC queda excluido y conserva su motor SVG/viewBox propio.
 */

const states = new Map();

function selectorToView(viewOrSelector) {
  if (!viewOrSelector) return null;
  if (typeof viewOrSelector === "string") return document.querySelector(viewOrSelector);
  return viewOrSelector;
}

function isManagedView(view) {
  return Boolean(view && view.classList?.contains("view") && !view.classList.contains("ctc-view"));
}

function lockHorizontal(view) {
  if (view.scrollLeft !== 0) view.scrollLeft = 0;
}

function isLandscape() {
  return matchMedia("(orientation: landscape)").matches;
}

function directionParts(view) {
  if (view.id === "view-plastic") {
    return {
      asc: view.querySelector("#ascDirection > .direction-title"),
      desc: view.querySelector("#descDirection > .direction-title")
    };
  }
  if (view.id === "view-isic") {
    return {
      asc: view.querySelector("#isicAscDirection > .direction-title"),
      desc: view.querySelector("#isicDescDirection > .direction-title")
    };
  }
  return { asc:null, desc:null };
}

function contentY(el, view) {
  if (!el?.isConnected) return Number.POSITIVE_INFINITY;
  const er = el.getBoundingClientRect();
  const vr = view.getBoundingClientRect();
  return er.top - vr.top + view.scrollTop;
}

function headingGeometry(el, view) {
  if (!el?.isConnected) return null;
  const er = el.getBoundingClientRect();
  const vr = view.getBoundingClientRect();
  return {
    left: er.left - vr.left,
    width: er.width,
    height: er.height,
    y: er.top - vr.top + view.scrollTop
  };
}

function cloneHeadingContent(source, target) {
  if (!source || !target) return;
  const html = source.innerHTML;
  if (target.innerHTML !== html) target.innerHTML = html;
}

function ensureDirectionOverlay(state) {
  const { view } = state;
  const parts = directionParts(view);
  if (!parts.asc || !parts.desc) return null;

  let overlay = view.querySelector(":scope > .direction-sticky-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "direction-sticky-overlay";
    overlay.setAttribute("aria-hidden", "true");

    const asc = document.createElement("div");
    asc.className = "direction-sticky-title direction-sticky-asc";
    const desc = document.createElement("div");
    desc.className = "direction-sticky-title direction-sticky-desc";
    overlay.append(asc, desc);

    /* PLASTIC: por encima del contenido pero por debajo de los filtros.
       iSIC: al principio de la vista, sin alterar el flujo porque es absoluto. */
    view.appendChild(overlay);
  }

  state.overlay = overlay;
  state.overlayAsc = overlay.querySelector(".direction-sticky-asc");
  state.overlayDesc = overlay.querySelector(".direction-sticky-desc");
  return overlay;
}

function syncDirectionStickyTop(state) {
  const { view, plasticFilters } = state;
  const top = plasticFilters && plasticFilters.isConnected
    ? Math.max(0, plasticFilters.offsetHeight)
    : 0;
  state.stickyTop = top;
  view.style.setProperty("--direction-sticky-top", `${top}px`);
  lockHorizontal(view);
}

function hideOverlay(state) {
  if (!state.overlay) return;
  state.overlay.classList.remove("visible", "landscape");
  state.overlayAsc.hidden = true;
  state.overlayDesc.hidden = true;
}

function updateDirectionOverlay(state) {
  const { view } = state;
  if (!view.classList.contains("active")) return;
  if (!state.overlay) ensureDirectionOverlay(state);
  if (!state.overlay) return;

  const parts = directionParts(view);
  if (!parts.asc || !parts.desc) {
    hideOverlay(state);
    return;
  }

  syncDirectionStickyTop(state);
  const stickyTop = state.stickyTop || 0;
  const scrollTop = view.scrollTop;
  const ascGeo = headingGeometry(parts.asc, view);
  const descGeo = headingGeometry(parts.desc, view);
  if (!ascGeo || !descGeo) {
    hideOverlay(state);
    return;
  }

  const activationY = scrollTop + stickyTop;
  const overlay = state.overlay;
  const ascClone = state.overlayAsc;
  const descClone = state.overlayDesc;

  cloneHeadingContent(parts.asc, ascClone);
  cloneHeadingContent(parts.desc, descClone);

  const landscape = isLandscape() && !view.querySelector(".plastic-directions.no-service");
  overlay.classList.toggle("landscape", landscape);

  if (landscape) {
    /* En horizontal las dos cabeceras permanecen simultáneamente ancladas a
       la X exacta de sus columnas y nunca se recentran. */
    const show = activationY >= Math.min(ascGeo.y, descGeo.y);
    if (!show) {
      hideOverlay(state);
      return;
    }

    overlay.classList.add("visible", "landscape");
    ascClone.hidden = false;
    descClone.hidden = false;

    const baseY = scrollTop + stickyTop;
    overlay.style.transform = `translate3d(0, ${baseY}px, 0)`;

    for (const [node, geo] of [[ascClone, ascGeo],[descClone, descGeo]]) {
      node.style.left = `${geo.left}px`;
      node.style.width = `${geo.width}px`;
      node.style.transform = "none";
    }
    return;
  }

  /* Vertical: una sola cabecera activa. El relevo empieza sólo cuando la
     siguiente cabecera alcanza físicamente a la actual; el movimiento es Y-only. */
  if (activationY < ascGeo.y) {
    hideOverlay(state);
    return;
  }

  overlay.classList.add("visible");
  ascClone.hidden = true;
  descClone.hidden = true;

  const usingDesc = activationY >= descGeo.y;
  const activeSource = usingDesc ? parts.desc : parts.asc;
  const activeGeo = usingDesc ? descGeo : ascGeo;
  const activeClone = usingDesc ? descClone : ascClone;
  activeClone.hidden = false;

  let pushY = 0;
  const cloneHeight = Math.max(activeGeo.height, activeClone.getBoundingClientRect().height || 0);
  if (!usingDesc) {
    const nextScreenTop = descGeo.y - scrollTop;
    const collision = stickyTop + cloneHeight - nextScreenTop;
    if (collision > 0) pushY = -collision;
  }

  overlay.style.transform = `translate3d(0, ${scrollTop + stickyTop + pushY}px, 0)`;
  activeClone.style.left = `${activeGeo.left}px`;
  activeClone.style.width = `${activeGeo.width}px`;
  activeClone.style.transform = "none";
}

function scheduleOverlayUpdate(state) {
  if (state.overlayRaf) return;
  state.overlayRaf = requestAnimationFrame(() => {
    state.overlayRaf = 0;
    updateDirectionOverlay(state);
  });
}

function ensureVerticalOnly(view) {
  if (!isManagedView(view)) return null;
  if (states.has(view)) return states.get(view);

  const plasticFilters = view.id === "view-plastic"
    ? view.querySelector(":scope > .plastic-filters")
    : null;

  const state = {
    view,
    plasticFilters,
    stickyTop:0,
    resizeObserver:null,
    mutationObserver:null,
    overlay:null,
    overlayAsc:null,
    overlayDesc:null,
    overlayRaf:0
  };
  states.set(view, state);

  view.classList.add("vertical-only-viewport");
  view.dataset.zoom = "1.000";
  view.style.setProperty("--viewport-scale", "1");
  lockHorizontal(view);
  syncDirectionStickyTop(state);
  ensureDirectionOverlay(state);

  view.addEventListener("scroll", () => {
    lockHorizontal(view);
    scheduleOverlayUpdate(state);
  }, { passive:true });

  /* No existe zoom de contenido ni zoom de página en estas vistas. */
  for (const name of ["gesturestart", "gesturechange", "gestureend"]) {
    view.addEventListener(name, event => event.preventDefault(), { passive:false });
  }

  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(() => {
      syncDirectionStickyTop(state);
      scheduleOverlayUpdate(state);
    });
    ro.observe(view);
    if (plasticFilters) ro.observe(plasticFilters);
    const parts = directionParts(view);
    if (parts.asc) ro.observe(parts.asc);
    if (parts.desc) ro.observe(parts.desc);
    state.resizeObserver = ro;
  }

  if ("MutationObserver" in window && (view.id === "view-plastic" || view.id === "view-isic")) {
    const mo = new MutationObserver(records => {
      const externalChange = records.some(record => !state.overlay?.contains(record.target));
      if (externalChange) scheduleOverlayUpdate(state);
    });
    mo.observe(view, { subtree:true, childList:true, characterData:true, attributes:true });
    state.mutationObserver = mo;
  }

  scheduleOverlayUpdate(state);
  return state;
}

function refreshAll() {
  for (const state of states.values()) {
    syncDirectionStickyTop(state);
    scheduleOverlayUpdate(state);
  }
}

let globalListenersInstalled = false;
function installGlobalListeners() {
  if (globalListenersInstalled) return;
  globalListenersInstalled = true;
  window.addEventListener("resize", () => requestAnimationFrame(refreshAll), { passive:true });
  window.addEventListener("orientationchange", () => {
    requestAnimationFrame(() => requestAnimationFrame(refreshAll));
  }, { passive:true });
}

export function setupViewports() {
  installGlobalListeners();
  document.querySelectorAll(".view:not(.ctc-view)").forEach(ensureVerticalOnly);
}

export function activateViewport(viewOrSelector) {
  const view = selectorToView(viewOrSelector);
  const state = ensureVerticalOnly(view);
  if (!state) return null;

  /* Por decisión de producto, no se conserva el scroll vertical al volver. */
  view.scrollTop = 0;
  lockHorizontal(view);
  requestAnimationFrame(() => {
    syncDirectionStickyTop(state);
    scheduleOverlayUpdate(state);
  });
  return state;
}

export function refreshViewport(viewOrSelector) {
  const view = selectorToView(viewOrSelector);
  const state = ensureVerticalOnly(view);
  if (!state) return null;
  syncDirectionStickyTop(state);
  scheduleOverlayUpdate(state);
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
  const state = ensureVerticalOnly(view);
  view.scrollLeft = 0;
  view.scrollTop = Math.max(0, Number(y || 0) - view.clientHeight * alignY);
  scheduleOverlayUpdate(state);
}

export function resetViewport(viewOrSelector) {
  const view = selectorToView(viewOrSelector);
  if (!isManagedView(view)) return;
  const state = ensureVerticalOnly(view);
  view.scrollLeft = 0;
  view.scrollTop = 0;
  scheduleOverlayUpdate(state);
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
    engine:"vertical-only-overlay-327",
    plasticFiltersFixed:Boolean(state.plasticFilters),
    horizontalLocked:true,
    zoomEnabled:false,
    directionOverlay:Boolean(state.overlay)
  };
}
