#!/usr/bin/env python3
"""z80emu.py — malý interpret Z80 pro trasování Stingeru (ST-M1 nástroj; referenční
emulátor pro regres bude v JS, tools/refemu, ST-M3). Důraz na správnost dokumentovaných
instrukcí a nejběžnějších nedokumentovaných (IXH/IXL, SLL, DDCB s cílovým registrem,
X/Y příznaky u základních operací); přesné T‑stavy se neřeší (čítá se hrubý počet
instrukcí). Paměť a I/O dodá volající přes objekt `bus` s metodami read(a), write(a, v),
fetch(a) (opkódový obraz — pro šifrovaný Stinger vrací dešifrovaný bajt), in_(port), out(port, v).
"""

FS, FZ, FY, FH, FX, FPV, FN, FC = 0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01

# tabulky příznaků
SZ = [0] * 256
SZP = [0] * 256
for i in range(256):
    p = bin(i).count("1") & 1
    SZ[i] = (i & (FS | FY | FX)) | (FZ if i == 0 else 0)
    SZP[i] = SZ[i] | (0 if p else FPV)


class Z80:
    def __init__(self, bus):
        self.bus = bus
        self.reset()

    def reset(self):
        self.a = self.f = 0xFF
        self.b = self.c = self.d = self.e = self.h = self.l = 0
        self.a2 = self.f2 = 0xFF
        self.b2 = self.c2 = self.d2 = self.e2 = self.h2 = self.l2 = 0
        self.ix = self.iy = 0xFFFF
        self.sp = 0xFFFF
        self.pc = 0
        self.i = self.r = 0
        self.iff1 = self.iff2 = 0
        self.im = 0
        self.halted = False
        self.cycles = 0
        self.nmi_pending = False
        self.int_pending = False

    # ---- registry pairs
    def get_bc(self): return (self.b << 8) | self.c
    def get_de(self): return (self.d << 8) | self.e
    def get_hl(self): return (self.h << 8) | self.l
    def get_af(self): return (self.a << 8) | self.f
    def set_bc(self, v): self.b, self.c = (v >> 8) & 0xFF, v & 0xFF
    def set_de(self, v): self.d, self.e = (v >> 8) & 0xFF, v & 0xFF
    def set_hl(self, v): self.h, self.l = (v >> 8) & 0xFF, v & 0xFF
    def set_af(self, v): self.a, self.f = (v >> 8) & 0xFF, v & 0xFF

    # ---- paměť
    def rd(self, a): return self.bus.read(a & 0xFFFF)
    def wr(self, a, v): self.bus.write(a & 0xFFFF, v & 0xFF)
    def rd16(self, a): return self.rd(a) | (self.rd(a + 1) << 8)
    def wr16(self, a, v): self.wr(a, v & 0xFF); self.wr(a + 1, v >> 8)

    def fetch(self):
        v = self.bus.fetch(self.pc)
        self.pc = (self.pc + 1) & 0xFFFF
        self.r = (self.r & 0x80) | ((self.r + 1) & 0x7F)
        return v

    def arg(self):
        v = self.rd(self.pc)
        self.pc = (self.pc + 1) & 0xFFFF
        return v

    def arg16(self):
        v = self.arg()
        return v | (self.arg() << 8)

    def push(self, v):
        self.sp = (self.sp - 2) & 0xFFFF
        self.wr16(self.sp, v)

    def pop(self):
        v = self.rd16(self.sp)
        self.sp = (self.sp + 2) & 0xFFFF
        return v

    # ---- přerušení
    def nmi(self):
        self.halted = False
        self.iff2 = self.iff1
        self.iff1 = 0
        self.push(self.pc)
        self.pc = 0x0066
        self.cycles += 11

    def irq(self):
        if not self.iff1:
            return False
        self.halted = False
        self.iff1 = self.iff2 = 0
        self.push(self.pc)
        self.pc = 0x0038   # IM 1
        self.cycles += 13
        return True

    # ---- ALU
    def add8(self, a, b, cy=0):
        r = a + b + cy
        f = SZ[r & 0xFF] | (FC if r > 0xFF else 0) | (FH if ((a ^ b ^ r) & 0x10) else 0) \
            | (FPV if ((a ^ r) & (b ^ r) & 0x80) else 0)
        self.f = f
        return r & 0xFF

    def sub8(self, a, b, cy=0):
        r = a - b - cy
        f = SZ[r & 0xFF] | FN | (FC if r < 0 else 0) | (FH if ((a ^ b ^ r) & 0x10) else 0) \
            | (FPV if ((a ^ b) & (a ^ r) & 0x80) else 0)
        self.f = f
        return r & 0xFF

    def cp8(self, a, b):
        r = a - b
        self.f = (SZ[r & 0xFF] & (FS | FZ)) | (b & (FY | FX)) | FN | (FC if r < 0 else 0) \
            | (FH if ((a ^ b ^ r) & 0x10) else 0) | (FPV if ((a ^ b) & (a ^ r) & 0x80) else 0)

    def logic(self, r, h):
        self.f = SZP[r] | (FH if h else 0)
        return r

    def inc8(self, v):
        r = (v + 1) & 0xFF
        self.f = (self.f & FC) | SZ[r] | (FH if (r & 0x0F) == 0 else 0) | (FPV if r == 0x80 else 0)
        return r

    def dec8(self, v):
        r = (v - 1) & 0xFF
        self.f = (self.f & FC) | SZ[r] | FN | (FH if (r & 0x0F) == 0x0F else 0) | (FPV if r == 0x7F else 0)
        return r

    def add16(self, a, b):
        r = a + b
        self.f = (self.f & (FS | FZ | FPV)) | ((r >> 8) & (FY | FX)) | (FC if r > 0xFFFF else 0) \
            | (FH if ((a ^ b ^ r) & 0x1000) else 0)
        return r & 0xFFFF

    def adc16(self, a, b):
        cy = self.f & FC
        r = a + b + cy
        self.f = ((r >> 8) & (FS | FY | FX)) | (FZ if (r & 0xFFFF) == 0 else 0) | (FC if r > 0xFFFF else 0) \
            | (FH if ((a ^ b ^ r) & 0x1000) else 0) | (FPV if ((a ^ r) & (b ^ r) & 0x8000) else 0)
        return r & 0xFFFF

    def sbc16(self, a, b):
        cy = self.f & FC
        r = a - b - cy
        self.f = ((r >> 8) & (FS | FY | FX)) | (FZ if (r & 0xFFFF) == 0 else 0) | FN | (FC if r < 0 else 0) \
            | (FH if ((a ^ b ^ r) & 0x1000) else 0) | (FPV if ((a ^ b) & (a ^ r) & 0x8000) else 0)
        return r & 0xFFFF

    def rot(self, op, v):
        c = self.f & FC
        if op == 0:   r = ((v << 1) | (v >> 7)) & 0xFF; nc = v >> 7            # RLC
        elif op == 1: r = ((v >> 1) | (v << 7)) & 0xFF; nc = v & 1            # RRC
        elif op == 2: r = ((v << 1) | c) & 0xFF; nc = v >> 7                  # RL
        elif op == 3: r = ((v >> 1) | (c << 7)) & 0xFF; nc = v & 1            # RR
        elif op == 4: r = (v << 1) & 0xFF; nc = v >> 7                        # SLA
        elif op == 5: r = ((v >> 1) | (v & 0x80)) & 0xFF; nc = v & 1          # SRA
        elif op == 6: r = ((v << 1) | 1) & 0xFF; nc = v >> 7                  # SLL
        else:         r = v >> 1; nc = v & 1                                  # SRL
        self.f = SZP[r] | (FC if nc else 0)
        return r

    def daa(self):
        a = self.a; f = self.f
        corr = 0; c = f & FC
        if (f & FH) or (a & 0x0F) > 9: corr |= 0x06
        if c or a > 0x99: corr |= 0x60; c = FC
        if f & FN:
            r = (a - corr) & 0xFF
            h = FH if (f & FH) and (a & 0x0F) < 6 else 0
        else:
            r = (a + corr) & 0xFF
            h = FH if (a & 0x0F) > 9 else 0
        self.f = SZP[r] | (f & FN) | h | c
        self.a = r

    # ---- registry podle kódu (s podporou IX/IY)
    def get_r(self, n, ix):
        if n == 6:
            if ix is None: return self.rd(self.get_hl())
            d = self.arg(); d = d - 256 if d > 127 else d
            return self.rd(ix + d)
        if ix is not None and n in (4, 5):
            v = self.ix if ix == "ix" else self.iy
            return (v >> 8) if n == 4 else (v & 0xFF)
        return (self.b, self.c, self.d, self.e, self.h, self.l, None, self.a)[n]

    def set_r(self, n, val, ix, disp=None):
        val &= 0xFF
        if n == 6:
            if ix is None: self.wr(self.get_hl(), val); return
            if disp is None:
                d = self.arg(); disp = d - 256 if d > 127 else d
            self.wr(ix + disp, val); return
        if ix is not None and n in (4, 5):
            v = self.ix if ix == "ix" else self.iy
            v = ((val << 8) | (v & 0xFF)) if n == 4 else ((v & 0xFF00) | val)
            if ix == "ix": self.ix = v
            else: self.iy = v
            return
        if n == 0: self.b = val
        elif n == 1: self.c = val
        elif n == 2: self.d = val
        elif n == 3: self.e = val
        elif n == 4: self.h = val
        elif n == 5: self.l = val
        else: self.a = val

    def get_rp(self, n, ixv):
        if n == 0: return self.get_bc()
        if n == 1: return self.get_de()
        if n == 2: return ixv if ixv is not None else self.get_hl()
        return self.sp

    def set_rp(self, n, v, ixname):
        v &= 0xFFFF
        if n == 0: self.set_bc(v)
        elif n == 1: self.set_de(v)
        elif n == 2:
            if ixname == "ix": self.ix = v
            elif ixname == "iy": self.iy = v
            else: self.set_hl(v)
        else: self.sp = v

    def cond(self, cc):
        f = self.f
        return ((not f & FZ), bool(f & FZ), (not f & FC), bool(f & FC),
                (not f & FPV), bool(f & FPV), (not f & FS), bool(f & FS))[cc]

    # ---- krok
    def step(self):
        if self.nmi_pending:
            self.nmi_pending = False
            self.nmi()
        elif self.int_pending and self.iff1:
            self.int_pending = False
            self.irq()
        if self.halted:
            self.cycles += 4
            return
        self.cycles += 4
        self.exec(self.fetch(), None)

    def exec(self, op, ixname):
        ixv = None if ixname is None else (self.ix if ixname == "ix" else self.iy)
        x, y, z, p, q = op >> 6, (op >> 3) & 7, op & 7, (op >> 4) & 3, (op >> 3) & 1
        if op == 0xDD: return self.exec(self.fetch(), "ix")
        if op == 0xFD: return self.exec(self.fetch(), "iy")
        if op == 0xCB: return self.exec_cb(ixname, ixv)
        if op == 0xED: return self.exec_ed()
        if x == 0:
            if z == 0:
                if y == 0: return
                if y == 1:
                    self.a, self.a2 = self.a2, self.a; self.f, self.f2 = self.f2, self.f; return
                d = self.arg(); d = d - 256 if d > 127 else d
                if y == 2:
                    self.b = (self.b - 1) & 0xFF
                    if self.b: self.pc = (self.pc + d) & 0xFFFF
                    return
                if y == 3 or self.cond(y - 4):
                    self.pc = (self.pc + d) & 0xFFFF
                return
            if z == 1:
                if q == 0: self.set_rp(p, self.arg16(), ixname); return
                hl = ixv if ixv is not None else self.get_hl()
                self.set_rp(2, self.add16(hl, self.get_rp(p, ixv)), ixname); return
            if z == 2:
                if q == 0:
                    if p == 0: self.wr(self.get_bc(), self.a)
                    elif p == 1: self.wr(self.get_de(), self.a)
                    elif p == 2: self.wr16(self.arg16(), ixv if ixv is not None else self.get_hl())
                    else: self.wr(self.arg16(), self.a)
                else:
                    if p == 0: self.a = self.rd(self.get_bc())
                    elif p == 1: self.a = self.rd(self.get_de())
                    elif p == 2: self.set_rp(2, self.rd16(self.arg16()), ixname)
                    else: self.a = self.rd(self.arg16())
                return
            if z == 3:
                v = self.get_rp(p, ixv)
                self.set_rp(p, v + (-1 if q else 1), ixname); return
            if z == 4 or z == 5:
                if y == 6 and ixv is not None:
                    d = self.arg(); d = d - 256 if d > 127 else d
                    v = self.rd(ixv + d)
                    self.wr(ixv + d, self.inc8(v) if z == 4 else self.dec8(v)); return
                v = self.get_r(y, ixname)
                self.set_r(y, self.inc8(v) if z == 4 else self.dec8(v), ixname); return
            if z == 6:
                if y == 6 and ixv is not None:
                    d = self.arg(); d = d - 256 if d > 127 else d
                    self.wr(ixv + d, self.arg()); return
                self.set_r(y, self.arg(), ixname); return
            # z == 7
            if y == 0: self.f = (self.f & (FS | FZ | FPV)) | (self.a >> 7) | (((self.a << 1) | (self.a >> 7)) & (FY | FX)); self.a = ((self.a << 1) | (self.a >> 7)) & 0xFF; return
            if y == 1: self.f = (self.f & (FS | FZ | FPV)) | (self.a & 1); self.a = ((self.a >> 1) | (self.a << 7)) & 0xFF; self.f |= self.a & (FY | FX); return
            if y == 2:
                c = self.f & FC; nc = self.a >> 7
                self.a = ((self.a << 1) | c) & 0xFF
                self.f = (self.f & (FS | FZ | FPV)) | nc | (self.a & (FY | FX)); return
            if y == 3:
                c = self.f & FC; nc = self.a & 1
                self.a = ((self.a >> 1) | (c << 7)) & 0xFF
                self.f = (self.f & (FS | FZ | FPV)) | nc | (self.a & (FY | FX)); return
            if y == 4: self.daa(); return
            if y == 5: self.a ^= 0xFF; self.f = (self.f & (FS | FZ | FPV | FC)) | FH | FN | (self.a & (FY | FX)); return
            if y == 6: self.f = (self.f & (FS | FZ | FPV)) | FC | (self.a & (FY | FX)); return
            self.f = (self.f & (FS | FZ | FPV | FC)) | ((self.f & FC) << 4) | (self.a & (FY | FX)); self.f ^= FC; return
        if x == 1:
            if op == 0x76: self.halted = True; return
            if ixv is not None and (y == 6 or z == 6):
                d = self.arg(); d = d - 256 if d > 127 else d
                if y == 6: self.wr(ixv + d, self.get_r(z, None))
                else: self.set_r(y, self.rd(ixv + d), None)
                return
            self.set_r(y, self.get_r(z, ixname), ixname); return
        if x == 2:
            v = self.get_r(z, ixname)
            self.alu(y, v); return
        # x == 3
        if z == 0:
            if self.cond(y): self.pc = self.pop()
            return
        if z == 1:
            if q == 0:
                v = self.pop()
                if p == 3: self.set_af(v)
                else: self.set_rp(p, v, ixname)
                return
            if p == 0: self.pc = self.pop(); return
            if p == 1:
                self.b, self.b2 = self.b2, self.b; self.c, self.c2 = self.c2, self.c
                self.d, self.d2 = self.d2, self.d; self.e, self.e2 = self.e2, self.e
                self.h, self.h2 = self.h2, self.h; self.l, self.l2 = self.l2, self.l; return
            if p == 2: self.pc = ixv if ixv is not None else self.get_hl(); return
            self.sp = ixv if ixv is not None else self.get_hl(); return
        if z == 2:
            a = self.arg16()
            if self.cond(y): self.pc = a
            return
        if z == 3:
            if y == 0: self.pc = self.arg16(); return
            if y == 2: self.bus.out(self.arg() | (self.a << 8), self.a); return
            if y == 3: self.a = self.bus.in_(self.arg() | (self.a << 8)); return
            if y == 4:
                v = self.rd16(self.sp)
                self.wr16(self.sp, ixv if ixv is not None else self.get_hl())
                self.set_rp(2, v, ixname); return
            if y == 5:
                de, hl = self.get_de(), self.get_hl(); self.set_de(hl); self.set_hl(de); return
            if y == 6: self.iff1 = self.iff2 = 0; return
            self.iff1 = self.iff2 = 1; return
        if z == 4:
            a = self.arg16()
            if self.cond(y): self.push(self.pc); self.pc = a
            return
        if z == 5:
            if q == 0:
                self.push(self.get_af() if p == 3 else self.get_rp(p, ixv)); return
            a = self.arg16(); self.push(self.pc); self.pc = a; return
        if z == 6: self.alu(y, self.arg()); return
        self.push(self.pc); self.pc = y * 8

    def alu(self, y, v):
        if y == 0: self.a = self.add8(self.a, v)
        elif y == 1: self.a = self.add8(self.a, v, self.f & FC)
        elif y == 2: self.a = self.sub8(self.a, v)
        elif y == 3: self.a = self.sub8(self.a, v, self.f & FC)
        elif y == 4: self.a = self.logic(self.a & v, True)
        elif y == 5: self.a = self.logic(self.a ^ v, False)
        elif y == 6: self.a = self.logic(self.a | v, False)
        else: self.cp8(self.a, v)

    def exec_cb(self, ixname, ixv):
        if ixv is not None:
            d = self.arg(); d = d - 256 if d > 127 else d
            o = self.arg()
            addr = (ixv + d) & 0xFFFF
            x, y, z = o >> 6, (o >> 3) & 7, o & 7
            v = self.rd(addr)
            if x == 0: r = self.rot(y, v)
            elif x == 1:
                self.f = (self.f & FC) | FH | (0 if v & (1 << y) else (FZ | FPV)) | ((FS if y == 7 and v & 0x80 else 0)) | ((addr >> 8) & (FY | FX)); return
            elif x == 2: r = v & ~(1 << y) & 0xFF
            else: r = v | (1 << y)
            self.wr(addr, r)
            if z != 6: self.set_r(z, r, None)
            return
        o = self.fetch()
        x, y, z = o >> 6, (o >> 3) & 7, o & 7
        v = self.get_r(z, None)
        if x == 0: self.set_r(z, self.rot(y, v), None); return
        if x == 1:
            self.f = (self.f & FC) | FH | (0 if v & (1 << y) else (FZ | FPV)) | (FS if y == 7 and v & 0x80 else 0) | (v & (FY | FX) if z != 6 else 0); return
        if x == 2: self.set_r(z, v & ~(1 << y), None); return
        self.set_r(z, v | (1 << y), None)

    def exec_ed(self):
        o = self.fetch()
        x, y, z, p, q = o >> 6, (o >> 3) & 7, o & 7, (o >> 4) & 3, (o >> 3) & 1
        if x == 1:
            if z == 0:
                v = self.bus.in_(self.get_bc())
                if y != 6: self.set_r(y, v, None)
                self.f = (self.f & FC) | SZP[v]; return
            if z == 1: self.bus.out(self.get_bc(), 0 if y == 6 else self.get_r(y, None)); return
            if z == 2:
                hl = self.get_hl(); v = self.get_rp(p, None)
                self.set_hl(self.adc16(hl, v) if q else self.sbc16(hl, v)); return
            if z == 3:
                a = self.arg16()
                if q: self.set_rp(p, self.rd16(a), None)
                else: self.wr16(a, self.get_rp(p, None))
                return
            if z == 4: self.a = self.sub8(0, self.a); return
            if z == 5: self.pc = self.pop(); self.iff1 = self.iff2; return
            if z == 6: self.im = (0, 0, 1, 2, 0, 0, 1, 2)[y]; return
            if y == 0: self.i = self.a; return
            if y == 1: self.r = self.a; return
            if y == 2: self.a = self.i; self.f = (self.f & FC) | SZ[self.a] | (FPV if self.iff2 else 0); return
            if y == 3: self.a = self.r; self.f = (self.f & FC) | SZ[self.a] | (FPV if self.iff2 else 0); return
            if y in (4, 5):
                hl = self.get_hl(); m = self.rd(hl)
                if y == 4:  # RRD
                    self.wr(hl, ((self.a << 4) | (m >> 4)) & 0xFF); self.a = (self.a & 0xF0) | (m & 0x0F)
                else:       # RLD
                    self.wr(hl, ((m << 4) | (self.a & 0x0F)) & 0xFF); self.a = (self.a & 0xF0) | (m >> 4)
                self.f = (self.f & FC) | SZP[self.a]; return
            return
        if x == 2 and z in (0, 1, 2, 3) and y >= 4:
            inc = 1 if y in (4, 6) else -1
            rep = y >= 6
            while True:
                hl, de, bc = self.get_hl(), self.get_de(), self.get_bc()
                if z == 0:   # LDI/LDD
                    v = self.rd(hl); self.wr(de, v)
                    self.set_hl(hl + inc); self.set_de(de + inc); bc = (bc - 1) & 0xFFFF; self.set_bc(bc)
                    n = (v + self.a) & 0xFF
                    self.f = (self.f & (FS | FZ | FC)) | (FPV if bc else 0) | (n & FX) | ((n << 4) & FY)
                    if not rep or bc == 0: return
                elif z == 1:  # CPI/CPD
                    v = self.rd(hl); c = self.f & FC
                    self.cp8(self.a, v)
                    self.set_hl(hl + inc); bc = (bc - 1) & 0xFFFF; self.set_bc(bc)
                    self.f = (self.f & ~(FC | FPV)) | c | (FPV if bc else 0)
                    if not rep or bc == 0 or (self.f & FZ): return
                elif z == 2:  # INI/IND
                    v = self.bus.in_(bc); self.wr(hl, v)
                    self.b = (self.b - 1) & 0xFF; self.set_hl(hl + inc)
                    self.f = SZ[self.b] | FN
                    if not rep or self.b == 0: return
                else:        # OUTI/OUTD
                    v = self.rd(hl); self.b = (self.b - 1) & 0xFF
                    self.bus.out(self.get_bc(), v); self.set_hl(hl + inc)
                    self.f = SZ[self.b] | FN
                    if not rep or self.b == 0: return
                self.cycles += 21
