#!/usr/bin/env python3
"""disz80.py — disassembler Z80 pro Stinger (Seibu Denshi 1983), ST-M1.

Použití:
    ./disz80.py main  [--hints hints-main.txt]  [--out ../../sources/asm/stinger/main.asm]
    ./disz80.py sound [--hints hints-sound.txt] [--out ../../sources/asm/stinger/sound.asm]

Vzor: ~/sw/pleiades/sources/asm/pleiades/dis8085.py (rekurzivní sledování toku od vstupních bodů,
oddělení kódu od dat, hinty, návěští L_/S_, symboly HW a RAM, křížové odkazy, DB bloky).

Odlišnost Stingeru — DVOJÍ OBRAZ: šifrovány jsou jen opkódy (M1 fetch). Opkód a prefixy CB/DD/ED/FD
se čtou z dešifrovaného obrazu, operandy z původního. U `DD CB d op` / `FD CB d op` jsou posun `d` i finální
`op` načteny bez M1 (MAME Z80 jádro: arg()), tedy z NEšifrovaného obrazu.
Obrazy: sources/rom/stinger/decrypted/opcodes.bin (dešifrované) a program.bin (surové);
vyrobí je tools/decrypt-stinger.mjs. `sound` má jen jeden (nešifrovaný) obraz 6-9f.bin.

Soubor hints — řádky (jako u dis8085):
    code 0x1234              ; další vstupní bod kódu (cíl JP (HL) / tabulky)
    data 0x2000 0x20ff       ; rozsah je určitě data
    label 0x0552 name
    comment 0x0552 text
    ram 0xc000 name          ; symbol pro RAM/HW adresu
    ptrs lohi 0x3f00 0x3fff  ; tabulka 16bit ukazatelů na kód (Z80 = lohi), každý platný = vstupní bod
    ptrs lohi 0x3f00 0x3fff step 3  ; volitelný krok záznamu (např. 3 B: ptr + parametr)
"""
import argparse
import hashlib
import os
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))

CPUS = {
    "main": {
        "size": 0xA000,
        "opcodes": os.path.join(ROOT, "sources/rom/stinger/decrypted/opcodes.bin"),
        "data": os.path.join(ROOT, "sources/rom/stinger/decrypted/program.bin"),
        "vectors": [0x0000, 0x0066],   # RST 0 reset, NMI
        "title": "Stinger (Seibu Denshi 1983) — hlavní CPU Z80, programová ROM 0000h–9FFFh (5 × 8 KiB, opkódy šifrované)",
        "hw": [  # (od, do, symbol, popis) — MAME wiz.cpp stinger main_map
            (0xC000, 0xC7FF, "RAM", "pracovní RAM 2 KiB"),
            (0xD000, 0xD3FF, "VRAM1", "video RAM vrstvy 1 (popředí), 32×32 kódů dlaždic"),
            (0xD400, 0xD7FF, "CRAM1", "color RAM vrstvy 1 (u Stingeru nevyužito, jen Wiz)"),
            (0xD800, 0xD83F, "ATTR1", "atributy vrstvy 1: [2n] scroll sloupce n, [2n+1] barva (3 bity)"),
            (0xD840, 0xD85F, "SPR1", "sprite RAM 1 (8 × 4 B: Y, kód, barva, X) — kreslí se z gfx1"),
            (0xE000, 0xE3FF, "VRAM0", "video RAM vrstvy 0 (pozadí)"),
            (0xE400, 0xE7FF, "CRAM0", "color RAM vrstvy 0 (nevyužito)"),
            (0xE800, 0xE83F, "ATTR0", "atributy vrstvy 0"),
            (0xE840, 0xE85F, "SPR0", "sprite RAM 0 (8 × 4 B) — kreslí se z gfx2"),
            (0xF000, 0xF000, "DSW0", "R: DIP 1 (mince A, životy, bonus)"),
            (0xF001, 0xF001, "NMI_EN", "W: povolení NMI (bit 0)"),
            (0xF002, 0xF002, "PALBANK0", "W: banka palety bit 0"),
            (0xF003, 0xF003, "PALBANK1", "W: banka palety bit 1"),
            (0xF004, 0xF004, "CHARBANK0", "W: banka znaků vrstvy 0 (gfx2)"),
            (0xF005, 0xF005, "CHARBANK1", "W: banka znaků vrstvy 1 (gfx1)"),
            (0xF006, 0xF006, "FLIPX", "W: flip X"),
            (0xF007, 0xF007, "FLIPY", "W: flip Y"),
            (0xF008, 0xF008, "DSW1", "R: DIP 2 (test play, mince B, Bongo time, obtížnost, kabinet)"),
            (0xF010, 0xF010, "IN0", "R: mince/start/tlačítka"),
            (0xF018, 0xF018, "IN1", "R: páka"),
            (0xF800, 0xF800, "SOUNDLATCH", "R: watchdog reset; W: příkaz zvukovému CPU"),
            (0xF808, 0xF808, "SND_BOOM", "W: trigger diskrétní exploze"),
            (0xF80A, 0xF80A, "SND_SHOT", "W: trigger diskrétního výstřelu"),
            (0xF818, 0xF818, "BGCOLOR", "W: barva pozadí (index palety)"),
        ],
    },
    "sound": {
        "size": 0x2000,
        "opcodes": os.path.join(ROOT, "sources/rom/stinger/6-9f.bin"),
        "data": None,
        "vectors": [0x0000, 0x0066],
        "title": "Stinger — zvukový CPU Z80, ROM 6-9f.bin 0000h–1FFFh (2× AY-3-8910)",
        "hw": [
            (0x2000, 0x23FF, "RAM", "RAM zvukového CPU 1 KiB"),
            (0x3000, 0x3000, "LATCH", "R: příkaz z hlavního CPU; W: povolení NMI"),
            (0x4000, 0x4000, "UNK4000", "W: neznámé (MAME nop)"),
            (0x5000, 0x5000, "AY1_ADDR", "W: AY-3-8910 #1 adresa registru"),
            (0x5001, 0x5001, "AY1_DATA", "W: AY-3-8910 #1 data"),
            (0x6000, 0x6000, "AY2_ADDR", "W: AY-3-8910 #2 adresa registru"),
            (0x6001, 0x6001, "AY2_DATA", "W: AY-3-8910 #2 data"),
        ],
    },
}

