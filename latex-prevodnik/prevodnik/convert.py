"""Sestavení článku do cílové šablony."""

from __future__ import annotations

import re
import shutil
from pathlib import Path

from .model import BACK_MARK, BIB_MARK, Article
from .project import is_aux, list_files
from .template import (GENERATORS, THEOREM_PREDEFINED, PREAMBLE_FRONT, Template, back_matter, bib_block)
from .texparse import Doc, apply_edits, squash

SKIP_PACKAGES = {
    "geometry", "fullpage", "a4wide", "a4", "vmargin", "savetrees", "fancyhdr", "titlesec", "titling", "authblk",
    "lineno", "setspace", "natbib", "cite", "biblatex", "inputenc", "fontenc", "lmodern", "times", "mathptmx",
    "newtxtext", "newtxmath", "newtx", "txfonts", "pxfonts", "helvet", "courier", "palatino", "mathpazo",
    "libertine", "libertinus", "fontspec", "unicode-math", "polyglossia", "showframe", "layout", "parskip",
    "sectsty", "caption", "abstract", "endfloat", "hyperref", "tocloft", "fancyheadings", "anysize",
    "typearea", "scrlayer-scrpage", "titletoc", "nameref", "bookmark", "hypcap", "orcidlink-off", "mathptm",
    "charter", "fourier", "kpfonts", "stix", "stix2", "sourcesanspro", "sourceserifpro", "tgtermes",
    "tgheros", "newpxtext", "newpxmath", "baskervald", "ebgaramond", "crimson", "cmbright", "eulervm",
    "multibib", "chapterbib", "bibentry", "url",
}
SKIP_PER_FAMILY = {
    "acmart": {"amssymb", "amsfonts", "amsthm", "xcolor", "graphicx", "booktabs"},
    "llncs": {"amsthm"},
    "svjour": {"amsthm"},
    "ieee": {"subcaption"},
    "revtex": {"float"},
    "mdpi": {"changepage", "float", "tabularx", "booktabs", "multirow", "xcolor", "graphicx", "amsmath", "amssymb"},
}
# jména maker, která nesmíme přepsat (patří titulní části / třídě)
PROTECTED = {"keywords", "keyword", "email", "address", "affil", "affiliation", "institute", "abstract", "title",
             "author", "and", "thanks", "orcid", "corres", "sep", "ead", "inst", "maketitle", "date", "Title",
             "Author", "shortauthors", "shorttitle", "authorrunning", "titlerunning", "IEEEauthorblockN",
             "IEEEauthorblockA", "orcidID", "fnm", "sur", "affiliations", "address", "corref", "cortext",
             "section", "subsection", "subsubsection", "paragraph", "caption", "cite", "ref", "label",
             "appendix", "footnote", "today", "abstractname", "refname", "bibname", "WriteBookmarks"}
THEOREM_NAMES = ["theorem", "lemma", "corollary", "proposition", "definition", "remark", "example",
                 "conjecture", "claim", "assumption", "hypothesis", "problem", "exercise", "notation",
                 "observation", "fact", "property", "question", "solution", "note", "axiom", "condition"]
NATBIB_CITES = ["citep", "citet", "citealp", "citealt", "citeauthor", "citeyear", "citeyearpar", "Citep", "Citet",
                "Citeauthor", "citetext", "citenum"]
BIBLATEX_CITES = ["parencite", "Parencite", "textcite", "Textcite", "autocite", "Autocite", "footcite",
                  "smartcite", "supercite", "fullcite"]


