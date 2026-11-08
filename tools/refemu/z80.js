// z80.js — jádro Zilog Z80 v JS (rychlý interpret, kompletní vč. nedokumentovaných
// instrukcí, přesných T-stavů, MEMPTR/WZ a nedokumentovaných příznaků X/Y).
//
// bus = { read(a), write(a,v), fetch(a), in(port), out(port,v) }
//  - fetch() se používá VÝHRADNĚ pro opkódové bajty (M1), včetně bajtů prefixů
//    CB/ED/DD/FD a opkódu za displacementem u DDCB/FDCB.
//  - operandy, displacementy a adresy se čtou přes read().

const FS = 0x80, FZ = 0x40, FY = 0x20, FH = 0x10, FX = 0x08, FPV = 0x04, FN = 0x02, FC = 0x01;
const FYX = FY | FX;

// tabulky příznaků
const sz53 = new Uint8Array(256);
const sz53p = new Uint8Array(256);
const parityTab = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let p = 0;
  for (let b = 0; b < 8; b++) p ^= (i >> b) & 1;
  parityTab[i] = p ? 0 : FPV;
  sz53[i] = (i & (FS | FY | FX)) | (i === 0 ? FZ : 0);
  sz53p[i] = sz53[i] | parityTab[i];
}

// mapa IM podle pole y u ED opkódů z=6
const IM_TAB = [0, 0, 1, 2, 0, 0, 1, 2];

export class Z80 {
  constructor(bus) {
    this.bus = bus;
    this.reset();
  }

  reset() {
    this.a = 0xFF; this.f = 0xFF;
    this.b = 0; this.c = 0; this.d = 0; this.e = 0; this.h = 0; this.l = 0;
    this.a_ = 0xFF; this.f_ = 0xFF;
    this.b_ = 0; this.c_ = 0; this.d_ = 0; this.e_ = 0; this.h_ = 0; this.l_ = 0;
    this.ix = 0xFFFF; this.iy = 0xFFFF;
    this.sp = 0xFFFF; this.pc = 0;
    this.i = 0; this.r = 0;          // r = plná 8bitová hodnota, inkrementuje se jen spodních 7 bitů
    this.iff1 = 0; this.iff2 = 0; this.im = 0;
    this.halted = false;
    this.memptr = 0;
    this.tstates = 0;
    this._nmiReq = false;
    this._irqReq = false;
    this._irqData = 0xFF;
    this._eiBlock = false;
  }

  // ---- páry registrů -------------------------------------------------------
  getAF() { return (this.a << 8) | this.f; }
  setAF(v) { this.a = (v >>> 8) & 0xFF; this.f = v & 0xFF; }
  getBC() { return (this.b << 8) | this.c; }
  setBC(v) { this.b = (v >>> 8) & 0xFF; this.c = v & 0xFF; }
  getDE() { return (this.d << 8) | this.e; }
  setDE(v) { this.d = (v >>> 8) & 0xFF; this.e = v & 0xFF; }
  getHL() { return (this.h << 8) | this.l; }
  setHL(v) { this.h = (v >>> 8) & 0xFF; this.l = v & 0xFF; }

  // ---- vnější požadavky ----------------------------------------------------
  nmi() { this._nmiReq = true; }
  irq(data = 0xFF) { this._irqReq = true; this._irqData = data & 0xFF; }

  // ---- přístup na sběrnici -------------------------------------------------
  _rb(a) { return this.bus.read(a & 0xFFFF) & 0xFF; }
  _wb(a, v) { this.bus.write(a & 0xFFFF, v & 0xFF); }

  _op() { // M1: opkódový bajt (přes fetch), inkrement R
    const v = this.bus.fetch(this.pc) & 0xFF;
    this.pc = (this.pc + 1) & 0xFFFF;
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
    return v;
  }
  _n() { // bezprostřední operand
    const v = this.bus.read(this.pc) & 0xFF;
    this.pc = (this.pc + 1) & 0xFFFF;
    return v;
  }
  _nn() { const lo = this._n(); return lo | (this._n() << 8); }
  _d() { return (this._n() << 24) >> 24; } // znaménkový displacement

  _push(v) {
    this.sp = (this.sp - 1) & 0xFFFF; this._wb(this.sp, (v >>> 8) & 0xFF);
    this.sp = (this.sp - 1) & 0xFFFF; this._wb(this.sp, v & 0xFF);
  }
  _pop() {
    const lo = this._rb(this.sp); this.sp = (this.sp + 1) & 0xFFFF;
    const hi = this._rb(this.sp); this.sp = (this.sp + 1) & 0xFFFF;
    return lo | (hi << 8);
  }

