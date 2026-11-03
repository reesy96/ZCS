"""Lokální webové rozhraní (jen standardní knihovna Pythonu)."""

from __future__ import annotations

import html
import json
import mimetypes
import secrets
import shutil
import threading
import traceback
import urllib.parse
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .compile import tex_available
from .model import Author
from .pipeline import ConversionError, analyze, load_article, make_zip, run, save_article
from .project import add_upload

JOBS = Path.home() / ".latex-prevodnik" / "ulohy"
LOCK = threading.Lock()
E = html.escape

CSS = """
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2330;--muted:#5d6779;--line:#dfe3ea;--acc:#2456c7;--ok:#1d7a46;--warn:#9a5b00;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--card:#1d2128;--ink:#e7eaf0;--muted:#9aa4b5;--line:#30363f;--acc:#7aa2ff;--ok:#5cc98a;--warn:#f0b35a;--err:#ff7b72}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px 16px 60px}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 10px}
.sub{color:var(--muted);margin:0 0 20px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin:14px 0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:720px){.grid{grid-template-columns:1fr}}
label{display:block;font-weight:600;margin:10px 0 4px}input[type=text],textarea,select{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink);font:inherit}
textarea{min-height:90px;font-family:ui-monospace,Consolas,monospace;font-size:13px}
.drop{border:2px dashed var(--line);border-radius:10px;padding:16px;text-align:center}.drop.over{border-color:var(--acc)}
.drop p{margin:6px 0;color:var(--muted)}.files{font-size:13px;color:var(--muted);text-align:left;max-height:120px;overflow:auto}
button,.btn{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}
.btn.sec{background:transparent;color:var(--acc);border:1px solid var(--acc)}button.small{padding:5px 10px;font-size:13px}
table{width:100%;border-collapse:collapse}td,th{padding:4px;text-align:left;vertical-align:top}th{font-size:13px;color:var(--muted)}
td input[type=text]{padding:6px 8px}.pill{display:inline-block;padding:2px 9px;border-radius:99px;border:1px solid var(--line);font-size:13px}
ul.list{padding-left:20px;margin:6px 0}ul.list li{margin:3px 0}.ok{color:var(--ok)}.warn{color:var(--warn)}.err{color:var(--err)}
pre{background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:10px;overflow:auto;font-size:12.5px;max-height:420px;white-space:pre-wrap}
iframe{width:100%;height:80vh;border:1px solid var(--line);border-radius:8px;background:#fff}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.hint{font-size:13px;color:var(--muted)}.card h2:first-child{margin-top:0}a{color:var(--acc)}.chk{display:flex;gap:8px;align-items:center;font-weight:400}
"""


def page(title, body):
    return f"""<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{E(title)}</title><style>{CSS}</style></head><body><main>{body}</main></body></html>"""


