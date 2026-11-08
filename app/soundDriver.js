// begin code

/**
 * The sound program of Stinger, transcribed 1:1 from sources/asm/stinger/sound.asm
 * (ST-M6), the way app/gameWorker.js transcribes the main program (ST-M4).
 * Deliberately free of DOM and Node dependencies, so the very same module runs in
 * the AudioWorklet of the browser and in tools/regress-sound.mjs under Node.
 *
 * The board (GAME-DESIGN chap. 2.6, notes/E.md): a second Z80 with an 8 KiB ROM
 * (6-9f.bin) at 0000-1FFF, 1 KiB of RAM at 2000-23FF, the latch of the main CPU
 * at 3000 (read: command, write bit 0: NMI enable) and two AY-3-8910 at
 * 5000/5001 and 6000/6001. The only clock the program has is its NMI, 240 Hz,
 * four per video frame; every note length is counted in those ticks.
 *
 * Structure of one NMI period, and of one nmi() call:
 *   1. NMI 0066: disable NMI, write the register shadow of both AYs (AY1 R0-R7
 *      from 2100-2107, R8/R9/R10 from 2140/2142/2144; AY2 R0-R7 from 2108-210F,
 *      R8/R9/R10 from 2148/214A/214C), copy the latch into cmdLatch 2000,
 *      increment the six tick counters 2120/2122/2124/2128/212A/212C, enable NMI.
 *   2. the main loop 0187: take the command apart by priority (bit 5 selects the
 *      AY2 group), then the sequencer 01F7, which prepares the shadow the *next*
 *      NMI will write. The loop is re-entered until the next NMI, and every step
 *      of it is idempotent within one tick, so the shadow is complete either way.
 *
 * RAM lives at its original addresses (rd(0x2100), wr(0x2140, v)), and the note
 * data is read from a sparse ROM image built from data/sound.json — data only,
 * never the program (decision of 2026-08-30). Reading an address the tables do
 * not carry is reported: it means the transcription strayed into code.
 *
 * Why there is a T-state model here after all. The program looks purely per-NMI,
 * and it is - except that NMI is *maskable* by the latch port, and two routines
 * hold it masked for longer than one NMI period: the RAM clear of the reset
 * (0171, 23 623 T = 1.85 periods). Command 90h, which the main CPU sends 16
 * times, reaches an unmapped pointer and resets the sound CPU (notes/E.md (g)),
 * so this happens constantly - during attract mode it is the *only* thing that
 * happens. The reference emulator therefore drops one or two NMIs after every
 * 90h, and which of them it drops decides on which NMI the next command is
 * heard. So every routine charges its exact T-states and the main loop is a
 * generator that can be interrupted between two instructions, exactly like the
 * original; nmi() takes an NMI only when the latch port has it enabled at the
 * period boundary. Instruction times are the ones of tools/refemu/z80.js.
 */

const SLICE_TSTATES = 12800;         // 51200 T per frame / 4 NMIs = 240 Hz
const NMI_TSTATES = 1544;            // 0066-016F including the 11 T of acceptance

/** the six channel structures, in the order the sequencer 01F7 walks them */
const CHANNELS = [0x2100, 0x2102, 0x2104, 0x2108, 0x210A, 0x210C];