  // ---- registry 0..7 (6 = (HL), řeší volající); idx: 0 none, 1 IX, 2 IY ----
  _gr(i, idx) {
    switch (i) {
      case 0: return this.b;
      case 1: return this.c;
      case 2: return this.d;
      case 3: return this.e;
      case 4: return idx === 0 ? this.h : (idx === 1 ? (this.ix >>> 8) : (this.iy >>> 8));
      case 5: return idx === 0 ? this.l : (idx === 1 ? (this.ix & 0xFF) : (this.iy & 0xFF));
      default: return this.a;
    }
  }
  _sr(i, v, idx) {
    v &= 0xFF;
    switch (i) {
      case 0: this.b = v; break;
      case 1: this.c = v; break;
      case 2: this.d = v; break;
      case 3: this.e = v; break;
      case 4:
        if (idx === 0) this.h = v;
        else if (idx === 1) this.ix = (this.ix & 0x00FF) | (v << 8);
        else this.iy = (this.iy & 0x00FF) | (v << 8);
        break;
      case 5:
        if (idx === 0) this.l = v;
        else if (idx === 1) this.ix = (this.ix & 0xFF00) | v;
        else this.iy = (this.iy & 0xFF00) | v;
        break;
      default: this.a = v; break;
    }
  }
  _ghl(idx) { return idx === 0 ? ((this.h << 8) | this.l) : (idx === 1 ? this.ix : this.iy); }
  _shl(idx, v) {
    v &= 0xFFFF;
    if (idx === 0) { this.h = v >>> 8; this.l = v & 0xFF; }
    else if (idx === 1) this.ix = v;
    else this.iy = v;
  }
  // adresa (IX+d)/(IY+d); nastavuje MEMPTR
  _idxAddr(idx) {
    const d = this._d();
    const addr = ((idx === 1 ? this.ix : this.iy) + d) & 0xFFFF;
    this.memptr = addr;
    return addr;
  }

  // ---- aritmetika 8bit -----------------------------------------------------
  _add8(v) {
    const a = this.a, r = a + v, res = r & 0xFF;
    this.f = sz53[res] | (r > 0xFF ? FC : 0) | ((a ^ v ^ res) & FH) |
      ((((a ^ v ^ 0x80) & (a ^ res)) >>> 5) & FPV);
    this.a = res;
  }
  _adc8(v) {
    const a = this.a, cy = this.f & FC, r = a + v + cy, res = r & 0xFF;
    this.f = sz53[res] | (r > 0xFF ? FC : 0) | ((a ^ v ^ res) & FH) |
      ((((a ^ v ^ 0x80) & (a ^ res)) >>> 5) & FPV);
    this.a = res;
  }
  _sub8(v) {
    const a = this.a, r = a - v, res = r & 0xFF;
    this.f = FN | sz53[res] | (r < 0 ? FC : 0) | ((a ^ v ^ res) & FH) |
      ((((a ^ v) & (a ^ res)) >>> 5) & FPV);
    this.a = res;
  }
  _sbc8(v) {
    const a = this.a, cy = this.f & FC, r = a - v - cy, res = r & 0xFF;
    this.f = FN | sz53[res] | (r < 0 ? FC : 0) | ((a ^ v ^ res) & FH) |
      ((((a ^ v) & (a ^ res)) >>> 5) & FPV);
    this.a = res;
  }
  _cp8(v) {
    const a = this.a, r = a - v, res = r & 0xFF;
    // X/Y se berou z operandu, ne z výsledku
    this.f = FN | (res & FS) | (res === 0 ? FZ : 0) | (v & FYX) | (r < 0 ? FC : 0) |
      ((a ^ v ^ res) & FH) | ((((a ^ v) & (a ^ res)) >>> 5) & FPV);
  }
  _alu(kind, v) {
    switch (kind) {
      case 0: this._add8(v); break;
      case 1: this._adc8(v); break;
      case 2: this._sub8(v); break;
      case 3: this._sbc8(v); break;
      case 4: this.a &= v; this.f = sz53p[this.a] | FH; break;
      case 5: this.a ^= v; this.f = sz53p[this.a]; break;
      case 6: this.a |= v; this.f = sz53p[this.a]; break;
      default: this._cp8(v); break;
    }
  }
  _inc8(v) {
    const res = (v + 1) & 0xFF;
    this.f = (this.f & FC) | sz53[res] | (res === 0x80 ? FPV : 0) | ((res & 0x0F) === 0 ? FH : 0);
    return res;
  }
  _dec8(v) {
    const res = (v - 1) & 0xFF;
    this.f = (this.f & FC) | FN | sz53[res] | (res === 0x7F ? FPV : 0) | ((res & 0x0F) === 0x0F ? FH : 0);
    return res;
  }