# ---- dekodér Z80 --------------------------------------------------------------------------------
R8 = ["B", "C", "D", "E", "H", "L", "(HL)", "A"]
RP = ["BC", "DE", "HL", "SP"]
RP2 = ["BC", "DE", "HL", "AF"]
CC = ["NZ", "Z", "NC", "C", "PO", "PE", "P", "M"]
ALU = ["ADD A,", "ADC A,", "SUB ", "SBC A,", "AND ", "XOR ", "OR ", "CP "]
ROT = ["RLC", "RRC", "RL", "RR", "SLA", "SRA", "SLL", "SRL"]
BLI = {0xA0: "LDI", 0xA1: "CPI", 0xA2: "INI", 0xA3: "OUTI", 0xA8: "LDD", 0xA9: "CPD", 0xAA: "IND", 0xAB: "OUTD",
       0xB0: "LDIR", 0xB1: "CPIR", 0xB2: "INIR", 0xB3: "OTIR", 0xB8: "LDDR", 0xB9: "CPDR", 0xBA: "INDR", 0xBB: "OTDR"}


class Insn:
    __slots__ = ("addr", "length", "text", "flow", "target", "raw")

    def __init__(self, addr, length, text, flow="", target=None, raw=b""):
        self.addr, self.length, self.text, self.flow, self.target, self.raw = addr, length, text, flow, target, raw


