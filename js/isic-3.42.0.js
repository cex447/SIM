import { resolveGtfsTimestamp } from "./time-3.42.0.js";

/*
 * SIM+ · iSIC visual parser + matching seguro
 *
 * El endpoint público iSIC devuelve una imagen PNG. El navegador accede
 * mediante el Worker CORS ya validado y reconoce únicamente las zonas
 * estables de línea, tiempo y vía; no se usa OCR genérico.
 *
 * Producción: nunca se usa memoria histórica para fabricar una vía actual.
 */

const PANEL_W = 1920;
const PANEL_H = 1080;
const ROW_TOP = 200;
const ROW_H = 200;
const ROWS = 4;
const TEMPLATE_W = 60;
const TEMPLATE_H = 70;

const templatesB64 = {"1": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8AAAAAAAAB8AAAAAAAAH+AAAAAAAAP+AAAAAAAAf+AAAAAAAB/+AAAAAAAD/+AAAAAAAH/+AAAAAAAf/+AAAAAAA/7+AAAAAAB/z+AAAAAAD/j+AAAAAAP+D+AAAAAAf8D+AAAAAA/4D+AAAAAAfwD+AAAAAAPAD+AAAAAAOAD+AAAAAAEAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "4": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfwAAAAAAAAfwAAAAAAAA/wAAAAAAAB/wAAAAAAAB/wAAAAAAAD/wAAAAAAAH/wAAAAAAAP/wAAAAAAAPvwAAAAAAAfvwAAAAAAB/PwAAAAAAB/PwAAAAAAD+PwAAAAAAH+PwAAAAAAP8PwAAAAAAP4PwAAAAAAf4PwAAAAAA/wPwAAAAAA/gPwAAAAAB+APwAAAAAD+APwAAAAAD8APwAAAAAH4APwAAAAAP4APwAAAAAfwAPwAAAAAfgAPwAAAAA/AAPwAAAAB/AAPwAAAAB+AAPwAAAAD8AAPwAAAAH8AAPwAAAAP4AAPwAAAAPwAAPwAAAAPwAAPwAAAAfgAAPwAAAA/gAAPwAAAA/AAAPwAAAB+AAAPwAAAD+AAAPwAAAD8AAAPwAAAH4AAAPwAAAP4AAAPwAAAfwAAAPwAAAfgAAAP4AAB////////AB////////AB////////AB////////AB////////AB////////AAAAAAAPwAAAAAAAAPwAAAAAAAAPwAAAAAAAAPwAAAAAAAAPwAAAAAAAAPwAAAAAAAAPwAAAAAAAAPwAAAAAAAAPwAAAAAAAAPwAAAAAAAAPwAAAAAAAAPwAAAAAAAAPwAAAAAAAAPwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "8": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD4AAAAAAAB//wAAAAAAP//+AAAAAA////gAAAAB////wAAAAD////4AAAAH/gB/8AAAAP+AAP+AAAAf8AAH+AAAAf4AAD/AAAAfwAAB/AAAA/gAAB/gAAA/gAAA/gAAA/gAAA/gAAA/gAAA/gAAA/gAAA/gAAA/gAAA/gAAA/gAAA/gAAA/gAAA/gAAAfgAAB/AAAAfwAAB/AAAAf4AAD+AAAAP4AAD+AAAAP8AAH8AAAAH/AAf4AAAAD/gA/wAAAAB/4D/gAAAAA/+P/AAAAAAf//8AAAAAAH//4AAAAAAB//gAAAAAAB//wAAAAAAH//8AAAAAAf///AAAAAA/8f/gAAAAD/wH/4AAAAH/AB/8AAAAP8AAf+AAAAf4AAH/AAAA/wAAD/AAAA/gAAB/gAAB/AAAA/wAAB/AAAAfwAAB+AAAAfwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAfwAAB/AAAAfwAAB/AAAA/wAAB/gAAB/gAAA/wAAD/gAAAf8AAH/AAAAf/AAf+AAAAP////8AAAAH////4AAAAB////wAAAAAf///AAAAAAH//4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "2": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf4AAAAAAAH//gAAAAAA///4AAAAAD///+AAAAAP////AAAAAf////gAAAB//AH/wAAAD/4AB/4AAAB/gAAf8AAAA+AAAP8AAAAcAAAH+AAAAQAAAH+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAB/AAAAAAAAB/AAAAAAAAB/AAAAAAAAB/AAAAAAAAB+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAH8AAAAAAAAH8AAAAAAAAP4AAAAAAAAP4AAAAAAAAfwAAAAAAAA/wAAAAAAAA/gAAAAAAAB/AAAAAAAAD/AAAAAAAAH+AAAAAAAAP8AAAAAAAAf4AAAAAAAA/wAAAAAAAB/wAAAAAAAB/gAAAAAAAD/AAAAAAAAH+AAAAAAAAP8AAAAAAAAf4AAAAAAAA/wAAAAAAAB/gAAAAAAAD/AAAAAAAAH+AAAAAAAAP8AAAAAAAAf4AAAAAAAA/wAAAAAAAB/gAAAAAAAD/AAAAAAAAH+AAAAAAAAP8AAAAAAAAf4AAAAAAAA/wAAAAAAAB/gAAAAAAAD/gAAAAAAAH//////wAAH//////wAAH//////wAAH//////wAAH//////wAAH//////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "7": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//////4AAP//////4AAP//////4AAP//////4AAP//////4AAP//////4AAP//////4AAAAAAAAPwAAAAAAAAfwAAAAAAAAfwAAAAAAAA/gAAAAAAAA/gAAAAAAAB/AAAAAAAAB/AAAAAAAAD+AAAAAAAAD+AAAAAAAAH8AAAAAAAAH8AAAAAAAAH4AAAAAAAAP4AAAAAAAAP4AAAAAAAAfwAAAAAAAAfwAAAAAAAA/gAAAAAAAA/gAAAAAAAB/AAAAAAAAB/AAAAAAAAD+AAAAAAAAD+AAAAAAAAD+AAAAAAAAH8AAAAAAAAH8AAAAAAAAP4AAAAAAAAP4AAAAAAAAP4AAAAAAAAfwAAAAAAAAfwAAAAAAAA/gAAAAAAAA/gAAAAAAAB/gAAAAAAAB/AAAAAAAAD/AAAAAAAAD+AAAAAAAAD+AAAAAAAAH8AAAAAAAAH8AAAAAAAAP4AAAAAAAAP4AAAAAAAAf4AAAAAAAAfwAAAAAAAA/wAAAAAAAA/gAAAAAAAB/gAAAAAAAB/AAAAAAAAB/AAAAAAAAD+AAAAAAAAD+AAAAAAAAH+AAAAAAAAH8AAAAAAAAP8AAAAAAAAP4AAAAAAAAf4AAAAAAAAfwAAAAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "3": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf8AAAAAAAH//4AAAAAA///+AAAAAH////gAAAAP////wAAAA/////4AAAB//AB/8AAAB/4AAf+AAAA/gAAP+AAAA+AAAH/AAAAYAAAD/AAAAAAAAB/AAAAAAAAB/gAAAAAAAA/gAAAAAAAA/gAAAAAAAA/gAAAAAAAA/gAAAAAAAA/gAAAAAAAA/gAAAAAAAA/gAAAAAAAB/AAAAAAAAB/AAAAAAAAD/AAAAAAAAD+AAAAAAAAH+AAAAAAAAP8AAAAAAAA/4AAAAAAAD/wAAAAAAAf/gAAAAAP//+AAAAAAP//wAAAAAAP//AAAAAAAP//4AAAAAAP///AAAAAAP///wAAAAAAAH/8AAAAAAAAf+AAAAAAAAH/AAAAAAAAD/gAAAAAAAB/gAAAAAAAA/wAAAAAAAAfwAAAAAAAAfwAAAAAAAAfwAAAAAAAAPwAAAAAAAAPwAAAAAAAAPwAAAAAAAAPwAAAAAAAAPwAAAAAAAAfwAAAAAAAAfwAAAAAAAAfwAAAAAAAA/wAAAAAAAA/wAAAAAAAB/gAACAAAAD/gAADgAAAH/AAAD8AAAf+AAAD/wAD/8AAAD/////4AAAD/////wAAAD/////AAAAA////8AAAAAD///wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "6": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/gAAAAAAA//+AAAAAAH//+AAAAAAf//+AAAAAB///+AAAAAD///+AAAAAP/4AGAAAAAf/AAAAAAAA/8AAAAAAAA/wAAAAAAAB/gAAAAAAAD/AAAAAAAAD+AAAAAAAAH8AAAAAAAAH8AAAAAAAAP4AAAAAAAAP4AAAAAAAAfwAAAAAAAAfwAAAAAAAAfgAAAAAAAA/gAAAAAAAA/gAAAAAAAA/gAAAAAAAA/AAAAAAAAA/AAAAAAAAB/AB/gAAAAB/AP/+AAAAB/A///gAAAB/D///wAAAB+H///8AAAB+P/H/+AAAB+fwAP/AAAB+/AAH/AAAB/8AAB/gAAB/4AAA/gAAB/wAAA/wAAD/gAAAfwAAD/gAAAfwAAD/AAAAPwAAB/AAAAPwAAB/AAAAPwAAB+AAAAPwAAB+AAAAHwAAB+AAAAHwAAB+AAAAHwAAB/AAAAHwAAB/AAAAPwAAA/AAAAPwAAA/AAAAPwAAA/gAAAPwAAA/gAAAPwAAAfwAAAfwAAAfwAAAfwAAAP4AAA/wAAAP8AAA/gAAAH8AAB/gAAAH/AAD/AAAAD/gAP+AAAAB/4A/+AAAAA////8AAAAAf///4AAAAAP///gAAAAAD///AAAAAAA//4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "0": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH8AAAAAAAB//wAAAAAAH//8AAAAAAf//+AAAAAA////gAAAAB////wAAAAD/4D/wAAAAH/AA/4AAAAH+AAP8AAAAP8AAH8AAAAP4AAD+AAAAfwAAD+AAAAfwAAB/AAAA/gAAB/AAAA/gAAA/gAAA/gAAA/gAAA/AAAA/gAAB/AAAAfgAAB/AAAAfwAAB/AAAAfwAAB/AAAAfwAAB+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAD+AAAAPwAAB+AAAAPwAAB+AAAAPwAAB/AAAAfwAAB/AAAAfwAAB/AAAAfwAAA/AAAAfwAAA/AAAA/gAAA/gAAA/gAAA/gAAA/gAAAfgAAB/AAAAfwAAB/AAAAfwAAD/AAAAP4AAD+AAAAH8AAH+AAAAH+AAP8AAAAD/AAf8AAAAD/4D/4AAAAB////wAAAAA////gAAAAAP///AAAAAAH//8AAAAAAB//wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "5": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH////8AAAAH////8AAAAH////8AAAAH////8AAAAH////8AAAAH////8AAAAH////8AAAAH4AAAAAAAAP4AAAAAAAAP4AAAAAAAAP4AAAAAAAAPwAAAAAAAAPwAAAAAAAAPwAAAAAAAAPwAAAAAAAAPwAAAAAAAAPwAAAAAAAAPwAAAAAAAAPwAAAAAAAAPwAAAAAAAAfwAAAAAAAAfwAAAAAAAAfwAAAAAAAAfgAAAAAAAAfgAAAAAAAAfg/8AAAAAAf///4AAAAAf///+AAAAAf////gAAAAf////wAAAAP////4AAAAHgAD/8AAAAAAAAf+AAAAAAAAH/AAAAAAAAD/AAAAAAAAB/gAAAAAAAB/gAAAAAAAA/wAAAAAAAA/wAAAAAAAAfwAAAAAAAAfwAAAAAAAAfwAAAAAAAAfwAAAAAAAAfwAAAAAAAAfwAAAAAAAAfwAAAAAAAAfwAAAAAAAAfwAAAAAAAAfwAAAAAAAAfwAAAAAAAA/gAAAAAAAA/gAAAAAAAB/gAAAAAAAD/AAADAAAAH/AAADwAAAP+AAAD+AAA/8AAAD/4AH/4AAAD/////wAAAD/////gAAAD////+AAAAAf///4AAAAAD///gAAAAAAD/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "9": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//AAAAAAA///wAAAAAB///8AAAAAH///+AAAAAP////AAAAAf/AH/gAAAAf8AB/wAAAA/wAA/4AAAB/gAAP4AAAB/AAAP8AAAD/AAAH8AAAD+AAAD+AAAD+AAAD+AAAD8AAAB/AAAD8AAAB/AAAD8AAAA/AAAD8AAAA/AAAD8AAAA/gAAD4AAAA/gAAD4AAAAfgAAD4AAAAfgAAD4AAAAfgAAD8AAAAfgAAD8AAAA/gAAD8AAAA/gAAD8AAAA/wAAD+AAAB/wAAD+AAAB/wAAD/AAAD/gAAB/AAAH/gAAB/gAAP/gAAA/4AA/fgAAA/8AD+fgAAAf/4/8fgAAAP///4fgAAAD///w/gAAAB///A/gAAAAf/8A/gAAAAB/gA/gAAAAAAAA/AAAAAAAAA/AAAAAAAAB/AAAAAAAAB/AAAAAAAAB/AAAAAAAAB+AAAAAAAAD+AAAAAAAAD+AAAAAAAAH8AAAAAAAAH8AAAAAAAAP4AAAAAAAAP4AAAAAAAAfwAAAAAAAA/wAAAAAAAB/gAAAAAAAD/AAAAAAAAP/AAAAAAAA/+AAAAAYAH/8AAAAAf///wAAAAAf///gAAAAAf//+AAAAAAf//4AAAAAAf//AAAAAAAB/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"};

const LINE_COLORS = Object.freeze({
  L12:[191,190,224],
  L6:[128,127,195],
  L7:[180,97,38],
  S1:[253,115,45],
  S2:[81,191,68]
});

const stationImageCache = new Map();
const platformCache = new Map();
const circulationPlatformCache = new Map();

/*
 * VÍA 0 es un valor ferroviario válido en algunas situaciones excepcionales.
 * null/undefined/"" significan, en cambio, "vía todavía no confirmada".
 * Nunca usar Number(value) directamente para comprobar existencia porque
 * Number(null) === 0.
 */
export function normalizePlatformValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;

  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) return null;
  return numeric;
}

