#!/usr/bin/env python3
"""trace-stinger.py — trasovací emulátor hlavního CPU Stingeru (ST-M1 pomůcka pro disassemblaci).

Emuluje Z80 + paměťovou mapu (MAME wiz.cpp stinger main_map), NMI 1×/snímek (60 Hz), DIP tovární,
vstupy ze skriptu. Zvukový CPU se neemuluje — zápisy do F800h (latch) a F808/F80A se logují.

Použití:
    ./trace-stinger.py --frames 600 [--input skript.txt] [--cov coverage.txt] [--shot N=out.png ...]
                       [--trace-ram] [--dump N=out.bin]

Skript vstupů: řádky "snímek klávesy" (klávesy: c=mince, 1=start1, l r u d = páka, f=fire, b=bongo),
platí od daného snímku do dalšího řádku. Např.:
    10 c
    12
    40 1
    42

Výstupy:
  --cov      seznam adres provedených opkódů (jeden hex na řádek) -> hints `code`
  --shot     PNG obrazu (224×256, orientace hráče) po snímku N — render dvou vrstev + sprajtů
             podle data/tiles.json, data/sprites.json, data/palette.json
  --dump     surový dump RAM C000–C7FF + VRAM/ATTR/SPR + registry po snímku N
  --trace-ram  vypíše adresy RAM, do kterých program zapsal (kolikrát) -> RAMUse
"""
import argparse
import json
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)
from z80emu import Z80  # noqa: E402

DSW0 = 0xEF   # coin A 1C/1C (07), 3 životy (08), bonus 20000/50000 (E0) — MAME PORT_DIPSETTING defaults
DSW1 = 0xAE   # debug off (00), coin B 1C/1C (0E), Bongo Medium (20), Normal (00), upright (80)


class StingerBus:
    def __init__(self, opcodes, program):
        self.opc = opcodes
        self.rom = program
        self.ram = bytearray(0x800)
        self.vram = [bytearray(0x400), bytearray(0x400)]   # [0]=E000 pozadí, [1]=D000 popředí
        self.cram = [bytearray(0x400), bytearray(0x400)]
        self.attr = [bytearray(0x40), bytearray(0x40)]
        self.spr = [bytearray(0x20), bytearray(0x20)]
        self.nmi_en = 0
        self.palbank = [0, 0]
        self.charbank = [0, 0]
        self.flip = [0, 0]
        self.bgcolor = 0
        self.in0 = 0
        self.in1 = 0
        self.latch_log = []      # (frame, value)
        self.shot_log = []
        self.boom_log = []
        self.frame = 0
        self.ram_writes = {}
        self.trace_ram = False
        self.watchdog = 0

    def fetch(self, a):
        if a < 0xA000:
            return self.opc[a]
        return self.read(a)

    def read(self, a):
        if a < 0xA000: return self.rom[a]
        if a < 0xC000: return 0xFF
        if a < 0xC800: return self.ram[a - 0xC000]
        if 0xD000 <= a < 0xD400: return self.vram[1][a - 0xD000]
        if 0xD400 <= a < 0xD800: return self.cram[1][a - 0xD400]
        if 0xD800 <= a < 0xD840: return self.attr[1][a - 0xD800]
        if 0xD840 <= a < 0xD860: return self.spr[1][a - 0xD840]
        if 0xE000 <= a < 0xE400: return self.vram[0][a - 0xE000]
        if 0xE400 <= a < 0xE800: return self.cram[0][a - 0xE400]
        if 0xE800 <= a < 0xE840: return self.attr[0][a - 0xE800]
        if 0xE840 <= a < 0xE860: return self.spr[0][a - 0xE840]
        if a == 0xF000: return DSW0
        if a == 0xF008: return DSW1
        if a == 0xF010: return self.in0
        if a == 0xF018: return self.in1
        if a == 0xF800: self.watchdog = 0; return 0xFF
        return 0xFF

    def write(self, a, v):
        if a < 0xC000: return
        if a < 0xC800:
            self.ram[a - 0xC000] = v
            if self.trace_ram: self.ram_writes[a] = self.ram_writes.get(a, 0) + 1
            return
        if 0xD000 <= a < 0xD400: self.vram[1][a - 0xD000] = v; return
        if 0xD400 <= a < 0xD800: self.cram[1][a - 0xD400] = v; return
        if 0xD800 <= a < 0xD840: self.attr[1][a - 0xD800] = v; return
        if 0xD840 <= a < 0xD860: self.spr[1][a - 0xD840] = v; return
        if 0xE000 <= a < 0xE400: self.vram[0][a - 0xE000] = v; return
        if 0xE400 <= a < 0xE800: self.cram[0][a - 0xE400] = v; return
        if 0xE800 <= a < 0xE840: self.attr[0][a - 0xE800] = v; return
        if 0xE840 <= a < 0xE860: self.spr[0][a - 0xE840] = v; return
        if a == 0xF001: self.nmi_en = v & 1; return
        if a in (0xF002, 0xF003): self.palbank[a - 0xF002] = v & 1; return
        if a in (0xF004, 0xF005): self.charbank[a - 0xF004] = v & 1; return
        if a in (0xF006, 0xF007): self.flip[a - 0xF006] = v & 1; return
        if a == 0xF800: self.latch_log.append((self.frame, v)); return
        if a == 0xF808: self.boom_log.append(self.frame); return
        if a == 0xF80A: self.shot_log.append(self.frame); return
        if a == 0xF818: self.bgcolor = v; return

    def in_(self, port): return 0xFF
    def out(self, port, v): pass


