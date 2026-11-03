// Test suite: synthetic cards with known defects must be detected and graded sensibly.
import assert from 'node:assert/strict';
import { makeCard, embedInScene, writePNG } from './synth.js';
import { rectifyCard, detectCardQuad, CARD_W, CARD_H } from '../src/cardDetect.js';
import { analyzeSide } from '../src/analyzers.js';
import { computeGrades, whatIf } from '../src/grading.js';
import { recommendGrader } from '../src/recommend.js';
import { buildTextReport } from '../src/report.js';
import { toGray, resizeRGBA } from '../src/imgproc.js';
import { assessQuality } from '../src/quality.js';
import { packResult } from '../src/pack.js';

const results = [];
function test(name, fn) {
  const t0 = Date.now();
  try { fn(); results.push([name, 'OK', Date.now() - t0]); console.log(`✔ ${name} (${Date.now() - t0} ms)`); }
  catch (e) { results.push([name, 'FAIL', Date.now() - t0]); console.log(`✘ ${name}\n   ${e.message}`); process.exitCode = 1; }
}
const types = r => r.defects.map(d => d.type);
const grade = (r, back) => computeGrades(r.defects, { front: { lr: r.frame.lr, tb: r.frame.tb, confidence: r.frame.confidence }, back });

test('clean card: no defects, top grades', () => {
  const r = analyzeSide(makeCard({ seed: 3 }));
  assert.ok(r.frame.valid, 'frame should be measured');
  assert.ok(Math.abs(r.frame.lr - 0.5) < 0.02 && Math.abs(r.frame.tb - 0.5) < 0.02, `centering ${r.frame.lr} ${r.frame.tb}`);
  const strong = r.defects.filter(d => d.confidence >= 0.5 && d.type !== 'print_line');
  assert.deepEqual(strong, [], `unexpected defects: ${JSON.stringify(strong.map(d => [d.type, d.severity.toFixed(2), d.confidence.toFixed(2)]))}`);
  const g = grade(r);
  assert.equal(g.psa.grade, 10); assert.equal(g.eu.grade, 'Mint');
  assert.equal(g.cgc.label, 'Pristine 10');
});

test('off-centre card is measured and penalised', () => {
  const r = analyzeSide(makeCard({ seed: 4, borderL: 44, borderR: 20 }));
  assert.ok(r.frame.valid);
  assert.ok(Math.abs(r.frame.lr - 44 / 64) < 0.03, `lr=${r.frame.lr}`);
  assert.ok(types(r).includes('centering'));
  const g = grade(r);
  assert.equal(g.subgrades.centering, 7, `centering subgrade ${g.subgrades.centering}`); // 69/31 -> 7
  assert.ok(g.psa.grade <= 7);
  const w = whatIf(r.defects, { front: { lr: r.frame.lr, tb: r.frame.tb } }, g);
  assert.ok(w.some(x => x.group.type === 'centering' && x.delta.psa > 0), 'what-if should show centering gain');
});

test('corner whitening is located on the right corner', () => {
  const r = analyzeSide(makeCard({ seed: 5, defects: [{ type: 'corner', corner: 'br', radius: 22 }] }));
  const cs = r.defects.filter(d => d.type === 'whitening_corner');
  assert.equal(cs.length, 1, `corners found: ${cs.map(c => c.corner)}`);
  assert.equal(cs[0].corner, 'br');
  const g = grade(r);
  assert.ok(g.subgrades.corners <= 9 && g.subgrades.corners >= 6, `corners ${g.subgrades.corners}`);
  assert.ok(g.psa.grade < 10 && g.eu.grade !== 'Mint');
});

test('edge whitening is located on the top edge', () => {
  const r = analyzeSide(makeCard({ seed: 6, defects: [{ type: 'edge', edge: 'top', t0: 0.3, t1: 0.55, depth: 5 }] }));
  const es = r.defects.filter(d => d.type === 'whitening_edge');
  assert.ok(es.length >= 1 && es[0].edge === 'top', `edges: ${es.map(e => e.edge)}`);
  assert.ok(!es.some(e => e.edge !== 'top' && e.confidence > 0.6), 'other edges flagged');
  const g = grade(r);
  assert.ok(g.subgrades.edges <= 8.5, `edges ${g.subgrades.edges}`);
  assert.ok(['Near Mint', 'Excellent'].includes(g.eu.grade), g.eu.grade);
});

