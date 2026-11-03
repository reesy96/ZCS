// Locate a trading card lying on a flat, contrasting surface and rectify it
// to a canonical portrait image (2.5" x 3.5" at ~300 dpi).
import { resizeRGBA, makeMask, makeGray, open, close, connectedComponents, convexHull, warpQuadToRect, median, fitLine, intersectLines, toGray, gaussianBlur, sobel, percentile, nmsAcrossLines, houghSegments } from './imgproc.js';

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

// ---------------------------------------------------------------- edge based detection
// Independent of background colour and shadows: find long straight edges and the quadrilateral with
// the card's aspect ratio that they best explain.
function lineOf(seg) { const dx = seg.x1 - seg.x0, dy = seg.y1 - seg.y0, l = Math.hypot(dx, dy) || 1; return { px: seg.x0, py: seg.y0, dx: dx / l, dy: dy / l, nx: -dy / l, ny: dx / l }; }
function angleDiff(a, b) { let d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); }
function quadArea(q) { let a = 0; for (let i = 0; i < 4; i++) { const p = q[i], r = q[(i + 1) % 4]; a += p.x * r.y - r.x * p.y; } return a / 2; }
function sideCoverage(seg, a, b) {
  // Fraction of side a->b covered by the projection of the segment onto it.
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1; const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
  const t0 = (seg.x0 - a.x) * ux + (seg.y0 - a.y) * uy, t1 = (seg.x1 - a.x) * ux + (seg.y1 - a.y) * uy;
  const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(L, Math.max(t0, t1));
  return Math.max(0, hi - lo) / L;
}

// Move each side of the quad outward to the outermost strong parallel edge nearby, so a side that
// snapped to the printed inner frame ends up on the physical card edge.
function refineOutward(quad, mag, sw, sh, thr) {
  const S = Math.min(Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y), Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y));
  const maxOff = Math.max(3, Math.round(S * 0.08));
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4];
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1; const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
    const nx = uy, ny = -ux; // outward for a clockwise quad in image coordinates
    const prof = [];
    for (let d = -maxOff; d <= maxOff; d++) {
      let s = 0, n = 0;
      for (let t = L * 0.1; t <= L * 0.9; t += 2) {
        const x = Math.round(a.x + ux * t + nx * d), y = Math.round(a.y + uy * t + ny * d);
        if (x < 0 || y < 0 || x >= sw || y >= sh) continue;
        s += mag.data[y * sw + x]; n++;
      }
      prof.push(n ? s / n : 0);
    }
    let bestD = 0;
    // Outermost local maximum that stands out from its surroundings on both sides (an edge, not texture)
    // and has a quiet gap between it and the current side (the plain card border).
    for (let k = prof.length - 1; k > maxOff; k--) {
      const v = prof[k];
      const isMax = v >= prof[k - 1] && (k === prof.length - 1 || v >= prof[k + 1]);
      if (!isMax || v < 15) continue;
      const beyond = prof.slice(k + 3, k + 8); const qb = beyond.length ? median(beyond) : 0;
      const gap = prof.slice(maxOff + 4, k - 2); const qg = gap.length ? median(gap) : 0;
      if (globalThis.CARD_DEBUG) console.log('  side', i, 'cand d', k - maxOff, 'v', v.toFixed(0), 'beyond', qb.toFixed(0), 'gap', qg.toFixed(0), 'gapLen', gap.length);
      if (gap.length < 2 || v < 1.5 * qb || v < 1.6 * qg) continue;
      bestD = k - maxOff; break;
    }
    if (globalThis.CARD_DEBUG) console.log('side', i, 'moved by', bestD, 'profile', Array.from(prof).map(v => v.toFixed(0)).join(' '));
    lines.push({ px: a.x + nx * bestD, py: a.y + ny * bestD, dx: ux, dy: uy });
  }
  const out = [];
  for (let i = 0; i < 4; i++) { const p = intersectLines(lines[(i + 3) % 4], lines[i]); if (!p) return quad; out.push(p); }
  return orderQuad(out);
}

