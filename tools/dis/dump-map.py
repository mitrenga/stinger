#!/usr/bin/env python3
"""dump-map.py — vykreslí mapová data Stingeru (pozadí kol, pevnost, titulní obrazovku) z ROM do PNG.

Formát dat (viz sources/asm/stinger/notes/B.md):
  * vrstva 0 (pozadí, VRAM0 E000h): stránka 1 KiB = 32 sloupců × 32 B; sloupec = 32 kódů dlaždic gfx2
    shora dolů (hráčova osa y), sloupce jdou v pořadí, v jakém se nasouvají zprava.  Kolo n používá
    stránku 57A0h[n] (horní bajt adresy); kódy < A0h ze stránek < 6000h a >= 9800h se překládají
    tabulkou podle kola (1F67h/2007h/20A7h/2147h, viz S_1F0F).  Barva sloupců je 2, banky palety/znaků
    dává 5740h[n] (bit1 F002, bit2 F003, bit3 F004, bit4 F005).
  * vrstva 1 (pevnost, VRAM1 D000h, jen dolní polovina obrazu): sloupec = 16 kódů gfx1 (y 128..255),
    bloky 200h B = 32 sloupců na 6000h/6200h/6400h/6600h/6800h; kolo n začíná na 6000h + 5700h[n]·100h
    a smyčkuje podle 1E53h.  Barva 5780h[n] (=1).
  * titul: 5000h = obraz VRAM1 (1 KiB), 5400h = atributy (40h B); pozadí titulu = stránky 4C00h/5C00h.

Použití:
    python3 tools/dis/dump-map.py [--out DIR]      # výchozí DIR = data/map
Výstup:
    map-rounds.png    pás 32 kol × 256 px (pozadí vrstvy 0, s bankami/paletou daného kola), kolo 0 = úvod
    map-pages.png     všech 9 rozlišitelných stránek pozadí (4800,4C00,5C00,6C00,7000,7400,7800,7C00,9800)
                      bez překladu kódů, banka 0, paleta kola 1
    map-fortress.png  bloky pevnosti 6000h–69FFh (5 × 32 sloupců × 16 řádků)
    map-title.png     titulní obrazovka (vrstva 1 z 5000h + atributy 5400h nad pozadím 4C00h)
"""
import argparse
import json
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))

ROM = open(os.path.join(ROOT, "sources/rom/stinger/decrypted/program.bin"), "rb").read()
TILES = json.load(open(os.path.join(ROOT, "data/tiles.json")))
PENS = [(int(p[1:3], 16), int(p[3:5], 16), int(p[5:7], 16))
        for p in json.load(open(os.path.join(ROOT, "data/palette.json")))["pens"]]

LEVEL_FORTRESS = 0x5700   # 5700h[n]: horní bajt bloku pevnosti (00/02/04/06) → 6000h + n·100h
LEVEL_VIDEOREG = 0x5740   # 5740h[n]: bity registrů F001..F005 (S_22C4)
LEVEL_FCOLOR = 0x5780     # 5780h[n]: barva sloupců pevnosti
LEVEL_BGPAGE = 0x57A0     # 57A0h[n]: horní bajt stránky pozadí
REMAP_TABLES = [0x1F67, 0x2007, 0x20A7, 0x2147]
BG_PAGES = [0x4800, 0x4C00, 0x5C00, 0x6C00, 0x7000, 0x7400, 0x7800, 0x7C00, 0x9800]


def remap_table(level):
    """S_1F0F (1F1E–1F45): tabulka překladu kódů podle čísla kola."""
    if level < 7: return REMAP_TABLES[0]
    if level < 0x10: return REMAP_TABLES[1]
    if level < 0x14: return REMAP_TABLES[2]
    if level < 0x1A: return REMAP_TABLES[3]
    return REMAP_TABLES[2]


def video_regs(level):
    v = ROM[LEVEL_VIDEOREG + level]
    palbank = ((v >> 1) & 1) | (((v >> 2) & 1) << 1)
    return palbank, (v >> 3) & 1, (v >> 4) & 1   # palbank, charbank0 (vrstva 0), charbank1 (vrstva 1)


