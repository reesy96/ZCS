// Grading engine: turns a list of defects + centering into grade predictions
// on PSA (1-10), Beckett/BGS (1-10 with subgrades, 0.5 steps), CGC (1-10, 10 Pristine)
// and the European (Cardmarket) condition scale: Mint, Near Mint, Excellent, Good,
// Light Played, Played, Poor.
//
// Grades are *estimates*: every grader applies human judgement, and a phone photo
// cannot see everything. We encode the published grading standards as thresholds.

export const EU_SCALE = ['Poor', 'Played', 'Light Played', 'Good', 'Excellent', 'Near Mint', 'Mint'];
export const EU_SHORT = { Poor: 'PO', Played: 'PL', 'Light Played': 'LP', Good: 'GD', Excellent: 'EX', 'Near Mint': 'NM', Mint: 'M' };

export const PSA_LABELS = { 10: 'GEM-MT 10', 9: 'MINT 9', 8: 'NM-MT 8', 7: 'NM 7', 6: 'EX-MT 6', 5: 'EX 5', 4: 'VG-EX 4', 3: 'VG 3', 2: 'GOOD 2', 1: 'PR 1' };
export const BGS_LABELS = { 10: 'Pristine 10', 9.5: 'Gem Mint 9.5', 9: 'Mint 9', 8.5: 'NM-MT+ 8.5', 8: 'NM-MT 8', 7.5: 'NM+ 7.5', 7: 'NM 7', 6.5: 'EX-MT+ 6.5', 6: 'EX-MT 6', 5.5: 'EX+ 5.5', 5: 'EX 5', 4.5: 'VG-EX+ 4.5', 4: 'VG-EX 4', 3.5: 'VG+ 3.5', 3: 'VG 3', 2.5: 'G+ 2.5', 2: 'G 2', 1.5: 'F 1.5', 1: 'Poor 1' };
export const CGC_LABELS = { 10: 'Gem Mint 10', 9.5: 'Mint+ 9.5', 9: 'Mint 9', 8.5: 'NM/Mint+ 8.5', 8: 'NM/Mint 8', 7.5: 'NM+ 7.5', 7: 'NM 7', 6.5: 'EX/NM+ 6.5', 6: 'EX/NM 6', 5.5: 'EX+ 5.5', 5: 'EX 5', 4.5: 'VG/EX+ 4.5', 4: 'VG/EX 4', 3.5: 'VG+ 3.5', 3: 'VG 3', 2.5: 'G+ 2.5', 2: 'G 2', 1.5: 'FR 1.5', 1: 'PR 1' };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round05 = v => Math.round(v * 2) / 2;

// Centering: ratio of the larger border to the sum (0.5 = perfect). PSA front thresholds; back is looser.
export function centeringSubgrade(ratio, side = 'front') {
  if (ratio === null || ratio === undefined) return { grade: null, label: 'nelze změřit' };
  const worst = Math.max(ratio, 1 - ratio); // e.g. 0.55 means 55/45
  const front = [[0.55, 10], [0.60, 9], [0.65, 8], [0.70, 7], [0.75, 6], [0.80, 5], [0.85, 4], [0.90, 3]];
  const back = [[0.75, 10], [0.80, 9], [0.85, 8], [0.90, 7], [0.92, 6], [0.94, 5], [0.96, 4], [0.98, 3]];
  const table = side === 'back' ? back : front;
  for (const [thr, g] of table) if (worst <= thr + 1e-6) return { grade: g, label: `${Math.round(worst * 100)}/${Math.round((1 - worst) * 100)}` };
  return { grade: 2, label: `${Math.round(worst * 100)}/${Math.round((1 - worst) * 100)}` };
}

function cornersSubgrade(defs) {
  const cs = defs.filter(d => d.type === 'whitening_corner');
  if (!cs.length) return 10;
  const maxSev = Math.max(...cs.map(d => d.severity));
  const n = cs.length;
  let g = 10;
  if (maxSev < 0.08) g = n <= 1 ? 9.5 : 9;
  else if (maxSev < 0.18) g = n <= 1 ? 9 : 8.5;
  else if (maxSev < 0.3) g = n <= 2 ? 8 : 7.5;
  else if (maxSev < 0.45) g = n <= 2 ? 7 : 6.5;
  else if (maxSev < 0.65) g = 6;
  else if (maxSev < 0.85) g = 5;
  else g = 4;
  // Dents on corners count here too.
  if (defs.some(d => d.type === 'dent' && d.note && d.note.startsWith('na okraji') && d.severity > 0.5)) g = Math.min(g, 6);
  return g;
}