const templates = Object.fromEntries(
  Object.entries(templatesB64).map(([digit,value]) => [digit, unpackTemplate(value)])
);

function unpackTemplate(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  const out = new Uint8Array(TEMPLATE_W * TEMPLATE_H);
  let bit = 0;
  for (let i = 0; i < out.length; i += 1, bit += 1) {
    const byte = bytes[bit >> 3];
    out[i] = (byte >> (7 - (bit & 7))) & 1;
  }
  return out;
}

function makeMask(data, imgW, x0, y0, w, h, pred) {
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    let src = ((y0 + y) * imgW + x0) * 4;
    let dst = y * w;
    for (let x = 0; x < w; x += 1, src += 4, dst += 1) {
      if (pred(data[src], data[src + 1], data[src + 2], data[src + 3])) mask[dst] = 1;
    }
  }
  return mask;
}

function connected(mask, w, h) {
  const seen = new Uint8Array(mask.length);
  const comps = [];
  const stackX = new Int32Array(mask.length);
  const stackY = new Int32Array(mask.length);
  const dirs = [-1,-1, 0,-1, 1,-1, -1,0, 1,0, -1,1, 0,1, 1,1];

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const idx = y * w + x;
      if (!mask[idx] || seen[idx]) continue;

      let sp = 0;
      stackX[sp] = x;
      stackY[sp] = y;
      sp += 1;
      seen[idx] = 1;

      let minX = x, maxX = x, minY = y, maxY = y, area = 0;
      const pts = [];

      while (sp) {
        sp -= 1;
        const cx = stackX[sp], cy = stackY[sp];
        pts.push([cx, cy]);
        area += 1;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        for (let d = 0; d < dirs.length; d += 2) {
          const nx = cx + dirs[d], ny = cy + dirs[d + 1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (mask[ni] && !seen[ni]) {
            seen[ni] = 1;
            stackX[sp] = nx;
            stackY[sp] = ny;
            sp += 1;
          }
        }
      }

      const cw = maxX - minX + 1;
      const ch = maxY - minY + 1;
      const local = new Uint8Array(cw * ch);
      for (const [px, py] of pts) local[(py - minY) * cw + (px - minX)] = 1;
      comps.push({ x:minX, y:minY, w:cw, h:ch, area, mask:local });
    }
  }
  return comps;
}

