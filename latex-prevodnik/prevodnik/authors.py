"""Rozpoznání autorů a afiliací z nejrůznějších stylů zápisu.

Podporované zápisy:
  * standardní \\author{A \\and B} (article, amsart, svjour3, IEEE journal)
  * authblk / Springer Nature / Elsevier: \\author[1,2]{..} + \\affil[1]{..}
  * sekvenční: \\author{..}\\affiliation{..}\\email{..} (REVTeX, ACM, amsart, elsarticle bez štítků)
  * IEEE konference: \\IEEEauthorblockN{..}\\IEEEauthorblockA{..}
  * LNCS: \\author{A\\inst{1}} + \\institute{.. \\and ..}
  * MDPI: \\Author{A $^{1}$, B $^{2,}$*} + \\address{..} + \\corres{..}
"""

from __future__ import annotations

import re

from .model import Author
from .texparse import EMAIL_RE, Doc, apply_edits, find_commands, mask, split_top, squash, unwrap_cmd

AFF_PART_CMDS = ["orgdiv", "orgname", "orgaddress", "street", "city", "postcode", "state", "country",
                 "institution", "department", "streetaddress", "postcode", "addressline", "authornote"]
FORMAT_CMDS = ["textit", "textbf", "emph", "textrm", "textsf", "textup", "textnormal", "mbox", "small",
               "footnotesize", "normalsize", "itshape", "upshape"]


def _norm_space(s: str) -> str:
    s = re.sub(r"\\(quad|qquad|newline|par|hfill|noindent|medskip|smallskip|bigskip)(?![a-zA-Z])", " ", s)
    s = re.sub(r"\\[,;: ]", " ", s)
    return squash(s)


def _strip_braces(s: str) -> str:
    s = s.strip()
    while s.startswith("{") and s.endswith("}"):
        # jen pokud jsou vnější závorky párové
        from .texparse import find_matching

        if find_matching(s, 0) == len(s):
            s = s[1:-1].strip()
        else:
            break
    return s


def expand_brace_emails(t: str) -> str:
    """LNCS zápis \\{abc,lncs\\}@uni.de → abc@uni.de, lncs@uni.de"""
    def rep(m):
        users = [u.strip() for u in m.group(1).split(",") if u.strip()]
        return ", ".join(u + "@" + m.group(2) for u in users)
    return re.sub(r"\\\{([^{}]*?)\\\}@([A-Za-z0-9.\-]+)", rep, t)


def fold(s: str) -> str:
    """Jméno/e-mail bez diakritiky a LaTeXových akcentů, malými písmeny."""
    import unicodedata

    s = latex_to_unicode(s)
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if c.isalpha()).lower()


ACCENTS = {"'": "\u0301", "`": "\u0300", "^": "\u0302", '"': "\u0308", "~": "\u0303", "=": "\u0304",
           ".": "\u0307", "u": "\u0306", "v": "\u030c", "H": "\u030b", "c": "\u0327", "k": "\u0328",
           "r": "\u030a", "d": "\u0323", "b": "\u0331"}
SPECIAL = {"ss": "ß", "o": "ø", "O": "Ø", "aa": "å", "AA": "Å", "l": "ł", "L": "Ł", "ae": "æ", "AE": "Æ",
           "oe": "œ", "OE": "Œ", "i": "ı", "j": "ȷ"}