# ---- render ------------------------------------------------------------------------------------
def png(width, height, rgb):
    raw = b"".join(b"\x00" + bytes(rgb[y * width * 3:(y + 1) * width * 3]) for y in range(height))
    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) \
        + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


class Renderer:
    """Port MAME screen_update (stinger) do orientace hráče: hw (hx, hy) -> player (223 - (hy-16), hx)...
    ve skutečnosti: hw obraz 256(š)×256(v), viditelné hy 16..239; ROT90 => px = 239 - hy, py = hx."""
    def __init__(self):
        d = os.path.join(ROOT, "data")
        self.tiles = json.load(open(os.path.join(d, "tiles.json")))
        self.sprites = json.load(open(os.path.join(d, "sprites.json")))
        pal = json.load(open(os.path.join(d, "palette.json")))["pens"]
        self.pens = [(int(p[1:3], 16), int(p[3:5], 16), int(p[5:7], 16)) for p in pal]

    def render(self, bus):
        W, H = 224, 256
        # hw framebuffer 256x256 pen indexes, pak otočit
        fb = bytearray([bus.bgcolor]) * (256 * 256)
        palbank = (bus.palbank[1] << 4) | (bus.palbank[0] << 3)
        def draw_layer(layer, region):
            tiles = self.tiles[region][bus.charbank[layer]]
            vram, attr = bus.vram[layer], bus.attr[layer]
            for offs in range(0x3FF, -1, -1):
                code = vram[offs]
                sx = offs & 0x1F
                sy = offs >> 5
                color = attr[(sx << 1) | 1] & 7
                scroll = (8 * sy + 256 - attr[sx << 1]) & 0xFF
                t = tiles[code]
                pen_base = (palbank | color) * 8
                # dlaždice je uložená v orientaci hráče: t[py*8+px], px = 7-hy_in, py = hx_in
                for hy_in in range(8):
                    hy = (scroll + hy_in) & 0xFF
                    row = hy * 256 + sx * 8
                    for hx_in in range(8):
                        pix = ord(t[hx_in * 8 + (7 - hy_in)]) - 48
                        if pix:
                            fb[row + hx_in] = pen_base + pix
        def draw_sprites(setn, region):
            spr = bus.spr[setn]
            sprites = self.sprites[region]
            for offs in range(0x1C, -1, -4):
                code = spr[offs + 1]; sx = spr[offs + 3]; sy = spr[offs]
                color = spr[offs + 2] & 7
                if not sx or not sy: continue
                if setn == 0 and offs <= 8: sy -= 1
                sy = 240 - sy
                s = sprites[code]
                pen_base = (palbank | color) * 8
                for hy_in in range(16):
                    hy = sy + hy_in
                    if not 0 <= hy < 256: continue
                    for hx_in in range(16):
                        hx = sx + hx_in
                        if not 0 <= hx < 256: continue
                        pix = ord(s[hx_in * 16 + (15 - hy_in)]) - 48
                        if pix:
                            fb[hy * 256 + hx] = pen_base + pix
        draw_layer(0, "gfx2")
        draw_layer(1, "gfx1")
        draw_sprites(1, "gfx1")
        draw_sprites(0, "gfx2")
        rgb = bytearray(W * H * 3)
        for py in range(H):
            hx = py
            for px in range(W):
                hy = 239 - px
                r, g, b = self.pens[fb[hy * 256 + hx]]
                i = (py * W + px) * 3
                rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b
        return png(W, H, rgb)


