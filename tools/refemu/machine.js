/**
 * machine.js — the Stinger arcade machine for the reference emulator (ST-M3).
 *
 * Models what MAME's stinger_state does (sources/mame/wiz.cpp) and what
 * GAME-DESIGN chap. 2.1/2.2 documents:
 *
 *   main CPU   Z80 @ 3.072 MHz (18.432/6), NMI once per frame at VBLANK,
 *              masked by F001 bit 0; program ROM 0000-9FFF with encrypted
 *              opcodes (separate opcode/data images, chap. 2.7)
 *   sound CPU  Z80 @ 3.072 MHz, NMI 4x per frame (240 Hz), masked by 3000 W;
 *              ROM 6-9f.bin 0000-1FFF, RAM 2000-23FF, sound latch 3000 R,
 *              AY1 5000/5001, AY2 6000/6001 (address/data), 4000 W ignored
 *
 * Timing is counted in T-states, not instructions: the game has wait loops
 * that are not synchronised with the NMI (chap. 2.5, S_160B), so a frame is
 * exactly 51200 T-states and the overshoot of the last instruction carries
 * over into the next frame.
 */
import {Z80} from './z80.js';

/** factory DIP settings, GAME-DESIGN chap. 2.4 */
export const DSW0_FACTORY = 0xEF;
export const DSW1_FACTORY = 0xAE;

/** 18.432 MHz / 6, one 60 Hz frame */
export const CPU_CLOCK = 3072000;
export const FRAME_TSTATES = CPU_CLOCK/60;      // 51200
export const SOUND_NMI_PER_FRAME = 4;           // 240 Hz

/** input keys, same notation as tools/dis/trace-stinger.py */
const KEYS_IN0 = {c: 0x01, b: 0x04, '2': 0x08, '1': 0x10, C: 0x20, f: 0x40};
const KEYS_IN1 = {r: 0x01, l: 0x02, u: 0x10, d: 0x20};

/**
 * Address space and I/O of the main CPU.
 */
export class MainBus {

  constructor(opcodes, program, options) {
    this.opc = opcodes;
    this.rom = program;
    this.dsw0 = options.dsw0;
    this.dsw1 = options.dsw1;

    this.ram = new Uint8Array(0x800);
    this.vram = [new Uint8Array(0x400), new Uint8Array(0x400)];   // [0] = E000 background, [1] = D000 foreground
    this.cram = [new Uint8Array(0x400), new Uint8Array(0x400)];   // color RAM, unused by the video hardware
    this.attr = [new Uint8Array(0x40), new Uint8Array(0x40)];
    this.spr = [new Uint8Array(0x20), new Uint8Array(0x20)];

    this.nmiEnable = 0;
    this.palbank = [0, 0];
    this.charbank = [0, 0];
    this.flip = [0, 0];
    this.bgcolor = 0;

    this.in0 = 0;
    this.in1 = 0;

    this.soundLatch = 0;
    this.frameLatches = [];      // values written to F800 during the current frame
    this.frameShots = 0;         // F80A writes (discrete shot)
    this.frameBooms = 0;         // F808 writes (discrete explosion)
    this.framesSinceWatchdog = 0;

    this.onLatch = null;         // callback(value) -> hands the byte to the sound CPU
    this.ramWrites = null;       // Map for --trace-ram
    this.writeHook = null;       // callback(addr, value) for the write trace
  } // constructor

  /** M1 opcode fetch: the decrypted image (chap. 2.7) */
  fetch(a) {
    return a < 0xA000 ? this.opc[a] : this.read(a);
  } // fetch

