"""Volitelný zkušební překlad výsledku (latexmk / pdflatex + bibtex)."""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path


def tex_available():
    return {t: shutil.which(t) is not None for t in ("latexmk", "pdflatex", "xelatex", "bibtex", "biber")}


def _run(cmd, cwd, timeout):
    try:
        p = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           stdin=subprocess.DEVNULL, timeout=timeout)
        return p.returncode, p.stdout.decode("utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return -1, "Překlad trval příliš dlouho a byl přerušen."
    except OSError as e:
        return -1, str(e)


def compile_tex(main: Path, engine: str = "pdflatex", timeout: int = 240):
    """Vrátí dict(ok, pdf, errors, log_tail, tool)."""
    avail = tex_available()
    cwd = main.parent
    name = main.name
    res = {"ok": False, "pdf": None, "errors": [], "tool": None, "log_tail": "", "no_tex": False}
    log = cwd / (main.stem + ".log")
    out = ""
    used_latexmk = False
    if avail.get("latexmk"):
        flag = {"pdflatex": "-pdf", "xelatex": "-xelatex", "lualatex": "-lualatex"}[engine]
        cmd = ["latexmk", flag, "-interaction=nonstopmode", "-file-line-error", "-f", name]
        res["tool"] = "latexmk " + flag
        code, out = _run(cmd, cwd, timeout)
        # MiKTeX: latexmk potřebuje Perl; bez něj se nic nepřeloží → zkusíme pdflatex přímo
        used_latexmk = log.exists()
    if not used_latexmk and avail.get(engine):
        res["tool"] = engine + " + bibtex"
        out = ""
        base = [engine, "-interaction=nonstopmode", "-file-line-error", name]
        code, o = _run(base, cwd, timeout)
        out += o
        aux = cwd / (main.stem + ".aux")
        if aux.exists() and "\\bibdata" in aux.read_text(errors="replace") and avail.get("bibtex"):
            _, o = _run(["bibtex", main.stem], cwd, timeout)
            out += o
        elif (cwd / (main.stem + ".bcf")).exists() and avail.get("biber"):
            _, o = _run(["biber", main.stem], cwd, timeout)
            out += o
        for _ in range(2):
            code, o = _run(base, cwd, timeout)
            out += o
    elif not used_latexmk:
        res["no_tex"] = True
        return res
    logtxt = log.read_text(errors="replace") if log.exists() else out
    res["errors"] = parse_errors(logtxt)
    pdf = cwd / (main.stem + ".pdf")
    res["pdf"] = pdf if pdf.exists() else None
    res["ok"] = res["pdf"] is not None and not res["errors"]
    res["log_tail"] = "\n".join(logtxt.splitlines()[-40:])
    res["undefined"] = sorted(set(re.findall(r"(?:Citation|Reference) `([^']+)' .*undefined", logtxt)))[:30]
    return res


def parse_errors(log: str):
    errs = []
    lines = log.splitlines()
    for i, l in enumerate(lines):
        if l.startswith("!") or re.match(r"^\S+\.tex:\d+: ", l):
            ctx = [l]
            for k in range(i + 1, min(i + 6, len(lines))):
                if lines[k].startswith("l.") or lines[k].strip():
                    ctx.append(lines[k])
                if lines[k].startswith("l."):
                    break
            msg = "\n".join(ctx)
            if msg not in errs:
                errs.append(msg)
        if len(errs) >= 15:
            break
    return errs
