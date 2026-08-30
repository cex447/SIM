/*
 * SIM+ Beta 3.25.0 · viewport estable basado en la geometría natural de 3.14.
 *
 * Principio:
 *   - escala 1 = composición mínima exacta de la página de referencia;
 *   - nunca se reduce por debajo de esa composición;
 *   - sólo escala el contenido de datos de PLASTIC/iSIC/LIT/SIV;
 *   - cabecera SIM+/reloj, campos de consulta, navegación inferior y filtros
 *     PLASTIC permanecen fuera del plano escalado;
 *   - CTC conserva su motor SVG/viewBox independiente.
 *
 * El motor evita medir/remaquetar el layer durante cada touchmove. El tamaño
 * lógico sólo se recalcula cuando cambia realmente el contenido o la vista.
 */

const states = new Map();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function selectorToView(viewOrSelector) {
  if (!viewOrSelector) return null;
  if (typeof viewOrSelector === "string") return document.querySelector(viewOrSelector);
  return viewOrSelector;
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
  const specific = isLandscape()
    ? numericData(view, "viewportMinLandscape", NaN)
    : numericData(view, "viewportMinPortrait", NaN);
  return Number.isFinite(specific) ? specific : numericData(view, "viewportMin", 1);
}

function maximumScale(view) {
  return numericData(view, "viewportMax", 2.75);
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
    x:((a.clientX + b.clientX) * 0.5) - rect.left,
    y:((a.clientY + b.clientY) * 0.5) - rect.top
  };
}

function viewContentBox(view) {
  const style = getComputedStyle(view);
  const px = value => Number.parseFloat(value) || 0;
  return {
    width:Math.max(1, view.clientWidth - px(style.paddingLeft) - px(style.paddingRight)),
    height:Math.max(1, view.clientHeight - px(style.paddingTop) - px(style.paddingBottom))
  };
}

function normalizeWrapper(view) {
  const fixedPlasticFilters = view.id === "view-plastic"
    ? view.querySelector(":scope > .plastic-filters")
    : null;

  const existingSpacer = view.querySelector(":scope > .zoom-spacer");
  const existingLayer = existingSpacer?.querySelector(":scope > .zoom-layer");
  if (existingSpacer && existingLayer) {
    return { spacer:existingSpacer, layer:existingLayer, fixedPlasticFilters };
  }

  const movableChildren = [...view.childNodes].filter(node => node !== fixedPlasticFilters);
  const spacer = document.createElement("div");
  spacer.className = "zoom-spacer";
  const layer = document.createElement("div");
  layer.className = "zoom-layer";
  spacer.appendChild(layer);

  if (fixedPlasticFilters) fixedPlasticFilters.insertAdjacentElement("afterend", spacer);
  else view.appendChild(spacer);

  for (const child of movableChildren) layer.appendChild(child);
  return { spacer, layer, fixedPlasticFilters };
}

function measureNatural(state) {
  if (state.pinching) return state.natural;

  const box = viewContentBox(state.view);
  state.layer.style.width = `${box.width}px`;
  state.layer.style.minWidth = `${box.width}px`;
  state.layer.style.minHeight = `${box.height}px`;

  const natural = {
    width:Math.max(box.width, state.layer.scrollWidth, state.layer.offsetWidth),
    height:Math.max(box.height, state.layer.scrollHeight, state.layer.offsetHeight)
  };
  state.natural = natural;
  return natural;
}

function applyScale(state, { measure = false } = {}) {
  if (!state.view.isConnected) return;
  state.minScale = minimumScale(state.view);
  state.maxScale = maximumScale(state.view);
  state.scale = clamp(state.scale, state.minScale, state.maxScale);

  const natural = measure || !state.natural ? measureNatural(state) : state.natural;
  state.layer.style.transformOrigin = "0 0";
  state.layer.style.transform = `scale(${state.scale})`;
  // BETA 3.25: el eje X no forma parte del viewport. El contenido ampliado
  // se recorta lateralmente y la vista sólo crece en Y.
  state.spacer.style.width = "100%";
  state.spacer.style.minWidth = "100%";
  state.spacer.style.height = `${Math.max(1, Math.ceil(natural.height * state.scale))}px`;
  if (state.view.scrollLeft !== 0) state.view.scrollLeft = 0;
  state.view.dataset.zoom = state.scale.toFixed(3);
  state.view.style.setProperty("--viewport-scale", String(state.scale));
  requestAnimationFrame(() => syncDirectionOverlay(state));
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
  const vr = state.view.getBoundingClientRect();
  const fr = state.fixedPlasticFilters.getBoundingClientRect();
  return Math.max(0, Math.min(vr.height, fr.bottom - vr.top));
}

function copyTitleContent(target, source) {
  if (!target || !source) return;
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
  const host = state.directionOverlay;
  if (!host) return;
  host.classList.remove("visible", "landscape");
  state.directionOverlayFirst.hidden = true;
  state.directionOverlaySecond.hidden = true;
}