def latex_to_unicode(s: str) -> str:
    """Převede LaTeXové akcenty (\\'a, \\v{c}, {\\"o} …) na znaky Unicode."""
    import unicodedata

    def acc(m):
        cmd, ch = m.group(1), m.group(2)
        if ch in ("\\i", "\\j"):
            ch = ch[1]
        return unicodedata.normalize("NFC", ch + ACCENTS[cmd])

    for _ in range(2):
        s = re.sub(r"\{\\(['`^\"~=.])\s*\{?(\\[ij]|[A-Za-z])\}?\}", acc, s)
        s = re.sub(r"\\(['`^\"~=.])\s*\{?(\\[ij]|[A-Za-z])\}?", acc, s)
        s = re.sub(r"\{?\\([uvHckrdb])\s*\{(\\[ij]|[A-Za-z])\}\}?", acc, s)
        s = re.sub(r"\{?\\([uvHckrdb])\s+([A-Za-z])\}?", acc, s)
    s = re.sub(r"\{\\(ss|aa|AA|ae|AE|oe|OE|o|O|l|L)\}", lambda m: SPECIAL[m.group(1)], s)
    s = re.sub(r"\\(ss|aa|AA|ae|AE|oe|OE|o|O|l|L)(?![a-zA-Z])\s?", lambda m: SPECIAL[m.group(1)], s)
    return s


def flatten_affiliation(text: str):
    """Převede afiliaci do jednoho řádku textu. Vrací (text, [e-maily])."""
    t = expand_brace_emails(text)
    emails = []
    # e-maily uvnitř afiliace (\email{..}, \texttt{..@..}, mailto)
    d = Doc(t)
    edits = []
    for nm in ("email", "ead", "texttt", "href", "url"):
        for c in d.cmds(nm, "om" if nm != "href" else "mm"):
            arg = " ".join(c.args)
            found = EMAIL_RE.findall(arg)
            if found:
                emails += found
                edits.append((c.start, c.end, ""))
    t = apply_edits(t, edits)
    for e in EMAIL_RE.findall(t):
        emails.append(e)
    t = EMAIL_RE.sub("", t)
    t = re.sub(r"\{[\s,;]*\}", "", t)
    t = re.sub(r"\(?\s*e-?mail\s*:?\s*[\s,;]*\)?", " ", t, flags=re.I)
    t = re.sub(r"\\(?:email|ead)\s*(\{\s*\})?", " ", t)
    # Elsevier key=value: organization={..}, city={..}
    if re.search(r"\b(organization|addressline|city|postcode|state|country)\s*=", t):
        parts = []
        for kv in split_top(t, r","):
            if "=" in kv:
                k, v = kv.split("=", 1)
                v = _strip_braces(v)
                if v:
                    parts.append(v)
            elif kv.strip():
                parts.append(kv.strip())
        t = ", ".join(parts)
    # strukturované příkazy (\orgname{..}, \institution{..}) → text oddělený čárkami
    sep = "\x00"
    for _ in range(4):
        d = Doc(t)
        edits = []
        for nm in AFF_PART_CMDS:
            for c in d.cmds(nm, "om"):
                edits.append((c.start, c.end, sep + (c.args[0] if c.args else "") + sep))
        if not edits:
            break
        t = apply_edits(t, edits)
    t = unwrap_cmd(t, FORMAT_CMDS)
    t = re.sub(r"\\\\(\[[^\]]*\])?", sep, t)
    t = re.sub(r"\$\s*\^\{?[^$]*\}?\s*\$", " ", t)  # $^{1}$ na začátku
    t = re.sub(r"\\textsuperscript\{[^}]*\}", " ", t)
    t = re.sub(r"\\IEEEauthorrefmark\{[^}]*\}", " ", t)
    t = _norm_space(t)
    pieces = [p.strip(" ,;") for p in t.split(sep)]
    t = ", ".join(p for p in pieces if p)
    t = re.sub(r"\s*,\s*(,\s*)+", ", ", t)
    t = re.sub(r"\s+,", ",", t)
    return t.strip(" ,;."), emails