/** pointer set-up of every command handler: pairs of (IX offset, value) */
const CMD_DATA = {
  cmd02: [48,0x90, 49,0x08, 80,0x90, 81,0x08, 50,0xF0, 51,0x08, 82,0xF0, 83,0x08,
          52,0x50, 53,0x09, 84,0x50, 85,0x09, 56,0xA0, 57,0x09, 88,0xA0, 89,0x09,
          58,0x10, 59,0x0A, 90,0x10, 91,0x0A, 60,0x4F, 61,0x0A, 92,0x4F, 93,0x0A],
  cmd04: [48,0x80, 49,0x0A, 80,0x80, 81,0x0A, 50,0xA0, 51,0x0A, 82,0xA0, 83,0x0A,
          52,0xC0, 53,0x0A, 84,0xC0, 85,0x0A, 56,0xE0, 57,0x0A, 88,0xE0, 89,0x0A,
          58,0x00, 59,0x0B, 90,0x00, 91,0x0B, 60,0x20, 61,0x0B, 92,0x20, 93,0x0B],
  cmd06: [48,0xA0, 49,0x15, 80,0xA0, 81,0x15, 50,0x20, 51,0x16, 82,0x20, 83,0x16,
          52,0xA0, 53,0x16, 84,0xA0, 85,0x16, 56,0x20, 57,0x17, 88,0x20, 89,0x17,
          58,0xA0, 59,0x17, 90,0xA0, 91,0x17, 60,0x20, 61,0x18, 92,0x20, 93,0x18],
  cmd08: [48,0x80, 49,0x14, 80,0x80, 81,0x14, 50,0xB0, 51,0x14, 82,0xB0, 83,0x14,
          52,0xE0, 53,0x14, 84,0xE0, 85,0x14, 56,0x10, 57,0x15, 88,0x10, 89,0x15,
          58,0x40, 59,0x15, 90,0x40, 91,0x15, 60,0x70, 61,0x15, 92,0x70, 93,0x15],
  cmd0A: [48,0xA0, 49,0x18, 80,0xA0, 81,0x18, 50,0x20, 51,0x19, 82,0x20, 83,0x19,
          52,0xA0, 53,0x19, 84,0xA0, 85,0x19, 56,0x20, 57,0x1A, 88,0x20, 89,0x1A,
          58,0xA0, 59,0x1A, 90,0xA0, 91,0x1A, 60,0x20, 61,0x1B, 92,0x20, 93,0x1B],
  // 0C: the three AY2 pointers stay 0000h (notes/E.md (h)) - a data bug of the
  // original, which then plays the start of its own ROM as note data
  cmd0C: [48,0x20, 49,0x11, 80,0x20, 81,0x11, 50,0x40, 51,0x11, 82,0x40, 83,0x11,
          52,0x60, 53,0x11, 84,0x60, 85,0x11, 56,0x00, 57,0x00, 88,0x00, 89,0x00,
          58,0x00, 59,0x00, 90,0x00, 91,0x00, 60,0x00, 61,0x00, 92,0x00, 93,0x00],
  cmd0E: [48,0x00, 49,0x00, 80,0x00, 81,0x00, 50,0x00, 51,0x00, 82,0x00, 83,0x00,
          52,0x00, 53,0x00, 84,0x00, 85,0x00, 56,0x00, 57,0x00, 88,0x00, 89,0x00,
          58,0x00, 59,0x00, 90,0x00, 91,0x00, 60,0x00, 61,0x00, 92,0x00, 93,0x00],
  cmd10: [48,0x50, 49,0x0E, 80,0x50, 81,0x0E, 50,0x70, 51,0x0E, 82,0x70, 83,0x0E,
          52,0x90, 53,0x0E, 84,0x90, 85,0x0E],
  cmd12: [48,0xB0, 49,0x0E, 80,0xB0, 81,0x0E, 50,0x00, 51,0x0F, 82,0x00, 83,0x0F,
          52,0x50, 53,0x0F, 84,0x50, 85,0x0F],
  cmd14: [48,0x80, 49,0x11, 80,0x80, 81,0x11, 50,0xF0, 51,0x11, 82,0xF0, 83,0x11,
          52,0x60, 53,0x12, 84,0x60, 85,0x12],
  cmd16: [48,0x00, 49,0x10, 80,0x00, 81,0x10, 50,0x20, 51,0x10, 82,0x20, 83,0x10,
          52,0x40, 53,0x10, 84,0x40, 85,0x10],
  cmd20: [56,0xA0, 57,0x1B, 88,0xA0, 89,0x1B, 58,0xA0, 59,0x1C, 90,0xA0, 91,0x1C,
          60,0xB0, 61,0x1D, 92,0xB0, 93,0x1D],
  cmd22: [56,0x60, 57,0x10, 88,0x60, 89,0x10, 58,0x80, 59,0x10, 90,0x80, 91,0x10,
          60,0xA0, 61,0x10, 92,0xA0, 93,0x10],
  cmd24: [56,0xC0, 57,0x10, 88,0xC0, 89,0x10, 58,0xE0, 59,0x10, 90,0xE0, 91,0x10,
          60,0x00, 61,0x11, 92,0x00, 93,0x11],
  // 26: the loop pointer of AY2 A is 0F80h, the start 0F70h - harmless, the FFh
  // mark never occurs in the data (notes/E.md (h))
  cmd26: [56,0x70, 57,0x0F, 88,0x80, 89,0x0F, 58,0xA0, 59,0x0F, 90,0xA0, 91,0x0F,
          60,0xD0, 61,0x0F, 92,0xD0, 93,0x0F],
  cmd28: [56,0xD0, 57,0x12, 88,0xD0, 89,0x12, 58,0x10, 59,0x13, 90,0x10, 91,0x13,
          60,0x50, 61,0x13, 92,0x50, 93,0x13],
  cmd2A: [56,0x90, 57,0x13, 88,0x90, 89,0x13, 58,0xE0, 59,0x13, 90,0xE0, 91,0x13,
          60,0x30, 61,0x14, 92,0x30, 93,0x14]
};

/** hold thresholds of dur_sus192 .. dur_sus1 (table 03A1-03C8) */
const SUS_TICKS = [0xC0, 0x90, 0x60, 0x48, 0x30, 0x24, 0x18, 0x12, 0x0C, 0x09, 0x06, 0x03, 0x02, 0x01];

export class SoundDriver {

  /**
   * @param {Object} data - the parsed contents of data/sound.json: {tables: [{addr, data}]}
   *   with the note data and the command table of the sound ROM, base64 encoded
   *   (tools/rom2sound.mjs).
   */
  constructor(data) {
    this.id = 'SoundDriver';

    this.rom = new Uint8Array(0x2000);
    this.romKnown = new Uint8Array(0x2000);
    this.reported = {};
    this.loadTables(data);

    this.ram = new Uint8Array(0x400);                        // 2000-23FF
    this.ay = [new Uint8Array(16), new Uint8Array(16)];      // 5000/5001 and 6000/6001

    this.reset();
  } // constructor

  // -------------------------------------------------------------- ROM tables
  /** rebuilds the sparse image of the sound ROM from data/sound.json */
  loadTables(data) {
    var list = data && data.tables ? data.tables : data;
    if (!Array.isArray(list)) {
      throw new Error('SoundDriver: data/sound.json has no tables');
    }
    for (var entry of list) {
      var addr = typeof entry.addr == 'string' ? parseInt(entry.addr, 16) : entry.addr;
      var bytes = this.decodeTableData(entry.data);
      for (var i = 0; i < bytes.length; i++) {
        this.rom[addr+i] = bytes[i];
        this.romKnown[addr+i] = 1;
      }
    }
  } // loadTables

  /** table bytes are base64 (rom2sound.mjs); a plain array is accepted too */
  decodeTableData(data) {
    if (Array.isArray(data)) {
      return data;
    }
    var binary = typeof atob == 'function' ? atob(data) : Buffer.from(data, 'base64').toString('latin1');
    var out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } // decodeTableData

  /** reports an address the tables do not carry: the transcription hit code */
  report(what) {
    if (!this.reported[what]) {
      this.reported[what] = 1;
      console.log('soundDriver: '+what);
    }
  } // report

  // --------------------------------------------------------------- the bus
  /** one byte of the original address space of the sound CPU */
  rd(a) {
    a &= 0xFFFF;
    if (a < 0x2000) {
      if (!this.romKnown[a]) {
        this.report('read of sound ROM '+hex4(a)+', which data/sound.json does not carry');
      }
      return this.rom[a];
    }
    if (a < 0x2400) return this.ram[a-0x2000];
    if (a == 0x3000) return this.latchPort;
    return 0xFF;                       // unmapped, as MAME and refemu: "nopr"
  } // rd

