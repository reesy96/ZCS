"""Vytěžení obsahu ze zdrojového článku do šablonově nezávislého modelu."""

from __future__ import annotations

import re
from pathlib import Path

from .authors import parse_authors
from .model import BACK_MARK, BIB_MARK, Article
from .project import expand_inputs, read_text
from .texparse import Doc, apply_edits, clean, find_commands, mask, squash, unwrap_cmd

# Příkazy titulní části, které se z těla odstraní (jméno → specifikace argumentů)
FRONT_CMDS = {
    "title": "som", "Title": "m", "TitleCitation": "m", "author": "som", "Author": "m",
    "AuthorNames": "m", "AuthorCitation": "m", "address": "om", "affiliation": "som", "affil": "som",
    "institute": "m", "email": "om", "ead": "om", "corres": "m", "cortext": "om", "fntext": "om",
    "tnotetext": "om", "date": "m", "maketitle": "", "IEEEpeerreviewmaketitle": "", "keywords": "m",
    "keyword": "m", "orcid": "m", "altaffiliation": "om", "homepage": "om", "authornote": "m",
    "markboth": "mm", "authorrunning": "m", "titlerunning": "m", "shorttitle": "m", "shortauthors": "m",
    "received": "om", "revised": "om", "accepted": "om", "published": "om", "pacs": "m", "preprint": "m",
    "ccsdesc": "om", "settopmatter": "m", "firstnote": "m", "secondnote": "m", "thirdnote": "m",
    "equalcont": "m", "IEEEdisplaynontitleabstractindextext": "", "IEEEoverridecommandlockouts": "",
    "cormark": "o", "fnmark": "o", "curraddr": "om", "dedicatory": "m", "subjclass": "om",
    "abstract": "m", "IEEEtitleabstractindextext": "m", "linenumbers": "", "thispagestyle": "m",
    "tnoteref": "m", "noindent": "", "credit": "m", "nonumnote": "m", "collaboration": "m",
    "noaffiliation": "", "authornotemark": "o", "tnotemark": "o", "IEEEaftertitletext": "m",
}
FRONT_ENVS = ["frontmatter", "abstract", "keyword", "keywords", "IEEEkeywords", "highlights",
              "graphicalabstract", "CCSXML", "IEEEbiography", "IEEEbiographynophoto"]

SECTION_RE = r"\\(section|chapter|part|bmhead|appendix|subsection)(?![a-zA-Z@])\*?"

DEF_SPECS = {
    "newcommand": "smOm", "renewcommand": "smOm", "providecommand": "smOm",
    "DeclareRobustCommand": "smOm", "DeclareMathOperator": "smm", "newenvironment": "smOmm",
    "renewenvironment": "smOmm", "newtheorem": "smomo", "theoremstyle": "m", "newcolumntype": "mom",
    "definecolor": "ommm", "colorlet": "omm", "usetikzlibrary": "m", "usepgfplotslibrary": "m",
    "pgfplotsset": "m", "tikzset": "m", "sisetup": "m", "lstset": "m", "lstdefinestyle": "mm",
    "lstdefinelanguage": "omom", "hyphenation": "m", "newcounter": "mo", "numberwithin": "omm",
    "crefname": "mmm", "Crefname": "mmm", "DeclareSIUnit": "omm", "newif": "m", "SetKwInput": "mm",
    "SetKwFunction": "mm", "newlength": "m", "DeclarePairedDelimiter": "mmm", "newacronym": "ommm",
    "algrenewcommand": "mOm", "algnewcommand": "mOm", "DeclareCaptionFormat": "mm",
    "DeclareCaptionLabelFormat": "mm", "newfloat": "mmmo", "floatname": "mm",
}

ACK_HEAD_RE = re.compile(
    r"\\(section|subsection|subsubsection|paragraph|bmhead|section\*)\*?\s*(\[[^\]]*\])?\s*\{\s*(\\textbf\{)?\s*(Acknowledg(e)?ments?|Acknowledg(e)?ment|Poděkování|Podekovani|Acknowledgements?)\s*\}?\s*\}",
    re.I,
)

MDPI_BACK = ["authorcontributions", "funding", "institutionalreview", "informedconsent", "dataavailability",
             "conflictsofinterest", "sampleavailability", "abbreviations", "supplementary", "acknowledgments",
             "disclaimer", "useofartificialintelligence", "entrylink"]