function normalizeComp(comp) {
  const targetH = 64;
  const nw = Math.max(1, Math.round(comp.w * targetH / comp.h));
  const out = new Uint8Array(TEMPLATE_W * TEMPLATE_H);
  const ox = Math.floor((TEMPLATE_W - nw) / 2);
  const oy = Math.floor((TEMPLATE_H - targetH) / 2);

  for (let y = 0; y < targetH; y += 1) {
    const sy = Math.min(comp.h - 1, Math.floor(y * comp.h / targetH));
    for (let x = 0; x < nw; x += 1) {
      const sx = Math.min(comp.w - 1, Math.floor(x * comp.w / nw));
      const dx = ox + x, dy = oy + y;
      if (dx >= 0 && dx < TEMPLATE_W && comp.mask[sy * comp.w + sx]) {
        out[dy * TEMPLATE_W + dx] = 1;
      }
    }
  }
  return out;
}

function iou(a, b) {
  let inter = 0, union = 0;
  for (let i = 0; i < a.length; i += 1) {
    const A = a[i], B = b[i];
    if (A || B) union += 1;
    if (A && B) inter += 1;
  }
  return union ? inter / union : 0;
}

function classifyDigit(comp) {
  const normalized = normalizeComp(comp);
  let best = null, bestScore = -1;
  for (const [digit, template] of Object.entries(templates)) {
    const score = iou(normalized, template);
    if (score > bestScore) {
      best = digit;
      bestScore = score;
    }
  }
  return { digit:best, score:bestScore };
}