  read(a) {
    if (a < 0xA000) return this.rom[a];
    if (a < 0xC000) return 0xFF;                                  // A000-BFFF not populated
    if (a < 0xC800) return this.ram[a-0xC000];
    if (a >= 0xD000 && a < 0xD400) return this.vram[1][a-0xD000];
    if (a >= 0xD400 && a < 0xD800) return this.cram[1][a-0xD400];
    if (a >= 0xD800 && a < 0xD840) return this.attr[1][a-0xD800];
    if (a >= 0xD840 && a < 0xD860) return this.spr[1][a-0xD840];
    if (a >= 0xE000 && a < 0xE400) return this.vram[0][a-0xE000];
    if (a >= 0xE400 && a < 0xE800) return this.cram[0][a-0xE400];
    if (a >= 0xE800 && a < 0xE840) return this.attr[0][a-0xE800];
    if (a >= 0xE840 && a < 0xE860) return this.spr[0][a-0xE840];
    if (a == 0xF000) return this.dsw0;
    if (a == 0xF008) return this.dsw1;
    if (a == 0xF010) return this.in0;
    if (a == 0xF018) return this.in1;
    if (a == 0xF800) { this.framesSinceWatchdog = 0; return 0xFF; }
    return 0xFF;
  } // read

  write(a, v) {
    if (this.writeHook) {
      this.writeHook(a, v);
    }
    if (a < 0xC000) return;                                       // ROM
    if (a < 0xC800) {
      this.ram[a-0xC000] = v;
      if (this.ramWrites) this.ramWrites.set(a, (this.ramWrites.get(a) || 0)+1);
      return;
    }
    if (a >= 0xD000 && a < 0xD400) { this.vram[1][a-0xD000] = v; return; }
    if (a >= 0xD400 && a < 0xD800) { this.cram[1][a-0xD400] = v; return; }
    if (a >= 0xD800 && a < 0xD840) { this.attr[1][a-0xD800] = v; return; }
    if (a >= 0xD840 && a < 0xD860) { this.spr[1][a-0xD840] = v; return; }
    if (a >= 0xE000 && a < 0xE400) { this.vram[0][a-0xE000] = v; return; }
    if (a >= 0xE400 && a < 0xE800) { this.cram[0][a-0xE400] = v; return; }
    if (a >= 0xE800 && a < 0xE840) { this.attr[0][a-0xE800] = v; return; }
    if (a >= 0xE840 && a < 0xE860) { this.spr[0][a-0xE840] = v; return; }
    if (a == 0xF001) { this.nmiEnable = v & 1; return; }
    if (a == 0xF002 || a == 0xF003) { this.palbank[a-0xF002] = v & 1; return; }
    if (a == 0xF004 || a == 0xF005) { this.charbank[a-0xF004] = v & 1; return; }
    if (a == 0xF006 || a == 0xF007) { this.flip[a-0xF006] = v & 1; return; }
    if (a == 0xF800) {
      this.soundLatch = v;
      this.frameLatches.push(v);
      if (this.onLatch) this.onLatch(v);
      return;
    }
    if (a == 0xF808) { this.frameBooms++; return; }
    if (a == 0xF80A) { this.frameShots++; return; }
    if (a == 0xF818) { this.bgcolor = v; return; }
  } // write

  in(port) { return 0xFF; }
  out(port, v) {}

  /** applies a key string ('c', '1', 'lf', ...) to IN0/IN1 (active high) */
  setKeys(keys) {
    var in0 = 0, in1 = 0;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k in KEYS_IN0) in0 |= KEYS_IN0[k];
      if (k in KEYS_IN1) in1 |= KEYS_IN1[k];
    }
    this.in0 = in0;
    this.in1 = in1;
  } // setKeys

} // MainBus

/**
 * Address space of the sound CPU. AY register writes are recorded so ST-M6 can
 * compare the JS sequencer against this log.
 */
export class SoundBus {

  constructor(rom) {
    this.rom = rom;
    this.ram = new Uint8Array(0x400);
    this.nmiEnable = 0;
    this.latch = 0;

    this.ayAddr = [0, 0];
    this.ay = [new Uint8Array(16), new Uint8Array(16)];
    this.frameWrites = [];       // {ay, reg, value} written during the current frame
  } // constructor

  fetch(a) { return this.read(a); }

  read(a) {
    if (a < 0x2000) return this.rom[a];
    if (a >= 0x2000 && a < 0x2400) return this.ram[a-0x2000];
    if (a == 0x3000) return this.latch;
    return 0xFF;                 // 5000-7FFF: MAME nopr, "CPU jumps here by accident"
  } // read

