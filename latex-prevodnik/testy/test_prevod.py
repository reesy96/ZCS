"""Základní testy: převod ukázkového článku (elsarticle) do obecné šablony.

Spuštění (ze složky latex-prevodnik):  python -m unittest discover testy
"""

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from prevodnik.authors import latex_to_unicode  # noqa: E402
from prevodnik.pipeline import analyze, run  # noqa: E402
from prevodnik.texparse import Doc, mask  # noqa: E402


class TestParser(unittest.TestCase):
    def test_maska_komentaru(self):
        t = "a % \\section{x}\n\\section{y} 50\\% b"
        m = mask(t)
        self.assertEqual(len(m), len(t))
        self.assertEqual([c.args[0] for c in Doc(t).cmds("section", "som")], ["y"])

    def test_akcenty(self):
        self.assertEqual(latex_to_unicode(r"Dvo\v{r}\'akov\'a"), "Dvořáková")


class TestPrevod(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        shutil.copytree(ROOT / "priklad" / "clanek-elsevier", self.tmp / "clanek")
        shutil.copytree(ROOT / "priklad" / "sablona-obecna", self.tmp / "sablona")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_extrakce(self):
        art = analyze(self.tmp / "clanek", self.tmp / "sablona")["article"]
        self.assertEqual(art.title, "Fibre Bragg Grating Sensors for Wrist Rehabilitation Monitoring")
        self.assertEqual([a.name for a in art.authors][2], "John Smith")
        self.assertEqual(art.authors[0].email, "jan.novak@fel.cvut.cz")
        self.assertTrue(art.authors[0].corresponding)
        self.assertEqual(art.authors[1].affs, [0, 1])
        self.assertEqual(len(art.affiliations), 2)
        self.assertEqual(len(art.keywords), 4)
        self.assertIn("volunteers", art.acknowledgments)
        self.assertEqual(art.bib_kind, "bibtex")

    def test_prevod(self):
        a = analyze(self.tmp / "clanek", self.tmp / "sablona")
        res = run(a["article"], self.tmp / "clanek", self.tmp / "sablona", self.tmp / "out", do_compile=False)
        tex = (self.tmp / "out" / res["main"]).read_text(encoding="utf-8")
        self.assertIn("\\documentclass[11pt,a4paper]{article}", tex)
        self.assertIn("\\section{Introduction}", tex)
        self.assertIn("\\bibliographystyle{abbrvnat}", tex)
        self.assertIn("\\bibliography{refs}", tex)
        self.assertNotIn("frontmatter", tex)
        self.assertNotIn("\\usepackage{geometry}\n% ===== konec", tex)
        self.assertTrue((self.tmp / "out" / "figures" / "sensor.png").exists())


if __name__ == "__main__":
    unittest.main()