def clean_name(raw: str):
    """Vyčistí jméno autora. Vrací (jméno, given, family, poznámky, e-maily, orcid, příznak *)."""
    t = re.sub(r"^\s*\d+\s*(\\textsuperscript\s*\{\s*(st|nd|rd|th)\s*\}|(st|nd|rd|th)(?![a-z]))\s*", "", raw)
    notes, emails = [], []
    orcid = ""
    corresponding = False
    d = Doc(t)
    edits = []
    for nm in ("thanks", "footnote"):
        for c in d.cmds(nm, "om"):
            n = squash(c.args[0])
            if n:
                notes.append(n)
                emails += EMAIL_RE.findall(n)
                if re.search(r"correspond", n, re.I):
                    corresponding = True
            edits.append((c.start, c.end, ""))
    for nm in ("orcidID", "orcid", "orcidlink"):
        for c in d.cmds(nm, "om"):
            m = re.search(r"\d{4}-\d{4}-\d{4}-\d{3}[\dX]", c.args[0])
            if m:
                orcid = m.group(0)
            edits.append((c.start, c.end, ""))
    for nm, spec in (("inst", "m"), ("IEEEmembership", "m"), ("IEEEauthorrefmark", "m"), ("corref", "m"),
                     ("fnref", "m"), ("tnoteref", "m"), ("textsuperscript", "m"), ("equalcont", "m"),
                     ("email", "om"), ("footnotemark", "o"), ("cormark", "o"), ("fnmark", "o"),
                     ("affilmark", "m"), ("authormark", "m"), ("at", ""), ("and", ""), ("protect", ""),
                     ("correspondingauthor", ""), ("Letter", "")):
        for c in d.cmds(nm, spec):
            if nm == "corref" or nm == "cormark":
                corresponding = True
            if nm == "email":
                emails += EMAIL_RE.findall(" ".join(c.args))
            edits.append((c.start, c.end, ""))
    for c in d.cmds("href", "mm"):
        edits.append((c.start, c.end, c.args[1]))
    t = apply_edits(t, edits)
    t = re.sub(r"\\orcid[A-Z]\s*(\{\s*\})?", "", t)
    if re.search(r"\$\s*\^\{?[^$]*\*", t) or re.search(r"\*\s*$", t):
        corresponding = True
    t = re.sub(r"\$[^$]*\$", "", t)
    t = re.sub(r"^\s*\d+\s*(st|nd|rd|th)\s*", "", t)  # „1\textsuperscript{st}“ v IEEE
    given = family = ""
    dd = Doc(t)
    fn = dd.cmds("fnm", "m")
    sn = dd.cmds("sur", "m")
    if fn or sn:
        given = squash(" ".join(c.args[0] for c in fn))
        family = squash(" ".join(c.args[0] for c in sn))
        t = unwrap_cmd(t, ["fnm", "sur", "spfx", "dgr", "sfx", "pfx"])
    t = unwrap_cmd(t, FORMAT_CMDS)
    t = t.replace("*", "")
    t = squash(t).strip(" ,;")
    return t, given, family, notes, emails, orcid, corresponding


def _labels(s: str):
    return [x.strip() for x in re.split(r"[,;]", s or "") if x.strip()]


class _Builder:
    def __init__(self):
        self.authors: list[Author] = []
        self.affs: list[str] = []
        self.emails_unassigned: list[str] = []
        self.aff_emails: dict = {}

    def aff_index(self, text: str) -> int:
        flat, emails = flatten_affiliation(text)
        self.emails_unassigned += emails
        if not flat:
            return -1
        if flat in self.affs:
            idx = self.affs.index(flat)
        else:
            self.affs.append(flat)
            idx = len(self.affs) - 1
        self.aff_emails.setdefault(idx, []).extend(emails)
        return idx

    def add_author(self, raw: str) -> Author | None:
        name, given, family, notes, emails, orcid, corr = clean_name(raw)
        if not name:
            return None
        a = Author(name=name, given=given, family=family, orcid=orcid, corresponding=corr)
        real_notes = []
        for n in notes:
            if EMAIL_RE.fullmatch(n.strip()) or re.fullmatch(r"(e-?mail|corresponding author)\s*:?\s*\S+@\S+", n, re.I):
                continue
            real_notes.append(n)
        a.notes = real_notes
        if emails:
            a.email = emails[0]
        self.authors.append(a)
        return a


# ---------------------------------------------------------------------------
# jednotlivé parsery


