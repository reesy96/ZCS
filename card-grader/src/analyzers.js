// Defect analyzers operating on a rectified card image (see cardDetect.js).
// Every analyzer returns measurements plus a list of normalised defects:
//   { type, severity(0..1), confidence(0..1), side, box:{x,y,w,h}, line?:{x0,y0,x1,y1}, note }
import { toGray, toHSV, gaussianBlur, subtract, localStats, connectedComponents, lineFit, median, percentile, makeMask, makeGray, orientedLineResponse, nmsAcrossLines, downsample2, houghSegments } from './imgproc.js';

const clamp01 = v => Math.max(0, Math.min(1, v));

// ---------------------------------------------------------------- frame / centering
export function measureFrame(gray, { maxBorderFrac = 0.14 } = {}) {
  const { w, h, data } = gray;
  const g = gaussianBlur(gray, 1.2);
  const maxBorder = Math.round(w * maxBorderFrac);
  // Average the gradient profile over many rows: the printed frame is at the same place in every row and
  // survives the averaging, text and artwork do not. Then take the first clear peak from the card edge.
  const scan = (coordRange, lineRange, horizontal, fromStart) => {
    const n = coordRange[1] - coordRange[0];
    const prof = new Float32Array(n);
    const rows = [];
    for (let l = lineRange[0]; l < lineRange[1]; l += 2) {
      const row = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const c = coordRange[0] + i;
        const a = horizontal ? g.data[l * w + Math.max(0, c - 2)] : g.data[Math.max(0, c - 2) * w + l];
        const b = horizontal ? g.data[l * w + Math.min(w - 1, c + 2)] : g.data[Math.min(h - 1, c + 2) * w + l];
        row[i] = Math.abs(b - a); prof[i] += row[i];
      }
      rows.push(row);
    }
    for (let i = 0; i < n; i++) prof[i] /= rows.length;
    let pmax = 0; for (let i = 0; i < n; i++) pmax = Math.max(pmax, prof[i]);
    if (pmax < 10) return null;
    const thr = Math.max(8, pmax * 0.4);
    let idx = -1;
    if (fromStart) { for (let i = 0; i < n; i++) if (prof[i] >= thr) { while (i + 1 < n && prof[i + 1] > prof[i]) i++; idx = i; break; } }
    else { for (let i = n - 1; i >= 0; i--) if (prof[i] >= thr) { while (i - 1 >= 0 && prof[i - 1] > prof[i]) i--; idx = i; break; } }
    if (idx < 0) return null;
    // Consistency: how many rows show the edge within +-3 px of the averaged position.
    let agree = 0;
    for (const row of rows) { let m = 0; for (let k = -3; k <= 3; k++) { const j = idx + k; if (j >= 0 && j < n) m = Math.max(m, row[j]); } if (m >= thr * 0.6) agree++; }
    return { value: coordRange[0] + idx, mad: agree / rows.length >= 0.7 ? 0 : 10 };
  };
  const yMid = [Math.round(h * 0.30), Math.round(h * 0.70)];
  const xMid = [Math.round(w * 0.30), Math.round(w * 0.70)];
  // Start a little inside: the physical card edge (and any background seam) must not count as the frame.
  const skip = Math.round(w * 0.018);
  const left = scan([skip, maxBorder], yMid, true, true);
  const right = scan([w - maxBorder, w - skip], yMid, true, false);
  const top = scan([skip, maxBorder], xMid, false, true);
  const bottom = scan([h - maxBorder, h - skip], xMid, false, false);
  const L = left ? left.value : null, R = right ? w - 1 - right.value : null;
  const T = top ? top.value : null, B = bottom ? h - 1 - bottom.value : null;
  const ok = v => v !== null && v >= w * 0.025 && v <= w * 0.13; // an edge right at the scan start is the card edge, not a frame
  const consistent = (s) => s && s.mad <= 3;
  const lrOk = ok(L) && ok(R), tbOk = ok(T) && ok(B);
  const valid = lrOk || tbOk; // one measurable axis is enough for a (partial) centering measurement
  let confidence = 0;
  if (valid) {
    confidence = 1;
    for (const s of [left, right, top, bottom]) if (s && !consistent(s)) confidence -= 0.2;
    if (!(lrOk && tbOk)) confidence -= 0.25;
    confidence = clamp01(confidence);
  }
  // Missing sides are estimated from the measured ones so the art box is still usable.
  const est = (v, alt) => (v !== null && ok(v)) ? v : (alt !== null && ok(alt)) ? alt : null;
  const Lf = est(L, R), Rf = est(R, L), Tf = est(T, B), Bf = est(B, T);
  const fill = (v) => v !== null ? v : Math.round(w * 0.045);
  const art = valid ? { x: fill(Lf), y: fill(Tf), w: w - fill(Lf) - fill(Rf), h: h - fill(Tf) - fill(Bf) } : { x: Math.round(w * 0.05), y: Math.round(h * 0.05), w: Math.round(w * 0.9), h: Math.round(h * 0.9) };
  return { L: Lf, R: Rf, T: Tf, B: Bf, valid, lrOk, tbOk, confidence,
    lr: lrOk ? L / (L + R) : null, tb: tbOk ? T / (T + B) : null, art };
}

function centeringDefects(frame, side) {
  if (!frame.valid) return [];
  const dLR = frame.lr === null ? 0 : Math.abs(frame.lr - 0.5), dTB = frame.tb === null ? 0 : Math.abs(frame.tb - 0.5);
  const worst = Math.max(dLR, dTB) * 2; // 0 = perfect, 1 = 100/0
  if (worst < 0.12) return [];
  const which = dLR >= dTB ? 'lr' : 'tb';
  return [{ type: 'centering', severity: clamp01(worst), confidence: frame.confidence, side, box: frame.art, axis: which,
    note: which === 'lr' ? 'vlevo/vpravo' : 'nahoře/dole' }];
}