  // ---- aritmetika 16bit ----------------------------------------------------
  _add16(idx, v) {
    const a = this._ghl(idx);
    this.memptr = (a + 1) & 0xFFFF;
    const r = a + v, res = r & 0xFFFF;
    this.f = (this.f & (FS | FZ | FPV)) | (((a ^ v ^ res) >>> 8) & FH) |
      ((res >>> 8) & FYX) | (r > 0xFFFF ? FC : 0);
    this._shl(idx, res);
  }
  _adc16(v) {
    const a = this.getHL();
    this.memptr = (a + 1) & 0xFFFF;
    const cy = this.f & FC, r = a + v + cy, res = r & 0xFFFF;
    this.f = ((res >>> 8) & (FS | FYX)) | (res === 0 ? FZ : 0) | (((a ^ v ^ res) >>> 8) & FH) |
      ((((a ^ v ^ 0x8000) & (a ^ res)) >>> 13) & FPV) | (r > 0xFFFF ? FC : 0);
    this.setHL(res);
  }
  _sbc16(v) {
    const a = this.getHL();
    this.memptr = (a + 1) & 0xFFFF;
    const cy = this.f & FC, r = a - v - cy, res = r & 0xFFFF;
    this.f = FN | ((res >>> 8) & (FS | FYX)) | (res === 0 ? FZ : 0) | (((a ^ v ^ res) >>> 8) & FH) |
      ((((a ^ v) & (a ^ res)) >>> 13) & FPV) | (r < 0 ? FC : 0);
    this.setHL(res);
  }

  // ---- rotace/posuny (CB) --------------------------------------------------
  _rot(kind, v) {
    let cy, res;
    switch (kind) {
      case 0: cy = v >>> 7; res = ((v << 1) | cy) & 0xFF; break;                 // RLC
      case 1: cy = v & 1; res = (v >>> 1) | (cy << 7); break;                    // RRC
      case 2: cy = v >>> 7; res = ((v << 1) | (this.f & FC)) & 0xFF; break;      // RL
      case 3: cy = v & 1; res = (v >>> 1) | ((this.f & FC) << 7); break;         // RR
      case 4: cy = v >>> 7; res = (v << 1) & 0xFF; break;                        // SLA
      case 5: cy = v & 1; res = (v & 0x80) | (v >>> 1); break;                   // SRA
      case 6: cy = v >>> 7; res = ((v << 1) | 1) & 0xFF; break;                  // SLL (nedok.)
      default: cy = v & 1; res = v >>> 1; break;                                 // SRL
    }
    this.f = sz53p[res] | cy;
    return res;
  }
  _bit(n, v, xySrc) {
    const set = v & (1 << n);
    this.f = (this.f & FC) | FH | (xySrc & FYX) |
      (set ? (n === 7 ? FS : 0) : (FZ | FPV));
  }

  // ---- krok ----------------------------------------------------------------
  step() {
    // NMI (hranou)
    if (this._nmiReq) {
      this._nmiReq = false;
      this.halted = false;
      this.iff1 = 0;                  // iff2 zůstává
      this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
      this._push(this.pc);
      this.pc = 0x0066;
      this.memptr = 0x0066;
      this._eiBlock = false;
      this.tstates += 11;
      return 11;
    }
    // maskovatelné přerušení (ne bezprostředně po EI)
    if (this._irqReq && this.iff1 && !this._eiBlock) {
      this._irqReq = false;
      this.halted = false;
      this.iff1 = 0; this.iff2 = 0;
      this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
      const data = this._irqData;
      let t;
      if (this.im === 2) {
        this._push(this.pc);
        const ad = ((this.i << 8) | data) & 0xFFFF;
        this.pc = this._rb(ad) | (this._rb((ad + 1) & 0xFFFF) << 8);
        t = 19;
      } else if (this.im === 1) {
        this._push(this.pc); this.pc = 0x0038; t = 13;
      } else {
        // IM 0 — na sběrnici typicky RST; bereme data jako RST opkód
        this._push(this.pc); this.pc = data & 0x38; t = 13;
      }
      this.memptr = this.pc;
      this.tstates += t;
      return t;
    }
    this._eiBlock = false;

    if (this.halted) { // HALT vykonává NOPy
      this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
      this.tstates += 4;
      return 4;
    }

    let idx = 0, t = 0;
    for (;;) {
      const op = this._op();
      if (op === 0xDD) { idx = 1; t += 4; continue; }   // prefix, přerušení se nepřijímá
      if (op === 0xFD) { idx = 2; t += 4; continue; }
      t += this._exec(op, idx);
      break;
    }
    this.tstates += t;
    return t;
  }

