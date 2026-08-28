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
    x:((a.clientX + b.clientX) / 2) - rect.left,
    y:((a.clientY + b.clientY) / 2) - rect.top
  };
}

function isLandscape() {
  if (window.matchMedia) return window.matchMedia("(orientation: landscape)").matches;
  return window.innerWidth > window.innerHeight;
}

function numericData(view, name, fallback) {
  const value = Number(view.dataset[name]);
  return Number.isFinite(value) ? value : fallback;
}

function minimumScale(view) {
  const orientationSpecific = isLandscape()
    ? numericData(view, "viewportMinLandscape", NaN)
    : numericData(view, "viewportMinPortrait", NaN);
  if (Number.isFinite(orientationSpecific)) return orientationSpecific;
  return numericData(view, "viewportMin", 0.70);
}

function maximumScale(view) {
  return numericData(view, "viewportMax", 2.75);
}

/*
 * BETA 3.23.0 · PLASTIC / iSIC / LIT / SIV
 *
 * Referencia funcional: vídeo de las primeras betas aportado por el usuario.
 * La composición zoomable es un ÚNICO plano rígido: no hay reflow durante el
 * pinch. CTC conserva su motor vectorial independiente por viewBox.
 *
 * PLASTIC tiene una excepción deliberada: los selectores de línea y UT quedan
 * fuera del plano zoomable. Mantienen siempre el mismo tamaño y posición y
 * permanecen sticky durante el scroll. El listado sí se escala como un bloque.
 *
 * PLASTIC e iSIC añaden encabezados de sentido sticky con relevo "push-off":
 * ASCENDENTS permanece visible mientras se recorre ese bloque y DESCENDENTS lo
 * desplaza al llegar a la primera circulación descendente. En horizontal se
 * mantienen simultáneamente los dos encabezados sobre sus columnas.
 */

function normalizeWrapper(view) {
  const fixedPlasticFilters = view.id === "view-plastic"
    ? view.querySelector(":scope > .plastic-filters")
    : null;

  const existingSpacer = view.querySelector(":scope > .zoom-spacer");
  const existingLayer = existingSpacer?.querySelector(":scope > .zoom-layer");
  if (existingSpacer && existingLayer) {
    return { spacer:existingSpacer, layer:existingLayer, fixedPlasticFilters };
  }

  const directLayer = view.querySelector(":scope > .zoom-layer");
  if (directLayer) {
    const spacer = document.createElement("div");
    spacer.className = "zoom-spacer";
    view.insertBefore(spacer, directLayer);
    spacer.appendChild(directLayer);
    return { spacer, layer:directLayer, fixedPlasticFilters };
  }

  const movableChildren = [...view.childNodes].filter(node => node !== fixedPlasticFilters);
  const spacer = document.createElement("div");
  spacer.className = "zoom-spacer";
  const layer = document.createElement("div");
  layer.className = "zoom-layer";
  spacer.appendChild(layer);

  if (fixedPlasticFilters) {
    fixedPlasticFilters.insertAdjacentElement("afterend", spacer);
  } else {
    view.appendChild(spacer);
  }

  for (const child of movableChildren) layer.appendChild(child);
  return { spacer, layer, fixedPlasticFilters };
}

function viewContentBox(view) {
  const style = getComputedStyle(view);
  const px = value => Number.parseFloat(value) || 0;
  return {
    width:Math.max(1, view.clientWidth - px(style.paddingLeft) - px(style.paddingRight)),
    height:Math.max(1, view.clientHeight - px(style.paddingTop) - px(style.paddingBottom))
  };
}

function logicalNaturalSize(state) {
  const { view, layer } = state;
  const box = viewContentBox(view);

  /* El layer conserva la anchura lógica de la vista SIN escala. */
  layer.style.width = `${box.width}px`;
  layer.style.minWidth = `${box.width}px`;
  layer.style.minHeight = `${box.height}px`;

  const width = Math.max(layer.scrollWidth, layer.offsetWidth, box.width);
  const height = Math.max(layer.scrollHeight, layer.offsetHeight, box.height);
  return { width, height };
}

function layerOrigin(state) {
  return {
    x:Number(state.spacer.offsetLeft || 0),
    y:Number(state.spacer.offsetTop || 0)
  };
}

