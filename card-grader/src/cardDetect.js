// Locate a trading card lying on a flat, contrasting surface and rectify it
// to a canonical portrait image (2.5" x 3.5" at ~300 dpi).
import { resizeRGBA, makeMask, open, close, connectedComponents, convexHull, warpQuadToRect, median, fitLine, intersectLines } from './imgproc.js';

export const CARD_W = 750;
export const CARD_H = 1050;

function estimateBackground(img) {
  // Median colour of a ring along the image border (the flat surface).
  const { w, h, data } = img;
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  const r = [], g = [], b = [];
  const push = (x, y) => { const i = (y * w + x) * 4; r.push(data[i]); g.push(data[i + 1]); b.push(data[i + 2]); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x < band || y < band || x >= w - band || y >= h - band) push(x, y);
  }
  return [median(r), median(g), median(b)];
}

function orderQuad(pts) {
  // Order as TL, TR, BR, BL using sums/differences.
  const s = pts.map(p => p.x + p.y), d = pts.map(p => p.x - p.y);
  const tl = pts[s.indexOf(Math.min(...s))], br = pts[s.indexOf(Math.max(...s))];
  const tr = pts[d.indexOf(Math.max(...d))], bl = pts[d.indexOf(Math.min(...d))];
  return [tl, tr, br, bl];
}

function quadFromHull(hull) {
  // Pick the 4 hull points that maximise the quadrilateral area (hull is small: brute force on a thinned hull).
  let pts = hull;
  if (pts.length > 40) { const step = pts.length / 40; pts = []; for (let i = 0; i < hull.length; i += step) pts.push(hull[Math.floor(i)]); }
  const n = pts.length;
  if (n < 4) return null;
  const area = (a, b, c, d) => Math.abs((a.x * b.y - b.x * a.y) + (b.x * c.y - c.x * b.y) + (c.x * d.y - d.x * c.y) + (d.x * a.y - a.x * d.y)) / 2;
  let best = 0, bq = null;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) for (let l = k + 1; l < n; l++) {
    const a = area(pts[i], pts[j], pts[k], pts[l]);
    if (a > best) { best = a; bq = [pts[i], pts[j], pts[k], pts[l]]; }
  }
  return orderQuad(bq);
}

// Fit a straight line to the boundary points lying along each side of the rough quad and intersect
// neighbouring lines. This ignores the rounded corners of a real card and the mask erosion bias.
function refineByEdgeLines(quad, boundary) {
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const sel = [];
    for (const p of boundary) {
      const t = (p.x - a.x) * ux + (p.y - a.y) * uy;
      if (t < len * 0.12 || t > len * 0.88) continue; // skip the corners
      const d = Math.abs(-(p.x - a.x) * uy + (p.y - a.y) * ux);
      if (d <= 5) sel.push(p);
    }
    if (sel.length < 10) return quad;
    // Robust: fit, drop outliers (> 1.5 px), refit.
    let l = fitLine(sel);
    const inl = sel.filter(p => Math.abs(-(p.x - l.px) * l.dy + (p.y - l.py) * l.dx) <= 1.5);
    if (inl.length >= 10) l = fitLine(inl);
    lines.push(l);
  }
  const out = [];
  for (let i = 0; i < 4; i++) {
    const p = intersectLines(lines[(i + 3) % 4], lines[i]);
    if (!p) return quad;
    out.push(p);
  }
  return out;
}

/**
 * Detect the card quad in an RGBA photo. Returns { quad:[{x,y}x4] in source coords, confidence, mask(w,h small) }
 * or null if nothing card-like was found.
 */
