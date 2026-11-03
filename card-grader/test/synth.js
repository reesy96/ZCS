// Synthetic Pokémon-style card generator with controllable defects, plus a PNG writer (no deps).
import { makeRGBA, findHomography, applyH } from '../src/imgproc.js';
import { CARD_W, CARD_H } from '../src/cardDetect.js';
import zlib from 'node:zlib';
import fs from 'node:fs';

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

export function makeCard(opts = {}) {
  const { borderL = 32, borderR = 32, borderT = 32, borderB = 32, seed = 1, borderColor = [247, 206, 60], holo = true } = opts;
  const w = CARD_W, h = CARD_H;
  const img = makeRGBA(w, h);
  const r = rng(seed);
  const set = (x, y, c) => { if (x < 0 || y < 0 || x >= w || y >= h) return; const i = (y * w + x) * 4; img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255; };
  const get = (x, y) => { const i = (y * w + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
  // Border + subtle paper texture.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const n = (r() - 0.5) * 6;
    set(x, y, [borderColor[0] + n, borderColor[1] + n, borderColor[2] + n]);
  }
  // Art/text area with a dark frame line.
  const ax = borderL, ay = borderT, aw = w - borderL - borderR, ah = h - borderT - borderB;
  for (let y = ay; y < ay + ah; y++) for (let x = ax; x < ax + aw; x++) {
    const edge = x - ax < 3 || y - ay < 3 || ax + aw - x <= 3 || ay + ah - y <= 3;
    if (edge) { set(x, y, [40, 40, 40]); continue; }
    const u = (x - ax) / aw, v = (y - ay) / ah;
    let c;
    if (v < 0.5) {
      // Illustration: smooth gradients + holo sparkle noise.
      const base = [90 + 120 * u, 120 + 80 * Math.sin(v * 9 + u * 3), 180 - 100 * v];
      const sparkle = holo ? (r() < 0.04 ? 60 : 0) + (r() - 0.5) * 18 : (r() - 0.5) * 6;
      c = base.map(q => q + sparkle);
    } else {
      // Text box: light background with horizontal "text" rows.
      const textRow = Math.floor((v - 0.5) * 40) % 3 === 1 && (Math.floor(u * 50) % 2 === 0) && u > 0.05 && u < 0.9;
      c = textRow ? [50, 50, 50] : [235, 232, 220 + (r() - 0.5) * 8];
      if (Math.abs(v - 0.5) * ah < 2) c = [40, 40, 40]; // divider line
    }
    set(x, y, c);
  }
  const blendWhite = (x, y, amt) => { const c = get(x, y); set(x, y, c.map(q => q + (255 - q) * amt)); };
  // Defects.
  for (const d of opts.defects || []) {
    if (d.type === 'corner') {
      const cx = d.corner[1] === 'l' ? 0 : w - 1, cy = d.corner[0] === 't' ? 0 : h - 1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const dist = Math.hypot(x - cx, y - cy);
        if (dist < d.radius) blendWhite(x, y, Math.min(1, (1 - dist / d.radius) * 1.6 + 0.3) * (0.7 + 0.3 * r()));
      }
    } else if (d.type === 'edge') {
      // Whitening strip along an edge between t0..t1 (fraction), depth px.
      const len = d.edge === 'top' || d.edge === 'bottom' ? w : h;
      for (let t = Math.round(d.t0 * len); t < d.t1 * len; t++) for (let k = 0; k < d.depth; k++) {
        const amt = (1 - k / d.depth) * (0.6 + 0.4 * r());
        if (d.edge === 'top') blendWhite(t, k, amt); else if (d.edge === 'bottom') blendWhite(t, h - 1 - k, amt);
        else if (d.edge === 'left') blendWhite(k, t, amt); else blendWhite(w - 1 - k, t, amt);
      }
    } else if (d.type === 'scratch') {
      const n = Math.hypot(d.x1 - d.x0, d.y1 - d.y0);
      for (let i = 0; i <= n; i++) {
        const x = Math.round(d.x0 + (d.x1 - d.x0) * i / n), y = Math.round(d.y0 + (d.y1 - d.y0) * i / n);
        for (let k = 0; k < (d.width || 1); k++) blendWhite(x + k, y, d.amount ?? 0.8);
      }
    } else if (d.type === 'crease') {
      // Bright/dark pair across a line, softer than a scratch, longer.
      const n = Math.hypot(d.x1 - d.x0, d.y1 - d.y0);
      const nx = -(d.y1 - d.y0) / n, ny = (d.x1 - d.x0) / n;
      for (let i = 0; i <= n; i++) {
        const bx = d.x0 + (d.x1 - d.x0) * i / n, by = d.y0 + (d.y1 - d.y0) * i / n;
        for (let k = -4; k <= 4; k++) {
          const x = Math.round(bx + nx * k), y = Math.round(by + ny * k);
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const c = get(x, y);
          const f = (k < 0 ? -1 : 1) * (1 - Math.abs(k) / 5) * (d.strength ?? 45);
          set(x, y, c.map(q => q + f));
        }
      }
    } else if (d.type === 'dent') {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const dist = Math.hypot(x - d.x, y - d.y);
        if (dist < d.radius) {
          const c = get(x, y);
          const f = -(d.strength ?? 30) * Math.cos(dist / d.radius * Math.PI / 2) * ((x - d.x) / d.radius * 1.4 + 0.5);
          set(x, y, c.map(q => q + f));
        }
      }
    } else if (d.type === 'bend') {
      // Smooth luminance band across the card (shading from a bowed surface).
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const t = (d.horizontal ? x / w : y / h) - d.at;
        const f = -(d.strength ?? 25) * Math.exp(-(t * t) / (2 * d.sigma * d.sigma));
        const c = get(x, y); set(x, y, c.map(q => q + f));
      }
    }
  }
  return img;
}