def parse_mdpi(F: Doc, B: _Builder, preamble: str):
    au = F.cmds("Author", "m")[0].args[0]
    orcids = dict(re.findall(r"\\newcommand\{?\\orcidauthor([A-Z])\}?\{([^}]*)\}", preamble))
    for piece in split_top(au, re.compile(r"\s*,\s*|\s+and\s+|\\and(?![a-zA-Z])")):
        piece = piece.strip()
        if not piece:
            continue
        sup = re.findall(r"\$\s*\^\{?([^$}]*)\}?\s*\$", piece)
        letter = re.search(r"\\orcid([A-Z])", piece)
        a = B.add_author(piece)
        if not a:
            continue
        nums = []
        for s in sup:
            nums += [x.strip() for x in s.split(",") if x.strip().isdigit()]
        a._labels = nums or ["1"]
        if letter and letter.group(1) in orcids:
            m = re.search(r"\d{4}-\d{4}-\d{4}-\d{3}[\dX]", orcids[letter.group(1)])
            if m:
                a.orcid = m.group(0)
    labels = {}
    ad = F.cmds("address", "om")
    if ad:
        for line in split_top(ad[0].args[0], re.compile(r"\\\\(\[[^\]]*\])?")):
            if not line.strip():
                continue
            m = re.match(r"\s*\$\s*\^\{?(\d+)\}?\s*\$\s*(.*)", line, re.S)
            if m:
                labels[m.group(1)] = B.aff_index(m.group(2))
            else:
                labels.setdefault("1", B.aff_index(line))
    for a in B.authors:
        a.affs = [labels[l] for l in getattr(a, "_labels", []) if l in labels and labels[l] >= 0]
    corr = F.cmds("corres", "m")
    text = ""
    if corr:
        text = squash(corr[0].args[0])
        emails = EMAIL_RE.findall(text)
        cs = [a for a in B.authors if a.corresponding] or B.authors[:1]
        for a, e in zip(cs, emails):
            a.email = e
    return text


def parse_ieee_blocks(F: Doc, B: _Builder, au_text: str):
    d = Doc(au_text)
    names = d.cmds("IEEEauthorblockN", "m")
    blocks = d.cmds("IEEEauthorblockA", "m")
    for i, n in enumerate(names):
        nxt = names[i + 1].start if i + 1 < len(names) else len(au_text)
        aff_blocks = [b for b in blocks if n.end <= b.start < nxt]
        group = []
        refmarks = {}
        for piece in split_top(n.args[0], re.compile(r"\s*,\s*|\s+and\s+|\\and(?![a-zA-Z])|\\\\")):
            if not piece.strip():
                continue
            marks = re.findall(r"\\IEEEauthorrefmark\{([^}]*)\}", piece)
            a = B.add_author(piece)
            if a:
                group.append(a)
                refmarks[id(a)] = [m.strip() for mk in marks for m in mk.split(",")]
        for ab in aff_blocks:
            txt = ab.args[0]
            if "\\IEEEauthorrefmark" in txt:
                parts = re.split(r"\\IEEEauthorrefmark\{([^}]*)\}", txt)
                mapping = {}
                for k in range(1, len(parts), 2):
                    mapping[parts[k].strip()] = B.aff_index(parts[k + 1])
                for a in group:
                    a.affs += [mapping[m] for m in refmarks.get(id(a), []) if mapping.get(m, -1) >= 0]
            else:
                before = len(B.emails_unassigned)
                idx = B.aff_index(txt)
                emails = B.emails_unassigned[before:]
                del B.emails_unassigned[before:]
                for a in group:
                    if idx >= 0:
                        a.affs.append(idx)
                for a, e in zip(group, emails):
                    if not a.email:
                        a.email = e
                B.emails_unassigned += emails[len(group):]