function logicalOffsetLeft(node, ancestor) {
  let x = 0;
  let current = node;
  while (current && current !== ancestor) {
    x += current.offsetLeft || 0;
    current = current.offsetParent;
  }
  return x;
}

function placeDirectionTitle(node, source, { x, y }) {
  copyTitleContent(node, source);
  node.hidden = false;
  node.style.left = `${Math.round(x * 1000) / 1000}px`;
  node.style.top = `${Math.round(y * 1000) / 1000}px`;
  node.style.width = `${Math.max(1, source.offsetWidth)}px`;
  // Nunca hereda la escala del plano de datos.
  node.style.transform = "none";
}

function syncDirectionOverlay(state) {
  if (!state.directional || !state.view.classList.contains("active")) return;
  ensureDirectionOverlay(state);

  const ascTitle = state.layer.querySelector(".plastic-direction:first-child > .direction-title");
  const descTitle = state.layer.querySelector(".plastic-direction:nth-child(2) > .direction-title");
  if (!ascTitle || !descTitle) {
    hideDirectionOverlay(state);
    return;
  }

  const viewRect = state.view.getBoundingClientRect();
  const topOffset = fixedTopPx(state);
  const stickyY = viewRect.top + topOffset;
  const ascRect = ascTitle.getBoundingClientRect();
  const descRect = descTitle.getBoundingClientRect();
  const host = state.directionOverlay;

  // El host vive fuera del plano transformado: X y tipografía son invariantes.
  host.style.top = `${topOffset}px`;
  host.classList.add("visible");

  const ascX = logicalOffsetLeft(ascTitle, state.layer);
  const descX = logicalOffsetLeft(descTitle, state.layer);
  const ascNaturalH = Math.max(1, ascTitle.offsetHeight);

  if (isLandscape()) {
    host.classList.add("landscape");
    // Ambos encabezados comparten sólo el desplazamiento vertical del listado.
    // Nunca se recentran ni se desplazan horizontalmente al hacer zoom.
    const ascY = Math.max(0, ascRect.top - stickyY);
    const descY = Math.max(0, descRect.top - stickyY);
    placeDirectionTitle(state.directionOverlayFirst, ascTitle, { x:ascX, y:ascY });
    placeDirectionTitle(state.directionOverlaySecond, descTitle, { x:descX, y:descY });
    return;
  }

  host.classList.remove("landscape");

  if (descRect.top <= stickyY + 0.5) {
    // Ya estamos dentro de DESCENDENTS: sólo queda su cabecera sticky.
    state.directionOverlayFirst.hidden = true;
    placeDirectionTitle(state.directionOverlaySecond, descTitle, { x:descX, y:0 });
    return;
  }

  // DESCENDENTS todavía no ha tomado el relevo. Su título se dibuja a tamaño
  // fijo en su posición vertical real para que pueda empujar ASCENDENTS.
  const descY = descRect.top - stickyY;
  placeDirectionTitle(state.directionOverlaySecond, descTitle, { x:descX, y:descY });

  if (ascRect.top > stickyY + 0.5) {
    // Antes de alcanzar el punto sticky, ASCENDENTS también conserva 1:1.
    const ascY = ascRect.top - stickyY;
    placeDirectionTitle(state.directionOverlayFirst, ascTitle, { x:ascX, y:ascY });
    return;
  }

  // ASCENDENTS sticky. Sólo puede desplazarse en Y durante el push-off.
  const pushY = Math.min(0, descRect.top - stickyY - ascNaturalH);
  placeDirectionTitle(state.directionOverlayFirst, ascTitle, { x:ascX, y:pushY });
}

function scheduleMeasure(state) {
  if (state.pinching || state.measureQueued) return;
  state.measureQueued = true;
  requestAnimationFrame(() => {
    state.measureQueued = false;
    if (state.pinching) return;
    applyScale(state, { measure:true });
  });
}