def index_page(msg=""):
    av = tex_available()
    tex = ("<span class='ok'>LaTeX nalezen (" + ", ".join(k for k, v in av.items() if v) + ") — výsledek se rovnou zkusí přeložit.</span>"
           if av.get("latexmk") or av.get("pdflatex") else
           "<span class='warn'>LaTeX na tomto počítači nenalezen — převod proběhne, ale PDF si přeložíš sám (TeXstudio, Overleaf…).</span>")

    def drop(name, title, hint):
        return f"""<div class="drop" data-name="{name}"><b>{title}</b><p>{hint}</p>
<div class="row" style="justify-content:center"><label class="btn sec" style="margin:0">Vybrat soubory / ZIP<input type="file" name="{name}" multiple hidden></label>
<label class="btn sec" style="margin:0">Vybrat složku<input type="file" name="{name}_dir" webkitdirectory directory multiple hidden></label></div>
<p class="hint">nebo sem soubory přetáhni</p><div class="files"></div></div>"""

    return page("Převod LaTeX článku do šablony časopisu", f"""
<h1>Převod LaTeX článku do jiné šablony</h1><p class="sub">Nahraj hotový článek a šablonu cílového časopisu. Text, obrázky, tabulky, rovnice,
literaturu i titulní údaje přenesu do nové šablony. Vše běží jen na tvém počítači.</p>
{('<div class="card err">' + E(msg) + '</div>') if msg else ''}
<form class="card" method="post" action="/analyze" enctype="multipart/form-data" id="f">
<div class="grid">
{drop("clanek", "1. Hotový článek", "celý projekt: .tex, obrázky, .bib (nejlépe jako ZIP nebo složka)")}
{drop("sablona", "2. Šablona časopisu", "ZIP/složka od časopisu (.tex, .cls, .bst, …)")}
</div>
<p class="hint" style="margin-top:14px">{tex}</p>
<button type="submit">Analyzovat →</button>
</form>
<div class="card hint"><b>Nativně podporované šablony:</b> Elsevier (elsarticle, CAS), IEEE (konference i časopis), Springer Nature (sn-jnl),
Springer LNCS, Springer svjour3, MDPI, ACM (acmart), APS/AIP (REVTeX), AMS (amsart). Ostatní třídy převedu obecně podle vzoru šablony.</div>
<script>
document.querySelectorAll('.drop').forEach(function(d){{
  var name=d.dataset.name, list=d.querySelector('.files'), inputs=d.querySelectorAll('input[type=file]');
  function show(){{var n=[];inputs.forEach(function(i){{for(var f of i.files)n.push(f.webkitRelativePath||f.name)}});
    list.innerHTML=n.length?('<b>'+n.length+' souborů</b><br>'+n.slice(0,40).map(function(x){{return x.replace(/</g,'&lt;')}}).join('<br>')+(n.length>40?'<br>…':'')):'';}}
  inputs.forEach(function(i){{i.addEventListener('change',show)}});
  d.addEventListener('dragover',function(e){{e.preventDefault();d.classList.add('over')}});
  d.addEventListener('dragleave',function(){{d.classList.remove('over')}});
  d.addEventListener('drop',function(e){{e.preventDefault();d.classList.remove('over');inputs[0].files=e.dataTransfer.files;show()}});
}});
document.getElementById('f').addEventListener('submit',function(e){{
  var b=this.querySelector('button');b.textContent='Analyzuji…';b.disabled=true;}});
</script>""")


def job_dir(jid: str) -> Path:
    if not jid or not all(c in "0123456789abcdef" for c in jid):
        raise ConversionError("Neplatná úloha.")
    d = JOBS / jid
    if not d.is_dir():
        raise ConversionError("Úloha neexistuje (možná byla smazána).")
    return d


