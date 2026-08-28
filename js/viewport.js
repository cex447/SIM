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

/*
 * BETA 3.22.0 · PLASTIC / iSIC / LIT / SIV
 *
 * Referencia funcional: el vídeo aportado el 28/08/2026 con el comportamiento
 * de las primeras betas.
 *
 * El zoom vuelve a ser geométrico, NO de maquetación:
 *   - toda la composición de la vista se trata como un único plano rígido;
 *   - no hay reflow durante el pinch;
 *   - textos, iconos, filas, columnas y separadores conservan siempre sus
 *     proporciones y posiciones relativas;
 *   - un dedo mantiene el scroll nativo de la propia vista;
 *   - dos dedos modifican únicamente una transform:scale() común;
 *   - SIM+/reloj y navegación inferior quedan fuera de este motor;
 *   - CTC conserva su motor vectorial independiente por viewBox.
 *
 * PLASTIC requiere además que los filtros de línea/UT permanezcan inmóviles
 * durante el scroll. Safari/iOS no es fiable combinando position:sticky con un
 * ancestro transformado, por lo que el anclaje se hace explícitamente: el
 * filtro recibe una traslación equivalente al scroll en coordenadas lógicas.
 * Visualmente forma parte del mismo plano y participa del mismo zoom, pero no
 * se desplaza al recorrer el listado.
 */

function normalizeWrapper(view) {
  const directLayer = view.querySelector(":scope > .zoom-layer");
  if (directLayer) {
    const spacer = document.createElement("div");
    spacer.className = "zoom-spacer";
    view.insertBefore(spacer, directLayer);
    spacer.appendChild(directLayer);
    return { spacer, layer:directLayer };
  }

  const existingSpacer = view.querySelector(":scope > .zoom-spacer");
  const existingLayer = existingSpacer?.querySelector(":scope > .zoom-layer");
  if (existingSpacer && existingLayer) return { spacer:existingSpacer, layer:existingLayer };

  const children = [...view.childNodes];
  const spacer = document.createElement("div");
  spacer.className = "zoom-spacer";
  const layer = document.createElement("div");
  layer.className = "zoom-layer";
  spacer.appendChild(layer);
  for (const child of children) layer.appendChild(child);
  view.appendChild(spacer);
  return { spacer, layer };
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

  /* La anchura lógica pertenece al viewport SIN escala, nunca al spacer. Si el
     layer usara width:100% del spacer, cada actualización multiplicaría su
     anchura de nuevo y el zoom crecería exponencialmente. */
  layer.style.width = `${box.width}px`;
  layer.style.minWidth = `${box.width}px`;
  layer.style.minHeight = `${box.height}px`;

  /* offset* y scroll* no incluyen el transform CSS; son dimensiones lógicas. */
  const width = Math.max(layer.scrollWidth, layer.offsetWidth, box.width);
  const height = Math.max(layer.scrollHeight, layer.offsetHeight, box.height);
  return { width, height };
}

function syncPinnedControls(state) {
  if (!state.plasticFilters) return;
  /* La transformación del filtro ocurre DENTRO del layer escalado:
     scale * (scrollTop/scale) == scrollTop, que compensa exactamente el scroll
     físico del viewport sin desacoplar su escala del resto de PLASTIC. */
  const logicalScrollTop = state.view.scrollTop / state.scale;
  state.plasticFilters.style.transform = `translate3d(0, ${logicalScrollTop}px, 0)`;
}

function syncGeometry(state) {
  if (!state.view.isConnected) return;
  const { view, layer, spacer } = state;
  const natural = logicalNaturalSize(state);

  layer.style.zoom = "";
  layer.style.transformOrigin = "0 0";
  layer.style.transform = `scale(${state.scale})`;

  /* El transform no participa en layout. El spacer crea exactamente la zona de
     scroll correspondiente al plano ya escalado, sin provocar reflow interno. */
  spacer.style.width = `${Math.max(view.clientWidth, Math.ceil(natural.width * state.scale))}px`;
  spacer.style.height = `${Math.max(view.clientHeight, Math.ceil(natural.height * state.scale))}px`;
  view.dataset.zoom = state.scale.toFixed(3);
  syncPinnedControls(state);
}