DECL_TITLES = {
    "authorcontributions": "Author Contributions", "funding": "Funding",
    "institutionalreview": "Institutional Review Board Statement", "informedconsent": "Informed Consent Statement",
    "dataavailability": "Data Availability Statement", "conflictsofinterest": "Conflicts of Interest",
    "sampleavailability": "Sample Availability", "abbreviations": "Abbreviations",
    "supplementary": "Supplementary Materials", "disclaimer": "Disclaimer",
    "useofartificialintelligence": "Use of Artificial Intelligence",
}


def _first(cmds):
    return cmds[0] if cmds else None


def class_name(raw: str) -> str:
    return raw.strip().split("/")[-1]


def split_keywords(text: str):
    t = clean(text)
    t = re.split(r"\\(PACS|MSC|JEL)(?![a-zA-Z])", t)[0]
    if "\\kwd" in t:
        d = Doc(t)
        return [squash(c.args[0]) for c in d.cmds("kwd", "om") if squash(c.args[0])]
    t = re.sub(r"\\sep(?![a-zA-Z])|\\and(?![a-zA-Z])|\\\\|\\par(?![a-zA-Z])", ";", t)
    t = re.sub(r"^\s*(\\textbf|\\textit|\\emph)?\{?\s*(Key\s*words|Keywords|Index Terms|Klíčová slova)\s*[:.—-]?\s*\}?\s*[:.—-]?", "", t, flags=re.I)
    sep = ";" if ";" in t else ("·" if "·" in t else ",")
    out = []
    for k in t.split(sep):
        k = squash(k).strip(" .;,")
        if k:
            out.append(k)
    return out


PLAIN_KW_RE = re.compile(
    r"(\\noindent\s*)?(\{\s*)?\\(textbf|textit|emph|textsc|bf|it)\s*\{?\s*(Key\s*words|Keywords|Index terms|Klíčová slova)\s*[:.—-]?\s*\}?\s*[:.—-]?\s*\}?(?P<kw>[^\n]*(\n(?!\s*\n)[^\n]*)*)",
    re.I,
)