def form_page(jid: str, meta: dict, art):
    aff_text = "\n".join(art.affiliations)
    rows = []
    authors = list(art.authors) + [Author(name="")]
    for i, a in enumerate(authors):
        rows.append(f"""<tr><td><input type="text" name="au_name_{i}" value="{E(a.name)}"></td>
<td style="width:90px"><input type="text" name="au_aff_{i}" value="{E(','.join(str(x + 1) for x in a.affs))}"></td>
<td><input type="text" name="au_email_{i}" value="{E(a.email)}"></td>
<td style="width:170px"><input type="text" name="au_orcid_{i}" value="{E(a.orcid)}"></td>
<td style="width:50px;text-align:center"><input type="checkbox" name="au_corr_{i}" {'checked' if a.corresponding else ''}></td></tr>""")

    def sel(name, cands, cur):
        if len(cands) <= 1:
            return f"<span class='pill'>{E(cur)}</span>"
        opts = "".join(f"<option {'selected' if c == cur else ''}>{E(c)}</option>" for c in cands)
        return f"<select name='{name}' onchange='this.form.action=\"/job/{jid}/reanalyze\";this.form.submit()'>{opts}</select>"

    warn = "".join(f"<li class='warn'>{E(w)}</li>" for w in art.warnings)
    info = "".join(f"<li>{E(w)}</li>" for w in art.info)
    return page("Kontrola údajů", f"""
<h1>Kontrola rozpoznaných údajů</h1>
<p class="sub">Zkontroluj a případně oprav, co jsem z článku vytáhl. Tělo článku (kapitoly, obrázky, tabulky, rovnice) se přenese automaticky.</p>
<form method="post" action="/job/{jid}/convert">
<div class="card"><div class="grid">
<div><label>Zdrojový článek</label>{sel('src_main', meta['src_candidates'], meta['src_main'])}
<div class="hint">třída <b>{E(art.source_class)}</b> {E(art.source_class_options)}</div></div>
<div><label>Cílová šablona</label>{sel('tpl_main', meta['tpl_candidates'], meta['tpl_main'])}
<div class="hint">{E(meta['tpl_label'])} {'· dvousloupcová' if meta.get('twocolumn') else ''}</div></div></div>
{('<ul class="list">' + warn + info + '</ul>') if (warn or info) else ''}</div>
<div class="card"><label>Název článku</label><input type="text" name="title" value="{E(art.title)}">
<label>Krátký název (záhlaví stránek, nepovinné)</label><input type="text" name="short_title" value="{E(art.short_title)}">
<h2>Autoři</h2><table id="au"><tr><th>Jméno (LaTeX)</th><th>Afiliace č.</th><th>E-mail</th><th>ORCID</th><th>Koresp.</th></tr>{''.join(rows)}</table>
<button type="button" class="small sec btn" onclick="addRow()">+ přidat autora</button>
<label>Afiliace (jedna na řádek; čísla řádků odpovídají sloupci „Afiliace č.“)</label><textarea name="affiliations" style="min-height:110px">{E(aff_text)}</textarea>
<label>Abstrakt</label><textarea name="abstract" style="min-height:160px">{E(art.abstract)}</textarea>
<label>Klíčová slova (jedno na řádek)</label><textarea name="keywords">{E(chr(10).join(art.keywords))}</textarea>
<label>Poděkování</label><textarea name="ack">{E(art.acknowledgments)}</textarea>
<label>Poznámka k názvu (financování apod.)</label><textarea name="notes" style="min-height:50px">{E(chr(10).join(art.general_notes))}</textarea>
</div>
<div class="card row"><label class="chk"><input type="checkbox" name="compile" checked> zkusit výsledek přeložit do PDF</label>
<button type="submit" id="go">Převést do šablony →</button><a class="btn sec" href="/">Začít znovu</a></div>
</form>
<script>
var n={len(authors)};
function addRow(){{var t=document.getElementById('au');var r=t.rows[t.rows.length-1].cloneNode(true);
r.querySelectorAll('input').forEach(function(i){{i.name=i.name.replace(/_\\d+$/,'_'+n);if(i.type=='checkbox')i.checked=false;else i.value='';}});n++;t.appendChild(r);}}
document.querySelector('form').addEventListener('submit',function(){{var b=document.getElementById('go');b.textContent='Převádím a překládám…';b.disabled=true;}});
</script>""")


def result_page(jid: str, res: dict):
    r = res["report"]
    c = res.get("compile")
    parts = [f"<h1>Hotovo</h1><p class='sub'>Článek je převedený do šablony <b>{E(res['template_label'])}</b>.</p>",
             f"<div class='card row'><a class='btn' href='/job/{jid}/download'>Stáhnout výsledek (ZIP)</a>"
             f"<a class='btn sec' href='/job/{jid}'>← Upravit údaje a převést znovu</a><a class='btn sec' href='/'>Nový převod</a></div>"]
    if c:
        if c.get("no_tex"):
            parts.append("<div class='card'><b>PDF jsem nevytvořil — na tomto počítači není nainstalovaný LaTeX.</b> "
                         "Převod sám proběhl; stáhni ZIP a přelož ho v Overleafu (nahraj ZIP jako nový projekt) "
                         "nebo si nainstaluj <a href='https://miktex.org/download'>MiKTeX</a> a aplikaci spusť znovu.</div>")
        elif c["ok"]:
            parts.append("<div class='card ok'><b>Zkušební překlad proběhl bez chyb.</b></div>")
        elif c["pdf"]:
            parts.append("<div class='card warn'><b>PDF vzniklo, ale překlad hlásil chyby</b> — viz níže.</div>")
        else:
            parts.append("<div class='card err'><b>Překlad se nepodařil.</b> Zdrojové soubory jsou i tak v ZIPu; chyby jsou níže.</div>")
        if c["errors"]:
            parts.append("<div class='card'><h2>Chyby LaTeXu</h2>" + "".join(f"<pre>{E(e)}</pre>" for e in c["errors"]) + "</div>")
        if c.get("undefined"):
            parts.append("<div class='card warn'>Nedefinované odkazy/citace: " + E(", ".join(c["undefined"])) + "</div>")
    for title, key, cls in (("Varování — zkontroluj ručně", "warnings", "warn"), ("Provedené úpravy", "done", ""), ("Informace", "info", "")):
        if r[key]:
            parts.append(f"<div class='card'><h2>{title}</h2><ul class='list'>" + "".join(f"<li class='{cls}'>{E(x)}</li>" for x in r[key]) + "</ul></div>")
    if c and c["pdf"]:
        parts.append(f"<div class='card'><h2>Náhled PDF</h2><iframe src='/job/{jid}/out/{urllib.parse.quote(c['pdf'])}'></iframe></div>")
    parts.append(f"<div class='card'><h2>Hlavní soubor {E(res['main'])}</h2><pre id='tex'>načítám…</pre></div>"
                 f"<script>fetch('/job/{jid}/out/{urllib.parse.quote(res['main'])}').then(r=>r.text()).then(t=>document.getElementById('tex').textContent=t)</script>")
    return page("Výsledek převodu", "".join(parts))