  write(a, v) {
    if (a >= 0x2000 && a < 0x2400) { this.ram[a-0x2000] = v; return; }
    if (a == 0x3000) { this.nmiEnable = v & 1; return; }
    if (a == 0x4000) return;                                      // MAME nopw "?"
    if (a == 0x5000) { this.ayAddr[0] = v & 0x0F; return; }
    if (a == 0x5001) { this.ayWrite(0, v); return; }
    if (a == 0x6000) { this.ayAddr[1] = v & 0x0F; return; }
    if (a == 0x6001) { this.ayWrite(1, v); return; }
  } // write

  ayWrite(chip, v) {
    var reg = this.ayAddr[chip];
    this.ay[chip][reg] = v;
    this.frameWrites.push({ay: chip, reg: reg, value: v});
  } // ayWrite

  in(port) { return 0xFF; }
  out(port, v) {}

} // SoundBus

/**
 * The whole machine: both CPUs, one 60 Hz frame at a time.
 */
export class StingerMachine {

  /**
   * @param {Object} roms - {opcodes, program, sound}: Uint8Arrays of the decrypted
   *   opcode image, the plain program image and the sound ROM (6-9f.bin).
   * @param {Object} [options] - {dsw0, dsw1, sound: true} — DIP bytes and whether
   *   the sound CPU runs (it is mandatory for ST-M3 output, but can be turned off
   *   to speed up long traces that do not need AY logs).
   */
  constructor(roms, options) {
    options = Object.assign({dsw0: DSW0_FACTORY, dsw1: DSW1_FACTORY, sound: true}, options || {});

    this.bus = new MainBus(roms.opcodes, roms.program, options);
    this.cpu = new Z80(this.bus);
    this.cpu.reset();

    this.soundEnabled = !!options.sound;
    this.soundBus = null;
    this.soundCpu = null;
    if (this.soundEnabled) {
      this.soundBus = new SoundBus(roms.sound);
      this.soundCpu = new Z80(this.soundBus);
      this.soundCpu.reset();
      this.bus.onLatch = (v) => { this.soundBus.latch = v; };
    }

    this.frame = 0;
    this.carry = 0;              // T-states the main CPU overran the previous frame by
    this.soundCarry = 0;
    this.watchdogWarned = false;
    this.profile = null;             // {ranges: [{name, from, to, tstates, frameTstates}]}
    this.frameOffset = function() { return 0; };   // T-states into the current frame
    this.logSoundSlices = false;     // record the latch and AY state per sound NMI
    this.soundSlices = [];
  } // constructor

  /** sets the input state from a key string; see KEYS_IN0/KEYS_IN1 */
  setKeys(keys) {
    this.bus.setKeys(keys);
  } // setKeys

  /**
   * Runs exactly one 60 Hz frame: the VBLANK NMI first (as in MAME, where the
   * interrupt fires at the start of the vertical blank), then 51200 T-states of
   * the main CPU, and in parallel the sound CPU with its four NMIs.
   * @returns {Object} per-frame log: {frame, latches, shots, booms, ayWrites}
   */
  runFrame() {
    var bus = this.bus;
    bus.frameLatches = [];
    bus.frameShots = 0;
    bus.frameBooms = 0;

    if (bus.nmiEnable) {
      this.cpu.nmi();
    }
    var budget = FRAME_TSTATES-this.carry;
    var spent = 0;
    var machine = this;
    this.frameOffset = function() { return spent; };
    if (this.profile) {
      // ST-M4 aid: attribute T-states to PC ranges, so the transcription in
      // app/gameWorker.js can charge measured costs instead of guessed ones
      var prof = this.profile;
      while (spent < budget) {
        var pc = this.cpu.pc;
        var used = this.cpu.step();
        spent += used;
        for (var r = 0; r < prof.ranges.length; r++) {
          if (pc >= prof.ranges[r].from && pc <= prof.ranges[r].to) {
            prof.ranges[r].tstates += used;
            prof.ranges[r].frameTstates += used;
            break;
          }
        }
      }
    } else {
      while (spent < budget) {
        spent += this.cpu.step();
      }
    }
    this.carry = spent-budget;

    var ayWrites = [];
    if (this.soundEnabled) {
      ayWrites = this.runSoundFrame();
    }

    bus.framesSinceWatchdog++;
    if (!this.watchdogWarned && bus.framesSinceWatchdog > 300) {
      // the real board would reset here; refemu only reports it, so a timing
      // difference never silently restarts a trace
      console.error('refemu: watchdog (F800) not read for 300 frames at frame '+this.frame);
      this.watchdogWarned = true;
    }

    var log = {
      frame: this.frame,
      latches: bus.frameLatches.slice(),
      shots: bus.frameShots,
      booms: bus.frameBooms,
      ayWrites: ayWrites
    };
    this.frame++;
    return log;
  } // runFrame