function lineForRow(data, imgW, panel, row) {
  const x0 = panel * PANEL_W;
  const y0 = ROW_TOP + row * ROW_H;
  const scores = Object.fromEntries(Object.keys(LINE_COLORS).map(key => [key, 0]));

  for (let y = y0; y < y0 + ROW_H; y += 2) {
    for (let x = x0; x < x0 + 250; x += 2) {
      const i = (y * imgW + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      if (max - min <= 30 || max <= 80) continue;

      for (const [key, color] of Object.entries(LINE_COLORS)) {
        const dr = r - color[0], dg = g - color[1], db = b - color[2];
        if (dr * dr + dg * dg + db * db < 625) scores[key] += 1;
      }
    }
  }

  let best = null, bestN = 0;
  for (const [key, score] of Object.entries(scores)) {
    if (score > bestN) { best = key; bestN = score; }
  }
  return bestN > 120 ? { line:best, score:bestN } : null;
}

function parseTime(data, imgW, panel, row) {
  const x0 = panel * PANEL_W + 1160;
  const y0 = ROW_TOP + row * ROW_H;
  const regionW = 200;
  const mask = makeMask(data, imgW, x0, y0, regionW, 200,
    (r,g,b) => r > 180 && g > 180 && b > 180);

  let comps = connected(mask, regionW, 200)
    .filter(comp => comp.area > 100 && comp.h >= 58)
    .sort((a,b) => a.x - b.x);

  if (comps.length) {
    comps = comps.slice(-3);
    let text = "", confidence = 1;
    const details = [];

    for (const comp of comps) {
      const q = classifyDigit(comp);
      text += q.digit;
      confidence = Math.min(confidence, q.score);
      details.push({
        digit:q.digit,
        score:+q.score.toFixed(3),
        x:comp.x + x0,
        w:comp.w,
        h:comp.h,
        area:comp.area
      });
    }

    return {
      kind:"minutes",
      value:Number(text),
      confidence:+confidence.toFixed(3),
      digitCount:comps.length,
      details
    };
  }

  const wide = makeMask(data, imgW, panel * PANEL_W + 1160, y0, 460, 200,
    (r,g,b) => r > 180 && g > 180 && b > 180);
  let amount = 0;
  for (let y = 40; y < 130; y += 1) {
    for (let x = 0; x < 460; x += 1) amount += wide[y * 460 + x];
  }
  if (amount > 1800) return { kind:"sortint", value:null, confidence:1, whitePixels:amount };
  return null;
}

function rowPlatform(data, imgW, panel, row) {
  const x0 = panel * PANEL_W + 1600;
  const y0 = ROW_TOP + row * ROW_H;
  const mask = makeMask(data, imgW, x0, y0, 280, 200,
    (r,g,b) => r > 180 && g > 180 && b > 180);
  const comps = connected(mask, 280, 200)
    .filter(comp => comp.area > 100 && comp.h > 45)
    .sort((a,b) => a.x - b.x);
  if (!comps.length) return null;

  let text = "", confidence = 1;
  const details = [];
  for (const comp of comps) {
    const q = classifyDigit(comp);
    text += q.digit;
    confidence = Math.min(confidence, q.score);
    details.push({digit:q.digit, score:+q.score.toFixed(3), w:comp.w, h:comp.h, area:comp.area});
  }
  return { value:Number(text), confidence:+confidence.toFixed(3), details };
}

function panelPlatform(data, imgW, panel) {
  const baseX = panel * PANEL_W + 1500;
  const yellow = makeMask(data, imgW, baseX, 0, 420, 200,
    (r,g,b) => r > 220 && g > 200 && b < 120);
  const big = connected(yellow, 420, 200)
    .filter(comp => comp.area > 10000 && comp.h > 150)
    .sort((a,b) => b.area - a.area)[0];
  if (!big) return null;

  const dark = makeMask(data, imgW, baseX + big.x, big.y, big.w, big.h,
    (r,g,b) => r < 100 && g < 100 && b < 100);
  for (let y = 0; y < big.h; y += 1) {
    for (let x = 0; x < big.w; x += 1) {
      if (x < 5 || y < 5 || x >= big.w - 5 || y >= big.h - 5) dark[y * big.w + x] = 0;
    }
  }

  const comp = connected(dark, big.w, big.h)
    .filter(candidate => candidate.area > 100 && candidate.h > 50)
    .sort((a,b) => b.area - a.area)[0];
  if (!comp) return null;

  const q = classifyDigit(comp);
  return { value:Number(q.digit), confidence:+q.score.toFixed(3), mode:"panel" };
}

export function parseIsicImageData(imgData) {
  const { data, width, height } = imgData;
  if (height !== PANEL_H || width % PANEL_W !== 0) {
    throw new Error(`Geometria iSIC inesperada: ${width}×${height}`);
  }

  const panels = width / PANEL_W;
  const rows = [];
  for (let panel = 0; panel < panels; panel += 1) {
    const panelVia = panelPlatform(data, width, panel);
    for (let row = 0; row < ROWS; row += 1) {
      const line = lineForRow(data, width, panel, row);
      if (!line) continue;
      const time = parseTime(data, width, panel, row);
      const platform = panelVia || rowPlatform(data, width, panel, row);
      rows.push({
        panel:panel + 1,
        row:row + 1,
        line:line.line,
        time,
        platform,
        platformMode:panelVia ? "panel" : "row"
      });
    }
  }

  return { width, height, panels, rows };
}

async function bitmapFromBlob(blob) {
  if (typeof createImageBitmap === "function") return createImageBitmap(blob);

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("No s'ha pogut decodificar la imatge iSIC")); };
    image.src = url;
  });
}

