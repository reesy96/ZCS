# LaTeX převodník článků mezi šablonami časopisů

Lokální aplikace, která vezme **hotový článek** v jedné LaTeX šabloně (např. Elsevier)
a **šablonu jiného časopisu** (např. IEEE, MDPI, Springer) a vytvoří z nich článek
v nové šabloně: titulní údaje, text, obrázky, tabulky, rovnice, makra i literaturu.
Všechno běží jen na tvém počítači, nic se nikam neposílá.

## Spuštění

Potřebuješ jen **Python 3.9+** (žádné další balíčky). Pro automatický zkušební překlad do PDF
ještě nainstalovaný LaTeX (TeX Live / MiKTeX s `latexmk` nebo `pdflatex`). Bez něj převod
funguje taky, jen si PDF přeložíš sám.

```bash
cd latex-prevodnik
python spustit.py
```

Ve Windows stačí dvojklik na **`spustit.bat`**. Otevře se prohlížeč s adresou `http://127.0.0.1:8765/`. Potom:

1. **Nahraj hotový článek.** Celý projekt jako ZIP nebo složku, tedy `.tex`, obrázky a `.bib`.
2. **Nahraj šablonu časopisu.** ZIP nebo složka, jak ji časopis poskytuje (`.tex`, `.cls`, `.bst`, …).
3. **Zkontroluj rozpoznané údaje** (název, autoři, afiliace, e-maily, abstrakt, klíčová slova,
   poděkování) a případně je oprav přímo ve formuláři.
4. **Převeď.** Dostaneš ZIP s hotovým projektem, náhled PDF a zprávu o tom, co se změnilo
   a co je potřeba zkontrolovat ručně.

Převod z příkazové řádky (bez prohlížeče):

```bash
python spustit.py --clanek muj_clanek.zip --sablona sablona_casopisu.zip --vystup vysledek.zip
```

Vyzkoušet to můžeš na přiloženém příkladu:

```bash
python spustit.py --clanek priklad/clanek-elsevier --sablona priklad/sablona-obecna --vystup vysledek.zip
```

## Co program dělá

| Část článku | Jak se přenese |
|---|---|
| Název, autoři, afiliace, e-maily, ORCID, korespondující autor | Rozpozná se z mnoha zápisů (`\author`+`\affil`, `\IEEEauthorblockN`, `\inst`/`\institute`, MDPI `\Author`/`\address`, `\fnm`/`\sur` …) a vygeneruje se znovu v zápisu cílové třídy. |
| Abstrakt, klíčová slova, highlights | Do správného místa a formy (`abstract`, `\abstract{}`, `keyword` + `\sep`, `IEEEkeywords`, `\keywords{… \and …}`). |
| Text, kapitoly, rovnice, tabulky, obrázky, přílohy | Přenesou se beze změny obsahu. Komentáře v textu zůstanou. |
| Specifika tříd | `\IEEEPARstart`, `teaserfigure`, `widetext`, `ruledtabular`, MDPI `adjustwidth`, `\bmhead`, `appendices` … se převedou na obecné ekvivalenty. |
| Dvousloupcová cílová šablona | V obyčejných obrázcích a tabulkách se `\textwidth` změní na `\columnwidth`. Na široké tabulky a rovnice upozorní. |
| Poděkování, Funding, Conflicts of interest … | Do formy cílové třídy (`acks`, `acknowledgments`, `\bmhead`, MDPI `\funding{}` …). |
| Literatura | `.bib` se zkopíruje a použije se bibliografický styl cílového časopisu. Citace (`\citep`, `\citet`, `\parencite` …) se přizpůsobí natbibu, biblatexu nebo obyčejnému `\cite`. |
| Balíčky a makra | Převezmou se balíčky, které článek potřebuje (kromě těch, které určují vzhled: geometry, fonty, fancyhdr …). Vlastní makra se vloží tak, aby nekolidovala se šablonou. |
| Soubory | Zkopírují se podpůrné soubory šablony (`.cls`, `.bst`, loga) a soubory článku (obrázky, `.bib`, vložené `.tex`). |