def extract(main: Path, root: Path) -> Article:
    art = Article()
    used = set()
    text = expand_inputs(read_text(main), main.parent, root, used)
    d = Doc(text)
    dc = _first(d.cmds("documentclass", "om"))
    if not dc:
        raise ValueError("Ve zdrojovém souboru chybí \\documentclass.")
    art.source_class = class_name(dc.args[0])
    art.source_class_options = squash(clean(dc.opts[0]).replace("%", "")) if dc.opts else ""
    b = d.search(r"\\begin\s*\{document\}")
    e = d.search(r"\\end\s*\{document\}")
    if not b:
        raise ValueError("Ve zdrojovém souboru chybí \\begin{document}.")
    preamble = text[dc.end : b.start()]
    body = text[b.end() : e.start() if e else len(text)]
    pre_clean = strip_pre = clean(preamble)

    bd = Doc(body)
    # oblast před první kapitolou = titulní část
    first_sec = None
    fm_envs = bd.envs("frontmatter")
    search_from = fm_envs[0].end if fm_envs else 0
    ms = bd.search(SECTION_RE, search_from)
    first_sec = ms.start() if ms else len(body)
    # konec abstraktu může být až za první \section? ne — ale \maketitle u acmart je za abstraktem
    front_region = body[:first_sec]
    F = Doc(pre_clean + "\n" + clean(front_region))

    # --- titul
    t = _first(F.cmds("title", "som")) or _first(F.cmds("Title", "m"))
    if t:
        title = t.args[0]
        title = re.sub(r"^\s*\[[^\]]*\]", "", title) if t.name == "title" else title
        thanks = [squash(c.args[0]) for c in Doc(title).cmds("thanks", "om")]
        for c in Doc(title).cmds("tnotetext", "om"):
            pass
        from .texparse import remove_cmds

        art.title = squash(remove_cmds(title, {"thanks": "om", "tnoteref": "m", "footnote": "om", "titlenote": "m"}))
        if thanks:
            art.general_notes += thanks
        if t.opts and t.name == "title" and "mode" not in t.opts[0]:
            art.short_title = squash(t.opts[0])
    st = _first(F.cmds("titlerunning", "m")) or _first(F.cmds("shorttitle", "m"))
    if st and not art.short_title:
        art.short_title = squash(st.args[0])

    # --- autoři
    authors, affs, style, corres, notes = parse_authors(F, pre_clean)
    art.authors, art.affiliations, art.correspondence = authors, affs, corres
    art.warnings += notes
    art.info.append(f"Autoři rozpoznáni stylem: {style}")
    for nm in ("firstnote", "secondnote", "thirdnote"):
        for c in F.cmds(nm, "m"):
            art.general_notes.append(squash(c.args[0]))
    for tn in F.cmds("tnotetext", "om"):
        art.general_notes.append(squash(tn.args[0]))
    for ft in F.cmds("fntext", "om"):
        art.general_notes.append(squash(ft.args[0]))

    # --- abstrakt
    ab_env = F.envs("abstract")
    if ab_env:
        art.abstract = ab_env[0].inner(F.text).strip()
    else:
        ab = _first(F.cmds("abstract", "m"))
        if ab:
            art.abstract = ab.args[0].strip()
    if art.abstract:
        ad = Doc(art.abstract)
        kwin = _first(ad.cmds("keywords", "m"))
        if kwin and not art.keywords:
            art.keywords = split_keywords(kwin.args[0])
        from .texparse import remove_cmds

        art.abstract = remove_cmds(art.abstract, {"keywords": "m"}).strip()
        mk = PLAIN_KW_RE.search(art.abstract)
        if mk and not art.keywords:
            art.keywords = split_keywords(mk.group("kw"))
            art.abstract = art.abstract[: mk.start()].strip()
        # MDPI: \abstract{\textbf{Background:} ...} necháme; odstraníme \noindent na začátku
        art.abstract = re.sub(r"^\\noindent\s*", "", art.abstract)

    # --- klíčová slova
    if not art.keywords:
        for env in ("keyword", "keywords", "IEEEkeywords"):
            ke = F.envs(env)
            if ke:
                art.keywords = split_keywords(ke[0].inner(F.text))
                break
    if not art.keywords:
        for cmd in ("keywords", "keyword", "kwd"):
            kc = F.cmds(cmd, "om")
            if kc:
                art.keywords = split_keywords(kc[0].args[0]) if cmd != "kwd" else [squash(c.args[0]) for c in kc]
                break
    plain_kw_span = None
    if not art.keywords:
        mk = PLAIN_KW_RE.search(bd.m, 0, first_sec)
        if mk:
            art.keywords = split_keywords(body[mk.start("kw") : mk.end("kw")])
            plain_kw_span = (mk.start(), mk.end())

    # --- highlights
    for h in F.envs("highlights"):
        items = re.split(r"\\item(?![a-zA-Z])", h.inner(F.text))
        art.highlights = [squash(i) for i in items if squash(i)]

    # --- tělo: odstranění titulní části
    edits = []
    if plain_kw_span:
        edits.append((plain_kw_span[0], plain_kw_span[1], ""))
    for env in FRONT_ENVS:
        for en in bd.envs(env, end=first_sec if env not in ("IEEEbiography", "IEEEbiographynophoto") else None):
            edits.append((en.start, en.end, ""))
    for nm, spec in FRONT_CMDS.items():
        if nm == "noindent":
            continue
        for c in bd.cmds(nm, spec, 0, first_sec):
            edits.append((c.start, c.end, ""))
    for nm in ("IEEEbiography", "IEEEbiographynophoto"):
        if bd.envs(nm):
            art.warnings.append("Biografie autorů (IEEEbiography) byly vynechány — do jiných šablon nepatří.")
            break
    body = apply_edits(body, _dedupe_outer(edits))
    bd = Doc(body)

    # --- poděkování a „back matter“
    edits = []
    marker_pos = None
    for env in ("acknowledgments", "acknowledgment", "acknowledgements", "acknowledgement", "acks", "ack", "credits"):
        for en in bd.envs(env):
            txt = en.inner(body)
            if env == "credits":
                parts = re.split(r"\\subsubsection\*?\{\\discintname\}", txt)
                if len(parts) > 1 and parts[1].strip():
                    art.declarations["Competing interests"] = parts[1].strip()
                txt = parts[0]
            txt = re.sub(r"\\subsubsection\*?\{\\(ackname|discintname)\}", "", txt)
            art.acknowledgments = (art.acknowledgments + "\n\n" + txt.strip()).strip()
            edits.append((en.start, en.end, BACK_MARK))
    for mh in ACK_HEAD_RE.finditer(bd.m):
        end = _section_end(bd, mh.end())
        art.acknowledgments = (art.acknowledgments + "\n\n" + body[mh.end() : end].strip()).strip()
        edits.append((mh.start(), end, BACK_MARK + "\n"))
    for nm in MDPI_BACK:
        found = bd.cmds(nm, "mm") if nm == "abbreviations" else []
        if found:
            for c in found:
                c.args = [c.args[1]]
        else:
            found = bd.cmds(nm, "m")
        for c in found:
            if nm == "acknowledgments":
                art.acknowledgments = (art.acknowledgments + "\n\n" + c.args[0].strip()).strip()
            else:
                art.declarations[DECL_TITLES.get(nm, nm)] = c.args[0].strip()
            edits.append((c.start, c.end, BACK_MARK))
    # bibliografie
    bib_pos = []
    for c in bd.cmds("bibliographystyle", "m"):
        art.bib_style = c.args[0].strip()
        bib_pos.append((c.start, c.end))
    for c in bd.cmds("bibliography", "m"):
        art.bib_kind = "bibtex"
        art.bib_files += [x.strip() for x in c.args[0].split(",") if x.strip()]
        bib_pos.append((c.start, c.end))
    for c in bd.cmds("printbibliography", "o"):
        art.bib_kind = "biblatex"
        bib_pos.append((c.start, c.end))
    for en in bd.envs("thebibliography"):
        art.bib_kind = "thebibliography"
        art.thebibliography = body[en.start : en.end]
        bib_pos.append((en.start, en.end))
    for nm, spec in (("reftitle", "m"), ("externalbibliography", "m"), ("PublishersNote", "m"),
                     ("printendnotes", "o"), ("bibliographyfile", "m")):
        for c in bd.cmds(nm, spec):
            bib_pos.append((c.start, c.end))
    for nm, spec in (("IEEEtriggeratref", "m"), ("IEEEtriggercmd", "m"), ("vspace", "sm")):
        pass
    if bib_pos:
        bib_pos.sort()
        edits.append((bib_pos[0][0], bib_pos[0][1], BIB_MARK))
        for s, e_ in bib_pos[1:]:
            edits.append((s, e_, ""))
    body = apply_edits(body, _dedupe_outer(edits))
    # pouze první značka back matter zůstane
    first = body.find(BACK_MARK)
    if first >= 0:
        body = body[: first + len(BACK_MARK)] + body[first + len(BACK_MARK) :].replace(BACK_MARK, "")
    if BIB_MARK not in body:
        body = body.rstrip() + "\n\n" + BIB_MARK + "\n"
    if BACK_MARK not in body:
        body = body.replace(BIB_MARK, BACK_MARK + "\n" + BIB_MARK, 1)
    art.body = _tidy(body)

    # --- preambule: balíčky a definice
    P = Doc(pre_clean)
    for nm in ("usepackage", "RequirePackage"):
        for c in P.cmds(nm, "omo"):
            opts = squash(c.opts[0]) if c.opts else ""
            for pk in c.args[0].split(","):
                pk = pk.strip()
                if pk:
                    art.preamble_packages.append((opts, pk))
    art.uses_fontspec = any(p in ("fontspec", "unicode-math", "polyglossia", "xeCJK") for _, p in art.preamble_packages)
    for _, p in art.preamble_packages:
        if p == "biblatex":
            art.bib_kind = "biblatex" if art.bib_kind in ("none", "biblatex") else art.bib_kind
    for c in P.cmds("usepackage", "omo"):
        if "biblatex" in c.args[0] and c.opts:
            art.biblatex_options = squash(c.opts[0])
    for c in P.cmds("addbibresource", "om") + P.cmds("addglobalbib", "om") + P.cmds("bibliography", "m"):
        for f in c.args[0].split(","):
            if f.strip():
                art.bib_files.append(f.strip())
    for c in P.cmds("graphicspath", "m"):
        art.graphicspath += re.findall(r"\{([^{}]*)\}", c.args[0])
    art.preamble_defs = extract_defs(pre_clean)

    # --- kontroly
    _check_files(art, root, main)
    return art


