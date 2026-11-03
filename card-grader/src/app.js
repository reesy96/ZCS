// UI glue for the Card Grader PWA.
import { ERAS, RARITIES, recommendGrader } from './recommend.js';
import { computeGrades, whatIf, EU_SCALE, usableDefect } from './grading.js';
import { assessQuality } from './quality.js';
import { DEFECT_NAMES, severityWord, confidenceWord, defectSentence, whatIfSentence, summaryLine, buildTextReport } from './report.js';

const $ = (s) => document.querySelector(s);
const state = { images: { front: null, back: null }, results: {}, grades: null, whatIfs: [], recommendation: null, side: 'front', filter: 'original', activeDefect: -1 };
let MAX_SIDE = 1800; // longest side of the source photo we hand to the analyzer (lowered automatically on memory errors)
const MIN_SIDE = 1100;

// ---------------------------------------------------------------- setup
for (const e of ERAS) $('#era').append(new Option(e.label, e.id));
for (const r of RARITIES) $('#rarity').append(new Option(r.label, r.id));
$('#era').value = 'sv'; $('#rarity').value = 'holo';
try { const saved = JSON.parse(localStorage.getItem('cg-meta') || '{}'); if (saved.era) $('#era').value = saved.era; if (saved.rarity) $('#rarity').value = saved.rarity; } catch {}
for (const id of ['era', 'rarity']) $('#' + id).addEventListener('change', () => { try { localStorage.setItem('cg-meta', JSON.stringify({ era: $('#era').value, rarity: $('#rarity').value })); } catch {} });
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

$('#file-front').addEventListener('change', e => loadFile(e.target.files[0], 'front'));
$('#file-back').addEventListener('change', e => loadFile(e.target.files[0], 'back'));
for (const b of document.querySelectorAll('[data-live]')) b.addEventListener('click', () => openLive(b.dataset.live));
$('#analyze').addEventListener('click', analyze);

async function loadFile(file, side) {
  if (!file) return;
  const bmp = await decodeImage(file);
  setImage(side, bmp);
}
async function decodeImage(file) {
  // Phone photos are often 12-108 MP; decoding them at full size needs hundreds of MB and kills the tab.
  // 1) WebCodecs ImageDecoder can decode JPEG straight to a smaller size (scaled DCT decode, tiny memory).
  // 2) Otherwise createImageBitmap with resize options. 3) Plain <img> as the last resort.
  const dims = await imageDimensions(file).catch(() => null);
  const scale = dims ? Math.min(1, MAX_SIDE / Math.max(dims.w, dims.h)) : 1;
  const tw = dims ? Math.round(dims.w * scale) : 0, th = dims ? Math.round(dims.h * scale) : 0;
  if ('ImageDecoder' in window && dims && scale < 1 && /^image\/(jpeg|png|webp)$/.test(file.type)) {
    try {
      const buf = await file.arrayBuffer();
      const orientation = file.type === 'image/jpeg' ? exifOrientation(buf) : 1;
      const dec = new ImageDecoder({ data: buf, type: file.type, desiredWidth: tw, desiredHeight: th });
      const { image } = await dec.decode();
      const bmp = await createImageBitmap(image); image.close(); dec.close();
      return orientation > 1 ? applyOrientation(bmp, orientation) : bmp;
    } catch (e) { console.warn('ImageDecoder path failed, falling back', e); }
  }
  if ('createImageBitmap' in window) {
    try {
      const opts = { imageOrientation: 'from-image' };
      if (scale < 1) { opts.resizeWidth = tw; opts.resizeHeight = th; opts.resizeQuality = 'high'; }
      return await createImageBitmap(file, opts);
    } catch {}
  }
  return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = URL.createObjectURL(file); });
}
// EXIF orientation (1..8) from a JPEG buffer; 1 when absent. ImageDecoder does not apply it for us.
function exifOrientation(buf) {
  const v = new DataView(buf);
  if (v.getUint16(0) !== 0xFFD8) return 1;
  let o = 2;
  while (o + 4 <= v.byteLength) {
    const marker = v.getUint16(o); const len = v.getUint16(o + 2);
    if (marker === 0xFFE1 && v.getUint32(o + 4) === 0x45786966) { // "Exif"
      const t = o + 10; const le = v.getUint16(t) === 0x4949;
      const ifd = t + v.getUint32(t + 4, le); const n = v.getUint16(ifd, le);
      for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (v.getUint16(e, le) === 0x0112) return v.getUint16(e + 8, le) || 1; }
      return 1;
    }
    if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) break;
    o += 2 + len;
  }
  return 1;
}
function applyOrientation(bmp, orientation) {
  const swap = orientation >= 5;
  const c = document.createElement('canvas'); c.width = swap ? bmp.height : bmp.width; c.height = swap ? bmp.width : bmp.height;
  const ctx = c.getContext('2d');
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, c.width, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, c.width, c.height); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, c.height); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, c.width, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, c.width, c.height); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, c.height); break;
  }
  ctx.drawImage(bmp, 0, 0); bmp.close();
  return c;
}
// Read the pixel dimensions without decoding pixels (an <img> element reports naturalWidth after a header-only decode).
function imageDimensions(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => { const w = img.naturalWidth, h = img.naturalHeight; URL.revokeObjectURL(url); img.src = ''; res({ w, h }); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('nelze přečíst obrázek')); };
    img.src = url;
  });
}
function setImage(side, source) {
  const sw = source.width || source.videoWidth, sh = source.height || source.videoHeight;
  const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
  const c = document.createElement('canvas'); c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, c.width, c.height);
  if (source.close) source.close(); // free the decoded bitmap right away
  // Keep only the canvas; pixels are extracted (and transferred, not copied) when the analysis starts.
  state.images[side] = { canvas: c, w: c.width, h: c.height };
  const thumb = $('#thumb-' + side); thumb.innerHTML = ''; thumb.classList.add('has');
  const t = document.createElement('canvas'); const ts = 300 / Math.max(c.width, c.height); t.width = c.width * ts; t.height = c.height * ts;
  t.getContext('2d').drawImage(c, 0, 0, t.width, t.height); thumb.append(t);
  $('#analyze').disabled = !state.images.front;
}