export async function fetchIsicStation(config, station, { force = false } = {}) {
  const code = String(station || "").trim().toUpperCase();
  if (!code) throw new Error("Estació iSIC buida");

  const ttl = Math.max(3000, Number(config?.cacheMs || config?.refreshMs) || 8000);
  const cached = stationImageCache.get(code);
  const now = Date.now();

  if (!force && cached?.value && now - cached.value.fetchedAt < ttl) return cached.value;
  if (cached?.promise) return cached.promise;

  const promise = (async () => {
    const proxy = String(config?.proxyUrl || "https://sim-isic-proxy2.cex447.workers.dev/");
    const url = new URL(proxy, window.location.href);
    url.searchParams.set("station", code.toLowerCase());
    url.searchParams.set("mode", "image");
    url.searchParams.set("v", String(Date.now()));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(2000, Number(config?.timeoutMs) || 7000));

    try {
      const response = await fetch(url.toString(), { cache:"no-store", signal:controller.signal });
      if (!response.ok) throw new Error(`iSIC ${code}: proxy HTTP ${response.status}`);
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error(`iSIC ${code}: resposta ${blob.type || "no imatge"}`);

      const bitmap = await bitmapFromBlob(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d", { willReadFrequently:true });
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close?.();

      const parsed = parseIsicImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
      const value = { station:code, fetchedAt:Date.now(), bytes:blob.size, ...parsed };
      stationImageCache.set(code, { value, promise:null });
      return value;
    } finally {
      clearTimeout(timeout);
    }
  })().catch(error => {
    const old = stationImageCache.get(code)?.value || null;
    stationImageCache.set(code, { value:old, promise:null, error:String(error?.message || error) });
    throw error;
  });

  stationImageCache.set(code, { value:cached?.value || null, promise });
  return promise;
}

