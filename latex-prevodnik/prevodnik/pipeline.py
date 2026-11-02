"""Spojení všech kroků: analýza → (úprava metadat) → převod → překlad → zip."""

from __future__ import annotations

import json
import shutil
import zipfile
from pathlib import Path

from .compile import compile_tex
from .extract import extract
from .model import Article
from .project import find_main_tex, flatten_single_root
from .template import analyze_template


class ConversionError(Exception):
    pass


def locate(src_dir: Path, tpl_dir: Path, src_main_rel: str | None = None, tpl_main_rel: str | None = None):
    for d in (src_dir, tpl_dir):
        if d.exists() and any(d.iterdir()):
            flatten_single_root(d)
    src_main, src_others = find_main_tex(src_dir)
    tpl_main, tpl_others = find_main_tex(tpl_dir)
    if src_main_rel:
        src_main = src_dir / src_main_rel
    if tpl_main_rel:
        tpl_main = tpl_dir / tpl_main_rel
    if not src_main:
        raise ConversionError("V nahraném článku jsem nenašel hlavní .tex soubor (s \\documentclass a \\begin{document}).")
    if not tpl_main:
        raise ConversionError("V nahrané šabloně jsem nenašel hlavní .tex soubor (s \\documentclass a \\begin{document}).")
    return src_main, src_others, tpl_main, tpl_others


def analyze(src_dir: Path, tpl_dir: Path, src_main_rel=None, tpl_main_rel=None):
    src_main, src_others, tpl_main, tpl_others = locate(src_dir, tpl_dir, src_main_rel, tpl_main_rel)
    art = extract(src_main, src_dir)
    T = analyze_template(tpl_main, tpl_dir, tpl_others)
    return {
        "article": art,
        "template": T,
        "src_main": src_main,
        "tpl_main": tpl_main,
        "src_candidates": [p.relative_to(src_dir).as_posix() for p in [src_main] + src_others],
        "tpl_candidates": [p.relative_to(tpl_dir).as_posix() for p in [tpl_main] + tpl_others],
    }


def run(art: Article, src_dir: Path, tpl_dir: Path, out_dir: Path, src_main_rel=None, tpl_main_rel=None,
        do_compile=True, out_name=None):
    from .convert import convert

    src_main, _, tpl_main, tpl_others = locate(src_dir, tpl_dir, src_main_rel, tpl_main_rel)
    T = analyze_template(tpl_main, tpl_dir, tpl_others)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    main_out, R = convert(art, T, src_dir, src_main, out_dir, out_name)
    result = {"main": main_out.name, "report": R.to_dict(), "compile": None, "template_label": T.label,
              "template_class": T.cls, "twocolumn": T.twocolumn}
    if do_compile:
        engine = "xelatex" if art.uses_fontspec else "pdflatex"
        c = compile_tex(main_out, engine)
        result["compile"] = {"ok": c["ok"], "pdf": c["pdf"].name if c["pdf"] else None, "errors": c["errors"],
                             "tool": c["tool"], "log_tail": c["log_tail"], "undefined": c.get("undefined", [])}
    write_report(out_dir, art, result)
    return result


def write_report(out_dir: Path, art: Article, result: dict):
    r = result["report"]
    lines = ["# Zpráva o převodu", "", f"Cílová šablona: {result['template_label']} (`{result['template_class']}`)", ""]
    lines += ["## Rozpoznaná metadata", "", f"- **Název:** {art.title}"]
    for a in art.authors:
        affs = "; ".join(art.affiliations[i] for i in a.affs if 0 <= i < len(art.affiliations))
        lines.append(f"- **Autor:** {a.name}{' (korespondující)' if a.corresponding else ''} — {affs} {a.email}")
    lines.append(f"- **Klíčová slova:** {'; '.join(art.keywords)}")
    lines.append(f"- **Abstrakt:** {len(art.abstract.split())} slov")
    for title, items in (("Provedené úpravy", r["done"]), ("Varování — zkontroluj", r["warnings"]), ("Informace", r["info"])):
        if items:
            lines += ["", "## " + title, ""] + ["- " + i.replace("\n", " ") for i in items]
    c = result.get("compile")
    if c:
        lines += ["", "## Zkušební překlad", "", f"Nástroj: {c['tool']}", "Výsledek: " + ("OK" if c["ok"] else ("PDF vzniklo, ale s chybami" if c["pdf"] else "nepodařilo se"))]
        for e in c["errors"]:
            lines += ["", "```", e, "```"]
    (out_dir / "ZPRAVA_O_PREVODU.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def make_zip(out_dir: Path, zip_path: Path):
    from .project import is_aux

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(out_dir.rglob("*")):
            if p.is_file() and not is_aux(p):
                z.write(p, p.relative_to(out_dir).as_posix())
    return zip_path


def save_article(art: Article, path: Path):
    path.write_text(json.dumps(art.to_dict(), ensure_ascii=False, indent=1), encoding="utf-8")


def load_article(path: Path) -> Article:
    return Article.from_dict(json.loads(path.read_text(encoding="utf-8")))