  // ---- hlavní dekodér ------------------------------------------------------
  _exec(op, idx) {
    // 0x40..0xBF: LD r,r' a ALU A,r
    if (op >= 0x40 && op <= 0xBF) {
      if (op === 0x76) { this.halted = true; return 4; }
      const z = op & 7;
      if (op < 0x80) {
        const y = (op >>> 3) & 7;
        if (idx !== 0 && (y === 6 || z === 6)) {
          const addr = this._idxAddr(idx);
          if (z === 6) this._sr(y, this._rb(addr), 0);     // cíl je skutečný H/L
          else this._wb(addr, this._gr(z, 0));             // zdroj je skutečný H/L
          return 15;
        }
        if (y === 6) { this._wb(this._ghl(0), this._gr(z, 0)); return 7; }
        if (z === 6) { this._sr(y, this._rb(this._ghl(0)), 0); return 7; }
        this._sr(y, this._gr(z, idx), idx);
        return 4;
      }
      const kind = (op >>> 3) & 7;
      if (z === 6) {
        if (idx !== 0) { this._alu(kind, this._rb(this._idxAddr(idx))); return 15; }
        this._alu(kind, this._rb(this._ghl(0)));
        return 7;
      }
      this._alu(kind, this._gr(z, idx));
      return 4;
    }

    let nn, v, addr, d;
    switch (op) {
      case 0x00: return 4;                                        // NOP
      case 0x01: this.setBC(this._nn()); return 10;
      case 0x02: { const bc = this.getBC(); this._wb(bc, this.a);
        this.memptr = ((bc + 1) & 0xFF) | (this.a << 8); return 7; }
      case 0x03: this.setBC((this.getBC() + 1) & 0xFFFF); return 6;
      case 0x04: this.b = this._inc8(this.b); return 4;
      case 0x05: this.b = this._dec8(this.b); return 4;
      case 0x06: this.b = this._n(); return 7;
      case 0x07: { const cy = this.a >>> 7; this.a = ((this.a << 1) | cy) & 0xFF;
        this.f = (this.f & (FS | FZ | FPV)) | cy | (this.a & FYX); return 4; }   // RLCA
      case 0x08: { let x = this.a; this.a = this.a_; this.a_ = x;
        x = this.f; this.f = this.f_; this.f_ = x; return 4; }                   // EX AF,AF'
      case 0x09: this._add16(idx, this.getBC()); return 11;
      case 0x0A: { const bc = this.getBC(); this.a = this._rb(bc);
        this.memptr = (bc + 1) & 0xFFFF; return 7; }
      case 0x0B: this.setBC((this.getBC() - 1) & 0xFFFF); return 6;
      case 0x0C: this.c = this._inc8(this.c); return 4;
      case 0x0D: this.c = this._dec8(this.c); return 4;
      case 0x0E: this.c = this._n(); return 7;
      case 0x0F: { const cy = this.a & 1; this.a = (this.a >>> 1) | (cy << 7);
        this.f = (this.f & (FS | FZ | FPV)) | cy | (this.a & FYX); return 4; }   // RRCA

      case 0x10: { d = this._d(); this.b = (this.b - 1) & 0xFF;                  // DJNZ
        if (this.b) { this.pc = (this.pc + d) & 0xFFFF; this.memptr = this.pc; return 13; }
        return 8; }
      case 0x11: this.setDE(this._nn()); return 10;
      case 0x12: { const de = this.getDE(); this._wb(de, this.a);
        this.memptr = ((de + 1) & 0xFF) | (this.a << 8); return 7; }
      case 0x13: this.setDE((this.getDE() + 1) & 0xFFFF); return 6;
      case 0x14: this.d = this._inc8(this.d); return 4;
      case 0x15: this.d = this._dec8(this.d); return 4;
      case 0x16: this.d = this._n(); return 7;
      case 0x17: { const cy = this.a >>> 7; this.a = ((this.a << 1) | (this.f & FC)) & 0xFF;
        this.f = (this.f & (FS | FZ | FPV)) | cy | (this.a & FYX); return 4; }   // RLA
      case 0x18: d = this._d(); this.pc = (this.pc + d) & 0xFFFF; this.memptr = this.pc; return 12;
      case 0x19: this._add16(idx, this.getDE()); return 11;
      case 0x1A: { const de = this.getDE(); this.a = this._rb(de);
        this.memptr = (de + 1) & 0xFFFF; return 7; }
      case 0x1B: this.setDE((this.getDE() - 1) & 0xFFFF); return 6;
      case 0x1C: this.e = this._inc8(this.e); return 4;
      case 0x1D: this.e = this._dec8(this.e); return 4;
      case 0x1E: this.e = this._n(); return 7;
      case 0x1F: { const cy = this.a & 1; this.a = (this.a >>> 1) | ((this.f & FC) << 7);
        this.f = (this.f & (FS | FZ | FPV)) | cy | (this.a & FYX); return 4; }   // RRA

      case 0x20: d = this._d(); if (!(this.f & FZ)) { this.pc = (this.pc + d) & 0xFFFF; this.memptr = this.pc; return 12; } return 7;
      case 0x21: this._shl(idx, this._nn()); return 10;
      case 0x22: nn = this._nn(); v = this._ghl(idx); this._wb(nn, v & 0xFF);
        this._wb((nn + 1) & 0xFFFF, v >>> 8); this.memptr = (nn + 1) & 0xFFFF; return 16;
      case 0x23: this._shl(idx, this._ghl(idx) + 1); return 6;
      case 0x24: this._sr(4, this._inc8(this._gr(4, idx)), idx); return 4;
      case 0x25: this._sr(4, this._dec8(this._gr(4, idx)), idx); return 4;
      case 0x26: this._sr(4, this._n(), idx); return 7;
      case 0x27: this._daa(); return 4;
      case 0x28: d = this._d(); if (this.f & FZ) { this.pc = (this.pc + d) & 0xFFFF; this.memptr = this.pc; return 12; } return 7;
      case 0x29: this._add16(idx, this._ghl(idx)); return 11;
      case 0x2A: nn = this._nn(); this._shl(idx, this._rb(nn) | (this._rb((nn + 1) & 0xFFFF) << 8));
        this.memptr = (nn + 1) & 0xFFFF; return 16;
      case 0x2B: this._shl(idx, this._ghl(idx) - 1); return 6;
      case 0x2C: this._sr(5, this._inc8(this._gr(5, idx)), idx); return 4;
      case 0x2D: this._sr(5, this._dec8(this._gr(5, idx)), idx); return 4;
      case 0x2E: this._sr(5, this._n(), idx); return 7;
      case 0x2F: this.a = (~this.a) & 0xFF;
        this.f = (this.f & (FS | FZ | FPV | FC)) | FH | FN | (this.a & FYX); return 4;  // CPL

      case 0x30: d = this._d(); if (!(this.f & FC)) { this.pc = (this.pc + d) & 0xFFFF; this.memptr = this.pc; return 12; } return 7;
      case 0x31: this.sp = this._nn(); return 10;
      case 0x32: nn = this._nn(); this._wb(nn, this.a);
        this.memptr = ((nn + 1) & 0xFF) | (this.a << 8); return 13;
      case 0x33: this.sp = (this.sp + 1) & 0xFFFF; return 6;
      case 0x34: if (idx !== 0) { addr = this._idxAddr(idx); this._wb(addr, this._inc8(this._rb(addr))); return 19; }
        addr = this._ghl(0); this._wb(addr, this._inc8(this._rb(addr))); return 11;
      case 0x35: if (idx !== 0) { addr = this._idxAddr(idx); this._wb(addr, this._dec8(this._rb(addr))); return 19; }
        addr = this._ghl(0); this._wb(addr, this._dec8(this._rb(addr))); return 11;
      case 0x36: if (idx !== 0) { addr = this._idxAddr(idx); this._wb(addr, this._n()); return 15; }
        this._wb(this._ghl(0), this._n()); return 10;
      case 0x37: this.f = (this.f & (FS | FZ | FPV)) | FC | (this.a & FYX); return 4;  // SCF
      case 0x38: d = this._d(); if (this.f & FC) { this.pc = (this.pc + d) & 0xFFFF; this.memptr = this.pc; return 12; } return 7;
      case 0x39: this._add16(idx, this.sp); return 11;
      case 0x3A: nn = this._nn(); this.a = this._rb(nn); this.memptr = (nn + 1) & 0xFFFF; return 13;
      case 0x3B: this.sp = (this.sp - 1) & 0xFFFF; return 6;
      case 0x3C: this.a = this._inc8(this.a); return 4;
      case 0x3D: this.a = this._dec8(this.a); return 4;
      case 0x3E: this.a = this._n(); return 7;
      case 0x3F: this.f = (this.f & (FS | FZ | FPV)) | ((this.f & FC) ? FH : FC) | (this.a & FYX); return 4; // CCF

      // --- 0xC0..0xFF ---
      case 0xC0: if (!(this.f & FZ)) { this.pc = this._pop(); this.memptr = this.pc; return 11; } return 5;
      case 0xC1: this.setBC(this._pop()); return 10;
      case 0xC2: nn = this._nn(); this.memptr = nn; if (!(this.f & FZ)) this.pc = nn; return 10;
      case 0xC3: nn = this._nn(); this.memptr = nn; this.pc = nn; return 10;
      case 0xC4: nn = this._nn(); this.memptr = nn; if (!(this.f & FZ)) { this._push(this.pc); this.pc = nn; return 17; } return 10;
      case 0xC5: this._push(this.getBC()); return 11;
      case 0xC6: this._add8(this._n()); return 7;
      case 0xC8: if (this.f & FZ) { this.pc = this._pop(); this.memptr = this.pc; return 11; } return 5;
      case 0xC9: this.pc = this._pop(); this.memptr = this.pc; return 10;
      case 0xCA: nn = this._nn(); this.memptr = nn; if (this.f & FZ) this.pc = nn; return 10;
      case 0xCB: return this._cb(idx);
      case 0xCC: nn = this._nn(); this.memptr = nn; if (this.f & FZ) { this._push(this.pc); this.pc = nn; return 17; } return 10;
      case 0xCD: nn = this._nn(); this.memptr = nn; this._push(this.pc); this.pc = nn; return 17;
      case 0xCE: this._adc8(this._n()); return 7;

      case 0xD0: if (!(this.f & FC)) { this.pc = this._pop(); this.memptr = this.pc; return 11; } return 5;
      case 0xD1: this.setDE(this._pop()); return 10;
      case 0xD2: nn = this._nn(); this.memptr = nn; if (!(this.f & FC)) this.pc = nn; return 10;
      case 0xD3: { const n = this._n(); const port = (this.a << 8) | n; this.bus.out(port, this.a);
        this.memptr = ((n + 1) & 0xFF) | (this.a << 8); return 11; }
      case 0xD4: nn = this._nn(); this.memptr = nn; if (!(this.f & FC)) { this._push(this.pc); this.pc = nn; return 17; } return 10;
      case 0xD5: this._push(this.getDE()); return 11;
      case 0xD6: this._sub8(this._n()); return 7;
      case 0xD8: if (this.f & FC) { this.pc = this._pop(); this.memptr = this.pc; return 11; } return 5;
      case 0xD9: { let x;                                                        // EXX
        x = this.b; this.b = this.b_; this.b_ = x;
        x = this.c; this.c = this.c_; this.c_ = x;
        x = this.d; this.d = this.d_; this.d_ = x;
        x = this.e; this.e = this.e_; this.e_ = x;
        x = this.h; this.h = this.h_; this.h_ = x;
        x = this.l; this.l = this.l_; this.l_ = x; return 4; }
      case 0xDA: nn = this._nn(); this.memptr = nn; if (this.f & FC) this.pc = nn; return 10;
      case 0xDB: { const n = this._n(); const port = (this.a << 8) | n;
        this.a = this.bus.in(port) & 0xFF; this.memptr = (port + 1) & 0xFFFF; return 11; }
      case 0xDC: nn = this._nn(); this.memptr = nn; if (this.f & FC) { this._push(this.pc); this.pc = nn; return 17; } return 10;
      case 0xDE: this._sbc8(this._n()); return 7;

      case 0xE0: if (!(this.f & FPV)) { this.pc = this._pop(); this.memptr = this.pc; return 11; } return 5;
      case 0xE1: this._shl(idx, this._pop()); return 10;
      case 0xE2: nn = this._nn(); this.memptr = nn; if (!(this.f & FPV)) this.pc = nn; return 10;
      case 0xE3: { const lo = this._rb(this.sp), hi = this._rb((this.sp + 1) & 0xFFFF);  // EX (SP),HL
        const cur = this._ghl(idx);
        this._wb(this.sp, cur & 0xFF); this._wb((this.sp + 1) & 0xFFFF, cur >>> 8);
        const nv = lo | (hi << 8); this._shl(idx, nv); this.memptr = nv; return 19; }
      case 0xE4: nn = this._nn(); this.memptr = nn; if (!(this.f & FPV)) { this._push(this.pc); this.pc = nn; return 17; } return 10;
      case 0xE5: this._push(this._ghl(idx)); return 11;
      case 0xE6: this.a &= this._n(); this.f = sz53p[this.a] | FH; return 7;
      case 0xE8: if (this.f & FPV) { this.pc = this._pop(); this.memptr = this.pc; return 11; } return 5;
      case 0xE9: this.pc = this._ghl(idx); return 4;                             // JP (HL)
      case 0xEA: nn = this._nn(); this.memptr = nn; if (this.f & FPV) this.pc = nn; return 10;
      case 0xEB: { let x = this.d; this.d = this.h; this.h = x;                  // EX DE,HL (prefix nemá vliv)
        x = this.e; this.e = this.l; this.l = x; return 4; }
      case 0xEC: nn = this._nn(); this.memptr = nn; if (this.f & FPV) { this._push(this.pc); this.pc = nn; return 17; } return 10;
      case 0xED: return this._ed();
      case 0xEE: this.a ^= this._n(); this.f = sz53p[this.a]; return 7;

      case 0xF0: if (!(this.f & FS)) { this.pc = this._pop(); this.memptr = this.pc; return 11; } return 5;
      case 0xF1: this.setAF(this._pop()); return 10;
      case 0xF2: nn = this._nn(); this.memptr = nn; if (!(this.f & FS)) this.pc = nn; return 10;
      case 0xF3: this.iff1 = 0; this.iff2 = 0; return 4;
      case 0xF4: nn = this._nn(); this.memptr = nn; if (!(this.f & FS)) { this._push(this.pc); this.pc = nn; return 17; } return 10;
      case 0xF5: this._push(this.getAF()); return 11;
      case 0xF6: this.a |= this._n(); this.f = sz53p[this.a]; return 7;
      case 0xF8: if (this.f & FS) { this.pc = this._pop(); this.memptr = this.pc; return 11; } return 5;
      case 0xF9: this.sp = this._ghl(idx); return 6;
      case 0xFA: nn = this._nn(); this.memptr = nn; if (this.f & FS) this.pc = nn; return 10;
      case 0xFB: this.iff1 = 1; this.iff2 = 1; this._eiBlock = true; return 4;
      case 0xFC: nn = this._nn(); this.memptr = nn; if (this.f & FS) { this._push(this.pc); this.pc = nn; return 17; } return 10;
      case 0xFE: this._cp8(this._n()); return 7;

      // RST
      case 0xC7: case 0xCF: case 0xD7: case 0xDF:
      case 0xE7: case 0xEF: case 0xF7: case 0xFF:
        this._push(this.pc); this.pc = op & 0x38; this.memptr = this.pc; return 11;
    }
    return 4; // nedosažitelné
  }

