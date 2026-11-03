// Turn the (large) analysis result into a compact, transferable object for the UI.
function toU8(gray, scale, offset = 128) {
  const out = new Uint8ClampedArray(gray.data.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, offset + gray.data[i] * scale));
  return out;
}
function up2(small, w, h) { // nearest-neighbour upscale of a half-res float map to full size, as U8 centered at 128
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = small.data[Math.min(small.h - 1, y >> 1) * small.w + Math.min(small.w - 1, x >> 1)];
    out[y * w + x] = Math.max(0, Math.min(255, 128 + v * 2.5));
  }
  return out;
}
export function packResult(rect, res) {
  const { card, quad, confidence, detected } = rect;
  const w = card.w, h = card.h;
  const whitening = res.edgeInfo.whitening.data;
  const highpass = toU8(res.surface.highpass, 4);
  const relief = toU8(res.surface.relief, 3);
  const ridge = up2(res.surface.creaseResp, w, h);
  const strip = (d) => ({ ...d });
  const result = {
    side: res.side, w, h, quad, detectConfidence: confidence, detected,
    card: card.data, whitening, highpass, relief, ridge,
    frame: { L: res.frame.L, R: res.frame.R, T: res.frame.T, B: res.frame.B, valid: res.frame.valid, confidence: res.frame.confidence, lr: res.frame.lr, tb: res.frame.tb, art: res.frame.art },
    edges: Object.fromEntries(Object.entries(res.edgeInfo.edges).map(([k, v]) => [k, { fraction: v.fraction, coverage: v.coverage, longestRun: v.longestRun }])),
    corners: res.edgeInfo.corners, band: res.edgeInfo.band, cornerR: res.edgeInfo.cornerR, uniformBorder: res.edgeInfo.uniformBorder,
    glareFrac: res.surface.glareFrac,
    defects: res.defects.map(strip),
  };
  result.transfer = [result.card.buffer, whitening.buffer, highpass.buffer, relief.buffer, ridge.buffer];
  return result;
}
