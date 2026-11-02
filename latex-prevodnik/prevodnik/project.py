"""Načtení nahraného projektu (zip / tar / jednotlivé soubory) a nalezení hlavního .tex."""

from __future__ import annotations

import os
import re
import shutil
import tarfile
import zipfile
from pathlib import Path, PurePosixPath

from .texparse import Doc

ARCHIVE_EXT = (".zip", ".tar", ".tar.gz", ".tgz", ".tar.bz2")
IGNORED_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}
AUX_EXT = {".aux", ".log", ".out", ".toc", ".lof", ".lot", ".fls", ".fdb_latexmk", ".synctex.gz",
           ".blg", ".bcf", ".run.xml", ".nav", ".snm", ".vrb", ".spl", ".xdv", ".dvi"}


def safe_rel(name: str) -> str | None:
    """Vrátí bezpečnou relativní cestu (bez .., absolutních cest apod.)."""
    name = name.replace("\\", "/")
    parts = [p for p in PurePosixPath(name).parts if p not in ("", ".", "/")]
    if not parts or any(p == ".." for p in parts):
        return None
    if parts[0].endswith(":"):  # C:
        parts = parts[1:]
    if any(p.startswith("__MACOSX") for p in parts) or parts[-1] in IGNORED_NAMES:
        return None
    return "/".join(parts)


def _extract_zip(path: Path, dest: Path):
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            rel = safe_rel(info.filename)
            if not rel:
                continue
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)


def _extract_tar(path: Path, dest: Path):
    with tarfile.open(path) as t:
        for member in t.getmembers():
            if not member.isfile():
                continue
            rel = safe_rel(member.name)
            if not rel:
                continue
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            src = t.extractfile(member)
            if src is None:
                continue
            with src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)


def add_upload(dest: Path, filename: str, data: bytes):
    """Uloží jeden nahraný soubor; archivy rozbalí."""
    rel = safe_rel(filename) or "soubor"
    low = rel.lower()
    dest.mkdir(parents=True, exist_ok=True)
    if low.endswith(ARCHIVE_EXT):
        tmp = dest / ("__upload__" + os.path.basename(rel))
        tmp.write_bytes(data)
        try:
            if low.endswith(".zip"):
                _extract_zip(tmp, dest)
            else:
                _extract_tar(tmp, dest)
        finally:
            tmp.unlink(missing_ok=True)
    else:
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def flatten_single_root(dest: Path):
    """Pokud je vše v jediné složce (typický zip), posuň obsah o úroveň výš."""
    while True:
        items = [p for p in dest.iterdir()]
        if len(items) == 1 and items[0].is_dir():
            inner = items[0]
            tmp = dest.parent / (dest.name + "__tmp")
            inner.rename(tmp)
            for p in tmp.iterdir():
                p.rename(dest / p.name)
            tmp.rmdir()
        else:
            break


def read_text(path: Path) -> str:
    data = path.read_bytes()
    for enc in ("utf-8-sig", "cp1250", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


PREFERRED_MAIN = ("main", "manuscript", "paper", "article", "clanek", "template", "sample", "rukopis")


def find_main_tex(root: Path):
    """Najde hlavní soubor (obsahuje \\documentclass a \\begin{document}).

    Vrací (cesta, [ostatní kandidáti]).
    """
    cands = []
    for p in sorted(root.rglob("*.tex")):
        try:
            t = Doc(read_text(p))
        except OSError:
            continue
        if t.search(r"\\documentclass") and t.search(r"\\begin\s*\{document\}"):
            depth = len(p.relative_to(root).parts)
            stem = p.stem.lower()
            pref = 0
            for i, key in enumerate(PREFERRED_MAIN):
                if key in stem:
                    pref = len(PREFERRED_MAIN) - i
                    break
            # šablony často obsahují i „bare“/„sample“ — preferuj soubor s nejvíc obsahem
            size = len(t.text)
            cands.append((depth, -pref, -size, p))
    if not cands:
        return None, []
    cands.sort(key=lambda c: (c[0], c[1], c[2]))
    main = cands[0][3]
    return main, [c[3] for c in cands[1:]]


INPUT_RE = r"\\(input|include|subfile)(?![a-zA-Z@])"


def expand_inputs(text: str, base: Path, root: Path, used: set, depth: int = 0) -> str:
    """Rekurzivně vloží obsah \\input / \\include souborů."""
    if depth > 10:
        return text
    d = Doc(text)
    edits = []
    for name in ("input", "include", "subfile"):
        for c in d.cmds(name, "m"):
            arg = c.args[0].strip()
            if not arg or "\\" in arg or "#" in arg:
                continue
            cand = []
            for b in (base, root):
                p = b / arg
                cand += [p, p.with_name(p.name + ".tex")]
            found = next((p for p in cand if p.is_file()), None)
            if not found or found.suffix.lower() not in (".tex", ""):
                continue
            used.add(found.resolve())
            inner = read_text(found)
            if name == "subfile":
                dd = Doc(inner)
                b = dd.search(r"\\begin\s*\{document\}")
                e = dd.search(r"\\end\s*\{document\}")
                if b and e:
                    inner = inner[b.end() : e.start()]
            inner = expand_inputs(inner, found.parent, root, used, depth + 1)
            prefix = "\\clearpage\n" if name == "include" else ""
            edits.append((c.start, c.end, prefix + inner.rstrip("\n") + "\n"))
    if not edits:
        return text
    from .texparse import apply_edits

    return apply_edits(text, edits)


def list_files(root: Path):
    return [p for p in sorted(root.rglob("*")) if p.is_file()]


def is_aux(p: Path) -> bool:
    name = p.name.lower()
    return any(name.endswith(e) for e in AUX_EXT)