function ensureDirectionOverlay(state) {
  if (!state.directional || state.directionOverlay?.isConnected) return;

  const host = document.createElement("div");
  host.className = "viewport-direction-overlay";
  host.setAttribute("aria-hidden", "true");

  const first = document.createElement("div");
  first.className = "direction-title viewport-sticky-title";
  const second = document.createElement("div");
  second.className = "direction-title viewport-sticky-title";
  second.hidden = true;

  host.append(first, second);
  state.view.insertBefore(host, state.spacer);
  state.directionOverlay = host;
  state.directionOverlayFirst = first;
  state.directionOverlaySecond = second;
}

function fixedTopPx(state) {
  if (!state.fixedPlasticFilters) return 0;
  const viewRect = state.view.getBoundingClientRect();
  const filterRect = state.fixedPlasticFilters.getBoundingClientRect();
  if (filterRect.bottom <= viewRect.top || filterRect.top >= viewRect.bottom) return 0;
  return Math.max(0, filterRect.bottom - viewRect.top);
}

function copyTitleContent(target, source) {
  if (!target || !source) return;
  /* Evitamos clonar IDs para no crear duplicidades DOM. */
  target.replaceChildren();
  for (const child of [...source.childNodes]) {
    const clone = child.cloneNode(true);
    if (clone.nodeType === Node.ELEMENT_NODE) {
      clone.removeAttribute?.("id");
      clone.querySelectorAll?.("[id]").forEach(node => node.removeAttribute("id"));
    }
    target.appendChild(clone);
  }
}

function hideDirectionOverlay(state) {
  if (!state.directionOverlay) return;
  state.directionOverlay.classList.remove("visible", "landscape");
  state.directionOverlayFirst.hidden = true;
  state.directionOverlaySecond.hidden = true;
}

function syncDirectionOverlay(state) {
  if (!state.directional) return;
  ensureDirectionOverlay(state);

  const view = state.view;
  const host = state.directionOverlay;
  const ascTitle = state.layer.querySelector(".plastic-direction:first-child > .direction-title");
  const descTitle = state.layer.querySelector(".plastic-direction:nth-child(2) > .direction-title");
  if (!host || !ascTitle || !descTitle) {
    hideDirectionOverlay(state);
    return;
  }

  const viewRect = view.getBoundingClientRect();
  const topOffset = fixedTopPx(state);
  const stickyY = viewRect.top + topOffset;
  host.style.top = `${topOffset}px`;

  const ascRect = ascTitle.getBoundingClientRect();
  const descRect = descTitle.getBoundingClientRect();
  const scale = state.scale;

  if (isLandscape()) {
    /* En horizontal los dos sentidos son visibles simultáneamente. El overlay
       aparece cuando sus encabezados originales alcanzan la zona sticky. */
    const shouldStick = Math.min(ascRect.top, descRect.top) <= stickyY + 0.5;
    if (!shouldStick) {
      hideDirectionOverlay(state);
      return;
    }

    copyTitleContent(state.directionOverlayFirst, ascTitle);
    copyTitleContent(state.directionOverlaySecond, descTitle);
    state.directionOverlayFirst.hidden = false;
    state.directionOverlaySecond.hidden = false;
    host.classList.add("visible", "landscape");

    const place = (node, source, rect) => {
      node.style.left = `${rect.left - viewRect.left}px`;
      node.style.top = "0px";
      node.style.width = `${Math.max(1, source.offsetWidth)}px`;
      node.style.transform = `scale(${scale})`;
    };
    place(state.directionOverlayFirst, ascTitle, ascRect);
    place(state.directionOverlaySecond, descTitle, descRect);
    return;
  }

  host.classList.remove("landscape");
  state.directionOverlaySecond.hidden = true;

  /* Antes de que ASCENDENTS llegue a la zona sticky se ve el original. */
  if (ascRect.top > stickyY + 0.5) {
    hideDirectionOverlay(state);
    return;
  }

  const currentIsDesc = descRect.top <= stickyY + 0.5;
  const currentTitle = currentIsDesc ? descTitle : ascTitle;
  const currentRect = currentIsDesc ? descRect : ascRect;

  copyTitleContent(state.directionOverlayFirst, currentTitle);
  state.directionOverlayFirst.hidden = false;
  host.classList.add("visible");

  const physicalHeight = Math.max(1, currentTitle.offsetHeight * scale);
  let pushY = 0;
  if (!currentIsDesc) {
    /* DESCENDENTS empuja a ASCENDENTS exactamente al entrar en su zona. */
    pushY = Math.min(0, descRect.top - stickyY - physicalHeight);
  }

  state.directionOverlayFirst.style.left = `${currentRect.left - viewRect.left}px`;
  state.directionOverlayFirst.style.top = `${pushY}px`;
  state.directionOverlayFirst.style.width = `${Math.max(1, currentTitle.offsetWidth)}px`;
  state.directionOverlayFirst.style.transform = `scale(${scale})`;
}