function edgesSubgrade(defs) {
  const es = defs.filter(d => d.type === 'whitening_edge');
  let g = 10;
  if (es.length) {
    const maxSev = Math.max(...es.map(d => d.severity));
    const n = es.length;
    if (maxSev < 0.06) g = n <= 1 ? 9.5 : 9;
    else if (maxSev < 0.15) g = n <= 1 ? 9 : 8.5;
    else if (maxSev < 0.3) g = 8;
    else if (maxSev < 0.5) g = 7;
    else if (maxSev < 0.7) g = 6;
    else if (maxSev < 0.9) g = 5;
    else g = 4;
  }
  const dents = defs.filter(d => d.type === 'dent' && d.note && d.note.startsWith('na okraji'));
  if (dents.length) g = Math.min(g, dents.some(d => d.severity > 0.6) ? 5 : 7);
  return g;
}

function surfaceSubgrade(defs) {
  let g = 10;
  const scratches = defs.filter(d => d.type === 'scratch');
  if (scratches.length) {
    const total = scratches.reduce((s, d) => s + d.severity, 0);
    const maxSev = Math.max(...scratches.map(d => d.severity));
    if (maxSev < 0.2 && scratches.length <= 1) g = 9;
    else if (maxSev < 0.3 && total < 0.6) g = 8.5;
    else if (maxSev < 0.45 && total < 1.2) g = 8;
    else if (maxSev < 0.6 && total < 2.5) g = 7;
    else if (total < 4) g = 6;
    else g = 5;
  }
  const dents = defs.filter(d => d.type === 'dent' && !(d.note && d.note.startsWith('na okraji')));
  for (const d of dents) g = Math.min(g, d.severity > 0.7 ? 5 : d.severity > 0.45 ? 6 : 7);
  const bends = defs.filter(d => d.type === 'bend');
  for (const b of bends) g = Math.min(g, b.severity > 0.6 ? 4 : 5.5);
  const creases = defs.filter(d => d.type === 'crease');
  for (const c of creases) g = Math.min(g, c.severity > 0.8 ? 2.5 : c.severity > 0.6 ? 3.5 : 4.5);
  return g;
}

function euFromNumeric(num, defs) {
  // Mapping used by most EU marketplaces (Cardmarket guide): Mint = flawless, NM = pack-fresh with minimal
  // wear, EX = light wear, GD = clearly played, LP = heavy wear, PL = creases/dents, PO = damaged.
  let eu;
  if (num >= 9.5) eu = 'Mint';
  else if (num >= 8) eu = 'Near Mint';
  else if (num >= 6.5) eu = 'Excellent';
  else if (num >= 5) eu = 'Good';
  else if (num >= 3.5) eu = 'Light Played';
  else if (num >= 2) eu = 'Played';
  else eu = 'Poor';
  const idx = EU_SCALE.indexOf(eu);
  let cap = 6;
  if (defs.some(d => d.type === 'crease')) cap = Math.min(cap, 1);               // creases -> at best Played
  if (defs.some(d => d.type === 'bend' && d.severity > 0.6)) cap = Math.min(cap, 2);
  if (defs.some(d => d.type === 'dent' && d.severity > 0.5)) cap = Math.min(cap, 2);
  if (defs.some(d => d.type === 'scratch' && d.severity > 0.5)) cap = Math.min(cap, 3);
  if (defs.some(d => d.type.startsWith('whitening') && d.severity > 0.1)) cap = Math.min(cap, 5); // any visible whitening -> not Mint
  return EU_SCALE[Math.min(idx, cap)];
}

// Which detections are solid enough to move the grade. Dents and bends need raking light to be sure,
// so they count only when the detector is confident; weaker ones are reported as "possible".
export const MIN_CONFIDENCE = { dent: 0.5, bend: 0.5, scratch: 0.4, crease: 0.4, whitening_edge: 0.5, whitening_corner: 0.5, default: 0.3 };
export function usableDefect(d) {
  if (d.type === 'print_line') return false;
  return d.confidence >= (MIN_CONFIDENCE[d.type] ?? MIN_CONFIDENCE.default);
}

/**
 * Compute grades from the merged defect list.
 * @param defects  array of defects from analyzers (both sides)
 * @param centering { front:{lr,tb,confidence}, back?:{lr,tb,confidence} }
 */