  wr(a, v) {
    a &= 0xFFFF;
    if (a >= 0x2000 && a < 0x2400) {
      this.ram[a-0x2000] = v & 0xFF;
    }
  } // wr

  /** (IX+d) of the channel structure the sequencer currently walks */
  ixRd(d) { return this.rd(this.ix+d); }
  ixWr(d, v) { this.wr(this.ix+d, v); }

  // ------------------------------------------------------------- public API
  /** reset of the sound CPU: it starts at 0000 with NMI disabled */
  reset() {
    this.ram.fill(0);
    this.ay[0].fill(0);
    this.ay[1].fill(0);
    this.ix = 0x2100;
    this.nmiEnable = 0;
    this.latchPort = 0;
    this.t = 0;
    this.sliceEnd = 0;
    this.cpu = this.run_0000();
  } // reset

  /**
   * One 240 Hz period: the NMI (if the program has it enabled) and the main loop
   * up to the next period boundary.
   * @param {number} latch - the byte the sound CPU sees at 3000, i.e. what the
   *   main CPU last wrote to F800.
   */
  nmi(latch) {
    this.latchPort = latch & 0xFF;
    if (this.nmiEnable) {
      this.nmi_0066();
    }
    this.sliceEnd += SLICE_TSTATES;
    while (this.t < this.sliceEnd) {
      var step = this.cpu.next();
      this.t += step.value | 0;
    }
  } // nmi

  // ----------------------------------------------------------------- 0066
  /**
   * nmi 0066: the whole handler runs inside one period (1544 T of 12800), so it
   * is executed in one piece; it is the only writer of the AY registers.
   */
  nmi_0066() {
    this.nmiEnable = 0;
    this.wr(0x2000, this.latchPort);                         // cmdLatch 007B

    var shadow = [                                           // 0082-0149
      [0x2100, 0x2101, 0x2102, 0x2103, 0x2104, 0x2105, 0x2106, 0x2107, 0x2140, 0x2142, 0x2144],
      [0x2108, 0x2109, 0x210A, 0x210B, 0x210C, 0x210D, 0x210E, 0x210F, 0x2148, 0x214A, 0x214C]
    ];
    for (var chip = 0; chip < 2; chip++) {
      for (var r = 0; r < 11; r++) {
        this.ay[chip][r] = this.rd(shadow[chip][r]);
      }
    }
    for (var tick of [0x2120, 0x2122, 0x2124, 0x2128, 0x212A, 0x212C]) {   // 014A-0159
      this.wr(tick, (this.rd(tick)+1) & 0xFF);
    }

    this.nmiEnable = 1;                                      // 016B
    this.t += NMI_TSTATES;
  } // nmi_0066

  // ----------------------------------------------------------------- 0000
  /** the program as the CPU runs it: reset, then the main loop for ever */
  *run_0000() {
    var next = 'reset';
    for (;;) {
      if (next == 'reset') {
        yield* this.reset_0000();
        next = 'loop';
      } else {
        next = yield* this.main_loop_0187();
      }
    }
  } // run_0000

  /** reset 0000: disable NMI, clear the RAM, enable NMI, fall into the main loop */
  *reset_0000() {
    yield 4;                                                 // XOR A
    this.nmiEnable = 0; yield 13;                            // LD (LATCH),A
    yield 10;                                                // JP init_ram
    yield* this.init_ram_0171();
  } // reset_0000

  /**
   * init_ram 0171: 4 pages of RAM, SP = 2400h, NMI enable. 23 623 T of the clear
   * run with NMI masked, which is why the board misses NMIs after every 90h.
   */
  *init_ram_0171() {
    yield 7;                                                 // LD B,04h
    var h = 0x20; yield 10;                                  // LD HL,cmdLatch
    for (var b = 4; b > 0; b--) {
      for (var l = 0; l < 256; l++) {
        this.wr((h << 8) | l, 0); yield 7;                   // LD (HL),A
        yield 4;                                             // INC L
        yield (l == 255 ? 7 : 12);                           // JR NZ,L_0176
      }
      h = (h+1) & 0xFF; yield 4;                             // INC H
      yield 7;                                               // LD L,00h
      yield (b > 1 ? 13 : 8);                                // DJNZ L_0176
    }
    yield 10;                                                // LD SP,stackTop
    yield 7;                                                 // LD A,01h
    this.nmiEnable = 1; yield 13;                            // LD (LATCH),A
  } // init_ram_0171

  // ----------------------------------------------------------------- 0187
  /** main_loop 0187: one pass; returns 'loop' or 'reset' */
  *main_loop_0187() {
    yield 13;                                                // LD A,(busy6ch)
    yield 7;                                                 // CP 00h - no effect
    yield 4; yield 4; yield 4;                               // NOP NOP NOP
    var a = this.rd(0x2000); yield 13;                       // LD A,(cmdLatch)
    yield 7;                                                 // CP 00h
    yield 10;                                                // JP Z,cmd00_release
    if (a == 0) {
      return yield* this.cmd00_release_0DD4();
    }
    var b = a; yield 4;                                      // LD B,A
    yield 7;                                                 // AND 20h
    yield 7;                                                 // CP 20h
    yield 10;                                                // JP Z,cmd_groupB
    if ((a & 0x20) == 0x20) {
      return yield* this.cmd_groupB_01B3(b);
    }
    var cur = this.rd(0x2001); yield 13;                     // LD A,(curCmdA)
    yield 4;                                                 // CP B
    if (cur >= b) {
      yield 12;                                              // JR NC,groupA_lower
      return yield* this.groupA_lower_01D9(b);
    }
    yield 7;
    yield 4;                                                 // LD A,B
    this.wr(0x2001, b); yield 13;                            // LD (curCmdA),A
    return yield* this.dispatch_cmd_01A9(b);
  } // main_loop_0187