function syncGeometry(state) {
  if (!state.view.isConnected) return;
  const { view, layer, spacer } = state;

  state.minScale = minimumScale(view);
  state.maxScale = maximumScale(view);
  state.scale = clamp(state.scale, state.minScale, state.maxScale);

  const natural = logicalNaturalSize(state);
  layer.style.zoom = "";
  layer.style.transformOrigin = "0 0";
  layer.style.transform = `scale(${state.scale})`;

  /* transform no participa en layout: el spacer aporta el área de scroll. */
  spacer.style.width = `${Math.max(view.clientWidth, Math.ceil(natural.width * state.scale))}px`;
  spacer.style.height = `${Math.max(1, Math.ceil(natural.height * state.scale))}px`;
  view.dataset.zoom = state.scale.toFixed(3);
  view.style.setProperty("--viewport-scale", String(state.scale));

  requestAnimationFrame(() => syncDirectionOverlay(state));
}

function ensureWrapped(view) {
  if (states.has(view)) return states.get(view);

  const { spacer, layer, fixedPlasticFilters } = normalizeWrapper(view);
  const state = {
    view,
    spacer,
    layer,
    fixedPlasticFilters,
    directional:view.id === "view-plastic" || view.id === "view-isic",
    directionOverlay:null,
    directionOverlayFirst:null,
    directionOverlaySecond:null,
    scale:1,
    minScale:minimumScale(view),
    maxScale:maximumScale(view),
    pinch:null,
    resizeObserver:null
  };
  states.set(view, state);

  if (fixedPlasticFilters) {
    fixedPlasticFilters.style.transform = "";
    fixedPlasticFilters.style.willChange = "auto";
  }

  ensureDirectionOverlay(state);

  const ro = new ResizeObserver(() => {
    requestAnimationFrame(() => syncGeometry(state));
  });
  ro.observe(layer);
  ro.observe(view);
  if (fixedPlasticFilters) ro.observe(fixedPlasticFilters);
  state.resizeObserver = ro;

  view.addEventListener("scroll", () => {
    requestAnimationFrame(() => syncDirectionOverlay(state));
  }, { passive:true });

  view.addEventListener("touchstart", event => {
    if (event.touches.length !== 2) return;
    const distance = touchDistance(event.touches);
    if (!Number.isFinite(distance) || distance < 8) return;

    const center = touchCenter(view, event.touches);
    const origin = layerOrigin(state);
    state.pinch = {
      distance,
      startScale:state.scale,
      logicalX:(view.scrollLeft + center.x - origin.x) / state.scale,
      logicalY:(view.scrollTop + center.y - origin.y) / state.scale
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
    state.minScale = minimumScale(view);
    state.maxScale = maximumScale(view);
    const next = clamp(state.pinch.startScale * ratio, state.minScale, state.maxScale);
    state.scale = next;
    syncGeometry(state);

    const origin = layerOrigin(state);
    view.scrollLeft = origin.x + state.pinch.logicalX * next - center.x;
    view.scrollTop = origin.y + state.pinch.logicalY * next - center.y;
    requestAnimationFrame(() => syncDirectionOverlay(state));
    event.preventDefault();
  }, { passive:false });

  const finishPinch = event => {
    if (!event.touches || event.touches.length < 2) state.pinch = null;
  };
  view.addEventListener("touchend", finishPinch, { passive:true });
  view.addEventListener("touchcancel", finishPinch, { passive:true });

  /* Safari puede emitir GestureEvent además de TouchEvent. Un solo motor evita
     dobles escalados y los saltos observados en betas anteriores. */
  for (const name of ["gesturestart", "gesturechange", "gestureend"]) {
    view.addEventListener(name, event => event.preventDefault(), { passive:false });
  }

  view.addEventListener("wheel", event => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const rect = view.getBoundingClientRect();
    const anchorX = event.clientX - rect.left;
    const anchorY = event.clientY - rect.top;
    const origin = layerOrigin(state);
    const logicalX = (view.scrollLeft + anchorX - origin.x) / state.scale;
    const logicalY = (view.scrollTop + anchorY - origin.y) / state.scale;
    const factor = Math.exp(-event.deltaY * 0.002);
    state.minScale = minimumScale(view);
    state.maxScale = maximumScale(view);
    state.scale = clamp(state.scale * factor, state.minScale, state.maxScale);
    syncGeometry(state);
    const nextOrigin = layerOrigin(state);
    view.scrollLeft = nextOrigin.x + logicalX * state.scale - anchorX;
    view.scrollTop = nextOrigin.y + logicalY * state.scale - anchorY;
    requestAnimationFrame(() => syncDirectionOverlay(state));
  }, { passive:false });

  window.addEventListener("orientationchange", () => {
    requestAnimationFrame(() => {
      state.minScale = minimumScale(view);
      state.maxScale = maximumScale(view);
      state.scale = clamp(state.scale, state.minScale, state.maxScale);
      syncGeometry(state);
    });
  }, { passive:true });

  requestAnimationFrame(() => syncGeometry(state));
  return state;
}