// ---------------------------------------------------------------- live camera
let stream = null, liveSide = 'front';
const liveAvailable = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
if (!liveAvailable) for (const b of document.querySelectorAll('[data-live]')) { b.title = 'Živá kamera funguje jen přes HTTPS nebo localhost'; b.classList.add('disabled-soft'); }
async function openLive(side) {
  liveSide = side;
  if (!liveAvailable) {
    alert(window.isSecureContext
      ? 'Tento prohlížeč živou kameru nepodporuje. Použij tlačítko „Vyfotit / vybrat“ – otevře systémový fotoaparát v plném rozlišení.'
      : 'Živá kamera funguje jen na zabezpečené adrese (HTTPS nebo localhost). Přes http://IP ji prohlížeč blokuje.\n\nPoužij tlačítko „Vyfotit / vybrat“ – otevře systémový fotoaparát a výsledek je stejný.');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } }, audio: false });
  } catch (e) { alert('Kameru se nepodařilo otevřít: ' + e.message + '\nPoužij tlačítko „Vyfotit / vybrat“.'); return; }
  const v = $('#live-video'); v.srcObject = stream; $('#live').hidden = false;
  v.onloadedmetadata = () => { $('#live-info').textContent = `${v.videoWidth}×${v.videoHeight}`; };
}
function closeLive() { if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; } $('#live').hidden = true; }
$('#live-cancel').addEventListener('click', closeLive);
$('#live-shutter').addEventListener('click', async () => {
  const v = $('#live-video');
  const track = stream && stream.getVideoTracks()[0];
  let source = v;
  if (track && 'ImageCapture' in window) { try { const blob = await new ImageCapture(track).takePhoto(); source = await decodeImage(blob); } catch {} }
  setImage(liveSide, source);
  closeLive();
});