function ensureWrapped(view) {
  if (states.has(view)) return states.get(view);

  const { spacer, layer } = normalizeWrapper(view);
  const state = {
    view,
    spacer,
    layer,
    scale:1,
    minScale:Number(view.dataset.viewportMin || 0.70),
    maxScale:Number(view.dataset.viewportMax || 2.75),
    pinch:null,
    resizeObserver:null,
    plasticFilters:view.id === "view-plastic" ? layer.querySelector(".plastic-filters") : null
  };
  states.set(view, state);

  if (state.plasticFilters) {
    state.plasticFilters.style.position = "relative";
    state.plasticFilters.style.top = "auto";
    state.plasticFilters.style.willChange = "transform";
  }

  const ro = new ResizeObserver(() => {
    /* Un render dinámico (PLASTIC/iSIC/LIT) cambia la altura lógica; actualizamos
       sólo el spacer, no la escala ni la maquetación de la vista. */
    requestAnimationFrame(() => syncGeometry(state));
  });
  ro.observe(layer);
  ro.observe(view);
  state.resizeObserver = ro;

  view.addEventListener("scroll", () => syncPinnedControls(state), { passive:true });

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
    syncGeometry(state);

    /* Mantener bajo los dedos el mismo punto lógico del plano durante todo el
       gesto. No se recalcula el punto de referencia entre eventos. */
    view.scrollLeft = state.pinch.logicalX * next - center.x;
    view.scrollTop = state.pinch.logicalY * next - center.y;
    syncPinnedControls(state);
    event.preventDefault();
  }, { passive:false });

  const finishPinch = event => {
    if (!event.touches || event.touches.length < 2) state.pinch = null;
  };
  view.addEventListener("touchend", finishPinch, { passive:true });
  view.addEventListener("touchcancel", finishPinch, { passive:true });

  /* Safari puede generar GestureEvent además de TouchEvent. El zoom de SIM+
     tiene un único motor para evitar dobles escalados. */
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
    syncGeometry(state);
    view.scrollLeft = logicalX * state.scale - anchorX;
    view.scrollTop = logicalY * state.scale - anchorY;
    syncPinnedControls(state);
  }, { passive:false });

  requestAnimationFrame(() => syncGeometry(state));
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
  const logicalX = (view.scrollLeft + x) / state.scale;
  const logicalY = (view.scrollTop + y) / state.scale;
  state.scale = clamp(scale, state.minScale, state.maxScale);
  syncGeometry(state);
  view.scrollLeft = logicalX * state.scale - x;
  view.scrollTop = logicalY * state.scale - y;
  syncPinnedControls(state);
  return state.scale;
}

export function focusViewportPoint(viewOrSelector, x, y, { scale = null, alignX = 0.5, alignY = 0.5 } = {}) {
  const view = selectorToView(viewOrSelector);
  if (!view || view.classList.contains("ctc-view")) return;
  const state = ensureWrapped(view);
  if (scale !== null) state.scale = clamp(scale, state.minScale, state.maxScale);
  syncGeometry(state);
  view.scrollLeft = Math.max(0, x * state.scale - view.clientWidth * alignX);
  view.scrollTop = Math.max(0, y * state.scale - view.clientHeight * alignY);
  syncPinnedControls(state);
}

export function resetViewport(viewOrSelector, { scale = 1 } = {}) {
  const view = selectorToView(viewOrSelector);
  if (!view || view.classList.contains("ctc-view")) return;
  const state = ensureWrapped(view);
  state.scale = clamp(scale, state.minScale, state.maxScale);
  syncGeometry(state);
  view.scrollLeft = 0;
  view.scrollTop = 0;
  syncPinnedControls(state);
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
    engine:"rigid-transform"
  };
}