  /** cmd_groupB 01B3: the AY2 half takes a command only if it is higher */
  *cmd_groupB_01B3(b) {
    var cur = this.rd(0x2002); yield 13;                     // LD A,(curCmdB)
    yield 4;                                                 // CP B
    if (cur >= b) {
      yield 12;                                              // JR NC,groupB_lower
      return yield* this.groupB_lower_01C0(b);
    }
    yield 7;
    yield 4;                                                 // LD A,B
    this.wr(0x2002, b); yield 13;                            // LD (curCmdB),A
    yield 10;                                                // JP dispatch_cmd
    return yield* this.dispatch_cmd_01A9(b);
  } // cmd_groupB_01B3

  /**
   * groupB_lower 01C0. The trap of this routine (and of groupA_lower): the
   * command is held in B, and clear_groupA goes through RST 20h, whose LD B,08h
   * leaves B = 0. So the branch that is meant to accept the command once the
   * group has fallen silent accepts 00h instead - curCmdB = 0 and a dispatch to
   * cmd00_release. The held latch does restart the sound, but only on the next
   * pass of the main loop, when the command is read from cmdLatch again against
   * the priority that has just been cleared. notes/E.md (c) misses this.
   */
  *groupB_lower_01C0(b) {
    var busyA = this.rd(0x2005); yield 13;
    yield 7;                                                 // CP 00h
    if (busyA != 0) {
      yield 12;                                              // JR NZ,L_01CA
    } else {
      yield 7;
      yield 17;                                              // CALL clear_groupA
      yield* this.clear_groupA_0E13();
      b = 0;                                                 // rst20_clear8 leaves B = 0
    }
    var busyB = this.rd(0x2006); yield 13;
    yield 7;                                                 // CP 00h
    yield 10;                                                // JP NZ,sequencer
    if (busyB != 0) {
      return yield* this.sequencer_01F7();
    }
    yield 4;                                                 // LD A,B
    this.wr(0x2002, b); yield 13;                            // LD (curCmdB),A
    yield 10;                                                // JP dispatch_cmd
    return yield* this.dispatch_cmd_01A9(b);
  } // groupB_lower_01C0

  /** groupA_lower 01D9, symmetrical to groupB_lower - and with the same B = 0 */
  *groupA_lower_01D9(b) {
    var busyB = this.rd(0x2006); yield 13;
    yield 7;                                                 // CP 00h
    if (busyB != 0) {
      yield 12;                                              // JR NZ,L_01E3
    } else {
      yield 7;
      yield 17;                                              // CALL clear_groupB
      yield* this.clear_groupB_0E2C();
      b = 0;                                                 // rst20_clear8 leaves B = 0
    }
    var busyA = this.rd(0x2005); yield 13;
    yield 7;                                                 // CP 00h
    yield 10;                                                // JP NZ,sequencer
    if (busyA != 0) {
      return yield* this.sequencer_01F7();
    }
    yield 4;                                                 // LD A,B
    this.wr(0x2001, b); yield 13;                            // LD (curCmdA),A
    yield 10;                                                // JP dispatch_cmd
    return yield* this.dispatch_cmd_01A9(b);
  } // groupA_lower_01D9

  /**
   * dispatch_cmd 01A9: HL = 0520h + A, but only through L, so a command outside
   * 00-30h takes its pointer from wherever that lands on page 05xx. Only the
   * table 0520-055F is data; everything around it is the program, which lives
   * here as JavaScript and not as bytes - and every one of those pointers ends
   * in a reset of the sound CPU anyway (notes/E.md (g): 90h -> 05B0h = 5436h,
   * unmapped -> FFh = RST 38h -> JP 0000; 18h-1Eh -> 0000h directly).
   */
  *dispatch_cmd_01A9(a) {
    yield 10;                                                // LD HL,cmd_table
    yield 4;                                                 // ADD A,L
    yield 4;                                                 // LD L,A
    var l = (0x20 + a) & 0xFF;
    var lo, hi;
    if (l <= 0x51) {
      lo = this.rd(0x0500 | l); yield 7;                     // LD E,(HL)
      yield 4;                                               // INC L
      hi = this.rd(0x0500 | ((l+1) & 0xFF)); yield 7;        // LD D,(HL)
    } else {
      yield 7; yield 4; yield 7;
      lo = 0x36; hi = 0x54;                                  // 05B0/05B1, inside cmd02_tune
    }
    yield 4;                                                 // EX DE,HL
    yield 4;                                                 // JP (HL)
    var target = (hi << 8) | lo;
    var handler = this.command(target);
    if (handler) {
      return yield* handler.call(this);
    }
    if (target != 0x0000) {
      yield 11;                                              // FFh at 5436h = RST 38h
      yield 10;                                              // 0038: JP 0000
    }
    return 'reset';
  } // dispatch_cmd_01A9