// Place the card into a larger "photo" with rotation/perspective over a uniform-ish background.
export function embedInScene(card, { W = 1200, H = 1600, angle = 0.08, persp = 0.0002, bg = [70, 72, 80], scale = 0.75, seed = 7, wood = false, shadow = false } = {}) {
  void scale;
  const scene = makeRGBA(W, H);
  const r = rng(seed);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; const n = (r() - 0.5) * 10;
    let c = [bg[0] + n, bg[1] + n, bg[2] + n];
    if (wood) { // light oak: horizontal grain stripes with a few dark lines
      const grain = 12 * Math.sin(y * 0.09 + Math.sin(x * 0.01) * 3) + (Math.abs(Math.sin(y * 0.021)) > 0.985 ? -40 : 0);
      c = [196 + grain + n, 164 + grain * 0.9 + n, 118 + grain * 0.7 + n];
    }
    if (shadow) { const f = 1 - 0.45 * Math.max(0, Math.min(1, (x - W * 0.55) / (W * 0.2))); c = c.map(v => v * f); } // soft shadow on the right
    scene.data[i * 4] = c[0]; scene.data[i * 4 + 1] = c[1]; scene.data[i * 4 + 2] = c[2]; scene.data[i * 4 + 3] = 255;
  }
  const cw = card.w * scale * (H / card.h) * 0.9 / scale * scale, ch = card.h * scale * (H / card.h) * 0.9 / scale * scale;
  const cx = W / 2, cy = H / 2;
  const corners = [[-cw / 2, -ch / 2], [cw / 2, -ch / 2], [cw / 2, ch / 2], [-cw / 2, ch / 2]].map(([x, y]) => {
    const xr = x * Math.cos(angle) - y * Math.sin(angle), yr = x * Math.sin(angle) + y * Math.cos(angle);
    const p = 1 + persp * yr; // mild keystone
    return { x: cx + xr * p, y: cy + yr };
  });
  const H2 = findHomography([{ x: 0, y: 0 }, { x: card.w, y: 0 }, { x: card.w, y: card.h }, { x: 0, y: card.h }], corners);
  const Hinv = (() => { // invert by swapping point sets
    return findHomography(corners, [{ x: 0, y: 0 }, { x: card.w, y: 0 }, { x: card.w, y: card.h }, { x: 0, y: card.h }]);
  })();
  const minX = Math.floor(Math.min(...corners.map(p => p.x))), maxX = Math.ceil(Math.max(...corners.map(p => p.x)));
  const minY = Math.floor(Math.min(...corners.map(p => p.y))), maxY = Math.ceil(Math.max(...corners.map(p => p.y)));
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const p = applyH(Hinv, x + 0.5, y + 0.5);
    if (p.x < 0 || p.y < 0 || p.x >= card.w || p.y >= card.h) continue;
    const sx = Math.min(card.w - 1, Math.floor(p.x)), sy = Math.min(card.h - 1, Math.floor(p.y));
    const s = (sy * card.w + sx) * 4, o = (y * W + x) * 4;
    const f = shadow ? 1 - 0.45 * Math.max(0, Math.min(1, (x - W * 0.55) / (W * 0.2))) : 1;
    scene.data[o] = card.data[s] * f; scene.data[o + 1] = card.data[s + 1] * f; scene.data[o + 2] = card.data[s + 2] * f;
  }
  void H2;
  return { scene, corners };
}

// ---- PNG I/O (RGBA, 8-bit) ----
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePNG(img) {
  const { w, h, data } = img;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(data.buffer, data.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export function writePNG(img, path) { fs.writeFileSync(path, encodePNG(img)); }