def parse_llncs(F: Doc, B: _Builder, au_text: str):
    names = split_top(au_text, re.compile(r"\\and(?![a-zA-Z])"))
    labels_of = []
    for piece in names:
        insts = re.findall(r"\\inst\{([^}]*)\}", piece)
        a = B.add_author(piece)
        if a:
            labels_of.append((a, [l for s in insts for l in _labels(s)]))
    inst = F.cmds("institute", "m")
    entries = split_top(inst[0].args[0], re.compile(r"\\and(?![a-zA-Z])")) if inst else []
    if entries and any("\\at" in e for e in entries):
        # svjour3: \institute{Jméno \at Afiliace \and ...}
        for k, e in enumerate(entries):
            name_part, _, aff_part = e.partition("\\at")
            before = len(B.emails_unassigned)
            idx = B.aff_index(aff_part)
            emails = B.emails_unassigned[before:]
            target = None
            nm = squash(name_part)
            for a in B.authors:
                if a.name and (a.name in nm or nm in a.name):
                    target = a
                    break
            if target is None and k < len(B.authors):
                target = B.authors[k]
            if target is not None:
                if idx >= 0:
                    target.affs.append(idx)
                if emails and not target.email:
                    target.email = emails[0]
                    B.emails_unassigned.remove(emails[0])
        return
    idx_of = {}
    per_inst_emails = {}
    for k, e in enumerate(entries, start=1):
        before = len(B.emails_unassigned)
        idx_of[str(k)] = B.aff_index(e)
        per_inst_emails[str(k)] = B.emails_unassigned[before:]
    for a, labs in labels_of:
        if not labs and len(entries) == 1:
            labs = ["1"]
        if not labs and len(entries) == len(labels_of):
            labs = [str(labels_of.index((a, labs)) + 1)]
        a.affs = [idx_of[l] for l in labs if idx_of.get(l, -1) >= 0]
    # e-maily: pokud v instituci sedí počet e-mailů na počet autorů, přiřaď popořadě
    for k, emails in per_inst_emails.items():
        group = [a for a, labs in labels_of if labs and labs[0] == k]
        if emails and len(emails) == len(group):
            for a, e in zip(group, emails):
                a.email = e
                B.emails_unassigned.remove(e)
    if B.emails_unassigned and len(B.emails_unassigned) == len(B.authors):
        for a, e in zip(B.authors, list(B.emails_unassigned)):
            a.email = a.email or e
        B.emails_unassigned = []


SEQ_AUTHOR = re.compile(r"\\author(?![a-zA-Z@])")
SEQ_TOKENS = {
    "author": "som",  # elsarticle/authblk/Springer: \author*[1,2]{..}
    "affil": "som",
    "affiliation": "som",
    "address": "som",
    "institution": "m",
    "email": "om",
    "ead": "om",
    "orcid": "m",
    "altaffiliation": "om",
    "cormark": "o",
    "cortext": "om",
    "fntext": "om",
    "curraddr": "om",
    "thanks": "om",
}


