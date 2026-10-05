"""Navijak boxerskych bandazi (hand wrap winder) - parametricky model pro 3D tisk.

Spusteni (lokalne i v Google Colabu):
    pip install trimesh manifold3d numpy
    python hand_wrap_winder.py            # vytvori hand_wrap_winder.stl

Princip: plochy ram (paddle) se otaci kolem osy X. Levou rukou drzis volnou
rukojet, pravou tocis klikou -> bandaz se namota na ram. Vse je print-in-place:
rukojet i klika jsou na cepech s vuli, tisknou se v jednom kuse, bez podpor.

Orientace pro tisk: ram lezi na podlozce (Z = 0 je spodek), osa X je delka.
Vsechny rozmery jsou v mm.
"""
import sys

import numpy as np
import manifold3d as m3d
import trimesh
from manifold3d import CrossSection, Manifold

# ----------------------------------------------------------------- parametry
FRAME_L = 90.0       # delka ramu (osa X) - bandaz siroky ~50 mm se vejde s rezervou
FRAME_W = 80.0       # sirka ramu (osa Y) - urcuje obvod navinuti
FRAME_T = 14.0       # tloustka ramu (osa Z)
RIM = 8.0            # sirka okraje ramu
RIB = 7.0            # sirka zeber uvnitr ramu
EDGE_R = 4.0         # zaobleni dlouhych hran (aby se bandaz nezadrhaval)
CORNER_R = 10.0      # zaobleni rohu v pudorysu
WIN_R = 4.0          # zaobleni oken

PIN_D = 8.0          # prumer cepu
CLR = 0.5            # radialni vule rukojeti/kliky na cepu (u hrubsich trysek zvys na 0.6)
GAP_X = 0.6          # osova vule
HEAD_D = 14.0        # prumer hlavy cepu (zaviraci)
HEAD_L = 3.0         # tloustka hlavy
FILLET_L = 4.0       # kuzelovy naběh cepu u ramu (pevnost)

GRIP_L = 70.0        # delka rukojeti (levy konec)
GRIP_D = 26.0        # prumer rukojeti
KNOB_L = 38.0        # delka kliky
KNOB_D = 22.0        # prumer kliky
CRANK_R = 30.0       # polomer kliky od osy otaceni (Y)

SEG = 96             # rozliseni valcu

Z0 = FRAME_T / 2     # osa otaceni lezi ve vysce stredu ramu


def to_x(m: Manifold) -> Manifold:
    """Valec/profil vytlaceny v Z -> natoceny tak, aby osa mirila do +X."""
    return m.rotate([0, 90, 0])


def cyl_x(x0, length, r, y, z, r_end=None):
    """Valec s osou rovnobeznou s X od x0 do x0+length (length muze byt <0)."""
    c = Manifold.cylinder(abs(length), r, r if r_end is None else r_end, SEG)
    c = to_x(c)  # od x=0 do x=+|length|
    if length < 0:
        c = c.mirror([1, 0, 0])
    return c.translate([x0, y, z])


def rounded_rect_xs(w, h, r):
    cs = CrossSection.square([w - 2 * r, h - 2 * r], center=True)
    return cs.offset(r, m3d.JoinType.Round, 2.0, SEG // 2)


def build_frame() -> Manifold:
    # tyc s plne zaoblenymi dlouhymi hranami (profil v YZ vytlacen podel X)
    prof = rounded_rect_xs(FRAME_T, FRAME_W, EDGE_R)       # x->Z, y->Y
    bar = to_x(Manifold.extrude(prof, FRAME_L))            # x-ose=X, Z<-x
    bar = bar.translate([0, 0, Z0])

    # zaobleni rohu v pudorysu
    outline = rounded_rect_xs(FRAME_L, FRAME_W, CORNER_R)
    outline = Manifold.extrude(outline, FRAME_T).translate([FRAME_L / 2, 0, 0])
    frame = bar ^ outline  # intersection

    # okna 3 x 2, uprostred podelne zebro
    inner_x0, inner_x1 = RIM, FRAME_L - RIM
    n_x = 3
    win_w = (inner_x1 - inner_x0 - (n_x - 1) * RIB) / n_x
    win_h = (FRAME_W - 2 * RIM - RIB) / 2
    for i in range(n_x):
        cx = inner_x0 + win_w / 2 + i * (win_w + RIB)
        for sgn in (-1, 1):
            cy = sgn * (RIB / 2 + win_h / 2)
            w = rounded_rect_xs(win_w, win_h, WIN_R)
            w = Manifold.extrude(w, FRAME_T + 2).translate([cx, cy, -1])
            frame = frame - w
    return frame


def build_axle(x_face, direction, y, sleeve_l, outer_d):
    """Cep + volne otocna objimka (print-in-place).

    x_face    - X souradnice steny ramu, ze ktere cep vychazi
    direction - +1 (doprava) / -1 (doleva)
    Vraci (cep_s_hlavou, objimka).
    """
    s = direction
    pin_r = PIN_D / 2
    # cep: zapusten 2 mm do ramu, kuzelovy naběh, valec, hlava
    embed = 2.0
    fillet = cyl_x(x_face - s * embed, s * (embed + FILLET_L), HEAD_D / 2, y, Z0, pin_r)
    x = x_face + s * FILLET_L
    sleeve_start = x + s * GAP_X
    sleeve_end = sleeve_start + s * sleeve_l
    head_start = sleeve_end + s * GAP_X
    pin = cyl_x(x_face, head_start - x_face, pin_r, y, Z0)
    head = cyl_x(head_start, s * HEAD_L, HEAD_D / 2, y, Z0)
    pin_all = fillet + pin + head

    # objimka: vnejsi valec tecny k podlozce (Z=0), otvor soustredny s cepem
    outer_r = outer_d / 2
    outer = cyl_x(sleeve_start, s * sleeve_l, outer_r, y, outer_r)
    bore = cyl_x(sleeve_start - s * 1, s * (sleeve_l + 2), pin_r + CLR, y, Z0)
    sleeve = outer - bore
    return pin_all, sleeve


def build() -> Manifold:
    frame = build_frame()
    # leva rukojet na ose (Y=0), klika vpravo na polomeru CRANK_R
    pin_l, grip = build_axle(0.0, -1, 0.0, GRIP_L, GRIP_D)
    pin_r, knob = build_axle(FRAME_L, +1, CRANK_R, KNOB_L, KNOB_D)
    body = frame + pin_l + pin_r
    return Manifold.compose([body, grip, knob])


def main(out="hand_wrap_winder.stl"):
    m = build()
    mesh = m.to_mesh()
    tm = trimesh.Trimesh(vertices=mesh.vert_properties[:, :3], faces=mesh.tri_verts)
    # Z=0 = spodek (vsechny dily lezi na podlozce)
    tm.apply_translation([0, 0, -tm.bounds[0][2]])
    tm.export(out)
    print(f"{out}: watertight={tm.is_watertight}, objem={tm.volume/1000:.1f} cm3, "
          f"rozmer={np.round(tm.extents, 1)} mm, teles={len(tm.split(only_watertight=False))}")


if __name__ == "__main__":
    main(*sys.argv[1:])
