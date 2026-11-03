// UI glue for the Card Grader PWA.
import { ERAS, RARITIES, recommendGrader } from './recommend.js';
import { computeGrades, whatIf, EU_SCALE } from './grading.js';
import { DEFECT_NAMES, severityWord, confidenceWord, defectSentence, whatIfSentence, summaryLine, buildTextReport } from './report.js';

const $ = (s) => document.querySelector(s);
const state = { images: { front: null, back: null }, results: {}, grades: null, whatIfs: [], recommendation: null, side: 'front', filter: 'original', activeDefect: -1 };
const MAX_SIDE = 2200; // longest side of the source photo we hand to the analyzer

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
  if ('createImageBitmap' in window) { try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {} }
  return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = URL.createObjectURL(file); });
}
function setImage(side, source) {
  const sw = source.width || source.videoWidth, sh = source.height || source.videoHeight;
  const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
  const c = document.createElement('canvas'); c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, c.width, c.height);
  const imageData = ctx.getImageData(0, 0, c.width, c.height);
  state.images[side] = { imageData, w: c.width, h: c.height };
  const thumb = $('#thumb-' + side); thumb.innerHTML = ''; thumb.classList.add('has');
  const t = document.createElement('canvas'); const ts = 300 / Math.max(c.width, c.height); t.width = c.width * ts; t.height = c.height * ts;
  t.getContext('2d').drawImage(c, 0, 0, t.width, t.height); thumb.append(t);
  $('#analyze').disabled = !state.images.front;
}

// ---------------------------------------------------------------- live camera
let stream = null, liveSide = 'front';
async function openLive(side) {
  liveSide = side;
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
  if (track && 'ImageCapture' in window) { try { source = await new ImageCapture(track).takePhoto().then(b => createImageBitmap(b)); } catch {} }
  setImage(liveSide, source);
  closeLive();
});

// ---------------------------------------------------------------- analysis
let worker = null, workerFailed = false, reqId = 0;
function getWorker() {
  if (worker || workerFailed) return worker;
  try { worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); worker.onerror = () => { workerFailed = true; worker = null; }; }
  catch { workerFailed = true; }
  return worker;
}
function analyzeInWorker(side, image) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    if (!w) return runInline(side, image).then(resolve, reject);
    const id = ++reqId;
    const onMsg = (e) => { if (e.data.id !== id) return; w.removeEventListener('message', onMsg); e.data.ok ? resolve(e.data.result) : reject(new Error(e.data.error)); };
    w.addEventListener('message', onMsg);
    const copy = new Uint8ClampedArray(image.imageData.data); // keep the original for a possible retry
    w.postMessage({ id, side, image: { w: image.w, h: image.h, data: copy.buffer } }, [copy.buffer]);
    setTimeout(() => { if (workerFailed) { w.removeEventListener('message', onMsg); runInline(side, image).then(resolve, reject); } }, 1500);
  });
}
async function runInline(side, image) {
  const [{ rectifyCard }, { analyzeSide }, { packResult }] = await Promise.all([import('./cardDetect.js'), import('./analyzers.js'), import('./pack.js')]);
  const rect = rectifyCard({ w: image.w, h: image.h, data: image.imageData.data });
  return packResult(rect, analyzeSide(rect.card, side));
}
function progress(p, text) { $('#progress').hidden = false; $('#progress-fill').style.width = Math.round(p * 100) + '%'; $('#progress-text').textContent = text; }

