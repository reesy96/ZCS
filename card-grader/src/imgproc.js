// Minimal dependency-free image processing used by the card grader.
// Images are plain objects:
//   RGBA: { w, h, data: Uint8ClampedArray }  (same layout as canvas ImageData)
//   Gray: { w, h, data: Float32Array }       (0..255)
//   Mask: { w, h, data: Uint8Array }         (0/1)

export function makeGray(w, h) {
  return { w, h, data: new Float32Array(w * h) };
}
export function makeMask(w, h) {
  return { w, h, data: new Uint8Array(w * h) };
}
export function makeRGBA(w, h) {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}

export function toGray(img) {
  const { w, h, data } = img;
  const out = makeGray(w, h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    out.data[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  }
  return out;
}

// Returns {sat(0..1), val(0..255)} arrays for an RGBA image (hue is not needed by the analyzers).
export function toHSV(img) {
  const { w, h, data } = img;
  const n = w * h;
  const sat = new Float32Array(n), val = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = data[j], g = data[j + 1], b = data[j + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const d = mx - mn;
    val[i] = mx;
    sat[i] = mx === 0 ? 0 : d / mx;
  }
  return { w, h, sat, val };
}

function reflect(i, n) {
  if (n === 1) return 0;
  while (i < 0 || i >= n) { if (i < 0) i = -i; if (i >= n) i = 2 * n - i - 2; }
  return i;
}

// Separable Gaussian blur on Gray.
export function gaussianBlur(src, sigma) {
  if (sigma <= 0) return { w: src.w, h: src.h, data: Float32Array.from(src.data) };
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const { w, h } = src;
  const tmp = new Float32Array(w * h);
  const out = makeGray(w, h);
  const d = src.data;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        acc += d[row + reflect(x + i, w)] * k[i + r];
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        acc += tmp[reflect(y + i, h) * w + x] * k[i + r];
      }
      out.data[y * w + x] = acc;
    }
  }
  return out;
}

export function subtract(a, b) {
  const out = makeGray(a.w, a.h);
  for (let i = 0; i < out.data.length; i++) out.data[i] = a.data[i] - b.data[i];
  return out;
}

// Box filter mean and standard deviation of a Gray image (window radius r).
export function localStats(src, r) {
  const { w, h, data } = src;
  const I = new Float64Array((w + 1) * (h + 1));
  const I2 = new Float64Array((w + 1) * (h + 1));
  for (let y = 1; y <= h; y++) {
    let rs = 0, rs2 = 0;
    for (let x = 1; x <= w; x++) {
      const v = data[(y - 1) * w + (x - 1)];
      rs += v; rs2 += v * v;
      I[y * (w + 1) + x] = I[(y - 1) * (w + 1) + x] + rs;
      I2[y * (w + 1) + x] = I2[(y - 1) * (w + 1) + x] + rs2;
    }
  }
  const mean = makeGray(w, h), std = makeGray(w, h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const n = (y1 - y0) * (x1 - x0);
      const s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
      const s2 = I2[y1 * (w + 1) + x1] - I2[y0 * (w + 1) + x1] - I2[y1 * (w + 1) + x0] + I2[y0 * (w + 1) + x0];
      const m = s / n;
      mean.data[y * w + x] = m;
      std.data[y * w + x] = Math.sqrt(Math.max(0, s2 / n - m * m));
    }
  }
  return { mean, std };
}

export function sobel(src) {
  const { w, h, data } = src;
  const mag = makeGray(w, h), gx = makeGray(w, h), gy = makeGray(w, h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = data[i - w - 1], b = data[i - w], c = data[i - w + 1];
      const d = data[i - 1], f = data[i + 1];
      const g = data[i + w - 1], hh = data[i + w], k = data[i + w + 1];
      const sx = (c + 2 * f + k) - (a + 2 * d + g);
      const sy = (g + 2 * hh + k) - (a + 2 * b + c);
      gx.data[i] = sx; gy.data[i] = sy;
      mag.data[i] = Math.hypot(sx, sy);
    }
  }
  return { mag, gx, gy };
}

export function threshold(src, t, above = true) {
  const out = makeMask(src.w, src.h);
  const d = src.data;
  for (let i = 0; i < d.length; i++) out.data[i] = (above ? d[i] > t : d[i] < t) ? 1 : 0;
  return out;
}