// ---------------------------------------------------------------- analysis
let worker = null, workerFailed = false, reqId = 0;
function getWorker() {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onerror = (e) => { const w = worker; worker = null; if (!w.gotMessage) workerFailed = true; for (const f of w.pending || []) f(new Error(e.message || 'worker selhal (pravděpodobně nedostatek paměti)')); w.pending = []; };
    worker.pending = [];
  } catch { workerFailed = true; }
  return worker;
}
function analyzeInWorker(side, image) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    if (!w) return runInline(side, image).then(resolve, reject);
    const id = ++reqId;
    const onMsg = (e) => { if (e.data.id !== id) return; w.gotMessage = true; w.removeEventListener('message', onMsg); w.pending = w.pending.filter(f => f !== reject); e.data.ok ? resolve(e.data.result) : reject(new Error(e.data.error)); };
    w.addEventListener('message', onMsg); w.pending.push(reject);
    const px = pixelsOf(image);
    w.postMessage({ id, side, image: { w: px.w, h: px.h, data: px.data.buffer }, hints: analysisHints() }, [px.data.buffer]);
    setTimeout(() => { if (workerFailed && !w.gotMessage) { w.removeEventListener('message', onMsg); runInline(side, image).then(resolve, reject); } }, 1500);
  });
}
function analysisHints() { return { fullArt: ['ultra', 'secret', 'illustration'].includes($('#rarity').value), era: $('#era').value }; }
// Pixels of a stored image at the current MAX_SIDE (re-sampled smaller after a memory error).
function pixelsOf(image) {
  const scale = Math.min(1, MAX_SIDE / Math.max(image.w, image.h));
  let c = image.canvas;
  if (scale < 1) { c = document.createElement('canvas'); c.width = Math.round(image.w * scale); c.height = Math.round(image.h * scale); c.getContext('2d').drawImage(image.canvas, 0, 0, c.width, c.height); }
  const id = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
  return { w: c.width, h: c.height, data: id.data };
}
async function runInline(side, image) {
  const [{ rectifyCard }, { analyzeSide }, { packResult }] = await Promise.all([import('./cardDetect.js'), import('./analyzers.js'), import('./pack.js')]);
  const px = pixelsOf(image);
  const rect = rectifyCard({ w: px.w, h: px.h, data: px.data });
  return packResult(rect, analyzeSide(rect.card, side, analysisHints()));
}
function progress(p, text) { $('#progress').hidden = false; $('#progress-fill').style.width = Math.round(p * 100) + '%'; $('#progress-text').textContent = text; }

async function analyze() {
  $('#analyze').disabled = true; $('#results').hidden = true; state.results = {};
  try {
    const sides = ['front', 'back'].filter(s => state.images[s]);
    let i = 0;
    for (const side of sides) {
      progress((i + 0.1) / sides.length, `${side === 'front' ? 'Přední' : 'Zadní'} strana: hledám kartu, narovnávám a měřím…`);
      try {
        state.results[side] = await analyzeInWorker(side, state.images[side]);
      } catch (e) {
        if (MAX_SIDE <= MIN_SIDE) throw e;
        // Most likely out of memory: drop the working resolution and try once more.
        MAX_SIDE = MIN_SIDE; if (worker) { worker.terminate(); worker = null; }
        progress((i + 0.2) / sides.length, 'Málo paměti – zkouším znovu v nižším rozlišení…');
        state.results[side] = await analyzeInWorker(side, state.images[side]);
      }
      i++;
    }
    progress(0.95, 'Vyhodnocuji grade…');
    grade();
    render();
    $('#progress').hidden = true;
    $('#results').hidden = false;
    $('#results').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    console.error(e);
    progress(1, 'Analýza selhala: ' + e.message + ' – zkus menší fotku nebo zavřít ostatní karty prohlížeče.');
  } finally { $('#analyze').disabled = false; }
}

function grade() {
  const f = state.results.front, b = state.results.back;
  const defects = [...f.defects, ...(b ? b.defects : [])];
  const centering = { front: { lr: f.frame.lr, tb: f.frame.tb, confidence: f.frame.confidence } };
  if (b && b.frame.valid) centering.back = { lr: b.frame.lr, tb: b.frame.tb, confidence: b.frame.confidence };
  state.defects = defects;
  state.quality = { front: assessQuality(f, { era: $('#era').value, sideName: 'front' }), back: b ? assessQuality(b, { era: $('#era').value, sideName: 'back' }) : null };
  state.grades = computeGrades(defects, centering);
  const qf = state.quality.front.score * (state.quality.back ? Math.max(0.6, state.quality.back.score) : 1);
  state.grades.confidence = Math.max(0.1, state.grades.confidence * qf);
  state.whatIfs = whatIf(defects, centering, state.grades);
  state.recommendation = recommendGrader({ era: $('#era').value, rarity: $('#rarity').value, grades: state.grades });
}