function ensureWrapped(view) {
  if (states.has(view)) return states.get(view);
  const { spacer, layer, fixedPlasticFilters } = normalizeWrapper(view);
  const state = {
    view, spacer, layer, fixedPlasticFilters,
    directional:view.id === "view-plastic" || view.id === "view-isic",
    directionOverlay:null, directionOverlayFirst:null, directionOverlaySecond:null,
    scale:1,
    minScale:minimumScale(view),
    maxScale:maximumScale(view),
    natural:null,
    pinch:null,
    pinching:false,
    measureQueued:false,
    resizeObserver:null,
    mutationObserver:null
  };
  states.set(view, state);
  if (state.directional) view.classList.add("viewport-directional-ready");
  ensureDirectionOverlay(state);

  const ro = new ResizeObserver(() => scheduleMeasure(state));
  ro.observe(view);
  if (fixedPlasticFilters) ro.observe(fixedPlasticFilters);
  state.resizeObserver = ro;

  const mo = new MutationObserver(() => scheduleMeasure(state));
  mo.observe(layer, { childList:true, subtree:true, characterData:true, attributes:true, attributeFilter:["hidden", "class"] });
  state.mutationObserver = mo;

  view.addEventListener("scroll", () => {
    // BETA 3.25: nunca existe navegación horizontal fuera de CTC.
    if (view.scrollLeft !== 0) view.scrollLeft = 0;
    requestAnimationFrame(() => syncDirectionOverlay(state));
  }, { passive:true });

  view.addEventListener("touchstart", event => {
    if (event.touches.length !== 2) return;
    const distance = touchDistance(event.touches);
    if (!Number.isFinite(distance) || distance < 8) return;

    // Congelamos geometría natural durante todo el gesto.
    if (!state.natural) measureNatural(state);
    const center = touchCenter(view, event.touches);
    state.pinching = true;
    state.pinch = {
      distance,
      startScale:state.scale,
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
    state.scale = clamp(state.pinch.startScale * ratio, minimumScale(view), maximumScale(view));
    applyScale(state, { measure:false });
    view.scrollLeft = 0;
    view.scrollTop = Math.max(0, state.pinch.logicalY * state.scale - center.y);
    event.preventDefault();
  }, { passive:false });

  const finishPinch = event => {
    if (event.touches && event.touches.length >= 2) return;
    if (!state.pinching) return;
    state.pinching = false;
    state.pinch = null;
    scheduleMeasure(state);
  };
  view.addEventListener("touchend", finishPinch, { passive:true });
  view.addEventListener("touchcancel", finishPinch, { passive:true });

  // Safari puede generar GestureEvent en paralelo: se anula para que jamás
  // intervenga un segundo motor de zoom sobre el mismo gesto.
  for (const name of ["gesturestart", "gesturechange", "gestureend"]) {
    view.addEventListener(name, event => event.preventDefault(), { passive:false });
  }

  view.addEventListener("wheel", event => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    if (!state.natural) measureNatural(state);
    const rect = view.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const ly = (view.scrollTop + y) / state.scale;
    state.scale = clamp(state.scale * Math.exp(-event.deltaY * 0.002), minimumScale(view), maximumScale(view));
    applyScale(state, { measure:false });
    view.scrollLeft = 0;
    view.scrollTop = Math.max(0, ly * state.scale - y);
  }, { passive:false });

  window.addEventListener("orientationchange", () => {
    requestAnimationFrame(() => {
      state.scale = clamp(state.scale, minimumScale(view), maximumScale(view));
      applyScale(state, { measure:true });
      view.scrollLeft = 0;
    });
  }, { passive:true });

  applyScale(state, { measure:true });
  return state;
}

export function setupViewports() {
  document.querySelectorAll(".view.active:not(.ctc-view)").forEach(ensureWrapped);
}

export function activateViewport(viewOrSelector) {
  const view = selectorToView(viewOrSelector);
  if (!view || view.classList.contains("ctc-view")) return null;
  const state = ensureWrapped(view);
  requestAnimationFrame(() => applyScale(state, { measure:true }));
  return state;
}

export function refreshViewport(viewOrSelector) {
  const view = selectorToView(viewOrSelector);
  if (!view || view.classList.contains("ctc-view")) return null;
  const state = ensureWrapped(view);
  applyScale(state, { measure:true });
  return state;
}

export function setViewportScale(viewOrSelector, scale, { anchorX = null, anchorY = null } = {}) {
  const view = selectorToView(viewOrSelector);
  if (!view || view.classList.contains("ctc-view")) return null;
  const state = ensureWrapped(view);
  if (!state.natural) measureNatural(state);
  const y = anchorY ?? view.clientHeight / 2;
  const ly = (view.scrollTop + y) / state.scale;
  state.scale = clamp(scale, minimumScale(view), maximumScale(view));
  applyScale(state, { measure:false });
  view.scrollLeft = 0;
  view.scrollTop = Math.max(0, ly * state.scale - y);
  void anchorX;
  return state.scale;
}

export function focusViewportPoint(viewOrSelector, x, y, { scale = null, alignX = 0.5, alignY = 0.5 } = {}) {
  const view = selectorToView(viewOrSelector);
  if (!view || view.classList.contains("ctc-view")) return;
  const state = ensureWrapped(view);
  if (scale !== null) state.scale = clamp(scale, minimumScale(view), maximumScale(view));
  applyScale(state, { measure:true });
  view.scrollLeft = 0;
  view.scrollTop = Math.max(0, y * state.scale - view.clientHeight * alignY);
  void x;
  void alignX;
}

export function resetViewport(viewOrSelector, { scale = 1 } = {}) {
  const view = selectorToView(viewOrSelector);
  if (!view || view.classList.contains("ctc-view")) return;
  const state = ensureWrapped(view);
  state.scale = clamp(scale, minimumScale(view), maximumScale(view));
  applyScale(state, { measure:true });
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
    engine:"stable-natural-325",
    plasticFiltersFixed:Boolean(state.fixedPlasticFilters),
    horizontalLocked:true
  };
}
