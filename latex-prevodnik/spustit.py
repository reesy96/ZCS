#!/usr/bin/env python3
"""LaTeX převodník článků mezi šablonami časopisů.

Spuštění webového rozhraní (otevře se v prohlížeči):
    python spustit.py

Převod z příkazové řádky:
    python spustit.py --clanek muj_clanek.zip --sablona sablona_casopisu.zip --vystup vysledek.zip
"""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from prevodnik.pipeline import ConversionError, analyze, make_zip, run  # noqa: E402
from prevodnik.project import add_upload  # noqa: E402


def _load(path: Path, dest: Path):
    if path.is_dir():
        shutil.copytree(path, dest, dirs_exist_ok=True)
    else:
        add_upload(dest, path.name, path.read_bytes())


def cli(args):
    work = Path(tempfile.mkdtemp(prefix="latex-prevodnik-"))
    try:
        _load(Path(args.clanek), work / "clanek")
        _load(Path(args.sablona), work / "sablona")
        a = analyze(work / "clanek", work / "sablona")
        art = a["article"]
        print(f"Zdroj: {art.source_class}  →  cíl: {a['template'].label}")
        print(f"Název: {art.title}")
        for au in art.authors:
            print(f"  autor: {au.name}  {au.email}")
        res = run(art, work / "clanek", work / "sablona", work / "out", do_compile=not args.bez_prekladu)
        out = Path(args.vystup)
        if out.suffix.lower() == ".zip":
            make_zip(work / "out", out)
        else:
            if out.exists():
                shutil.rmtree(out)
            shutil.copytree(work / "out", out)
        r = res["report"]
        for w in r["warnings"]:
            print("  ! " + w)
        c = res.get("compile")
        if c:
            print("Překlad: " + ("OK" if c["ok"] else "s chybami" if c["pdf"] else "nepodařil se"))
            for e in c["errors"][:5]:
                print("    " + e.replace("\n", "\n    "))
        print(f"Výsledek: {out}  (podrobnosti v ZPRAVA_O_PREVODU.md)")
    except ConversionError as e:
        print("Chyba: " + str(e))
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return 0


def main():
    ap = argparse.ArgumentParser(description="Převod LaTeX článku do šablony jiného časopisu.")
    ap.add_argument("--clanek", help="hotový článek (.zip, složka nebo .tex)")
    ap.add_argument("--sablona", help="šablona časopisu (.zip, složka nebo .tex)")
    ap.add_argument("--vystup", default="prevedeny-clanek.zip", help="výstupní .zip nebo složka")
    ap.add_argument("--bez-prekladu", action="store_true", help="nezkoušet překlad do PDF")
    ap.add_argument("--port", type=int, default=8765, help="port webového rozhraní")
    ap.add_argument("--neotevirat", action="store_true", help="neotevírat prohlížeč automaticky")
    args = ap.parse_args()
    if args.clanek or args.sablona:
        if not (args.clanek and args.sablona):
            ap.error("pro převod z příkazové řádky zadej --clanek i --sablona")
        sys.exit(cli(args))
    from prevodnik.server import serve

    serve(port=args.port, open_browser=not args.neotevirat)


if __name__ == "__main__":
    main()