class Canvas:
    def __init__(self, w, h, bg=(24, 24, 24)):
        self.w, self.h = w, h
        self.buf = bytearray(bytes(bg) * (w * h))

    def tile(self, region, bank, code, x0, y0, pen_base):
        t = TILES[region][bank][code]
        for py in range(8):
            row = (y0 + py) * self.w
            for px in range(8):
                pix = ord(t[py * 8 + px]) - 48
                if pix:
                    i = (row + x0 + px) * 3
                    self.buf[i:i + 3] = bytes(PENS[pen_base + pix])

    def png(self, path):
        raw = b"".join(b"\x00" + bytes(self.buf[y * self.w * 3:(y + 1) * self.w * 3]) for y in range(self.h))
        def chunk(t, d):
            c = t + d
            return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
        with open(path, "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", self.w, self.h, 8, 2, 0, 0, 0))
                    + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def draw_bg_page(cv, page, x0, y0, level, remap=True, palbank=None, charbank=None, color=2):
    """32 sloupců × 32 B stránky pozadí; sloupec c → x = x0 + 8c, bajt i → y = y0 + 8i."""
    pb, cb0, _ = video_regs(level)
    if palbank is not None: pb = palbank
    if charbank is not None: cb0 = charbank
    tab = remap_table(level)
    do_remap = remap and (page < 0x6000 or page >= 0x9800)
    pen_base = ((pb << 3) | color) * 8
    for c in range(32):
        for i in range(32):
            code = ROM[page + c * 32 + i]
            if do_remap and code < 0xA0:
                code = ROM[tab + code]
            cv.tile("gfx2", cb0, code, x0 + 8 * c, y0 + 8 * i, pen_base)


def draw_fortress_block(cv, addr, x0, y0, level, color=1):
    """32 sloupců × 16 B (dolní polovina obrazu, y 128..255)."""
    _, _, cb1 = video_regs(level)
    pb = video_regs(level)[0]
    pen_base = ((pb << 3) | color) * 8
    for c in range(32):
        for i in range(16):
            cv.tile("gfx1", cb1, ROM[addr + c * 16 + i], x0 + 8 * c, y0 + 8 * i, pen_base)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "map"))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    # 1. pás kol 0..31 (kolo 0 = úvodní obraz 7400h, poté 57A0h[1..31])
    cv = Canvas(32 * 260, 256)
    for lv in range(32):
        page = ROM[LEVEL_BGPAGE + lv] << 8
        draw_bg_page(cv, page, lv * 260, 0, lv)
    cv.png(os.path.join(a.out, "map-rounds.png"))

    # 2. samostatné stránky bez překladu
    cv = Canvas(256, len(BG_PAGES) * 260)
    for k, page in enumerate(BG_PAGES):
        draw_bg_page(cv, page, 0, k * 260, 1, remap=False, palbank=3, charbank=0)
    cv.png(os.path.join(a.out, "map-pages.png"))

    # 3. pevnost
    cv = Canvas(256, 5 * 132)
    for k in range(5):
        draw_fortress_block(cv, 0x6000 + k * 0x200, 0, k * 132, 1)
    cv.png(os.path.join(a.out, "map-fortress.png"))

    # 4. titul: obraz 5000h (vrstva 1) s barvami sloupců 5400h[2·sx+1], paleta 1 (S_22C4(02h)),
    #    v orientaci hráče 224×256: hw sloupec sx = hráčův řádek y = 8·sx, hw řádek sy → x = 216 − 8·sy
    #    (sy 0,1,30,31 jsou mimo viditelných 224 px). Pozadí (stránky 4C00h/5C00h) se pod ním scrolluje, není vykresleno.
    cv = Canvas(224, 256, bg=(0, 0, 0))
    for sx in range(32):
        color = ROM[0x5401 + 2 * sx] & 7
        for sy in range(2, 30):
            cv.tile("gfx1", 0, ROM[0x5000 + sy * 32 + sx], 216 - 8 * sy, 8 * sx, ((1 << 3) | color) * 8)
    cv.png(os.path.join(a.out, "map-title.png"))

    print("OK:", a.out)
    for lv in range(32):
        pb, cb0, cb1 = video_regs(lv)
        print(f"kolo {lv:2d}: pozadí {ROM[LEVEL_BGPAGE + lv]:02X}00h  pevnost {0x6000 + (ROM[LEVEL_FORTRESS + lv] << 8):04X}h"
              f"  paleta {pb} charbank0 {cb0} charbank1 {cb1}  překlad {remap_table(lv):04X}h"
              f"{' (bez překladu)' if 0x6000 <= ROM[LEVEL_BGPAGE + lv] << 8 < 0x9800 else ''}")


if __name__ == "__main__":
    main()