export function computeGrades(defects, centering) {
  const usable = defects.filter(usableDefect);
  const cF = centering.front || {};
  const cLR = centeringSubgrade(cF.lr, 'front'), cTB = centeringSubgrade(cF.tb, 'front');
  const known0 = [cLR.grade, cTB.grade].filter(v => v !== null);
  let cent = known0.length ? Math.min(...known0) : null;
  if (centering.back) {
    const bLR = centeringSubgrade(centering.back.lr, 'back'), bTB = centeringSubgrade(centering.back.tb, 'back');
    const kb = [bLR.grade, bTB.grade].filter(v => v !== null);
    if (kb.length) cent = Math.min(cent ?? 10, ...kb);
  }
  const sub = {
    centering: cent,
    corners: cornersSubgrade(usable),
    edges: edgesSubgrade(usable),
    surface: surfaceSubgrade(usable),
  };
  const known = Object.values(sub).filter(v => v !== null);
  const lowest = Math.min(...known);
  const avg = known.reduce((s, v) => s + v, 0) / known.length;

  // PSA: whole numbers, essentially driven by the weakest attribute, with a tiny lift for an otherwise perfect card.
  let psa = Math.floor(lowest);
  if (lowest - psa >= 0.5 && avg - lowest > 1.2) psa += 1;
  psa = clamp(psa, 1, 10);
  if (psa === 10 && usable.length > 0) psa = 9; // PSA 10 tolerates only the slightest print imperfections
  // BGS: final can be at most 0.5 above the lowest subgrade when the rest is clearly stronger; half-point scale.
  let bgs = round05(Math.min(lowest + 0.5, avg));
  if (bgs > lowest + 0.5) bgs = lowest + 0.5;
  bgs = clamp(bgs, 1, 10);
  if (bgs === 10 && known.some(v => v < 10)) bgs = 9.5;
  if (bgs === 9.5 && known.filter(v => v >= 9.5).length < 3) bgs = 9;
  // CGC: 0.5 steps like BGS, 10 Gem Mint and (above it) Pristine 10 when all subgrades are perfect.
  let cgc = clamp(round05(Math.min(lowest + 0.5, avg)), 1, 10);
  if (cgc === 10 && known.some(v => v < 10)) cgc = 9.5;
  const cgcPristine = cgc === 10 && usable.length === 0;
  const eu = euFromNumeric(Math.min(psa, bgs), usable);
  const confidence = clamp(0.9 - usable.filter(d => d.confidence < 0.6).length * 0.07 - (cent === null ? 0.2 : 0), 0.2, 0.95);
  return {
    subgrades: sub,
    centeringLabel: { lr: cLR.label, tb: cTB.label },
    psa: { grade: psa, label: PSA_LABELS[psa] },
    bgs: { grade: bgs, label: BGS_LABELS[bgs] || `${bgs}` },
    cgc: { grade: cgc, label: cgcPristine ? 'Pristine 10' : (CGC_LABELS[cgc] || `${cgc}`) },
    eu: { grade: eu, short: EU_SHORT[eu] },
    confidence,
  };
}

// Group defects so "what if" statements read naturally (one line per group).
export function groupDefects(defects) {
  const groups = new Map();
  for (const d of defects) {
    if (d.type === 'print_line') continue;
    const key = d.type === 'whitening_edge' ? 'whitening_edge' : d.type === 'whitening_corner' ? 'whitening_corner' : d.type === 'scratch' ? 'scratch' : `${d.type}#${defects.indexOf(d)}`;
    if (!groups.has(key)) groups.set(key, { key, type: d.type, defects: [] });
    groups.get(key).defects.push(d);
  }
  return [...groups.values()];
}

/**
 * "What if" analysis: for every defect group, re-grade the card without it.
 * Returns [{ group, without: grades, delta: { psa, bgs, eu } }] sorted by impact.
 */
export function whatIf(defects, centering, base) {
  const groups = groupDefects(defects);
  const out = [];
  for (const g of groups) {
    const rest = defects.filter(d => !g.defects.includes(d));
    const cent = g.type === 'centering' ? { front: { lr: 0.5, tb: 0.5, confidence: 1 }, back: centering.back } : centering;
    const without = computeGrades(rest, cent);
    const dPsa = without.psa.grade - base.psa.grade, dBgs = without.bgs.grade - base.bgs.grade;
    const dEu = EU_SCALE.indexOf(without.eu.grade) - EU_SCALE.indexOf(base.eu.grade);
    if (dPsa > 0 || dBgs > 0 || dEu > 0) out.push({ group: g, without, delta: { psa: dPsa, bgs: dBgs, eu: dEu } });
  }
  out.sort((a, b) => (b.delta.psa + b.delta.bgs + b.delta.eu) - (a.delta.psa + a.delta.bgs + a.delta.eu));
  return out;
}