// ---------------------------------------------------------------- whitening (edges / corners)
function whiteningMask(img, hsv, bandMask) {
  const { w, h } = img;
  const lums = [], sats = [], hues = [];
  const gray = toGray(img);
  for (let i = 0; i < w * h; i++) if (bandMask.data[i]) { lums.push(gray.data[i]); sats.push(hsv.sat[i]); }
  const refLum = median(lums), refSat = median(sats);
  const lumThr = refLum + Math.max(28, 0.22 * (255 - refLum));
  const satThr = refSat * 0.55 + 0.06;
  const mask = makeMask(w, h);
  let count = 0;
  for (let i = 0; i < w * h; i++) {
    if (!bandMask.data[i]) continue;
    if (gray.data[i] > lumThr && hsv.sat[i] < satThr) { mask.data[i] = 1; count++; }
  }
  return { mask, count, refLum, refSat, lumThr, satThr };
}

export function analyzeEdgesAndCorners(img, hsv, frame, side) {
  const { w, h } = img;
  // Whitening lives within ~1.7 mm of the physical edge, whatever the printed border is: a fixed band,
  // never wider than the printed border itself.
  const borderW = frame.valid ? Math.min(frame.L, frame.R, frame.T, frame.B) : Math.round(w * 0.04);
  const band = Math.max(8, Math.min(Math.round(w * 0.027), borderW - 2));
  const cornerR = Math.round(w * 0.075);
  const edgeBand = makeMask(w, h), cornerBand = makeMask(w, h);
  // Real cards have rounded corners (radius ~3 mm). After rectification the area outside the arc shows the
  // background, which must never be read as whitening. Skip the outermost pixels of the edge too (the
  // rectified edge always carries a sliver of background / anti-aliasing).
  const SKIP = 6; // the rectified edge carries background / the white paper core seen at an angle
  // Corner radius per corner, estimated from the image: walk the diagonal from the corner tip until the pixel
  // looks like card border rather than background. Capped so corner whitening on white paper is not swallowed.
  const borderRef = (() => { const rs = [], gs = [], bs = []; for (let y = band + 2; y < h - band - 2; y += 7) for (const x of [Math.round(band / 2), w - 1 - Math.round(band / 2)]) { const i = (y * w + x) * 4; rs.push(img.data[i]); gs.push(img.data[i + 1]); bs.push(img.data[i + 2]); } return [median(rs), median(gs), median(bs)]; })();
  const px = (x, y) => { const i = (Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
  const cdist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const cornerRadius = {};
  for (const [name, sx, sy, dx, dy] of [['tl', 0, 0, 1, 1], ['tr', w - 1, 0, -1, 1], ['bl', 0, h - 1, 1, -1], ['br', w - 1, h - 1, -1, -1]]) {
    const bg = px(sx + dx * 2, sy + dy * 2);
    let t0 = 0;
    if (cdist(bg, borderRef) > 60) { // background distinguishable from the border
      for (let t = 2; t < 70; t++) { const c = px(sx + dx * Math.round(t / Math.SQRT2), sy + dy * Math.round(t / Math.SQRT2)); if (cdist(c, borderRef) < cdist(c, bg)) { t0 = t; break; } }
    }
    const r = t0 ? t0 / (Math.SQRT2 - 1) : 40;
    cornerRadius[name] = Math.max(28, Math.min(46, r));
  }
  const outsideCorner = (x, y) => {
    const name = (y < h / 2 ? 't' : 'b') + (x < w / 2 ? 'l' : 'r');
    const r = cornerRadius[name];
    const cx = x < r ? r : x >= w - r ? w - 1 - r : null, cy = y < r ? r : y >= h - r ? h - 1 - r : null;
    if (cx === null || cy === null) return false;
    return Math.hypot(x - cx, y - cy) > r - SKIP;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inBand = x < band || y < band || x >= w - band || y >= h - band;
    if (!inBand) continue;
    if (x < SKIP || y < SKIP || x >= w - SKIP || y >= h - SKIP) continue;
    if (outsideCorner(x, y)) continue;
    const nearCorner = (x < cornerR || x >= w - cornerR) && (y < cornerR || y >= h - cornerR);
    if (nearCorner) cornerBand.data[y * w + x] = 1; else edgeBand.data[y * w + x] = 1;
  }
  // Reference colour comes from the whole band (edges + corners) so a single bad corner cannot skew it.
  const all = makeMask(w, h);
  for (let i = 0; i < w * h; i++) all.data[i] = edgeBand.data[i] | cornerBand.data[i];
  const wm = whiteningMask(img, hsv, all);
  // Border uniformity -> is there a printed border at all (full-art cards have none)?
  const gray = toGray(img);
  const vals = [];
  for (let i = 0; i < w * h; i++) if (all.data[i]) vals.push(gray.data[i]);
  const spread = percentile(vals, 0.9) - percentile(vals, 0.1);
  const uniformBorder = spread < 60;
  const confidenceBase = uniformBorder ? 0.9 : 0.45;

  // Per-edge statistics.
  const edges = { top: { total: 0, white: 0, runs: [] }, bottom: { total: 0, white: 0, runs: [] }, left: { total: 0, white: 0, runs: [] }, right: { total: 0, white: 0, runs: [] } };
  const runOf = (name, length, horizontal) => {
    const e = edges[name]; let run = 0, runStart = 0;
    for (let t = cornerR; t < length - cornerR; t++) {
      let hit = 0, tot = 0;
      for (let k = SKIP; k < band; k++) {
        let x, y;
        if (name === 'top') { x = t; y = k; } else if (name === 'bottom') { x = t; y = h - 1 - k; } else if (name === 'left') { x = k; y = t; } else { x = w - 1 - k; y = t; }
        tot++; if (wm.mask.data[y * w + x]) hit++;
      }
      e.total += tot; e.white += hit;
      if (hit >= 3) { if (run === 0) runStart = t; run++; } else if (run > 0) { e.runs.push({ start: runStart, len: run }); run = 0; }
    }
    if (run > 0) e.runs.push({ start: runStart, len: run });
  };
  runOf('top', w, true); runOf('bottom', w, true); runOf('left', h, false); runOf('right', h, false);
  const defects = [];
  for (const [name, e] of Object.entries(edges)) {
    const frac = e.total ? e.white / e.total : 0;
    const longest = e.runs.reduce((m, r) => Math.max(m, r.len), 0);
    e.fraction = frac; e.longestRun = longest;
    const runsLen = e.runs.filter(r => r.len >= 3).reduce((s, r) => s + r.len, 0);
    const edgeLen = (name === 'top' || name === 'bottom' ? w : h) - 2 * cornerR;
    const coverage = runsLen / edgeLen;
    e.coverage = coverage;
    if (coverage > 0.004 || longest >= 6) {
      const severity = clamp01(coverage * 0.9 + frac * 1.5 + Math.min(0.1, longest / edgeLen));
      const box = name === 'top' ? { x: 0, y: 0, w, h: band } : name === 'bottom' ? { x: 0, y: h - band, w, h: band } : name === 'left' ? { x: 0, y: 0, w: band, h } : { x: w - band, y: 0, w: band, h };
      defects.push({ type: 'whitening_edge', edge: name, severity, confidence: confidenceBase * clamp01(0.5 + coverage * 20), side, box,
        note: `${{ top: 'horní', bottom: 'dolní', left: 'levá', right: 'pravá' }[name]} hrana, ${(coverage * 100).toFixed(1)} % délky` });
    }
  }
  // Corners.
  const corners = {};
  const cdef = [['tl', 0, 0], ['tr', w - cornerR, 0], ['bl', 0, h - cornerR], ['br', w - cornerR, h - cornerR]];
  for (const [name, x0, y0] of cdef) {
    let tot = 0, white = 0, inner = 0;
    const cxp = name[1] === 'l' ? 0 : w - 1, cyp = name[0] === 't' ? 0 : h - 1;
    for (let y = y0; y < y0 + cornerR; y++) for (let x = x0; x < x0 + cornerR; x++) {
      const i = y * w + x; if (!cornerBand.data[i]) continue;
      tot++; if (wm.mask.data[i]) { white++; if (Math.hypot(x - cxp, y - cyp) < cornerR * 0.5) inner++; }
    }
    const frac = tot ? white / tot : 0;
    corners[name] = { fraction: frac, whitePixels: white, innerPixels: inner };
    if (white >= 6 && (frac > 0.006 || inner >= 6)) {
      const radiusMm = Math.sqrt(white * 4 / Math.PI) * (63.5 / w); // equivalent whitened radius
      const severity = clamp01(radiusMm / 5 + (inner >= 6 ? 0.05 : 0));
      defects.push({ type: 'whitening_corner', corner: name, severity, confidence: confidenceBase * clamp01(0.5 + frac * 15), side,
        box: { x: x0, y: y0, w: cornerR, h: cornerR },
        note: `${{ tl: 'levý horní', tr: 'pravý horní', bl: 'levý dolní', br: 'pravý dolní' }[name]} roh, ~${radiusMm.toFixed(1)} mm` });
    }
  }
  return { band, cornerR, cornerRadius, uniformBorder, edges, corners, whitening: wm.mask, defects };
}

// ---------------------------------------------------------------- surface: scratches, creases, dents, bend
function inBox(x, y, b) { return x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h; }

// Extract straight line segments from an oriented-filter response map.
function extractLines(resp, box, thr, { minLen, maxWidth, minStraight, relTex = null, relK = 0 }) {
  const { w, h } = resp;
  const mask = makeMask(w, h);
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
    const i = y * w + x;
    const v = Math.abs(resp.data[i]);
    if (v > thr && (!relTex || v > relK * relTex.data[i])) mask.data[i] = 1;
  }
  const { comps } = connectedComponents(mask, { keepPixels: true, minArea: Math.max(6, minLen) });
  const out = [];
  for (const c of comps) {
    const f = lineFit(c.pixels, w);
    if (f.length < minLen || f.width > maxWidth || f.straightness < minStraight) continue;
    let amp = 0; for (const p of c.pixels) amp += Math.abs(resp.data[p]); amp /= c.pixels.length;
    out.push({ comp: c, fit: f, amp, box: { x: c.minX, y: c.minY, w: c.maxX - c.minX + 1, h: c.maxY - c.minY + 1 } });
  }
  return out;
}

// How much does the response flip sign right next to the ridge? A thin line (scratch) has weak side lobes,
// a printed step edge has a strong opposite-sign neighbour. Returns mean ratio over the component.
function bipolarity(resp, ang, comp) {
  const { w, h } = resp;
  let sum = 0, n = 0;
  for (const p of comp.pixels) {
    const x = p % w, y = (p - x) / w;
    const v = resp.data[p]; if (!v) continue;
    const t = ang[p];
    const nx = -Math.sin(t), ny = Math.cos(t);
    let worst = 0;
    for (let k = 1; k <= 3; k++) {
      for (const sgn of [-1, 1]) {
        const xx = Math.round(x + sgn * nx * k), yy = Math.round(y + sgn * ny * k);
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = resp.data[yy * w + xx];
        if (Math.sign(q) === -Math.sign(v)) worst = Math.max(worst, Math.abs(q) / Math.abs(v));
      }
    }
    sum += worst; n++;
  }
  return n ? sum / n : 0;
}

function robustSigma(img, box, step = 4) {
  const v = [];
  for (let y = box.y; y < box.y + box.h; y += step) for (let x = box.x; x < box.x + box.w; x += step) v.push(Math.abs(img.data[y * img.w + x]));
  return Math.max(1, median(v) * 1.4826);
}

export function analyzeSurface(img, gray, hsv, frame, edgeInfo, side, debug = null, { fullArt = false, era = '' } = {}) {
  const { w, h } = img;
  const log = (...a) => { if (debug) debug.push(a.map(v => typeof v === 'number' ? +v.toFixed(2) : v)); };
  const MM = 63.5 / w; // mm per pixel
  const art = frame.art;
  const inset = 4;
  const artBox = { x: art.x + inset, y: art.y + inset, w: art.w - 2 * inset, h: art.h - 2 * inset };
  const fullBox = { x: 2, y: 2, w: w - 4, h: h - 4 };
  const defects = [];

  // Glare check.
  let glare = 0, artPix = 0;
  for (let y = artBox.y; y < artBox.y + artBox.h; y++) for (let x = artBox.x; x < artBox.x + artBox.w; x++) { artPix++; if (hsv.val[y * w + x] >= 252) glare++; }
  const glareFrac = artPix ? glare / artPix : 0;
  const glarePenalty = glareFrac > 0.03 ? 0.5 : glareFrac > 0.01 ? 0.8 : 1;

  // High-pass (fine detail) and a texture map (how busy the print is around each pixel).
  const hp = subtract(gray, gaussianBlur(gray, 2));
  const absHp = makeGray(w, h);
  for (let i = 0; i < hp.data.length; i++) absHp.data[i] = Math.abs(hp.data[i]);
  const { mean: texture } = localStats(absHp, 9);
  const localTexture = (x, y) => texture.data[Math.round(y) * w + Math.round(x)];

  const bp = subtract(gaussianBlur(gray, 1.5), gaussianBlur(gray, 6));

  // ---- Creases: band-pass at half resolution, oriented line filter, NMS; long straight ridges anywhere on the card.
  const g2 = downsample2(gray);
  const bp2 = subtract(gaussianBlur(g2, 0.8), gaussianBlur(g2, 3));
  const abp2 = makeGray(bp2.w, bp2.h); for (let i = 0; i < bp2.data.length; i++) abp2.data[i] = Math.abs(bp2.data[i]);
  const { mean: tex2 } = localStats(abp2, 8);
  const box2 = { x: 1, y: 1, w: bp2.w - 2, h: bp2.h - 2 };
  const bpSigma = robustSigma(bp2, box2, 3);
  const cr2 = orientedLineResponse(bp2, box2, { length: 17, nAngles: 36 });
  const crNms = nmsAcrossLines(cr2.resp, cr2.ang, box2);
  // Blank the printed frame and the card edge so a crease crossing them is not glued to those lines.
  const band2 = 3; // only the physical card edge
  const fx = frame.valid ? [frame.L / 2, (w - 1 - frame.R) / 2] : [], fy = frame.valid ? [frame.T / 2, (h - 1 - frame.B) / 2] : [];
  for (let y = 0; y < bp2.h; y++) for (let x = 0; x < bp2.w; x++) {
    const nearFrame = fx.some(v => Math.abs(x - v) <= 6) || fy.some(v => Math.abs(y - v) <= 6);
    const nearEdge = x < band2 || y < band2 || x >= bp2.w - band2 || y >= bp2.h - band2;
    if (nearFrame || nearEdge) crNms.data[y * bp2.w + x] = 0;
  }
  const minCrease = Math.round(Math.min(bp2.w, bp2.h) * 0.22);
  const creaseThr = Math.max(4, 3 * bpSigma);
  // Candidate ridge pixels must also stand out from the local print texture.
  const ridge = makeGray(bp2.w, bp2.h);
  for (let i = 0; i < ridge.data.length; i++) { const v = Math.abs(crNms.data[i]); if (v > creaseThr) ridge.data[i] = crNms.data[i]; }
  const segs = houghSegments(ridge, box2, { minLen: minCrease, tol: 3, maxGap: 30, maxSegments: 40, ang: cr2.ang, angTol: 7 }).filter(sg => sg.support >= 0.5);
  // Clip every segment to the art area (half-res): the border part is verified separately by a probe.
  const art2 = { x: art.x / 2, y: art.y / 2, w: art.w / 2, h: art.h / 2 };
  const clip = (sg) => {
    let t0 = 0, t1 = 1; const dx = sg.x1 - sg.x0, dy = sg.y1 - sg.y0;
    for (const [p, q] of [[-dx, sg.x0 - art2.x], [dx, art2.x + art2.w - sg.x0], [-dy, sg.y0 - art2.y], [dy, art2.y + art2.h - sg.y0]]) {
      if (p === 0) { if (q < 0) return null; continue; }
      const t = q / p;
      if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
    const x0 = sg.x0 + dx * t0, y0 = sg.y0 + dy * t0, x1 = sg.x0 + dx * t1, y1 = sg.y0 + dy * t1;
    return { ...sg, x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, length: Math.hypot(x1 - x0, y1 - y0), clipped0: t0 > 0, clipped1: t1 < 1 };
  };
  const creaseLines2 = segs.map(clip).filter(sg => sg && sg.length >= minCrease * 0.8).map(sg => ({ amp: sg.amp, support: sg.support, clipped: [sg.clipped0, sg.clipped1],
    box: { x: Math.min(sg.x0, sg.x1), y: Math.min(sg.y0, sg.y1), w: Math.abs(sg.x1 - sg.x0) + 1, h: Math.abs(sg.y1 - sg.y0) + 1 },
    fit: { cx: sg.cx, cy: sg.cy, angle: sg.angle, length: sg.length, width: 1, straightness: 1, x0: sg.x0, y0: sg.y0, x1: sg.x1, y1: sg.y1 } }));
  // Does the segment continue beyond an endpoint (into the border we blanked)? Sample the raw response there.
  const continues = (l) => {
    const f = l.fit;
    const ux = (f.x1 - f.x0) / f.length, uy = (f.y1 - f.y0) / f.length;
    // Mean of the band-pass along the segment's own direction (17 samples) at a probe point.
    const lineMean = (x, y) => {
      // max over a +-2 px perpendicular window: the extended line may miss the ridge by a pixel or two
      let best = 0;
      for (let q = -2; q <= 2; q++) {
        let s = 0, n = 0;
        for (let k = -4; k <= 4; k++) {
          const xx = Math.round(x + ux * k - uy * q), yy = Math.round(y + uy * k + ux * q);
          if (xx < 4 || yy < 4 || xx >= bp2.w - 4 || yy >= bp2.h - 4) continue; // never average the card edge in
          if (fx.some(v => Math.abs(xx - v) <= 5) || fy.some(v => Math.abs(yy - v) <= 5)) continue; // nor the printed frame
          s += bp2.data[yy * bp2.w + xx]; n++;
        }
        if (n) best = Math.max(best, Math.abs(s / n));
      }
      return best;
    };
    const probe = (x, y, dx, dy) => {
      const vals = [];
      for (let k = 2; k <= 16; k++) {
        const xx = Math.round(x + dx * k), yy = Math.round(y + dy * k);
        if (xx < 6 || yy < 6 || xx >= bp2.w - 6 || yy >= bp2.h - 6) break; // the card edge itself must not feed the probe
        if (fx.some(v => Math.abs(xx - v) <= 6) || fy.some(v => Math.abs(yy - v) <= 6)) continue; // skip the printed frame
        vals.push(lineMean(xx, yy));
      }
      if (vals.length < 3) return false;
      vals.sort((a, b) => b - a);
      const top = vals.slice(0, Math.ceil(vals.length / 2));
      const mean = top.reduce((a, b) => a + b, 0) / top.length; // best half: the crease may fade before the card edge
      const need = Math.max(0.8 * creaseThr, 0.4 * l.amp);
      log('  probe', 'from', x, y, 'n', vals.length, 'mean', mean, 'need', need);
      return mean > need;
    };
    const nearFrame = (x, y) => fx.some(v => Math.abs(x - v) <= 8) || fy.some(v => Math.abs(y - v) <= 8);
    return (nearFrame(f.x1, f.y1) && probe(f.x1, f.y1, ux, uy)) || (nearFrame(f.x0, f.y0) && probe(f.x0, f.y0, -ux, -uy));
  };
  const creaseLines = creaseLines2.map(l => ({ amp: l.amp, support: l.support, cont: continues(l), box: { x: l.box.x * 2, y: l.box.y * 2, w: l.box.w * 2, h: l.box.h * 2 },
    fit: { ...l.fit, cx: l.fit.cx * 2, cy: l.fit.cy * 2, length: l.fit.length * 2, width: l.fit.width * 2, x0: l.fit.x0 * 2, y0: l.fit.y0 * 2, x1: l.fit.x1 * 2, y1: l.fit.y1 * 2 } }));
  const creases = [], longScratches = [];
  const sampleAlong = (img, f, pad = 0) => {
    let s = 0, n = 0; const ux = (f.x1 - f.x0) / f.length, uy = (f.y1 - f.y0) / f.length;
    for (let k = 0; k <= f.length; k += 2) {
      // take the max over a small perpendicular window so sub-pixel misalignment does not matter
      let m = 0;
      for (let q = -pad; q <= pad; q++) {
        const xx = Math.round(f.x0 + ux * k - uy * q), yy = Math.round(f.y0 + uy * k + ux * q);
        if (xx < 0 || yy < 0 || xx >= img.w || yy >= img.h) continue;
        m = Math.max(m, Math.abs(img.data[yy * img.w + xx]));
      }
      s += m; n++;
    }
    return n ? s / n : 0;
  };
  for (const l of creaseLines) {
    const { fit } = l;
    const ang = ((fit.angle * 180 / Math.PI) % 180 + 180) % 180;
    const horiz = ang < 8 || ang > 172, vert = Math.abs(ang - 90) < 8;
    log('crease-cand', 'len', fit.length, 'ang', ang, 'amp', l.amp, 'support', l.support, 'cont', l.cont, 'ends', fit.x0, fit.y0, fit.x1, fit.y1);
    const endsAtFrame = (p) => (frame.valid && (Math.abs(p.x - frame.L) < 14 || Math.abs(p.x - (w - 1 - frame.R)) < 14 || Math.abs(p.y - frame.T) < 14 || Math.abs(p.y - (h - 1 - frame.B)) < 14));
    void endsAtFrame;
    const crossesBorder = l.cont;
    // Long axis-aligned lines fully inside the art are layout (text boxes, dividers), not creases.
    if ((horiz || vert) && (!crossesBorder || l.support < 0.7)) { log('  reject: axis-aligned layout line'); continue; }
    const prominence = l.amp / Math.max(1.5, sampleAlong(tex2, { x0: fit.x0 / 2, y0: fit.y0 / 2, x1: fit.x1 / 2, y1: fit.y1 / 2, length: fit.length / 2 }, 0));
    if (!crossesBorder && (prominence < 1.2 || l.support < 0.6)) { log('  reject: low prominence/support', prominence, l.support); continue; }
    // Thin bright line = long scratch; wide soft ridge = crease.
    const thin = sampleAlong(absHp, fit, 2) / Math.max(1, sampleAlong(bp, fit, 2));
    log('  thin ratio', thin, 'crosses', crossesBorder);
    if (thin > 1.2 && !crossesBorder) { longScratches.push({ ...l, prominence }); continue; } // a line running into the border is a fold, not a surface scratch
    // Printed artwork is full of long straight edges (logos, frames, the Pokéball). A fold, on the other hand,
    // runs across the border. Lines that stay inside the art are only ever "possible" creases.
    if (!crossesBorder && fit.length < 0.4 * Math.min(w, h)) { log('  reject: inside art and short'); continue; }
    const severity = clamp01(0.45 + fit.length / Math.min(w, h) * 0.6 + (crossesBorder ? 0.15 : 0));
    const confidence = crossesBorder ? glarePenalty * clamp01(0.6 + fit.length / (2 * Math.min(w, h)) + Math.min(0.15, l.amp / 100) + (l.support - 0.5) * 0.3) : Math.min(0.35, glarePenalty * (0.2 + l.support * 0.15));
    creases.push({ ...l, severity, confidence });
  }
  creases.sort((a, b) => b.fit.length - a.fit.length);
  const nearCrease = (x, y) => creases.some(cr => inBox(x, y, { x: cr.box.x - 10, y: cr.box.y - 10, w: cr.box.w + 20, h: cr.box.h + 20 }));
  for (const c of creases.slice(0, 5)) {
    defects.push({ type: 'crease', severity: c.severity, confidence: c.confidence, side, box: c.box, line: { x0: c.fit.x0, y0: c.fit.y0, x1: c.fit.x1, y1: c.fit.y1 }, note: `délka ${Math.round(c.fit.length * MM)} mm` });
  }

  const modernLayout = side === 'front' && (fullArt || ['sm', 'swsh', 'sv'].includes(era));
  const designZone = (cy) => modernLayout && (cy < 0.13 * h || (fullArt && cy > 0.78 * h));

  // ---- Scratches: fine high-pass lines inside the art (oriented filter -> NMS ridge -> Hough segments).
  const sigma = robustSigma(absHp, artBox, 4);
  // Response on a slightly larger box than the extraction box, so the bipolarity test can see the dark side
  // of the printed frame line just outside the art area.
  const pad = 8;
  const respBox = { x: Math.max(1, artBox.x - pad), y: Math.max(1, artBox.y - pad), w: 0, h: 0 };
  respBox.w = Math.min(w - 1, artBox.x + artBox.w + pad) - respBox.x; respBox.h = Math.min(h - 1, artBox.y + artBox.h + pad) - respBox.y;
  const scratchResp = orientedLineResponse(hp, respBox, { length: 15, nAngles: 24 });
  const scratchNms = nmsAcrossLines(scratchResp.resp, scratchResp.ang, artBox);
  const scratchThr = Math.max(6, 3.5 * sigma);
  const sSegs = houghSegments(scratchNms, artBox, { thr: scratchThr, minLen: 16, tol: 2.5, maxGap: 5, maxSegments: 40, ang: scratchResp.ang, angTol: 9 });
  const scratches = [], printLines = [];
  for (const sg of sSegs) {
    if (sg.support < 0.6) continue;
    const fit = { cx: sg.cx, cy: sg.cy, angle: sg.angle, length: sg.length, x0: sg.x0, y0: sg.y0, x1: sg.x1, y1: sg.y1 };
    const box = { x: Math.min(sg.x0, sg.x1), y: Math.min(sg.y0, sg.y1), w: Math.abs(sg.x1 - sg.x0) + 1, h: Math.abs(sg.y1 - sg.y0) + 1 };
    const l = { fit, box, amp: sg.amp, comp: { pixels: sg.pixels } };
    let signed = 0; for (const p of sg.pixels) signed += hp.data[p]; signed /= sg.pixels.length;
    log('scratch-cand', 'at', fit.cx, fit.cy, 'len', fit.length, 'amp', sg.amp, 'support', sg.support, 'signed', signed);
    if (signed < 0.3 * sg.amp) { log('  reject: dark line (printed text/outline)'); continue; } // scratches expose the lighter layer below
    if (nearCrease(fit.cx, fit.cy)) { log('  reject: near crease'); continue; }
    const ang = ((fit.angle * 180 / Math.PI) % 180 + 180) % 180;
    const axisAligned = ang < 2.5 || ang > 177.5 || Math.abs(ang - 90) < 2.5;
    const prominence = l.amp / Math.max(1, sampleAlong(texture, fit, 0));
    if (prominence < 1.3) { log('  reject: low prominence', prominence); continue; } // part of busy artwork or text
    const bip = bipolarity(scratchResp.resp, scratchResp.ang, l.comp);
    if (bip > 0.45) { log('  reject: bipolar (print edge)', bip); continue; } // printed step edge (text, outlines), not a scratch
    // Full-art layouts (XY/SM/SV ex, GX, V) carry a slanted bright design line next to the name bar: ignore
    // long straight bright lines in the name-bar zone of a full-art front.
    // Modern layouts carry printed straight lines in the name bar (underline, slanted divider) and in the
    // bottom bar (weakness/retreat dividers): ignore line candidates there on such fronts.
    if (designZone(fit.cy)) { log('  reject: printed layout line (name/bottom bar)'); continue; }
    if (axisAligned && fit.length > 0.55 * (ang < 45 || ang > 135 ? artBox.w : artBox.h)) { printLines.push({ ...l, prominence }); continue; }
    scratches.push({ ...l, prominence });
  }
  // Holo foils and textured prints produce many short, parallel bright streaks. A real scratch is a lone line:
  // drop short candidates that belong to an orientation bin with several similar candidates.
  {
    const bins = new Map();
    const TEX_LEN = 100; // streaks shorter than ~8 mm
    for (const sc of scratches) { if (sc.fit.length >= TEX_LEN) continue; const b = Math.round((((sc.fit.angle * 180 / Math.PI) % 180) + 180) % 180 / 15); const k = b % 12; bins.set(k, (bins.get(k) || 0) + 1); }
    const textured = [...bins.entries()].filter(([, c]) => c >= 3).map(([k]) => k);
    if (textured.length) {
      const keep = scratches.filter(sc => { if (sc.fit.length >= TEX_LEN) return true; const k = Math.round((((sc.fit.angle * 180 / Math.PI) % 180) + 180) % 180 / 15) % 12; return !textured.includes(k); });
      log('scratch texture filter', 'dropped', scratches.length - keep.length);
      scratches.length = 0; scratches.push(...keep);
    }
  }
  for (const l of longScratches) {
    if (designZone(l.fit.cy)) { log('  reject long line: printed layout line (name/bottom bar)'); continue; }
    if (!scratches.some(sc => inBox(l.fit.cx, l.fit.cy, { x: sc.box.x - 10, y: sc.box.y - 10, w: sc.box.w + 20, h: sc.box.h + 20 }))) scratches.push(l);
  }
  scratches.sort((a, b) => b.fit.length - a.fit.length);
  for (const s of scratches.slice(0, 12)) {
    const severity = clamp01(0.1 + s.fit.length / 300 + Math.min(0.25, (s.prominence - 1.3) * 0.05));
    defects.push({ type: 'scratch', severity, confidence: glarePenalty * clamp01(0.35 + (s.prominence - 1.3) * 0.1 + s.fit.length / 300), side, box: s.box,
      line: { x0: s.fit.x0, y0: s.fit.y0, x1: s.fit.x1, y1: s.fit.y1 }, note: `délka ${Math.round(s.fit.length * MM)} mm` });
  }
  for (const p of printLines.slice(0, 4)) {
    defects.push({ type: 'print_line', severity: 0.15, confidence: 0.4 * glarePenalty, side, box: p.box, line: { x0: p.fit.x0, y0: p.fit.y0, x1: p.fit.x1, y1: p.fit.y1 }, note: 'tisková linka (vada z výroby)' });
  }

  // ---- Dents: low-frequency blobs in low-texture areas (border, flat colour fields).
  const relief = subtract(gaussianBlur(gray, 3), gaussianBlur(gray, 15));
  // On the border the 2-D relief is biased by the nearby printed frame; use a 1-D band-pass *along* the edge
  // there instead (a dent changes brightness along the edge, the frame bias does not).
  const bandD = frame.valid ? Math.max(6, Math.min(frame.L, frame.R, frame.T, frame.B) - 4) : edgeInfo.band;
  const sm3 = gaussianBlur(gray, 1.5);
  const lineBP = (getter, n) => { // 1-D: smooth(1.5) - smooth(15) along a line of n samples
    const src = makeGray(n, 1); for (let t = 0; t < n; t++) src.data[t] = getter(t);
    const lo = gaussianBlur(src, 15); const out = new Float32Array(n);
    for (let t = 0; t < n; t++) out[t] = src.data[t] - lo.data[t];
    return out;
  };
  for (let x = 0; x < w; x++) {
    if (x >= bandD && x < w - bandD) continue;
    const col = lineBP(t => sm3.data[t * w + x], h);
    for (let y = 0; y < h; y++) relief.data[y * w + x] = col[y];
  }
  for (let y = 0; y < h; y++) {
    if (y >= bandD && y < h - bandD) continue;
    const row = lineBP(t => sm3.data[y * w + t], w);
    for (let x = bandD; x < w - bandD; x++) relief.data[y * w + x] = row[x];
  }
  const { mean: texDent } = localStats(absHp, 5);
  const lowTex = makeMask(w, h);
  const reliefSamples = [];
  for (let y = 3; y < h - 3; y++) for (let x = 3; x < w - 3; x++) {
    const i = y * w + x;
    if (texDent.data[i] <= 8) { lowTex.data[i] = 1; if ((x & 3) === 0 && (y & 3) === 0 && !inBox(x, y, art)) reliefSamples.push(Math.abs(relief.data[i])); }
  }
  const rSigma = Math.max(1.2, median(reliefSamples) * 1.4826);
  const dentThr = Math.max(5, 4 * rSigma);
  const artSamples = [];
  for (let y = artBox.y; y < artBox.y + artBox.h; y += 4) for (let x = artBox.x; x < artBox.x + artBox.w; x += 4) { const i = y * w + x; if (lowTex.data[i]) artSamples.push(Math.abs(relief.data[i])); }
  const dentThrArt = Math.max(dentThr, 4 * Math.max(1.2, median(artSamples) * 1.4826), percentile(artSamples, 0.97));
  const dentMask = makeMask(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!lowTex.data[i]) continue;
    const thr = inBox(x, y, art) ? dentThrArt : dentThr;
    if (Math.abs(relief.data[i]) > thr) dentMask.data[i] = 1;
  }
  const { comps: dentComps } = connectedComponents(dentMask, { keepPixels: true, minArea: 30 });
  const dents = [];
  log('dent thr', dentThr, 'art thr', dentThrArt, 'cands', dentComps.length);
  for (const c of dentComps) {
    const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
    const aspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
    log('dent-cand', 'at', c.cx, c.cy, 'area', c.area, 'aspect', aspect);
    if (c.area > 5000) { log('  reject: too large'); continue; }
    if ((c.cx < edgeInfo.cornerR || c.cx > w - edgeInfo.cornerR) && (c.cy < edgeInfo.cornerR || c.cy > h - edgeInfo.cornerR)) { log('  reject: corner region (handled by corner analyzer)'); continue; }
    if (aspect > 3.5) { log('  reject: elongated'); continue; }
    if (nearCrease(c.cx, c.cy)) { log('  reject: near crease'); continue; }
    // Printed layout edges (frame line, text box divider) produce relief too: skip blobs hugging the frame.
    if (frame.valid && (Math.abs(c.cx - frame.L) < 12 || Math.abs(c.cx - (w - 1 - frame.R)) < 12 || Math.abs(c.cy - frame.T) < 12 || Math.abs(c.cy - (h - 1 - frame.B)) < 12) && c.area < 150) { log('  reject: small blob on frame line'); continue; }
    let contrast = 0, tex = 0; for (const p of c.pixels) { contrast += Math.abs(relief.data[p]); tex += texture.data[p]; } contrast /= c.pixels.length; tex /= c.pixels.length;
    const onBorder = c.cx < art.x || c.cy < art.y || c.cx >= art.x + art.w || c.cy >= art.y + art.h;
    if (!onBorder && tex > 7) { log('  reject: print texture', tex); continue; } // the blob hugs a sharp printed edge (text box, outline)
    if (!onBorder) {
      // Inside the artwork only small, bipolar (lit side + shadow side) blobs count; large smooth bumps are print gradients.
      if (c.area > 1500 || c.area < 100 || contrast < dentThrArt * 1.3) { log('  reject: in-art size/contrast', contrast); continue; }
      let pos = 0, neg = 0;
      const r = Math.max(bw, bh);
      for (let y = Math.max(0, c.minY - r); y < Math.min(h, c.maxY + r); y++) for (let x = Math.max(0, c.minX - r); x < Math.min(w, c.maxX + r); x++) {
        const v = relief.data[y * w + x]; if (v > dentThr * 0.6) pos++; else if (v < -dentThr * 0.6) neg++;
      }
      if (Math.min(pos, neg) < 0.25 * Math.max(pos, neg)) { log('  reject: not bipolar'); continue; }
    }
    log('  accepted dent', 'contrast', contrast, 'onBorder', onBorder);
    const sizeMm = Math.sqrt(c.area) * MM;
    const severity = clamp01(0.2 + sizeMm / 8 + contrast / 80);
    const thrHere = onBorder ? dentThr : dentThrArt;
    const ratio = contrast / Math.max(1, thrHere);
    // A dent in a plain photo is a weak cue (raking light is what really shows it): stay below 0.5 unless the
    // shading is several times the local noise.
    // From a single flat photo a dent is never more than a hint: raking light is what shows it.
    const confidence = Math.min(0.45, glarePenalty * clamp01(0.2 + (ratio - 1) * 0.18) * (onBorder ? 1 : 0.75));
    dents.push({ comp: c, severity, contrast, sizeMm, confidence, onBorder });
  }
  // Merge the lit/shadow lobes of one dent (and any touching blobs) into a single defect.
  const merged = [];
  for (const d of dents) {
    const c = d.comp;
    const hit = merged.find(m => c.minX <= m.maxX + 24 && c.maxX >= m.minX - 24 && c.minY <= m.maxY + 24 && c.maxY >= m.minY - 24);
    if (hit) {
      hit.minX = Math.min(hit.minX, c.minX); hit.maxX = Math.max(hit.maxX, c.maxX); hit.minY = Math.min(hit.minY, c.minY); hit.maxY = Math.max(hit.maxY, c.maxY);
      hit.area += c.area; hit.severity = Math.max(hit.severity, d.severity); hit.confidence = Math.max(hit.confidence, d.confidence); hit.contrast = Math.max(hit.contrast, d.contrast);
      hit.sizeMm = Math.sqrt(hit.area) * MM; hit.onBorder = hit.onBorder || d.onBorder;
    } else merged.push({ minX: c.minX, maxX: c.maxX, minY: c.minY, maxY: c.maxY, area: c.area, severity: d.severity, confidence: d.confidence, contrast: d.contrast, sizeMm: d.sizeMm, onBorder: d.onBorder });
  }
  dents.length = 0; dents.push(...merged);
  dents.sort((a, b) => b.severity - a.severity);
  for (const d of dents.slice(0, 6)) {
    const c = d;
    defects.push({ type: 'dent', severity: d.severity, confidence: d.confidence, side, box: { x: c.minX, y: c.minY, w: c.maxX - c.minX + 1, h: c.maxY - c.minY + 1 },
      note: `${d.onBorder ? 'na okraji' : 'v ploše'}, ~${d.sizeMm.toFixed(1)} mm` });
  }

  // ---- Bend: smooth luminance bump along the border band (needs even lighting).
  const bend = detectBend(gray, edgeInfo.band, w, h);
  // A smooth brightness band is just as often a shadow on the photo as a bowed card, so a bend from one
  // photo is only ever a hint ("possible bend"): it never moves the grade by itself.
  if (bend) defects.push({ type: 'bend', severity: bend.severity, confidence: Math.min(0.45, bend.confidence * glarePenalty), side, box: bend.box, note: bend.note });

  return { glareFrac, sigma, scratchThr, scratches, printLines, creases, dents, bend, highpass: hp, relief, lineResp: scratchNms, creaseResp: crNms, creaseRidge: ridge, creaseTex: tex2, creaseThr, defects };
}

function detectBend(gray, band, w, h) {
  const profile = (horizontal) => {
    const n = horizontal ? w : h;
    const prof = new Float64Array(n);
    for (let t = 0; t < n; t++) {
      let s = 0, c = 0;
      for (let k = 2; k < band; k++) {
        if (horizontal) { s += gray.data[k * w + t] + gray.data[(h - 1 - k) * w + t]; }
        else { s += gray.data[t * w + k] + gray.data[t * w + (w - 1 - k)]; }
        c += 2;
      }
      prof[t] = s / c;
    }
    // Linear fit + residual.
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += prof[i]; sxx += i * i; sxy += i * prof[i]; }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx), icpt = (sy - slope * sx) / n;
    const res = makeGray(n, 1);
    for (let i = 0; i < n; i++) res.data[i] = prof[i] - (slope * i + icpt);
    const sm = gaussianBlur(res, 25);
    let best = 0, at = 0;
    for (let i = Math.round(n * 0.1); i < n * 0.9; i++) if (Math.abs(sm.data[i]) > best) { best = Math.abs(sm.data[i]); at = i; }
    // Width of the bump at half maximum.
    let a = at, b = at;
    while (a > 0 && Math.abs(sm.data[a]) > best / 2) a--;
    while (b < n - 1 && Math.abs(sm.data[b]) > best / 2) b++;
    return { amp: best, at, width: b - a, horizontal };
  };
  const ph = profile(true), pv = profile(false);
  const p = ph.amp >= pv.amp ? ph : pv;
  if (p.amp < 9 || p.width < (p.horizontal ? w : h) * 0.08) return null;
  const severity = clamp01(0.3 + (p.amp - 9) / 30);
  const box = p.horizontal ? { x: p.at - p.width / 2, y: 0, w: p.width, h } : { x: 0, y: p.at - p.width / 2, w, h: p.width };
  return { severity, confidence: clamp01(0.25 + (p.amp - 9) / 40), box, amp: p.amp, note: `${p.horizontal ? 'svislý' : 'vodorovný'} pás změny jasu (${p.amp.toFixed(0)} úrovní) – ověřte pohledem ze strany` };
}

