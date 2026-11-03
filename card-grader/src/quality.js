// Photo quality assessment. A grade estimated from a poor photo is worse than no grade at all,
// so every result carries a quality verdict and the UI refuses to grade when it fails.
import { CARD_W } from './cardDetect.js';

export const YELLOW_BORDER_ERAS = new Set(['vintage', 'ex', 'dp', 'bw']); // eras where a printed frame is expected on the front

/**
 * @param side   packed analysis result for one side (needs quad, detected, stats, frame, glareFrac)
 * @param opts   { era, side: 'front'|'back' }
 * @returns { ok, score(0..1), issues:[{ code, level:'fail'|'warn', text }] }
 */
export function assessQuality(side, { era = 'sv', sideName = 'front' } = {}) {
  const issues = [];
  const add = (code, level, text) => issues.push({ code, level, text });
  // 1. Card size in the source photo: the analysis works on 750 px width, upscaling invents nothing.
  const q = side.quad;
  const srcW = q ? (Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) + Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y)) / 2 : CARD_W;
  const upscale = CARD_W / Math.max(1, srcW);
  if (!side.detected) add('no-card', 'warn', 'Kartu se nepodařilo odlišit od pozadí – použit celý snímek. Použij jednobarevný kontrastní podklad.');
  if (upscale > 2.4) add('too-small', 'fail', `Karta je v záběru příliš malá (${Math.round(srcW)} px na šířku). Přibliž se tak, aby karta vyplnila většinu obrazovky.`);
  else if (upscale > 1.5) add('small', 'warn', `Karta je v záběru malá (${Math.round(srcW)} px na šířku) – jemné vady nejsou vidět. Přibliž se.`);
  // 2. Sharpness and light.
  const st = side.stats || {};
  if (st.sharpness !== undefined) {
    if (st.sharpness < 0.04) add('blurry', 'fail', 'Snímek je rozmazaný. Zaostři na kartu, drž telefon pevně a nepoužívej digitální zoom.');
    else if (st.sharpness < 0.07) add('soft', 'warn', 'Snímek je měkký (lehce neostrý) – jemné škrábance mohou uniknout.');
  }
  if (st.meanLum !== undefined && st.meanLum < 70) add('dark', 'warn', 'Snímek je tmavý. Přidej světlo (denní světlo u okna nebo lampa ze strany), neblýskej.');
  if (side.glareFrac > 0.03) add('glare', 'warn', 'Na kartě je odlesk (přepálená místa). Nakloň kartu nebo změň polohu světla.');
  // 3. Printed frame on the front of yellow-border eras.
  if (sideName === 'front' && YELLOW_BORDER_ERAS.has(era) && !side.frame.valid) {
    add('no-frame', 'fail', 'Nenašel jsem vnitřní rámeček karty, takže nejde změřit centrování ani spolehlivě okraje. Obvykle: karta je malá, v obalu, nebo rozmazaná. Vyndej ji z obalu a vyfoť znovu zblízka.');
  }
  const fails = issues.filter(i => i.level === 'fail').length, warns = issues.filter(i => i.level === 'warn').length;
  const score = Math.max(0, 1 - fails * 0.5 - warns * 0.15);
  return { ok: fails === 0, score, issues, upscale, srcW };
}