export function detectCardQuad(img) {
  const scale = Math.min(1, 640 / Math.max(img.w, img.h));
  const sw = Math.round(img.w * scale), sh = Math.round(img.h * scale);
  const small = scale < 1 ? resizeRGBA(img, sw, sh) : img;
  const bg = estimateBackground(small);
  const mask = makeMask(sw, sh);
  const d = small.data;
  // Colour distance from background; adaptive threshold from the distribution.
  const dist = new Float32Array(sw * sh);
  for (let i = 0, j = 0; i < sw * sh; i++, j += 4) {
    dist[i] = Math.abs(d[j] - bg[0]) + Math.abs(d[j + 1] - bg[1]) + Math.abs(d[j + 2] - bg[2]);
  }
  const sorted = Float32Array.from(dist).sort();
  const p20 = sorted[Math.floor(sorted.length * 0.2)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const thr = Math.max(30, p20 + (p95 - p20) * 0.35);
  for (let i = 0; i < dist.length; i++) mask.data[i] = dist[i] > thr ? 1 : 0;
  let m = close(open(mask, 2), 4);
  const { comps, labels } = connectedComponents(m, { keepPixels: true, minArea: 50 });
  if (!comps.length) return null;
  comps.sort((a, b) => b.area - a.area);
  const c = comps[0];
  const frac = c.area / (sw * sh);
  if (frac < 0.08) return null;
  // Boundary pixels -> hull.
  const pts = [];
  for (const p of c.pixels) {
    const x = p % sw, y = (p - x) / sw;
    if (x === 0 || y === 0 || x === sw - 1 || y === sh - 1 || labels[p - 1] !== c.id || labels[p + 1] !== c.id || labels[p - sw] !== c.id || labels[p + sw] !== c.id) pts.push({ x, y });
  }
  const hull = convexHull(pts);
  let quad = quadFromHull(hull);
  if (!quad) return null;
  quad = refineByEdgeLines(quad, pts);
  // Sanity: quad area vs component area, and aspect ratio near 2.5:3.5.
  const qa = Math.abs((quad[0].x * quad[1].y - quad[1].x * quad[0].y) + (quad[1].x * quad[2].y - quad[2].x * quad[1].y) + (quad[2].x * quad[3].y - quad[3].x * quad[2].y) + (quad[3].x * quad[0].y - quad[0].x * quad[3].y)) / 2;
  const fill = c.area / qa;
  const e = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const wEst = (e(quad[0], quad[1]) + e(quad[3], quad[2])) / 2, hEst = (e(quad[0], quad[3]) + e(quad[1], quad[2])) / 2;
  const landscape = wEst > hEst;
  const ratio = landscape ? hEst / wEst : wEst / hEst;
  const ratioErr = Math.abs(ratio - 2.5 / 3.5);
  let confidence = Math.max(0, Math.min(1, (fill - 0.7) / 0.25)) * Math.max(0, 1 - ratioErr / 0.15);
  if (landscape) quad = [quad[1], quad[2], quad[3], quad[0]];
  const full = quad.map(p => ({ x: p.x / scale, y: p.y / scale }));
  return { quad: full, confidence, fill, ratio, landscape, mask: m };
}

/**
 * Rectify photo to canonical card image. If no quad is found the whole image is used (user already cropped).
 * Returns { card: RGBA(CARD_W x CARD_H), quad, confidence, detected }
 */
export function rectifyCard(img, forcedQuad = null) {
  let det = null;
  if (forcedQuad) det = { quad: forcedQuad, confidence: 1 };
  else det = detectCardQuad(img);
  let quad, detected = true, confidence = 1;
  if (det && det.confidence > 0.25) { quad = det.quad; confidence = det.confidence; }
  else {
    detected = false; confidence = det ? det.confidence : 0;
    const landscape = img.w > img.h;
    quad = landscape
      ? [{ x: img.w, y: 0 }, { x: img.w, y: img.h }, { x: 0, y: img.h }, { x: 0, y: 0 }]
      : [{ x: 0, y: 0 }, { x: img.w, y: 0 }, { x: img.w, y: img.h }, { x: 0, y: img.h }];
  }
  // Shrink the quad by a fraction of a pixel so the background never leaks into the edge band.
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4, cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  const inset = detected ? 0.0015 : 0; // ~1 px: keeps the background out without eating edge whitening
  const q = quad.map(p => ({ x: p.x + (cx - p.x) * inset, y: p.y + (cy - p.y) * inset }));
  const card = warpQuadToRect(img, q, CARD_W, CARD_H);
  return { card, quad, confidence, detected };
}