test('scratch across the holo art is detected', () => {
  const r = analyzeSide(makeCard({ seed: 8, defects: [{ type: 'scratch', x0: 120, y0: 150, x1: 330, y1: 260, width: 2, amount: 0.9 }] }));
  const sc = r.defects.filter(d => d.type === 'scratch');
  assert.ok(sc.length >= 1, 'no scratch found');
  const s = sc[0];
  assert.ok(Math.abs(s.box.x - 120) < 15 && Math.abs(s.box.y - 150) < 15, `scratch at ${JSON.stringify(s.box)}`);
  const g = grade(r);
  assert.ok(g.subgrades.surface <= 9, `surface ${g.subgrades.surface}`);
});

test('crease crossing the border caps the grade (Played at best)', () => {
  const r = analyzeSide(makeCard({ seed: 9, defects: [{ type: 'crease', x0: 0, y0: 703, x1: 500, y1: 560, strength: 40 }] }));
  const cr = r.defects.filter(d => d.type === 'crease');
  assert.ok(cr.length >= 1, `no crease; defects=${types(r)}`);
  assert.ok(cr[0].confidence >= 0.6, `crease confidence ${cr[0].confidence}`);
  const g = grade(r);
  assert.ok(g.psa.grade <= 4, `psa ${g.psa.grade}`);
  assert.ok(['Played', 'Poor'].includes(g.eu.grade), g.eu.grade);
  const w = whatIf(r.defects, { front: { lr: r.frame.lr, tb: r.frame.tb } }, g);
  assert.ok(w.some(x => x.group.type === 'crease' && x.delta.psa >= 3), 'what-if without crease should jump');
});

test('dent on the border is detected', () => {
  const r = analyzeSide(makeCard({ seed: 10, defects: [{ type: 'dent', x: 18, y: 500, radius: 18, strength: 60 }] }));
  const dn = r.defects.filter(d => d.type === 'dent');
  assert.ok(dn.length >= 1, `no dent; defects=${types(r)}`);
  assert.ok(Math.abs(dn[0].box.y + dn[0].box.h / 2 - 500) < 25, `dent y=${dn[0].box.y}`);
  const g = grade(r);
  assert.ok(g.subgrades.edges <= 7 || g.subgrades.surface <= 7);
  const w = whatIf(r.defects, { front: { lr: r.frame.lr, tb: r.frame.tb } }, g);
  assert.ok(w.some(x => x.group.type === 'dent' && (x.delta.psa > 0 || x.delta.eu > 0)), 'what-if without dent');
});

test('bend produces a low-confidence bend warning', () => {
  const r = analyzeSide(makeCard({ seed: 11, defects: [{ type: 'bend', horizontal: false, at: 0.5, sigma: 0.08, strength: 30 }] }));
  assert.ok(types(r).includes('bend'), `defects=${types(r)}`);
});

test('photo of a rotated card on a dark table is found and rectified', () => {
  const card = makeCard({ seed: 12, defects: [{ type: 'corner', corner: 'tl', radius: 24 }] });
  const { scene, corners } = embedInScene(card, { angle: 0.12, persp: 0.00015 });
  const det = detectCardQuad(scene);
  assert.ok(det && det.confidence > 0.5, `detection failed: ${det && JSON.stringify({ c: det.confidence, fill: det.fill, ratio: det.ratio })}`);
  for (let i = 0; i < 4; i++) {
    const d = Math.hypot(det.quad[i].x - corners[i].x, det.quad[i].y - corners[i].y);
    assert.ok(d < 8, `corner ${i} off by ${d.toFixed(1)} px`);
  }
  const { card: rect, detected } = rectifyCard(scene);
  assert.ok(detected);
  assert.equal(rect.w, CARD_W); assert.equal(rect.h, CARD_H);
  const r = analyzeSide(rect);
  assert.ok(r.frame.valid, 'frame after rectification');
  assert.ok(Math.abs(r.frame.lr - 0.5) < 0.04, `lr ${r.frame.lr}`);
  const cs = r.defects.filter(d => d.type === 'whitening_corner');
  assert.ok(cs.some(c => c.corner === 'tl'), `corner after rectification: ${cs.map(c => c.corner)}`);
  writePNG(scene, new URL('./scene.png', import.meta.url).pathname);
});