USAGE_PKGS = [
    (r"\\includegraphics", "graphicx"),
    (r"\\begin\s*\{(figure|table)\*?\}\s*\[[^\]]*H", "float"),
    (r"\\begin\s*\{tabularx\}", "tabularx"),
    (r"\\(toprule|midrule|bottomrule|cmidrule)(?![a-zA-Z])", "booktabs"),
    (r"\\multirow(?![a-zA-Z])", "multirow"),
    (r"\\(SI|si|num|qty|unit|ang|SIrange)\s*(\[[^\]]*\])?\s*\{", "siunitx"),
    (r"\\(textcolor|color|colorbox|rowcolor|cellcolor)(?![a-zA-Z])", "xcolor"),
    (r"\\begin\s*\{(align|gather|multline|split|cases|pmatrix|bmatrix)\*?\}|\\(eqref|text|dfrac|tfrac|boldsymbol)(?![a-zA-Z])", "amsmath"),
    (r"\\(mathbb|mathfrak|checkmark|varepsilon)(?![a-zA-Z])", "amssymb"),
    (r"\\begin\s*\{subfigure\}", "subcaption"),
    (r"\\begin\s*\{longtable\}", "longtable"),
    (r"\\begin\s*\{adjustwidth\}", "changepage"),
    (r"\\newcolumntype|\\arraybackslash", "array"),
    (r"\\(cref|Cref)(?![a-zA-Z])", "cleveref"),
    (r"\\orcidlink(?![a-zA-Z])", "orcidlink"),
    (r"\\ce\s*\{", "mhchem"),
    (r"\\begin\s*\{(algorithm)\}", "algorithm"),
    (r"\\begin\s*\{(algorithmic)\}", "algorithmic"),
    (r"\\begin\s*\{(tikzpicture)\}", "tikz"),
    (r"\\begin\s*\{(axis)\}", "pgfplots"),
    (r"\\lipsum(?![a-zA-Z])", "lipsum"),
    (r"\\(makecell)(?![a-zA-Z])", "makecell"),
    (r"\\begin\s*\{threeparttable\}", "threeparttable"),
    (r"\\begin\s*\{(wrapfigure|wraptable)\}", "wrapfig"),
    (r"\\(bm)\s*\{", "bm"),
]


class Report:
    def __init__(self):
        self.info = []
        self.warnings = []
        self.done = []

    def to_dict(self):
        return {"info": self.info, "warnings": self.warnings, "done": self.done}


# ---------------------------------------------------------------------------
# úpravy těla


def _unwrap_env(text: str, name: str, spec: str = "", keep: str | None = None, cond=None):
    d = Doc(text)
    edits = []
    for en in d.envs(name, spec):
        head = text[en.start : en.inner_start]
        if cond and not cond(head):
            continue
        inner = en.inner(text)
        if keep is not None:
            edits.append((en.start, en.end, keep.replace("@@", inner)))
        else:
            edits.append((en.start, en.end, inner))
    return apply_edits(text, edits), len(edits)