// Final sub-pixel refinement at full resolution: slide each side across +-2% of the card and lock onto the
// nearest gradient peak (parabolic interpolation). Needed because centering is measured in single pixels.
function refineFullRes(quad, img) {
  const { w, h, data } = img;
  const lum = (x, y) => { const xi = Math.min(w - 1, Math.max(0, Math.round(x))), yi = Math.min(h - 1, Math.max(0, Math.round(y))); const i = (yi * w + xi) * 4; return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; };
  const S = Math.min(Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y), Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y));
  const R = Math.max(6, Math.round(S * 0.06)); // wide enough to reach from the printed frame to the card edge
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4];
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1; const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L; const nx = uy, ny = -ux;
    const pts = [], near = [];
    const step = Math.max(2, Math.floor(L / 80));
    for (let t = L * 0.08; t <= L * 0.92; t += step) {
      // Gradient profile across the side at this position. The printed frame is always inside the card and
      // only background lies outside, so the OUTERMOST clear peak is the physical edge; the nearest peak is
      // kept as a fallback when the outermost choices do not agree along the side.
      const prof = new Float64Array(2 * R + 1);
      let pmax = 0;
      for (let d = -R; d <= R; d++) { const x = a.x + ux * t + nx * d, y = a.y + uy * t + ny * d; prof[d + R] = Math.abs(lum(x + 1.5 * nx, y + 1.5 * ny) - lum(x - 1.5 * nx, y - 1.5 * ny)); pmax = Math.max(pmax, prof[d + R]); }
      if (pmax < 10) continue;
      // Nearest peak is judged inside a narrow window (+-3%) against that window's own maximum, so the strong
      // printed frame further inside cannot veto a weak physical edge.
      const Rn = Math.max(4, Math.round(S * 0.03));
      let pmaxNear = 0; for (let j = R - Rn; j <= R + Rn; j++) pmaxNear = Math.max(pmaxNear, prof[j]);
      let kOut = -1, kNear = -1, bestDist = Infinity;
      for (let j = 1; j < prof.length - 1; j++) {
        if (!(prof[j] >= prof[j - 1] && prof[j] >= prof[j + 1])) continue;
        const v = prof[j];
        if (Math.abs(j - R) <= Rn && v >= Math.max(10, 0.25 * pmaxNear)) { const dist = Math.abs(j - R); if (dist < bestDist) { bestDist = dist; kNear = j; } }
        if (v < Math.max(10, 0.2 * pmax)) continue;
        const beyond = []; for (let q = j + 3; q <= Math.min(prof.length - 1, j + 8); q++) beyond.push(prof[q]);
        const qb = beyond.length ? beyond.reduce((s2, v2) => s2 + v2, 0) / beyond.length : 0;
        if (beyond.length && qb > 0.8 * v) continue;
        kOut = j; // keep the last (outermost) qualifying peak
      }
      const sub = (k) => { let d = k - R; const y0 = prof[k - 1], y1 = prof[k], y2 = prof[k + 1]; const den = y0 - 2 * y1 + y2; if (den < 0) d += 0.5 * (y0 - y2) / den; return d; };
      if (kOut >= 0) { const d = sub(kOut); pts.push({ x: a.x + ux * t + nx * d, y: a.y + uy * t + ny * d }); }
      if (kNear >= 0) { const d = sub(kNear); near.push({ x: a.x + ux * t + nx * d, y: a.y + uy * t + ny * d }); }
    }
    const fitRobust = (P) => { let l = fitLine(P); const resid = p => Math.abs(-(p.x - l.px) * l.dy + (p.y - l.py) * l.dx); const inl = P.filter(p => resid(p) <= 2.5); return { l: inl.length >= 8 ? fitLine(inl) : l, frac: inl.length / P.length }; };
    // The coarse stage already sits close to the physical edge: the nearest clear peak is the primary choice;
    // the outermost peak is the fallback when the nearest choices disagree along the side.
    let chosen = near.length >= 8 ? fitRobust(near) : null;
    let used = 'near';
    if (!chosen || chosen.frac < 0.6) { const alt = pts.length >= 8 ? fitRobust(pts) : null; if (alt && (!chosen || alt.frac > chosen.frac)) { chosen = alt; used = 'outer'; } }
    if (globalThis.CARD_DEBUG) console.log('fullres side', i, 'outer pts', pts.length, 'frac', chosen && chosen.frac.toFixed(2), 'near pts', near.length, 'used', used, 'R', R);
    // When the per-position picks do not agree (weak edge on a textured background) the coarse line is the
    // better estimate: keep it rather than fitting noise.
    if (!chosen) { lines.push({ px: a.x, py: a.y, dx: ux, dy: uy }); continue; }
    lines.push(chosen.l);
  }
  const out = [];
  for (let i = 0; i < 4; i++) { const p = intersectLines(lines[(i + 3) % 4], lines[i]); if (!p) return quad; out.push(p); }
  return orderQuad(out);
}