test('landscape photo is rotated to portrait', () => {
  const card = makeCard({ seed: 13 });
  const { scene } = embedInScene(card, { W: 1600, H: 1200, angle: Math.PI / 2 + 0.05, persp: 0 });
  const { card: rect, detected } = rectifyCard(scene);
  assert.ok(detected);
  const r = analyzeSide(rect);
  assert.ok(r.frame.valid && Math.abs(r.frame.lr - 0.5) < 0.05, `lr ${r.frame.lr}`);
});

test('grader recommendation follows era/rarity rules', () => {
  const g = { psa: { grade: 9 }, subgrades: { centering: 9, corners: 10, edges: 10, surface: 10 } };
  assert.equal(recommendGrader({ era: 'vintage', rarity: 'holo', grades: g }).recommendations[0].grader, 'CGC');
  assert.equal(recommendGrader({ era: 'sv', rarity: 'illustration', grades: g }).recommendations[0].grader, 'Beckett (BGS)');
  assert.equal(recommendGrader({ era: 'xy', rarity: 'holo', grades: g }).recommendations[0].grader, 'PSA');
  assert.ok(recommendGrader({ era: 'xy', rarity: 'holo', grades: g }).notes.some(n => /likvid/i.test(n)));
});

test('text report renders', () => {
  const r = analyzeSide(makeCard({ seed: 14, defects: [{ type: 'corner', corner: 'tr', radius: 20 }, { type: 'dent', x: 400, y: 1030, radius: 16, strength: 60 }] }));
  const g = grade(r);
  const w = whatIf(r.defects, { front: { lr: r.frame.lr, tb: r.frame.tb } }, g);
  const rep = buildTextReport({ meta: { name: 'Charizard' }, grades: g, defects: r.defects, whatIfs: w, recommendation: recommendGrader({ era: 'vintage', rarity: 'holo', grades: g }) });
  assert.ok(rep.includes('Charizard') && rep.includes('DOPORUČENÝ GRADER'));
  console.log('\n' + rep.split('\n').map(l => '    ' + l).join('\n') + '\n');
});

test('quality gate: small or blurry card is refused, good photo passes', () => {
  const card = makeCard({ seed: 31 });
  const good = embedInScene(card, { W: 1500, H: 2000 }).scene;
  const rg = rectifyCard(good); const qg = assessQuality(packResult(rg, analyzeSide(rg.card)), { era: 'ex', sideName: 'front' });
  assert.ok(qg.ok, 'good photo should pass: ' + JSON.stringify(qg.issues));
  const far = embedInScene(card, { W: 1500, H: 2000, scale: 0.75 }).scene;
  const small = resizeRGBA(far, 400, 533); // card ~ 260 px wide in the source
  const rs = rectifyCard(small); const qs = assessQuality(packResult(rs, analyzeSide(rs.card)), { era: 'ex', sideName: 'front' });
  assert.ok(!qs.ok && qs.issues.some(i => i.code === 'too-small'), 'small card should fail: ' + JSON.stringify(qs.issues));
  // Back side of a yellow-border era has no frame and must not be flagged for it.
  const qb = assessQuality(packResult(rg, { ...analyzeSide(rg.card, 'back'), frame: { valid: false } }), { era: 'ex', sideName: 'back' });
  assert.ok(!qb.issues.some(i => i.code === 'no-frame'));
});

console.log(`\n${results.filter(r => r[1] === 'OK').length}/${results.length} tests passed`);