function contextAscending(context) {
  if (typeof context?.ascending === "boolean") return context.ascending;
  const last = Number(String(context?.circulation || "").slice(-1));
  return Number.isFinite(last) ? last % 2 === 1 : null;
}

/* Política ferroviaria común SIM+ 3.31.
   - Una vía real confirmada se obtiene fuera de esta función y manda siempre.
   - Aquí sólo se describen reglas operativas inequívocas, supresiones de vía
     en terminales de recepción y, por último, el fallback 1/2 por sentido. */
export function platformPolicyFor(context) {
  const origin = String(context?.effectiveOrigin || "").toUpperCase();
  const destination = String(context?.effectiveDestination || "").toUpperCase();
  const station = String(context?.station || origin).toUpperCase();
  const line = String(context?.line || "");
  const ascending = contextAscending(context);
  const isOrigin = typeof context?.isOrigin === "boolean"
    ? context.isOrigin
    : Boolean(origin && station === origin);
  const isFinal = typeof context?.isFinal === "boolean"
    ? context.isFinal
    : Boolean(destination && station === destination);

  if (line === "L12" && station === "SR") {
    return { platform:4, source:"fixed", hard:true, reason:"L12 a SR: via 4 fixa" };
  }

  if (line === "L7" && station === "GR" && ascending !== null) {
    return {
      platform:ascending ? 3 : 4,
      source:"fixed",
      hard:true,
      reason:ascending ? "L7 ascendent a GR: via 3" : "L7 descendent a GR: via 4"
    };
  }

  if (station === "TB") {
    return { platform:1, source:"fixed", hard:true, reason:"TB: única via" };
  }

  /* Terminales de recepción: no mostramos una cifra que no podemos conocer
     con seguridad. PC descendente termina sin vía; NA/PN/RE ascendentes idem. */
  if (station === "PC" && ascending === false && isFinal) {
    return { platform:null, source:"terminal-unknown", suppress:true, reason:"PC recepció descendent: via desconeguda" };
  }
  if (["NA","PN","RE"].includes(station) && ascending === true && isFinal) {
    return { platform:null, source:"terminal-unknown", suppress:true, reason:`${station} recepció ascendent: via desconeguda` };
  }

  /* En PC sólo usamos vía de salida realmente conocida. En los terminales
     NA/PN/RE de salida descendente tampoco inventamos la vía si iSIC no la da. */
  if (station === "PC") return { platform:null, source:"no-default", reason:"PC: sense fallback de via" };
  if (["NA","PN","RE"].includes(station) && ascending === false && isOrigin) {
    return { platform:null, source:"no-default", reason:`${station}: sortida, esperar via real` };
  }

  if (ascending === null) return { platform:null, source:"no-default" };
  return {
    platform:ascending ? 1 : 2,
    source:"direction-default",
    hard:false,
    reason:ascending ? "fallback ascendent: via 1" : "fallback descendent: via 2"
  };
}