export function otsu(src, mask) {
  const hist = new Float64Array(256);
  const d = src.data;
  let total = 0;
  for (let i = 0; i < d.length; i++) {
    if (mask && !mask.data[i]) continue;
    const v = Math.max(0, Math.min(255, Math.round(d[i])));
    hist[v]++; total++;
  }
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, bestT = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (wB === 0) continue;
    const wF = total - wB; if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; bestT = t; }
  }
  return bestT;
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const arr = Float32Array.from(values).sort();
  const idx = Math.min(arr.length - 1, Math.max(0, Math.floor(p * (arr.length - 1))));
  return arr[idx];
}

export function median(values) { return percentile(values, 0.5); }

function morph(mask, r, dilate) {
  const { w, h, data } = mask;
  const tmp = new Uint8Array(w * h);
  const out = makeMask(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = dilate ? 0 : 1;
    for (let i = -r; i <= r; i++) {
      const xx = x + i; if (xx < 0 || xx >= w) { if (!dilate) v = 0; continue; }
      const p = data[y * w + xx];
      if (dilate) { if (p) { v = 1; break; } } else if (!p) { v = 0; break; }
    }
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = dilate ? 0 : 1;
    for (let i = -r; i <= r; i++) {
      const yy = y + i; if (yy < 0 || yy >= h) { if (!dilate) v = 0; continue; }
      const p = tmp[yy * w + x];
      if (dilate) { if (p) { v = 1; break; } } else if (!p) { v = 0; break; }
    }
    out.data[y * w + x] = v;
  }
  return out;
}
export const dilate = (m, r) => morph(m, r, true);
export const erode = (m, r) => morph(m, r, false);
export const open = (m, r) => dilate(erode(m, r), r);
export const close = (m, r) => erode(dilate(m, r), r);

// 8-connected components. Returns { labels: Int32Array, comps: [{id,area,minX,minY,maxX,maxY,cx,cy,pixels?}] }
export function connectedComponents(mask, { keepPixels = false, minArea = 1 } = {}) {
  const { w, h, data } = mask;
  const labels = new Int32Array(w * h);
  const comps = [];
  const stack = new Int32Array(w * h);
  let next = 1;
  for (let s = 0; s < w * h; s++) {
    if (!data[s] || labels[s]) continue;
    let sp = 0; stack[sp++] = s; labels[s] = next;
    let area = 0, minX = w, minY = h, maxX = -1, maxY = -1, sx = 0, sy = 0;
    const pixels = keepPixels ? [] : null;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w, y = (p - x) / w;
      area++; sx += x; sy += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (pixels) pixels.push(p);
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (data[q] && !labels[q]) { labels[q] = next; stack[sp++] = q; }
        }
      }
    }
    if (area >= minArea) comps.push({ id: next, area, minX, minY, maxX, maxY, cx: sx / area, cy: sy / area, pixels });
    next++;
  }
  return { labels, comps };
}

// Principal-axis fit for a component: returns length, width, angle(rad), straightness (0..1)
export function lineFit(pixels, w) {
  const n = pixels.length;
  let sx = 0, sy = 0;
  for (const p of pixels) { sx += p % w; sy += Math.floor(p / w); }
  const cx = sx / n, cy = sy / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pixels) {
    const dx = p % w - cx, dy = Math.floor(p / w) - cy;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  sxx /= n; syy /= n; sxy /= n;
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(0, tr / 2 - disc);
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  // Project pixels to major axis to get extent.
  const ux = Math.cos(angle), uy = Math.sin(angle);
  let mn = Infinity, mx = -Infinity, mnp = Infinity, mxp = -Infinity;
  for (const p of pixels) {
    const dx = p % w - cx, dy = Math.floor(p / w) - cy;
    const t = dx * ux + dy * uy, q = -dx * uy + dy * ux;
    if (t < mn) mn = t; if (t > mx) mx = t; if (q < mnp) mnp = q; if (q > mxp) mxp = q;
  }
  const length = mx - mn + 1, width = mxp - mnp + 1;
  const straightness = l1 > 0 ? 1 - Math.sqrt(l2 / l1) : 1;
  return { cx, cy, angle, length, width, straightness, x0: cx + ux * mn, y0: cy + uy * mn, x1: cx + ux * mx, y1: cy + uy * mx };
}

