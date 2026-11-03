// Which grading company fits this card? Rules follow the user's collector heuristics:
//  * Beckett (BGS) for ultra rares: sub-grades + black label are what buyers of top-end moderns pay for.
//  * CGC for vintage (WotC era): PSA is strict on vintage and CGC's standards/pricing suit it.
//  * PSA for modern XY/SM/SwSh/SV holos & regular rares: the most liquid label on the market.
// PSA stays the most liquid option everywhere, which we always point out.

export const ERAS = [
  { id: 'vintage', label: 'Vintage (WotC 1999–2003: Base, Jungle, Fossil, Neo, e-Series, Skyridge…)', vintage: true },
  { id: 'ex', label: 'EX éra (2003–2007: Ruby & Sapphire … Power Keepers)', vintage: false },
  { id: 'dp', label: 'Diamond & Pearl / Platinum / HGSS (2007–2011)', vintage: false },
  { id: 'bw', label: 'Black & White (2011–2013)', vintage: false },
  { id: 'xy', label: 'XY (2014–2016)', vintage: false },
  { id: 'sm', label: 'Sun & Moon (2017–2019)', vintage: false },
  { id: 'swsh', label: 'Sword & Shield (2020–2022)', vintage: false },
  { id: 'sv', label: 'Scarlet & Violet (2023+)', vintage: false },
];

export const RARITIES = [
  { id: 'common', label: 'Common / Uncommon / Rare (bez holo)' },
  { id: 'holo', label: 'Holo Rare / Reverse Holo' },
  { id: 'ultra', label: 'Ultra Rare (EX, GX, V, VMAX, ex, Full Art)' },
  { id: 'secret', label: 'Secret / Hyper / Gold / Rainbow Rare' },
  { id: 'illustration', label: 'Illustration Rare / Special Illustration / Alt Art' },
  { id: 'promo', label: 'Promo / Special' },
];

export function recommendGrader({ era, rarity, grades }) {
  const eraInfo = ERAS.find(e => e.id === era) || ERAS[0];
  const isVintage = eraInfo.vintage;
  const isUltra = ['ultra', 'secret', 'illustration'].includes(rarity);
  const psa = grades ? grades.psa.grade : 10;
  const allPerfect = grades && Object.values(grades.subgrades).every(v => v === 10);
  const list = [];

  if (isUltra) {
    list.push({ grader: 'Beckett (BGS)', primary: true,
      why: 'Ultra rare karta: Beckett uvádí subgrady (centrování, rohy, hrany, povrch) a nabízí Black Label (všechny subgrady 10). Sběratelé top moderních karet to oceňují nejvíc.' });
    list.push({ grader: 'PSA', primary: false, why: 'Nejlikvidnější label – prodá se nejrychleji a kupujících je nejvíc, i když Beckett dává u ultra rare lepší obraz o kvalitě.' });
    list.push({ grader: 'CGC', primary: false, why: 'Levnější alternativa se subgrady; na trhu zatím méně likvidní než PSA.' });
  } else if (isVintage) {
    list.push({ grader: 'CGC', primary: true,
      why: 'Vintage (WotC): PSA je u starých karet výrazně přísnější a často známku sráží. CGC hodnotí vintage konzistentně a nabízí Pristine 10.' });
    list.push({ grader: 'PSA', primary: false, why: 'Nejlikvidnější – u vintage PSA 9/10 dosahuje nejvyšších cen, ale šance na vysokou známku je nižší.' });
    list.push({ grader: 'Beckett (BGS)', primary: false, why: 'Subgrady se hodí, pokud chcete doložit, kde přesně karta ztrácí (např. jen centrování).' });
  } else {
    list.push({ grader: 'PSA', primary: true,
      why: `Moderní karta (${eraInfo.label.split(' (')[0]}): PSA je nejrozšířenější a nejlikvidnější label – nejvíc kupujících a nejrychlejší prodej.` });
    list.push({ grader: 'CGC', primary: false, why: 'Levnější a rychlejší; výsledná cena bývá nižší než u stejné známky PSA.' });
    list.push({ grader: 'Beckett (BGS)', primary: false, why: 'Vhodné jen pokud karta míří na Black Label / 9.5+, jinak se poplatek nevrátí.' });
  }

  const notes = [];
  if (allPerfect) notes.push('Všechny subgrady vycházejí na 10 – kandidát na BGS Black Label / CGC Pristine. Zvažte Beckett i u běžné rarity.');
  if (psa <= 7) notes.push(`Předpokládaná známka PSA ${psa}: u běžných karet se poplatek za grading nemusí vrátit. Gradujte jen vzácné/vintage kusy nebo kvůli ochraně.`);
  if (isUltra && psa >= 9) notes.push('U PSA se může zdát, že dá vyšší známku; výhodou PSA je hlavně likvidita, Beckett ale u ultra rare dokládá kvalitu subgrady.');
  notes.push('Likvidita: PSA > CGC ≈ Beckett. Stejná známka od PSA se obvykle prodá dráž a rychleji.');
  return { era: eraInfo, isVintage, isUltra, recommendations: list, notes };
}