# ---- vstupy ------------------------------------------------------------------------------------
KEYS0 = {"c": 0x01, "b": 0x04, "2": 0x08, "1": 0x10, "f": 0x40}
KEYS1 = {"r": 0x01, "l": 0x02, "u": 0x10, "d": 0x20}


def load_input(path):
    if not path:
        return []
    ev = []
    for ln in open(path):
        ln = ln.split("#", 1)[0].strip()
        if not ln: continue
        parts = ln.split()
        ev.append((int(parts[0]), parts[1] if len(parts) > 1 else ""))
    return sorted(ev)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--frames", type=int, default=600)
    ap.add_argument("--input")
    ap.add_argument("--cov")
    ap.add_argument("--shot", action="append", default=[])
    ap.add_argument("--dump", action="append", default=[])
    ap.add_argument("--trace-ram", action="store_true")
    ap.add_argument("--ram-trace", help="soubor: každý snímek hodnoty vybraných adres (čárkou, hex)")
    ap.add_argument("--ram-addrs", default="c0a2")
    ap.add_argument("--ipf", type=int, default=51200, help="instrukcí za snímek (3.072 MHz / 60 / ~10 T ≈ 5 100 instr.; default 51200 = hrubě 10× rezerva pro smyčky čekání)")
    a = ap.parse_args()

    rom_dir = os.path.join(ROOT, "sources/rom/stinger/decrypted")
    opc = open(os.path.join(rom_dir, "opcodes.bin"), "rb").read()
    prg = open(os.path.join(rom_dir, "program.bin"), "rb").read()
    bus = StingerBus(opc, prg)
    bus.trace_ram = a.trace_ram
    cpu = Z80(bus)
    cpu.pc = 0
    events = load_input(a.input)
    shots = {int(s.split("=")[0]): s.split("=")[1] for s in a.shot}
    dumps = {int(s.split("=")[0]): s.split("=")[1] for s in a.dump}
    renderer = Renderer() if shots else None
    cov = set() if a.cov else None
    trace_addrs = [int(x, 16) for x in a.ram_addrs.split(",")]
    trace_f = open(a.ram_trace, "w") if a.ram_trace else None
    if trace_f:
        trace_f.write("frame\t" + "\t".join(f"{x:04X}" for x in trace_addrs) + "\tlatch\n")

    ei = 0
    for frame in range(a.frames):
        bus.frame = frame
        while ei < len(events) and events[ei][0] <= frame:
            keys = events[ei][1]
            bus.in0 = sum(KEYS0.get(k, 0) for k in keys)
            bus.in1 = sum(KEYS1.get(k, 0) for k in keys)
            ei += 1
        # snímek: NMI na začátku (VBLANK), pak běh CPU
        if bus.nmi_en:
            cpu.nmi_pending = True
        latch_before = len(bus.latch_log)
        for _ in range(a.ipf):
            if cov is not None:
                cov.add(cpu.pc)
            cpu.step()
        if trace_f:
            vals = "\t".join(f"{bus.read(x):02X}" for x in trace_addrs)
            latches = ",".join(f"{v:02X}" for _, v in bus.latch_log[latch_before:])
            trace_f.write(f"{frame}\t{vals}\t{latches}\n")
        if frame in shots:
            open(shots[frame], "wb").write(renderer.render(bus))
            print(f"snímek {frame}: {shots[frame]}")
        if frame in dumps:
            with open(dumps[frame], "wb") as f:
                f.write(bus.ram); f.write(bus.vram[1]); f.write(bus.attr[1]); f.write(bus.spr[1])
                f.write(bus.vram[0]); f.write(bus.attr[0]); f.write(bus.spr[0])
                f.write(bytes([bus.nmi_en, bus.palbank[0], bus.palbank[1], bus.charbank[0], bus.charbank[1], bus.bgcolor]))
    if cov is not None:
        with open(a.cov, "w") as f:
            for x in sorted(cov):
                if x < 0xA000:
                    f.write(f"{x:04X}\n")
        print(f"pokrytí: {sum(1 for x in cov if x < 0xA000)} adres -> {a.cov}")
    if a.trace_ram:
        print("zápisy do RAM (adresa: počet):")
        for k in sorted(bus.ram_writes):
            print(f"  {k:04X}: {bus.ram_writes[k]}")
    print(f"latch zápisy: {len(bus.latch_log)}, výstřely: {len(bus.shot_log)}, exploze: {len(bus.boom_log)}")
    print("prvních latchů:", [(f, hex(v)) for f, v in bus.latch_log[:20]])
    print(f"PC={cpu.pc:04X} SP={cpu.sp:04X} halted={cpu.halted} nmi_en={bus.nmi_en}")


if __name__ == "__main__":
    main()