// Mean luminance and a resolution-independent sharpness measure (high-pass energy relative to contrast).
export function imageStats(gray, hp) {
  const n = gray.data.length;
  let s = 0, s2 = 0, g = 0, g2 = 0;
  for (let i = 0; i < n; i++) { const v = hp.data[i]; s += v; s2 += v * v; const u = gray.data[i]; g += u; g2 += u * u; }
  const vh = s2 / n - (s / n) ** 2, vg = Math.max(1, g2 / n - (g / n) ** 2);
  return { meanLum: g / n, sharpness: Math.sqrt(Math.max(0, vh)) / Math.sqrt(vg) };
}

// ---------------------------------------------------------------- full pipeline for one side
export function analyzeSide(card, side = 'front', { debug = false, fullArt = false, era = '' } = {}) {
  const log = debug ? [] : null;
  const gray = toGray(card);
  const hsv = toHSV(card);
  // Full-art cards and card backs have only a narrow printed border: do not let the scan wander into the art.
  const frame = measureFrame(gray, { maxBorderFrac: (fullArt && side === 'front') ? 0.065 : side === 'back' ? 0.09 : 0.14 });
  const edgeInfo = analyzeEdgesAndCorners(card, hsv, frame, side);
  const surface = analyzeSurface(card, gray, hsv, frame, edgeInfo, side, log, { fullArt, era });
  const defects = [...centeringDefects(frame, side), ...edgeInfo.defects, ...surface.defects];
  const stats = imageStats(gray, surface.highpass);
  return { side, frame, edgeInfo, surface, defects, gray, log, stats };
}