// ---------- geometry ----------

// Solve 8x8 linear system via Gaussian elimination with partial pivoting.
function solve(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const pv = M[c][c];
    if (Math.abs(pv) < 1e-12) throw new Error('singular');
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / pv;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

// Homography mapping src[i] -> dst[i] (4 points each, {x,y}). Returns 3x3 row-major array.
export function findHomography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const hh = solve(A, b);
  return [...hh, 1];
}

export function invert3x3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

export function applyH(H, x, y) {
  const d = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / d, y: (H[3] * x + H[4] * y + H[5]) / d };
}

// Warp RGBA source so that quad (4 points in src, TL,TR,BR,BL) maps to the full output rect.
export function warpQuadToRect(src, quad, outW, outH) {
  const dst = [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }];
  const H = findHomography(dst, quad); // output -> input
  const out = makeRGBA(outW, outH);
  const { w, h, data } = src;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const p = applyH(H, x + 0.5, y + 0.5);
      const sx = p.x - 0.5, sy = p.y - 0.5;
      const o = (y * outW + x) * 4;
      if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) { out.data[o + 3] = 255; continue; }
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * w + x0) * 4, i01 = i00 + 4, i10 = i00 + w * 4, i11 = i10 + 4;
      for (let c = 0; c < 3; c++) {
        out.data[o + c] = (data[i00 + c] * (1 - fx) + data[i01 + c] * fx) * (1 - fy) + (data[i10 + c] * (1 - fx) + data[i11 + c] * fx) * fy;
      }
      out.data[o + 3] = 255;
    }
  }
  return out;
}

// Nearest/bilinear resize of RGBA.
export function resizeRGBA(src, outW, outH) {
  const out = makeRGBA(outW, outH);
  const { w, h, data } = src;
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(h - 1, (y + 0.5) * h / outH - 0.5);
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(h - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(w - 1, (x + 0.5) * w / outW - 0.5);
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0;
      const o = (y * outW + x) * 4;
      for (let c = 0; c < 4; c++) {
        const a = data[(y0 * w + x0) * 4 + c], b = data[(y0 * w + x1) * 4 + c];
        const cc = data[(y1 * w + x0) * 4 + c], d = data[(y1 * w + x1) * 4 + c];
        out.data[o + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy;
      }
    }
  }
  return out;
}

export function cropRGBA(src, x, y, cw, ch) {
  const out = makeRGBA(cw, ch);
  for (let yy = 0; yy < ch; yy++) {
    const sy = Math.min(src.h - 1, Math.max(0, y + yy));
    for (let xx = 0; xx < cw; xx++) {
      const sx = Math.min(src.w - 1, Math.max(0, x + xx));
      const s = (sy * src.w + sx) * 4, o = (yy * cw + xx) * 4;
      out.data[o] = src.data[s]; out.data[o + 1] = src.data[s + 1]; out.data[o + 2] = src.data[s + 2]; out.data[o + 3] = 255;
    }
  }
  return out;
}

// Convex hull (monotone chain) of points [{x,y}].
export function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

// Convert a Gray image to RGBA for display (with optional scaling to 0..255 range).
export function grayToRGBA(g, { min = 0, max = 255 } = {}) {
  const out = makeRGBA(g.w, g.h);
  const s = 255 / (max - min || 1);
  for (let i = 0, j = 0; i < g.data.length; i++, j += 4) {
    const v = Math.max(0, Math.min(255, (g.data[i] - min) * s));
    out.data[j] = out.data[j + 1] = out.data[j + 2] = v; out.data[j + 3] = 255;
  }
  return out;
}