  /** the entries of cmd_table 0520 that point at a handler of this program */
  command(target) {
    switch (target) {
      case 0x0DD4: return this.cmd00_release_0DD4;
      case 0x057A: return function*() { return yield* this.cmdTune6(CMD_DATA.cmd02); };
      case 0x05EA: return function*() { return yield* this.cmdTune6(CMD_DATA.cmd04); };
      case 0x065A: return function*() { return yield* this.cmdTune6(CMD_DATA.cmd06); };
      case 0x06CA: return function*() { return yield* this.cmdTune6(CMD_DATA.cmd08); };
      case 0x073A: return function*() { return yield* this.cmdTune6(CMD_DATA.cmd0A); };
      case 0x07AA: return function*() { return yield* this.cmdTune6(CMD_DATA.cmd0C); };
      case 0x081A: return function*() { return yield* this.cmdTune6(CMD_DATA.cmd0E); };
      case 0x0B66: return function*() { return yield* this.cmdFxA(CMD_DATA.cmd10); };
      case 0x0BA0: return function*() { return yield* this.cmdFxA(CMD_DATA.cmd12); };
      case 0x0BDA: return function*() { return yield* this.cmdFxA(CMD_DATA.cmd14); };
      case 0x0C14: return function*() { return yield* this.cmdFxA(CMD_DATA.cmd16); };
      case 0x0D26: return function*() { return yield* this.cmdFxB(CMD_DATA.cmd20); };
      case 0x0C78: return function*() { return yield* this.cmdFxB(CMD_DATA.cmd22); };
      case 0x0CB2: return function*() { return yield* this.cmdFxB(CMD_DATA.cmd24); };
      case 0x0CEC: return function*() { return yield* this.cmdFxB(CMD_DATA.cmd26); };
      case 0x0D60: return function*() { return yield* this.cmdFxB(CMD_DATA.cmd28); };
      case 0x0D9A: return function*() { return yield* this.cmdFxB(CMD_DATA.cmd2A); };
      case 0x0E04: return this.cmd2C_stopB_0E04;
      case 0x0E0A: return this.cmd2E_stopA_0E0A;
      case 0x0E10: return this.cmd30_nop_0E10;
      default: return null;
    }
  } // command

  // ------------------------------------------------------- command handlers
  /**
   * cmd02/04/06/08/0A/0C/0E 057A..081A: a six channel tune. It refuses to start
   * while the AY1 group plays, so a tune that lost the priority race is dropped
   * even though curCmdA has already been raised (notes/E.md (c)).
   */
  *cmdTune6(list) {
    var busyA = this.rd(0x2005); yield 13;
    yield 7;                                                 // CP 00h
    yield 10;                                                // JP NZ,sequencer
    if (busyA != 0) {
      return yield* this.sequencer_01F7();
    }
    yield 11;                                                // RST 10h
    yield* this.rst10_clearCh_0010();
    this.ix = 0x2100; yield 14;                              // LD IX,chA1Per
    for (var i = 0; i < list.length; i += 2) {
      this.ixWr(list[i], list[i+1]); yield 19;               // LD (IX+d),n
    }
    yield 10;                                                // JP start_6ch
    return yield* this.start_6ch_0552();
  } // cmdTune6

  /** cmd10/12/14/16 0B66..0C14: an AY1 effect - it interrupts whatever plays */
  *cmdFxA(list) {
    yield 17;                                                // CALL clear_groupA
    yield* this.clear_groupA_0E13();
    this.ix = 0x2100; yield 14;                              // LD IX,chA1Per
    for (var i = 0; i < list.length; i += 2) {
      this.ixWr(list[i], list[i+1]); yield 19;
    }
    yield 10;                                                // JP start_ay1
    return yield* this.start_ay1_0C4E();
  } // cmdFxA

  /** cmd20/22/24/26/28/2A 0C78..0D9A: an AY2 tune or effect */
  *cmdFxB(list) {
    yield 17;                                                // CALL clear_groupB
    yield* this.clear_groupB_0E2C();
    this.ix = 0x2100; yield 14;                              // LD IX,chA1Per
    for (var i = 0; i < list.length; i += 2) {
      this.ixWr(list[i], list[i+1]); yield 19;
    }
    yield 10;                                                // JP start_ay2
    return yield* this.start_ay2_0C63();
  } // cmdFxB

  /** start_6ch 0552: all six channels active, both groups busy, mixers F8h */
  *start_6ch_0552() {
    yield 7;                                                 // LD A,FFh
    for (var d of [16, 18, 20, 24, 26, 28]) {
      this.ixWr(d, 0xFF); yield 19;
    }
    this.wr(0x2005, 0xFF); yield 13;                         // busyA
    this.wr(0x2006, 0xFF); yield 13;                         // busyB
    this.wr(0x2007, 0xFF); yield 13;                         // busy6ch
    this.ixWr(7, 0xF8); yield 19;                            // AY1 mixer
    this.ixWr(15, 0xF8); yield 19;                           // AY2 mixer
    yield 10;                                                // JP sequencer
    return yield* this.sequencer_01F7();
  } // start_6ch_0552

  /** start_ay1 0C4E */
  *start_ay1_0C4E() {
    yield 7;                                                 // LD A,FFh
    for (var d of [16, 18, 20]) {
      this.ixWr(d, 0xFF); yield 19;
    }
    this.wr(0x2005, 0xFF); yield 13;
    this.ixWr(7, 0xF8); yield 19;
    yield 10;
    return yield* this.sequencer_01F7();
  } // start_ay1_0C4E

  /** start_ay2 0C63 */
  *start_ay2_0C63() {
    yield 7;                                                 // LD A,FFh
    for (var d of [24, 26, 28]) {
      this.ixWr(d, 0xFF); yield 19;
    }
    this.wr(0x2006, 0xFF); yield 13;
    this.ixWr(15, 0xF8); yield 19;
    yield 10;
    return yield* this.sequencer_01F7();
  } // start_ay2_0C63

  /**
   * cmd00_release 0DD4: zero releases the priority of a group that has finished
   * playing; it never stops a sound. The main CPU writes it every frame.
   */
  *cmd00_release_0DD4() {
    var busyA = this.rd(0x2005); yield 13;
    yield 7;                                                 // CP 00h
    yield 10;                                                // JP NZ,cmd00_A_busy
    if (busyA != 0) {
      return yield* this.cmd00_A_busy_0DF3();
    }
    this.wr(0x2001, 0); yield 13;                            // LD (curCmdA),A
    yield 17;                                                // CALL clear_groupA
    yield* this.clear_groupA_0E13();
    var busyB = this.rd(0x2006); yield 13;
    yield 7;                                                 // CP 00h
    yield 10;                                                // JP NZ,sequencer
    if (busyB != 0) {
      return yield* this.sequencer_01F7();
    }
    this.wr(0x2002, 0); yield 13;                            // LD (curCmdB),A
    yield 17;                                                // CALL clear_groupB
    yield* this.clear_groupB_0E2C();
    yield 10;                                                // JP main_loop
    return 'loop';
  } // cmd00_release_0DD4