def transform_body(art: Article, T: Template, R: Report, extra_pkgs: list) -> str:
    body = art.body
    fam = T.family
    src = art.source_class

    def note(msg, n=1):
        if n:
            R.done.append(msg + (f" ({n}×)" if n > 1 else ""))

    # \IEEEPARstart{T}{his} → This
    if fam != "ieee":
        d = Doc(body)
        ed = [(c.start, c.end, c.args[0] + c.args[1]) for c in d.cmds("IEEEPARstart", "mm")]
        body = apply_edits(body, ed)
        note("\\IEEEPARstart převeden na běžný text", len(ed))
    # acmart
    if fam != "acmart":
        body, n = _unwrap_env(body, "teaserfigure", keep="\\begin{figure*}[t]@@\\end{figure*}")
        note("teaserfigure → figure*", n)
        d = Doc(body)
        ed = [(c.start, c.end, "") for c in d.cmds("Description", "om")]
        body = apply_edits(body, ed)
        note("odstraněny ACM popisky \\Description", len(ed))
    # REVTeX
    if fam != "revtex":
        body, n = _unwrap_env(body, "widetext")
        note("prostředí widetext rozbaleno", n)
        body, n = _unwrap_env(body, "ruledtabular")
        note("prostředí ruledtabular rozbaleno", n)
    # MDPI
    if fam != "mdpi":
        body, n = _unwrap_env(body, "adjustwidth", "mm", cond=lambda h: "extralength" in h)
        note("MDPI adjustwidth{-\\extralength} rozbaleno", n)
        d = Doc(body)
        ed = [(c.start, c.end, "") for nm, sp in (("appendixtitles", "m"), ("appendixstart", ""),
                                                  ("isPreprints", "m"), ("firstpage", "m"))
              for c in d.cmds(nm, sp)]
        body = apply_edits(body, ed)
        # MDPI: \section[\appendix]{A} → \section{A}
        body = re.sub(r"\\section\[\\appendix\]", r"\\section", body)
    # Springer Nature
    if fam != "snjnl":
        d = Doc(body)
        ed = [(c.start, c.end, "\\subsection*{" + c.args[0] + "}") for c in d.cmds("bmhead", "m")]
        ed += [(c.start, c.end, "") for c in d.cmds("backmatter", "")]
        body = apply_edits(body, ed)
        note("\\bmhead → \\subsection*", len([e for e in ed if e[2]]))
    if not T.feats.get("appendices_env") and not any(p == "appendix" for _, p in art.preamble_packages):
        body, n = _unwrap_env(body, "appendices", keep="\\appendix\n@@")
        note("prostředí appendices → \\appendix", n)
    # dvousloupcová sazba: \textwidth v obyčejných plovoucích objektech → \columnwidth
    if T.twocolumn:
        d = Doc(body)
        ed = []
        for env in ("figure", "table"):
            for en in d.envs(env):
                inner = body[en.inner_start : en.inner_end]
                new = re.sub(r"\\textwidth(?![a-zA-Z])", r"\\columnwidth", inner)
                new = re.sub(r"\\linewidth(?![a-zA-Z])", r"\\linewidth", new)
                if new != inner:
                    ed.append((en.inner_start, en.inner_end, new))
        body = apply_edits(body, ed)
        note("v jednosloupcových obrázcích/tabulkách \\textwidth → \\columnwidth (cíl je dvousloupcový)", len(ed))
        # široké tabulky — varování
        d = Doc(body)
        wide = 0
        for en in d.envs("table"):
            for m in re.finditer(r"\\begin\s*\{(tabular\*?|tabularx|longtable)\}\s*(\{[^}]*\})?\s*\{([^}]*)\}", body[en.inner_start:en.inner_end]):
                cols = len(re.findall(r"[lcrXpmb](?![a-z])", m.group(3)))
                if cols >= 6:
                    wide += 1
        if wide:
            R.warnings.append(f"{wide} tabulek má 6 a více sloupců a v dvousloupcové sazbě se nemusí vejít — zvaž změnu na table*.")
        R.warnings.append("Cílová šablona je dvousloupcová: zkontroluj dlouhé rovnice a široké obrázky (případně použij figure*/table*).")
    elif not T.twocolumn and art.source_class_options and "twocolumn" in art.source_class_options:
        pass

    # REVTeX nesnese balíček float → umístění [H] nahradíme [!htbp]
    if fam == "revtex":
        body, n = re.subn(r"(\\begin\s*\{(?:figure|table)\*?\}\s*)\[\s*H\s*\]", r"\1[!htbp]", body)
        note("umístění plovoucích objektů [H] → [!htbp] (REVTeX nepodporuje balíček float)", n)

    # citace
    body = convert_cites(body, art, T, R)

    # biografie, \linenumbers, prázdné \maketitle
    d = Doc(body)
    ed = [(c.start, c.end, "") for c in d.cmds("linenumbers", "")]
    body = apply_edits(body, ed)

    # teorémová prostředí, která cílová třída nezná
    defined = {name for kind, name, _ in art.preamble_defs if kind == "newtheorem"}
    pre = THEOREM_PREDEFINED.get(fam, set()) | T.feats.get("theorems", set())
    used = set(re.findall(r"\\begin\s*\{([a-zA-Z]+)\}", Doc(body).m))
    for name in THEOREM_NAMES:
        if name in used and name not in defined and name not in pre:
            extra_pkgs.append("\\ifcsname %s\\endcsname\\else\\newtheorem{%s}{%s}\\fi" % (name, name, name.capitalize()))
    if "proof" in used and "proof" not in pre and fam not in ("llncs", "svjour") and not any(p == "amsthm" for _, p in art.preamble_packages):
        extra_pkgs.insert(0, "\\ifcsname proof\\endcsname\\else\\usepackage{amsthm}\\fi")
    return body


