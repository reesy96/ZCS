# FBG půdní senzor, díly v41 (kelímek a botička)

Upravené díly k modelu v40 (`v40_vse.stl`). Vnitřní díly (základna, deska, pouzdro)
se nemění, mění se jen kelímky a botičky, aby šlo vlákno osadit už se svařeným
SC/APC konektorem.

| soubor | co je jinak proti v40 |
|---|---|
| `kelimek_v41_dira13.stl` | střední otvor ve dně 10 → 13 mm (projde SC/APC), jinak beze změny |
| `kelimek_v41_dira13_perforovany.stl` | totéž plus perforace: 2 řady po 12 otvorech Ø3 ve stěně (z 5,5 a 11,5 mm, pod rampami bajonetu), 18 otvorů Ø3 ve dně |
| `boticka_v41_drazka.stl` | drážka 1,3 mm po celé výšce na straně −X (naproti zápaďce a výřezu pro lepidlo), vlákno se zasune z boku; příruba 13,4 → 17 mm, aby kryla otvor 13 |
| `boticka_v41_drazka_nakruzek.stl` | totéž plus nákružek 2,5 mm (Ø12,6 / Ø8,8) pod přírubou, který zajede do otvoru 13 v kelímku a utěsní ho |

Bajonetové rampy kelímku (z 17 až 24,2 mm) jsou nedotčené, ověřeno řezem. Tisk 2× kelímek, 2× botička,
ABS nebo PC, bez podpor. Botička s nákružkem se tiskne postavená na nákružku (špičkou nahoru), dej brim.

Před tiskem změř úhlopříčku svého SC/APC konektoru. Běžné tělo je cca 9 × 7,5 mm, úhlopříčka
12 mm, proto otvor 13. Pokud máš větší (s klipem, s boot), změň `DIRA_KELIMEK` ve skriptu.

## Regenerace

```bash
pip install trimesh manifold3d numpy scipy rtree shapely
python3 uprava_v41.py v40_vse.stl .
```

Parametry nahoře ve skriptu: `DIRA_KELIMEK`, `PERF_D`, `DRAZKA_W`, `PRIRUBA_D`, `NAKRUZEK_*`.