  /** cmd00_A_busy 0DF3 */
  *cmd00_A_busy_0DF3() {
    var busyB = this.rd(0x2006); yield 13;
    yield 7;
    yield 10;                                                // JP NZ,sequencer
    if (busyB != 0) {
      return yield* this.sequencer_01F7();
    }
    this.wr(0x2002, 0); yield 13;
    yield 17;                                                // CALL clear_groupB
    yield* this.clear_groupB_0E2C();
    yield 10;                                                // JP sequencer
    return yield* this.sequencer_01F7();
  } // cmd00_A_busy_0DF3

  /** cmd2C_stopB 0E04 - the main CPU never sends it */
  *cmd2C_stopB_0E04() {
    yield 17;
    yield* this.clear_groupB_0E2C();
    yield 10;
    return yield* this.sequencer_01F7();
  } // cmd2C_stopB_0E04

  /** cmd2E_stopA 0E0A - the main CPU never sends it */
  *cmd2E_stopA_0E0A() {
    yield 17;
    yield* this.clear_groupA_0E13();
    yield 10;
    return yield* this.sequencer_01F7();
  } // cmd2E_stopA_0E0A

  /** cmd30_nop 0E10 */
  *cmd30_nop_0E10() {
    yield 10;
    return yield* this.sequencer_01F7();
  } // cmd30_nop_0E10

  // ---------------------------------------------------------------- clearing
  /** rst10_clearCh 0010: zeroes 2100-2163, every channel structure at once */
  *rst10_clearCh_0010() {
    var l = 0x00; yield 10;                                  // LD HL,chA1Per
    yield 7;                                                 // LD B,64h
    yield 4;                                                 // XOR A
    for (var i = 0; i < 0x64; i++) {
      this.wr(0x2100 | l, 0); yield 7;                       // LD (HL),A
      l = (l+1) & 0xFF; yield 4;                             // INC L
      yield (i < 0x63 ? 13 : 8);                             // DJNZ L_0016
    }
    yield 10;                                                // RET
  } // rst10_clearCh_0010

  /** rst20_clear8 0020: zeroes 8 bytes from HL */
  *rst20_clear8_0020(hl) {
    yield 4;                                                 // XOR A
    yield 7;                                                 // LD B,08h
    for (var i = 0; i < 8; i++) {
      this.wr(hl, 0); yield 7;                               // LD (HL),A
      hl = (hl & 0xFF00) | ((hl+1) & 0xFF); yield 4;         // INC L
      yield (i < 7 ? 13 : 8);                                // DJNZ
    }
    yield 10;                                                // RET
  } // rst20_clear8_0020

  /** clear_groupA 0E13: the six rows of the AY1 channel structures */
  *clear_groupA_0E13() {
    for (var hl of [0x2100, 0x2110, 0x2120, 0x2130, 0x2140, 0x2150]) {
      yield 10;                                              // LD HL,nn
      yield 11;                                              // RST 20h
      yield* this.rst20_clear8_0020(hl);
    }
    yield 10;                                                // RET
  } // clear_groupA_0E13

  /** clear_groupB 0E2C */
  *clear_groupB_0E2C() {
    for (var hl of [0x2108, 0x2118, 0x2128, 0x2138, 0x2148, 0x2158]) {
      yield 10;
      yield 11;
      yield* this.rst20_clear8_0020(hl);
    }
    yield 10;
  } // clear_groupB_0E2C

  // --------------------------------------------------------------- 01F7
  /**
   * sequencer 01F7: the six channels in the order AY1 A,B,C then AY2 A,B,C -
   * a sounding note gets note_tick, a finished one fetch_note. Then the two
   * phantom channels 2106/210E, leftovers that never trigger (notes/E.md (d)).
   */
  *sequencer_01F7() {
    for (var base of CHANNELS) {
      this.ix = base; yield 14;                              // LD IX,nn
      var active = this.ixRd(16); yield 19;
      yield 7;                                               // CP 00h
      if (active == 0) {
        yield 12;                                            // JR Z, next channel
        continue;
      }
      yield 7;
      var on = this.ixRd(17); yield 19;
      yield 7;                                               // CP 00h
      if (on == 0) {
        yield 12;                                            // JR Z,fetch
        yield 17;                                            // CALL fetch_note
        yield* this.fetch_note_02B2();
      } else {
        yield 7;
        yield 17;                                            // CALL note_tick
        yield* this.note_tick_031C();
        yield 12;                                            // JR next channel
      }
    }
    // seq_phantom 0293
    this.ix = 0x2106; yield 14;
    var ph1 = this.ixRd(16); yield 19;
    yield 7;
    if (ph1 != 0) {
      yield 7;
      yield 17;                                              // CALL reset - dead code
      this.report('phantom channel 2116h set, the original would CALL 0000');
      return 'reset';
    }
    yield 12;
    this.ix = 0x210E; yield 14;
    var ph2 = this.ixRd(16); yield 19;
    yield 7;
    if (ph2 != 0) {
      yield 7;
      yield 4; yield 4; yield 4;                             // NOP NOP NOP
    } else {
      yield 12;
    }
    yield 10;                                                // JP main_loop
    return 'loop';
  } // sequencer_01F7