// ---------------------------------------------------------------- rendering
const ICONS = { centering: '⇔', whitening_edge: '▭', whitening_corner: '◸', scratch: '⟋', print_line: '≡', crease: '⚡', dent: '◉', bend: '⌒' };
const FILTERS = [
  ['original', 'Originál', 'Narovnaná karta tak, jak ji aplikace vidí.'],
  ['centering', 'Centrování', 'Změřené šířky okrajů (px) a poměry L/R, T/B. Čáry ukazují nalezený vnitřní rámeček.'],
  ['whitening', 'Whitening', 'Červeně pixely na hranách a rozích, které jsou výrazně světlejší a méně syté než zbytek okraje.'],
  ['surface', 'Povrch', 'Horní propust: zvýrazní jemné škrábance a tiskové linky v ploše.'],
  ['emboss', 'Emboss', 'Reliéfní sken jako u gradingových firem: šedý podklad, každá nerovnost povrchu (dent, kríz, škrábanec, vlnka) vrhá „stín“. Přepni směr světla, vady vyniknou z různých stran.'],
  ['relief', 'Reliéf', 'Pásmová propust: denty a ohyby se projeví jako měkké světlé/tmavé skvrny, krízy jako dlouhé linie.'],
  ['corners', 'Rohy 4×', 'Čtyři rohy zvětšené 4×, whitening podbarven červeně.'],
  ['defects', 'Vady', 'Všechny nalezené vady vyznačené na kartě.'],
];
function renderQuality() {
  const q = state.quality.front, qb = state.quality.back;
  const issues = [...q.issues.map(i => ({ ...i, text: (qb ? 'Přední: ' : '') + i.text })), ...(qb ? qb.issues.map(i => ({ ...i, text: 'Zadní: ' + i.text })) : [])];
  const box = $('#quality');
  const ok = q.ok && (!qb || qb.ok);
  $('#results').classList.toggle('nograde', !ok);
  if (!issues.length) { box.hidden = true; $('#grades-block').hidden = false; return; }
  box.hidden = false; box.className = 'quality ' + (ok ? 'warn' : 'fail');
  box.innerHTML = `<b>${ok ? '⚠️ Snímek má nedostatky – známka je jen orientační' : '⛔ Snímek nestačí na spolehlivé hodnocení'}</b><ul>${issues.map(i => `<li class="${i.level}">${i.text}</li>`).join('')}</ul>` +
    (ok ? '' : '<p>Známky jsem proto schoval, aby nemátly. Níže vidíš, co detektor našel; vyfoť kartu znovu podle tipů a spusť analýzu znovu.</p>');
  $('#grades-block').hidden = !ok;
}
function render() {
  const g = state.grades;
  renderQuality();
  $('#eu-grade').textContent = `${g.eu.grade} (${g.eu.short})`;
  $('#psa-grade').textContent = g.psa.label; $('#bgs-grade').textContent = g.bgs.label; $('#cgc-grade').textContent = g.cgc.label;
  $('#summary-line').textContent = summaryLine(g);
  const f = state.results.front;
  const warn = [];
  if (!f.frame.valid && !state.quality.front.issues.some(i => i.code === 'no-frame')) warn.push('Vnitřní rámeček nenalezen (full-art karta?), centrování nelze změřit.');
  $('#confidence-line').textContent = `Jistota odhadu: ${confidenceWord(g.confidence)} (${Math.round(g.confidence * 100)} %). ${warn.join(' ')}`;

  const subs = $('#subgrades'); subs.innerHTML = '';
  const subNames = { centering: 'Centrování', corners: 'Rohy', edges: 'Hrany', surface: 'Povrch' };
  for (const [k, name] of Object.entries(subNames)) {
    const v = g.subgrades[k];
    const d = document.createElement('div'); d.className = 'sub ' + (v === null ? '' : v >= 8.5 ? 'ok' : v >= 6.5 ? 'mid' : 'low');
    const extra = k === 'centering' && v !== null ? ` <span class="muted">(${g.centeringLabel.lr} · ${g.centeringLabel.tb})</span>` : '';
    d.innerHTML = `<span>${name}${extra}</span><div class="track"><i style="width:${v === null ? 0 : v * 10}%"></i></div><b>${v === null ? 'n/a' : v}</b>`;
    subs.append(d);
  }

  const st = $('#side-toggle'); st.innerHTML = '';
  for (const s of ['front', 'back']) {
    if (!state.results[s]) continue;
    const b = document.createElement('button'); b.textContent = s === 'front' ? 'Přední' : 'Zadní'; b.className = s === state.side ? 'active' : '';
    b.onclick = () => { state.side = s; render(); }; st.append(b);
  }
  if (!state.results[state.side]) state.side = 'front';
  const fl = $('#filters'); fl.innerHTML = '';
  for (const [id, label] of FILTERS) {
    const b = document.createElement('button'); b.textContent = label; b.className = id === state.filter ? 'active' : '';
    b.onclick = () => { state.filter = id; drawView(); updateFilterButtons(); }; fl.append(b);
  }
  drawView();

  const ul = $('#defects'); ul.innerHTML = '';
  if (!state.defects.length) ul.innerHTML = '<li class="empty">Žádné zřetelné vady. 🎉</li>';
  state.defects.forEach((d, i) => {
    const li = document.createElement('li'); if (i === state.activeDefect) li.classList.add('active');
    const possible = !usableDefect(d) && d.type !== 'print_line';
    if (possible) li.classList.add('possible');
    li.innerHTML = `<div class="ico">${ICONS[d.type] || '•'}</div><div><div class="title">${possible ? 'Možný ' : ''}${possible ? (DEFECT_NAMES[d.type] || d.type).toLowerCase() : (DEFECT_NAMES[d.type] || d.type)} – ${severityWord(d.severity)}<span class="sev"><i style="width:${Math.round(d.severity * 100)}%"></i></span></div><div class="meta">${d.side === 'back' ? 'zadní strana' : 'přední strana'}${d.note ? ' · ' + d.note : ''} · jistota ${confidenceWord(d.confidence)}${possible ? ' · do známky se nepočítá, ověř v bočním světle' : ''}</div></div>`;
    li.onclick = () => { state.activeDefect = i; state.side = d.side; state.filter = 'defects'; render(); $('#view').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    ul.append(li);
  });

  const wi = $('#whatif'); wi.innerHTML = '';
  if (!state.whatIfs.length) wi.innerHTML = `<li class="empty">${state.defects.length ? 'Žádná jednotlivá vada známku sama o sobě nezlepší – limituje kombinace vad.' : 'Karta je bez nalezených vad – není co zlepšovat.'}</li>`;
  for (const w of state.whatIfs) { const li = document.createElement('li'); li.textContent = whatIfSentence(w, g); wi.append(li); }

  const rc = $('#recommend'); rc.innerHTML = '';
  for (const r of state.recommendation.recommendations) {
    const d = document.createElement('div'); d.className = 'rec' + (r.primary ? ' primary' : '');
    d.innerHTML = `<b>${r.primary ? '★ ' : ''}${r.grader}</b><p>${r.why}</p>`; rc.append(d);
  }
  for (const n of state.recommendation.notes) { const p = document.createElement('p'); p.className = 'note'; p.textContent = n; rc.append(p); }
}
function updateFilterButtons() {
  [...$('#filters').children].forEach((b, i) => b.classList.toggle('active', FILTERS[i][0] === state.filter));
  $('#filter-help').textContent = FILTERS.find(f => f[0] === state.filter)[2];
}

function grayToImageData(u8, w, h) {
  const id = new ImageData(w, h);
  for (let i = 0, j = 0; i < u8.length; i++, j += 4) { id.data[j] = id.data[j + 1] = id.data[j + 2] = u8[i]; id.data[j + 3] = 255; }
  return id;
}
// Emboss: directional derivative of the (lightly smoothed) luminance around mid grey, like the surface scans
// grading companies publish. Cached per side + direction.
const EMBOSS_DIRS = [['↖', -1, -1], ['↑', 0, -1], ['↗', 1, -1], ['→', 1, 0]];
state.embossDir = 1; state.embossStrength = 4;
function embossImage(r) {
  const key = `${state.side}-${state.embossDir}-${state.embossStrength}`;
  if (r._emboss && r._emboss.key === key) return r._emboss.img;
  const { w, h } = r; const d = r.card;
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  // 3x3 box smoothing to keep sensor noise out of the relief.
  const sm = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; sm[i] = (g[i - w - 1] + g[i - w] + g[i - w + 1] + g[i - 1] + g[i] + g[i + 1] + g[i + w - 1] + g[i + w] + g[i + w + 1]) / 9; }
  const [, dx, dy] = EMBOSS_DIRS[state.embossDir]; const k = state.embossStrength;
  const img = new ImageData(w, h);
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x;
    const v = Math.max(0, Math.min(255, 128 + k * (sm[(y + dy) * w + (x + dx)] - sm[(y - dy) * w + (x - dx)])));
    const o = i * 4; img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255;
  }
  r._emboss = { key, img };
  return img;
}
function renderEmbossDirs() {
  const box = $('#emboss-dirs'); box.hidden = state.filter !== 'emboss'; box.innerHTML = '';
  if (box.hidden) return;
  EMBOSS_DIRS.forEach(([label], i) => { const b = document.createElement('button'); b.textContent = `Světlo ${label}`; b.className = i === state.embossDir ? 'active' : ''; b.onclick = () => { state.embossDir = i; drawView(); }; box.append(b); });
  for (const [label, k] of [['jemně', 2.5], ['silně', 6]]) { const b = document.createElement('button'); b.textContent = label; b.className = state.embossStrength === k ? 'active' : ''; b.onclick = () => { state.embossStrength = state.embossStrength === k ? 4 : k; drawView(); }; box.append(b); }
}
function drawView() {
  const r = state.results[state.side]; if (!r) return;
  renderEmbossDirs();
  const { w, h } = r;
  const canvas = $('#view');
  const ctx = canvas.getContext('2d');
  updateFilterButtons();
  if (state.filter === 'corners') { drawCorners(r, canvas, ctx); return; }
  canvas.width = w; canvas.height = h;
  let base;
  if (state.filter === 'surface') base = grayToImageData(r.highpass, w, h);
  else if (state.filter === 'relief') base = grayToImageData(r.relief, w, h);
  else if (state.filter === 'emboss') base = embossImage(r);
  else base = new ImageData(new Uint8ClampedArray(r.card), w, h);
  if (state.filter === 'whitening') { for (let i = 0, j = 0; i < w * h; i++, j += 4) if (r.whitening[i]) { base.data[j] = 255; base.data[j + 1] = 40; base.data[j + 2] = 40; } }
  ctx.putImageData(base, 0, 0);
  ctx.lineWidth = 3; ctx.font = 'bold 26px system-ui, sans-serif';
  if (state.filter === 'centering' && r.frame.valid) {
    const { L, R, T, B } = r.frame;
    ctx.strokeStyle = 'rgba(255,203,5,.9)'; ctx.strokeRect(L, T, w - L - R, h - T - B);
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(w / 2 - 170, h / 2 - 60, 340, 120);
    ctx.fillStyle = '#ffcb05'; ctx.textAlign = 'center';
    ctx.fillText(r.frame.lrOk ? `L ${L} px · R ${R} px → ${Math.round(r.frame.lr * 100)}/${Math.round((1 - r.frame.lr) * 100)}` : 'L/R: rámeček nenalezen', w / 2, h / 2 - 15);
    ctx.fillText(r.frame.tbOk ? `T ${T} px · B ${B} px → ${Math.round(r.frame.tb * 100)}/${Math.round((1 - r.frame.tb) * 100)}` : 'T/B: rámeček nenalezen', w / 2, h / 2 + 30);
  } else if (state.filter === 'centering') {
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(w / 2 - 200, h / 2 - 30, 400, 60); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText('Rámeček nenalezen – centrování nelze změřit', w / 2, h / 2 + 8);
  }
  if (state.filter === 'defects' || state.filter === 'whitening' || state.filter === 'surface' || state.filter === 'relief' || state.filter === 'emboss') {
    r.defects.forEach(d => {
      const globalIdx = state.defects.indexOf(d) >= 0 ? state.defects.indexOf(d) : state.defects.findIndex(x => x.type === d.type && x.box && d.box && x.box.x === d.box.x && x.box.y === d.box.y);
      const active = globalIdx === state.activeDefect;
      if (state.filter !== 'defects' && !active) return;
      const col = { crease: '#f87171', dent: '#fb923c', bend: '#fb923c', scratch: '#60a5fa', print_line: '#94a3b8', whitening_edge: '#f43f5e', whitening_corner: '#f43f5e', centering: '#ffcb05' }[d.type] || '#fff';
      ctx.strokeStyle = col; ctx.lineWidth = active ? 6 : 3;
      if (d.line) { ctx.beginPath(); ctx.moveTo(d.line.x0, d.line.y0); ctx.lineTo(d.line.x1, d.line.y1); ctx.stroke(); }
      if (d.box && d.type !== 'centering') { const pad = 8; ctx.strokeRect(d.box.x - pad, d.box.y - pad, d.box.w + 2 * pad, d.box.h + 2 * pad); }
      if (d.box) {
        const label = `${ICONS[d.type] || ''} ${DEFECT_NAMES[d.type] || d.type}`;
        const tx = Math.min(w - 10, Math.max(10, d.box.x)), ty = Math.max(30, d.box.y - 12);
        ctx.font = 'bold 22px system-ui, sans-serif'; ctx.textAlign = 'left';
        const tw = ctx.measureText(label).width + 12;
        ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(Math.min(tx, w - tw), ty - 22, tw, 28);
        ctx.fillStyle = col; ctx.fillText(label, Math.min(tx, w - tw) + 6, ty);
      }
    });
  }
}
function drawCorners(r, canvas, ctx) {
  const { w, h, cornerR } = r; const cs = cornerR, Z = 4, gap = 12;
  canvas.width = cs * Z * 2 + gap; canvas.height = cs * Z * 2 + gap;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const src = document.createElement('canvas'); src.width = w; src.height = h;
  const id = new ImageData(new Uint8ClampedArray(r.card), w, h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) if (r.whitening[i]) { id.data[j] = 255; id.data[j + 1] = 60; id.data[j + 2] = 60; }
  src.getContext('2d').putImageData(id, 0, 0);
  ctx.imageSmoothingEnabled = false;
  const spots = [['tl', 0, 0, 0, 0], ['tr', w - cs, 0, cs * Z + gap, 0], ['bl', 0, h - cs, 0, cs * Z + gap], ['br', w - cs, h - cs, cs * Z + gap, cs * Z + gap]];
  for (const [name, sx, sy, dx, dy] of spots) {
    ctx.drawImage(src, sx, sy, cs, cs, dx, dy, cs * Z, cs * Z);
    const c = r.corners[name];
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(dx, dy + cs * Z - 34, cs * Z, 34);
    ctx.fillStyle = c && c.fraction > 0.006 ? '#f87171' : '#4ade80'; ctx.font = 'bold 22px system-ui, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(`${{ tl: 'Levý horní', tr: 'Pravý horní', bl: 'Levý dolní', br: 'Pravý dolní' }[name]} · whitening ${(c.fraction * 100).toFixed(1)} %`, dx + 8, dy + cs * Z - 10);
  }
}