// Oriented line filter: for each pixel inside `box`, the mean of `src` sampled along a line of `length`
// pixels through the pixel, for `nAngles` orientations. Returns the orientation with the largest
// absolute response. Random dots average out while a straight scratch/crease keeps its full amplitude.
export function orientedLineResponse(src, box, { length = 15, nAngles = 12 } = {}) {
  const { w, h, data } = src;
  const resp = makeGray(w, h);
  const ang = new Float32Array(w * h);
  const half = Math.floor(length / 2);
  const dirs = [];
  for (let a = 0; a < nAngles; a++) { const t = Math.PI * a / nAngles; dirs.push([Math.cos(t), Math.sin(t), t]); }
  const x0 = Math.max(0, box.x), y0 = Math.max(0, box.y), x1 = Math.min(w, box.x + box.w), y1 = Math.min(h, box.y + box.h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    let best = 0, bestA = 0;
    for (const [dx, dy, t] of dirs) {
      let s = 0, n = 0;
      for (let k = -half; k <= half; k++) {
        const xx = Math.round(x + dx * k), yy = Math.round(y + dy * k);
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        s += data[yy * w + xx]; n++;
      }
      const m = n ? s / n : 0;
      if (Math.abs(m) > Math.abs(best)) { best = m; bestA = t; }
    }
    resp.data[y * w + x] = best; ang[y * w + x] = bestA;
  }
  return { resp, ang };
}

// Least-squares line through points -> {px,py,dx,dy} (point + unit direction).
export function fitLine(pts) {
  const n = pts.length;
  let sx = 0, sy = 0; for (const p of pts) { sx += p.x; sy += p.y; }
  const cx = sx / n, cy = sy / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) { const dx = p.x - cx, dy = p.y - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const t = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { px: cx, py: cy, dx: Math.cos(t), dy: Math.sin(t) };
}
export function intersectLines(a, b) {
  const den = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / den;
  return { x: a.px + a.dx * t, y: a.py + a.dy * t };
}

// Non-maximum suppression across the detected orientation: keeps the ridge of a line response.
export function nmsAcrossLines(resp, ang, box) {
  const { w, h } = resp;
  const out = makeGray(w, h);
  const x0 = Math.max(1, box.x), y0 = Math.max(1, box.y), x1 = Math.min(w - 1, box.x + box.w), y1 = Math.min(h - 1, box.y + box.h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * w + x;
    const v = Math.abs(resp.data[i]); if (v === 0) continue;
    const t = ang[i];
    // perpendicular direction
    const px = Math.round(-Math.sin(t)), py = Math.round(Math.cos(t));
    // Only neighbours with the same sign compete: a bipolar pair (light/dark ridge of a crease) must survive.
    const same = (xx, yy) => { if (xx < 0 || yy < 0 || xx >= w || yy >= h) return 0; const q = resp.data[yy * w + xx]; return Math.sign(q) === Math.sign(resp.data[i]) ? Math.abs(q) : 0; };
    const a = same(x + px, y + py), b = same(x - px, y - py);
    const c = same(x + 2 * px, y + 2 * py), d = same(x - 2 * px, y - 2 * py);
    if (v >= a && v >= b && v >= c && v >= d) out.data[i] = resp.data[i];
  }
  return out;
}

export function downsample2(g) {
  const w = Math.floor(g.w / 2), h = Math.floor(g.h / 2);
  const out = makeGray(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (2 * y) * g.w + 2 * x;
    out.data[y * w + x] = (g.data[i] + g.data[i + 1] + g.data[i + g.w] + g.data[i + g.w + 1]) / 4;
  }
  return out;
}