  // --------------------------------------------------------------- 02B2
  /**
   * fetch_note 02B2: [length code][period]. The period is two bytes when the
   * upper nibble of the first is 0 (hi then lo), otherwise one byte and the hi
   * byte stays what the previous note left; a rest is period 0. After the note
   * comes the mark: FFh loops to chLoop, FEh/FDh/FCh release the busy flags.
   */
  *fetch_note_02B2() {
    this.ixWr(32, 0x00); yield 19;                           // tick = 0
    this.ixWr(17, 0x01); yield 19;                           // note sounds
    var h = this.ixRd(49); yield 19;
    var l = this.ixRd(48); yield 19;
    var a = this.rd((h << 8) | l); yield 7;                  // LD A,(HL)
    this.ixWr(33, a); yield 19;                              // length code
    l = (l+1) & 0xFF; yield 4;
    if (l != 0) { yield 12; } else { yield 7; h = (h+1) & 0xFF; yield 4; }
    var c = this.rd((h << 8) | l); yield 7;
    yield 4;                                                 // LD C,A
    yield 7;                                                 // AND F0h
    yield 7;                                                 // CP 00h
    if ((c & 0xF0) != 0) {
      yield 12;                                              // JR NZ,L_02D8
    } else {
      yield 7;
      this.ixWr(1, c); yield 19;                             // period hi
      l = (l+1) & 0xFF; yield 4;
      if (l != 0) { yield 12; } else { yield 7; h = (h+1) & 0xFF; yield 4; }
      c = this.rd((h << 8) | l); yield 7;                    // LD C,(HL)
    }
    this.ixWr(0, c); yield 19;                               // period lo
    this.ixWr(64, 0x0F); yield 19;                           // volume
    l = (l+1) & 0xFF; yield 4;
    if (l != 0) { yield 12; } else { yield 7; h = (h+1) & 0xFF; yield 4; }
    this.ixWr(49, h); yield 19;
    this.ixWr(48, l); yield 19;
    var mark = this.rd((h << 8) | l); yield 7;
    yield 7;                                                 // CP FFh
    yield 10;                                                // JP NZ,mark_FE
    if (mark == 0xFF) {
      var lo = this.ixRd(80); yield 19;
      this.ixWr(48, lo); yield 19;
      var hi = this.ixRd(81); yield 19;
      this.ixWr(49, hi); yield 19;
      yield 10;                                              // RET
      return;
    }
    yield 7;                                                 // CP FEh
    if (mark == 0xFE) {
      yield 7;
      yield 4;                                               // XOR A
      this.wr(0x2005, 0); yield 13;                          // busyA = 0
      yield 10;
      return;
    }
    yield 12;                                                // JR NZ,mark_FD
    yield 7;                                                 // CP FDh
    if (mark == 0xFD) {
      yield 7;
      yield 4;
      this.wr(0x2006, 0); yield 13;                          // busyB = 0
      yield 10;
      return;
    }
    yield 12;                                                // JR NZ,mark_FC
    yield 7;                                                 // CP FCh
    if (mark != 0xFC) {
      yield 11;                                              // RET NZ
      return;
    }
    yield 5;
    yield 4;                                                 // XOR A
    this.wr(0x2005, 0); yield 13;
    this.wr(0x2006, 0); yield 13;
    this.wr(0x2007, 0); yield 13;
    yield 10;                                                // RET
  } // fetch_note_02B2

  // --------------------------------------------------------------- 031C
  /**
   * note_tick 031C: JP (0380h + length code) - through L only, so a code above
   * 7Fh does not land in the jump table at all but 100h lower, in the dead copy
   * 0325-037F (notes/E.md (e) says 042Fh for code AFh; ADD A,L drops the carry,
   * so the original goes to 032Fh instead). Codes that are not a multiple of
   * three run into the middle of a JP: 3Ah, which the data of commands 0C, 10
   * and 16 use, lands on 03BAh = JP PE,C304h, which is not taken (the parity of
   * BAh is odd), and then on DI / INC B / JP dur_sus6 - so it holds for 6 ticks,
   * not the 9 of dur_sus9 that notes/E.md (e) and sound.asm claim.
   *
   * The other entry the original really reaches is 032Fh, from length code AFh:
   * the first byte the AY2 channels of command 0C read when their pointers stay
   * at 0000h. It runs INC B / JP 044Fh / LD A,(HL) / LD B,C / CP 12h into
   * decay_hold - a decay with no tick gate at all, so it takes one step per pass
   * of the main loop. Any other code is reported instead of guessed.
   */
  *note_tick_031C() {
    yield 10;                                                // LD HL,dur_table
    var dur = this.ixRd(33); yield 19;
    yield 4;                                                 // ADD A,L
    yield 4;                                                 // LD L,A
    yield 4;                                                 // JP (HL)
    var target = 0x0300 | ((0x80 + dur) & 0xFF);
    if (target == 0x03CB) {                                  // code 4Bh: dur_dec24 body
      return yield* this.dur_dec24_03CB(false);
    }
    if (target == 0x03BA) {                                  // code 3Ah, see above
      yield 10;                                              // JP PE,C304h not taken
      yield 4;                                               // DI
      yield 4;                                               // INC B
      yield 10;                                              // JP dur_sus6
      return yield* this.dur_sus(0x06, true);   // 04FC dur_sus6, JP note_end_sus
    }
    if (target == 0x032F) {                                  // code AFh, from the 0C data bug
      yield 4;                                               // 032F INC B
      yield 10;                                              // 0330 JP 044F
      var a = this.rd(target); yield 7;                      // 044F LD A,(HL), HL = 032Fh
      yield 4;                                               // 0450 LD B,C
      yield 7;                                               // 0451 CP 12h
      if (a == 0x12) { yield 7; this.ixWr(65, 0xFF); yield 19; } else { yield 12; }
      yield 10;                                              // 0459 JP decay_hold
      return yield* this.decay_hold_03E9();                  // no tick gate at all
    }
    if (target >= 0x0380 && target <= 0x03C8 && ((target-0x0380) % 3) == 0) {
      yield 10;                                              // JP handler
      return yield* this.dur_entry((target-0x0380)/3);
    }
    this.report('length code '+hex2(dur)+' jumps to '+hex4(target)+', outside the jump table 0380h');
  } // note_tick_031C

