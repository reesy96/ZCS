"""Nízkoúrovňové nástroje pro práci se zdrojovým kódem LaTeXu.

Klíčový trik: ke každému textu si vytváříme „masku“ stejné délky, ve které
jsou komentáře a obsah verbatim prostředí nahrazeny mezerami. Hledání
příkazů probíhá v masce (takže nenajdeme nic, co je zakomentované), ale
výřezy bereme z původního textu (takže zachováme komentáře v těle článku).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

VERBATIM_ENVS = ("verbatim", "verbatim*", "lstlisting", "minted", "comment", "Verbatim", "alltt")

_VERB_RE = re.compile(r"\\verb\*?([^a-zA-Z\s])")


def mask(text: str) -> str:
    """Vrátí text stejné délky, kde komentáře a verbatim obsah jsou mezery."""
    out = list(text)
    n = len(text)
    i = 0
    while i < n:
        c = text[i]
        if c == "\\":
            # \begin{verbatim} ... \end{verbatim}
            if text.startswith("\\begin{", i):
                m = re.match(r"\\begin\{([^}]*)\}", text[i:])
                if m and m.group(1) in VERBATIM_ENVS:
                    env = m.group(1)
                    start = i + m.end()
                    end_tag = "\\end{" + env + "}"
                    j = text.find(end_tag, start)
                    if j < 0:
                        j = n
                    for k in range(start, j):
                        if out[k] != "\n":
                            out[k] = " "
                    i = j + len(end_tag)
                    continue
            m = _VERB_RE.match(text, i)
            if m:
                delim = m.group(1)
                start = m.end()
                j = text.find(delim, start)
                if j < 0:
                    j = n
                for k in range(start, j):
                    out[k] = " "
                i = j + 1
                continue
            i += 2  # přeskočí escapovaný znak (\%, \{, \\ ...)
            continue
        if c == "%":
            j = text.find("\n", i)
            if j < 0:
                j = n
            for k in range(i, j):
                out[k] = " "
            i = j
            continue
        i += 1
    return "".join(out)


def strip_comments(text: str) -> str:
    """Odstraní komentáře (ponechá samotné „%“, aby se nezměnily mezery)."""
    m = mask(text)
    res = []
    for line_t, line_m in zip(text.split("\n"), m.split("\n")):
        if len(line_t) != len(line_m):  # nemělo by nastat
            res.append(line_t)
            continue
        idx = None
        # pozice prvního maskovaného % = tam, kde se maska liší a text má %
        for k, (a, b) in enumerate(zip(line_t, line_m)):
            if a == "%" and b == " ":
                idx = k
                break
        if idx is None:
            res.append(line_t)
        else:
            kept = line_t[:idx]
            if kept.strip() == "":
                res.append(None)  # řádek obsahoval jen komentář
            else:
                res.append(kept + "%")
    return "\n".join(r for r in res if r is not None)


def clean(text: str) -> str:
    """Komentáře pryč, sjednocené mezery, ořez."""
    t = strip_comments(text)
    t = re.sub(r"%\n\s*", "", t)
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def find_matching(text: str, i: int, open_c: str = "{", close_c: str = "}") -> int:
    """`text[i]` je otevírací závorka; vrátí index za odpovídající uzavírací.

    Vrací -1, pokud závorka není uzavřena.
    """
    depth = 0
    n = len(text)
    j = i
    while j < n:
        c = text[j]
        if c == "\\":
            j += 2
            continue
        if open_c != "{" and c == "{":
            k = find_matching(text, j)
            if k < 0:
                return -1
            j = k
            continue
        if c == open_c:
            depth += 1
        elif c == close_c:
            depth -= 1
            if depth == 0:
                return j + 1
        j += 1
    return -1


@dataclass
class Cmd:
    name: str
    start: int
    end: int
    star: bool = False
    opts: list = field(default_factory=list)  # obsah [] argumentů
    args: list = field(default_factory=list)  # obsah {} argumentů
    # pořadí argumentů tak, jak šly za sebou: [("o"|"m", obsah), ...]
    seq: list = field(default_factory=list)


def _skip_ws(m: str, j: int, allow_par: bool = False) -> int:
    n = len(m)
    newlines = 0
    k = j
    while k < n and m[k] in " \t\n\r":
        if m[k] == "\n":
            newlines += 1
            if newlines > 1 and not allow_par:
                return j
        k += 1
    return k


def parse_args(text: str, m: str, pos: int, spec: str):
    """Načte argumenty podle specifikace.

    spec: posloupnost znaků  s = volitelná hvězdička, o = volitelný [..],
    m = povinný {..}, O = libovolný počet volitelných [..].
    Vrací (konec, star, seq) nebo None, pokud povinný argument chybí.
    """
    j = pos
    star = False
    seq = []
    for s in spec:
        if s == "s":
            if j < len(m) and m[j] == "*":
                star = True
                j += 1
            continue
        k = _skip_ws(m, j)
        if s in "oO":
            while k < len(m) and m[k] == "[":
                e = find_matching(m, k, "[", "]")
                if e < 0:
                    break
                seq.append(("o", text[k + 1 : e - 1]))
                j = e
                k = _skip_ws(m, j)
                if s == "o":
                    break
            continue
        if s == "m":
            if k < len(m) and m[k] == "{":
                e = find_matching(m, k)
                if e < 0:
                    return None
                seq.append(("m", text[k + 1 : e - 1]))
                j = e
            elif k < len(m) and m[k] == "\\":
                # argument bez závorek: \cmd\foo
                mm = re.match(r"\\[a-zA-Z@]+|\\.", m[k:])
                seq.append(("m", text[k : k + mm.end()]))
                j = k + mm.end()
            elif k < len(m) and m[k] not in "}]":
                seq.append(("m", text[k]))
                j = k + 1
            else:
                return None
    return j, star, seq


def find_commands(text: str, m: str, name: str, spec: str = "", start: int = 0, end: int | None = None):
    """Najde všechny výskyty příkazu \\name s argumenty podle spec."""
    if end is None:
        end = len(text)
    res = []
    pat = re.compile(r"\\" + re.escape(name) + r"(?![a-zA-Z@])")
    for mt in pat.finditer(m, start, end):
        if mt.start() > 0 and m[mt.start() - 1] == "\\" and (mt.start() < 2 or m[mt.start() - 2] != "\\"):
            continue  # \\name je ve skutečnosti \\ + name
        r = parse_args(text, m, mt.end(), spec)
        if r is None:
            continue
        e, star, seq = r
        c = Cmd(name=name, start=mt.start(), end=e, star=star, seq=seq)
        c.opts = [v for t, v in seq if t == "o"]
        c.args = [v for t, v in seq if t == "m"]
        res.append(c)
    return res


@dataclass
class Env:
    name: str
    start: int  # začátek \begin
    end: int  # konec \end{..}
    inner_start: int
    inner_end: int
    begin_args_end: int  # konec argumentů za \begin{name}

    def inner(self, text: str) -> str:
        return text[self.inner_start : self.inner_end]


def find_environments(text: str, m: str, name: str, spec: str = "", start: int = 0, end: int | None = None):
    """Najde prostředí \\begin{name} ... \\end{name} (s ohledem na vnoření)."""
    if end is None:
        end = len(text)
    res = []
    b_pat = re.compile(r"\\begin\s*\{" + re.escape(name) + r"\}")
    e_pat = re.compile(r"\\end\s*\{" + re.escape(name) + r"\}")
    pos = start
    while True:
        b = b_pat.search(m, pos, end)
        if not b:
            break
        args_end = b.end()
        if spec:
            r = parse_args(text, m, b.end(), spec)
            if r:
                args_end = r[0]
        depth = 1
        p = b.end()
        found = None
        while depth:
            nb = b_pat.search(m, p, end)
            ne = e_pat.search(m, p, end)
            if not ne:
                break
            if nb and nb.start() < ne.start():
                depth += 1
                p = nb.end()
            else:
                depth -= 1
                p = ne.end()
                if depth == 0:
                    found = ne
        if not found:
            pos = b.end()
            continue
        res.append(Env(name, b.start(), found.end(), args_end, found.start(), args_end))
        pos = found.end()
    return res


def apply_edits(text: str, edits):
    """edits = [(start, end, replacement)], nesmí se překrývat."""
    edits = sorted(edits, key=lambda e: (e[0], e[1]))
    out = []
    last = 0
    for s, e, r in edits:
        if s < last:
            continue  # překryv — ignorujeme pozdější
        out.append(text[last:s])
        out.append(r)
        last = e
    out.append(text[last:])
    return "".join(out)


def split_top(text: str, seps) -> list:
    """Rozdělí text podle oddělovačů (regex), ale jen mimo {} a $..$."""
    if isinstance(seps, str):
        seps = re.compile(seps)
    parts = []
    depth = 0
    in_math = False
    last = 0
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c == "\\":
            if depth == 0 and not in_math:
                mt = seps.match(text, i)
                if mt and mt.end() > i:
                    parts.append(text[last:i])
                    last = i = mt.end()
                    continue
            i += 2
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        elif c == "$":
            in_math = not in_math
        elif depth == 0 and not in_math:
            mt = seps.match(text, i)
            if mt and mt.end() > i:
                parts.append(text[last:i])
                last = i = mt.end()
                continue
        i += 1
    parts.append(text[last:])
    return parts


class Doc:
    """Text + jeho maska; po úpravě se maska přepočítá."""

    def __init__(self, text: str):
        self.text = text
        self.m = mask(text)

    def set(self, text: str):
        self.text = text
        self.m = mask(text)

    def cmds(self, name, spec="", start=0, end=None):
        return find_commands(self.text, self.m, name, spec, start, end)

    def envs(self, name, spec="", start=0, end=None):
        return find_environments(self.text, self.m, name, spec, start, end)

    def search(self, pattern, start=0, end=None):
        if end is None:
            end = len(self.m)
        return re.compile(pattern).search(self.m, start, end)

    def edit(self, edits):
        self.set(apply_edits(self.text, edits))


def unwrap_cmd(text: str, names, keep_arg: int = 0) -> str:
    """Nahradí \\name{X} za X pro dané příkazy (opakovaně, i vnořené)."""
    for _ in range(5):
        d = Doc(text)
        edits = []
        for nm in names:
            for c in d.cmds(nm, "som"):
                edits.append((c.start, c.end, c.args[keep_arg] if c.args else ""))
        if not edits:
            break
        text = apply_edits(text, edits)
    return text


def remove_cmds(text: str, specs: dict) -> str:
    """Odstraní příkazy (i s argumenty). specs = {jméno: spec}."""
    d = Doc(text)
    edits = []
    for nm, spec in specs.items():
        for c in d.cmds(nm, spec):
            edits.append((c.start, c.end, ""))
    return apply_edits(text, edits)


EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+(?:\\_[A-Za-z0-9._%+\-]+)*@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+")


def squash(s: str) -> str:
    s = s.replace("~", " ")
    s = re.sub(r"\s+", " ", s)
    return s.strip()