def _dedupe_outer(edits):
    """Ze zásahů, které se překrývají, ponech ten vnější."""
    edits = sorted(edits, key=lambda e: (e[0], -(e[1])))
    out = []
    last_end = -1
    for s, e, r in edits:
        if s < last_end:
            continue
        out.append((s, e, r))
        last_end = e
    return out


def _section_end(bd: Doc, pos: int) -> int:
    pat = re.compile(r"\\(section|chapter|appendix|bmhead|bibliography|bibliographystyle|printbibliography|begin\s*\{(thebibliography|appendices|acknowledgments|backmatter)\}|backmatter)(?![a-zA-Z@])|\\end\s*\{document\}|%%PREVOD:")
    m = pat.search(bd.m, pos)
    return m.start() if m else len(bd.text)


def _tidy(body: str) -> str:
    body = re.sub(r"\n[ \t]*\n([ \t]*\n)+", "\n\n", body)
    return body.strip("\n") + "\n"


def extract_defs(pre: str):
    """Najde definice maker v preambuli. Vrací [(druh, jméno, text)]."""
    P = Doc(pre)
    found = []
    # bloky \makeatletter ... \makeatother vezmeme celé
    blocks = []
    for m in re.finditer(r"\\makeatletter(?![a-zA-Z])", P.m):
        e = re.compile(r"\\makeatother(?![a-zA-Z])").search(P.m, m.end())
        end = e.end() if e else len(pre)
        blocks.append((m.start(), end))
        found.append((m.start(), "makeat", "", pre[m.start() : end]))

    def inside_block(pos):
        return any(s <= pos < e for s, e in blocks)

    for nm, spec in DEF_SPECS.items():
        for c in P.cmds(nm, spec):
            if inside_block(c.start):
                continue
            name = c.args[0].strip() if c.args else ""
            name = name.lstrip("\\").strip("{} ")
            found.append((c.start, nm, name, pre[c.start : c.end]))
    for m in re.finditer(r"\\(g|e|x)?def\s*\\([a-zA-Z@]+)", P.m):
        if inside_block(m.start()):
            continue
        brace = P.m.find("{", m.end())
        if brace < 0:
            continue
        from .texparse import find_matching

        end = find_matching(P.m, brace)
        if end < 0:
            continue
        found.append((m.start(), "def", m.group(2), pre[m.start() : end]))
    for m in re.finditer(r"\\let\s*\\([a-zA-Z@]+)\s*=?\s*\\[a-zA-Z@]+", P.m):
        if not inside_block(m.start()):
            found.append((m.start(), "let", m.group(1), pre[m.start() : m.end()]))
    found.sort()
    # odstraň definice vnořené v jiných (např. \newcommand uvnitř \newenvironment)
    out = []
    last_end = -1
    for start, kind, name, txt in found:
        if start < last_end:
            continue
        out.append((kind, name, txt))
        last_end = start + len(txt)
    return out