def apply_form(art, form: dict):
    g = lambda k: form.get(k, [""])[0]
    art.title = g("title").strip()
    art.short_title = g("short_title").strip()
    art.affiliations = [l.strip() for l in g("affiliations").splitlines() if l.strip()]
    old = {a.name: a for a in art.authors}
    authors = []
    i = 0
    while f"au_name_{i}" in form or i < 3:
        name = g(f"au_name_{i}").strip()
        if name:
            affs = []
            for x in g(f"au_aff_{i}").replace(";", ",").split(","):
                x = x.strip()
                if x.isdigit() and 1 <= int(x) <= len(art.affiliations):
                    affs.append(int(x) - 1)
            prev = old.get(name)
            authors.append(Author(name=name, given=prev.given if prev else "", family=prev.family if prev else "",
                                  affs=affs, email=g(f"au_email_{i}").strip(), orcid=g(f"au_orcid_{i}").strip(),
                                  corresponding=bool(form.get(f"au_corr_{i}")), notes=prev.notes if prev else []))
        i += 1
        if i > 200:
            break
    art.authors = authors
    art.abstract = g("abstract").strip()
    art.keywords = [k.strip() for k in g("keywords").splitlines() if k.strip()]
    art.acknowledgments = g("ack").strip()
    art.general_notes = [k.strip() for k in g("notes").splitlines() if k.strip()]
    return art