export function detectCardQuadEdges(img) {
  const scale = Math.min(1, 640 / Math.max(img.w, img.h));
  const sw = Math.round(img.w * scale), sh = Math.round(img.h * scale);
  const small = scale < 1 ? resizeRGBA(img, sw, sh) : img;
  const g = gaussianBlur(toGray(small), 1.2);
  const { mag, gx, gy } = sobel(g);
  const ang = new Float32Array(sw * sh);
  for (let i = 0; i < ang.length; i++) ang[i] = Math.atan2(gy.data[i], gx.data[i]) + Math.PI / 2; // ridge (edge) direction
  const samples = []; for (let i = 0; i < mag.data.length; i += 7) samples.push(mag.data[i]);
  const box = { x: 1, y: 1, w: sw - 2, h: sh - 2 };
  const nms = nmsAcrossLines(mag, ang, box);
  const minSide = Math.min(sw, sh);
  // Strong edges first (busy backgrounds such as wood grain stay out); only if nothing convincing comes out,
  // admit weaker edges (a yellow or silver border on white paper).
  const thrStrong = Math.max(25, percentile(samples, 0.93)), thrWeak = Math.max(25, percentile(samples, 0.85));
  const strong = bestQuadFromEdges(nms, box, thrStrong, ang, sw, sh, minSide);
  let best = strong, usedThr = thrStrong;
  if (!strong || strong.score < 0.6) {
    const weak = bestQuadFromEdges(nms, box, thrWeak, ang, sw, sh, minSide);
    // Weaker edges win only when they reveal a clearly bigger card-shaped rectangle (the real outer edge
    // of a pale border) or when the strong pass found nothing convincing.
    if (weak && (!strong || weak.score > strong.score + 0.2 || (weak.score > strong.score + 0.03 && weak.area > strong.area * 1.1))) { best = weak; usedThr = thrWeak; }
    if (globalThis.CARD_DEBUG) console.log('strong', strong && strong.score.toFixed(2), strong && (100 * strong.area / (sw * sh)).toFixed(0) + '%', 'weak', weak && weak.score.toFixed(2), weak && (100 * weak.area / (sw * sh)).toFixed(0) + '%', 'chosen', best === weak ? 'weak' : 'strong');
  }
  if (!best) return null;
  let quad = refineOutward(best.quad, mag, sw, sh, usedThr);
  {
    const e = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const wEst = (e(quad[0], quad[1]) + e(quad[3], quad[2])) / 2, hEst = (e(quad[0], quad[3]) + e(quad[1], quad[2])) / 2;
    best.landscape = wEst > hEst; best.ratio = Math.min(wEst, hEst) / Math.max(wEst, hEst);
    best.score = best.meanCov * Math.max(0, 1 - Math.abs(best.ratio - 2.5 / 3.5) / 0.12);
  }
  if (best.landscape) quad = [quad[1], quad[2], quad[3], quad[0]];
  let full = quad.map(p => ({ x: p.x / scale, y: p.y / scale }));
  if (globalThis.CARD_DEBUG) console.log('before full-res', full.map(p => [p.x.toFixed(1), p.y.toFixed(1)]));
  if (scale < 1) full = refineFullRes(full, img);
  if (globalThis.CARD_DEBUG) console.log('after full-res ', full.map(p => [p.x.toFixed(1), p.y.toFixed(1)]));
  return { quad: full, confidence: Math.min(1, best.score), method: 'edges', ratio: best.ratio, landscape: best.landscape };
}