GRAPHIC_EXT = ["", ".pdf", ".png", ".jpg", ".jpeg", ".eps", ".PDF", ".PNG", ".JPG", ".svg"]


def _check_files(art: Article, root: Path, main: Path):
    bd = Doc(art.body)
    missing = []
    eps = []
    dirs = [main.parent, root] + [main.parent / g for g in art.graphicspath] + [root / g for g in art.graphicspath]
    for c in bd.cmds("includegraphics", "som"):
        f = c.args[0].strip()
        ok = False
        for base in dirs:
            for ext in GRAPHIC_EXT:
                if (base / (f + ext)).is_file():
                    ok = True
                    if (f + ext).lower().endswith(".eps") and ext:
                        eps.append(f)
                    break
            if ok:
                break
        if not ok:
            missing.append(f)
        if f.lower().endswith(".eps"):
            eps.append(f)
    if missing:
        art.warnings.append("Nenalezené obrázky ve zdroji (nahraj je také): " + ", ".join(sorted(set(missing))))
    if eps:
        art.info.append("Obrázky EPS se při pdfLaTeXu převádějí automaticky (epstopdf); ve starší instalaci TeXu to může selhat.")
    if art.bib_kind in ("bibtex", "biblatex"):
        nob = []
        for b in art.bib_files:
            fn = b if b.endswith(".bib") else b + ".bib"
            if not ((main.parent / fn).is_file() or (root / fn).is_file()):
                nob.append(fn)
        if nob:
            bbl = main.with_suffix(".bbl")
            if bbl.is_file() and art.bib_kind == "bibtex":
                art.bib_kind = "thebibliography"
                art.thebibliography = read_text(bbl)
                art.warnings.append(f"Soubor {', '.join(nob)} chybí — použil jsem hotovou bibliografii z {bbl.name} (styl citací zůstane podle původní šablony).")
            else:
                art.warnings.append("Chybí soubor s literaturou: " + ", ".join(nob) + " — nahraj ho spolu s článkem.")