def decode(opc, dat, pc, size):
    """Dekóduje instrukci na pc. Opkód (a prefixy) z `opc`, operandy z `dat`.
    flow: '' | 'jmp' | 'jcc' | 'call' | 'ccc' | 'ret' | 'rcc' | 'rst' | 'stop' (JP (HL), HALT)."""
    def op(i):
        return opc[(pc + i) % size]

    def arg(i):
        return dat[(pc + i) % size]

    def imm16(i):
        return arg(i) | (arg(i + 1) << 8)

    def rel(i):
        d = arg(i)
        return (pc + i + 1 + (d - 256 if d > 127 else d)) & 0xFFFF

    b = op(0)
    if b in (0xDD, 0xFD):
        ix = "IX" if b == 0xDD else "IY"
        b2 = op(1)
        if b2 == 0xCB:
            d = arg(2)
            o = arg(3)   # u DDCB je finální opkód načten jako operand (bez M1) -> z datového obrazu
            disp = f"{ix}{d - 256 if d > 127 else d:+d}"
            x, y, z = o >> 6, (o >> 3) & 7, o & 7
            if x == 0:
                t = f"{ROT[y]} ({disp})" + (f",{R8[z]}" if z != 6 else "")
            elif x == 1:
                t = f"BIT {y},({disp})"
            elif x == 2:
                t = f"RES {y},({disp})" + (f",{R8[z]}" if z != 6 else "")
            else:
                t = f"SET {y},({disp})" + (f",{R8[z]}" if z != 6 else "")
            return Insn(pc, 4, t)
        # prefix DD/FD: dekódovat jako základní instrukci s HL->IX, (HL)->(IX+d)
        inner = decode_base(op, arg, imm16, rel, pc, 1, ix)
        if inner is None:
            return Insn(pc, 1, f"DB {b:02X}h ; prefix {ix} bez efektu")
        return inner
    if b == 0xCB:
        o = op(1)
        x, y, z = o >> 6, (o >> 3) & 7, o & 7
        t = [f"{ROT[y]} {R8[z]}", f"BIT {y},{R8[z]}", f"RES {y},{R8[z]}", f"SET {y},{R8[z]}"][x]
        return Insn(pc, 2, t)
    if b == 0xED:
        o = op(1)
        x, y, z, p, q = o >> 6, (o >> 3) & 7, o & 7, (o >> 4) & 3, (o >> 3) & 1
        if x == 1:
            if z == 0:
                return Insn(pc, 2, f"IN {R8[y] if y != 6 else 'F'},(C)")
            if z == 1:
                return Insn(pc, 2, f"OUT (C),{R8[y] if y != 6 else '0'}")
            if z == 2:
                return Insn(pc, 2, f"{'ADC' if q else 'SBC'} HL,{RP[p]}")
            if z == 3:
                a = imm16(2)
                return Insn(pc, 4, f"LD ({{a16}}),{RP[p]}" if not q else f"LD {RP[p]},({{a16}})", target=a) if False else \
                    Insn(pc, 4, (f"LD (%s),{RP[p]}" if not q else f"LD {RP[p]},(%s)"), "", a)
            if z == 4:
                return Insn(pc, 2, "NEG")
            if z == 5:
                return Insn(pc, 2, "RETI" if y == 1 else "RETN", "ret")
            if z == 6:
                return Insn(pc, 2, f"IM {[0, 0, 1, 2, 0, 0, 1, 2][y]}")
            if z == 7:
                return Insn(pc, 2, ["LD I,A", "LD R,A", "LD A,I", "LD A,R", "RRD", "RLD", "NOP", "NOP"][y])
        if x == 2 and o in BLI:
            return Insn(pc, 2, BLI[o])
        return Insn(pc, 2, f"DB EDh,{o:02X}h ; NONI")
    r = decode_base(op, arg, imm16, rel, pc, 0, "HL")
    return r