async function analyze() {
  $('#analyze').disabled = true; $('#results').hidden = true; state.results = {};
  try {
    const sides = ['front', 'back'].filter(s => state.images[s]);
    let i = 0;
    for (const side of sides) {
      progress((i + 0.1) / sides.length, `${side === 'front' ? 'Přední' : 'Zadní'} strana: hledám kartu, narovnávám a měřím…`);
      state.results[side] = await analyzeInWorker(side, state.images[side]);
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
    progress(1, 'Analýza selhala: ' + e.message);
  } finally { $('#analyze').disabled = false; }
}

function grade() {
  const f = state.results.front, b = state.results.back;
  const defects = [...f.defects, ...(b ? b.defects : [])];
  const centering = { front: { lr: f.frame.lr, tb: f.frame.tb, confidence: f.frame.confidence } };
  if (b && b.frame.valid) centering.back = { lr: b.frame.lr, tb: b.frame.tb, confidence: b.frame.confidence };
  state.defects = defects;
  state.grades = computeGrades(defects, centering);
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
  ['relief', 'Reliéf', 'Pásmová propust: denty a ohyby se projeví jako měkké světlé/tmavé skvrny, krízy jako dlouhé linie.'],
  ['corners', 'Rohy 4×', 'Čtyři rohy zvětšené 4×, whitening podbarven červeně.'],
  ['defects', 'Vady', 'Všechny nalezené vady vyznačené na kartě.'],
];
function render() {
  const g = state.grades;
  $('#eu-grade').textContent = `${g.eu.grade} (${g.eu.short})`;
  $('#psa-grade').textContent = g.psa.label; $('#bgs-grade').textContent = g.bgs.label; $('#cgc-grade').textContent = g.cgc.label;
  $('#summary-line').textContent = summaryLine(g);
  const f = state.results.front;
  const warn = [];
  if (!f.detected) warn.push('Kartu se nepodařilo najít na pozadí – použit celý snímek.');
  if (f.glareFrac > 0.01) warn.push('Na snímku je odlesk (přepal), to snižuje spolehlivost detekce škrábanců.');
  if (!f.frame.valid) warn.push('Vnitřní rámeček nenalezen (full-art karta?), centrování nelze změřit.');
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
    li.innerHTML = `<div class="ico">${ICONS[d.type] || '•'}</div><div><div class="title">${DEFECT_NAMES[d.type] || d.type} – ${severityWord(d.severity)}<span class="sev"><i style="width:${Math.round(d.severity * 100)}%"></i></span></div><div class="meta">${d.side === 'back' ? 'zadní strana' : 'přední strana'}${d.note ? ' · ' + d.note : ''} · jistota ${confidenceWord(d.confidence)}</div></div>`;
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
function drawView() {
  const r = state.results[state.side]; if (!r) return;
  const { w, h } = r;
  const canvas = $('#view');
  const ctx = canvas.getContext('2d');
  updateFilterButtons();
  if (state.filter === 'corners') { drawCorners(r, canvas, ctx); return; }
  canvas.width = w; canvas.height = h;
  let base;
  if (state.filter === 'surface') base = grayToImageData(r.highpass, w, h);
  else if (state.filter === 'relief') base = grayToImageData(r.relief, w, h);
  else base = new ImageData(new Uint8ClampedArray(r.card), w, h);
  if (state.filter === 'whitening') { for (let i = 0, j = 0; i < w * h; i++, j += 4) if (r.whitening[i]) { base.data[j] = 255; base.data[j + 1] = 40; base.data[j + 2] = 40; } }
  ctx.putImageData(base, 0, 0);
  ctx.lineWidth = 3; ctx.font = 'bold 26px system-ui, sans-serif';
  if (state.filter === 'centering' && r.frame.valid) {
    const { L, R, T, B } = r.frame;
    ctx.strokeStyle = 'rgba(255,203,5,.9)'; ctx.strokeRect(L, T, w - L - R, h - T - B);
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(w / 2 - 170, h / 2 - 60, 340, 120);
    ctx.fillStyle = '#ffcb05'; ctx.textAlign = 'center';
    ctx.fillText(`L ${L} px · R ${R} px → ${Math.round(r.frame.lr * 100)}/${Math.round((1 - r.frame.lr) * 100)}`, w / 2, h / 2 - 15);
    ctx.fillText(`T ${T} px · B ${B} px → ${Math.round(r.frame.tb * 100)}/${Math.round((1 - r.frame.tb) * 100)}`, w / 2, h / 2 + 30);
  } else if (state.filter === 'centering') {
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(w / 2 - 200, h / 2 - 30, 400, 60); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText('Rámeček nenalezen – centrování nelze změřit', w / 2, h / 2 + 8);
  }
  if (state.filter === 'defects' || state.filter === 'whitening' || state.filter === 'surface' || state.filter === 'relief') {
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
  const out = { meta: { name: $('#cardName').value, era: $('#era').value, rarity: $('#rarity').value, date: new Date().toISOString() }, grades: state.grades, defects: state.defects, whatIfs: state.whatIfs.map(w => ({ type: w.group.type, without: w.without, delta: w.delta })), recommendation: state.recommendation,
    measurements: Object.fromEntries(Object.entries(state.results).map(([s, r]) => [s, { frame: r.frame, edges: r.edges, corners: r.corners, glareFrac: r.glareFrac, detected: r.detected, detectConfidence: r.detectConfidence }])) };
  download(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), 'card-grader-report.json');
});
$('#download-image').addEventListener('click', () => { state.filter = 'defects'; drawView(); $('#view').toBlob(b => download(b, 'card-grader-vady.png'), 'image/png'); });
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }

// Expose for tests.
window.__cardGrader = { state, setImage, analyze, EU_SCALE, defectSentence };
