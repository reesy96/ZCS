"""Datový model článku nezávislý na šabloně."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass
class Author:
    name: str  # LaTeX zápis celého jména
    given: str = ""
    family: str = ""
    affs: list = field(default_factory=list)  # indexy (od 0) do Article.affiliations
    email: str = ""
    orcid: str = ""
    corresponding: bool = False
    notes: list = field(default_factory=list)  # \thanks a poznámky

    def split_name(self):
        if self.given or self.family:
            return self.given, self.family
        parts = self.name.replace("~", " ").split()
        if len(parts) <= 1:
            return "", self.name
        # „van der Berg“ apod. ponecháme jednoduše: poslední slovo = příjmení
        return " ".join(parts[:-1]), parts[-1]

    def initials(self):
        g, f = self.split_name()
        ini = " ".join(p[0] + "." for p in g.replace("-", " ").split() if p and p[0].isalpha())
        return ini, f


@dataclass
class Article:
    source_class: str = ""
    source_class_options: str = ""
    title: str = ""
    short_title: str = ""
    authors: list = field(default_factory=list)
    affiliations: list = field(default_factory=list)
    general_notes: list = field(default_factory=list)  # poznámky k autorům bez přiřazení
    correspondence: str = ""
    abstract: str = ""
    keywords: list = field(default_factory=list)
    highlights: list = field(default_factory=list)
    acknowledgments: str = ""
    declarations: dict = field(default_factory=dict)  # Funding, Conflicts of interest ...
    body: str = ""  # tělo s místy %%PREVOD:BACKMATTER%% a %%PREVOD:BIBLIOGRAPHY%%
    preamble_packages: list = field(default_factory=list)  # [(volby, jméno)]
    preamble_defs: list = field(default_factory=list)  # [(druh, jméno, text)]
    graphicspath: list = field(default_factory=list)
    bib_kind: str = "none"  # bibtex | biblatex | thebibliography | none
    bib_files: list = field(default_factory=list)
    bib_style: str = ""
    thebibliography: str = ""
    biblatex_options: str = ""
    uses_fontspec: bool = False
    warnings: list = field(default_factory=list)
    info: list = field(default_factory=list)

    def to_dict(self):
        return asdict(self)

    @classmethod
    def from_dict(cls, d):
        d = dict(d)
        d["authors"] = [Author(**a) for a in d.get("authors", [])]
        return cls(**d)


BACK_MARK = "%%PREVOD:BACKMATTER%%"
BIB_MARK = "%%PREVOD:BIBLIOGRAPHY%%"
