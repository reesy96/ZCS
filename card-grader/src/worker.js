// Analysis worker: keeps the UI responsive while the (CPU heavy) image pipeline runs.
import { rectifyCard } from './cardDetect.js';
import { analyzeSide } from './analyzers.js';
import { packResult } from './pack.js';

self.onmessage = (e) => {
  const { id, side, image } = e.data;
  try {
    const img = { w: image.w, h: image.h, data: new Uint8ClampedArray(image.data) };
    const rect = rectifyCard(img);
    const res = analyzeSide(rect.card, side);
    const packed = packResult(rect, res);
    self.postMessage({ id, ok: true, result: packed }, packed.transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.stack || err) });
  }
};
