# Card Grader – hodnocení stavu Pokémon TCG karet z fotky

Progresivní webová aplikace (PWA) pro telefon. Vyfotíš kartu na rovném povrchu, aplikace ji
najde, narovná a v plném rozlišení projde několika filtry, které hledají:

| Vada | Jak se hledá |
|---|---|
| **Centrování** | změří šířky okrajů (L/R/T/B) podle vnitřního rámečku, poměr se porovná s tabulkami PSA |
| **Whitening hran** | pixely v pásu u hrany, které jsou světlejší a méně syté než zbytek okraje; měří se pokrytí délky hrany |
| **Otřepené rohy** | totéž ve čtvrtkruhu u každého rohu, přepočteno na mm |
| **Škrábance** | horní propust + orientovaný liniový filtr + Houghovo hlasování; tiskové hrany odfiltruje test dvoupolarity, tiskové linky (factory) se hlásí zvlášť |
| **Krízy** | pásmová propust v poloviční velikosti, dlouhé rovné hřebeny; linie přecházející do okraje karty = kríz |
| **Denty** | nízkofrekvenční reliéf v místech bez tiskové textury (okraj, plné plochy); na okraji 1-D reliéf podél hrany |
| **Ohyb** | hladký pás změny jasu v okrajovém pásu (nutné rovnoměrné světlo) |

Z vad vznikne odhad:

* **PSA 1–10**, **Beckett/BGS** (se subgrady centrování · rohy · hrany · povrch, krok 0,5) a **CGC** (vč. Pristine 10),
* **evropská škála** (Cardmarket): Poor, Played, Light Played, Good, Excellent, Near Mint, Mint,
* **„Co kdyby“** – pro každou vadu přepočet známky bez ní („Kdyby tu nebyl dent, byla by to PSA 9 místo 7“),
* **doporučení gradera**: ultra rare → Beckett (subgrady, Black Label); vintage WotC → CGC (PSA u vintage sráží);
  moderní XY/SM/SwSh/SV holo → PSA; vždy s poznámkou, že PSA je nejlikvidnější label.

Vše běží v prohlížeči (Web Worker, žádné knihovny, žádný server, fotky nikam neodcházejí).

## Spuštění

```bash
cd card-grader
npm test            # syntetické testy detekce + gradování
npm run serve       # http://localhost:8080 – v telefonu otevři IP počítače
```

PWA vyžaduje HTTPS (nebo localhost) kvůli kameře a service workeru – pro nasazení stačí
nahrát adresář na libovolný statický hosting (GitHub Pages, Netlify…) a na telefonu zvolit
„Přidat na plochu“.

## Jak fotit

1. Rovný, matný, jednobarevný podklad s kontrastem vůči okraji karty.
2. Měkké rovnoměrné světlo, bez odlesků na holo. Pro denty/ohyby druhý snímek v bočním světle.
3. Telefon rovnoběžně s kartou, karta vyplní většinu záběru, všechny čtyři rohy v záběru.
4. Nejvyšší rozlišení, bez digitálního zoomu, karta mimo obal.

## Struktura

```
src/imgproc.js     – zpracování obrazu (blur, Sobel, komponenty, homografie, orientovaný filtr, Hough)
src/cardDetect.js  – nalezení karty na pozadí, fit hran, perspektivní narovnání na 750×1050 px
src/analyzers.js   – měření rámečku, whitening, škrábance, krízy, denty, ohyb
src/grading.js     – PSA/BGS/CGC/EU známky, subgrady, „co kdyby“
src/recommend.js   – doporučení gradera podle éry a rarity
src/report.js      – český textový report
src/worker.js      – analýza ve Web Workeru;  src/pack.js – zmenšení výsledku pro UI
src/app.js         – UI: kamera, filtry, seznam vad, export
test/synth.js      – generátor syntetických karet s vadami;  test/run.js – testy
```

## Omezení (upřímně)

* Odhad z jedné fotky nikdy nenahradí gradera – denty a ohyby jsou vidět hlavně v bočním světle,
  jemné škrábance na holo při změně úhlu. Aplikace proto u těchto vad uvádí nižší jistotu.
* Prahy jsou kalibrovány na syntetických kartách a běžných žlutých/stříbrných okrajích; full-art
  karty bez rámečku mají centrování „n/a“ a whitening s nižší jistotou.
* Analýza jedné strany trvá na telefonu zhruba 5–20 s podle výkonu.