Třídy podporované nativně: **Elsevier** (elsarticle, CAS cas-sc/cas-dc), **IEEE** (IEEEtran
konference i časopis), **Springer Nature** (sn-jnl), **Springer LNCS** (llncs),
**Springer svjour3**, **MDPI**, **ACM** (acmart), **APS/AIP** (REVTeX), **AMS** (amsart).
Ostatní třídy (article, Wiley, Taylor & Francis, IOP, …) převede obecným způsobem podle toho,
jaké příkazy šablona používá.

## Je to vůbec reálné?

**Ano, ve většině případů to funguje dobře, ale vždy je potřeba výsledek zkontrolovat.**

Převod je realistický, protože LaTeX je strukturovaný. Tělo článku (kapitoly, rovnice,
obrázky, tabulky, citace) je napříč šablonami skoro stejné a přenáší se spolehlivě. Rozdíly
mezi časopisy jsou hlavně v **titulní části** (každá třída zapisuje autory a afiliace jinak),
v **bibliografickém stylu** a v **rozměrech sazby**. Na to má program pravidla pro jednotlivé třídy.

Co se nedá plně automatizovat:

- **Vizuální přizpůsobení.** Když jde článek z jednosloupcové do dvousloupcové sazby, dlouhé
  rovnice a široké tabulky se nemusí vejít. Program je upraví, kde to jde (`\columnwidth`),
  a na zbytek upozorní. Jestli dát tabulku přes oba sloupce, je redakční rozhodnutí.
- **Požadavky časopisu na obsah.** MDPI chce sekce Author Contributions / Funding, ACM chce
  CCS concepts, Elsevier highlights. Program připraví místa, ale obsah musíš doplnit ty.
- **Neobvyklé zápisy autorů.** Rozpoznávání pokrývá běžné styly. U exotického zápisu zkontroluj
  formulář, kde jde všechno opravit, než převod spustíš.
- **Ručně psaná bibliografie** (`thebibliography`) zůstane ve svém formátu. Styl časopisu se
  automaticky uplatní jen na `.bib` soubory.
- **Hluboké zásahy do třídy** (`\makeatletter` bloky, předefinování interních maker)
  se přenesou, ale mohou s novou třídou kolidovat.

Proto program na konci článek **zkusí přeložit** a ukáže chyby LaTeXu s čísly řádků
a nedefinované odkazy. Všechna upozornění najdeš ve stránce s výsledkem i v souboru
`ZPRAVA_O_PREVODU.md` uvnitř ZIPu.

Při testech se převody mezi elsarticle, CAS, IEEE, ACM, REVTeX, LNCS, Springer Nature,
MDPI a obecnou třídou `article` přeložily bez chyb. Třídy MDPI a sn-jnl nejsou v TeX Live,
takže výstup do nich byl ověřen jen kontrolou vygenerovaného kódu, ne překladem.

## Struktura

```
spustit.py              spouštěč (web / příkazová řádka)
prevodnik/
  texparse.py           parser LaTeXu (komentáře, závorky, příkazy, prostředí)
  project.py            rozbalení nahraných souborů, nalezení hlavního .tex, \input
  authors.py            rozpoznání autorů a afiliací z různých stylů
  extract.py            vytěžení článku do šablonově nezávislého modelu
  template.py           analýza cílové šablony + generátory titulní části pro třídy
  convert.py            sestavení výsledku (tělo, balíčky, makra, literatura, soubory)
  compile.py            zkušební překlad (latexmk / pdflatex + bibtex)
  server.py             lokální webové rozhraní
priklad/                ukázkový článek a šablona
testy/                  python -m unittest discover testy
```

Pracovní soubory webového rozhraní se ukládají do `~/.latex-prevodnik/ulohy/`. Klidně je smaž.