def parse_sequential(F: Doc, B: _Builder):
    """\\author / \\affil / \\email v libovolném pořadí, se štítky i bez nich."""
    events = []
    for nm, spec in SEQ_TOKENS.items():
        for c in F.cmds(nm, spec):
            events.append(c)
    events.sort(key=lambda c: c.start)
    # \thanks uvnitř \author se zpracuje v clean_name — vyhoď vnořené události
    top = []
    for c in events:
        if any(o.start < c.start < o.end for o in events if o is not c):
            continue
        top.append(c)
    labelled_affs = {}
    pending_labels = []  # (autor, [štítky])
    group: list[Author] = []
    group_closed = False
    cortexts = {}
    last = None
    for c in top:
        if c.name == "author":
            raw = c.args[0] if c.args else ""
            # CAS: \author[1]{Jméno}[orcid=...]
            tail = F.text[c.end : c.end + 200]
            mt = re.match(r"\s*\[([^\]]*)\]", tail)
            if mt and "orcid" in mt.group(1).lower():
                raw += "\\orcid{" + mt.group(1) + "}"
            a = B.add_author(raw)
            if not a:
                continue
            if c.star:
                a.corresponding = True
            if c.opts:
                pending_labels.append((a, _labels(c.opts[0])))
            if group_closed:
                group = []
                group_closed = False
            group.append(a)
            last = a
        elif c.name in ("affil", "affiliation", "address", "institution"):
            if c.name == "address" and not c.args:
                continue
            body = c.args[0] if c.args else ""
            if c.opts and c.name != "institution":
                for lab in _labels(c.opts[0]):
                    labelled_affs[lab] = B.aff_index(body)
                group_closed = True
                continue
            idx = B.aff_index(body)
            if idx >= 0:
                for a in group:
                    if idx not in a.affs:
                        a.affs.append(idx)
            group_closed = True
        elif c.name in ("email", "ead"):
            if c.name == "ead" and c.opts and c.opts[0].strip().lower() == "url":
                continue
            emails = EMAIL_RE.findall(c.args[0] if c.args else "")
            if last and emails and not last.email:
                last.email = emails[0]
            elif emails:
                B.emails_unassigned += emails
        elif c.name == "orcid" and last:
            m = re.search(r"\d{4}-\d{4}-\d{4}-\d{3}[\dX]", c.args[0])
            if m:
                last.orcid = m.group(0)
        elif c.name == "cormark" and last:
            last.corresponding = True
        elif c.name == "cortext":
            cortexts[c.opts[0] if c.opts else ""] = c.args[0]
        elif c.name == "thanks" and last:
            last.notes.append(squash(c.args[0]))
    for a, labs in pending_labels:
        for lab in labs:
            idx = labelled_affs.get(lab)
            if idx is not None and idx >= 0 and idx not in a.affs:
                a.affs.append(idx)
    # authblk: \affil bez štítku se vztahuje ke všem autorům (pokud jediný)
    if not any(a.affs for a in B.authors) and len(B.affs) == 1:
        for a in B.authors:
            a.affs = [0]


def parse_single(F: Doc, B: _Builder, au_text: str):
    """Jediný \\author{...}, autoři odděleni \\and, řádky \\\\, čárkami."""
    d = Doc(au_text)
    if d.search(r"\\and(?![a-zA-Z])"):
        pieces = split_top(au_text, re.compile(r"\\and(?![a-zA-Z])"))
    elif not d.search(r"\\\\"):
        pieces = split_top(au_text, re.compile(r"\s*,\s*(?:and\s+)?|\s+and\s+"))
    else:
        pieces = [au_text]
    for piece in pieces:
        lines = split_top(piece, re.compile(r"\\\\(\[[^\]]*\])?"))
        lines = [l for l in lines if l and l.strip()]
        if not lines:
            continue
        name_line = lines[0]
        # IEEE journal: „A, B, and C\thanks{...}“ v jednom řádku
        sub = split_top(name_line, re.compile(r"\s*,\s*(?:and\s+)?|\s+and\s+")) if len(lines) == 1 and "," in name_line else [name_line]
        group = []
        for s in sub:
            if not s.strip() or re.fullmatch(r"\s*\\IEEEmembership\{[^}]*\}\s*", s):
                continue
            a = B.add_author(s)
            if a:
                group.append(a)
        rest = lines[1:]
        aff_lines, emails = [], []
        for l in rest:
            found = EMAIL_RE.findall(l)
            if found:
                emails += found
                if not EMAIL_RE.sub("", unwrap_cmd(l, ["texttt", "href", "url", "email"] + FORMAT_CMDS)).strip(" ,;:{}\\"):
                    continue
            aff_lines.append(l)
        if aff_lines:
            before = len(B.emails_unassigned)
            idx = B.aff_index("\\\\".join(aff_lines))
            emails += B.emails_unassigned[before:]
            del B.emails_unassigned[before:]
            for a in group:
                if idx >= 0:
                    a.affs.append(idx)
        for a, e in zip(group, emails):
            if not a.email:
                a.email = e
    # IEEE journal: afiliace bývají v \thanks („X is with ...“) — necháme jako poznámky