export function setupViewports() {
  document.querySelectorAll(".view.active:not(.ctc-view)").forEach(ensureWrapped);
}

export function activateViewport(viewOrSelector) {
  const view = selectorToView(viewOrSelector);
  if (!view || view.classList.contains("ctc-view")) return null;
  const state = ensureWrapped(view);
  requestAnimationFrame(() => syncGeometry(state));
  return state;
}

export function refreshViewport(viewOrSelector) {
  const view = selectorToView(viewOrSelector);
  if (!view || view.classList.contains("ctc-view")) return null;
  const state = ensureWrapped(view);
  syncGeometry(state);
  return state;
}

export function setViewportScale(viewOrSelector, scale, { anchorX = null, anchorY = null } = {}) {
  const view = selectorToView(viewOrSelector);
  if (!view || view.classList.contains("ctc-view")) return null;
  const state = ensureWrapped(view);
  const x = anchorX ?? view.clientWidth / 2;
  const y = anchorY ?? view.clientHeight / 2;
  const origin = layerOrigin(state);
  const logicalX = (view.scrollLeft + x - origin.x) / state.scale;
  const logicalY = (view.scrollTop + y - origin.y) / state.scale;

  state.minScale = minimumScale(view);
  state.maxScale = maximumScale(view);
  state.scale = clamp(scale, state.minScale, state.maxScale);
  syncGeometry(state);
  const nextOrigin = layerOrigin(state);
  view.scrollLeft = nextOrigin.x + logicalX * state.scale - x;
  view.scrollTop = nextOrigin.y + logicalY * state.scale - y;
  requestAnimationFrame(() => syncDirectionOverlay(state));
  return state.scale;
}

export function focusViewportPoint(viewOrSelector, x, y, { scale = null, alignX = 0.5, alignY = 0.5 } = {}) {
  const view = selectorToView(viewOrSelector);
  if (!view || view.classList.contains("ctc-view")) return;
  const state = ensureWrapped(view);
  state.minScale = minimumScale(view);
  state.maxScale = maximumScale(view);
  if (scale !== null) state.scale = clamp(scale, state.minScale, state.maxScale);
  syncGeometry(state);
  const origin = layerOrigin(state);
  view.scrollLeft = Math.max(0, origin.x + x * state.scale - view.clientWidth * alignX);
  view.scrollTop = Math.max(0, origin.y + y * state.scale - view.clientHeight * alignY);
  requestAnimationFrame(() => syncDirectionOverlay(state));
}

export function resetViewport(viewOrSelector, { scale = 1 } = {}) {
  const view = selectorToView(viewOrSelector);
  if (!view || view.classList.contains("ctc-view")) return;
  const state = ensureWrapped(view);
  state.minScale = minimumScale(view);
  state.maxScale = maximumScale(view);
  state.scale = clamp(scale, state.minScale, state.maxScale);
  syncGeometry(state);
  view.scrollLeft = 0;
  view.scrollTop = 0;
  requestAnimationFrame(() => syncDirectionOverlay(state));
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
    engine:"rigid-transform-323",
    plasticFiltersFixed:Boolean(state.fixedPlasticFilters)
  };
}