  _daa() {
    const old = this.a;
    let a = old;
    if (this.f & FN) {
      if ((this.f & FH) || (old & 0x0F) > 9) a -= 6;
      if ((this.f & FC) || old > 0x99) a -= 0x60;
    } else {
      if ((this.f & FH) || (old & 0x0F) > 9) a += 6;
      if ((this.f & FC) || old > 0x99) a += 0x60;
    }
    a &= 0xFF;
    this.f = (this.f & (FC | FN)) | (old > 0x99 ? FC : 0) | ((old ^ a) & FH) | sz53p[a];
    this.a = a;
  }

  // ---- CB / DDCB / FDCB ----------------------------------------------------
  _cb(idx) {
    if (idx !== 0) {
      const addr = this._idxAddr(idx);                 // nejdřív displacement
      const op = this.bus.fetch(this.pc) & 0xFF;       // opkód přes fetch, ale bez inkrementu R
      this.pc = (this.pc + 1) & 0xFFFF;
      const x = op >>> 6, y = (op >>> 3) & 7, z = op & 7;
      if (x === 1) { this._bit(y, this._rb(addr), (addr >>> 8) & 0xFF); return 16; }
      let v = this._rb(addr);
      if (x === 0) v = this._rot(y, v);
      else if (x === 2) v &= ~(1 << y) & 0xFF;
      else v |= (1 << y);
      this._wb(addr, v);
      if (z !== 6) this._sr(z, v, 0);                  // nedokumentované: uloží i do registru
      return 19;
    }
    const op = this._op();
    const x = op >>> 6, y = (op >>> 3) & 7, z = op & 7;
    if (x === 1) {
      if (z === 6) { this._bit(y, this._rb(this._ghl(0)), (this.memptr >>> 8) & 0xFF); return 12; }
      const v = this._gr(z, 0); this._bit(y, v, v); return 8;
    }
    let v = z === 6 ? this._rb(this._ghl(0)) : this._gr(z, 0);
    if (x === 0) v = this._rot(y, v);
    else if (x === 2) v &= ~(1 << y) & 0xFF;
    else v |= (1 << y);
    if (z === 6) { this._wb(this._ghl(0), v); return 15; }
    this._sr(z, v, 0);
    return 8;
  }