def convert_cites(body: str, art: Article, T: Template, R: Report) -> str:
    d = Doc(body)
    target_biblatex = T.bib_system == "biblatex"
    natbib = T.feats.get("natbib")
    textual = 0
    dropped_pre = 0
    ed = []
    pat = re.compile(r"\\(" + "|".join(NATBIB_CITES + BIBLATEX_CITES) + r")(?![a-zA-Z@])(\*?)")
    for m in pat.finditer(d.m):
        name, star = m.group(1), m.group(2)
        new = None
        if target_biblatex:
            mp = {"citep": "parencite", "Citep": "Parencite", "citet": "textcite", "Citet": "Textcite",
                  "citealp": "cite", "citealt": "cite", "citeyearpar": "parencite*", "citenum": "cite"}
            new = mp.get(name)
        elif natbib:
            mp = {"parencite": "citep", "Parencite": "Citep", "textcite": "citet", "Textcite": "Citet",
                  "autocite": "citep", "Autocite": "Citep", "footcite": "citep", "smartcite": "citep",
                  "supercite": "cite", "fullcite": "cite"}
            new = mp.get(name)
        else:
            if name in ("citet", "Citet", "textcite", "Textcite", "citeauthor", "Citeauthor"):
                textual += 1
            if name in ("citeyear", "citetext"):
                continue
            new = "cite"
            # dvojitý volitelný argument [viz][s. 5] → ponecháme jen druhý
            rest = d.m[m.end() : m.end() + 400]
            dm = re.match(r"\s*\[([^\]]*)\]\s*\[([^\]]*)\]", rest)
            if dm:
                dropped_pre += 1
                ed.append((m.start(), m.end() + dm.end(), "\\cite" + "[" + body[m.end() + dm.start(2) : m.end() + dm.end(2)] + "]"))
                continue
        if new and new != name:
            ed.append((m.start(), m.end(), "\\" + new + ("" if new.endswith("*") else star)))
    body = apply_edits(body, ed)
    if ed:
        R.done.append(f"Citační příkazy upraveny pro cílovou šablonu ({len(ed)}×)")
    if textual:
        R.warnings.append(f"Cílová šablona nepoužívá natbib: {textual}× \\citet/\\textcite převedeno na \\cite — zkontroluj, že věty dávají smysl (např. „Novák et al. [3]“ → „[3]“).")
    if dropped_pre:
        R.warnings.append(f"{dropped_pre}× citace s dvěma volitelnými argumenty ([viz][s. 5]) — první argument byl vynechán.")
    return body


# ---------------------------------------------------------------------------
# preambule