  /** the 25 entries of dur_table 0380 */
  *dur_entry(k) {
    switch (k) {
      case 0: return yield* this.dur_dec24_03CB(false);
      case 1: return yield* this.dur_decay(0x12, true);      // dur_dec18
      case 2: return yield* this.dur_decay(0x0C, true);      // dur_dec12
      case 3: return yield* this.dur_decay(0x09, true);      // dur_dec9
      case 4: return yield* this.dur_decay(0x06, true);      // dur_dec6
      case 5: return yield* this.dur_decay_hold(0x04, 0x12); // dur_dec4_72
      case 6: return yield* this.dur_decay(0x03, true);      // dur_dec3
      case 7: return yield* this.dur_decay_hold(0x02, 0x12); // dur_dec2_36
      case 8: return yield* this.dur_decay_hold(0x01, 0x18); // dur_dec1_24
      case 9: return yield* this.dur_sus16(0x18, false);     // dur_sus24x16
      case 10: return yield* this.dur_sus16(0x12, true);     // dur_sus18x16
      default: return yield* this.dur_sus(SUS_TICKS[k-11], k > 11);
    }
  } // dur_entry

  /** dur_dec24 03CB - and the shared body of dur_dec18/12/9/6/3 */
  *dur_dec24_03CB(viaJump) { return yield* this.dur_decay(0x18, viaJump); }

  /** the decaying length codes 00/03/06/09/0C/12: volume -1 every N ticks */
  *dur_decay(threshold, viaJump) {
    var tick = this.ixRd(32); yield 19;
    yield 7;                                                 // CP n
    if (tick != threshold) {
      yield 11;                                              // RET NZ
      return;
    }
    yield 5;
    if (viaJump) {
      yield 10;                                              // JP decay_step
    }
    yield* this.decay_step_03D1();
  } // dur_decay

  /** decay_step 03D1 */
  *decay_step_03D1() {
    this.ixWr(32, 0x00); yield 19;
    var vol = this.ixRd(64); yield 19;
    yield 7;                                                 // CP 00h
    if (vol == 0) {
      yield 12;                                              // JR Z,note_end
      return yield* this.note_end_03E0();
    }
    yield 7;
    this.ixWr(64, (vol-1) & 0xFF); yield 23;                 // DEC (IX+64)
    yield 10;                                                // RET
  } // decay_step_03D1

  /** note_end 03E0 */
  *note_end_03E0() {
    this.ixWr(17, 0x00); yield 19;
    this.ixWr(65, 0x00); yield 19;
    yield 10;                                                // RET
  } // note_end_03E0

  /**
   * dur_dec4_72 0425, dur_dec2_36 0445, dur_dec1_24 045C: volume -1 every N
   * ticks, and the note is held until the step counter has reached its limit.
   */
  *dur_decay_hold(threshold, limit) {
    var tick = this.ixRd(32); yield 19;
    yield 7;                                                 // CP n
    if (tick != threshold) {
      yield 11;                                              // RET NZ
      return;
    }
    yield 5;
    var env = (this.ixRd(65)+1) & 0xFF;
    this.ixWr(65, env); yield 23;                            // INC (IX+65)
    yield 19;                                                // LD A,(IX+65)
    yield 7;                                                 // CP limit
    if (env == limit) {
      yield 7;
      this.ixWr(65, 0xFF); yield 19;
    } else {
      yield 12;                                              // JR NZ
    }
    yield 10;                                                // JP decay_hold
    yield* this.decay_hold_03E9();
  } // dur_decay_hold

  /** decay_hold 03E9 */
  *decay_hold_03E9() {
    this.ixWr(32, 0x00); yield 19;
    var vol = this.ixRd(64); yield 19;
    yield 7;                                                 // CP 00h
    if (vol != 0) {
      yield 7;
      this.ixWr(64, (vol-1) & 0xFF); yield 23;
      yield 10;                                              // RET
      return;
    }
    yield 12;                                                // JR Z,L_03F8
    var env = this.ixRd(65); yield 19;
    yield 7;                                                 // CP FFh
    if (env != 0xFF) {
      yield 11;                                              // RET NZ
      return;
    }
    yield 5;
    yield 10;                                                // JP note_end
    yield* this.note_end_03E0();
  } // decay_hold_03E9

  /** dur_sus24x16 0473 / dur_sus18x16 0493: full volume for 16 steps */
  *dur_sus16(threshold, viaJump) {
    var tick = this.ixRd(32); yield 19;
    yield 7;
    if (tick != threshold) {
      yield 11;                                              // RET NZ
      return;
    }
    yield 5;
    if (viaJump) {
      yield 10;                                              // JP sus_step
    }
    yield* this.sus_step_0479();
  } // dur_sus16

  /** sus_step 0479 */
  *sus_step_0479() {
    this.ixWr(32, 0x00); yield 19;
    var env = (this.ixRd(65)+1) & 0xFF;
    this.ixWr(65, env); yield 23;                            // INC (IX+65)
    yield 19;                                                // LD A,(IX+65)
    yield 7;                                                 // CP 10h
    if (env != 0x10) {
      yield 11;                                              // RET NZ
      return;
    }
    yield 5;
    this.ixWr(64, 0x00); yield 19;
    this.ixWr(17, 0x00); yield 19;
    this.ixWr(65, 0x00); yield 19;
    yield 10;                                                // RET
  } // sus_step_0479

  /** dur_sus192 049C .. dur_sus1 0517: hold, the volume stays for the next note */
  *dur_sus(threshold, viaJump) {
    var tick = this.ixRd(32); yield 19;
    yield 7;                                                 // CP n
    if (tick != threshold) {
      yield 11;                                              // RET NZ
      return;
    }
    yield 5;
    if (viaJump) {
      yield 10;                                              // JP note_end_sus
    }
    this.ixWr(32, 0x00); yield 19;                           // note_end_sus 04A2
    this.ixWr(17, 0x00); yield 19;
    yield 10;                                                // RET
  } // dur_sus

} // SoundDriver

function hex2(n) { return (n & 0xFF).toString(16).toUpperCase().padStart(2, '0')+'h'; }
function hex4(n) { return (n & 0xFFFF).toString(16).toUpperCase().padStart(4, '0')+'h'; }