def decode_base(op, arg, imm16, rel, pc, i, hl):
    """Základní tabulka (bez prefixu CB/ED). i = 1 pro DD/FD prefix (hl = 'IX'/'IY'); pak (HL) -> (IX+d).
    Vrací Insn; text s '%s' + target pro a16."""
    b = op(i)
    x, y, z, p, q = b >> 6, (b >> 3) & 7, b & 7, (b >> 4) & 3, (b >> 3) & 1
    pre = i  # délka prefixu
    ixd = (hl != "HL")

    def r8(n, k):
        """registr n; k = offset dalšího operandu (pro (IX+d))"""
        if n == 6 and ixd:
            d = arg(k)
            return f"({hl}{d - 256 if d > 127 else d:+d})", 1
        if n in (4, 5) and ixd:
            return hl[0] + ("H" if n == 4 else "L"), 0   # IXH/IXL (nedokumentované)
        return R8[n], 0

    def rp(n):
        return hl if n == 2 else RP[n]

    L = pre + 1
    if x == 0:
        if z == 0:
            if y == 0: return Insn(pc, L, "NOP")
            if y == 1: return Insn(pc, L, "EX AF,AF'")
            if y == 2: return Insn(pc, L + 1, "DJNZ %s", "jcc", rel(pre + 1))
            if y == 3: return Insn(pc, L + 1, "JR %s", "jmp", rel(pre + 1))
            return Insn(pc, L + 1, f"JR {CC[y - 4]},%s", "jcc", rel(pre + 1))
        if z == 1:
            if q == 0: return Insn(pc, L + 2, f"LD {rp(p)},%s", "", imm16(pre + 1))
            return Insn(pc, L, f"ADD {hl},{rp(p)}")
        if z == 2:
            if q == 0:
                if p == 0: return Insn(pc, L, "LD (BC),A")
                if p == 1: return Insn(pc, L, "LD (DE),A")
                if p == 2: return Insn(pc, L + 2, f"LD (%s),{hl}", "", imm16(pre + 1))
                return Insn(pc, L + 2, "LD (%s),A", "", imm16(pre + 1))
            if p == 0: return Insn(pc, L, "LD A,(BC)")
            if p == 1: return Insn(pc, L, "LD A,(DE)")
            if p == 2: return Insn(pc, L + 2, f"LD {hl},(%s)", "", imm16(pre + 1))
            return Insn(pc, L + 2, "LD A,(%s)", "", imm16(pre + 1))
        if z == 3:
            return Insn(pc, L, f"{'DEC' if q else 'INC'} {rp(p)}")
        if z in (4, 5):
            t, e = r8(y, pre + 1)
            return Insn(pc, L + e, f"{'INC' if z == 4 else 'DEC'} {t}")
        if z == 6:
            t, e = r8(y, pre + 1)
            return Insn(pc, L + e + 1, f"LD {t},{arg(pre + 1 + e):02X}h")
        return Insn(pc, L, ["RLCA", "RRCA", "RLA", "RRA", "DAA", "CPL", "SCF", "CCF"][y])
    if x == 1:
        if b == 0x76: return Insn(pc, L, "HALT", "stop")
        if y == 6 or z == 6:
            t1, e1 = r8(y, pre + 1)
            t2, e2 = r8(z, pre + 1)
            if y == 6 and ixd: t2 = R8[z]
            if z == 6 and ixd: t1 = R8[y]
            return Insn(pc, L + max(e1, e2), f"LD {t1},{t2}")   # oprava: posun d i u LD r,(IX+d)
        return Insn(pc, L, f"LD {r8(y, 0)[0]},{r8(z, 0)[0]}")
    if x == 2:
        t, e = r8(z, pre + 1)
        return Insn(pc, L + e, f"{ALU[y]}{t}")
    # x == 3
    if z == 0: return Insn(pc, L, f"RET {CC[y]}", "rcc")
    if z == 1:
        if q == 0: return Insn(pc, L, f"POP {hl if p == 2 else RP2[p]}")
        if p == 0: return Insn(pc, L, "RET", "ret")
        if p == 1: return Insn(pc, L, "EXX")
        if p == 2: return Insn(pc, L, f"JP ({hl})", "stop")
        return Insn(pc, L, f"LD SP,{hl}")
    if z == 2: return Insn(pc, L + 2, f"JP {CC[y]},%s", "jcc", imm16(pre + 1))
    if z == 3:
        if y == 0: return Insn(pc, L + 2, "JP %s", "jmp", imm16(pre + 1))
        if y == 1: return None  # CB prefix — řeší decode()
        if y == 2: return Insn(pc, L + 1, f"OUT ({arg(pre + 1):02X}h),A")
        if y == 3: return Insn(pc, L + 1, f"IN A,({arg(pre + 1):02X}h)")
        if y == 4: return Insn(pc, L, f"EX (SP),{hl}")
        if y == 5: return Insn(pc, L, "EX DE,HL")
        if y == 6: return Insn(pc, L, "DI")
        return Insn(pc, L, "EI")
    if z == 4: return Insn(pc, L + 2, f"CALL {CC[y]},%s", "ccc", imm16(pre + 1))
    if z == 5:
        if q == 0: return Insn(pc, L, f"PUSH {hl if p == 2 else RP2[p]}")
        if p == 0: return Insn(pc, L + 2, "CALL %s", "call", imm16(pre + 1))
        return None  # DD/ED/FD prefixy — řeší decode()
    if z == 6: return Insn(pc, L + 1, f"{ALU[y]}{arg(pre + 1):02X}h")
    return Insn(pc, L, f"RST {y * 8:02X}h", "rst", y * 8)


