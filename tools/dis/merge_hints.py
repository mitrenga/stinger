#!/usr/bin/env python3
"""merge_hints.py — sloučí sources/asm/stinger/hints.d/*.txt do hints-main.txt (za značku) a ověří adresy
proti aktuální main.asm. Řádky s adresou uvnitř instrukce nebo mimo ROM se vypustí a vypíšou; duplicitní
label/ram se hlásí (vyhrává první). Použití: python3 tools/dis/merge_hints.py && python3 tools/dis/disz80.py main
(Vzor: ~/sw/pleiades/sources/asm/pleiades/merge_hints.py.)"""
import glob, os, re
HERE = os.path.dirname(os.path.abspath(__file__))
ASM_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "sources", "asm", "stinger"))
ROM_SIZE = 0xA000
MARK = "; === hints.d (generováno merge_hints.py, needitovat ručně) ==="
asm_path = os.path.join(ASM_DIR, "main.asm")
inside = set()
if os.path.exists(asm_path):
    for l in open(asm_path, encoding="utf-8"):
        m = re.match(r"^([0-9A-F]{4})  ((?:[0-9A-F]{2} )+)\s*\t", l)
        if m:
            a = int(m.group(1), 16); n = len(m.group(2).split())
            inside.update(range(a + 1, a + n))
hints_path = os.path.join(ASM_DIR, "hints-main.txt")
base = open(hints_path, encoding="utf-8").read().split(MARK)[0].rstrip() + "\n"
seen = {}
for l in base.splitlines():
    p = l.split(";", 1)[0].split()
    if len(p) >= 3 and p[0] in ("label", "ram"):
        seen[(p[0], int(p[1], 0))] = "hints-main.txt"
out, dropped = [MARK], []
for f in sorted(glob.glob(os.path.join(ASM_DIR, "hints.d", "*.txt"))):
    name = os.path.basename(f)
    out.append(f"; --- {name} ---")
    for ln in open(f, encoding="utf-8"):
        l = ln.rstrip("\n")
        p = l.split(";", 1)[0].split()
        if not p:
            continue
        kind = p[0]
        if kind not in ("code", "data", "label", "comment", "ram", "ptrs"):
            dropped.append((name, l, "neznámý typ")); continue
        try:
            a = int(p[1] if kind != "ptrs" else p[2], 0)
        except (ValueError, IndexError):
            dropped.append((name, l, "adresa")); continue
        if kind in ("label", "comment", "code") and (a in inside or not 0 <= a < ROM_SIZE):
            dropped.append((name, l, "uvnitř instrukce / mimo ROM")); continue
        if kind == "ram" and not (0xC000 <= a <= 0xFFFF):
            dropped.append((name, l, "ram mimo C000–FFFF")); continue
        if kind in ("label", "ram"):
            if (kind, a) in seen:
                dropped.append((name, l, f"duplicita s {seen[(kind, a)]}")); continue
            seen[(kind, a)] = name
        out.append(l)
open(hints_path, "w", encoding="utf-8").write(base + "\n" + "\n".join(out) + "\n")
print(f"sloučeno {len(out)} řádků; vypuštěno {len(dropped)}")
for name, l, why in dropped:
    print(f"  {name}: {why}: {l}")