function bestQuadFromEdges(nms, box, thr, ang, sw, sh, minSide) {
  const segs = houghSegments(nms, box, { thr, minLen: Math.round(minSide * 0.12), tol: 2, maxGap: 12, maxSegments: 60, ang, angTol: 10 }).filter(sg => sg.support >= 0.45);
  if (globalThis.CARD_DEBUG) { console.log('edge thr', thr.toFixed(0), 'segments', segs.length); for (const sg of segs.slice(0, 30)) console.log('  seg', Math.round(sg.x0), Math.round(sg.y0), '->', Math.round(sg.x1), Math.round(sg.y1), 'len', Math.round(sg.length), 'sup', sg.support.toFixed(2), 'amp', sg.amp.toFixed(0)); }
  const lines = segs.map(sg => ({ sg, ln: lineOf(sg), ang: Math.atan2(sg.y1 - sg.y0, sg.x1 - sg.x0) }));
  const pairs = [];
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const a = lines[i], b = lines[j];
    if (angleDiff(a.ang, b.ang) > 8 * Math.PI / 180) continue;
    const dist = Math.abs((b.sg.cx - a.sg.cx) * a.ln.nx + (b.sg.cy - a.sg.cy) * a.ln.ny);
    if (dist < minSide * 0.12) continue;
    pairs.push({ a, b, ang: a.ang });
  }
  let best = null;
  for (const P of pairs) for (const Q of pairs) {
    if (P === Q) continue;
    const d = angleDiff(P.ang, Q.ang);
    if (Math.abs(d - Math.PI / 2) > 10 * Math.PI / 180) continue;
    const corners = [intersectLines(P.a.ln, Q.a.ln), intersectLines(Q.a.ln, P.b.ln), intersectLines(P.b.ln, Q.b.ln), intersectLines(Q.b.ln, P.a.ln)];
    if (corners.some(c => !c)) continue;
    const quad = orderQuad(corners);
    const area = Math.abs(quadArea(quad));
    if (area < 0.03 * sw * sh) continue;
    if (quad.some(c => c.x < -0.05 * sw || c.y < -0.05 * sh || c.x > 1.05 * sw || c.y > 1.05 * sh)) continue;
    const sides = [[quad[0], quad[1]], [quad[1], quad[2]], [quad[2], quad[3]], [quad[3], quad[0]]];
    const cov = [P.a, P.b, Q.a, Q.b].map(L => Math.max(...sides.map(([a, b]) => angleDiff(L.ang, Math.atan2(b.y - a.y, b.x - a.x)) < 0.2 ? sideCoverage(L.sg, a, b) : 0)));
    const meanCov = cov.reduce((s, v) => s + v, 0) / 4, minCov = Math.min(...cov);
    if (minCov < 0.12 || meanCov < 0.45) continue; // one side may be weak (silver border on white paper)
    const e = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const wEst = (e(quad[0], quad[1]) + e(quad[3], quad[2])) / 2, hEst = (e(quad[0], quad[3]) + e(quad[1], quad[2])) / 2;
    const ratio = Math.min(wEst, hEst) / Math.max(wEst, hEst);
    const aspectFit = Math.max(0, 1 - Math.abs(ratio - 2.5 / 3.5) / 0.12);
    if (aspectFit <= 0) continue;
    // The card is the largest well-supported rectangle with card proportions: weight by relative area so a
    // sub-rectangle (text box to bottom edge) with coincidentally similar proportions does not win.
    const score = meanCov * aspectFit * Math.sqrt(area / (sw * sh));
    if (globalThis.CARD_DEBUG && score > 0.15) console.log('  cand score', score.toFixed(2), 'cov', meanCov.toFixed(2), 'min', minCov.toFixed(2), 'aspect', ratio.toFixed(3), 'area%', (100 * area / (sw * sh)).toFixed(0), 'quad', quad.map(p => [Math.round(p.x), Math.round(p.y)]).join(' '));
    if (!best || score > best.score) best = { score, area, quad, landscape: wEst > hEst, ratio, meanCov, aspectFit };
  }
  return best;
}

/**
 * Detect the card quad in an RGBA photo. Returns { quad:[{x,y}x4] in source coords, confidence, mask(w,h small) }
 * or null if nothing card-like was found.
 */
export function detectCardQuadColour(img) {
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
  return { quad: full, confidence, fill, ratio, landscape, mask: m, method: 'colour' };
}

export function detectCardQuad(img) {
  let edges = null, colour = null;
  try { edges = detectCardQuadEdges(img); } catch { edges = null; }
  if (edges && edges.confidence >= 0.45) return edges;
  try { colour = detectCardQuadColour(img); } catch { colour = null; }
  if (edges && colour) return colour.confidence > edges.confidence + 0.2 ? colour : edges;
  return edges || colour;
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