def build_preamble_additions(art: Article, T: Template, R: Report, body: str, extra: list):
    fam = T.family
    pass_opts = []
    lines = []
    skip = SKIP_PACKAGES | SKIP_PER_FAMILY.get(fam, set())
    have = set(T.packages)
    added = []
    skipped = []
    src_pkgs = []
    seen = set()
    for opts, p in art.preamble_packages:
        if p in seen:
            continue
        seen.add(p)
        src_pkgs.append((opts, p))
    for opts, p in src_pkgs:
        if p in skip:
            if fam == "ieee" and p == "subcaption":
                continue
            if p not in ("natbib", "cite", "biblatex", "hyperref", "inputenc", "fontenc", "url"):
                skipped.append(p)
            continue
        if p in have:
            continue
        if p in ("cleveref",):
            continue  # až za hyperref
        if opts:
            pass_opts.append("\\PassOptionsToPackage{" + opts + "}{" + p + "}")
        lines.append("\\usepackage{" + p + "}")
        added.append(p)
    src_names = {p for _, p in src_pkgs}
    # balíčky, které zdrojová třída načítala sama (MDPI, Springer…), ale tělo je potřebuje
    bm = Doc(body).m
    for rx, pkg in USAGE_PKGS:
        if pkg in have or pkg in src_names or pkg in skip or pkg in added:
            continue
        if re.search(rx, bm):
            lines.append("\\usepackage{" + pkg + "}% použito v textu")
            added.append(pkg)
    # IEEE + subcaption
    if fam == "ieee" and "subcaption" in src_names and "subcaption" not in have:
        lines.append("\\usepackage[caption=false]{caption}% IEEE: kompatibilita se subcaption")
        lines.append("\\usepackage{subcaption}")
        added.append("subcaption")
    # hyperref / url
    needs_links = re.search(r"\\(href|url|hyperref|autoref|nolinkurl|doi)(?![a-zA-Z])", Doc(body).m)
    if needs_links and not ({"hyperref", "url"} & have) and fam not in ("mdpi", "acmart", "snjnl", "revtex"):
        if "hyperref" in src_names or re.search(r"\\(href|hyperref|autoref)(?![a-zA-Z])", body):
            lines.append("\\usepackage{hyperref}")
            added.append("hyperref")
        else:
            lines.append("\\usepackage{url}")
            added.append("url")
    for opts, p in src_pkgs:
        if p == "cleveref" and p not in have:
            if opts:
                pass_opts.append("\\PassOptionsToPackage{" + opts + "}{cleveref}")
            lines.append("\\usepackage{cleveref}")
            added.append("cleveref")
    if added:
        R.done.append("Přidané balíčky: " + ", ".join(added))
    if skipped:
        R.info.append("Vynechané balíčky (vzhled určuje šablona, nebo se s ní tlučou): " + ", ".join(sorted(set(skipped))))
    if fam in ("acmart",) and {"amssymb", "amsfonts"} & src_names:
        R.info.append("amssymb/amsfonts vynechány: acmart načítá vlastní matematické fonty (jinak chyba \\Bbbk already defined).")

    # definice maker
    defs = []
    risky = []
    if any(k == "theoremstyle" for k, _, _ in art.preamble_defs):
        defs.append("\\providecommand{\\theoremstyle}[1]{}")
    for kind, name, txt in art.preamble_defs:
        base = name.split("}")[0]
        if kind == "theoremstyle":
            txt = re.sub(r"thmstyleone", "plain", txt)
            txt = re.sub(r"thmstyletwo", "remark", txt)
            txt = re.sub(r"thmstylethree", "definition", txt)
        if base in PROTECTED or base.startswith("orcidauthor"):
            R.info.append(f"Makro \\{base} ze zdroje nebylo převzato (koliduje s titulní částí/třídou).")
            continue
        if kind in ("newcommand", "renewcommand", "providecommand", "DeclareRobustCommand", "DeclareMathOperator"):
            if kind == "renewcommand":
                txt = "\\providecommand{\\%s}{}" % base + "\n" + txt
            elif kind in ("newcommand", "DeclareMathOperator"):
                txt = "\\let\\%s\\relax\n" % base + txt
            defs.append(txt)
        elif kind in ("newenvironment", "renewenvironment"):
            if kind == "newenvironment":
                txt = "\\expandafter\\let\\csname %s\\endcsname\\relax\\expandafter\\let\\csname end%s\\endcsname\\relax\n" % (base, base) + txt
            else:
                txt = "\\ifcsname %s\\endcsname\\else\\newenvironment{%s}{}{}\\fi\n" % (base, base) + txt
            defs.append(txt)
        elif kind == "newtheorem":
            if base in T.feats.get("theorems", set()) or base in THEOREM_PREDEFINED.get(fam, set()):
                continue  # šablona už prostředí definuje
            defs.append("\\ifcsname %s\\endcsname\\else%s\\fi" % (base, txt.replace("\n", " ")))
        elif kind == "newcounter":
            defs.append("\\ifcsname c@%s\\endcsname\\else%s\\fi" % (base, txt))
        elif kind == "newlength":
            defs.append("\\ifcsname %s\\endcsname\\else%s\\fi" % (base, txt))
        elif kind == "makeat":
            if not re.search(r"\\(def|gdef|edef|newcommand|renewcommand|let|providecommand)(?![a-zA-Z])", txt) or "@firstpage" in txt:
                continue  # blok bez definic (např. nastavení čísla stránky v MDPI) — nepotřebujeme
            risky.append(txt)
        else:
            defs.append(txt)
    if risky:
        defs += risky
        R.warnings.append("Ze zdroje byly převzaty bloky \\makeatletter…\\makeatother — mohou zasahovat do vnitřností třídy; pokud překlad selže, začni jejich kontrolou.")
    if defs:
        R.done.append(f"Převzato {len(defs)} definic maker/prostředí z preambule zdroje")
    return pass_opts, lines, defs


