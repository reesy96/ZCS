#!/usr/bin/env python3
"""Uprava kelimku a boticky FBG senzoru (v40 -> v41).

Vstup:  v40_vse.stl (vsechny dily v jednom ASCII STL)
Vystup: kelimek_v41_*.stl, boticka_v41_*.stl

Zmeny:
  kelimek: stredni otvor ve dne 10 -> DIRA_KELIMEK mm (projde SC/APC konektor),
           volitelne perforace sten a dna (otvory PERF_D mm)
  boticka: drazka DRAZKA_W mm po cele vysce na strane -X (naproti zapadce),
           priruba zvetsena na PRIRUBA_D, volitelny nakruzek do otvoru kelimku

Pouziti: python3 uprava_v41.py cesta/k/v40_vse.stl vystupni_adresar
Potrebuje: pip install trimesh manifold3d numpy scipy rtree shapely
"""
import sys, os
import numpy as np
import trimesh

DIRA_KELIMEK = 13.0   # mm, prumer stredniho otvoru ve dne kelimku (puvodne 10)
PERF_D       = 3.0    # mm, prumer perforacnich otvoru
DRAZKA_W     = 1.3    # mm, sirka drazky na vlakno v boticce
PRIRUBA_D    = 17.0   # mm, prumer priruby boticky (puvodne 13.4)
NAKRUZEK_H   = 2.5    # mm, vyska nakruzku pod prirubou (0 = bez nakruzku)
NAKRUZEK_OD  = 12.6   # mm, vnejsi prumer nakruzku (do otvoru 13 s vuli 0.2)
NAKRUZEK_ID  = 8.8    # mm, vnitrni prumer nakruzku (stopka ma 8.0)

def load_solids(path):
    """ASCII STL s vice 'solid' bloky -> dict jmeno -> Trimesh (nejvetsi komponenta)."""
    out, cur, tris, buf = {}, None, [], []
    for line in open(path):
        s = line.split()
        if not s: continue
        if s[0] == 'solid': cur, tris = s[1], []
        elif s[0] == 'vertex': buf.append([float(x) for x in s[1:4]])
        elif s[0] == 'endfacet': tris.append(buf); buf = []
        elif s[0] == 'endsolid':
            v = np.array(tris).reshape(-1, 3); f = np.arange(len(v)).reshape(-1, 3)
            m = trimesh.Trimesh(v, f, process=True)
            parts = m.split(only_watertight=False)
            m = max(parts, key=lambda p: len(p.faces))   # zahodi degenerovane slivery
            out[cur] = m
    return out

def cyl(d, h, at, axis='z'):
    c = trimesh.creation.cylinder(radius=d / 2, height=h, sections=96)
    if axis == 'x': c.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [0, 1, 0]))
    if axis == 'y': c.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0]))
    c.apply_translation(at)
    return c

def diff(a, cutters):
    return trimesh.boolean.difference([a] + cutters, engine='manifold')

def union(a, adds):
    return trimesh.boolean.union([a] + adds, engine='manifold')

def kelimek(m, perforace):
    c = m.bounds.mean(axis=0); cx, cy = c[0], c[1]
    cutters = [cyl(DIRA_KELIMEK, 6, [cx, cy, 1.0])]          # dno je z 0..1.6
    if perforace:
        # dno: dva vence otvoru
        for r, n, off in [(11.0, 6, 0), (18.0, 12, 15)]:
            for i in range(n):
                a = np.radians(off + 360 * i / n)
                cutters.append(cyl(PERF_D, 6, [cx + r * np.cos(a), cy + r * np.sin(a), 1.0]))
        # stena: dve rady radialnich otvoru, pod rampami bajonetu (rampy od z=17)
        for z, off in [(5.5, 0), (11.5, 15)]:
            for i in range(12):
                a = np.radians(off + 30 * i)
                h = cyl(PERF_D, 8, [0, 0, 0], axis='x')
                h.apply_transform(trimesh.transformations.rotation_matrix(a, [0, 0, 1]))
                h.apply_translation([cx + 25.7 * np.cos(a), cy + 25.7 * np.sin(a), z])
                cutters.append(h)
    return diff(m, cutters)

def boticka(m, nakruzek):
    c = m.bounds.mean(axis=0); cx, cy = c[0], c[1]
    BORE = 7.6                                                     # puvodni vrtani boticky
    adds = [diff(cyl(PRIRUBA_D, 1.0, [cx, cy, 0.5]), [cyl(BORE, 4, [cx, cy, 0.5])])]  # priruba jako prstenec
    if nakruzek and NAKRUZEK_H > 0:
        ring = diff(cyl(NAKRUZEK_OD, NAKRUZEK_H, [cx, cy, -NAKRUZEK_H / 2]),
                    [cyl(NAKRUZEK_ID, NAKRUZEK_H + 2, [cx, cy, -NAKRUZEK_H / 2])])
        adds.append(ring)
    m = union(m, adds)
    # drazka: kvadr od osy ven na stranu -X, po cele vysce
    slot = trimesh.creation.box(extents=[12, DRAZKA_W, 40])
    slot.apply_translation([cx - 6, cy, 11])
    # v ose nechame prujezd az k vlaknovemu kanalku (ten ma prumer ~2.4)
    return diff(m, [slot])

def main():
    src = sys.argv[1] if len(sys.argv) > 1 else 'v40_vse.stl'
    out = sys.argv[2] if len(sys.argv) > 2 else '.'
    os.makedirs(out, exist_ok=True)
    s = load_solids(src)
    cup = s['08_klicka_kelimek_1']; cap = s['04_boticka_horni_1']
    results = {
        'kelimek_v41_dira13.stl':              kelimek(cup, perforace=False),
        'kelimek_v41_dira13_perforovany.stl':  kelimek(cup, perforace=True),
        'boticka_v41_drazka.stl':              boticka(cap, nakruzek=False),
        'boticka_v41_drazka_nakruzek.stl':     boticka(cap, nakruzek=True),
    }
    for name, m in results.items():
        m.apply_translation(-m.bounds[0] * [1, 1, 0] - [0, 0, m.bounds[0][2]])  # roh do pocatku, z od 0
        m.merge_vertices(); m.update_faces(m.nondegenerate_faces())
        assert m.is_watertight, name
        m.export(os.path.join(out, name))
        print(f"{name:40s} faces={len(m.faces):6d} vol={m.volume:8.1f} mm3 size={np.round(m.extents,2).tolist()}")

if __name__ == '__main__':
    main()