export function fixedPlatformFor(context) {
  const policy = platformPolicyFor(context);
  return policy?.hard ? policy : null;
}

export function fallbackPlatformFor(context) {
  const policy = platformPolicyFor(context);
  if (!policy || policy.hard || policy.suppress) return null;
  return normalizePlatformValue(policy.platform) === null ? null : policy;
}

export function suppressPlatformFor(context) {
  return platformPolicyFor(context)?.suppress === true;
}

function rowMinute(row) {
  if (row?.time?.kind === "sortint") return 0;
  if (row?.time?.kind === "minutes" && Number.isFinite(Number(row.time.value))) {
    return Number(row.time.value);
  }
  return null;
}

function intervalCost(expected, lo, hi) {
  if (expected < lo) return lo - expected;
  if (expected > hi) return expected - hi;
  return Math.abs(expected - (lo + hi) / 2) * 0.05;
}

export function pairAssessment(context, row, nowMs = Date.now()) {
  if (!context || context.line !== row?.line) {
    return { eligible:false, cost:Infinity, reason:"línia diferent" };
  }

  const targetMs = resolveGtfsTimestamp(context.departure, nowMs);
  const adjustment = Number(context.delayAdjustmentMinutes) || 0;
  const expected = targetMs === null ? null : (targetMs - nowMs) / 60000 + adjustment;
  const rm = rowMinute(row);

  if (expected === null || rm === null) {
    return { eligible:false, cost:Infinity, expectedMinutes:expected, rowMinutes:rm, reason:"sense referència temporal" };
  }

  const delayedOrigin = context.onTime === false && context.originHold === true;
  const overdue = expected < -0.5;
  let cost, eligible, mode, window;

  if (delayedOrigin && overdue) {
    if (row.time?.kind === "sortint") {
      cost = 0;
      eligible = true;
      window = "sortint";
    } else {
      cost = rm + 0.6;
      eligible = rm <= 5;
      window = "0–5 min per retard";
    }
    mode = "delayed-overdue";
  } else {
    let lo, hi;
    if (row.time?.kind === "sortint") {
      lo = -1.60;
      hi = 1.25;
      window = "sortint -1.60…1.25";
    } else {
      lo = rm - 0.20;
      hi = rm + 1.20;
      window = `${lo.toFixed(2)}…${hi.toFixed(2)}`;
    }
    cost = intervalCost(expected, lo, hi);
    eligible = cost <= 1.35 && expected >= -1.60;
    mode = "scheduled-window";
  }

  const platformConfidence = Number(row?.platform?.confidence ?? 0);
  const timeConfidence = Number(row?.time?.confidence ?? 0);
  const platformMinimum = row?.platformMode === "panel" ? 0.72 : 0.78;
  const platformValue = normalizePlatformValue(row?.platform?.value);
  if (platformValue === null) eligible = false;
  if (platformConfidence < platformMinimum || timeConfidence < 0.65) eligible = false;
  if (eligible && timeConfidence < 0.80) cost += 0.25;

  /* La vía habitual por sentido es una pista de matching, no una verdad:
     ayuda a no emparejar un descendente con la fila ascendente (PR1/PR2),
     pero una vía real excepcional sigue siendo elegible si es la única segura. */
  const platformHint = normalizePlatformValue(context?.platformHint);
  if (eligible && platformHint !== null && platformValue !== platformHint) cost += 1.0;

  return {
    eligible,
    cost:+Number(cost).toFixed(3),
    expectedMinutes:+Number(expected).toFixed(3),
    rowMinutes:rm,
    mode,
    window,
    platformConfidence,
    platformMinimum,
    timeConfidence
  };
}

/*
 * Assignació un-a-un. El DP usa una màscara de files i per tant escala amb
 * el nombre de files iSIC (màxim observat: 8), no amb totes les circulacions
 * candidates de l'horari.
 */