# ---------------------------------------------------------------------------
# hlavní funkce


def _remove_preamble_front(pre: str, T: Template) -> str:
    d = Doc(pre)
    ed = []
    for nm in PREAMBLE_FRONT:
        spec = {"title": "som", "author": "som", "affil": "som", "affiliation": "som", "address": "om",
                "email": "om", "ead": "om", "cortext": "om", "tnotetext": "om", "fntext": "om"}.get(nm, "m")
        for c in d.cmds(nm, spec):
            ed.append((c.start, c.end, ""))
    for env in ("abstract",):
        for en in d.envs(env):
            ed.append((en.start, en.end, ""))
    return apply_edits(pre, ed)


def _bib_names(art: Article):
    names = []
    for b in art.bib_files:
        n = b[:-4] if b.lower().endswith(".bib") else b
        if n not in names:
            names.append(n)
    return names


def convert(art: Article, T: Template, src_root: Path, src_main: Path, out_dir: Path, out_name: str | None = None):
    R = Report()
    R.info.append(f"Cílová třída: {T.cls} — {T.label}" + (" (dvousloupcová sazba)" if T.twocolumn else ""))
    if T.family == "generic":
        R.warnings.append(f"Třídu „{T.cls}“ neznám nativně — titulní část jsem vytvořil podle vzoru šablony (\\title/\\author/abstract). Zkontroluj ji pečlivěji.")
    extra = []
    body = transform_body(art, T, R, extra)

    # titulní část
    gen = GENERATORS.get(T.family, GENERATORS["generic"])
    fm = gen(art, T)

    # back matter + bibliografie
    bib_names = _bib_names(art)
    back = back_matter(art, T)
    bib = bib_block(art, T, bib_names)
    body = body.replace(BACK_MARK, back.strip() + "\n" if back.strip() else "")
    body = body.replace(BIB_MARK, bib)
    if art.bib_kind == "thebibliography" and T.bib_system != "biblatex":
        R.warnings.append("Zdroj má ručně psanou bibliografii (thebibliography) — formát referencí zůstal původní, styl cílového časopisu se na ni neuplatní.")
    if art.bib_kind == "thebibliography" and T.bib_system == "biblatex":
        R.warnings.append("Šablona používá biblatex, ale zdroj má ručně psanou bibliografii — tohle spolu nefunguje dobře; doporučuji převést literaturu do .bib.")
    if art.bib_kind == "biblatex" and T.bib_system != "biblatex":
        R.warnings.append("Zdroj používal biblatex, cíl BibTeX: .bib soubor zůstává, ale pole jako date/journaltitle BibTeX nezná (používej year/journal).")
    if art.bib_kind in ("bibtex", "biblatex") and T.bib_system != "biblatex":
        R.done.append("Bibliografie: \\bibliographystyle{%s} + \\bibliography{%s}" % (T.bib_style or "(nastavuje třída)", ",".join(bib_names)))

    # preambule
    pass_opts, pkgs, defs = build_preamble_additions(art, T, R, body, extra)
    text = T.text
    pre = text[T.pre_start : T.begin_doc]
    pre = _remove_preamble_front(pre, T)
    if T.bib_system == "biblatex" and bib_names:
        d = Doc(pre)
        ed = [(c.start, c.end, "") for c in d.cmds("addbibresource", "om") + d.cmds("bibliography", "m")]
        pre = apply_edits(pre, ed)
        pre += "".join("\\addbibresource{%s.bib}\n" % n for n in bib_names)
    gp = list(dict.fromkeys(art.graphicspath))
    add = []
    if pkgs or defs or extra or gp:
        add.append("\n% ===== Převzato ze zdrojového článku (latex-prevodnik) =====\n")
        add += [l + "\n" for l in pkgs]
        if gp:
            add.append("\\graphicspath{" + "".join("{%s}" % g for g in gp) + "}\n")
        add += [l + "\n" for l in extra]
        add += [l.rstrip() + "\n" for l in defs]
        add.append("% ===== konec převzaté části =====\n")
    pre = pre.rstrip() + "\n" + "".join(add)
    if fm["preamble"]:
        pre += "\n% ===== Titulní údaje =====\n" + fm["preamble"]
    head = text[: T.pre_start]
    if pass_opts:
        dc_start = Doc(head).cmds("documentclass", "om")[0].start
        head = head[:dc_start] + "\n".join(pass_opts) + "\n" + head[dc_start:]
    body_head = text[T.body_start : T.insert_at]
    out = (head + pre.rstrip() + "\n\n" + "\\begin{document}" + body_head.rstrip() + "\n\n" + fm["front"] +
           "\n" + body.strip() + "\n\n\\end{document}\n")
    out = re.sub(r"\n{4,}", "\n\n\n", out)

    # soubory
    out_dir.mkdir(parents=True, exist_ok=True)
    name = out_name or T.main.name
    copy_files(T, src_root, src_main, art, out_dir, name, R)
    (out_dir / name).write_text(out, encoding="utf-8")
    R.info.append(f"Výstupní hlavní soubor: {name}")
    checklist(art, T, R)
    return out_dir / name, R