  /** one frame of the sound CPU: four NMI slices of 12800 T-states each */
  runSoundFrame() {
    var slice = FRAME_TSTATES/SOUND_NMI_PER_FRAME;
    this.soundBus.frameWrites = [];
    this.soundSlices = [];
    for (var n = 0; n < SOUND_NMI_PER_FRAME; n++) {
      // the value the sound CPU is about to see: it reads the latch once per
      // NMI (notes/E.md (b)), so this is the pairing that decides what plays
      var latchSeen = this.soundBus.latch;
      if (this.soundBus.nmiEnable) {
        this.soundCpu.nmi();
      }
      var budget = slice-this.soundCarry;
      var spent = 0;
      while (spent < budget) {
        spent += this.soundCpu.step();
      }
      this.soundCarry = spent-budget;
      if (this.logSoundSlices) {
        this.soundSlices.push({
          nmi: n,
          latch: latchSeen,
          ay: [this.soundBus.ay[0].slice(), this.soundBus.ay[1].slice()]
        });
      }
    }
    return this.soundBus.frameWrites;
  } // runSoundFrame

  /**
   * The frame state in the worker protocol shape (app/WORKER-PROTOCOL.md), ready
   * for app/tileMapRender.js.
   */
  videoState() {
    var bus = this.bus;
    return {
      vram: [bus.vram[0], bus.vram[1]],
      attr: [bus.attr[0], bus.attr[1]],
      sprites: [bus.spr[0], bus.spr[1]],
      regs: {
        palbank: bus.palbank[0] | (bus.palbank[1] << 1),
        charbank: [bus.charbank[0], bus.charbank[1]],
        bgcolor: bus.bgcolor,
        flip: [bus.flip[0], bus.flip[1]]
      }
    };
  } // videoState

  /**
   * Raw dump in exactly the layout tools/dis/trace-stinger.py --dump produces, so
   * the Python tracer and refemu stay byte-comparable:
   * RAM 2048 | VRAM1 1024 | ATTR1 64 | SPR1 32 | VRAM0 1024 | ATTR0 64 | SPR0 32 |
   * nmiEnable, palbank0, palbank1, charbank0, charbank1, bgcolor
   */
  dump() {
    var bus = this.bus;
    var out = new Uint8Array(0x800+2*(0x400+0x40+0x20)+6);
    var p = 0;
    var put = (src) => { out.set(src, p); p += src.length; };
    put(bus.ram);
    put(bus.vram[1]); put(bus.attr[1]); put(bus.spr[1]);
    put(bus.vram[0]); put(bus.attr[0]); put(bus.spr[0]);
    out.set([bus.nmiEnable, bus.palbank[0], bus.palbank[1], bus.charbank[0], bus.charbank[1], bus.bgcolor], p);
    return out;
  } // dump

  /** main CPU register snapshot for trace files */
  registers() {
    var c = this.cpu;
    return {
      pc: c.pc, sp: c.sp, af: c.getAF(), bc: c.getBC(), de: c.getDE(), hl: c.getHL(),
      ix: c.ix, iy: c.iy, i: c.i, im: c.im, iff1: c.iff1, halted: c.halted ? 1 : 0,
      tstates: c.tstates
    };
  } // registers

} // StingerMachine

export default StingerMachine;