export function matchContextsToRows(contexts, rows, nowMs = Date.now()) {
  const all = (contexts || []).map((context, index) => ({
    context,
    index,
    assessments:(rows || []).map(row => pairAssessment(context, row, nowMs))
  }));

  let active = all.filter(item => item.assessments.some(a => a.eligible));
  if (active.length > 18) {
    active = active
      .map(item => ({ ...item, best:Math.min(...item.assessments.filter(a => a.eligible).map(a => a.cost)) }))
      .sort((a,b) => a.best - b.best)
      .slice(0, 18);
  }

  let states = new Map([[0, { matched:0, cost:0, assign:new Map() }]]);
  active.forEach(item => {
    const next = new Map(states);
    for (const [mask, state] of states) {
      item.assessments.forEach((assessment, rowIndex) => {
        if (!assessment.eligible || (mask & (1 << rowIndex))) return;
        const nextMask = mask | (1 << rowIndex);
        const candidate = {
          matched:state.matched + 1,
          cost:state.cost + assessment.cost,
          assign:new Map(state.assign).set(item.index, rowIndex)
        };
        const old = next.get(nextMask);
        if (!old || candidate.matched > old.matched ||
            (candidate.matched === old.matched && candidate.cost < old.cost)) {
          next.set(nextMask, candidate);
        }
      });
    }
    states = next;
  });

  let best = { matched:0, cost:Infinity, assign:new Map() };
  for (const state of states.values()) {
    if (state.matched > best.matched ||
        (state.matched === best.matched && state.cost < best.cost)) best = state;
  }

  const results = new Map();
  for (const item of all) {
    const rowIndex = best.assign.get(item.index);
    if (rowIndex === undefined) {
      results.set(item.context.key ?? item.index, { status:"no-match", platform:null });
      continue;
    }

    const chosen = item.assessments[rowIndex];
    const contextAlternatives = item.assessments
      .map((a,i) => ({ a,i }))
      .filter(x => x.i !== rowIndex && x.a.eligible)
      .sort((a,b) => a.a.cost - b.a.cost);
    const contextGap = contextAlternatives.length ? contextAlternatives[0].a.cost - chosen.cost : Infinity;

    const rowAlternatives = all
      .filter(other => other.index !== item.index && other.assessments[rowIndex]?.eligible)
      .map(other => other.assessments[rowIndex].cost)
      .sort((a,b) => a - b);
    const rowGap = rowAlternatives.length ? rowAlternatives[0] - chosen.cost : Infinity;

    const safe = contextGap >= 0.60 && rowGap >= 0.60;
    results.set(item.context.key ?? item.index, {
      status:safe ? (chosen.mode === "delayed-overdue" ? "safe-delay" : "safe") : "ambiguous",
      platform:safe ? normalizePlatformValue(rows[rowIndex].platform.value) : null,
      row:rows[rowIndex],
      assessment:chosen,
      ambiguityGap:Number.isFinite(contextGap) ? +contextGap.toFixed(3) : null,
      rowAmbiguityGap:Number.isFinite(rowGap) ? +rowGap.toFixed(3) : null
    });
  }

  return results;
}

export function matchContextToRows(context, rows, nowMs = Date.now()) {
  const key = context?.key || "single";
  const result = matchContextsToRows([{ ...context, key }], rows, nowMs).get(key);
  return result || { status:"no-match", platform:null };
}

function platformKey(tripId, station) {
  return `${String(tripId || "")}|${String(station || "").toUpperCase()}`;
}

function circulationPlatformKey(circulation, station) {
  return `${String(circulation || "").toUpperCase()}|${String(station || "").toUpperCase()}`;
}

function platformFresh(value, staleMs) {
  if (!value) return false;
  if (value.source === "fixed") return true;
  return Date.now() - value.confirmedAt <= Math.max(1000, Number(staleMs) || 30000);
}

export function rememberPlatform(tripId, station, platform, source = "isic", meta = {}) {
  const normalized = normalizePlatformValue(platform);
  if (!tripId || normalized === null) return null;
  const value = {
    tripId:String(tripId),
    station:String(station || "").toUpperCase(),
    platform:normalized,
    source,
    confirmedAt:Date.now(),
    ...meta
  };
  platformCache.set(platformKey(tripId, station), value);
  if (value.circulation) {
    circulationPlatformCache.set(circulationPlatformKey(value.circulation, station), value);
  }
  return value;
}

export function clearPlatform(tripId, station) {
  const key = platformKey(tripId, station);
  const existing = platformCache.get(key);
  platformCache.delete(key);
  if (existing?.circulation) {
    const cKey = circulationPlatformKey(existing.circulation, station);
    const shared = circulationPlatformCache.get(cKey);
    if (shared?.tripId === String(tripId)) circulationPlatformCache.delete(cKey);
  }
}

export function cachedPlatform(tripId, station, staleMs = 30000) {
  const value = platformCache.get(platformKey(tripId, station));
  return platformFresh(value, staleMs) ? value : null;
}

export function cachedPlatformByCirculation(circulation, station, staleMs = 30000) {
  const value = circulationPlatformCache.get(circulationPlatformKey(circulation, station));
  return platformFresh(value, staleMs) ? value : null;
}

export function clearAllIsicCaches() {
  stationImageCache.clear();
  platformCache.clear();
  circulationPlatformCache.clear();
}