def copy_files(T: Template, src_root: Path, src_main: Path, art: Article, out_dir: Path, name: str, R: Report):
    # 1) soubory šablony (třída, styly, loga) — kromě hlavního .tex a ukázkového PDF
    tpl_main_pdf = T.main.with_suffix(".pdf")
    skip_tpl = {T.main.resolve(), tpl_main_pdf.resolve()} | {o.resolve() for o in T.others}
    for p in list_files(T.root):
        if p.resolve() in skip_tpl or is_aux(p):
            continue
        rel = p.relative_to(T.root)
        dst = out_dir / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, dst)
    # 2) soubory zdroje (obrázky, .bib, vložené soubory) — přepíší případné ukázkové
    src_cls = art.source_class
    n = 0
    for p in list_files(src_root):
        if p.resolve() == src_main.resolve() or is_aux(p):
            continue
        if p.suffix.lower() in (".cls", ".bst") and src_cls and p.stem == src_cls:
            continue
        if p.resolve() == src_main.with_suffix(".pdf").resolve():
            continue
        rel = p.relative_to(src_root)
        dst = out_dir / rel
        if dst.name == name:
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, dst)
        n += 1
    R.done.append(f"Zkopírováno {n} souborů ze zdroje (obrázky, literatura, …) a podpůrné soubory šablony")


def checklist(art: Article, T: Template, R: Report):
    if not art.title:
        R.warnings.append("Nenašel jsem název článku.")
    if not art.authors:
        R.warnings.append("Nenašel jsem žádné autory — doplň je ve formuláři.")
    elif not art.affiliations:
        R.warnings.append("Nenašel jsem afiliace autorů.")
    if not art.abstract:
        R.warnings.append("Nenašel jsem abstrakt.")
    if not art.keywords:
        R.info.append("Klíčová slova nenalezena.")
    if T.family == "mdpi" and not art.declarations:
        R.warnings.append("MDPI vyžaduje sekce Author Contributions, Funding, Conflicts of Interest — připravil jsem je zakomentované, doplň je.")
    if art.general_notes and T.family in ("mdpi", "snjnl"):
        R.warnings.append("Poznámky k názvu/autorům (" + " | ".join(art.general_notes) + ") jsem vložil do sekce Funding — zkontroluj, zda tam patří.")
    if T.family == "acmart":
        R.warnings.append("ACM vyžaduje CCS concepts (\\ccsdesc) a údaje o konferenci/časopisu — doplň je podle pokynů ACM.")
    if T.family == "elsarticle" and "\\journal{" in T.text:
        R.info.append("Nezapomeň upravit \\journal{...} v preambuli na název cílového časopisu.")
    for w in art.warnings:
        R.warnings.append(w)
    for i in art.info:
        R.info.append(i)