# ---- načtení ------------------------------------------------------------------------------------
def load_images(cpu):
    c = CPUS[cpu]
    if not os.path.exists(c["opcodes"]):
        sys.exit(f"Chybí {c['opcodes']} — spusť node tools/decrypt-stinger.mjs (main) / dodej ROM (sound)")
    opc = open(c["opcodes"], "rb").read()[:c["size"]].ljust(c["size"], b"\0")
    dat = open(c["data"], "rb").read()[:c["size"]].ljust(c["size"], b"\0") if c["data"] else opc
    return opc, dat


def load_hints(path):
    h = {"code": set(), "data": [], "label": {}, "comment": {}, "ram": {}, "ptrs": []}
    if not path or not os.path.exists(path):
        return h
    for ln in open(path, encoding="utf-8"):
        ln = ln.split(";", 1)[0].strip()
        if not ln:
            continue
        parts = ln.split(None, 2)
        kind = parts[0]
        if kind == "code":
            h["code"].add(int(parts[1], 0))
        elif kind == "data":
            rest = (parts[1] + " " + (parts[2] if len(parts) > 2 else "")).split()
            h["data"].append((int(rest[0], 0), int(rest[1], 0)))
        elif kind in ("label", "ram"):
            h[kind][int(parts[1], 0)] = parts[2].strip()
        elif kind == "comment":
            h["comment"][int(parts[1], 0)] = parts[2]
        elif kind == "ptrs":
            rest = parts[2].split()
            a, b = int(rest[0], 0), int(rest[1], 0)
            step = int(rest[3], 0) if len(rest) >= 4 and rest[2] == "step" else 2
            h["ptrs"].append((parts[1], a, b, step))
    return h


# ---- analýza toku -------------------------------------------------------------------------------
def analyze(opc, dat, size, hints, vectors):
    is_code = bytearray(size)      # 1 = začátek instrukce, 2 = pokračování
    forced = bytearray(size)
    for a, b in hints["data"]:
        for x in range(a, min(b, size - 1) + 1):
            forced[x] = 1
    targets = defaultdict(set)
    subs = set()
    insns = {}
    work = list(vectors) + sorted(hints["code"])
    for order, a, b, step in hints["ptrs"]:
        for x in range(a, b + 1 - 1, step):
            forced[x] = forced[x + 1] = 1
            t = (dat[x] | dat[x + 1] << 8) if order == "lohi" else (dat[x] << 8 | dat[x + 1])
            if 0 < t < size:
                targets[t].add((x, "ptr"))
                work.append(t)
    while work:
        pc = work.pop()
        while 0 <= pc < size and not is_code[pc] and not forced[pc]:
            if pc >= 0x80 and opc[pc] in (0x00, 0xFF) and opc[pc:pc + 32] == bytes([opc[pc]]) * 32:
                break   # výplň (>= 32 shodných bajtů; kratší NOP sledy jsou průchozí kód)
            ins = decode(opc, dat, pc, size)
            if pc + ins.length > size:
                break
            insns[pc] = ins
            is_code[pc] = 1
            for k in range(1, ins.length):
                is_code[pc + k] = 2
            if ins.flow in ("jmp", "jcc", "call", "ccc", "rst") and ins.target is not None:
                t = ins.target
                targets[t].add((pc, ins.flow))
                if ins.flow in ("call", "ccc", "rst"):
                    subs.add(t)
                if t < size:
                    work.append(t)
            pc += ins.length
            if ins.flow in ("jmp", "ret", "stop"):
                break
    return is_code, targets, subs, insns


# ---- výstup -------------------------------------------------------------------------------------
def hw_symbol(hw, addr):
    for lo, hi, sym, _ in hw:
        if lo <= addr <= hi:
            return sym if addr == lo else f"{sym}+{addr - lo:X}"
    return None