  // ---- ED ------------------------------------------------------------------
  _grp(p) { // páry BC/DE/HL/SP
    switch (p) { case 0: return this.getBC(); case 1: return this.getDE(); case 2: return this.getHL(); default: return this.sp; }
  }
  _srp(p, v) {
    switch (p) { case 0: this.setBC(v); break; case 1: this.setDE(v); break; case 2: this.setHL(v); break; default: this.sp = v & 0xFFFF; }
  }

  _ed() {
    const op = this._op();
    const x = op >>> 6, y = (op >>> 3) & 7, z = op & 7;

    if (x === 1) {
      switch (z) {
        case 0: { // IN r,(C) / IN (C)
          const bc = this.getBC();
          const v = this.bus.in(bc) & 0xFF;
          this.memptr = (bc + 1) & 0xFFFF;
          this.f = (this.f & FC) | sz53p[v];
          if (y !== 6) this._sr(y, v, 0);
          return 12; }
        case 1: { // OUT (C),r / OUT (C),0
          const bc = this.getBC();
          this.bus.out(bc, y === 6 ? 0 : this._gr(y, 0));
          this.memptr = (bc + 1) & 0xFFFF;
          return 12; }
        case 2:
          if (y & 1) this._adc16(this._grp(y >>> 1)); else this._sbc16(this._grp(y >>> 1));
          return 15;
        case 3: {
          const nn = this._nn();
          if (y & 1) { this._srp(y >>> 1, this._rb(nn) | (this._rb((nn + 1) & 0xFFFF) << 8)); }
          else { const v = this._grp(y >>> 1); this._wb(nn, v & 0xFF); this._wb((nn + 1) & 0xFFFF, v >>> 8); }
          this.memptr = (nn + 1) & 0xFFFF;
          return 20; }
        case 4: { // NEG (všechny varianty)
          const a = this.a, res = (0 - a) & 0xFF;
          this.f = FN | sz53[res] | (a !== 0 ? FC : 0) | ((a ^ res) & FH) | (a === 0x80 ? FPV : 0);
          this.a = res; return 8; }
        case 5: // RETN / RETI
          this.pc = this._pop(); this.memptr = this.pc; this.iff1 = this.iff2; return 14;
        case 6: this.im = IM_TAB[y]; return 8;
        default:
          switch (y) {
            case 0: this.i = this.a; return 9;
            case 1: this.r = this.a; return 9;
            case 2: this.a = this.i; this.f = (this.f & FC) | sz53[this.a] | (this.iff2 ? FPV : 0); return 9;
            case 3: this.a = this.r & 0xFF; this.f = (this.f & FC) | sz53[this.a] | (this.iff2 ? FPV : 0); return 9;
            case 4: { // RRD
              const hl = this.getHL(), v = this._rb(hl);
              this._wb(hl, ((this.a << 4) | (v >>> 4)) & 0xFF);
              this.a = (this.a & 0xF0) | (v & 0x0F);
              this.f = (this.f & FC) | sz53p[this.a];
              this.memptr = (hl + 1) & 0xFFFF; return 18; }
            case 5: { // RLD
              const hl = this.getHL(), v = this._rb(hl);
              this._wb(hl, ((v << 4) | (this.a & 0x0F)) & 0xFF);
              this.a = (this.a & 0xF0) | (v >>> 4);
              this.f = (this.f & FC) | sz53p[this.a];
              this.memptr = (hl + 1) & 0xFFFF; return 18; }
            default: return 8; // NOP
          }
      }
    }

    if (x === 2 && z < 4 && y >= 4) return this._block(y, z);
    return 8; // nedokumentované ED = NOP, 8 T
  }

