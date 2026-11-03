// Human readable (Czech) report built from analyzer + grading output.
import { EU_SCALE } from './grading.js';

export const DEFECT_NAMES = {
  centering: 'Špatné centrování', whitening_edge: 'Whitening hrany', whitening_corner: 'Whitening / otřepený roh',
  scratch: 'Škrábanec', print_line: 'Tisková linka', crease: 'Kríz / zlom', dent: 'Dent (promáčknutí)', bend: 'Ohyb karty',
};

export const DEFECT_GROUP_NAMES = {
  centering: 'problém s centrováním', whitening_edge: 'whitening na hranách', whitening_corner: 'otřepené rohy',
  scratch: 'škrábance', crease: 'kríz', dent: 'dent', bend: 'ohyb',
};

export function severityWord(s) {
  if (s < 0.2) return 'nepatrné'; if (s < 0.4) return 'lehké'; if (s < 0.65) return 'střední'; return 'výrazné';
}
export function confidenceWord(c) {
  if (c >= 0.75) return 'vysoká'; if (c >= 0.5) return 'střední'; return 'nízká';
}

export function defectSentence(d) {
  const side = d.side === 'back' ? 'zadní strana' : 'přední strana';
  return `${DEFECT_NAMES[d.type] || d.type} – ${severityWord(d.severity)} (${side}${d.note ? ', ' + d.note : ''}); jistota detekce ${confidenceWord(d.confidence)}`;
}

export function whatIfSentence(item, base) {
  const name = DEFECT_GROUP_NAMES[item.group.type] || item.group.type;
  const parts = [];
  if (item.delta.psa > 0) parts.push(`PSA ${item.without.psa.grade} místo ${base.psa.grade}`);
  if (item.delta.bgs > 0) parts.push(`BGS ${item.without.bgs.grade} místo ${base.bgs.grade}`);
  if (item.delta.eu > 0) parts.push(`${item.without.eu.grade} místo ${base.eu.grade}`);
  const what = item.group.type === 'centering' ? 'Kdyby byla karta dobře vycentrovaná' : `Kdyby tu nebyl${item.group.type === 'scratch' || item.group.type === 'whitening_corner' ? 'y' : item.group.type === 'whitening_edge' ? '' : ''} ${name}`;
  return `${what}, byla by to ${parts.join(', ')}.`;
}

export function summaryLine(grades) {
  const eu = grades.eu.grade;
  const idx = EU_SCALE.indexOf(eu);
  const tone = idx >= 5 ? 'Karta vypadá velmi dobře.' : idx >= 3 ? 'Karta nese stopy používání.' : 'Karta je zřetelně poškozená.';
  return `${tone} Odhadovaný stav: ${eu} (${grades.eu.short}), PSA ~${grades.psa.grade}, BGS ~${grades.bgs.grade}, CGC ~${grades.cgc.grade}.`;
}

export function buildTextReport({ meta, grades, defects, whatIfs, recommendation }) {
  const lines = [];
  lines.push(`POKÉMON TCG – ODHAD STAVU KARTY`);
  if (meta?.name) lines.push(`Karta: ${meta.name}`);
  lines.push(`Éra: ${recommendation.era.label}`);
  lines.push('');
  lines.push(summaryLine(grades));
  lines.push(`Jistota odhadu: ${confidenceWord(grades.confidence)} (${Math.round(grades.confidence * 100)} %)`);
  lines.push('');
  lines.push('SUBGRADY (styl Beckett):');
  const s = grades.subgrades;
  lines.push(`  Centrování: ${s.centering ?? 'n/a'}  (LR ${grades.centeringLabel.lr}, TB ${grades.centeringLabel.tb})`);
  lines.push(`  Rohy: ${s.corners}   Hrany: ${s.edges}   Povrch: ${s.surface}`);
  lines.push('');
  lines.push(`ZNÁMKY: PSA ${grades.psa.label} | BGS ${grades.bgs.label} | CGC ${grades.cgc.label} | EU: ${grades.eu.grade}`);
  lines.push('');
  lines.push(defects.length ? 'NALEZENÉ VADY:' : 'NALEZENÉ VADY: žádné zřetelné vady.');
  for (const d of defects) lines.push(`  • ${defectSentence(d)}`);
  if (whatIfs.length) { lines.push(''); lines.push('CO KDYBY:'); for (const w of whatIfs) lines.push(`  • ${whatIfSentence(w, grades)}`); }
  lines.push('');
  lines.push('DOPORUČENÝ GRADER:');
  for (const r of recommendation.recommendations) lines.push(`  ${r.primary ? '★' : '•'} ${r.grader}: ${r.why}`);
  for (const n of recommendation.notes) lines.push(`  ! ${n}`);
  lines.push('');
  lines.push('Pozn.: Odhad z fotografie. Denty a ohyby ověřte v bočním světle; finální známku určuje grader.');
  return lines.join('\n');
}