def assign_leftover_emails(B: _Builder):
    """Nepřiřazené e-maily: podle jména v adrese, pak podle afiliace."""
    left = [e for e in dict.fromkeys(B.emails_unassigned) if e not in {a.email for a in B.authors}]
    if not left:
        B.emails_unassigned = []
        return
    for e in list(left):
        local = fold(e.split("@")[0])
        best = None
        for a in B.authors:
            if a.email:
                continue
            g, f = a.split_name()
            fam, giv = fold(f), fold(g.split()[0] if g.split() else "")
            if (len(fam) >= 3 and fam in local) or (len(giv) >= 3 and local.startswith(giv)):
                best = a
                break
        if best:
            best.email = e
            left.remove(e)
    for idx, emails in B.aff_emails.items():
        free = [e for e in emails if e in left]
        group = [a for a in B.authors if not a.email and idx in a.affs]
        if free and len(free) == len(group):
            for a, e in zip(group, free):
                a.email = e
                left.remove(e)
    B.emails_unassigned = left


def parse_authors(F: Doc, preamble_clean: str):
    """Hlavní vstup. F = Doc s frontmatter textem bez komentářů."""
    B = _Builder()
    correspondence = ""
    notes_general = []
    authors_cmds = F.cmds("author", "som")
    if F.cmds("Author", "m"):
        correspondence = parse_mdpi(F, B, preamble_clean)
        style = "mdpi"
    elif authors_cmds and "\\IEEEauthorblockN" in authors_cmds[0].args[0]:
        parse_ieee_blocks(F, B, authors_cmds[0].args[0])
        style = "ieee-bloky"
    elif authors_cmds and (F.cmds("institute", "m") or "\\inst{" in authors_cmds[0].args[0]):
        parse_llncs(F, B, authors_cmds[0].args[0])
        style = "lncs/svjour"
    elif len(authors_cmds) > 1 or (authors_cmds and (authors_cmds[0].opts or authors_cmds[0].star)) or F.cmds("affil", "om") or F.cmds("affiliation", "om"):
        parse_sequential(F, B)
        style = "sekvenční"
    elif authors_cmds:
        parse_single(F, B, authors_cmds[0].args[0])
        # u standardního zápisu mohou následovat \address/\email (amsart)
        if F.cmds("address", "om") or F.cmds("email", "om"):
            extra = _Builder()
            extra.affs = B.affs
            extra.authors = []
            for c in F.cmds("address", "om"):
                idx = B.aff_index(c.args[0])
                if idx >= 0 and B.authors and idx not in B.authors[-1].affs:
                    # amsart: \address patří autorovi před ním — bez pozic nevíme; dáme všem bez afiliace
                    for a in B.authors:
                        if not a.affs:
                            a.affs.append(idx)
            emails = [e for c in F.cmds("email", "om") for e in EMAIL_RE.findall(c.args[0])]
            for a, e in zip([a for a in B.authors if not a.email], emails):
                a.email = e
        style = "standardní"
    else:
        style = "nenalezeno"
    assign_leftover_emails(B)
    # e-mail, který zbyl, přiřadíme korespondujícímu autorovi
    if B.emails_unassigned:
        cs = [a for a in B.authors if a.corresponding and not a.email]
        for a, e in zip(cs, B.emails_unassigned):
            a.email = e
        rest = [e for e in B.emails_unassigned if e not in [a.email for a in B.authors]]
        if rest:
            notes_general.append("Nepřiřazené e-maily: " + ", ".join(dict.fromkeys(rest)))
    if B.authors and not any(a.corresponding for a in B.authors):
        with_mail = [a for a in B.authors if a.email]
        if len(with_mail) == 1:
            with_mail[0].corresponding = True
    for a in B.authors:
        if hasattr(a, "_labels"):
            del a._labels
    return B.authors, B.affs, style, correspondence, notes_general