class Handler(BaseHTTPRequestHandler):
    server_version = "LatexPrevodnik/1.0"

    def log_message(self, fmt, *args):
        pass

    def send_html(self, text, code=200):
        data = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def redirect(self, loc):
        self.send_response(303)
        self.send_header("Location", loc)
        self.end_headers()

    def send_file(self, path: Path, download_name=None):
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix in (".tex", ".md", ".bib", ".log", ".cls", ".sty", ".bst"):
            ctype = "text/plain; charset=utf-8"
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if download_name:
            self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        self.end_headers()
        self.wfile.write(data)

    def fail(self, e):
        if isinstance(e, ConversionError):
            self.send_html(index_page(str(e)))
        else:
            tb = traceback.format_exc()
            self.send_html(page("Chyba", f"<h1>Něco se pokazilo</h1><p>{E(str(e))}</p><pre>{E(tb)}</pre><a class='btn' href='/'>Zpět</a>"), 500)

    def do_GET(self):
        try:
            p = urllib.parse.urlparse(self.path).path
            parts = [x for x in p.split("/") if x]
            if not parts:
                return self.send_html(index_page())
            if parts[0] == "job" and len(parts) >= 2:
                d = job_dir(parts[1])
                meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
                if len(parts) == 2:
                    return self.send_html(form_page(parts[1], meta, load_article(d / "article.json")))
                if parts[2] == "result":
                    res = json.loads((d / "result.json").read_text(encoding="utf-8"))
                    return self.send_html(result_page(parts[1], res))
                if parts[2] == "download":
                    z = make_zip(d / "out", d / "vysledek.zip")
                    return self.send_file(z, "prevedeny-clanek.zip")
                if parts[2] == "out" and len(parts) >= 4:
                    rel = urllib.parse.unquote("/".join(parts[3:]))
                    f = (d / "out" / rel).resolve()
                    if (d / "out").resolve() in f.parents and f.is_file():
                        return self.send_file(f)
            self.send_html(page("Nenalezeno", "<h1>Stránka nenalezena</h1><a href='/'>Zpět</a>"), 404)
        except Exception as e:  # noqa: BLE001
            self.fail(e)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n)

    def do_POST(self):
        try:
            p = urllib.parse.urlparse(self.path).path
            parts = [x for x in p.split("/") if x]
            if parts == ["analyze"]:
                return self.analyze_upload()
            if parts and parts[0] == "job" and len(parts) == 3:
                d = job_dir(parts[1])
                form = urllib.parse.parse_qs(self.read_body().decode("utf-8"), keep_blank_values=True)
                meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
                if parts[2] == "reanalyze":
                    meta["src_main"] = form.get("src_main", [meta["src_main"]])[0]
                    meta["tpl_main"] = form.get("tpl_main", [meta["tpl_main"]])[0]
                    self.do_analyze(d, meta)
                    return self.redirect(f"/job/{parts[1]}")
                if parts[2] == "convert":
                    art = apply_form(load_article(d / "article.json"), form)
                    save_article(art, d / "article.json")
                    with LOCK:
                        res = run(art, d / "clanek", d / "sablona", d / "out", meta["src_main"], meta["tpl_main"],
                                  do_compile=bool(form.get("compile")))
                    (d / "result.json").write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
                    return self.redirect(f"/job/{parts[1]}/result")
            self.send_html(page("Nenalezeno", "<h1>Nenalezeno</h1>"), 404)
        except Exception as e:  # noqa: BLE001
            self.fail(e)

    def analyze_upload(self):
        ctype = self.headers.get("Content-Type", "")
        body = self.read_body()
        msg = BytesParser(policy=policy.default).parsebytes(
            b"Content-Type: " + ctype.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + body)
        jid = secrets.token_hex(6)
        d = JOBS / jid
        d.mkdir(parents=True)
        counts = {"clanek": 0, "sablona": 0}
        for part in msg.iter_parts():
            name = part.get_param("name", header="content-disposition") or ""
            fn = part.get_param("filename", header="content-disposition")
            if not fn:
                continue
            key = name.replace("_dir", "")
            if key not in counts:
                continue
            data = part.get_payload(decode=True) or b""
            if not data and not fn:
                continue
            add_upload(d / key, fn, data)
            counts[key] += 1
        if not counts["clanek"] or not counts["sablona"]:
            shutil.rmtree(d, ignore_errors=True)
            raise ConversionError("Nahraj prosím jak hotový článek, tak šablonu časopisu.")
        self.do_analyze(d, {})
        self.redirect(f"/job/{jid}")

    def do_analyze(self, d: Path, meta: dict):
        a = analyze(d / "clanek", d / "sablona", meta.get("src_main"), meta.get("tpl_main"))
        T = a["template"]
        meta = {"src_main": a["src_main"].relative_to(d / "clanek").as_posix(),
                "tpl_main": a["tpl_main"].relative_to(d / "sablona").as_posix(),
                "src_candidates": a["src_candidates"], "tpl_candidates": a["tpl_candidates"],
                "tpl_label": T.label + f" ({T.cls})", "twocolumn": T.twocolumn}
        (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        save_article(a["article"], d / "article.json")


def serve(host="127.0.0.1", port=8765, open_browser=True):
    JOBS.mkdir(parents=True, exist_ok=True)
    httpd = None
    for p in range(port, port + 20):
        try:
            httpd = ThreadingHTTPServer((host, p), Handler)
            port = p
            break
        except OSError:
            continue
    if httpd is None:
        raise SystemExit("Nepodařilo se otevřít síťový port.")
    url = f"http://{host}:{port}/"
    print(f"Převodník běží na {url}  (ukončíš klávesami Ctrl+C)")
    print(f"Pracovní soubory: {JOBS}")
    if open_browser:
        import webbrowser

        threading.Timer(0.7, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nUkončeno.")