def emit(cpu, opc, dat, is_code, targets, subs, insns, hints, out):
    c = CPUS[cpu]
    size = c["size"]
    labels = {}
    for t in targets:
        if t >= size:
            continue
        labels[t] = hints["label"].get(t, f"S_{t:04X}" if t in subs else f"L_{t:04X}")
    for a, n in hints["label"].items():
        labels.setdefault(a, n)

    def sym(v, is_addr):
        if v in labels:
            return labels[v]
        if v in hints["ram"]:
            return hints["ram"][v]
        s = hw_symbol(c["hw"], v)
        if s and (is_addr or v >= 0x2000):
            return s
        return f"{v:04X}h"

    ncode = sum(1 for x in is_code if x)
    w = out.write
    w(f"; {c['title']}\n")
    w("; Vygenerováno tools/dis/disz80.py; pokrytí kódem %d/%d B (%.1f %%)\n" % (ncode, size, 100.0 * ncode / size))
    if c["data"]:
        w("; Levý sloupec bajtů = OPKÓDOVÝ obraz (dešifrovaný, opcodes.bin); operandy jsou z datového obrazu (program.bin).\n")
    w(";\n; Mapa paměti (MAME wiz.cpp):\n")
    for lo, hi, s, desc in c["hw"]:
        w(f";   {lo:04X}–{hi:04X}  {s:<10} {desc}\n")
    w("\n")
    for a, n in sorted(hints["ram"].items()):
        w(f"{n:<24} EQU {a:04X}h\n")
    for lo, hi, s, _ in c["hw"]:
        w(f"{s:<24} EQU {lo:04X}h\n")
    w("\n\tORG 0000h\n\n")
    pc = 0
    while pc < size:
        if pc in labels:
            refs = sorted(a for a, _ in targets.get(pc, ()))
            kinds = {k for _, k in targets.get(pc, ())}
            w("\n")
            head = []
            if "ptr" in kinds:
                head.append("z tabulky ukazatelů")
            if refs:
                head.append("xref: " + ", ".join(f"{a:04X}" for a in refs))
            if head:
                w("; " + " ".join(head) + "\n")
            w(f"{labels[pc]}:\n")
        if pc in hints["comment"]:
            w(f"; {hints['comment'][pc]}\n")
        if is_code[pc] == 1:
            ins = insns[pc]
            raw = " ".join(f"{opc[pc + k]:02X}" if k == 0 or (k == 1 and opc[pc] in (0xCB, 0xED, 0xDD, 0xFD)) else f"{dat[pc + k]:02X}"
                           for k in range(ins.length))
            text = ins.text
            if "%s" in text:
                text = text % sym(ins.target, ins.flow != "" or text.startswith("LD (") or "),(" in text or text.endswith("(%s)"))
            w(f"{pc:04X}  {raw:<12} \t{text}\n")
            pc += ins.length
            if ins.flow in ("jmp", "ret", "stop"):
                w("\n")
        else:
            start = pc
            pc += 1
            while pc < size and is_code[pc] == 0 and pc not in labels and pc not in hints["comment"] and pc - start < 16:
                pc += 1
            chunk = dat[start:pc]
            hexs = ",".join(f"{b:02X}h" for b in chunk)
            asc = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
            w(f"{start:04X}  \tDB {hexs:<80} ; {asc}\n")
    w("\n\tEND\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cpu", choices=["main", "sound"])
    ap.add_argument("--hints")
    ap.add_argument("--out")
    a = ap.parse_args()
    c = CPUS[a.cpu]
    hints_path = a.hints or os.path.join(ROOT, "sources/asm/stinger", f"hints-{a.cpu}.txt")
    out_path = a.out or os.path.join(ROOT, "sources/asm/stinger", f"{a.cpu}.asm")
    opc, dat = load_images(a.cpu)
    hints = load_hints(hints_path)
    is_code, targets, subs, insns = analyze(opc, dat, c["size"], hints, c["vectors"])
    with open(out_path, "w", encoding="utf-8") as f:
        emit(a.cpu, opc, dat, is_code, targets, subs, insns, hints, f)
    ncode = sum(1 for x in is_code if x)
    print(f"{out_path}: kód {ncode} B ({100.0 * ncode / c['size']:.1f} %), návěští {len(targets)}, podprogramů {len(subs)}, instrukcí {len(insns)}")


if __name__ == "__main__":
    main()