// ---------------------------------------------------------------- export
function reportText() {
  return buildTextReport({ meta: { name: $('#cardName').value.trim() }, grades: state.grades, defects: state.defects, whatIfs: state.whatIfs, recommendation: state.recommendation });
}
$('#copy-report').addEventListener('click', async () => { try { await navigator.clipboard.writeText(reportText()); $('#copy-report').textContent = 'Zkopírováno ✓'; setTimeout(() => $('#copy-report').textContent = 'Kopírovat report', 1500); } catch { prompt('Zkopíruj text:', reportText()); } });
$('#share-report').addEventListener('click', async () => { if (navigator.share) { try { await navigator.share({ title: 'Card Grader report', text: reportText() }); } catch {} } else alert('Sdílení není v tomto prohlížeči dostupné – použij Kopírovat report.'); });
$('#download-json').addEventListener('click', () => {
  const out = { meta: { name: $('#cardName').value, era: $('#era').value, rarity: $('#rarity').value, date: new Date().toISOString() }, quality: state.quality, grades: state.grades, defects: state.defects, whatIfs: state.whatIfs.map(w => ({ type: w.group.type, without: w.without, delta: w.delta })), recommendation: state.recommendation,
    measurements: Object.fromEntries(Object.entries(state.results).map(([s, r]) => [s, { frame: r.frame, edges: r.edges, corners: r.corners, glareFrac: r.glareFrac, detected: r.detected, detectConfidence: r.detectConfidence }])) };
  download(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), 'card-grader-report.json');
});
$('#download-image').addEventListener('click', () => { state.filter = 'defects'; drawView(); $('#view').toBlob(b => download(b, 'card-grader-vady.png'), 'image/png'); });
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }

// Expose for tests.
window.__cardGrader = { state, setImage, analyze, EU_SCALE, defectSentence };
