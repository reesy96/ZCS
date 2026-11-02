"""Analýza cílové šablony a generování titulní části pro jednotlivé třídy."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from .extract import FRONT_CMDS, FRONT_ENVS, class_name
from .authors import latex_to_unicode
from .model import Article, Author
from .project import read_text
from .texparse import Doc, clean, mask, squash

# Rodiny tříd, které umíme „nativně“
FAMILIES = {
    "elsarticle": "elsarticle", "cas-sc": "cas", "cas-dc": "cas", "IEEEtran": "ieee", "IEEEconf": "ieee",
    "revtex4": "revtex", "revtex4-1": "revtex", "revtex4-2": "revtex", "aip": "revtex", "aps": "revtex",
    "acmart": "acmart", "llncs": "llncs", "svjour3": "svjour", "svjour": "svjour", "sn-jnl": "snjnl",
    "mdpi": "mdpi", "amsart": "amsart", "article": "generic", "scrartcl": "generic", "extarticle": "generic",
    "report": "generic", "aa": "generic", "copernicus": "generic",
}

FAMILY_LABEL = {
    "elsarticle": "Elsevier (elsarticle)", "cas": "Elsevier CAS (cas-sc/cas-dc)", "ieee": "IEEE (IEEEtran)",
    "revtex": "APS/AIP (REVTeX)", "acmart": "ACM (acmart)", "llncs": "Springer LNCS (llncs)",
    "svjour": "Springer (svjour3)", "snjnl": "Springer Nature (sn-jnl)", "mdpi": "MDPI",
    "amsart": "AMS (amsart)", "generic": "obecná třída (article apod.)",
}

# výchozí bibliografické styly tříd
DEFAULT_BST = {"elsarticle": "elsarticle-num", "cas": "cas-model2-names", "ieee": "IEEEtran", "llncs": "splncs04",
               "acmart": "ACM-Reference-Format", "svjour": "spmpsci", "amsart": "amsplain", "generic": "plain"}
# třídy, které natbib načítají samy
NATBIB_CLASSES = {"elsarticle", "cas", "revtex", "acmart", "mdpi", "snjnl"}
# třídy, které si bibliografický styl nastaví samy
NO_BST_CLASSES = {"snjnl", "revtex"}

# metadata, která v preambuli šablony nahrazujeme svými
PREAMBLE_FRONT = ["title", "Title", "TitleCitation", "author", "Author", "AuthorNames", "AuthorCitation",
                  "address", "affiliation", "affil", "institute", "email", "corres", "abstract", "keyword",
                  "keywords", "firstnote", "secondnote", "thirdnote", "shorttitle", "shortauthors",
                  "authorrunning", "titlerunning", "ead", "orcid", "cortext", "tnotetext", "fntext"]

THEOREM_PREDEFINED = {
    "llncs": {"theorem", "lemma", "corollary", "proposition", "definition", "example", "remark", "proof",
              "note", "problem", "property", "question", "solution", "case", "claim", "conjecture", "exercise"},
    "svjour": {"theorem", "lemma", "corollary", "proposition", "definition", "example", "remark", "proof",
               "note", "problem", "property", "question", "solution", "case", "claim", "conjecture", "exercise"},
    "ieee": {"IEEEproof"},
}


@dataclass
class Template:
    main: Path
    root: Path
    text: str
    cls: str
    cls_raw: str
    options: str
    family: str
    twocolumn: bool
    pre_start: int  # konec \documentclass[...]{...}
    begin_doc: int  # začátek \begin{document}
    body_start: int  # konec \begin{document}
    insert_at: int  # kde v těle začíná titulní část / obsah
    end_doc: int
    feats: dict = field(default_factory=dict)
    packages: set = field(default_factory=set)
    preamble_clean: str = ""
    bib_style: str = ""
    bib_system: str = "bibtex"
    others: list = field(default_factory=list)
    warnings: list = field(default_factory=list)

    @property
    def label(self):
        return FAMILY_LABEL.get(self.family, self.cls)


def analyze_template(main: Path, root: Path, others=None) -> Template:
    text = read_text(main)
    d = Doc(text)
    dcs = d.cmds("documentclass", "om")
    if not dcs:
        raise ValueError("V šabloně chybí \\documentclass.")
    dc = dcs[0]
    cls_raw = dc.args[0].strip()
    cls = class_name(cls_raw)
    opts = squash(clean(dc.opts[0]).replace("%", "")) if dc.opts else ""
    optset = {o.strip() for o in opts.split(",")}
    family = FAMILIES.get(cls, "generic")
    if cls.startswith("revtex"):
        family = "revtex"
    b = d.search(r"\\begin\s*\{document\}")
    e = d.search(r"\\end\s*\{document\}")
    if not b:
        raise ValueError("V šabloně chybí \\begin{document}.")
    end_doc = e.start() if e else len(text)
    pre_clean = clean(text[dc.end : b.start()])
    body_m = d.m[b.end() : end_doc]

    # dvousloupcová sazba?
    two = "twocolumn" in optset
    if family == "ieee":
        two = not ({"onecolumn", "draftcls", "draftclsnofoot", "peerreview", "peerreviewca"} & optset)
    elif family == "elsarticle":
        two = two or "5p" in optset
    elif family == "cas":
        two = cls == "cas-dc"
    elif family == "revtex":
        two = two or "reprint" in optset
    elif family == "acmart":
        two = bool({"sigconf", "sigplan", "sigchi", "acmtog"} & optset) and "manuscript" not in optset
    elif cls == "aa":
        two = "onecolumn" not in optset
    if re.search(r"\\twocolumn(?![a-zA-Z\[])", body_m):
        two = True

    # kde začíná titulní část
    starts = []
    for nm, spec in FRONT_CMDS.items():
        if nm in ("noindent", "thispagestyle", "linenumbers", "date", "IEEEoverridecommandlockouts"):
            continue
        for c in d.cmds(nm, spec, b.end(), end_doc):
            starts.append(c.start)
    for env in FRONT_ENVS + ["teaserfigure"]:
        for en in d.envs(env, start=b.end(), end=end_doc):
            starts.append(en.start)
    if starts:
        insert_at = min(starts)
    else:
        ms = re.compile(r"\\(section|chapter|bibliography|begin\s*\{thebibliography\}|printbibliography)(?![a-zA-Z])").search(d.m, b.end(), end_doc)
        insert_at = ms.start() if ms else end_doc

    t = Template(main=main, root=root, text=text, cls=cls, cls_raw=cls_raw, options=opts, family=family,
                 twocolumn=two, pre_start=dc.end, begin_doc=b.start(), body_start=b.end(), insert_at=insert_at,
                 end_doc=end_doc, preamble_clean=pre_clean, others=others or [])
    P = Doc(pre_clean)
    for nm in ("usepackage", "RequirePackage"):
        for c in P.cmds(nm, "omo"):
            for p in c.args[0].split(","):
                if p.strip():
                    t.packages.add(p.strip())
    whole = Doc(text)
    body_text = text[b.end() : end_doc]
    bd = Doc(body_text)
    f = t.feats
    f["ieee_conference"] = family == "ieee" and "conference" in optset
    f["abstract_cmd"] = bool(re.search(r"\\abstract\s*\{", whole.m)) and not re.search(r"\\begin\s*\{abstract\}", whole.m)
    ab = re.search(r"\\begin\s*\{abstract\}|\\abstract\s*\{", whole.m)
    mk = re.search(r"\\maketitle(?![a-zA-Z])", whole.m)
    f["has_maketitle"] = bool(mk)
    f["abstract_before_maketitle"] = bool(ab and mk and ab.start() < mk.start())
    kwf = None
    for env in ("keyword", "keywords", "IEEEkeywords"):
        if re.search(r"\\begin\s*\{" + env + r"\}", whole.m):
            kwf = "env:" + env
            break
    if not kwf:
        for cmd in ("keywords", "keyword"):
            if re.search(r"\\" + cmd + r"\s*\{", whole.m):
                kwf = "cmd:" + cmd
                break
    if not kwf and re.search(r"Key\s*words|Index Terms", whole.m, re.I):
        kwf = "plain"
    f["keywords_form"] = kwf
    f["keywords_in_abstract"] = bool(re.search(r"\\begin\s*\{abstract\}((?!\\end\s*\{abstract\}).)*\\keywords", whole.m, re.S))
    f["authblk"] = "authblk" in t.packages
    f["affil_kv"] = bool(re.search(r"\\affiliation\s*(\[[^\]]*\])?\s*\{\s*organization\s*=", whole.m))
    f["els_address"] = bool(re.search(r"\\address\s*\[", whole.m))
    f["highlights"] = bool(re.search(r"\\begin\s*\{highlights\}", whole.m))
    f["date_cmd"] = (re.search(r"\\date\s*\{[^}]*\}", clean(text[b.end():end_doc]) + pre_clean) or [None])[0] if re.search(r"\\date\s*\{", whole.m) else None
    f["extralength"] = "\\extralength" in body_m
    f["publishersnote"] = bool(re.search(r"\\PublishersNote", whole.m))
    f["authorcitation"] = bool(re.search(r"\\AuthorCitation", whole.m))
    f["abbrev2"] = bool(re.search(r"\\abbreviations\s*\{\s*Abbreviations\s*\}\s*\{", whole.m))
    f["credits_env"] = bool(re.search(r"\\begin\s*\{credits\}", whole.m))
    f["reftitle"] = bool(re.search(r"\\reftitle", whole.m))
    f["theorems"] = set(re.findall(r"\\newtheorem\*?\s*\{([^}]*)\}", pre_clean))
    f["appendices_env"] = family == "snjnl" or "appendix" in t.packages
    f["twocolumn"] = two

    # bibliografie v šabloně
    if "biblatex" in t.packages:
        t.bib_system = "biblatex"
    style = re.findall(r"\\bibliographystyle\s*\{([^}]*)\}", whole.m)
    if style:
        t.bib_style = style[-1].strip()
    else:
        commented = re.findall(r"%+\s*\\bibliographystyle\s*\{([^}<>]*)\}", text)
        commented = [c.strip() for c in commented if c.strip() and "<" not in c]
        bsts = sorted(p for p in root.rglob("*.bst"))
        if commented:
            t.bib_style = commented[0]
        elif len(bsts) >= 1:
            rel = bsts[0].relative_to(root).with_suffix("")
            t.bib_style = rel.as_posix()
        elif family not in NO_BST_CLASSES:
            t.bib_style = DEFAULT_BST.get(family, "plain")
    if family in NO_BST_CLASSES and not style:
        t.bib_style = ""
    f["natbib"] = family in NATBIB_CLASSES or "natbib" in t.packages or (
        t.bib_system == "biblatex" and re.search(r"natbib\s*=\s*true|natbib(?=[,\]])", pre_clean) is not None)
    return t


# ---------------------------------------------------------------------------
# pomocné funkce pro generování


def used_affs(art: Article):
    """Afiliace v pořadí prvního použití; vrací (seznam textů, {starý index: nové číslo od 1})."""
    order = []
    for a in art.authors:
        for i in a.affs:
            if 0 <= i < len(art.affiliations) and i not in order:
                order.append(i)
    for i in range(len(art.affiliations)):  # nepoužité na konec
        if i not in order and art.affiliations[i].strip():
            order.append(i)
    mapping = {old: k + 1 for k, old in enumerate(order)}
    return [art.affiliations[i] for i in order], mapping


def nums(a: Author, mapping):
    return [mapping[i] for i in a.affs if i in mapping]


def _kw_join(art, sep):
    return sep.join(art.keywords)


def keywords_block(art: Article, form: str | None, default="plain"):
    if not art.keywords:
        return ""
    form = form or default
    if form == "env:keyword":
        return "\\begin{keyword}\n" + " \\sep ".join(art.keywords) + "\n\\end{keyword}\n"
    if form == "env:keywords":
        return "\\begin{keywords}\n" + " \\sep ".join(art.keywords) + "\n\\end{keywords}\n" if False else \
               "\\begin{keywords}\n" + ", ".join(art.keywords) + "\n\\end{keywords}\n"
    if form == "env:IEEEkeywords":
        return "\\begin{IEEEkeywords}\n" + ", ".join(art.keywords) + "\n\\end{IEEEkeywords}\n"
    if form == "cmd:keywords":
        return "\\keywords{" + ", ".join(art.keywords) + "}\n"
    if form == "cmd:keyword":
        return "\\keyword{" + "; ".join(art.keywords) + "}\n"
    return "\\medskip\n\\noindent\\textbf{Keywords:} " + "; ".join(art.keywords) + "\n"


def abstract_block(art: Article, cmd=False):
    if not art.abstract.strip():
        return ""
    if cmd:
        return "\\abstract{" + art.abstract.strip() + "}\n"
    return "\\begin{abstract}\n" + art.abstract.strip() + "\n\\end{abstract}\n"


def _title_notes(art: Article):
    """Obecné poznámky (financování apod.) jako \\thanks u názvu."""
    return "".join("\\thanks{" + n + "}" for n in art.general_notes)


def corr_note(a: Author):
    return "Corresponding author" + (": \\href{mailto:%s}{%s}" % (a.email, a.email) if a.email else "")


def _thanks(a: Author, with_email=True, corr=True):
    parts = []
    if a.corresponding and corr:
        parts.append("Corresponding author.")
    if a.email and with_email:
        parts.append("E-mail: " + a.email)
    parts += a.notes
    return "".join("\\thanks{" + p + "}" for p in parts)


# ---------------------------------------------------------------------------
# generátory titulních částí — každý vrací dict(preamble=..., front=...)


def gen_generic(art: Article, T: Template):
    affs, mp = used_affs(art)
    out = []
    out.append("\\title{" + art.title + _title_notes(art) + "}\n")
    if T.feats.get("authblk"):
        for a in art.authors:
            n = ",".join(str(x) for x in nums(a, mp))
            out.append("\\author[" + n + "]{" + a.name + _thanks(a) + "}\n")
        for k, af in enumerate(affs, 1):
            out.append("\\affil[" + str(k) + "]{" + af + "}\n")
    else:
        multi = len(affs) > 1
        names = []
        for a in art.authors:
            mark = ",".join(str(x) for x in nums(a, mp)) if multi else ""
            if a.corresponding:
                mark = (mark + ",*") if mark else "*"
            names.append(a.name + ("\\textsuperscript{" + mark + "}" if mark else ""))
        lines = []
        for k, af in enumerate(affs, 1):
            lines.append(("\\textsuperscript{%d}" % k if multi else "") + af)
        corr = [a for a in art.authors if a.corresponding and a.email]
        for a in corr:
            lines.append("\\textsuperscript{*}Corresponding author: \\texttt{" + a.email + "}")
        if len(names) > 1:
            auth = ", ".join(names[:-1]) + " and " + names[-1]
        else:
            auth = names[0] if names else ""
        notes = [n for a in art.authors for n in a.notes]
        auth += "".join("\\thanks{" + n + "}" for n in notes)
        if lines:
            auth += ("\\\\[1ex]\n  \\parbox{\\linewidth}{\\centering\\small\n   "
                     + "\\\\\n   ".join(lines) + "}")
        out.append("\\author{" + auth + "}\n")
    if T.feats.get("date_cmd"):
        out.append(T.feats["date_cmd"] + "\n")
    ab = abstract_block(art, T.feats.get("abstract_cmd"))
    kw = keywords_block(art, T.feats.get("keywords_form"))
    if T.feats.get("abstract_before_maketitle"):
        out += [ab, kw, "\\maketitle\n"]
    else:
        out += ["\\maketitle\n", ab, kw]
    return {"preamble": "", "front": "".join(out)}


def gen_amsart(art: Article, T: Template):
    affs, mp = used_affs(art)
    out = ["\\title{" + art.title + _title_notes(art) + "}\n"]
    for a in art.authors:
        out.append("\\author{" + a.name + "}\n")
        for i in a.affs:
            if 0 <= i < len(art.affiliations):
                out.append("\\address{" + art.affiliations[i] + "}\n")
        if a.email:
            out.append("\\email{" + a.email + "}\n")
        for n in a.notes:
            out.append("\\thanks{" + n + "}\n")
    if art.keywords:
        out.append("\\keywords{" + ", ".join(art.keywords) + "}\n")
    out.append(abstract_block(art))
    out.append("\\maketitle\n")
    return {"preamble": "", "front": "".join(out)}


def gen_elsarticle(art: Article, T: Template, cas=False):
    affs, mp = used_affs(art)
    out = []
    if cas:
        out.append("\\shorttitle{" + (art.short_title or art.title) + "}\n")
        out.append("\\shortauthors{" + _short_authors(art) + "}\n")
        out.append("\\title[mode = title]{" + art.title + "}" + ("\\tnotemark[1]" if art.general_notes else "") + "\n" + ("\\tnotetext[1]{" + " ".join(art.general_notes) + "}\n" if art.general_notes else ""))
    else:
        out.append("\\begin{frontmatter}\n\n")
        out.append("\\title{" + art.title + ("\\tnoteref{t1}" if art.general_notes else "") + "}\n" + ("\\tnotetext[t1]{" + " ".join(art.general_notes) + "}\n" if art.general_notes else "") + "\n")
    corr_n = 0
    for a in art.authors:
        labels = ",".join(str(x) for x in nums(a, mp))
        name = a.name
        extra = ""
        if a.corresponding:
            corr_n += 1
            if cas:
                extra += "\\cormark[%d]\n" % 1
            else:
                name += "\\corref{cor1}"
        if cas:
            opt = "[orcid=%s]" % a.orcid if a.orcid else ""
            out.append("\\author[" + labels + "]{" + name + "}" + opt + "\n" + extra)
        else:
            out.append("\\author[" + labels + "]{" + name + "}\n")
        if a.email:
            out.append("\\ead{" + a.email + "}\n")
    out.append("\n")
    for k, af in enumerate(affs, 1):
        if cas or T.feats.get("affil_kv") or not T.feats.get("els_address"):
            # elsarticle neumí LaTeXové akcenty uvnitř key=value → převedeme na Unicode
            out.append("\\affiliation[" + str(k) + "]{organization={" + latex_to_unicode(af) + "}}\n")
        else:
            out.append("\\address[" + str(k) + "]{" + af + "}\n")
    if corr_n:
        out.append("\n\\cortext[" + ("1" if cas else "cor1") + "]{Corresponding author}\n")
    for i, n in enumerate([n for a in art.authors for n in a.notes] + art.general_notes, 1):
        out.append("\\nonumnote{" + n + "}\n" if cas else "")
    out.append("\n" + abstract_block(art))
    if art.highlights and T.feats.get("highlights"):
        out.append("\n\\begin{highlights}\n" + "".join("\\item " + h + "\n" for h in art.highlights) + "\\end{highlights}\n")
    if art.keywords:
        env = "keywords" if cas else "keyword"
        out.append("\n\\begin{" + env + "}\n" + " \\sep ".join(art.keywords) + "\n\\end{" + env + "}\n")
    if cas:
        out.append("\n\\maketitle\n")
    else:
        out.append("\n\\end{frontmatter}\n")
    return {"preamble": "", "front": "".join(out)}


def _short_authors(art: Article):
    if not art.authors:
        return ""
    fam = [a.split_name()[1] for a in art.authors]
    if len(fam) == 1:
        return fam[0]
    if len(fam) == 2:
        return fam[0] + " and " + fam[1]
    return fam[0] + " et al."


def gen_ieee(art: Article, T: Template):
    affs, mp = used_affs(art)
    out = ["\\title{" + art.title + (_title_notes(art) if T.feats.get("ieee_conference") else "") + "}\n\n"]
    if T.feats.get("ieee_conference"):
        blocks = []
        for a in art.authors:
            lines = [art.affiliations[i] for i in a.affs if 0 <= i < len(art.affiliations)]
            # afiliaci rozdělíme na řádky podle čárek (oddělení, instituce, město)
            alines = []
            for l in lines:
                parts = [p.strip() for p in l.split(",") if p.strip()]
                if len(parts) > 2:
                    alines += ["\\textit{" + parts[0] + "}", ", ".join(parts[1:-1]), parts[-1]]
                else:
                    alines.append(l)
            if a.email:
                alines.append(a.email)
            if a.orcid:
                alines.append("ORCID: " + a.orcid)
            name = a.name + ("\\IEEEauthorrefmark{1}" if False else "")
            blocks.append("\\IEEEauthorblockN{" + name + "}\n\\IEEEauthorblockA{" + "\\\\\n".join(alines) + "}")
        out.append("\\author{" + "\n\\and\n".join(blocks) + "}\n\n")
    else:
        names = [a.name for a in art.authors]
        auth = ", ".join(names[:-1]) + (", and " if len(names) > 2 else " and ") + names[-1] if len(names) > 1 else (names[0] if names else "")
        thanks = []
        for a in art.authors:
            aff = "; ".join(art.affiliations[i] for i in a.affs if 0 <= i < len(art.affiliations))
            if aff or a.email:
                s = a.name + (" is with " + aff if aff else "")
                if a.email:
                    s += " (e-mail: " + a.email + ")"
                if a.corresponding:
                    s += ". Corresponding author"
                thanks.append(s + ".")
            thanks += a.notes
        thanks += art.general_notes
        out.append("\\author{" + auth + "%\n" + "".join("\\thanks{" + t + "}%\n" for t in thanks) + "}\n\n")
    out.append("\\maketitle\n\n")
    out.append(abstract_block(art))
    out.append(keywords_block(art, "env:IEEEkeywords"))
    return {"preamble": "", "front": "".join(out)}


def gen_revtex(art: Article, T: Template):
    out = ["\\title{" + art.title + _title_notes(art) + "}\n\n"]
    for a in art.authors:
        out.append("\\author{" + a.name + "}\n")
        if a.email:
            out.append("\\email{" + a.email + "}\n")
        if a.orcid:
            out.append("% ORCID: " + a.orcid + "\n")
        for n in a.notes:
            out.append("\\thanks{" + n + "}\n")
        for i in a.affs:
            if 0 <= i < len(art.affiliations):
                out.append("\\affiliation{" + art.affiliations[i] + "}\n")
    out.append("\n\\date{\\today}\n\n")
    out.append(abstract_block(art))
    if art.keywords:
        out.append("\\keywords{" + ", ".join(art.keywords) + "}\n")
    out.append("\n\\maketitle\n")
    return {"preamble": "", "front": "".join(out)}


def _acm_affiliation(text: str):
    """Volný text afiliace → \\institution / \\city / \\postcode / \\country (acmart vyžaduje zemi)."""
    parts = [p.strip() for p in text.split(",") if p.strip()]
    if len(parts) < 2:
        return "\\institution{" + text + "}\n  \\country{}"
    country = parts[-1]
    rest = parts[:-1]
    postcodes = [p for p in rest if re.fullmatch(r"[\d\s\-A-Z]{3,10}", p) and re.search(r"\d", p)]
    rest = [p for p in rest if p not in postcodes]
    city = ""
    if len(rest) >= 2:
        city = rest[-1]
        rest = rest[:-1]
    s = "\\institution{" + ", ".join(rest) + "}"
    if city:
        s += "\n  \\city{" + city + "}"
    if postcodes:
        s += "\n  \\postcode{" + postcodes[0] + "}"
    return s + "\n  \\country{" + country + "}"


def gen_acmart(art: Article, T: Template):
    out = ["\\title{" + art.title + "}\n" + _title_notes(art) + "\n\n"]
    for a in art.authors:
        out.append("\\author{" + a.name + "}\n")
        for n in a.notes:
            out.append("\\authornote{" + n + "}\n")
        if a.email:
            out.append("\\email{" + a.email + "}\n")
        if a.orcid:
            out.append("\\orcid{" + a.orcid + "}\n")
        for i in a.affs:
            if 0 <= i < len(art.affiliations):
                out.append("\\affiliation{%\n  " + _acm_affiliation(art.affiliations[i]) + "\n}\n")
        out.append("\n")
    out.append("\\renewcommand{\\shortauthors}{" + _short_authors(art) + "}\n\n")
    out.append(abstract_block(art))
    if art.keywords:
        out.append("\n\\keywords{" + ", ".join(art.keywords) + "}\n")
    out.append("\n\\maketitle\n")
    return {"preamble": "", "front": "".join(out)}


def gen_llncs(art: Article, T: Template):
    affs, mp = used_affs(art)
    title = "\\title{" + art.title + _title_notes(art) + "}\n"
    if art.short_title:
        title += "\\titlerunning{" + art.short_title + "}\n"
    names = []
    for a in art.authors:
        n = a.name
        ns = nums(a, mp)
        if ns and len(affs) > 1:
            n += "\\inst{" + ",".join(str(x) for x in ns) + "}"
        if a.orcid:
            n += "\\orcidID{" + a.orcid + "}"
        n += "".join("\\thanks{" + t + "}" for t in a.notes)
        names.append(n)
    inst = []
    for k, af in enumerate(affs, 1):
        emails = [a.email for a in art.authors if a.email and a.affs and mp.get(a.affs[0]) == k]
        s = af
        if emails:
            s += "\\\\\n\\email{" + ", ".join(emails) + "}"
        inst.append(s)
    out = [title + "\n", "\\author{" + " \\and\n".join(names) + "}\n",
           "\\authorrunning{" + _short_authors(art) + "}\n",
           "\\institute{" + " \\and\n".join(inst) + "}\n\n", "\\maketitle\n\n"]
    ab = art.abstract.strip()
    if ab or art.keywords:
        out.append("\\begin{abstract}\n" + ab + "\n")
        if art.keywords:
            out.append("\n\\keywords{" + " \\and ".join(art.keywords) + "}\n")
        out.append("\\end{abstract}\n")
    return {"preamble": "", "front": "".join(out)}


def gen_svjour(art: Article, T: Template):
    affs, mp = used_affs(art)
    out = ["\\title{" + art.title + _title_notes(art) + "}\n\n"]
    out.append("\\author{" + " \\and ".join(a.name + "".join("\\thanks{" + t + "}" for t in a.notes) for a in art.authors) + "}\n\n")
    inst = []
    for a in art.authors:
        aff = ", ".join(art.affiliations[i] for i in a.affs if 0 <= i < len(art.affiliations))
        s = a.name + " \\at " + aff
        if a.email:
            s += " \\\\\n\\email{" + a.email + "}"
        inst.append(s)
    out.append("\\institute{" + " \\and\n".join(inst) + "}\n\n")
    out.append("\\date{Received: date / Accepted: date}\n\n\\maketitle\n\n")
    out.append("\\begin{abstract}\n" + art.abstract.strip() + "\n")
    if art.keywords:
        out.append("\\keywords{" + " \\and ".join(art.keywords) + "}\n")
    out.append("\\end{abstract}\n")
    return {"preamble": "", "front": "".join(out)}


def gen_snjnl(art: Article, T: Template):
    affs, mp = used_affs(art)
    out = []
    out.append("\\title" + ("[" + art.short_title + "]" if art.short_title else "") + "{" + art.title + "}\n\n")
    corr_affs = set()
    for a in art.authors:
        g, f = a.split_name()
        labels = ",".join(str(x) for x in nums(a, mp))
        star = "*" if a.corresponding else ""
        if a.corresponding and nums(a, mp):
            corr_affs.add(nums(a, mp)[0])
        name = ("\\fnm{" + g + "} " if g else "") + "\\sur{" + f + "}"
        out.append("\\author" + star + "[" + labels + "]{" + name + "}")
        if a.email:
            out.append("\\email{" + a.email + "}")
        out.append("\n")
    out.append("\n")
    for k, af in enumerate(affs, 1):
        star = "*" if k in corr_affs and k == min(corr_affs) else ""
        out.append("\\affil" + star + "[" + str(k) + "]{\\orgname{" + af + "}}\n")
    out.append("\n" + abstract_block(art, cmd=True))
    if art.keywords:
        out.append("\n\\keywords{" + ", ".join(art.keywords) + "}\n")
    out.append("\n\\maketitle\n")
    return {"preamble": "", "front": "".join(out)}


def gen_mdpi(art: Article, T: Template):
    affs, mp = used_affs(art)
    multi = len(affs) > 1
    out = ["\\Title{" + art.title + "}\n\n", "\\TitleCitation{" + art.title + "}\n\n"]
    letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    names = []
    orcids = []
    for k, a in enumerate(art.authors):
        marks = [str(x) for x in nums(a, mp)] if multi else []
        sup = ""
        if marks and a.corresponding:
            sup = " $^{" + ",".join(marks) + ",}$*"
        elif marks:
            sup = " $^{" + ",".join(marks) + "}$"
        elif a.corresponding:
            sup = " $^{*}$"
        orc = ""
        if a.orcid and k < len(letters):
            orcids.append("\\providecommand{\\orcidauthor%s}{}\\renewcommand{\\orcidauthor%s}{%s}\n" % (letters[k], letters[k], a.orcid))
            orc = "\\orcid" + letters[k] + "{}"
        names.append(a.name + sup + orc)
    joined = ", ".join(names[:-1]) + " and " + names[-1] if len(names) > 1 else (names[0] if names else "")
    out = orcids + out
    out.append("\\Author{" + joined + "}\n\n")
    plain = [a.name for a in art.authors]
    out.append("\\AuthorNames{" + (", ".join(plain[:-1]) + " and " + plain[-1] if len(plain) > 1 else "".join(plain)) + "}\n\n")
    if T.feats.get("authorcitation"):
        cit = []
        for a in art.authors:
            ini, fam = a.initials()
            cit.append(fam + ", " + ini if ini else fam)
        out.append("\\AuthorCitation{" + "; ".join(cit) + "}\n\n")
    if multi:
        out.append("\\address{%\n" + "\\\\\n".join("$^{%d}$ \\quad %s" % (k, af) for k, af in enumerate(affs, 1)) + "}\n\n")
    elif affs:
        out.append("\\address{%\n" + affs[0] + "}\n\n")
    corr = [a for a in art.authors if a.corresponding and a.email]
    if corr:
        out.append("\\corres{Correspondence: " + "; ".join(a.email for a in corr) + "}\n\n")
    elif art.correspondence:
        out.append("\\corres{" + art.correspondence + "}\n\n")
    out.append("\\abstract{" + art.abstract.strip() + "}\n\n")
    if art.keywords:
        out.append("\\keyword{" + "; ".join(art.keywords) + "}\n\n")
    return {"preamble": "".join(out), "front": ""}


GENERATORS = {
    "generic": gen_generic, "amsart": gen_amsart, "elsarticle": gen_elsarticle,
    "cas": lambda a, t: gen_elsarticle(a, t, cas=True), "ieee": gen_ieee, "revtex": gen_revtex,
    "acmart": gen_acmart, "llncs": gen_llncs, "svjour": gen_svjour, "snjnl": gen_snjnl, "mdpi": gen_mdpi,
}

MDPI_DECL_CMD = {
    "Author Contributions": "authorcontributions", "Funding": "funding",
    "Institutional Review Board Statement": "institutionalreview", "Informed Consent Statement": "informedconsent",
    "Data Availability Statement": "dataavailability", "Conflicts of Interest": "conflictsofinterest",
    "Sample Availability": "sampleavailability", "Supplementary Materials": "supplementary",
    "Disclaimer": "disclaimer",
}


def back_matter(art: Article, T: Template) -> str:
    """Poděkování a prohlášení ve formátu cílové třídy."""
    out = []
    ack = art.acknowledgments.strip()
    fam = T.family
    decl = dict(art.declarations)
    if fam in ("mdpi", "snjnl") and art.general_notes and "Funding" not in decl:
        decl["Funding"] = " ".join(art.general_notes)
    if fam == "mdpi":
        out.append("\\vspace{6pt}\n")
        for title, txt in decl.items():
            cmd = MDPI_DECL_CMD.get(title)
            if title == "Abbreviations":
                if T.feats.get("abbrev2"):
                    out.append("\\abbreviations{Abbreviations}{" + txt + "}\n")
                else:
                    out.append("\\abbreviations{" + txt + "}\n")
            elif cmd:
                out.append("\\" + cmd + "{" + txt + "}\n")
            else:
                out.append("\\section*{" + title + "}\n" + txt + "\n")
        if ack:
            out.append("\\acknowledgments{" + ack + "}\n")
        missing = [t for t in ("Author Contributions", "Funding", "Conflicts of Interest") if t not in decl]
        for t in missing:
            out.append("%\\" + MDPI_DECL_CMD[t] + "{DOPLŇTE}  % MDPI tuto sekci obvykle vyžaduje\n")
        return "".join(out)
    if ack:
        if fam == "revtex":
            out.append("\\begin{acknowledgments}\n" + ack + "\n\\end{acknowledgments}\n")
        elif fam == "acmart":
            out.append("\\begin{acks}\n" + ack + "\n\\end{acks}\n")
        elif fam == "snjnl":
            out.append("\\bmhead{Acknowledgements}\n\n" + ack + "\n")
        elif fam == "llncs":
            if T.feats.get("credits_env"):
                out.append("\\begin{credits}\n\\subsubsection{\\ackname} " + ack + "\n\\end{credits}\n")
            else:
                out.append("\\subsubsection*{Acknowledgements}\n" + ack + "\n")
        elif fam == "ieee":
            out.append("\\section*{Acknowledgment}\n" + ack + "\n")
        else:
            out.append("\\section*{Acknowledgments}\n" + ack + "\n")
    for title, txt in decl.items():
        head = "\\bmhead{" + title + "}\n" if fam == "snjnl" else "\\section*{" + title + "}\n"
        out.append("\n" + head + txt + "\n")
    return "".join(out)


def bib_block(art: Article, T: Template, bib_names) -> str:
    if art.bib_kind == "thebibliography":
        core = art.thebibliography.strip() + "\n"
    elif art.bib_kind in ("bibtex", "biblatex") and bib_names:
        if T.bib_system == "biblatex":
            core = "\\printbibliography\n"
        else:
            core = ""
            if T.bib_style:
                core += "\\bibliographystyle{" + T.bib_style + "}\n"
            core += "\\bibliography{" + ",".join(bib_names) + "}\n"
    else:
        core = ""
    if T.family == "mdpi":
        inner = ("\\reftitle{References}\n" if T.feats.get("reftitle") or True else "") + core
        if T.feats.get("publishersnote"):
            inner += "\n\\PublishersNote{}\n"
        if T.feats.get("extralength"):
            return "\\begin{adjustwidth}{-\\extralength}{0cm}\n" + inner + "\\end{adjustwidth}\n"
        return inner
    return core