  // blokové instrukce; y: 4=I,5=D,6=IR,7=DR ; z: 0=LD,1=CP,2=IN,3=OUT
  _block(y, z) {
    const inc = (y & 1) ? -1 : 1;
    const repeat = y >= 6;
    switch (z) {
      case 0: { // LDI/LDD/LDIR/LDDR
        const hl = this.getHL(), de = this.getDE();
        const v = this._rb(hl);
        this._wb(de, v);
        this.setHL((hl + inc) & 0xFFFF);
        this.setDE((de + inc) & 0xFFFF);
        const bc = (this.getBC() - 1) & 0xFFFF;
        this.setBC(bc);
        const n = (v + this.a) & 0xFF;
        this.f = (this.f & (FS | FZ | FC)) | (n & FX) | ((n & 0x02) ? FY : 0) | (bc !== 0 ? FPV : 0);
        if (repeat && bc !== 0) {
          this.pc = (this.pc - 2) & 0xFFFF;
          this.memptr = (this.pc + 1) & 0xFFFF;
          return 21;
        }
        return 16; }
      case 1: { // CPI/CPD/CPIR/CPDR
        const hl = this.getHL();
        const v = this._rb(hl);
        const a = this.a;
        const res = (a - v) & 0xFF;
        const hf = ((a & 0x0F) - (v & 0x0F)) & 0x10;
        this.setHL((hl + inc) & 0xFFFF);
        const bc = (this.getBC() - 1) & 0xFFFF;
        this.setBC(bc);
        const n = (res - (hf ? 1 : 0)) & 0xFF;
        this.f = (this.f & FC) | FN | (bc !== 0 ? FPV : 0) | hf |
          (res === 0 ? FZ : 0) | (res & FS) | (n & FX) | ((n & 0x02) ? FY : 0);
        if (repeat && bc !== 0 && res !== 0) {
          this.pc = (this.pc - 2) & 0xFFFF;
          this.memptr = (this.pc + 1) & 0xFFFF;
          return 21;
        }
        this.memptr = (this.memptr + inc) & 0xFFFF;
        return 16; }
      case 2: { // INI/IND/INIR/INDR
        const bc = this.getBC();
        const v = this.bus.in(bc) & 0xFF;
        this._wb(this.getHL(), v);
        this.memptr = (bc + inc) & 0xFFFF;
        this.b = (this.b - 1) & 0xFF;
        this.setHL((this.getHL() + inc) & 0xFFFF);
        let f = sz53[this.b] | ((v & 0x80) ? FN : 0);
        const k = v + ((this.c + inc) & 0xFF);
        if (k > 255) f |= FH | FC;
        f |= parityTab[(k & 7) ^ this.b];
        this.f = f;
        if (repeat && this.b !== 0) { this.pc = (this.pc - 2) & 0xFFFF; return 21; }
        return 16; }
      default: { // OUTI/OUTD/OTIR/OTDR
        const hl = this.getHL();
        const v = this._rb(hl);
        this.setHL((hl + inc) & 0xFFFF);
        this.b = (this.b - 1) & 0xFF;
        const port = this.getBC();
        this.bus.out(port, v);
        this.memptr = (port + inc) & 0xFFFF;
        let f = sz53[this.b] | ((v & 0x80) ? FN : 0);
        const k = v + this.l;
        if (k > 255) f |= FH | FC;
        f |= parityTab[(k & 7) ^ this.b];
        this.f = f;
        if (repeat && this.b !== 0) { this.pc = (this.pc - 2) & 0xFFFF; return 21; }
        return 16; }
    }
  }
}

export default Z80;