// Hough-style straight segment extraction from a sparse ridge map (Gray, non-zero = candidate).
// Robust to fragmented ridges: pixels vote for (theta, rho) lines, the best line is traced for its
// longest continuous run (gaps up to maxGap), the run's pixels are removed and the search repeats.
export function houghSegments(ridge, box, { thr = 0, minLen = 50, tol = 2.5, maxGap = 8, maxSegments = 8, angleStep = 1, ang = null, angTol = 22 } = {}) {
  const { w, h } = ridge;
  let pts = [];
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
    const v = ridge.data[y * w + x]; if (Math.abs(v) > thr) pts.push({ x, y, v, a: ang ? ang[y * w + x] * 180 / Math.PI : null });
  }
  // Orientation of a pixel's ridge must agree with the line it supports (kills collinear corners of grids/text).
  // theta is the line's normal angle; the pixel's ridge direction must match the line direction theta + 90.
  const angOk = (p, theta) => { if (p.a === null) return true; let d = Math.abs(((p.a % 180) + 180) % 180 - ((theta + 90) % 180)); if (d > 90) d = 180 - d; return d <= angTol; };
  const nAng = Math.round(180 / angleStep);
  const cosT = new Float64Array(nAng), sinT = new Float64Array(nAng);
  for (let a = 0; a < nAng; a++) { const t = a * angleStep * Math.PI / 180; cosT[a] = Math.cos(t); sinT[a] = Math.sin(t); }
  const diag = Math.ceil(Math.hypot(w, h));
  const nRho = 2 * diag + 1;
  const segments = [];
  const acc = new Int32Array(nAng * nRho);
  const vote = (p, sgn) => { for (let a = 0; a < nAng; a++) { if (!angOk(p, a * angleStep)) continue; const rho = Math.round(p.x * cosT[a] + p.y * sinT[a]) + diag; acc[a * nRho + rho] += sgn; } };
  for (const p of pts) vote(p, 1);
  void angOk;
  const banned = new Uint8Array(acc.length);
  const banAround = (a, rhoIdx) => {
    for (let da = -2; da <= 2; da++) {
      const aa = (a + da + nAng) % nAng;
      for (let dr = -Math.ceil(tol); dr <= Math.ceil(tol); dr++) { const ri = rhoIdx + dr; if (ri >= 0 && ri < nRho) banned[aa * nRho + ri] = 1; }
    }
  };
  for (let iter = 0; iter < 150 && segments.length < maxSegments; iter++) {
    let best = -1, bi = -1;
    for (let i = 0; i < acc.length; i++) if (acc[i] > best && !banned[i]) { best = acc[i]; bi = i; }
    if (best < minLen * 0.5) break;
    const a = Math.floor(bi / nRho), rhoIdx = bi % nRho, rho = rhoIdx - diag;
    banAround(a, rhoIdx);
    // Line: x cos t + y sin t = rho; direction along the line = (-sin t, cos t).
    const dx = -sinT[a], dy = cosT[a];
    const near = [];
    const theta = a * angleStep;
    for (const p of pts) {
      if (!angOk(p, theta)) continue;
      const d = Math.abs(p.x * cosT[a] + p.y * sinT[a] - rho);
      if (d <= tol) near.push({ p, t: p.x * dx + p.y * dy });
    }
    near.sort((u, v) => u.t - v.t);
    // Longest run with gaps <= maxGap.
    let runStart = 0, bestRun = [0, 0];
    for (let i = 1; i <= near.length; i++) {
      if (i === near.length || near[i].t - near[i - 1].t > maxGap) {
        if (near[i - 1].t - near[runStart].t > near[bestRun[1]].t - near[bestRun[0]].t) bestRun = [runStart, i - 1];
        runStart = i;
      }
    }
    const run = near.slice(bestRun[0], bestRun[1] + 1);
    const length = run.length ? run[run.length - 1].t - run[0].t + 1 : 0;
    if (length < minLen || run.length < 0.4 * length) continue;
    const px = rho * cosT[a], py = rho * sinT[a];
    const t0 = run[0].t, t1 = run[run.length - 1].t;
    let amp = 0; for (const r of run) amp += Math.abs(r.p.v); amp /= run.length;
    const angle = Math.atan2(dy, dx);
    const seg = { x0: px + dx * t0, y0: py + dy * t0, x1: px + dx * t1, y1: py + dy * t1, length, angle, amp, support: Math.min(1, run.length / length), pixels: run.map(r => r.p.y * w + r.p.x), theta: a * angleStep, rho, t0, t1 };
    seg.cx = (seg.x0 + seg.x1) / 2; seg.cy = (seg.y0 + seg.y1) / 2;
    // Duplicate of an existing segment (same line, overlapping extent)? Keep the longer one.
    const dup = segments.findIndex(o => Math.min(Math.abs(o.theta - seg.theta), 180 - Math.abs(o.theta - seg.theta)) <= 3 && Math.abs(o.rho - seg.rho) <= 2 * tol + 1 && Math.min(o.t1, seg.t1) - Math.max(o.t0, seg.t0) > 0);
    if (dup >= 0) { if (segments[dup].length < seg.length) segments[dup] = seg; continue; }
    segments.push(seg);
  }
  return segments;
}
