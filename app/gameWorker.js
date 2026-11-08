// begin code

/**
 * Stinger game worker (ST-M4) — a 1:1 JavaScript transcription of the original
 * Seibu Denshi 1983 program (Z80, sources/asm/stinger/main.asm, notes/A-D.md).
 *
 * Memory model: the worker keeps the board's RAM (C000h-C7FFh), both video RAM
 * pages, both attribute pages and both sprite RAM pages, and every game variable
 * LIVES at its original address (C0A2h gameState, C140h the ship sprite, C224h
 * the enemy slots, ...). That is what makes the reference emulator usable as an
 * oracle: tools/regress.mjs compares the two byte by byte every frame. The ROM
 * data tables are rebuilt from data/tables.json (tools/rom2tables.mjs) into a
 * sparse 40 KiB image and read at their original addresses; no program code is
 * shipped to the browser (decision 2026-08-30).
 *
 * Control flow: the original is not a state machine that returns every frame —
 * main_loop (0CA3h) waits for the NMI to change frameCounter (C0A0h), and the
 * game and the demo are blocking loops that do the same (L_12CA, L_1358,
 * L_2E44, L_3403). The program is therefore written as a generator:
 *
 *   - `waitFrame()` is the original's "wait until C0A0h changes"; it yields.
 *   - `delay(n)` is n calls of delayLoop (S_160B), which is NOT synchronised
 *     with the NMI: it burns 54768 T-states = 1.0697 frames each (0x30 x 0x50
 *     iterations of DEC E / JP NZ at 14 T, plus the loop overhead). Frame-exact
 *     agreement with the reference emulator depends on modelling that, so the
 *     worker tracks a T-state budget: FRAME_TSTATES (51200 = 3.072 MHz / 60) per
 *     frame, and any wait that overruns it yields the frames it consumed.
 *   - Everything else is assumed to fit inside one frame, which it does — the
 *     original always ends up waiting for the frame counter again.
 *
 * tick() therefore means: fire the NMI if it is enabled (F001h bit 0), then let
 * the foreground run until it blocks. Frame numbering matches refemu: frame 0 is
 * the reset. Wall-clock frames advance whether or not the NMI is enabled, so the
 * long power-on screen (NMI off, ~128 delayLoops) lines up too.
 */

var TICK_MS = 1000/60;
var FRAME_TSTATES = 51200;           // 3.072 MHz / 60 Hz, one frame of the main CPU
var DELAY_LOOP_TSTATES = 54861;      // S_160B (160Bh): 0x30 x (7 + 0x50*14 + 14) of loop,
                                     // plus PUSH DE 11 + LD D 7 + POP DE 10 + RST 38h 55 + RET 10

// ---------------------------------------------------------------- memory
var rom = new Uint8Array(0xA000);        // sparse: only the tables of data/tables.json
var romKnown = new Uint8Array(0xA000);   // 1 = byte delivered by tables.json
var ram = new Uint8Array(0x800);         // C000h-C7FFh
var vram = [new Uint8Array(0x400), new Uint8Array(0x400)];   // [0] = E000h layer 0, [1] = D000h layer 1
var attr = [new Uint8Array(0x40), new Uint8Array(0x40)];     // [0] = E800h, [1] = D800h
var spr = [new Uint8Array(0x20), new Uint8Array(0x20)];      // [0] = E840h, [1] = D840h

var nmiEnable = 0;                   // F001h bit 0
var palbank = [0, 0];                // F002h / F003h
var charbank = [0, 0];               // F004h / F005h
var flip = [0, 0];                   // F006h / F007h
var bgcolor = 0;                     // F818h

var in0 = 0;                         // F010h: coin/start/fire/bongo (active high)
var in1 = 0;                         // F018h: joystick
var dsw0 = 0xEF;                     // F000h, factory default (GAME-DESIGN chap. 2.4)
var dsw1 = 0xAE;                     // F008h

var strictRom = false;               // throw when the program reads a table not in tables.json

/** rebuilds the sparse ROM image from data/tables.json */
function loadTables(tables) {
  rom.fill(0);
  romKnown.fill(0);
  var list = tables && tables.tables ? tables.tables : tables;
  if (!Array.isArray(list)) {
    throw new Error('gameWorker: initData.tables missing (data/tables.json)');
  }
  list.forEach(function(entry) {
    var addr = typeof entry.addr == 'string' ? parseInt(entry.addr, 16) : entry.addr;
    var bytes = decodeTableData(entry.data);
    for (var i = 0; i < bytes.length; i++) {
      rom[addr+i] = bytes[i];
      romKnown[addr+i] = 1;
    }
  });
} // loadTables

/** table bytes are base64 (rom2tables.mjs); a plain array is accepted too */
function decodeTableData(data) {
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

// ---------------------------------------------------------------- bus
/**
 * Reads one byte of the original address space. Reading a ROM address that
 * data/tables.json does not carry means the transcription strayed into code,
 * so it is reported (and, with strictRom, fatal) instead of silently returning 0.
 */
function rd(a) {
  a &= 0xFFFF;
  if (a < 0xA000) {
    if (!romKnown[a]) {
      reportUnknownRom(a);
    }
    return rom[a];
  }
  if (a < 0xC000) return 0xFF;
  if (a < 0xC800) return ram[a-0xC000];
  if (a >= 0xD000 && a < 0xD400) return vram[1][a-0xD000];
  if (a >= 0xD800 && a < 0xD840) return attr[1][a-0xD800];
  if (a >= 0xD840 && a < 0xD860) return spr[1][a-0xD840];
  if (a >= 0xE000 && a < 0xE400) return vram[0][a-0xE000];
  if (a >= 0xE800 && a < 0xE840) return attr[0][a-0xE800];
  if (a >= 0xE840 && a < 0xE860) return spr[0][a-0xE840];
  if (a == 0xF000) return dsw0;
  if (a == 0xF008) return dsw1;
  if (a == 0xF010) return in0;
  if (a == 0xF018) return in1;
  return 0xFF;                       // F800h watchdog and everything unmapped
} // rd

function wr(a, v) {
  a &= 0xFFFF;
  v &= 0xFF;
  if (a < 0xC000) return;            // ROM
  if (a < 0xC800) { ram[a-0xC000] = v; return; }
  if (a >= 0xD000 && a < 0xD400) { vram[1][a-0xD000] = v; return; }
  if (a >= 0xD800 && a < 0xD840) { attr[1][a-0xD800] = v; return; }
  if (a >= 0xD840 && a < 0xD860) { spr[1][a-0xD840] = v; return; }
  if (a >= 0xE000 && a < 0xE400) { vram[0][a-0xE000] = v; return; }
  if (a >= 0xE800 && a < 0xE840) { attr[0][a-0xE800] = v; return; }
  if (a >= 0xE840 && a < 0xE860) { spr[0][a-0xE840] = v; return; }
  if (a == 0xF001) { nmiEnable = v & 1; return; }
  if (a == 0xF002 || a == 0xF003) { palbank[a-0xF002] = v & 1; return; }
  if (a == 0xF004 || a == 0xF005) { charbank[a-0xF004] = v & 1; return; }
  if (a == 0xF006 || a == 0xF007) { flip[a-0xF006] = v & 1; return; }
  if (a == 0xF800) { soundLatch(v); return; }
  if (a == 0xF808) { frameBooms++; return; }
  if (a == 0xF80A) { frameShots++; return; }
  if (a == 0xF818) { bgcolor = v; return; }
} // wr

function rd16(a) { return rd(a) | (rd(a+1) << 8); }
function wr16(a, v) { wr(a, v & 0xFF); wr(a+1, (v >> 8) & 0xFF); }

// Measured instruction costs of the block routines. They matter: the reset
// sequence spends several frames inside them with the NMI off, so the frame the
// title appears on depends on getting these right (tools/regress.mjs checks it).
var LDIR_TSTATES = 21;               // LDIR, per byte
var FILL_PAGES_TSTATES = 21;         // fillPages 15C4h: LD (HL),A + INC L + JP NZ
var FILL_BYTES_TSTATES = 24;         // fillBytes 15CEh: LD (HL),A + INC L + DJNZ
var MEMCPY_WD_TSTATES = 162;         // RST 08h 0334h: two watchdog kicks per byte

/** LDIR: copies bc bytes from hl to de */
function ldir(hl, de, bc) {
  for (var i = 0; i < bc; i++) {
    wr(de+i, rd(hl+i));
  }
  charge(bc*LDIR_TSTATES);
} // ldir

/** RST 08h -> memcpyWd (0334h): the same copy, but kicking the watchdog per byte */
function memcpyWd(hl, de, bc) {
  for (var i = 0; i < bc; i++) {
    wr(de+i, rd(hl+i));
  }
  charge(bc*MEMCPY_WD_TSTATES);
} // memcpyWd

/** fillPages (15C4h): b pages of 256 bytes from hl with a */
function fillPages(hl, b, a) {
  for (var i = 0; i < b*256; i++) {
    wr(hl+i, a);
  }
  // per page also INC H 4 + DJNZ 13 (15C9/15CA), the last DJNZ 5 T shorter
  charge(b*(256*FILL_PAGES_TSTATES+4+13)-5);
} // fillPages

// The generator forms below charge as they write, one page at a time, instead of
// charging once at the end. During the reset the NMI is off and the program
// spends whole frames inside these loops, so the frame on which a given byte
// changes is observable — and tools/regress.mjs compares every frame from 0.
function* fillPagesG(hl, b, a) {
  for (var page = 0; page < b; page++) {
    for (var i = 0; i < 256; i++) {
      wr(hl+page*256+i, a);
    }
    // INC H 4 + DJNZ 13 close every page (15C9/15CA); the last DJNZ is 8 T
    charge(256*FILL_PAGES_TSTATES+4+(page === b-1 ? 8 : 13));
    yield 'work';
  }
} // fillPagesG

function* memcpyWdG(hl, de, bc) {
  for (var i = 0; i < bc; i++) {
    wr(de+i, rd(hl+i));
    if ((i & 0x3F) === 0x3F) {
      charge(64*MEMCPY_WD_TSTATES);
      yield 'work';
    }
  }
  charge((bc & 0x3F)*MEMCPY_WD_TSTATES);
} // memcpyWdG

/** fillBytes (15CEh): b bytes from hl with a (b = 0 means 256) */
function fillBytes(hl, b, a) {
  var count = b === 0 ? 256 : b;
  for (var i = 0; i < count; i++) {
    wr(hl+i, a);
  }
  // the last DJNZ (15D0) is 8 T, not 13, and the routine ends with RET 10 (15D2);
  // callers charge the CALL 17 themselves (cf. payFillBytes)
  charge(count*FILL_BYTES_TSTATES-5+10);
} // fillBytes

// ---------------------------------------------------------------- RNG (1694h)
/**
 * The original's pseudo-random generator, 16-bit state at C0A4h/C0A5h seeded
 * with 5A36h. Spawn positions, directions and enemy choices all come from it and
 * its sequence has a period of only 611, so it must be bit-exact (notes/D.md (g)).
 *
 * Note the return value: 16A4/16A5 are `LD A,H` / `OR L`, which overwrite the
 * sum computed at 16A1. The routine therefore returns the OR of the two bytes of
 * the NEW state, not that sum — notes/D.md describes the sum as the result,
 * which is wrong (the zero test doubles as the return value).
 */
function rng() {
  var l0 = ram[0x0A4], h0 = ram[0x0A5];
  var hl = (h0 << 8) | l0;
  var b = l0, c = h0;                          // LD B,L / LD C,H
  hl = (hl+hl) & 0xFFFF;                       // ADD HL,HL
  hl = (hl+((b << 8) | c)) & 0xFFFF;           // ADD HL,BC
  hl = (b << 8) | (hl & 0xFF);                 // LD H,B
  c = hl & 0xFF;                               // LD C,L
  hl = (hl+((b << 8) | c)) & 0xFFFF;           // ADD HL,BC
  var a = (c+((hl >> 8) & 0xFF)) & 0xFF;       // LD A,C / ADD A,H
  hl = ((a << 8) | (hl & 0xFF)) & 0xFFFF;      // LD H,A
  hl = (hl+hl) & 0xFFFF;                       // ADD HL,HL
  a = ((hl >> 8) | (hl & 0xFF)) & 0xFF;        // LD A,H / OR L  -> this is what is returned
  if (hl === 0) {
    hl = 0x5A36;
  }
  ram[0x0A4] = hl & 0xFF;
  ram[0x0A5] = (hl >> 8) & 0xFF;
  return a;
} // rng

// ---------------------------------------------------------------- sound board
// The original writes commands to F800h, and pulses F808h / F80Ah for the two
// discrete circuits. The worker only collects them per frame; ST-M6 turns them
// into sound (app/WORKER-PROTOCOL.md, `soundBoard`).
var frameLatches = [];
var frameShots = 0;
var frameBooms = 0;
var frameShotSlots = [];
var frameBoomSlots = [];

/**
 * A write to F800h. The sound board reads its latch once per NMI at 240 Hz
 * (notes/E.md (b)), so WHERE in the frame the write happened decides which of
 * the frame's four sound-CPU NMIs sees it. The worker knows that: it is
 * tracking how much of the frame's T-state budget has been spent. The slot is
 * recorded with the value so app/stingerSoundProcessor.js can reproduce the
 * pairing instead of guessing it.
 */
function soundLatch(v) {
  frameLatches.push({slot: currentSoundSlot(), value: v});
} // soundLatch

/** which of the frame's four sound NMIs the current instant falls into */
function currentSoundSlot() {
  var slot = Math.floor(state.frameSpent/(FRAME_TSTATES/4));
  return slot < 0 ? 0 : (slot > 3 ? 3 : slot);
} // currentSoundSlot

// ---------------------------------------------------------------- timing
// The foreground code is a generator; `state.pending` is the T-state debt it has
// run up inside delay loops. tick() gives it one frame worth of T-states.
var state = null;
var program = null;

function newState(initData) {
  return {
    frame: 0,                  // wall-clock frame, matches tools/refemu
    pending: 0,                // T-states the foreground still owes this frame
    frameSpent: 0,             // T-states of this frame already used (sound NMI slots)
    nmiCost: 0,                // T-states this frame's NMI took away from it
    lastNmi: 0,                // ... kept for the timing probes of tools/
    running: true,
    stopped: false,
    paused: false,
    headless: !!(initData && initData.headless),
    attract: !!(initData && initData.attract),
    inputScript: (initData && initData.inputScript) || null,
    controls: {left: false, right: false, up: false, down: false, fire: false, bongo: false},
    unknownRom: 0
  };
} // newState

/** adds T-states the foreground still has to pay off before it runs on */
function charge(tstates) {
  state.pending += tstates;
} // charge

/**
 * Hands control back to tick() so it can charge the accumulated T-states against
 * this frame's budget. `yield 'work'` means "the program is still running", as
 * opposed to `yield 'frame'`, which is the original blocking on the NMI.
 */
function* settle() {
  yield 'work';
} // settle

/**
 * Runs one of the interruptible routines below to completion in a single go.
 *
 * The long foreground routines (drawScore 1536h, addScore 16B7h, drawBottomHud
 * 089Ch, the collision scans) are written as generators so tick() can break them
 * on a frame boundary the way the NMI breaks the original. Some of them are
 * also reached from the NMI handler itself (0066h -> 053Fh -> supplyDockCheck
 * 0798h -> fuelGaugeFill 07F0h), and there the original cannot be interrupted
 * either: the Z80 accepts no further NMI until the RETN at 00F8h, and the model
 * charges the whole NMI to the frame up front. Those call sites therefore drain
 * the generator instead of delegating to it, which spends exactly the same
 * T-states and performs exactly the same writes, just without the break points.
 */
function drain(gen) {
  var step = gen.next();
  while (!step.done) {
    step = gen.next();
  }
  return step.value;
} // drain

/**
 * delayLoop (S_160B, 160Bh) n times: 0x30 x 0x50 iterations of DEC E / JP NZ.
 * A pure instruction delay, not synchronised with the NMI, so it is charged in
 * T-states like every other long operation.
 */
function* delay(n, extra) {
  // ... called from a DJNZ loop, so every call also pays CALL 17 + DJNZ 13 (and
  // the stray NOP of the 0D78h loop, which is what `extra` is for). The last
  // DJNZ is not taken and is 5 T shorter.
  charge(n*(17+DELAY_LOOP_TSTATES+13+(extra || 0))-5);
  yield 'work';
} // delay

function reportUnknownRom(a) {
  state.unknownRom++;
  if (state.unknownRom < 20) {
    console.error('gameWorker: read of ROM '+a.toString(16).toUpperCase()+
      'h, which data/tables.json does not carry (transcription strayed into code?)');
  }
  if (strictRom) {
    throw new Error('gameWorker: unknown ROM read at '+a.toString(16).toUpperCase()+'h');
  }
} // reportUnknownRom

// ---------------------------------------------------------------- inputs
// IN0 (F010h): bit0 coin A, bit1 P2 bongo, bit2 bongo, bit3 start 2P, bit4 start
// 1P, bit5 coin B, bit6 fire, bit7 P2 fire. IN1 (F018h): bit0 right, bit1 left,
// bit4 up, bit5 down. Active high (notes/A.md (e)).
function applyControls() {
  var c = state.controls;
  in1 = (c.right ? 0x01 : 0) | (c.left ? 0x02 : 0) | (c.up ? 0x10 : 0) | (c.down ? 0x20 : 0);
  in0 = (in0 & 0x39) | (c.fire ? 0x40 : 0) | (c.bongo ? 0x04 : 0);
} // applyControls

/** headless runs (tools/regress.mjs) drive IN0/IN1 from a script of {frame, in0, in1} */
function applyInputScript() {
  if (!state.inputScript) {
    return;
  }
  for (var i = 0; i < state.inputScript.length; i++) {
    var e = state.inputScript[i];
    if (e.frame === state.frame) {
      in0 = e.in0 & 0xFF;
      in1 = (e.in1 || 0) & 0xFF;
    }
  }
} // applyInputScript

// ---------------------------------------------------------------- RST vectors
/** RST 38h (0038h): kicks the watchdog by reading F800h — no effect here */
function watchdogKick() {
} // watchdogKick

/** RST 18h (0018h): CHARBANK1 = 1 */
function rst18Charbank1() {
  wr(0xF005, 1);
} // rst18Charbank1

/** RST 10h -> clearScreens (0342h): both VRAM = 10h, shadows and attributes 0, BGCOLOR 0 */
function clearScreens() {
  charge(11+10+55+7+13+7+10+7+17);   // RST 10h (11) + JP 0342h (10), then 0342-034F
  wr(0xF001, 0);
  fillPages(0xD000, 4, 0x10);
  charge(65+55+10+7+17);             // fillPages tail (RST 38h + RET), 0352-0358
  fillPages(0xE000, 4, 0x10);
  charge(65+55+4+10+7+17);           // ... and 035B-0362
  fillBytes(0xC100, 0xC0, 0);        // attr1Shadow, spr1, attr0Shadow, spr0
  charge(10+7+17);                   // 0365-036A
  fillBytes(0xD800, 0x60, 0);        // ATTR1 + SPR1
  charge(10+7+17);                   // 036D-0372
  fillBytes(0xE800, 0x60, 0);        // ATTR0 + SPR0
  charge(13+55+10);                  // 0375-0379 LD (BGCOLOR),A / RST 38h / RET
  wr(0xF818, 0);
} // clearScreens

/** the same, charging as it goes (see fillPagesG) */
function* clearScreensG() {
  // every caller reaches clearScreens through RST 10h (0297, 0CFD, 0D5F, 0D7E,
  // 123D, 1252, 13F7, 1863, 19AB, 19D2, 1C6C, 1D04), which is RST 11 + the
  // JP clearScreens at 0010h 10 -- 21 T that used to be charged nowhere.
  charge(11+10+55+7+13+7+10+7+17);   // RST 10h, then 0342-034F
  wr(0xF001, 0);
  yield* fillPagesG(0xD000, 4, 0x10);
  charge(65+55+10+7+17);             // fillPages tail (RST 38h + RET), 0352-0358
  yield* fillPagesG(0xE000, 4, 0x10);
  charge(65+55+4+10+7+17);           // ... and 035B-0362
  fillBytes(0xC100, 0xC0, 0);
  charge(10+7+17);                   // 0365-036A LD HL / LD B / CALL fillBytes
  fillBytes(0xD800, 0x60, 0);
  charge(10+7+17);                   // 036D-0372
  fillBytes(0xE800, 0x60, 0);
  charge(13+55+10);                  // 0375-0379 LD (BGCOLOR),A / RST 38h / RET
  wr(0xF818, 0);
  yield 'work';
} // clearScreensG

// ---------------------------------------------------------------- reset (0C85h)
/** initRam (0CEAh) */
function* initRam() {
  yield* fillPagesG(0xC000, 7, 0);               // C000h-C6FFh (the stack page C700h is left alone)
  wr(0xC0A4, 0x5A);                              // 0CF3: note the bytes are stored low = 5Ah, high = 36h,
  wr(0xC0A5, 0x36);                              // i.e. the seed is 365Ah, while the reseed at 16AFh uses 5A36h
  yield* clearScreensG();
  ldir(0x54C0, 0xC031, 0x2A);                    // default high-score table
  ldir(0x5460, 0xC200, 0x14);                    // default names MIE KIN JIM H.K KAS
  ldir(0xC031, 0xC079, 0x06);                    // HUD high score = entry 0
  fillBytes(0xC280, 0x20, 0x10);                 // both Bongo gauges empty
  wr(0xF800, 0x90);                              // stop the sound program
  wr(0xC515, 0);
  fillBytes(0xF002, 0x06, 0);                    // F002h-F007h: palette banks, char banks, flip
  wr(0xC0B9, 1);                                 // lifeOver: the game part of the NMI stays off
  yield 'work';
} // initRam

/** decodeDsw0 (0D89h) — coinage A, lives, bonus thresholds (notes/A.md, DIP table) */
function decodeDsw0() {
  var d = rd(0xF000);
  var coinage = [[3, 2], [4, 1], [3, 1], [2, 3], [2, 1], [1, 3], [1, 2], [1, 1]][d & 7];
  wr(0xC0A7, coinage[0]);                        // coins per credit
  wr(0xC0A6, coinage[1]);                        // credits per coin
  wr(0xC0A8, 2+((d >> 3) & 3));                  // lives 2-5
  // bonus thresholds are stored as six-digit scores (digit 3 = ten thousands),
  // because the displayed score is the stored one times ten
  var bonus = {0xE0: [2, 5], 0xC0: [2, 6], 0xA0: [2, 7], 0x80: [2, 8], 0x60: [2, 9], 0x40: [3, 8], 0x20: [3, 9]}[d & 0xE0];
  fillBytes(0xC07F, 0x0C, 0);
  if (bonus) {
    wr(0xC082, bonus[0]);
    wr(0xC088, bonus[1]);
    wr(0xC0A9, 1);
  } else {
    wr(0xC0A9, 0);                               // 00h = no bonus life
  }
} // decodeDsw0

/** decodeDsw1 (0E58h) — cabinet, difficulty, Bongo time, coinage B, test play */
function decodeDsw1() {
  var d = rd(0xF008);
  wr(0xC0BD, (d & 0x80) ? 0 : 1);                // cocktail
  wr(0xC005, (d & 0x40) ? 5 : 0);                // 5 = Normal, 0 = Hard
  wr(0xC00A, {0x30: 0x20, 0x20: 0x18, 0x10: 0x10, 0x00: 0x08}[d & 0x30]);
  var coinageB = [[5, 1], [2, 3], [3, 2], [1, 2], [4, 1], [2, 1], [3, 1], [1, 1]][(d >> 1) & 7];
  wr(0xC540, coinageB[0]);
  wr(0xC541, coinageB[1]);
  wr(0xC500, (d & 1) ? 0 : rd(0xC500));          // DSW1 bit 0 = 1 clears the (dead) TEST PLAY flag
} // decodeDsw1

/**
 * powerOnScreen (0D4Ah) — the service screen the board shows before the title:
 * VRAM1 is filled with 8 passes of RNG output ("snow"), cleared, the raw DIP
 * values are printed, then the whole layer is set to the solid tile 3Fh and
 * cleared again. The NMI is off the whole time, so nothing advances except the
 * wall clock; what matters for the rest of the game is that the 7680 RNG calls
 * leave the generator in the right state.
 *
 * The two delays are 30h and 50h calls of delayLoop; the RNG fill is charged at
 * its measured instruction cost (RST 38h 55 T + CALL rng 191 T + the loop body).
 */
// One byte of the 0D50h loop, counted instruction by instruction: RST 38h 55 T
// + CALL rng 17 + rng body 174 + LD (HL),A 7 + INC HL 6 + LD A,H 4 + CP 7 + NOP 4
// + JP NZ 10. At 51200 T a frame that is 180 calls per frame, which is what the
// reference emulator does.
var RNG_FILL_TSTATES = 284;
var RESET_OVERHEAD_TSTATES = 900;    // see mainProgram

function* powerOnScreen() {
  rst18Charbank1();
  charge(7);                         // LD B,08h
  for (var pass = 0; pass < 8; pass++) {
    charge(10);                      // LD HL,VRAM1+40h at the head of each pass
    for (var hl = 0xD040; hl < 0xD400; hl++) {
      // pay first, then act: an instruction's effect is only visible once its
      // T-states have elapsed, which is what decides the frame a given RNG
      // state is reached on
      charge(RNG_FILL_TSTATES);
      yield 'work';
      wr(hl, rng());
    }
    charge(13);                      // DJNZ closing the pass
  }
  yield* clearScreensG();
  showCoinageRaw();
  yield* delay(0x30);
  wr(0xD000, 0x3F);
  yield* memcpyWdG(0xD000, 0xD001, 0x3FF);   // RST 08h: propagate 3Fh over the whole layer
  yield* delay(0x50, 4);   // 0D78h has a NOP in the loop
  yield* clearScreensG();
} // powerOnScreen

// ---------------------------------------------------------------- the program
/**
 * main_start (0C85h) and main_loop (0CA3h). The attract mode runs in main_loop;
 * the demo (S_1252) and the game (L_296B) are blocking loops that keep waiting
 * for the frame counter themselves and only come back here by jumping.
 */
function* mainProgram() {
  yield* initRam();
  decodeDsw0();
  decodeDsw1();
  // Straight-line instruction time the transcription does not model byte by byte:
  // main_start's setup, the watchdog kicks and CALL/RET overhead inside initRam
  // and clearScreens, and the long compare chains of decodeDsw0 (0D89h) and
  // decodeDsw1 (0E58h). Those routines have no observable effect other than how
  // much of the frame they eat, so their cost is calibrated against refemu
  // instead of transcribed: with it the power-on RNG fill starts on the same
  // T-state, and C0A4h/C0A5h then agree frame by frame through the whole reset.
  charge(RESET_OVERHEAD_TSTATES);
  yield* settle();
  yield* powerOnScreen();
  wr(0xF800, 0x00);
  if (rd(0xC500) === 1) {
    yield* testPlayStart();          // dead code in this ROM, kept for fidelity
  }
  yield* drawTitle();

  for (;;) {                         // main_loop 0CA3h
    // 0CA3-0CB1: RST 38h 55 + LD A,01h 7 + LD (NMI_EN),A 13 + LD A,(C0A0) 13 +
    // LD B,A 4 + LD A,(C0A1) 13 + CP B 4 + JP Z 10 = 119 T a turn. The turn is
    // charged rather than given away with `yield 'frame'`, exactly as the game
    // loop at 2E44h does it: the NMI lands in the middle of a turn, so the body
    // below starts up to 119 T after the NMI returns, not at T-state 0 of the
    // frame. Giving the rest of the frame away instead put every pass of the
    // body 110 T early, and that offset then froze for the whole PUSH START
    // screen and the first startLife (measured with profile.mjs --write-at C119).
    for (;;) {
      charge(55+7+13+13+4+13+4+10);              // 0CA3-0CB1
      wr(0xF001, 1);
      if (rd(0xC0A1) !== rd(0xC0A0)) {
        break;
      }
      yield 'work';
    }
    // 0CB4-0CD8, the body of main_loop itself: 172 T of straight-line code and
    // CALL/RET overhead per pass (measured with tools/refemu/profile.mjs
    // --range tail=0CB4-0CDA, which reports a flat 172 T in every attract frame).
    charge(4+13+4+13+17);                        // 0CB4-0CBC
    wr(0xC0A1, rd(0xC0A0));
    wr(0xF800, 0x00);
    if (yield* checkCreditsStart()) {
      continue;
    }
    charge(13+7+(rd(0xC0A2) === 1 ? 17 : 10));   // 0CBF-0CC4
    if (rd(0xC0A2) === 1) {
      yield* drawTitle();
    }
    charge(17);                                  // 0CC7 CALL bgScrollDec
    bgScrollDec();
    charge(17);                                  // 0CCA CALL titleState
    yield* titleState();
    charge(17);                                  // 0CCD CALL checkCreditsStart
    if (yield* checkCreditsStart()) {
      continue;
    }
    charge(13+7+(rd(0xC0A2) === 4 ? 17 : 10)+10);   // 0CD0-0CD8
    if (rd(0xC0A2) === 4) {
      if (yield* demoStart()) {                // 1234: a coin ends the demo
        yield* pushStartScreen();
        continue;
      }
    }
  }
} // mainProgram

/** checkCreditsStart (0CDBh): any credit goes straight to the PUSH START screen */
function* checkCreditsStart() {
  // 0CDB LD A,(credits) 13 + CP 00h 7 + RET Z (11 taken, 5 not); with a credit,
  // LD SP,C800h 10 + JP pushStartScreen 10. Measured: 62 T per attract frame
  // for the two calls together, which the transcription used to spend nothing on.
  var credits = rd(0xC0AC);
  charge(13+7+(credits === 0 ? 11 : 5));
  if (credits === 0) {
    return false;
  }
  charge(10+10);
  yield* pushStartScreen();
  return true;
} // checkCreditsStart

// ---------------------------------------------------------------- attract frame
// The attract mode: the NMI, the title picture and the high-score table. Every
// routine keeps the original's name and address so the transcription can be
// checked against sources/asm/stinger/main.asm line by line.
//
// Time is charged here the way powerOnScreen does it — pay first, act second —
// because drawTitle runs with the NMI switched off for nearly eight frames and
// the frame on which it switches it back on (0FF0h) sets the phase of the whole
// title sequence. The costs are counted from the instructions: RST 38h is 55 T
// (11 + PUSH AF 11 + LD A,(nn) 13 + POP AF 10 + RET 10), RST 08h is 47 T of
// overhead plus 162 T a byte, fillBytes is 24 T a byte, LDIR 21 T a byte.

/** charges t T-states and lets tick() spend them before the next effect */
function* pay(t) {
  charge(t);
  yield 'work';
} // pay

/** LD HL,nn / LD B,n / CALL fillBytes (15CEh), paid before the bytes change */
function* payFillBytes(hl, b, a) {
  var n = b === 0 ? 256 : b;
  charge(10+7+17+n*FILL_BYTES_TSTATES-5+10);
  yield 'work';
  for (var i = 0; i < n; i++) {
    wr(hl+i, a);
  }
} // payFillBytes

/** showCoinageRaw (0EFCh) — the raw DIP values on the power-on screen */
function showCoinageRaw() {
  charge(55+13+13+13+13+13+13+13+13);            // 0EFC-0F14
  wr(0xD382, rd(0xC0A7));                        // coin A: coins per credit
  wr(0xD342, rd(0xC0A6));                        // ... and credits per coin
  wr(0xD384, rd(0xC540));                        // coin B
  wr(0xD344, rd(0xC541));
  // 0F15-0F27: one C5h tile per life, walking up the column from D386h in steps
  // of 20h (the screen is rotated), then the count itself below them
  var hl = 0xD386;
  var a = rd(0xC0A8);
  var b = a === 0 ? 256 : a;
  charge(10+13+4);
  for (var i = 0; i < b; i++) {
    wr(hl, 0xC5);
    hl = (hl-0x20) & 0xFFFF;
    charge(7+7+0x20*22-4+13);                    // LD (HL),C5h + LD C,20h + DEC HL/DEC C/JR NZ + DJNZ
  }
  wr(hl, a);
  charge(7+10);                                  // LD (HL),A + RET
} // showCoinageRaw

/** testPlayStart (2966h) — dead code in this ROM (C500h is never set to 1) */
function* testPlayStart() {
  yield 'frame';
} // testPlayStart

/** setVideoRegs (22C4h) — bits 0-4 of a go to F001h-F005h; in attract (curPlayer
 *  0) the value is forced to 02h, i.e. NMI off and palette bank 0 = 1.
 *  notes/A.md says F001h-F007h, but the routine only ever touches five registers. */
function setVideoRegs(a) {
  var b = a & 0xFF;
  var cost = 11+14+4+13+7;                       // PUSH BC, LD IX, LD B,A, LD A,(curPlayer), CP 00h
  if (rd(0xC030) === 0) {
    cost += 10+7;                                // JP NZ not taken, LD B,02h
    b = 0x02;
  } else {
    cost += 10;
  }
  cost += 4;                                     // LD A,B
  for (var i = 0; i < 5; i++) {
    var set = (b >> i) & 1;
    cost += 8+10+19;                             // BIT n,A + JP Z + LD (IX+n),v
    if (!set && i < 4) {
      cost += 12;                                // the zero path jumps back with JR
    }
    wr(0xF001+i, set);
  }
  charge(cost+10+10);                            // POP BC + RET
} // setVideoRegs

/** drawDigits6 (1583h) — six digits from (de) downwards into (hl), step -20h;
 *  leading zeros become the space tile 10h, an all-zero score a single '0' */
function* drawDigits6(hl, de) {
  // One turn of L_1585/L_159F is ~650 T and the six of them are most of the
  // 8294 T of drawScore, so the digits are settled one by one: the NMI really
  // does land inside this loop and the digits after it show the score the NMI
  // has just changed.
  charge(7);                                     // LD C,06h
  var cost = 0;
  var leading = true;
  for (var i = 0; i < 6; i++) {
    yield 'work';
    var v = rd(de);
    charge(cost);
    cost = 0;
    if (leading && v === 0) {
      wr(hl, 0x10);
      cost += 668;                               // the L_1585 branch
    } else {
      if (leading) {
        cost += 31;                              // ... and the test that leaves it
      }
      leading = false;
      wr(hl, v);
      cost += 644;                               // the L_159F branch
    }
    de = (de-1) & 0xFFFF;
    hl = (hl-0x20) & 0xFFFF;
  }
  yield 'work';
  if (leading) {
    hl = (hl+0x20) & 0xFFFF;                     // 1598: put a '0' back in the last cell
    charge(cost+41);
    wr(hl, 0);
  } else {
    charge(cost+10);
  }
} // drawDigits6

/** drawScoreAndHigh (1576h) — a score at (hl) and always the high score at D241h */
function* drawScoreAndHigh(hl, de) {
  charge(17);
  yield* drawDigits6(hl, de);
  charge(10+10+17);
  yield* drawDigits6(0xD241, 0xC07E);
  charge(10);
} // drawScoreAndHigh

/** drawScore (1536h) — the score of curPlayer (C030h) plus the high score */
function* drawScore() {
  charge(55+7+13+13+13+36);                      // RST 38h, LD A,00h, three stores, nine NOPs
  wr(0xD2C1, 0);
  wr(0xD181, 0);
  wr(0xD061, 0);
  var p = rd(0xC030);
  if (p === 1) {
    charge(13+7+10+10+10+10);
    yield* drawScoreAndHigh(0xD381, 0xC072);      // 1UP
  } else if (p === 2) {
    charge(13+7+10+7+10+10+10+10);
    yield* drawScoreAndHigh(0xD121, 0xC078);      // 2UP
  } else if (p === 3) {
    charge(13+7+10+7+10+7+10+10+10);
    yield* drawScoreAndHigh(0xD381, 0xC090);      // scoreAlt, never reached in this ROM
  } else {
    charge(13+7+10+7+10+7+10+10);
  }
} // drawScore

/** drawScores (121Ah) — redraws 1UP, 2UP and HIGH SCORE */
function* drawScores() {
  charge(55+13+11);                              // RST 38h, LD A,(curPlayer), PUSH AF
  var save = rd(0xC030);
  charge(7+13+17);
  wr(0xC030, 1);
  yield* drawScore();                            // curPlayer is 1 here for a third of
  charge(7+13+17);                               // a frame, and the NMI can fall inside
  wr(0xC030, 2);
  yield* drawScore();                            // ... and 2 here
  charge(10+13+10);
  wr(0xC030, save);
} // drawScores

/** drawText32 (15ACh) — 32 characters from (de) into the column (hl), step 20h */
function drawText32(hl, de) {
  charge(55+11+11+11+11+7);
  for (var i = 0; i < 0x20; i++) {
    wr(hl, rd(de+i));
    hl = (hl+0x20) & 0xFFFF;
    charge(i === 0x1F ? 675 : 680);              // the last DJNZ is 5 T shorter
  }
  charge(10+10+10+10+10);                        // POP HL/DE/BC/AF + RET
} // drawText32

/** drawText4Rev (11E0h) — four characters read backwards from ix into the
 *  column (hl), so the text ends up left to right on the rotated screen */
function drawText4Rev(hl, ix) {
  for (var i = 0; i < 4; i++) {
    wr(hl, rd(ix));
    ix = (ix-1) & 0xFFFF;
    hl = (hl+0x20) & 0xFFFF;
  }
  charge(11+11+11+11+15+10+7+4*(19+7+10+11+13)-5+14+10+10+10+10+10);
} // drawText4Rev

/** drawRankTitle (11ABh) — PRO. / SEMI / AMA. beside the table row in c.
 *  The disassembly in sources/asm/stinger/main.asm shows this as DB bytes: the
 *  hint `data 0x110B 0x11AB` in hints.d/A.txt is one byte too long and swallows
 *  the first instruction. The code is LD HL,VRAM1+AC / LD B,C / INC HL x C ... */
function drawRankTitle(c) {
  var hl = (0xD0AC+c) & 0xFFFF;
  charge(10+4+c*19-5+4+4+7);
  var slot = (c-1) & 0xFF;
  charge(17);
  if (compareScores(slot, 6) === 0) {            // below entry 6 (30000)
    charge(13+7+10+14+10);
    drawText4Rev(hl, 0x547F);                    // "AMA."
  } else {
    charge(13+7+10+7+17);
    if (compareScores(slot, 5) === 0) {          // below entry 5 (999990)
      charge(13+7+10+14+10);
      drawText4Rev(hl, 0x547B);                  // "SEMI"
    } else {
      charge(13+7+10+14);
      drawText4Rev(hl, 0x5477);                  // "PRO."
    }
  }
  charge(17+10);                                 // CALL drawText4Rev + RET
} // drawRankTitle

/** compareScores (1629h) — 1 when the six digits of table entry b are >= those
 *  of entry c (equal counts as >=, the loop falls into the carry branch) */
function compareScores(b, c) {
  // 1629h: both slots are found by walking C036h in steps of six, and each step
  // of both walks kicks the watchdog — with b and c up to 0Eh that is most of
  // what the routine costs.
  charge(11+11+10+10);
  var i;
  for (i = b; i > 0; i--) charge(55+4+7+7+11+4+10);
  charge(55+4+7+12+11+14+10);
  for (i = c; i > 0; i--) charge(4+7+10+11+4+55+12);
  charge(4+7+10+11+14+7);
  var ix = 0xC036+6*b;
  var iy = 0xC036+6*c;
  for (i = 0; i < 6; i++) {
    var vb = rd(ix-i);
    var vc = rd(iy-i);
    charge(19+19+4+10);
    if (vc < vb) { charge(10+7+10+10+10+10); return 1; }
    if (vc > vb) { charge(10+10+7+10+10+10); return 0; }
    charge(10+10+4+10);
  }
  charge(7+10+10+10+10);
  return 1;
} // compareScores

/** colorTableRows (11FBh) — the five table columns C11Bh.. are colour 3, the row
 *  being written (C666h) is colour 7 */
function colorTableRows() {
  var de = 0xC119+2*(rd(0xC666)-1);
  charge(10+13+(rd(0xC666)-1)*36+14);
  for (var i = 0; i < 5; i++) {
    wr(0xC11B+2*i, 3);
  }
  charge(4+10+7+(10+6+6+13)*5-5+7+7+10);
  wr(de, 7);
} // colorTableRows

/** titleRevealStep (10B5h) — one of the 32 columns of the STINGER logo: two
 *  tiles into VRAM1+5 going right, three into VRAM1+3E7 going left (tables 110Bh) */
function titleRevealStep() {
  var c = rd(0xC667);
  var a = (c+1) & 0xFF;
  wr(0xC667, a);
  charge(11+13+4+4+13+7+10);
  if (a === 0x20) {
    // L_10FE: the reveal is over, colour the five logo columns of ATTR1
    for (var i = 0; i < 5; i++) {
      wr(0xD80B+2*i, 6);
    }
    charge(10+7+5*(10+6+6+13)-5+10+10);
    return;
  }
  var ix = 0xD005, iy = 0xD3E7, hl = 0x110B;
  charge(4+14+14+10+10);
  for (var n = 0; n < c; n++) {
    hl += 5;
    ix += 0x20;
    iy -= 0x20;
    charge(7+7+10+11+0x20*(10+10+13)-5+4+10);
  }
  charge(7+7+10);
  wr(ix, rd(hl));
  wr(ix+1, rd(hl+1));
  wr(iy, rd(hl+2));
  wr(iy+1, rd(hl+3));
  wr(iy+2, rd(hl+4));
  charge(7+19+6+7+19+6+7+19+6+7+19+6+7+19+10+10);
} // titleRevealStep

/**
 * drawTitle (0F2Eh) — puts up the whole title screen. It runs with the NMI off
 * (setVideoRegs 02h), takes about 7.8 frames and only switches the NMI back on
 * at 0FF0h, so its length decides the phase of everything that follows.
 */
function* drawTitle() {
  yield* pay(55+4);                              // 0F2E RST 38h, 0F2F XOR A
  yield* payFillBytes(0xC140, 0x20, 0);          // 0F30 layer 1 sprite shadows
  yield* payFillBytes(0xC1A0, 0x20, 0);          // 0F38 layer 0 sprite shadows
  yield* payFillBytes(0xC220, 0x20, 0);          // 0F40 the object records
  yield* pay(13+13+7+13+7);                      // 0F48 FLIPY/FLIPX = 0, latch 90h, LD A,02h
  wr(0xF007, 0);
  wr(0xF006, 0);
  wr(0xF800, 0x90);
  charge(17);                                    // 0F55 CALL setVideoRegs
  setVideoRegs(0x02);
  yield 'work';

  yield* pay(10+10+10+0x40*LDIR_TSTATES-5);      // 0F58 attrInit -> the layer 1 shadow
  for (var i = 0; i < 0x40; i++) {
    wr(0xC100+i, rd(0x5400+i));
  }
  yield* pay(7+13);                              // 0F63 latch 90h
  wr(0xF800, 0x90);
  yield* pay(10+10+10+0x40*LDIR_TSTATES-5);      // 0F68 ... and straight to ATTR1
  for (i = 0; i < 0x40; i++) {
    wr(0xD800+i, rd(0x5400+i));
  }

  // 0F73-0F7E: the title picture, 1 KiB through RST 08h (162 T a byte, so this
  // one copy alone is 3.2 frames)
  yield* pay(55+10+10+10+47+0x400*MEMCPY_WD_TSTATES+4);
  for (i = 0; i < 0x400; i++) {
    wr(0xD000+i, rd(0x5000+i));
  }

  yield* pay(4);                                 // 0F7F XOR A
  yield* payFillBytes(0xC140, 0x20, 0);          // 0F80
  yield* payFillBytes(0xC1A0, 0x20, 0);          // 0F88
  yield* pay(7+13);                              // 0F90 latch 90h
  wr(0xF800, 0x90);

  // drawCoinageText (0F95h): "n COIN n CREDIT" and its doubled second line; the
  // 'S' of the plural (23h) only appears when the doubled value is >= 2
  var a = rd(0xC0A7);
  charge(13+13+8+13+8+7+10);
  wr(0xD31B, a);
  wr(0xD31D, (a << 1) & 0xFF);
  if ((((a << 1) & 0xFF) >> 1) & 0xFE) {
    charge(7+13);
    wr(0xD25B, 0x23);
  }
  a = rd(0xC0A6);
  charge(13+13+8+13+8+7+10);
  wr(0xD1FB, a);
  wr(0xD1FD, (a << 1) & 0xFF);
  if ((((a << 1) & 0xFF) >> 1) & 0xFE) {
    charge(7+13);
    wr(0xD0FB, 0x23);
  }
  charge(17);                                    // 0FC3 CALL drawScores
  yield* drawScores();
  yield 'work';

  yield* pay(7);                                 // 0FC6 LD A,01h
  yield* payFillBytes(0xC160, 0x40, 1);          // 0FC8 layer 0 scroll = 1 (the title backdrop)
  yield* payFillBytes(0xE800, 0x40, 1);          // 0FD0
  yield* pay(10+10+7);                           // 0FD8 LD HL/LD DE/LD A

  // titleBgFillLoop (0FE0h): 32 columns of 20h tiles from 4C00h into VRAM0,
  // bottom row first, each column separated by a 40h-step DEC DE loop — that
  // deliberate delay is what makes the backdrop roll in over four frames
  var hl = 0x4C00, de = 0xE3E0;
  for (var col = 0; col < 0x20; col++) {
    yield* pay(10+47+0x20*MEMCPY_WD_TSTATES+4+7+0x40*19-5+4+10);
    for (i = 0; i < 0x20; i++) {
      wr(de+i, rd(hl+i));
    }
    hl += 0x20;
    de = (de-0x20) & 0xFFFF;
  }

  yield* pay(7+13+13+13+7+(rd(0xC0AC) !== 0 ? 11 : 5));   // 0FEE NMI_EN = 1, lifeOver = 1
  wr(0xF001, 1);
  wr(0xC0B9, 1);
  if (rd(0xC0AC) !== 0) {
    return;                                      // 0FFB: with a credit, L_296B sets the state
  }
  yield* pay(7+13+7+13+4+13+13+13+10);           // 0FFC
  wr(0xC0A2, 2);                                 // gameState = title
  wr(0xC666, 1);                                 // titleRow
  wr(0xC667, 0);                                 // titleTimer
  wr(0xC515, 0);
  wr(0xC521, 0);
} // drawTitle

/**
 * titleState (1011h) — the attract state machine of the title screen. For the
 * first 32 even frames it reveals the logo; after that it writes one line of the
 * high-score table every time the backdrop scroll passes 7Fh or FFh, i.e. every
 * 128 frames, and hands over to the demo at row 7.
 */
function* titleState() {
  if (rd(0xC667) < 0x20) {
    charge(13+7+10);
    // L_10AE: one reveal step every other frame
    charge(55+13+8+(rd(0xC0A0) & 1 ? 11 : 5));
    if (rd(0xC0A0) & 1) {
      return;
    }
    titleRevealStep();
    yield 'work';
    return;
  }
  charge(13+7+10+55+17);
  colorTableRows();                              // 101A
  var scroll = rd(0xC160);
  charge(13+7+10+7+10+10);
  if (scroll !== 0x7F && scroll !== 0xFF) {
    return;                                      // 102A: wait for the backdrop to come round
  }
  var row = rd(0xC666);
  charge(13+7+10);
  if (row >= 7) {
    // L_10A3: the table is finished, go to the demo
    charge(7+13+7+13+10);
    wr(0xC0A2, 4);
    wr(0xC666, 1);
    yield 'work';
    return;
  }
  charge(7+10);
  if (row >= 6) {
    charge(4+13+10);                             // 1038: row 6 is a pause, nothing is drawn
    wr(0xC666, (row+1) & 0xFF);
    yield 'work';
    return;
  }

  // L_103D: the row number, the two rule tiles and the rank, score and name
  charge(4+4+10+row*19-5+7+4+10+row*19-5+4+7+4+10+row*19-5+7+7+10+11+4+7);
  wr(0xD2EC+row, row);
  wr(0xD16C+row, 0);
  wr(0xD30C+row, 0x1F);
  wr(0xD30C+row+0x20, 0x1E);
  charge(17);
  drawRankTitle(row);                            // 105F
  charge(13+4+10+10+(row-1)*(4+10+6+6+6+6+6+6+10)+4+10+17);
  yield* drawScoreAndHigh(0xD22D+row-1, 0xC036+6*(row-1));   // 107A
  charge(13+4+10+14+(row-1)*(4+10+6+10+10+10+10+10)+4+10+17);
  drawText4Rev(0xD24D+row-1, 0xC203+4*(row-1));        // 1098
  charge(13+4+13+10);
  wr(0xC666, (row+1) & 0xFF);
  yield 'work';
} // titleState

/**
 * bgScrollDec (225Eh) — scrolls layer 0 by one pixel a frame (all 32 column
 * scroll bytes of the shadow) and, in the closing fortress section only, walks
 * the enemy sprites down with it.
 */
function bgScrollDec() {
  charge(55+10+7+4+7);
  var v = (rd(0xC160)-1) & 0xFF;
  for (var i = 0; i < 0x20; i++) {
    wr(0xC160+2*i, v);
  }
  // 2276 INC HL costs 6 T whenever the current player is not 1 (it was never
  // charged); measured as a flat 6 T of undercharge on every attract-mode call
  charge(0x20*(7+6+6+13)-5+10+13+7+(rd(0xC030) === 1 ? 10 : 10+6));
  var section = rd(rd(0xC030) === 1 ? 0xC0BB : 0xC0BC);
  charge(7+7+(section < 0x1F ? 11 : 5));
  if (section < 0x1F) {
    return;                                      // 227A: only the fortress finale walks the enemies
  }
  charge(10+10+7);
  for (i = 0; i < 4; i++) {                      // 2283: the four A slots on layer 1
    if (rd(0xC224+2*i) >= 0x90) {
      wr(0xC148+4*i, (rd(0xC148+4*i)-1) & 0xFF);
    }
  }
  charge(10+10+7);
  for (i = 0; i < 3; i++) {                      // 229A: three of the B slots on layer 0
    if (rd(0xC238+2*i) >= 0x90) {
      wr(0xC1B0+4*i, (rd(0xC1B0+4*i)-1) & 0xFF);
    }
  }
  charge(10);
} // bgScrollDec

// ---------------------------------------------------------------- round tables
/**
 * currentRound (1EA3h) and roundTableByte (1E1Dh). Both read the fortress
 * section of the current player (C0BBh / C0BCh); roundTableByte indexes a 32
 * byte table with it. Note 1E2C/1E2D are `ADD A,L` / `LD L,A`, so the index is
 * added to L only and never carries into H.
 */
function currentRound() {
  var p = rd(0xC030);
  charge(11+10+13+7+(p === 1 ? 12 : 7+6)+7+10+10);
  return rd(p === 1 ? 0xC0BB : 0xC0BC);
} // currentRound

function roundTableByte(hl) {
  var p = rd(0xC030);
  charge(11+10+13+7+(p === 1 ? 10 : 10+6)+7+10+4+4+7+10);
  return rd((hl & 0xFF00) | ((hl+rd(p === 1 ? 0xC0BB : 0xC0BC)) & 0xFF));
} // roundTableByte

/** loadStageParam (2208h) — stageParam (C520h) = roundVideoRegs[round] */
function loadStageParam() {
  charge(10+17+13+10);
  var a = roundTableByte(0x5740);
  wr(0xC520, a);
  return a;
} // loadStageParam

/**
 * fgColumnVramAddr (15D3h) / bgColumnVramAddr (1DEAh) — the VRAM address of the
 * column that is currently scrolling in: the row comes from the column's scroll
 * byte in the attribute page (>= F8h means row 0), the column from b.
 */
function columnVramAddr(b, attrBase, vramBase, saves) {
  // The two copies are not the same code: 15D3h saves AF/BC/DE and pops them
  // again before its RET, 1DEAh (which starts at the LD C,B of 15D6h) does
  // neither. Measured: 1DEAh costs 63 T less than 15D3h on the same path, which
  // is exactly the three PUSHes and the three POPs.
  var v = rd(attrBase+2*b);
  var cost = (saves ? 11+11+11 : 0)+4+10+8+4+4+4+7+7+10;
  var hl;
  if (v >= 0xF8) {
    cost += 10+7+11+(saves ? 10+10+10 : 0)+10;
    charge(cost);
    return (vramBase+b) & 0xFFFF;
  }
  cost += 7;                                   // LD B,00h
  var n = 0, a = v;
  for (;;) {
    a -= 8;
    cost += 7+10;                              // SUB 08h / JP C
    if (a < 0) {
      break;
    }
    n++;
    cost += 4+10;                              // INC B / JP
  }
  cost += 10+10;                               // LD HL,VRAM+20 / LD DE,0020
  cost += n*(4+7+10+11+4+10)+4+7+10;           // the ADD HL,DE loop and its exit
  cost += 11+(saves ? 10+10+10 : 0)+10;        // ADD HL,BC + POP DE/BC/AF + RET
  charge(cost);
  return (vramBase+0x20+0x20*n+b) & 0xFFFF;
} // columnVramAddr

function fgColumnVramAddr(b) { return columnVramAddr(b, 0xD800, 0xD000, 1); }
function bgColumnVramAddr(b) { return columnVramAddr(b, 0xE800, 0xE000, 0); }

/**
 * S_27E0 — recolours layer 1 columns 15..30 with the round's foreground colour
 * and layer 0 with 2. Runs once a frame from fgScrollDec and from the demo.
 */
function fgRecolour() {
  var p = rd(0xC030);
  // 27EF RET NZ: 11 T when it returns, 5 T when it falls through (was inverted)
  charge(10+13+7+(p === 1 ? 10 : 10+6)+7+7+(rd(p === 1 ? 0xC006 : 0xC007) !== 0 ? 11 : 5));
  if (rd(p === 1 ? 0xC006 : 0xC007) !== 0) {
    return;
  }
  charge(10+17);
  var a = roundTableByte(0x5780);
  charge(10+7+0x10*(7+6+6+13)-5);
  for (var i = 0; i < 0x10; i++) {
    wr(0xC11F+2*i, a);
  }
  charge(7+10+7+0x20*(7+6+6+13)-5+10);
  for (i = 0; i < 0x20; i++) {
    wr(0xC161+2*i, 2);
  }
} // fgRecolour

/** fgScrollDec (2212h) — layer 1 columns 15..30 scroll one pixel a frame */
function fgScrollDec() {
  charge(55+10+7+4+7);
  var v = (rd(0xC11E)-1) & 0xFF;
  for (var i = 0; i < 0x10; i++) {
    wr(0xC11E+2*i, v);
  }
  charge(0x10*(7+6+6+13)-5+17);
  fgRecolour();                                // 221F CALL S_27E0
  charge(10+14+7);
  for (i = 0; i < 4; i++) {                    // 222B: the four A slots walk with it
    var t = rd(0xC224+2*i);
    charge(7+7+(t === 0x40 ? 12 : 7+7+(t === 0x45 ? 10 : 10)));
    if (t === 0x40 || t === 0x45) {
      wr(0xC148+4*i, (rd(0xC148+4*i)-1) & 0xFF);
      charge(23);
    }
    charge(6+6+10+10+10+10+13);
  }
  charge(-5+13+7);
  var b = rd(0xC22C);
  // 2249/224C/224F/2255 are RET cc: 11 T when they return, 5 T when they fall
  // through. The two first tests used to be charged as one lump of 39 T.
  charge(b === 0 ? 11 : 5);                      // 2249 RET Z
  if (b === 0) {
    return;
  }
  charge(7+(b === 0x44 ? 11 : 5));               // 224A-224C
  if (b === 0x44) {
    return;
  }
  charge(7);
  if (b >= 0x80) {
    charge(11);                                  // 224F RET NC
    return;
  }
  charge(5+13+7);
  if (rd(0xC310) === 3) {
    charge(11);
    return;
  }
  charge(5+13+4+13+10);
  wr(0xC158, (rd(0xC158)-1) & 0xFF);
} // fgScrollDec

/**
 * fgScrollStep (1E31h) — layer 1. Whenever the scroll has moved on by a whole
 * column, 16 bytes of the current foreground block are copied into the bottom
 * half of the new column; the block pointer wraps between 6000h/6200h/6400h/
 * 6600h/6800h according to roundFgBlock (5700h).
 */
function fgScrollStep() {
  var p = rd(0xC030);
  charge(10+13+7+(p === 1 ? 10 : 10+6)+7+7);
  if (rd(p === 1 ? 0xC006 : 0xC007) === 1) {
    charge(11);
    return;
  }
  charge(5+7+17);
  var de = fgColumnVramAddr(0x0F);
  charge(4+16+4+4+10);
  var hl = rd16(0xC0AF);
  if ((hl & 0xFF) === (de & 0xFF)) {
    fgScrollDec();
    return;
  }
  charge(20+16);
  wr16(0xC0AF, de);
  hl = rd16(0xC0B7);                           // fgMapAdvance 1E53
  charge(10+0x10*LDIR_TSTATES-5);
  for (var i = 0; i < 0x10; i++) {
    wr(de+i, rd(hl+i));
  }
  hl = (hl+0x10) & 0xFFFF;
  charge(4+7+10);
  if ((hl & 0xFF) === 0) {
    // 1E61-1E6E: the three CP/JP pairs are only reached in turn, so 68h costs
    // one pair, 64h two and 6Ah three (they used to be charged as three always)
    var h = (hl >> 8) & 0xFF;
    charge(4+7+10+(h === 0x68 ? 0 : 7+10+(h === 0x64 ? 0 : 7+10)));
    var r;
    if (h === 0x68) {
      charge(10+17);                             // 1E90 LD HL + 1E93 CALL
      r = roundTableByte(0x5700);
      charge(10+7+(r === 0 ? 10 : 10+7+10));     // 1E96-1E9B, else 1E9E-1EA0
      hl = (r === 0) ? 0x6000 : 0x6600;
    } else if (h === 0x64) {
      charge(10+17);                             // 1E7D LD HL + 1E80 CALL
      r = roundTableByte(0x5700);
      charge(10+7+(r !== 4 ? 10 : 10+7+10));     // 1E83-1E88, else 1E8B-1E8D
      hl = (r === 4) ? 0x6400 : 0x6200;
    } else if (h === 0x6A) {
      charge(7+10);                              // 1E9E-1EA0
      hl = 0x6600;
    }
  }
  charge(16+4+7+13+10);
  wr16(0xC0B7, hl);
  wr(0xC530, (hl >> 8) & 0x0E);
  fgScrollDec();
} // fgScrollStep

/**
 * remapBgColumn (1F0Fh) — translates the tile codes of the column just copied
 * (the 32 bytes below de) through one of four tables chosen by the round.
 * Source pages 60h..97h come pre-translated and are left alone.
 */
function remapBgColumnRun(srcHigh, de) {
  charge(11+11+11+11+55+4+7);
  if (srcHigh < 0x98 && srcHigh >= 0x60) {
    charge(7+7+10+10+10+10+10+10);
    return;
  }
  charge((srcHigh >= 0x98 ? 12 : 7+7+10)+17);
  var r = currentRound();
  // 1F21-1F31: four CP/JR C pairs tried in turn, then the LD HL of the table
  // and the JR that rejoins L_1F45 (1F42h falls through instead). Only the last
  // case was right before: the four CPs were charged up front, so every earlier
  // case paid for tests it never ran.
  var table;
  if (r < 0x07) { table = 0x1F67; charge(7+12+10+12); }
  else if (r < 0x10) { table = 0x2007; charge(7+7+7+12+10+12); }
  else if (r < 0x14) { table = 0x20A7; charge(7+7+7+7+7+12+10+12); }
  else if (r < 0x1A) { table = 0x2147; charge(7+7+7+7+7+7+7+12+10); }
  else { table = 0x20A7; charge(7+7+7+7+7+7+7+7+12+10+12); }
  charge(55+16+7);
  wr(0xC528, table);
  wr(0xC529, (table >> 8) & 0xFF);
  for (var i = 0; i < 0x20; i++) {
    de = (de-1) & 0xFFFF;
    var v = rd(de);
    charge(11+13+16+6+7+7+10);
    if (v < 0xA0) {
      wr(de, rd(table+v));
      charge(4+7+11+7+7);
    }
    charge(10+13);
  }
  charge(-5+10+10+10+10+10);
} // remapBgColumnRun

/** nextRound (21E7h) — the disassembly shows this as DB bytes; the code is
 *  section++, bgMapPtr = roundBgPage[section] << 8, loadStageParam, bgScrollDec */
function nextRound() {
  var p = rd(0xC030);
  charge(10+13+7+(p === 1 ? 10 : 10+6)+7+4+7);
  var addr = p === 1 ? 0xC0BB : 0xC0BC;
  var a = (rd(addr)+1) & 0xFF;
  wr(addr, a);
  charge(10+4+4+7+7+4+16+17+10);
  wr16(0xC260, rd(0x57A0+a) << 8);
  loadStageParam();
  bgScrollDec();
} // nextRound

/**
 * bgScrollStep (1EB2h) — layer 0, every fourth frame. A whole new column (32
 * bytes) of the background page is streamed in and remapped; running off the end
 * of a page is what ends the round.
 */
function bgScrollStep() {
  charge(13+7+5);
  if (rd(0xC0A0) & 3) {
    charge(6);
    return;
  }
  charge(7+17);
  var de = bgColumnVramAddr(0);
  charge(4+16+4+4+10);
  var hl = rd16(0xC262);
  if ((hl & 0xFF) === (de & 0xFF)) {
    bgScrollDec();
    return;
  }
  charge(20+16+10+0x20*LDIR_TSTATES-5);
  wr16(0xC262, de);
  hl = rd16(0xC260);
  for (var i = 0; i < 0x20; i++) {
    wr(de+i, rd(hl+i));
  }
  hl = (hl+0x20) & 0xFFFF;
  charge(17);
  remapBgColumnRun((hl >> 8) & 0xFF, (de+0x20) & 0xFFFF);
  charge(4+7+10);
  if ((hl & 0xFF) === 0) {
    var h = (hl >> 8) & 0xFF;
    // 1EDB-1F06: nine CP/JP Z pairs tried in turn, so only the pairs up to and
    // including the one that matches are executed
    var ends = [0x4C, 0x50, 0x78, 0x80, 0x70, 0x74, 0x7C, 0x9C, 0x60];
    var hit = ends.indexOf(h);
    charge(4+(hit >= 0 ? hit+1 : ends.length)*(7+10));
    if (hit >= 0) {
      nextRound();
      return;
    }
  }
  charge(16+10);
  wr16(0xC260, hl);
  bgScrollDec();
} // bgScrollStep

/**
 * attractBgStream (0183h) — the same background streaming, but for the closing
 * fortress section (round 1Fh), where the pages cycle 4C00h/5C00h instead of
 * ending the round.
 */
function attractBgStream() {
  var p = rd(0xC030);
  charge(55+10+13+7+(p === 1 ? 10 : 10+6)+7+7+5);
  if (rd(p === 1 ? 0xC006 : 0xC007) !== 0) {
    charge(6);
    return;
  }
  charge(13+7+5);
  if (rd(0xC0A0) & 3) {
    charge(6);
    return;
  }
  charge(7+17);
  var de = bgColumnVramAddr(0);
  charge(4+16+4+4+10);
  var hl = rd16(0xC262);
  if ((hl & 0xFF) === (de & 0xFF)) {
    bgScrollDec();
    return;
  }
  charge(20+16+10+47+0x20*MEMCPY_WD_TSTATES+17);
  wr16(0xC262, de);
  hl = rd16(0xC260);
  for (var i = 0; i < 0x20; i++) {
    wr(de+i, rd(hl+i));
  }
  hl = (hl+0x20) & 0xFFFF;
  remapBgColumnRun((hl >> 8) & 0xFF, (de+0x20) & 0xFFFF);
  charge(4+7+10);
  if ((hl & 0xFF) === 0) {
    var h = (hl >> 8) & 0xFF;
    charge(4+7+10);
    if (h === 0x50) {                          // L_01E1: alternate 4C00h and 5C00h
      var t = (rd(0xC525)+1) & 0xFF;
      wr(0xC525, t);
      charge(13+4+13+7);
      if (t === 2) {
        charge(12+4+13+10+10);
        wr(0xC525, 0);
        hl = 0x5C00;
      } else {
        charge(7+10+10);
        hl = 0x4C00;
      }
    } else if (h === 0x60) {                   // L_01FC: the finale starts
      charge(7+10+10+13+7+(p === 1 ? 10 : 10+6)+10+10);
      wr(p === 1 ? 0xC006 : 0xC007, 2);
      return;
    } else if (h === 0x74 || h === 0x78 || h === 0x7C || h === 0x80) {
      charge(7+7+7+7+10+7+10);
      hl = 0x4800;
    } else {
      charge(7+7+7+7+7+7+7+7);
    }
  }
  charge(16+10);
  wr16(0xC260, hl);
  bgScrollDec();
} // attractBgStream
// ---------------------------------------------------------------- NMI, game part
/**
 * calcAltitudeZone (04C0h) — how low the ship is flying (C310h): 0..3. In most
 * segments (fgMapPageFlags >= 6) it is simply 1; segments 0 and 4 have a ground
 * mask in C130h and only there does the ship's X decide.
 */
function calcAltitudeZone() {
  charge(55+14+13+7+10);
  var seg = rd(0xC530);
  if (seg >= 6) {
    charge(7+10);
    storeAltitudeZone(1);
    return;
  }
  charge(7+10);                                // 04CD-04CF
  // L_04F0 (LD A,01h + JP storeAltitudeZone) costs 7+10 T and is charged where
  // it is jumped to; the 7+10 used to be paid up front in altitudeSegType0,
  // which over-charged every path that does not take that jump by 17 T.
  if (seg === 0) {                             // altitudeSegType0 0500h
    var g = rd(0xC130);
    charge(13+7+10);                           // 0500-0505
    if (g >= 0xA0) { charge(7+10); storeAltitudeZone(1); return; }
    var y = rd(0xC140);
    charge(4+13+4+10);                         // 0508-050D
    if (y < g) { charge(7+10); storeAltitudeZone(1); return; }
    charge(4+7+10);                            // 0510-0513
    if (((y-g) & 0xFF) < 0x10) { charge(7+10); storeAltitudeZone(1); return; }
    charge(10);                                // 0516 JP altitudeByShipX
    altitudeByShipX();
    return;
  }
  charge(7+10);                                // 04D2-04D4
  if (seg === 4) {                             // altitudeSegType4 0519h
    var g4 = rd(0xC130);
    charge(13+7+10);                           // 0519-051E
    if (g4 === 0xFF) { charge(7+10); storeAltitudeZone(1); return; }
    charge(7+10);                              // 0521-0523
    if (g4 >= 0xA0) { altitudeByShipX(); return; }
    var y4 = rd(0xC140);
    charge(4+13+4+10);                         // 0526-052B
    if (y4 < g4) { altitudeByShipX(); return; }
    charge(7+10);                              // 052E-0530
    if (y4 < 0x10) { altitudeByShipX(); return; }
    charge(10+7+10);                           // 0533 JP L_04F0 + L_04F0
    storeAltitudeZone(1);
    return;
  }
  altitudeByShipX();
} // calcAltitudeZone

/** altitudeByShipX (04D7h) */
function altitudeByShipX() {
  var x = rd(0xC143);
  charge(19+7+10);
  if (x < 0x30) { charge(4+10); storeAltitudeZone(0); return; }
  charge(7+10);
  if (x < 0x60) { charge(7+10); storeAltitudeZone(1); return; }
  charge(7+10);
  if (x >= 0x90) { charge(7); storeAltitudeZone(3); return; }
  charge(10+7+10);
  storeAltitudeZone(2);
} // altitudeByShipX

function storeAltitudeZone(a) {
  charge(13+10);
  wr(0xC310, a);
} // storeAltitudeZone

/**
 * nmiSpriteAux (0383h) — tops the Bongo gauge up when it has been full for F0h
 * of the 32-frame ticks, and places the ship's ground shadow (sprite slot 7 of
 * set 1) according to the altitude zone.
 */
function nmiSpriteAux() {
  // 0389/0394/03A7 are JR cc: 12 T when the jump to L_03B2 is taken, 7 T when
  // it is not. The four tests here were charged the other way round.
  var fc = rd(0xC0A0) & 0x1F;
  charge(55+13+7+(fc === 0 ? 7 : 12));           // 0383-0389
  if (fc === 0) {
    var t = (rd(0xC524)+1) & 0xFF;
    wr(0xC524, t);
    charge(13+4+13+7+(t >= 0xF0 ? 7 : 12));      // 038B-0394
    if (t >= 0xF0) {
      var p = rd(0xC030);
      charge(10+13+7+(p === 1 ? 12 : 7+10+11));  // 0396-03A3
      var meter = p === 1 ? 0xC280 : 0xC290;
      var full = rd(meter) === 0xC4;
      charge(7+7+(full ? 7 : 12));               // 03A4-03A7
      if (full) {
        charge(4+10+10+0x10*LDIR_TSTATES-5);     // 03A9-03B0
        for (var i = 0; i < 0x10; i++) {
          wr(meter+i, rd(0x03EB+i));
        }
      }
    }
  }
  charge(13+7+5);
  if (rd(0xC22E) === 1) {
    charge(6);
    return;
  }
  charge(14+13+7+10);
  var z = rd(0xC310);
  if (z === 0 || z === 1) {
    charge((z === 0 ? 0 : 7+10)+4+19+19+19+19+13+10);
    wr(0xC15C, 0);                             // shadowHide 03FBh
    wr(0xC15D, 0);
    wr(0xC15E, 0);
    wr(0xC15F, 0);
    wr(0xC22E, 0);
    return;
  }
  // 03C4 CP 01h + 03C6 JP Z (17 T) were counted twice here; the original runs
  // them once. Measured with tools/refemu/profile.mjs: the PC trace of attract
  // frame 3347 spends 03C4:7 03C6:10 03C9:19 03CC:7 03CE:10 = 53 T on this
  // stretch, and the NMI of that frame was 17 T dearer in the worker than in
  // the reference -- the first frame of the demo game, i.e. the first frame in
  // which nmiGameLogic reaches nmiSpriteAux at all.
  charge(7+10+19+7+10);                        // 03C4-03CE
  var y = rd(0xC15C-0x19);                     // (IX-25) = C143h, shipX
  if (y >= 0xA0) {                             // shadowLowAlt 040Ch
    charge(19+7+19+19+19+19+7+19+10);
    wr(0xC15C, (rd(0xC140)+2) & 0xFF);         // (IX-28) is the ship's Y, C140h
    wr(0xC15D, 0x95);
    wr(0xC15E, 0x04);
    wr(0xC15F, (rd(0xC143)+3) & 0xFF);
    return;
  }
  charge(4+7+4+19+19+19+7+4+19+4+19+10);
  var a = (0x4A-y) & 0xFF;
  wr(0xC15F, a);
  wr(0xC15E, 0x04);
  wr(0xC15D, 0x95);
  wr(0xC15C, (rd(0xC140)+((a-0x9F) & 0xFF)) & 0xFF);
} // nmiSpriteAux

/**
 * drawBottomHud (089Ch) — the row of spare-life icons (C5h, C6h for five) and
 * the Bongo stock column, plus the 16 gauge tiles.
 */
function* drawBottomHud() {
  // 6151 T, so it too is settled inside its four loops (one life icon, one
  // blanked cell, one Bongo icon, one gauge tile at a time) -- each turn is one
  // pass of L_08C1 / L_08DD / L_08F3 / L_08FF / L_0910 in the original.
  charge(55+13+7+10);
  var p2 = rd(0xC030) === 2;
  var meter = p2 ? 0xC290 : 0xC280;
  var lives = rd(p2 ? 0xC0B2 : 0xC0B1);
  var stock = rd(p2 ? 0xC2A1 : 0xC2A0);
  charge(14+10+10+(p2 ? 0 : 10));
  var a = (lives-1) & 0xFF;
  var hl = 0xD3BF;
  charge(7+4+10);
  for (;;) {
    yield 'work';
    charge(7+10);
    if (a === 0) {
      break;
    }
    charge(7+10);
    if (a >= 5) {
      wr(hl, 0xC6);
      a = (a-4) & 0xFF;
      charge(10+7+10);
    } else {
      wr(hl, 0xC5);
      charge(10);
    }
    charge(7+0x20*(6+13)-5+4+10);
    hl = (hl-0x20) & 0xFFFF;
    a = (a-1) & 0xFF;
  }
  for (;;) {                                   // L_08DD: blank the rest of the row
    yield 'work';
    charge(4+7+10);
    if ((hl & 0xFF) === 0xDF) {
      break;
    }
    charge(10+7+0x20*(6+13)-5+12);
    wr(hl, 0x10);
    hl = (hl-0x20) & 0xFFFF;
  }
  charge(7+10+10);
  var s = stock;
  hl = 0xD25F;
  for (;;) {
    yield 'work';
    charge(7+10);
    if (s === 0) {
      break;
    }
    charge(10+4+11+10);
    wr(hl, 0xC0);
    s = (s-1) & 0xFF;
    hl = (hl+0x20) & 0xFFFF;
  }
  for (;;) {                                   // L_08FF
    yield 'work';
    charge(4+7+10);
    if ((hl & 0xFF) >= 0xE0) {
      break;
    }
    charge(10+11+10);
    wr(hl, 0x10);
    hl = (hl+0x20) & 0xFFFF;
  }
  charge(10+7);
  hl = 0xD05F;
  for (var i = 0; i < 0x10; i++) {              // L_0910: the 16 gauge tiles
    yield 'work';
    charge(19+7+11+10+13);
    wr(hl, rd(meter+i));
    hl = (hl+0x20) & 0xFFFF;
  }
  charge(-5+55+10);
} // drawBottomHud

/** blinkUpLabel (2B49h) — 1UP / 2UP flashing every 16 frames */
function blinkUpLabel() {
  charge(13+7+10);
  var ix, a, b, c;
  if (rd(0xC030) === 2) {
    ix = 0xD0A0;
    charge(14+13+8+10);
    if (rd(0xC0B6) & 1) { a = 0x20; b = 0x25; c = 0x02; charge(7+7+7+10); }
    else { a = 0x10; b = 0x10; c = 0x10; charge(7+4+4); }   // 2B82-2B85, no JP
  } else {
    ix = 0xD300;
    charge(14+13+8+10);
    if (rd(0xC0B6) & 1) { a = 0x20; b = 0x25; c = 0x01; charge(7+7+7+10); }
    else { a = 0x10; b = 0x10; c = 0x10; charge(7+4+4+10); }  // 2B66-2B6A
  }
  charge(19+19+19+10);
  wr(ix, a);
  wr(ix+0x20, b);
  wr(ix+0x40, c);
} // blinkUpLabel

/** enemyLevelCalc (S_150Bh) — C000h = 8*stage + section/16 + difficulty */
function enemyLevelCalc() {
  var p = rd(0xC030);
  charge(10+10+13+7+(p === 1 ? 10 : 10+6+6));
  var section = rd(p === 1 ? 0xC0BB : 0xC0BC);
  var stage = rd(p === 1 ? 0xC003 : 0xC004);
  charge(7+8+8+8+8+4+7+8+8+8+4+4+13+4+13+10);
  wr(0xC000, (((stage << 3) & 0xFF)+(section >> 4)+rd(0xC005)) & 0xFF);
} // enemyLevelCalc

// ---------------------------------------------------------------- the ship
/** shipMoveRight (2374h) — the hardware Y axis, +2 a frame (half that in zone 3) */
function shipMoveAxis(addr, dir, limit) {
  charge(11+13+7+10);
  var step = 2;
  if (rd(0xC310) === 3) {
    charge(13+8+10);
    if (rd(0xC0A0) & 1) {                      // 2391: JP Z, so it is the EVEN frames
      charge(10+10);                           // that move, at half a pixel step
      return;
    }
    charge(13+10);
    step = 1;                                  // the zone 3 path re-enters at L_2381,
  } else {                                     // i.e. after the first INC A, so half speed
    charge(13+4);
  }
  var a = (rd(addr)+step*dir) & 0xFF;
  charge(4+7+10);
  if (dir > 0 ? a < limit : a >= limit) {
    wr(addr, a);
    charge(13);
  }
  charge(10+10);
} // shipMoveAxis

function shipMoveRight() { shipMoveAxis(0xC140, 1, 0xB0); }
function shipMoveLeft()  { shipMoveAxis(0xC140, -1, 0x15); }
function shipMoveDown()  { shipMoveAxis(0xC143, 1, 0xE8); }
/** shipMoveUp (23ECh) — note 23ED reads C130h, not altitudeZone C310h: a typo in
 *  the original that makes upward movement full speed even in zone 3 */
function shipMoveUp() {
  charge(11+13+7+10);
  var step = 2;
  if (rd(0xC130) === 3) {
    charge(13+8+10);
    if (rd(0xC0A0) & 1) {                      // 2391: JP Z, so it is the EVEN frames
      charge(10+10);                           // that move, at half a pixel step
      return;
    }
    charge(13+10);
    step = 1;
  } else {
    charge(13+4);
  }
  var a = (rd(0xC143)-step) & 0xFF;
  charge(4+7+10);
  if (a >= 0x10) {
    wr(0xC143, a);
    charge(13);
  }
  charge(10+10);
} // shipMoveUp

/** playerInput (2322h) — the joystick, or the recorded demo track at 6B00h */
function playerInput() {
  charge(13+7+10);
  var a;
  if (rd(0xC0A2) === 5) {
    charge(13+7+10);
    if (rd(0xC0BD) === 0) {
      charge(13);
      a = rd(0xF018);
    } else {
      charge(13+7+10);
      if (rd(0xC030) === 1) {
        charge(13);
        a = rd(0xF018);
      } else {
        charge(13);                            // L_235C: the cocktail second player
        a = rd(0xF018);
        charge(8+(a & 0x08 ? 17 : 10)+8+(a & 0x04 ? 17 : 10)+8+(a & 0x40 ? 17 : 10)+8+(a & 0x80 ? 17 : 10)+10);
        if (a & 0x08) shipMoveRight();
        if (a & 0x04) shipMoveLeft();
        if (a & 0x40) shipMoveUp();
        if (a & 0x80) shipMoveDown();
        return;
      }
    }
  } else {
    charge(13+7+4+7+10);
    a = rd(0x6B00+rd(0xC0A0));                 // the demo joystick track
  }
  charge(8+(a & 0x01 ? 17 : 10)+8+(a & 0x02 ? 17 : 10)+8+(a & 0x10 ? 17 : 10)+8+(a & 0x20 ? 17 : 10)+10);
  if (a & 0x01) shipMoveRight();
  if (a & 0x02) shipMoveLeft();
  if (a & 0x10) shipMoveUp();
  if (a & 0x20) shipMoveDown();
} // playerInput

/** shipAnimate (2414h) — the propeller: 80h -> 81h -> 82h -> 80h */
function shipAnimate() {
  charge(10+13+7+10);
  var v = rd(0xC141);
  if (rd(0xC310) === 3) {                      // shipAnimateLowAlt 2433h
    charge(7+4+7);
    var a = (v+1) & 0xFF;
    if (a === 0x84) { a = 0x94; charge(12+7+12); }
    else if (a < 0x84) { charge(7+12); }
    else { a = 0x80; charge(7+7+7); }
    wr(0xC141, a);
    charge(7+10);
    return;
  }
  charge(7+7+10);
  if (v === 0x81) { charge(10+10); wr(0xC141, 0x82); return; }   // 242D LD (HL),82h + RET
  charge(7+10);
  if (v === 0x82) { charge(10+10); wr(0xC141, 0x80); return; }
  charge(10+10);
  wr(0xC141, 0x81);
} // shipAnimate

// ---------------------------------------------------------------- the shots
/**
 * fireButton (24B9h) — returns 1 on a fresh press. C534h counts up on every
 * call (three times a frame: nmiShot1, nmiShot2, nmiShot3) and has to have
 * reached 10h (8 when a = 1); the button must have been released in between
 * (C533h), so there is no autofire.
 */
function fireButton(a) {
  var b = a === 1 ? 8 : 0x10;
  // 24BD JR NZ,L_24C1 skips LD B,08h: 12 T when A is not 1, 7 T + 7 T when it
  // is (both were the wrong way round). Same at 24C7 JR NC,L_24CC, which skips
  // the store: 12 T when the cooldown has saturated, 7 T + 13 T when it has not.
  charge(7+7+(a === 1 ? 7+7 : 12));
  var cd = (rd(0xC534)+1) & 0xFF;
  charge(13+4+7+(cd < 0xFF ? 7+13 : 12));
  if (cd < 0xFF) {
    wr(0xC534, cd);
  }
  charge(13+7+10);
  var pressed;
  if (rd(0xC0BD) !== 0 && rd(0xC030) !== 1) {
    charge(13+7+10+13+8+10);
    pressed = (rd(0xF010) & 0x80) !== 0;
  } else {
    charge((rd(0xC0BD) === 0 ? 0 : 13+7+10)+13+8+10);
    pressed = (rd(0xF010) & 0x40) !== 0;
  }
  if (!pressed) {
    charge(4+13+10);
    wr(0xC533, 0);
    return 0;
  }
  // 24EA JR Z,L_24EE and 24F2 JR C,L_24EC: 12 T taken, 7 T not (both were
  // charged as if the branch always went the same way)
  var held = rd(0xC533) !== 0;
  charge(13+7+55+(held ? 7 : 12));
  if (held) {
    charge(4+10);
    return 0;
  }
  var cool = rd(0xC534);
  charge(13+4+(cool < b ? 12 : 7));
  if (cool < b) {
    charge(4+10);
    return 0;
  }
  charge(4+13+7+13+10);
  wr(0xC534, 0);
  wr(0xC533, 1);
  return 1;
} // fireButton

/** shot1Remove (2584h) */
function shot1Remove() {
  charge(14+7+19+19+13+7+13+10);
  wr(0xC144, 0);
  wr(0xC147, 0);
  wr(0xC222, 0);
  wr(0xC142, 3);
} // shot1Remove

/**
 * shot1FireLowAlt (250Bh) — inside the fortress (zone 3) the shot becomes a
 * bomb: sprite code C9h at the ship's own position, state 2, timer 0. With no
 * new press the slot shows the aiming marker instead (lowAltMarker 254Bh).
 */
function shot1FireLowAlt() {
  charge(13+7+10);
  if (rd(0xC0A2) === 5) {
    charge(7+17+7+10);
    var f = fireButton(1);
    if (f === 0) { lowAltMarker(); return; }
    charge(13);
    wr(0xF80A, f);
  }
  charge(7+13+7+13+4+13+14+19+7+19+19+19+19+7+19+10);   // L_2520
  wr(0xC142, 0x06);
  wr(0xC222, 0x02);
  wr(0xC223, 0);
  wr(0xC144, rd(0xC140));
  wr(0xC145, 0xC9);
  wr(0xC146, 0x07);
  wr(0xC147, rd(0xC143));
} // shot1FireLowAlt

/** lowAltMarker (254Bh) — the code 96h marker 48 px ahead, where a bomb lands */
function lowAltMarker() {
  charge(14+19+7+19+19+19+19+19+4+13+7+13+10);
  wr(0xC144, (rd(0xC140)+0x30) & 0xFF);
  wr(0xC145, 0x96);
  wr(0xC146, 0x07);
  wr(0xC147, rd(0xC143));
  wr(0xC222, 0);
  wr(0xC142, 0x03);
} // lowAltMarker

/**
 * bombFly (2599h) — 3 px a frame forward; the cross axis follows the timer
 * (-3 -3 -3 -2 -2 -1 -1 -1 0 +1 +2 +2 +3 ...), which draws the arc. After 10h
 * frames the bomb stops, turns into the impact code CAh and is gone five frames
 * later (bombFall 25E8h).
 */
function bombFly() {
  charge(13+4+13+4+7+10);
  var a = rd(0xC223);
  wr(0xC223, (a+1) & 0xFF);
  if (a >= 0x10) {
    charge(7+10);                              // bombFall 25E8h
    if (a >= 0x15) { shot1Remove(); return; }
    charge(7+13+10);
    wr(0xC145, 0xCA);
    return;
  }
  charge(14+23+23+23+7+10);
  wr(0xC144, (rd(0xC144)+3) & 0xFF);
  var d = 0;
  if (a < 3) { d = -3; charge(23+23+23+10+10); }
  else {
    charge(7+10);
    if (a < 5) { d = -2; charge(23+23+10+10); }
    else {
      charge(7+10);
      if (a < 8) { d = -1; charge(23+10+10); }
      else {
        charge(10);
        if (a === 8) { charge(10); }
        else {
          charge(7+10);
          if (a < 0x0A) { d = 1; charge(23+10); }
          else {
            charge(7+10);
            if (a < 0x0C) { d = 2; charge(10+23+23+10); }
            else { d = 3; charge(10+23+23+23+10); }
          }
        }
      }
    }
  }
  if (d) { wr(0xC147, (rd(0xC147)+d) & 0xFF); }
} // bombFly


/** rearShotCheck (2679h) — a full Bongo gauge and five in stock buy a rear shot */
function rearShotCheck() {
  charge(13+7+5);
  if (rd(0xC310) >= 2) {
    charge(6);
    return;
  }
  charge(13+7+5);
  if (rd(0xC22E) === 1) {
    charge(6);
    return;
  }
  charge(13+7+10);
  var p1 = rd(0xC030) === 1;
  var meter = p1 ? 0xC280 : 0xC290;
  var stockAddr = p1 ? 0xC2A0 : 0xC2A1;
  charge(14+14+(p1 ? 0 : 10));
  charge(13+7+5);
  if (rd(0xC22E) === 1) { charge(6); return; }
  charge(19+7+5);
  if (rd(stockAddr) < 5) { charge(6); return; }
  charge(19+7+5);
  if (rd(meter) !== 0xC4) { charge(6); return; }
  charge(7+13);
  wr(0xC22E, 1);
  charge(14+13+19+19+19+13+19+10);             // rearShotSpawn 26B7h
  wr(0xC15C, rd(0xC140));
  wr(0xC15D, 0xCE);
  wr(0xC15E, 0x06);
  wr(0xC15F, rd(0xC143));
} // rearShotCheck

/** nmiShot1 (2443h) — the main shot; state 2 (bomb) and 3 (deflected) are the
 *  low-altitude and ricochet variants */
function nmiShot1() {
  var st = rd(0xC222);
  charge(13+7+10);
  if (st === 1) {                              // shot1Fly 256Fh
    charge(14+19+7);
    var y = rd(0xC144);
    for (var i = 0; i < 10; i++) {
      y = (y+1) & 0xFF;
      charge(4+7+10);
      if (y >= 0xF0) {
        shot1Remove();
        return;
      }
      wr(0xC144, y);
      charge(19+13);
    }
    charge(-5+10);
    return;
  }
  charge(7+10);
  if (st === 2) { bombFly(); return; }          // bombFly 2599h
  charge(7+10);
  if (st === 3) { shot1Deflected(); return; }   // 2452 -> 25F3h
  charge(13+7+5);
  if (rd(0xC0B9) === 1) {
    charge(6);
    return;
  }
  shot1FireCheck();
} // nmiShot1

/**
 * shot1Deflected (25F3h) — state 3: shotDeflect (2CF3h) turns the shot round
 * when it hits armour, and it then flies up and to the left as sprite code 84h,
 * 4 px in Y and 3 px in X a frame, for 30h frames or until it leaves the play
 * field. The three sibling routines below do the same for the tail shots.
 * T-states counted from the instructions of 25F3h..2622h.
 */
function shot1Deflected() {
  var t = rd(0xC223);
  charge(14+19+13+4+13+4+7+10);                // 25F3-2605
  wr(0xC145, 0x84);
  wr(0xC223, (t+1) & 0xFF);
  if (t >= 0x30) {
    shot1Remove();                             // 2605 JP NC
    return;
  }
  var y = (rd(0xC144)-4) & 0xFF;
  charge(19+7+7+10);                           // 2608-260F
  if (y < 0x10) {
    shot1Remove();
    return;
  }
  var x = (rd(0xC147)-3) & 0xFF;
  charge(19+19+7+7+10);                        // 2612-261C
  wr(0xC144, y);
  if (x < 0x08) {
    shot1Remove();
    return;
  }
  charge(19+10);                               // 261F-2622
  wr(0xC147, x);
} // shot1Deflected

/** shot2Deflected (271Fh) — the same for shot 2 (C1BCh), but X grows by 3 */
function shot2Deflected() {
  var t = rd(0xC23F);
  charge(14+13+4+13+4+7+10);                   // 271F-272D
  wr(0xC23F, (t+1) & 0xFF);
  if (t >= 0x30) {
    shot2Remove();                             // 272D JP NC
    return;
  }
  var y = (rd(0xC1BC)-4) & 0xFF;
  charge(19+19+7+7+10);                        // 2730-273B
  wr(0xC1BD, 0x84);
  if (y < 0x10) {
    shot2Remove();
    return;
  }
  var x = (rd(0xC1BF)+3) & 0xFF;
  charge(19+19+7+7+10);                        // 273E-2748
  wr(0xC1BC, y);
  if (x >= 0xF0) {
    shot2Remove();
    return;
  }
  charge(19+10);                               // 274B-274E
  wr(0xC1BF, x);
} // shot2Deflected

/** shot3Deflected (27C1h) — shot 3 (C1B8h) only moves in Y, 10 px a frame */
function shot3Deflected() {
  var t = rd(0xC23D);
  charge(14+10+7+11+7+10);                     // 27C1-27CC
  wr(0xC23D, (t+1) & 0xFF);
  if (t >= 0x30) {
    shot3Remove();                             // 27CC JP NC
    return;
  }
  charge(7+19);                                // 27CF-27D1
  var y = rd(0xC1B8);
  for (var i = 0; i < 10; i++) {               // L_27D4: DEC A ten times
    y = (y-1) & 0xFF;
    charge(4+7+10);
    if (y < 0x08) {
      shot3Remove();                           // 27D7 JP C
      return;
    }
    charge(13);
  }
  charge(-5+19+10);                            // 27DA (last DJNZ), 27DC-27DF
  wr(0xC1B8, y);
} // shot3Deflected

/** L_245B — the shot 1 fire test; also entered from the demo through S_1446 */
function shot1FireCheck() {
  charge(13+7+10);
  if (rd(0xC310) === 3) {
    shot1FireLowAlt();                         // 2460 shot1FireLowAlt 250Bh
    return;
  }
  var p = rd(0xC030);
  charge(10+13+7+(p === 1 ? 10 : 10+6)+7+7+5);   // 2463-2472, CP 03h included
  if (rd(p === 1 ? 0xC006 : 0xC007) === 3) {
    charge(6);
    return;
  }
  charge(13+7+10);
  if (rd(0xC0A2) === 5) {
    charge(4+17);
    var f = fireButton(0);
    charge(7+10);
    if (f === 0) {
      shot1Remove();
      return;
    }
    charge(13);
    wr(0xF80A, f);
  }
  charge(7+13+14+14+19+7+19+19+19+19+7+19+7+13+7+13+10);
  wr(0xC331, 1);
  wr(0xC144, (rd(0xC140)+0x10) & 0xFF);
  wr(0xC145, 0xBE);
  wr(0xC146, 0x06);
  wr(0xC147, (rd(0xC143)+2) & 0xFF);
  wr(0xC142, 6);
  wr(0xC222, 1);
  rearShotCheck();
} // shot1FireCheck

/** nmiShot2 (2623h) — the tail shot of set 0, plus the rear shot's flight */
function nmiShot2() {
  charge(13+7+5);
  if (rd(0xC0A2) !== 5) {
    charge(6);
    return;
  }
  charge(13+7+(rd(0xC22E) === 1 ? 17 : 10));
  if (rd(0xC22E) === 1) {
    rearShotFly();
  }
  var st = rd(0xC23E);
  charge(13+7+10);
  if (st === 1) {                              // shot2Fly 26FFh
    charge(14+19+7);
    var y = rd(0xC1BC);
    for (var i = 0; i < 10; i++) {
      y = (y+1) & 0xFF;
      charge(4+7+10);
      if (y >= 0xF0) {
        shot2Remove();
        return;
      }
      wr(0xC1BC, y);
      charge(19+13);
    }
    charge(-5+10);
    return;
  }
  charge(7+10);
  if (st === 3) { shot2Deflected(); return; }  // 263B -> 271Fh
  charge(13+7+5);
  if (rd(0xC0B9) === 1) { charge(6); return; }
  charge(13+7+5);
  if (rd(0xC310) === 3) { charge(6); return; }
  charge(4+17);
  var f = fireButton(0);
  charge(7+5);
  if (f === 0) { charge(6); return; }
  charge(14+14+19+7+19+19+19+19+7+19+7+13+13+10);
  wr(0xC1BC, (rd(0xC140)+0x10) & 0xFF);
  wr(0xC1BD, 0xBE);
  wr(0xC1BE, 0x06);
  wr(0xC1BF, (rd(0xC143)+2) & 0xFF);
  wr(0xC23E, 1);
  wr(0xF80A, 1);
} // nmiShot2

function shot2Remove() {
  charge(4+19+19+13+10);
  wr(0xC1BC, 0);
  wr(0xC1BF, 0);
  wr(0xC23E, 0);
} // shot2Remove

/** rearShotFly (26D0h) — the rear shot travels backwards 10 px a frame */
function rearShotFly() {
  charge(14+7+19);
  var y = rd(0xC15C);
  for (var i = 0; i < 10; i++) {
    y = (y-1) & 0xFF;
    charge(4+7+10);
    if (y < 8) {
      charge(4+10+7+17+13+10);
      fillBytes(0xC15C, 4, 0);
      wr(0xC22E, 0);
      return;
    }
    charge(13);
  }
  charge(-5+19+19+4+7+(rd(0xC15D)+1 < 0xD0 ? 12 : 7+7)+19+10);
  wr(0xC15C, y);
  var c = (rd(0xC15D)+1) & 0xFF;
  wr(0xC15D, c < 0xD0 ? c : 0xCE);
} // rearShotFly

/** nmiShot3 (274Fh) — the second tail shot (slot 6 of set 0) */
function nmiShot3() {
  charge(13+7+5);
  if (rd(0xC0A2) !== 5) { charge(6); return; }
  var st = rd(0xC23C);
  charge(13+7+10);
  if (st === 1) {                              // shot3Fly 279Ch
    charge(14+7+19);
    var y = rd(0xC1B8);
    for (var i = 0; i < 10; i++) {
      y = (y+1) & 0xFF;
      charge(4+7+7);
      if (y >= 0xF0) {
        charge(5);
        shot3Remove();
        return;
      }
      charge(13);
    }
    charge(-5+19+10);
    wr(0xC1B8, y);
    return;
  }
  charge(7+10);
  if (st === 3) { shot3Deflected(); return; }  // 275F -> 27C1h
  charge(13+7+5);
  if (rd(0xC0B9) === 1) { charge(6); return; }
  charge(13+7+5);
  if (rd(0xC310) === 3) { charge(6); return; }
  charge(4+17);
  var f = fireButton(0);
  charge(7+5);
  if (f === 0) { charge(6); return; }
  charge(14+19+7+19+19+19+19+7+19+7+13+13+10);
  wr(0xC1B8, (rd(0xC140)+0x10) & 0xFF);
  wr(0xC1B9, 0xBE);
  wr(0xC1BA, 0x06);
  wr(0xC1BB, (rd(0xC143)+2) & 0xFF);
  wr(0xC23C, 1);
  wr(0xF80A, 1);
  rearShotCheck();
} // nmiShot3

function shot3Remove() {
  charge(4+19+19+19+19+13+10);
  wr(0xC1B8, 0);
  wr(0xC1B9, 0);
  wr(0xC1BA, 0);
  wr(0xC1BB, 0);
  wr(0xC23C, 0);
} // shot3Remove

/*
 * -------------------------------------------------------------- Bongo (053Fh)
 * Bongo and the supply object are one object: sprite slot 6 of set 1 (C158h),
 * the state byte bongoState C22Ch and the timer bongoTimer C22Dh. 053Fh runs
 * every NMI and dispatches on the state; the attract demo drives the same
 * routines from attractBongoAutopilot (1455h).
 *
 * Every step of the 053Fh chain is a JP, never a CALL, which matters in one
 * place: when the supply object is shot down, supplyDestroyed (076Eh) ends with
 * POP AF / RET, throwing away the return address of its own CALL so that the
 * whole chain is left at once. Here that is just a `return` from supplyWander.
 */
function nmiBongoPlayer() {
  charge(55+13+7+5);
  if (rd(0xC0B9) === 1) { charge(6); return; }
  charge(13+7+5);
  if (rd(0xC0A2) !== 5) { charge(6); return; }
  charge(13+7+10);
  var st = rd(0xC22C);
  if (st === 0x23) { supplyDepart(); return; }
  charge(7+10);
  if (st >= 0x80) { bongoActive(); return; }
  charge(7+10);
  if (st === 0x44) { supplyExplode(st); return; }
  charge(13+7+10);
  if (rd(0xC21C) === 0) {
    charge(13+7+10);
    if (rd(0xC21D) === 0) { supplyObjectUpdate(); return; }
  }
  bongoCallInput();
} // nmiBongoPlayer

/** bongoCallInput (056Eh) — the BONGO CALL button: IN0 bit 2 (bit 1 for the
 *  cocktail's player 2). There is no edge detection, so a held button calls a
 *  new Bongo the instant the previous one is gone. */
function bongoCallInput() {
  charge(55+13+4+13+7+10);
  var b = rd(0xF010);
  var stock;
  if (rd(0xC030) === 1) {
    charge(10);                                  // L_0594
    stock = 0xC2A0;
  } else {
    charge(10+13+7+10);
    stock = 0xC2A1;
    if (rd(0xC0BD) !== 0) {
      charge(7+7+10);
      if (rd(stock) === 0) { supplyObjectUpdate(); return; }
      charge(8+10);
      if (b & 0x02) { bongoCall(stock); return; }
      charge(10);
      supplyObjectUpdate();
      return;
    }
  }
  charge(7+7+10);                                // L_0597
  if (rd(stock) === 0) { supplyObjectUpdate(); return; }
  charge(8+10);
  if (b & 0x04) { bongoCall(stock); return; }
  supplyObjectUpdate();
} // bongoCallInput

/** bongoCall (09E4h) — one Bongo out of stock. With no supply object on screen
 *  it enters at the left edge (Y = 0) from the half of the screen the ship is
 *  not in; a supply object simply turns into Bongo where it stands (L_0A08). */
function bongoCall(hl) {
  charge(11+14+13+7+10);
  wr(hl, (rd(hl)-1) & 0xFF);
  if (rd(0xC22C) === 0) {
    charge(19+13+7+10);
    wr(0xC158, 0x00);
    if (rd(0xC143) < 0x80) {
      charge(19+10);
      wr(0xC15B, 0xA0);
    } else {
      charge(19);                                // L_0A04
      wr(0xC15B, 0x30);
    }
  }
  charge(19+19+4+13);                            // L_0A08
  wr(0xC159, 0xD0);
  wr(0xC15A, 0x05);
  wr(0xC22D, 0);
  charge(13+7+10);                               // bongoStart 0A14h
  if (rd(0xC0A2) === 5) {
    charge(7+13);
    wr(0xF800, 0x10);
  }
  charge(7+13+10);
  wr(0xC22C, 0x80);
} // bongoCall

/**
 * bongoActive (0A27h) — every NMI while the state is >= 80h. The timer moves on
 * every 16 frames and the run ends when it passes bongoTime (C00Ah, from DSW1);
 * 80h approaches the ship, 81h..90h orbit it, 92h..9Ch hunt, A0h flies away.
 */
function bongoActive() {
  charge(13+7+10);
  if (rd(0xC0A2) === 5) {
    charge(7+13);
    wr(0xF800, 0x28);
  }
  charge(13+4+13+4+10);
  var b = rd(0xC22D);
  if (rd(0xC00A) < b) { bongoReturnEnd(); return; }
  charge(13+7+10);
  if ((rd(0xC0A0) & 0x0F) === 0) {
    charge(4+4+13);
    wr(0xC22D, (b+1) & 0xFF);
  }
  charge(13+7+10);                               // L_0A4C
  var st = rd(0xC22C);
  if (st === 0xA0) { bongoReturnEnd(); return; }
  charge(7+10);
  if (st >= 0x92) { bongoHuntTarget(); return; }
  charge(14+13+7+10);
  st = rd(0xC22C);
  if (st === 0x80) { bongoApproachShip(); return; }
  // 0A65: B keeps the state as it was BEFORE the step below, and it is that old
  // state that picks the orbit slot
  charge(4+13+7+10);
  if ((rd(0xC0A0) & 0x03) === 0) {
    charge(4+4+7+10);
    var n = (st+1) & 0xFF;
    if (n >= 0x91) {
      charge(7+13+10);
      wr(0xC22C, 0x92);
      return;
    }
    charge(13);                                  // L_0A7B
    wr(0xC22C, n);
  }
  charge(4+7+10+10);                             // L_0A7E
  var a = st & 0x1F;
  var hl = 0x0AB3;                               // bongoOrbitTable
  for (;;) {
    a = (a-1) & 0xFF;
    charge(4+10);
    if (a === 0) { break; }
    charge(11+10);
    hl += 4;
  }
  // bongoOrbitPosition 0A8Fh
  charge(14+14+19+7+4+19+6+7+19+6+7+19+6+7+19+4+19+10);
  wr(0xC158, (rd(hl)+rd(0xC140)) & 0xFF);
  wr(0xC159, rd(hl+1));
  wr(0xC15A, rd(hl+2));
  wr(0xC15B, (rd(hl+3)+rd(0xC143)) & 0xFF);
} // bongoActive

/** bongoApproachShip (0AF3h) — 3 px a frame in each axis until both gaps are
 *  under 10h, then the orbit starts (bongoStartOrbit 0BC5h) */
function bongoApproachShip() {
  charge(14+17+14);
  var dir = bongoDirToTarget(0xC158, 0xC140);    // bongoDirToShip 0B47h
  charge(17);
  bongoMoveByDir(dir, 0xC158);
  charge(17);
  var d = bongoDistToShip(0xC158);
  charge(7+10);
  if (d < 0x10) {
    charge(7+13+10);
    wr(0xC22C, 0x81);
    return;
  }
  charge(10);
} // bongoApproachShip

/** bongoMoveByDir (0B06h) — the direction byte of 0B4Bh: bits 0/1 Y-3, 2/3 Y+3,
 *  4/5 X-3, 6/7 X+3 (two bits per direction, three pixels per bit pair) */
var BONGO_STEPS = [[0,-3],[0,-3],[0,3],[0,3],[3,-3],[3,-3],[3,3],[3,3]];
function bongoMoveByDir(a, ix) {
  for (var i = 0; i < 8; i++) {
    charge(8);
    if (a & (1 << i)) {
      charge(17+69+10);
      var off = BONGO_STEPS[i][0], d = BONGO_STEPS[i][1];
      wr(ix+off, (rd(ix+off)+d) & 0xFF);
    } else {
      charge(10);
    }
  }
  charge(13+7+5);
  if (rd(0xC0A0) & 0x0F) { charge(6); return; }
  charge(19+4+7+10);
  var c = (rd(ix+1)+1) & 0xFF;
  if (c >= 0xD4) { charge(7); c = 0xD0; }
  charge(19+19+10);                              // L_0B3F
  wr(ix+1, c);
  wr(ix+2, 0x05);
} // bongoMoveByDir

/**
 * bongoDirToTarget (0B4Bh) — the eight-way direction from ix to iy. The cached
 * value in C527h is dead code: 0B56 is `AND 00h`, so the test that follows it is
 * always taken and the direction is recomputed every frame.
 */
function bongoDirToTarget(ix, iy) {
  charge(13+7);
  if (rd(0xC527) !== 0) {
    charge(7+4+13+7+12);
  } else {
    charge(12);
  }
  charge(19+19+4+10);                            // L_0B5C
  var v;
  if (rd(ix+0) >= rd(iy+0)) {
    charge(19+19+4+10);
    var a = rd(ix+3), b = rd(iy+3);
    if (a === b) { charge(7+12); v = 0x03; }
    else if (a < b) { charge(10+7); v = 0x41; }
    else { charge(10+7+12); v = 0x11; }
  } else {
    charge(19+19+4+10);                          // L_0B81
    var a2 = rd(ix+3), b2 = rd(iy+3);
    if (a2 === b2) { charge(7+10); v = 0x0C; }
    else if (a2 < b2) { charge(10+7+10); v = 0x44; }
    else { charge(10+7+10); v = 0x14; }
  }
  charge(13+10);                                 // L_0B7D
  wr(0xC527, v);
  return v;
} // bongoDirToTarget

/** bongoDistToShip (0C53h) — |dY| + |dX| to the ship, but only when both are
 *  under 10h; otherwise it returns the axis gap itself, which is >= 10h */
function bongoDistToShip(ix) {
  charge(14+19+19+4+10);
  var a = rd(ix+0), b = rd(0xC140), t;
  if (a < b) { charge(4+4+4); t = a; a = b; b = t; }
  charge(4+7+5);
  a = a-b;
  if (a >= 0x10) { charge(6); return a; }
  charge(4+19+19+4+10);
  var d = a;
  a = rd(ix+3); b = rd(0xC143);
  if (a < b) { charge(4+4+4); t = a; a = b; b = t; }
  charge(4+7+5);
  a = a-b;
  if (a >= 0x10) { charge(6); return a; }
  charge(4+10);
  return (a+d) & 0xFF;
} // bongoDistToShip

/** bongoHuntTarget (0BD1h) — states 92h..9Ch pick sprite (state-92h): 92h..95h
 *  are slots 2..5 of set 1, 96h..9Ch slots 0..6 of set 0. Empty, exploding or
 *  invulnerable types are skipped (bongoNextTarget 0C26h). */
function bongoHuntTarget() {
  charge(13+14+7+10);
  var st = rd(0xC22C);
  var hl, iy, n;
  if (st >= 0x96) {
    charge(7+10+14+10);                          // L_0BF9
    n = st-0x96; hl = 0xC230; iy = 0xC1A0;
  } else {
    charge(7+10+14);
    n = st-0x92; hl = 0xC224; iy = 0xC148;
  }
  for (; n !== 0; n--) {                         // L_0BE6
    charge(7+10+4+6+6+40+10);
    hl += 2; iy += 4;
  }
  charge(7+10);
  var t = rd(hl);                                // L_0C05
  charge(7+7+10);
  if (t === 0) { bongoNextTarget(); return; }
  charge(7+10);
  if (t === 0x2F) { bongoNextTarget(); return; }
  charge(7+10);
  if (t === 0x4D) { bongoNextTarget(); return; }
  charge(7+10);
  if (t === 0x4E) { bongoNextTarget(); return; }
  charge(7+10);
  if (t >= 0x90) { bongoNextTarget(); return; }
  charge(17);
  var dir = bongoDirToTarget(0xC158, iy);
  charge(17);
  bongoMoveByDir(dir, 0xC158);
  charge(10);
} // bongoHuntTarget

/** bongoNextTarget (0C26h) — the next slot, and after 9Ch back to the ship */
function bongoNextTarget() {
  charge(13+4+7+10);
  var n = (rd(0xC22C)+1) & 0xFF;
  if (n >= 0x9D) {
    charge(7+13+10);
    wr(0xC22C, 0x80);
    return;
  }
  charge(13+10);                                 // L_0C35
  wr(0xC22C, n);
  bongoHuntTarget();
} // bongoNextTarget

/** bongoReturnEnd (0C3Bh) — state A0h: 2 px a frame backwards, gone under Y = 8 */
function bongoReturnEnd() {
  charge(7+13+14+23+23+19+7+5);
  wr(0xC22C, 0xA0);
  var y = (rd(0xC158)-2) & 0xFF;
  wr(0xC158, y);
  if (y >= 0x08) { charge(6); return; }
  charge(10);
  bongoRemoveSilent();
} // bongoReturnEnd

/** bongoRemoveSilent (09BCh) / bongoClear (09C0h) */
function bongoRemoveSilent() {
  charge(4+13);
  wr(0xF800, 0);
  bongoClear();
} // bongoRemoveSilent

function bongoClear() {
  charge(4+13+13+14+19+19+19+19+13+10);
  wr(0xC22C, 0);
  wr(0xC312, 0);
  wr(0xC158, 0); wr(0xC159, 0); wr(0xC15A, 0); wr(0xC15B, 0);
  wr(0xC311, 0);
} // bongoClear

// ------------------------------------------------------- the supply object
/** supplyObjectUpdate (05A2h) — inside a type 2 segment the object lives its
 *  life (05E8h); anywhere else an existing one drifts off the screen */
function supplyObjectUpdate() {
  charge(55+14+13+7+10);
  if (rd(0xC530) === 2) { supplyInDockSegment(); return; }
  charge(13+7+5);
  if (rd(0xC22C) === 0) { charge(6); return; }
  supplyDriftAway();
} // supplyObjectUpdate

/** supplyDriftAway (05B5h) — Y -2 every 8 frames until it leaves at Y < 0Ah */
function supplyDriftAway() {
  charge(13+7+5);
  if (rd(0xC0A0) & 0x07) { charge(6); return; }
  charge(23+23+4+13+19+7+10);
  wr(0xC158, (rd(0xC158)-2) & 0xFF);
  wr(0xF800, 0);
  if (rd(0xC158) < 0x0A) { bongoRemoveSilent(); return; }
  charge(19+7+10);
  if (rd(0xC159) === 0xA0) {
    charge(19+10);                               // L_05DA
    wr(0xC159, 0xA1);
    return;
  }
  charge(19+10);
  wr(0xC159, 0xA0);
} // supplyDriftAway

/** supplyInDockSegment (05E8h) — one object per 512 frames (C0B5h = 50h), only
 *  after the life has been running for 255 frames */
function supplyInDockSegment() {
  charge(13+7+10);
  var st = rd(0xC22C);
  if (st === 0x44) { supplyExplode(st); return; }
  charge(7+10);
  if (st !== 0) { supplyActive(); return; }
  charge(13+7+5);
  if (rd(0xC0B5) !== 0x50) { charge(6); return; }
  charge(16+4+7+10);
  var pf = rd16(0xC21C);
  if ((pf >> 8) === 0) {
    charge(4+7+5);
    if ((pf & 0xFF) < 0xFF) { charge(6); return; }
  }
  charge(13+7+5);                                // L_0608
  if (rd(0xC0B9) === 1) { charge(6); return; }
  spawnSupplyObject();
} // supplyInDockSegment

/** spawnSupplyObject (060Eh) — state 1, sprite at the bottom right corner */
function spawnSupplyObject() {
  charge(4+13+4+13+13+19+19+19+19+10);
  wr(0xC22D, 0);
  wr(0xC22C, 1);
  wr(0xC270, 1);
  wr(0xC158, 0xE8);
  wr(0xC159, 0xA0);
  wr(0xC15A, 0x05);
  wr(0xC15B, 0xC0);
} // spawnSupplyObject

/** supplyDepart (062Ah) — state 23h: the object leaves after the gauge is full */
function supplyDepart() {
  charge(13+4+7+10);
  var t = (rd(0xC22D)+1) & 0xFF;
  if (t >= 0x20) { bongoClear(); return; }
  charge(13+13+7+10);
  wr(0xC22D, t);
  if (rd(0xC158) < 0x08) { bongoClear(); return; }
  charge(10);
} // supplyDepart

/** supplyActive (063Fh) — codes CBh..CDh mean the object has escaped */
function supplyActive() {
  charge(19+7+10);
  var c = rd(0xC159);
  if (c === 0xCB) { supplyEscape(); return; }
  charge(7+10);
  if (c === 0xCC) { supplyEscape(); return; }
  charge(7+10);
  if (c !== 0xCD) { supplyWander(); return; }
  supplyEscape();
} // supplyActive

/** supplyEscape (0651h) — the escape animation, 10h frames long */
function supplyEscape() {
  charge(7+13+13+4+7+10);
  wr(0xF800, 0x26);
  var t = (rd(0xC22D)+1) & 0xFF;
  if (t >= 0x10) { bongoRemoveSilent(); return; }
  charge(13+13+7+5);
  wr(0xC22D, t);
  if (rd(0xC0A0) & 0x03) { charge(6); return; }
  charge(19+4+7+10);
  var c = (rd(0xC159)+1) & 0xFF;
  if (c >= 0xCE) { charge(7); c = 0xCB; }
  charge(19+13+7+5);                             // L_0673
  wr(0xC159, c);
  if (rd(0xC0A0) & 0x0F) { charge(6); return; }
  charge(23+10);
  wr(0xC158, (rd(0xC158)+1) & 0xFF);
} // supplyEscape

/**
 * supplyWander (0680h) — every 8 frames: animate, test the enemies (a hit turns
 * the object into an explosion and leaves the whole 053Fh chain), then look for
 * a "puller" enemy of code E5h..E7h close by; failing that, 070Ch.
 */
function supplyWander() {
  charge(13+7+10);
  if (rd(0xC0B9) === 1) { supplyDriftAway(); return; }
  charge(13+7+5);
  if (rd(0xC0A0) & 0x07) { charge(6); return; }
  charge(19+8+10);
  var b = rd(0xC159);
  if (b & 1) { charge(8+10); b &= 0xFE; } else { charge(8); b |= 1; }
  charge(19+19+17);                              // L_069D
  wr(0xC159, b);
  wr(0xC15A, 0x05);
  if (supplyVsEnemies()) { return; }             // 06A4 — POP AF / RET
  charge(14+7);
  var iy = 0xC148;
  for (var n = 4; n > 0; n--) {
    charge(19+7+10);
    var t = rd(iy+1);
    var pull = (t === 0xE5);
    if (!pull) { charge(7+10); pull = (t === 0xE6); }
    if (!pull) { charge(7+10); pull = (t === 0xE7); }
    if (pull) {
      charge(19+19+4+7+10);                      // L_06CC
      var dy = (rd(0xC158)-rd(iy+0)) & 0xFF;
      var near = dy < 0x30;
      if (!near) { charge(7+10); near = dy >= 0xD0; }
      if (near) {
        charge(19+19+4+7+10);                    // L_06E0
        var dx = (rd(0xC15B)-rd(iy+3)) & 0xFF;
        if (dx < 0x10) {
          charge(7+13+17+17+10);                 // L_06F4
          wr(0xF800, 0x16);
          supplyDir2(); supplyDir2();
          return;
        }
        charge(7+10);
        if (dx >= 0xF0) {
          charge(7+13+17+17+10);                 // L_0700
          wr(0xF800, 0x16);
          supplyDir4(); supplyDir4();
          return;
        }
        charge(10);
      } else {
        charge(10);
      }
    }
    charge(40+13);                               // L_06BF
  }
  charge(-5+10);
  supplyDockOrWander();
} // supplyWander

/** supplyVsEnemies (075Ah) — the object against sprites 2..5 of set 1; a hit is
 *  state 44h and, through POP AF / RET, the end of the whole NMI chain */
function supplyVsEnemies() {
  charge(7+7);
  for (var c = 2; c < 6; c++) {
    charge(17+7+10);
    if (spriteCollide(6, c) === 1) {
      charge(7+13+4+13+10+10);                   // supplyDestroyed 076Eh
      wr(0xC22C, 0x44);
      wr(0xC22D, 0);
      return true;
    }
    charge(4+4+7+10);
  }
  charge(10);
  return false;
} // supplyVsEnemies

/** supplyExplode (0779h) — state 44h: SND_BOOM every frame for 30h frames */
function supplyExplode(a) {
  charge(14+13+13+4+7+10);
  wr(0xF808, a);
  var t = (rd(0xC22D)+1) & 0xFF;
  if (t >= 0x30) { bongoRemoveSilent(); return; }
  charge(13+8+8+8+7+19+10);
  wr(0xC22D, t);
  wr(0xC159, ((t >> 3)+0xAB) & 0xFF);
} // supplyExplode

/** supplyDockOrWander (070Ch) — with the ship low (zone 3) try to dock */
function supplyDockOrWander() {
  charge(13+7+10);
  if (rd(0xC310) === 3) { supplyDockCheck(); return; }
  supplyRandomDir();
} // supplyDockOrWander

/** supplyRandomDir (0714h) — a new direction 1..4 out of the RNG every 20h of
 *  the object's own timer, then one step in it */
function supplyRandomDir() {
  charge(7+13+7+13+13+7+10);
  wr(0xF800, 0x12);
  wr(0xC311, 1);
  if ((rd(0xC22D) & 0x1F) === 0) {
    var a;
    for (;;) {                                   // L_0726
      charge(17+RNG_TSTATES+7+7+10);
      a = rng() & 0x0F;
      if (a < 6) { break; }
    }
    charge(7+10);
    if (a >= 4) { charge(7); a = 4; }
    charge(13);                                  // L_0737
    wr(0xC270, a);
  }
  supplyMoveByDir();
} // supplyRandomDir

/** supplyMoveByDir (073Ah) */
function supplyMoveByDir() {
  charge(13+7+10);
  var d = rd(0xC270);
  if (d === 4) { supplyDir4(); return; }
  charge(7+10);
  if (d === 3) { supplyDir3(); return; }
  charge(7+10);
  if (d === 2) { supplyDir2(); return; }
  charge(10);
  supplyDir1();
} // supplyMoveByDir

// The four directions (091Bh, 0933h, 094Eh, 0969h). Each one first makes sure
// the sprite already wears the pair of codes that belongs to the direction; if
// not it only steps the code on (supplyAnimStep) and moves next time.
function supplyDir1() {
  charge(7+13+19+7+10);
  wr(0xC270, 1);
  var c = rd(0xC159);
  if (c !== 0xA0) {
    charge(7+10);
    if (c !== 0xA1) { supplyAnimStep(); return; }
  }
  charge(23+10);                                 // L_092D
  wr(0xC158, (rd(0xC158)-1) & 0xFF);
  supplyStepDone();
} // supplyDir1

function supplyDir2() {
  charge(7+13+19+7+10);
  wr(0xC270, 2);
  var c = rd(0xC159);
  if (c !== 0xA6) {
    charge(7+10);
    if (c !== 0xA7) { supplyAnimStep(); return; }
  }
  charge(23+23+10);                              // L_0945
  wr(0xC158, (rd(0xC158)+1) & 0xFF);
  wr(0xC15B, (rd(0xC15B)+1) & 0xFF);
  supplyStepDone();
} // supplyDir2

function supplyDir3() {
  charge(7+13+19+7+10);
  wr(0xC270, 3);
  var c = rd(0xC159);
  if (c !== 0xA4) {
    charge(7+10);
    if (c !== 0xA5) { supplyAnimStep(); return; }
  }
  charge(23+23+10);                              // L_0960
  wr(0xC158, (rd(0xC158)+2) & 0xFF);
  supplyStepDone();
} // supplyDir3

function supplyDir4() {
  charge(7+13+19+7+10);
  wr(0xC270, 4);
  var c = rd(0xC159);
  if (c !== 0xA2) {
    charge(7+10);
    if (c !== 0xA3) { supplyAnimStep(); return; }
  }
  charge(23+19+4+7+10);                          // L_097B
  wr(0xC158, (rd(0xC158)-1) & 0xFF);
  if (((rd(0xC15B)-1) & 0xFF) < 0x90) {
    charge(19+4+13+10);                          // L_098D: the object gets away
    wr(0xC159, 0xCB);
    wr(0xC22D, 0);
    return;
  }
  charge(23+10);
  wr(0xC15B, (rd(0xC15B)-1) & 0xFF);
  supplyStepDone();
} // supplyDir4

/** supplyAnimStep (0996h) — code += 2, wrapping at A8h back to A0h */
function supplyAnimStep() {
  charge(19+4+4+7+10);
  var c = (rd(0xC159)+2) & 0xFF;
  if (c >= 0xA8) { charge(7); c = 0xA0; }
  charge(19+10);                                 // L_09A2
  wr(0xC159, c);
} // supplyAnimStep

/** supplyStepDone (074Fh) */
function supplyStepDone() {
  charge(13+4+13+17+10);
  wr(0xC22D, (rd(0xC22D)+1) & 0xFF);
  supplyClampEdges();
} // supplyStepDone

/** supplyClampEdges (09A6h) — gone under Y = 0Fh, pushed back at X >= E5h */
function supplyClampEdges() {
  charge(19+7+10);
  if (rd(0xC158) < 0x0F) {
    charge(17+10);
    bongoRemoveSilent();
    return;
  }
  charge(19+7+5);                                // L_09B2
  if (rd(0xC15B) < 0xE5) { charge(6); return; }
  charge(23+10);
  wr(0xC15B, (rd(0xC15B)-1) & 0xFF);
} // supplyClampEdges

/**
 * supplyDockCheck (0798h) — with the ship low and within 0Ah/10h the object
 * snaps 0Fh px in front of or behind it and the gauge starts filling: one tile
 * every 16 frames, or one every call while C521h is set.
 */
function supplyDockCheck() {
  charge(14+19+19+4+7+10);
  var dx = (rd(0xC15B)-rd(0xC143)) & 0xFF;
  if (dx >= 0x0A) {
    charge(7+10);
    if (dx < 0xF5) { supplyRandomDir(); return; }
  }
  charge(19+19+4+7+10);                          // L_07AD
  var b = rd(0xC140);
  var dy = (rd(0xC158)-b) & 0xFF;
  if (dy < 0x10) {
    charge(4+7+19+10);                           // supplySnapAhead 07C1h
    wr(0xC158, (b+0x0F) & 0xFF);
  } else {
    charge(7+10);
    if (dy < 0xF0) { supplyRandomDir(); return; }
    charge(4+7+19);                              // supplySnapBehind 07CAh
    wr(0xC158, (b-0x0F) & 0xFF);
  }
  charge(7+13+13+7+10);                          // supplyDocked 07D0h
  wr(0xF800, 0x24);
  if (rd(0xC521) !== 0) {
    charge(17);
    fuelGaugeFill();
    charge(17);
    fuelGaugeFill();
  } else {
    charge(13+7);
    if (rd(0xC0A0) & 0x0F) {
      charge(12);
    } else {
      charge(7+12+17);
      fuelGaugeFill();
    }
  }
  charge(17);
  drain(drawBottomHud());                       // see drain(): the NMI path (053Fh)
  charge(10);
} // supplyDockCheck

/**
 * fuelGaugeFill (07F0h) — one empty tile (10h) of the 16-tile gauge becomes
 * C2h/C3h/C4h. When the gauge is full: stock < 5 gains a Bongo and 600 points,
 * stock 5 repaints the gauge in C4h and finally pays 2000.
 */
function fuelGaugeFill() {
  charge(13+7+10);
  var hl, stock;
  if (rd(0xC030) === 2) {
    charge(10+14);                               // L_0802
    hl = 0xC290; stock = 0xC2A1;
  } else {
    charge(10+14+10);
    hl = 0xC280; stock = 0xC2A0;
  }
  var de = hl;
  charge(11+10+7);
  for (var b = 0x10; b > 0; b--) {               // L_080D
    charge(7+7+10);
    if (rd(hl) === 0x10) { gaugeSlotTile(hl); return; }
    charge(6+13);
    hl++;
  }
  charge(-5+19+7+10);
  if (rd(stock) >= 5) { gaugeFullMaxStock(hl); return; }
  charge(13+7+10);
  if (rd(0xC0A2) === 5) {
    charge(7+13+13+13);
    wr(0xF800, 0x22); wr(0xF800, 0x22); wr(0xF800, 0x22);
  }
  charge(4+7+7+17);                              // gaugeFullBongoGained 0831h
  fillBytes(de, 0x10, 0x10);
  charge(23+7+13+4+13+14+19+19+7+13+7+17);
  wr(stock, (rd(stock)+1) & 0xFF);
  wr(0xC22C, 0x23);
  wr(0xC22D, 0);
  wr(0xC159, 0x97);
  wr(0xC15A, 0x07);
  wr(0xC21C, 1);
  drain(addScore(0x3C));                         // see drain(): the NMI path (053Fh)
  charge(4+13+10);
  wr(0xC524, 0);
} // fuelGaugeFill

/** gaugeFullMaxStock (0860h) — hl is one past the gauge; the tiles are turned
 *  into C4h from the top down, and the last one pays 2000 points */
function gaugeFullMaxStock(hl) {
  charge(4+4+4+7+4+7+7+7);
  var de = (hl & 0xFF00) | ((hl-0x10) & 0xFF);
  if (rd(de) === 0xC4) {
    charge(5+7+13+10);                           // L_087B
    wr(0xF800, 0x22);
    bongoClear();
    return;
  }
  charge(6+7);
  hl--;
  for (var b = 0x10; b > 0; b--) {               // L_086E
    charge(7+7+7);
    if (rd(hl) !== 0xC4) {
      charge(5+10+10);                           // L_0883
      wr(hl, 0xC4);
      return;
    }
    charge(6+13);
    hl--;
  }
  charge(-5+7+17);
  drain(addScore(0xC8));                         // see drain(): the NMI path (053Fh)
  charge(7+13+10);
  wr(0xF800, 0x22);
  bongoClear();
} // gaugeFullMaxStock

/** gaugeSlotTile (0886h) — slot < 8 is C2h, 8..0Ch C3h, >= 0Dh C4h */
function gaugeSlotTile(hl) {
  charge(4+7+7+10);
  var i = hl & 0x0F;
  if (i >= 0x0D) { charge(10+10); wr(hl, 0xC4); return; }
  charge(7+10);
  if (i >= 8) { charge(10+10); wr(hl, 0xC3); return; }
  charge(10+10);
  wr(hl, 0xC2);
} // gaugeSlotTile

/**
 * nmiGameLogic (0103h) — the video and scrolling half of the NMI, run whenever a
 * life is in progress.
 */
function nmiGameLogic() {
  charge(55+17);
  calcAltitudeZone();
  charge(11+17);
  playerInput();
  charge(10+17);
  shipAnimate();
  var p = rd(0xC030);
  charge(55+10+13+7+(p === 1 ? 10 : 10+6)+7+7+10);
  if (rd(p === 1 ? 0xC0BB : 0xC0BC) === 0x1F) {
    // L_015A: the closing fortress
    charge(55+4+13+10+13+7+(p === 1 ? 10 : 10+6)+7+7+10);
    wr(0xC523, 0);
    if (rd(p === 1 ? 0xC006 : 0xC007) === 3) {
      return;                                  // finaleFlashSeq 0210h — ST-M5
    }
    charge(7+17);
    setVideoRegs(0x16);
    charge(17+10);
    attractBgStream();
    return;
  }
  charge(13+55+17);
  setVideoRegs(rd(0xC520));
  charge(55+17);
  bgScrollStep();
  charge(55+17);
  nmiSpriteAux();
  charge(13+7+10);
  if (rd(0xC310) === 3) {
    charge(55+13+8);
    if (rd(0xC0A0) & 1) {
      charge(17);
      fgScrollStep();
    } else {
      charge(10);
    }
    charge(10);
    return;
  }
  charge(55+17+10);
  fgScrollStep();
} // nmiGameLogic
// ---------------------------------------------------------------- level set-up
/** n straight CALLs of delayLoop (S_160B) */
function* delayCalls(n) {
  charge(n*(17+DELAY_LOOP_TSTATES));
  yield 'work';
} // delayCalls

/** roundAfterDeath (4136h) — the section a life restarts from */
function roundAfterDeath(a) {
  charge(11+4+13+10+7+7);
  wr(0xC532, 0);
  if (a < 3) {
    charge(12+4+10);
    return 0;
  }
  charge(7+7+10);
  return (a-1) & 0xFF;
} // roundAfterDeath

/**
 * fgLevelInit (1D04h) — layer 1: the HUD colours, the round's foreground colour
 * for columns 15..30, the HUD text and score, and 31 columns of the round's
 * foreground block streamed into the bottom half of the screen. The RST 08h
 * copies cost 162 T a byte, so this alone is a bit over two frames with the NMI
 * still off.
 */
function* fgLevelInit() {
  yield* clearScreensG();
  charge(7+13+13+13+13+13+13);
  wr(0xC101, 7); wr(0xD801, 7);
  wr(0xC103, 7); wr(0xD803, 7);
  wr(0xC13F, 7); wr(0xD83F, 7);
  var p = rd(0xC030);
  charge(10+13+7+(p === 1 ? 10 : 10+6)+7+17+4+4+7);
  var addr = p === 1 ? 0xC0BB : 0xC0BC;
  wr(addr, roundAfterDeath(rd(addr)));
  charge(10+17);
  var col = roundTableByte(0x5780);
  charge(10+7+0x10*(7+6+6+13)-5);
  for (var i = 0; i < 0x10; i++) {
    wr(0xC11F+2*i, col);
  }
  charge(10+7+0x10*(7+6+6+13)-5);
  for (i = 0; i < 0x10; i++) {
    wr(0xD81F+2*i, col);
  }
  charge(7+10+7+0x0D*(7+6+6+13)-5);
  for (i = 0; i < 0x0D; i++) {
    wr(0xC105+2*i, 2);
  }
  charge(10+10+17);
  drawText32(0xD000, 0x5480);
  charge(17);
  yield* drawScores();
  yield 'work';

  charge(10+17);
  var block = ((roundTableByte(0x5700)+0x60) & 0xFF) << 8;
  charge(4+4+10+7);
  var de = 0xD3EF;
  for (i = 0; i < 0x1F; i++) {
    yield* pay(10+47);
    for (var j = 0; j < 0x10; j++) {             // RST 08h copies a byte at a time
      yield* pay(MEMCPY_WD_TSTATES);
      wr(de+j, rd(block+0x10*i+j));
    }
    yield* pay(4+7+0x30*(6+13)-5+4+10);
    de = (de-0x20) & 0xFFFF;
  }
  charge(16+7+17+16);
  wr16(0xC0B7, (block+0x1F0) & 0xFFFF);
  wr16(0xC0AF, fgColumnVramAddr(0x0F));
  charge(14+19+19+19+19+7+13+10);
  wr(0xC140, 0x30);
  wr(0xC141, 0x81);
  wr(0xC142, 0x03);
  wr(0xC143, 0x50);
  wr(0xC220, 1);
  yield 'work';
} // fgLevelInit

/** bgLevelInit (1DA2h) — layer 0: colour 2 everywhere and 31 columns of the
 *  round's background page, each remapped by remapBgColumn */
function* bgLevelInit() {
  charge(55+7+10+7+0x20*(7+6+6+13)-5+55+10+7+0x20*(7+6+6+13)-5);
  for (var i = 0; i < 0x20; i++) {
    wr(0xC161+2*i, 2);
    wr(0xE801+2*i, 2);
  }
  charge(17);
  var r = currentRound();
  charge(55+10+4+4+7+7+4+10+7);
  var page = rd((0x57A0 & 0xFF00) | ((0xA0+r) & 0xFF)) << 8;
  var de = 0xE3E0;
  for (i = 0; i < 0x1F; i++) {
    yield* pay(10+47);
    for (var j = 0; j < 0x20; j++) {
      yield* pay(MEMCPY_WD_TSTATES);
      wr(de+j, rd(page+0x20*i+j));
    }
    yield* pay(4+17);
    remapBgColumnRun(((page+0x20*(i+1)) >> 8) & 0xFF, (de+0x20) & 0xFFFF);
    yield* pay(7+0x40*(6+13)-5+4+10);
    de = (de-0x20) & 0xFFFF;
  }
  charge(16+7+17+16+10);
  wr16(0xC260, (page+0x3E0) & 0xFFFF);
  wr16(0xC262, bgColumnVramAddr(0));
  yield 'work';
} // bgLevelInit

/** clearHudRows (1848h) — blanks columns 18h..1Fh of every row of VRAM1 */
function clearHudRows() {
  charge(7+10+7);
  var hl = 0xD018;
  for (var c = 0; c < 0x20; c++) {
    for (var i = 0; i < 8; i++) {
      wr(hl, 0x10);
      hl = (hl+1) & 0xFFFF;
    }
    hl = (hl+0x18) & 0xFFFF;
    charge(7+8*(7+6+13)-5+7+0x18*(6+13)-5+4+10);
  }
  charge(10);
} // clearHudRows

/** drawStageNumber (195Ch) — the round number in decimal at ix and ix-20h */
function drawStageNumber(ix) {
  charge(10+13+7+(rd(0xC030) === 1 ? 10 : 10+6)+7+4+7+10);
  var a = (rd(rd(0xC030) === 1 ? 0xC003 : 0xC004)+1) & 0xFF;
  if (a < 0x0A) {
    charge(19+10);
    wr(ix, a);
    return;
  }
  charge(7);
  var b = 0;
  while (a >= 0x0A) {
    b++;
    a -= 0x0A;
    charge(4+7+7+10);
  }
  charge(19+19+10);
  wr(ix, b);
  wr((ix-0x20) & 0xFFFF, a);
} // drawStageNumber

/**
 * S_1984 — the blink delay of the PLAYER READY screen: 31h x FFh iterations of
 * RST 38h / DEC E / JR NZ, i.e. about 17.3 frames of pure instruction time. The
 * NMI is running throughout, so the game logic keeps ticking behind the text.
 */
var BLINK_DELAY_TSTATES = 4+13+7+48*(7+255*(55+4+12)-5+4+12)+(7+255*(55+4+12)-5+4+7)+4+10;

function* blinkDelay() {
  charge(4+13);
  wr(0xF800, 0);
  charge(BLINK_DELAY_TSTATES-4-13);
  yield 'work';
} // blinkDelay

/**
 * startLife (S_1860h) — brings a player on: clear screen, round registers, both
 * map layers, the HUD, then five flashes of "PLAYER- READY" / "STAGE n".
 */
function* startLife(player) {
  charge(13);
  wr(0xC030, player);
  yield* clearScreensG();
  charge(7+13);
  wr(0xF800, 0x90);
  yield* delayCalls(3);
  charge(17);
  var param = loadStageParam();
  charge(17);
  setVideoRegs(param);
  charge(7+13+7+13+4+13+13+13+13+13+13+13+13+13+13+13+10+7+17);
  wr(0xF800, 0x02);
  wr(0xC310, 1);
  wr(0xC525, 0); wr(0xC523, 0); wr(0xC526, 0);
  wr(0xC006, 0); wr(0xC007, 0); wr(0xC008, 0);
  wr(0xC330, 0); wr(0xC515, 0);
  wr(0xC21C, 0); wr(0xC21D, 0); wr(0xC533, 0);
  fillBytes(0xC220, 0x20, 0);
  charge(55+13+7+10);
  var flip, meter;
  if (rd(0xC030) === 2) {
    charge(55+10+13);
    meter = 0xC290;
    flip = rd(0xC0BD);
  } else {
    charge(7+10+10);
    meter = 0xC280;
    flip = 0;
  }
  charge(55+13+13+7+7+7);
  wr(0xF006, flip);
  wr(0xF007, flip);
  if (rd(meter) === 0xC4) {
    charge(10+10+0x10*LDIR_TSTATES-5);
    for (var i = 0; i < 0x10; i++) {
      wr(meter+i, rd(0x03EB+i));
    }
  }
  charge(17);
  yield* fgLevelInit();
  charge(17);
  yield* bgLevelInit();
  charge(17);
  yield* drawBottomHud();
  charge(4+13+4+13);
  yield 'work';                      // 18E1: the life only counts as running once
  wr(0xC0B9, 0);                     // the HUD above it has been drawn
  wr(0xF001, 1);
  charge(17);
  enemyLevelCalc();
  yield 'work';

  charge(7);
  for (var pass = 0; pass < 5; pass++) {
    // The two attribute writes are watched byte for byte, so they are charged
    // instruction by instruction rather than in one lump: with a lump the write
    // lands up to 70 T from where the original puts it, which is enough to fall
    // into the neighbouring frame when it happens near a frame boundary.
    charge(11+7+13);                           // 18EE-18F1
    wr(0xC119, 0);
    charge(13);                                // 18F4
    wr(0xC11D, 0);
    charge(13+4+10+13+7+10);                   // 18F7-1903
    var b = rd(0xC030);
    var de = 0x5560;                           // txtPlayerReady
    if (rd(0xC500) !== 0) {
      de = 0x4540;                             // txtTestPlay (dead in this ROM)
      b = 0x10;
      charge(10+7+10);                         // 1906-190B
    } else {
      charge(10);                              // 190E LD DE,txtPlayerReady
    }
    charge(17);
    drawText32(0xD00C, de);
    charge(4+13+10+10+17);
    wr(0xD1EC, b);
    drawText32(0xD00E, 0x4520);                // txtStage
    charge(14+17);
    drawStageNumber(0xD1AE);
    charge(17);
    yield* blinkDelay();
    charge(4+7+13);                            // 192B-192E
    wr(0xC119, 2);
    charge(13);                                // 1931
    wr(0xC11D, 2);
    charge(10+10+17);                          // 1934-193A
    drawText32(0xD00C, 0x6600);
    charge(10+10+17);
    drawText32(0xD00E, 0x6600);
    charge(17);
    yield* blinkDelay();
    charge(4+10+13);
  }
  charge(-5+7+13+13+7+13+4+10);
  wr(0xC11D, 2);
  wr(0xD81D, 2);
  wr(0xF800, 0);
  yield 'work';
} // startLife

// ---------------------------------------------------------------- game over
/** highScoreCheck (S_1A08h) — where the player's score lands in the table */
function* highScoreCheck() {
  var b = rd(0xC0B3) === 1 ? 0x0A : 0x0B;
  charge(13+7+10+7+10);
  for (var c = 0; c < 5; c++) {
    charge(7+17+4+7+10);
    if (compareScores(b, c) === 1) {
      charge(4+13+17);
      wr(0xC0B4, c);
      yield* nameEntry();
      // 1A32: insert the new entry and shift the rest down
      var hl = 0xC031+6*c;
      charge(10+10+c*(4+7+10+11+4+10)+4+7+10);
      for (var i = 0; i < 6; i++) {
        wr(0xC05B+i, rd(hl+i));                // hsTempA
      }
      var src = rd(0xC0B3) === 1 ? 0xC06D : 0xC073;
      charge(11+10+10+6*LDIR_TSTATES-5+10+13+7+10+10+4+10+6*LDIR_TSTATES-5);
      for (i = 0; i < 6; i++) {
        wr(hl+i, rd(src+i));
      }
      var rank = rd(0xC0B4);
      var nh = 0xC200+4*rank;
      charge(13+10+10+rank*(7+10+11+4+10)+7+10);
      for (i = 0; i < 4; i++) {
        wr(0xC214+i, rd(nh+i));                // nameTemp
        wr(nh+i, rd(0xC218+i));                // nameNew
      }
      charge(11+10+10+4*LDIR_TSTATES-5+10+10+4+10+4*LDIR_TSTATES-5);
      // hsShiftDown 1A8Ah
      for (;;) {
        var r = rd(0xC0B4);
        charge(13+7+10);
        if (r === 4) {
          charge(10);
          return;
        }
        r = (r+1) & 0xFF;
        wr(0xC0B4, r);
        var dst = 0xC031+6*r;
        charge(4+13+4+10+10+r*(4+7+10+11+4+10)+4+7+10);
        for (i = 0; i < 6; i++) {
          var t = rd(dst+i);
          wr(dst+i, rd(0xC05B+i));
          wr(0xC05B+i, t);
        }
        charge(11+10+10+6*LDIR_TSTATES-5+10+10+4+10+6*LDIR_TSTATES-5+10+10+10+6*LDIR_TSTATES-5);
        var nd = 0xC200+4*r;
        charge(13+4+10+10+r*(4+7+10+11+4+10)+4+7+10);
        for (i = 0; i < 4; i++) {
          var n = rd(nd+i);
          wr(nd+i, rd(0xC218+i));
          wr(0xC218+i, n);
        }
        charge(11+10+10+4*LDIR_TSTATES-5+10+10+4+10+4*LDIR_TSTATES-5+10+10+10+4*LDIR_TSTATES-5+10);
      }
    }
    charge(4+4+7+10);
  }
  charge(10);
} // highScoreCheck

/** drawNameEntryScreen (1C6Ch) — the INPUT YOUR INITIAL screen */
function* drawNameEntryScreen() {
  yield* clearScreensG();
  charge(14+19+19+19+19+19+4+7+13+13+7);
  wr(0xF001, 1); wr(0xF002, 0); wr(0xF003, 1); wr(0xF004, 1); wr(0xF005, 1);
  wr(0xC101, 7);
  wr(0xC103, 7);
  charge(10+0x20*(10+6+10+6+4+13)-5);
  for (var i = 0; i < 0x20; i++) {
    wr(0xC160+2*i, 0);
    wr(0xC161+2*i, 2);
  }
  charge(10+10+17);
  drawText32(0xD000, 0x5480);
  charge(17);
  yield* drawScores();
  charge(10+10+7+4);
  var de = 0xE3E0;
  for (i = 0; i < 0x20; i++) {
    yield* pay(55+10+0x20*LDIR_TSTATES-5+7+0x40*(6+13)-5+4+10);
    for (var j = 0; j < 0x20; j++) {
      wr(de+j, rd(0x7000+0x20*i+j));
    }
    de = (de-0x20) & 0xFFFF;
  }
  charge(4+13+10+10+17);
  wr(0xC121, 0);
  drawText32(0xD010, 0x45A0);
  charge(4+13+10+10+17);
  wr(0xC125, 0);
  drawText32(0xD012, 0x45C0);
  charge(4+13+10+10+17);
  wr(0xC129, 0);
  drawText32(0xD014, 0x45E0);
  charge(13+4+13+7+13+7+14+19+19+19+10);
  wr(0xD1D2, (rd(0xC0B4)+1) & 0xFF);
  wr(0xC12D, 7);
  wr(0xD237, 0x35);
  wr(0xD217, 0x35);
  wr(0xD1F7, 0x35);
  yield 'work';
} // drawNameEntryScreen

/** nameEntry (1AFEh) — three initials, joystick to pick a letter, fire to take it */
function* nameEntry() {
  charge(11+17);
  yield* drawNameEntryScreen();
  charge(4+13+13+7+13+7+10+7+17);
  wr(0xC008, 0);
  wr(0xC009, 0);
  wr(0xF800, 0x06);
  fillBytes(0xC214, 8, 0x10);
  charge(10+10+7+7);
  var hl = 0xC218, de = 0xD236;
  wr(de, 0x11);
  var p2 = rd(0xC0BD) !== 0 && rd(0xC0B3) === 2;
  charge(7+13+7+10+(p2 ? 13+7+10 : 0));
  for (var b = 3; b > 0; b--) {
    for (;;) {
      yield* delayCalls(2);
      charge(4+4+13+7+10);
      if ((rd(0xC0A0) & 0x0F) === 0) {
        charge(13+4+13);
        wr(0xC009, (rd(0xC009)+1) & 0xFF);
      }
      charge(4+13+7+10);
      if (rd(0xC009) >= 0x20) {
        charge(7+13+17+10+10);
        wr(0xF800, 0x90);
        yield* delayCalls(1);
        return;
      }
      charge(4+13+8+10+13+8+10+13+8+10);
      var in1v = rd(0xF018);
      if (in1v & (p2 ? 0x04 : 0x01)) {
        yield* nameLetterStep(de, 1);
      }
      in1v = rd(0xF018);
      if (in1v & (p2 ? 0x08 : 0x02)) {
        yield* nameLetterStep(de, -1);
      }
      var fireBit = p2 ? 0x80 : 0x40;
      if ((rd(0xF010) & fireBit) === 0) {
        charge(4+13);
        wr(0xC008, 0);
      }
      charge(4+13+7+10);
      if (rd(0xC008) === 1) {
        continue;
      }
      charge(13+8+10);
      if ((rd(0xF010) & fireBit) === 0) {
        continue;
      }
      charge(7+13);
      wr(0xC008, 1);
      yield* delayCalls(2);
      charge(7+7+7+0x20*(6+4+10)-5+6+4);
      wr(hl, rd(de));
      de = (de-0x20) & 0xFFFF;
      hl = (hl+1) & 0xFFFF;
      yield* delayCalls(4);
      charge(4+4+13);
      break;
    }
  }
  charge(7+13+17+10+10);
  wr(0xF800, 0x90);
  yield* delayCalls(1);
} // nameEntry

/** nameLetterNext (1C3Dh) / nameLetterPrev (1C55h) */
function* nameLetterStep(de, dir) {
  yield* delayCalls(2);
  charge(7+4+7+10+7+7);
  var a = (rd(de)+dir) & 0xFF;
  if (dir > 0) {
    if (a >= 0x2D) { a = 0x10; }
  } else {
    if (a < 0x10) { a = 0x2C; }
  }
  wr(de, a);
  yield* delayCalls(2);
  charge(10);
} // nameLetterStep

/**
 * gameOverPlayer (S_1995h) — "PLAYER- GAME OVER", the high-score entry and then
 * about 160 delay loops with the coin input still live.
 */
function* gameOverPlayer(player) {
  charge(13+7+13);
  wr(0xC0B3, player);
  wr(0xF800, 0x90);
  yield* delayCalls(3);
  charge(7+13);
  wr(0xF800, 0x04);
  yield* clearScreensG();
  charge(7+13+13+7+10);
  wr(0xF001, 1);
  var flip = 0;
  if (rd(0xC0B3) === 2) {
    charge(13);
    flip = rd(0xC0BD);
  } else {
    charge(7+10);
  }
  charge(13+13+7+13+13+17);
  wr(0xF006, flip);
  wr(0xF007, flip);
  wr(0xC11F, 0);
  wr(0xD81F, 0);
  yield* highScoreCheck();
  yield* clearScreensG();
  charge(13+10+10+17+13+7);
  drawText32(0xD00F, 0x5540);
  wr(0xD22F, rd(0xC0B3));
  for (var b = 0; b < 0x0A; b++) {
    charge(7);
    for (var c = 0; c < 0x10; c++) {
      charge(11+17);
      coinInput();
      yield* delayCalls(1);
      charge(4+13+10+4+4+10);
    }
    charge(-5+13);
  }
  charge(-5+4+13+13+13+13+10);
  wr(0xF005, 0);
  wr(0xF006, 0);
  wr(0xF007, 0);
  wr(0xF800, 0);
} // gameOverPlayer
// ---------------------------------------------------------------- scoring
/** addScore (16B7h) — b times ten points, then the high score and the extends */
function* addScore(b) {
  charge(11+11+11+11+15+15);
  // L_16BF: the whole head of the loop (the B test, the game-state test and the
  // player test) runs again for every ten points, and the digit chain 16F4h is
  // walked in the same turn. The transcription used to charge nothing at all for
  // this, which is why every pass of the game loop came out about 38 T short
  // (21 T of the loop head here, 17 T in the player branch below): measured with
  // tools/refemu against the call at 2E8Bh, 14331 T against the worker's 14322.
  for (;;) {
    yield 'work';                              // one turn of L_16BF per ten points
    charge(4+7+10);                            // 16BF LD A,B / 16C0 CP 00h / 16C2 JP Z
    if (b === 0) {
      break;
    }
    charge(13+7+10);                           // 16C5-16CA the game state
    if (rd(0xC0A2) !== 5) {
      break;
    }
    charge(13+7+10);                           // 16CD-16D2 the current player
    var p = rd(0xC030);
    var ix;
    if (p === 1) {
      charge(14+10);                           // 16E2 LD IX,scoreP1 / 16E6 JP
      ix = 0xC06D;
    } else {
      charge(7+10);                            // 16D5 CP 02h / 16D7 JP Z
      if (p === 2) {
        charge(14+10);                         // 16E9 LD IX,scoreP2 / 16ED JP
        ix = 0xC073;
      } else {
        charge(7+10);                          // 16DA CP 03h / 16DC JP Z
        if (p !== 3) {
          charge(10);                          // 16DF JP scoreUpdateHighAndExtend
          break;
        }
        charge(14);                            // 16F0 LD IX,scoreSlot3 (falls through)
        ix = 0xC08B;
      }
    }
    for (var d = 0; d < 6; d++) {
      charge(19+4+7+10);                       // LD A,(IX+d) / INC A / CP 0Ah / JP Z
      var v = (rd(ix+d)+1) & 0xFF;
      if (v !== 0x0A) {
        charge(19+10);                         // LD (IX+d),A / JP L_1766
        wr(ix+d, v);
        break;
      }
      charge(19);                              // LD (IX+d),00h, carry into the next digit
      wr(ix+d, 0);
    }
    charge(4+10);                              // 1766 DEC B / 1767 JP L_16BF
    b--;
  }
  // scoreUpdateHighAndExtend 176Ah
  charge(4+13+7+10);
  var pl = rd(0xC030);
  if (pl === 1) {
    charge(7+10+10);                           // 177B LD B,0Ah / 177D LD HL / 1780 JP
  } else {
    charge(7+10);                              // 1773 CP 02h / 1775 JP Z
    if (pl === 2) {
      charge(7+10);                            // 1783 LD B,0Bh / 1785 LD HL,scoreP2
    } else {
      charge(10);                              // 1778 JP L_179B
    }
  }
  if (pl === 1 || pl === 2) {
    charge(7+17+4+7+10);                       // 1788 LD C,0Ch / 178A CALL / 178D-1790
    if (compareScores(pl === 1 ? 0x0A : 0x0B, 0x0C) !== 0) {
      charge(10+10+6*LDIR_TSTATES-5);
      var src = pl === 1 ? 0xC06D : 0xC073;
      for (var i = 0; i < 6; i++) {
        wr(0xC079+i, rd(src+i));
      }
    }
  }
  charge(17);
  yield* drawScore();
  charge(17);
  checkExtend();
  charge(14+14+10+10+10+10+10);
} // addScore

/** checkExtend (17ABh) — the two bonus lives */
function checkExtend() {
  // A conditional RET costs 5 T when it is not taken and 11 T when it is, and the
  // three tests here are all normally not taken. Charging 11 T flat made the
  // routine 29 T too dear on every pass of the game loop (measured: refemu
  // 2975 T for the call at 179Eh against the worker's 3004 T).
  charge(13+7+5);                              // 17AB-17B0, RET Z not taken
  if (rd(0xC0A9) === 0) {
    charge(6);                                 // 17B0 RET Z taken
    return;
  }
  charge(13+7+10);                             // 17B1 LD A,(curPlayer) / 17B4 CP / 17B6 JP Z
  var p = rd(0xC030);
  if (p !== 1) {
    charge(7+10);                              // 17B9 CP 02h / 17BB JP Z
    if (p !== 2) {
      charge(10);                              // 17BE RET
      return;
    }
  }
  var cntAddr = p === 1 ? 0xC0BE : 0xC0BF;
  var livesAddr = p === 1 ? 0xC0B1 : 0xC0B2;
  var b = p === 1 ? 0x0A : 0x0B;
  charge(13+7+5);                              // 17BF-17C4, RET Z not taken
  var n = rd(cntAddr);
  if (n === 2) {
    charge(6);                                 // 17C4 RET Z taken
    return;
  }
  charge(7+10);                                // 17C5 CP 01h / 17C7 JP Z
  if (n !== 1) {
    charge(7+7+17+4+7+5);
    if (compareScores(b, 0x0D) !== 1) {
      charge(6);
      return;
    }
    charge(13+4+13+7+13+7+13);
    wr(livesAddr, (rd(livesAddr)+1) & 0xFF);
    wr(0xF800, 0x22);
    wr(cntAddr, 1);
  }
  charge(7+7+17+4+7+5);
  if (compareScores(b, 0x0E) !== 1) {
    charge(6);
    return;
  }
  charge(13+4+13+7+13+7+13+10);
  wr(livesAddr, (rd(livesAddr)+1) & 0xFF);
  wr(0xF800, 0x22);
  wr(cntAddr, 2);
} // checkExtend

/** flushPendingScore (2E1Eh) */
function* flushPendingScore() {
  charge(13+4+4+13+17+10);
  var b = rd(0xC330);
  wr(0xC330, 0);
  yield* addScore(b);
} // flushPendingScore

/**
 * spriteSlotPointers (281Eh) — the record and the sprite shadow of two slots.
 * Slots 0..7 are the "set 1" objects (records C220h+2n, shadows C140h+4n),
 * slots 8..0Dh the "set 0" ones (records C230h+2n, shadows C1A0h+4n). The
 * original returns them in HL/IX (slot b) and DE/IY (slot c) — the low byte of
 * HL and DE is itself tested later on, so both are kept as full addresses.
 */
function spriteSlotPointers(b, c) {
  // 281E-2876: the two pointer pairs are walked one slot at a time, and both
  // walks kick the watchdog (RST 38h) on every step — this is where most of the
  // time of a collision test goes.
  var i;
  charge(10+10+4+7+55);
  charge(b < 8 ? 7+14+55+12 : 12+7+14+10);
  for (i = (b < 8 ? b : b-8); i > 0; i--) charge(7+7+55+6+6+40+4+10);
  charge(7+12+4+7+10);
  charge(c < 8 ? 14+10 : 7+14+10);
  for (i = (c < 8 ? c : c-8); i > 0; i--) charge(55+7+7+6+6+40+4+10);
  charge(55+7+12+10);
  return {
    hl: b < 8 ? 0xC220+2*b : 0xC230+2*(b-8),
    ix: b < 8 ? 0xC140+4*b : 0xC1A0+4*(b-8),
    de: c < 8 ? 0xC220+2*c : 0xC230+2*(c-8),
    iy: c < 8 ? 0xC140+4*c : 0xC1A0+4*(c-8)
  };
} // spriteSlotPointers

/** spriteSizeLookup (295Fh) — 4300h[code]; ADD A,L never carries into H. */
function spriteSizeLookup(a) {
  // 295F LD HL,4300h 10 + ADD A,L 4 + LD L,A 4 + LD A,(HL) 7 + RET 10; the body
  // was never charged, so every collision test was 35 T per operand short
  charge(10+4+4+7+10);
  return rd(0x4300+(a & 0xFF));
} // spriteSizeLookup

/**
 * spriteCollide (2877h) — 1 when slot b and slot c overlap. Both boxes have to
 * be smaller than both radii (4300h[code]), which is how a big sprite still
 * only collides over the small one's area. Slot 6 (Bongo) and altitude zone 3
 * (inside the fortress) add the sprite-code windows 85h-87h and E5h-EAh.
 */
function spriteCollide(b, c) {
  // Every rejection jumps to L_2956 (XOR A) and leaves through the five POPs
  // and the RET: 4 + 14 + 14 + 10 + 10 + 10 + 10 = 72 T, not the 54 T the
  // transcription used to charge (it was missing the XOR A and one POP IY/IX).
  var exit = 4+14+14+10+10+10+10;
  charge(11+11+11+15+15+17);                         // 2877-287E
  var p = spriteSlotPointers(b, c);
  charge(7+7+10);                                    // 2881-2884
  var hl = p.hl, de = p.de, ix = p.ix, iy = p.iy;
  var a = rd(hl);
  if (a === 0) { charge(exit); return 0; }
  a = rd(de);
  charge(7+7+10);                                    // 2887-288A
  if (a === 0x00) { charge(exit); return 0; }
  charge(7+10);                                      // 288D-288F
  if (a === 0x2F) { charge(exit); return 0; }
  charge(7+10);                                      // 2892-2894
  if (a === 0x3F) { charge(exit); return 0; }
  charge(7+10);                                      // 2897-2899
  if (a === 0x52) { charge(exit); return 0; }
  charge(4+7+10);                                    // 289C-289F
  if ((hl & 0xFF) === 0x2C) {                        // 289Ch: b is Bongo
    charge(13+7+10);                                 // 28A2-28A7
    if (rd(0xC22C) < 0x80) {
      var s = rd(iy+1);
      charge(19+7+10);                               // 28AA-28AF
      if (s < 0x85) { charge(exit); return 0; }
      charge(7+10);                                  // 28B2-28B4
      if (s >= 0x88) {                               // s < 88h -> L_28C4
        charge(7+10);                                // 28B7-28B9
        if (s < 0xE5) { charge(exit); return 0; }
        charge(7+10);                                // 28BC-28BE
        if (s >= 0xEB) { charge(10+exit); return 0; }  // 28C1 JP L_2956
      }
    }
  }
  // L_28C4
  charge(4+7+10);                                    // 28C4-28C7
  if ((hl & 0xFF) !== 0x2C) {
    var s2 = rd(iy+1);
    charge(19+7+7+10);                               // 28CA-28D1
    if (((s2-0xA0) & 0xFF) < 8) { charge(exit); return 0; }
    var zone = rd(0xC310);
    charge(13+7+10);                                 // 28D4-28D9
    if (zone === 3) {                                // 28D4h: inside the fortress
      charge(4+7+10);                                // 28DC-28DF
      if ((de & 0xFF) >= 0x30) { charge(exit); return 0; }
      var s3 = rd(iy+1);
      charge(19+7+10);                               // 28E2-28E7
      if (s3 < 0x85) { charge(exit); return 0; }
      charge(7+(s3 < 0x88 ? 12 : 7));                // 28EA-28EC JR C,L_28F8
      if (s3 >= 0x88) {
        charge(7+10);                                // 28EE-28F0
        if (s3 < 0xE5) { charge(exit); return 0; }
        charge(7+10);                                // 28F3-28F5
        if (s3 >= 0xEB) { charge(exit); return 0; }
      }
    }
  }
  // L_28F8: the two boxes
  charge(19+17+4+19+7+10);                           // 28F8-2904 (the CALL body
  var d = spriteSizeLookup(rd(ix+1));                // is charged by the routine)
  var e;
  if (rd(ix+1) === 0xBE) {                           // 2902h: the big saucer
    charge(19+7+10+7+10+7+10);
    var t = rd(iy+1);
    if (t === 0xD4 || t === 0x98 || t === 0x99) {
      charge(4+4+10);
      e = 0;
    } else {
      charge(19+17+4);
      e = spriteSizeLookup(t);
    }
  } else {
    charge(19+17+4);                                 // 291E-2924
    e = spriteSizeLookup(rd(iy+1));
  }
  var av = rd(ix+0), bv = rd(iy+0), tmp;
  charge(19+19+4+10);                                // 2925-292C
  if (av < bv) { charge(4+4+4); tmp = av; av = bv; bv = tmp; }   // 292F-2931
  av = (av-bv) & 0xFF;
  charge(4+4+10);                                    // 2932-2934
  if (av >= d) { charge(exit); return 0; }
  charge(4+10);                                      // 2937-2938
  if (av >= e) { charge(exit); return 0; }
  av = rd(ix+3); bv = rd(iy+3);
  charge(19+19+4+10);                                // 293B-2942
  if (av < bv) { charge(4+4+4); tmp = av; av = bv; bv = tmp; }   // 2945-2947
  av = (av-bv) & 0xFF;
  charge(4+4+10);                                    // 2948-294A
  if (av >= d) { charge(exit); return 0; }
  charge(4+10);                                      // 294D-294E
  if (av >= e) { charge(exit); return 0; }
  charge(7+55+12+14+14+10+10+10+10);                 // 2951-2954 and L_2957
  return 1;
} // spriteCollide

/** shipVsEnemies (2B91h) — the ship against sprites 2-5 of set 1 and 0-5 of set 0 */
function* shipVsEnemies() {
  // The scan is 11.5k T long, more than half of the foreground time a frame has
  // left after the NMI, so the original is regularly interrupted in the middle
  // of it: the slots it looks at after the interruption see the object records
  // the NMI has just written. Settling between slots is what lets that happen
  // here too -- run as one lump, the ten slots all saw the records of the frame
  // the call started in, and the scan came out 1736 T (four B slots that had
  // just been spawned) cheaper than the original for one pass in every burst of
  // spawns: refemu 13308 T against the worker's 11572 T at playFrameCounter 13
  // of sources/reference/input-play.txt, where C234h-C23Bh fill up in frame 645
  // while the call is running.
  charge(7+7);                                     // 2B91-2B93
  for (var c = 2; c < 6; c++) {
    yield 'work';
    charge(17+7+10);                               // 2B95 CALL / 2B98 CP / 2B9A JP Z
    if (spriteCollide(0, c) === 1) {
      // 2BC8 LD (lifeOver),A. Settling first is what keeps the store in the
      // frame the original makes it in: measured with profile.mjs
      // --write-at C0B9 on sources/reference/input-play.txt, the original
      // stores 01h at frame 696 T+37686 while the worker, charging and storing
      // in one go, still had 1429 T of debt outstanding and stored it in 695.
      charge(13+4+13+10);
      yield 'work';
      wr(0xC0B9, 1);                               // shipKilled 2BC8h
      wr(0xC030, 0);
      return;
    }
    charge(4+4+7+10);                              // 2B9D INC C / 2B9E / 2B9F / 2BA1
  }
  charge(7);                                       // 2BA4 LD C,08h
  for (c = 8; c < 0x0E; c++) {
    yield 'work';
    charge(17+7+10);                               // 2BA6 CALL / 2BA9 CP / 2BAB JP Z
    if (spriteCollide(0, c) === 1) {
      charge(13+4+13+10);
      yield 'work';                                // as above, 2BC8h
      wr(0xC0B9, 1);
      wr(0xC030, 0);
      return;
    }
    charge(4+4+7+10);                              // 2BAE-2BB2
  }
  // 2BBA RET NZ: 11 T when taken (bongoState is not A0h, which is the usual
  // case), 5 T when not. The flat 5 T left every pass of the game loop 6 T short
  // (measured: refemu 14176 T for the call at 2E8Eh against the worker's 14170).
  charge(13+7+5);
  if (rd(0xC22C) !== 0xA0) {
    charge(6);                                     // 2BBA RET NZ taken
    return;
  }
  charge(7+17+7+5);                                // 2BBB LD C,06h / 2BBD CALL / 2BC0 / 2BC2
  if (spriteCollide(0, 6) === 1) {
    charge(13+10);                                 // 2BC3 LD (C523),A / 2BC6 RET
    wr(0xC523, 1);
  } else {
    charge(6);                                     // 2BC2 RET NZ taken
  }
} // shipVsEnemies

/**
 * shot1VsEnemies (2BD0h) and its three siblings 2BFBh/2C06h/2C11h. Shot 1 is
 * live for any non-zero state, the other three only for state 1; the loop body
 * (L_2BD8) is shared.
 */
function* shotVsEnemies(stateAddr, b, wantOne) {
  // 2BD5 RET Z (2C00/2C0B/2C16 RET NZ) is 11 T when it returns and 5 T when it
  // does not, and the entries other than shot 1 then run LD B,nn + JP L_2BD8
  // (17 T) that were never charged.
  var st = rd(stateAddr);
  var go = wantOne ? st === 1 : st !== 0;
  charge(13+7+(go ? 5+(wantOne ? 7+10 : 7) : 11));
  if (!go) {
    return;
  }
  // The ten slots are settled one at a time, exactly like shipVsEnemies 2B91h:
  // the scan is long enough to run over the end of a frame, and the slots after
  // the break must see the records the NMI wrote in between.
  // 2BDF JP Z,shotHitEnemy leaves the loop, so 2BE2-2BE6 (INC C / LD A,C /
  // CP 06h / JP C = 25 T) do NOT run on a hit; charging them flat made every
  // hit 25 T too dear -- the same slip that was already fixed at 2B9Dh.
  charge(7);                                       // 2BD8 LD C,02h
  for (var c = 2; c < 6; c++) {
    yield 'work';
    charge(17+7+10);                               // 2BDA CALL / 2BDD CP / 2BDF JP Z
    if (spriteCollide(b, c) === 1) {
      yield* shotHitEnemy(b, c);
      return;
    }
    charge(4+4+7+10);                              // 2BE2-2BE6
  }
  charge(7);                                       // 2BE9 LD C,08h
  for (c = 8; c < 0x0E; c++) {
    yield 'work';
    charge(17+7+10);                               // 2BEB CALL / 2BEE CP / 2BF0 JP Z
    if (spriteCollide(b, c) === 1) {
      yield* shotHitEnemy(b, c);
      return;
    }
    charge(4+4+7+10);                              // 2BF3-2BF7
  }
  charge(10);
} // shotVsEnemies

/**
 * shotHitEnemy (2C1Ch) — the shot in slot b has hit the object in slot c. The
 * NMI is off for the whole of it (the shot and the object are rewritten), and
 * on the two "indestructible core" types 4Dh/4Eh the original really does
 * return with it still off; the play loop turns it back on at 2E45h.
 */
function* shotHitEnemy(b, c) {
  // Settled twice, because the hit regularly falls on the last few hundred
  // T-states of a frame: 2C1D turns the NMI off, and whether the next frame has
  // an NMI at all depends on which side of the frame boundary that store lands
  // on; the record and sprite stores that follow then belong to the frame after
  // it. Measured with profile.mjs --write-at C226/C330/C144 on the --random 4
  // script, where the original writes the burst at frame 662 T+184..293 and the
  // worker, charging and storing in one go, wrote it in frame 661.
  charge(4+13);                                      // 2C1C-2C1D
  yield 'work';
  wr(0xF001, 0);
  charge(17);                                        // 2C20 CALL spriteSlotPointers
  var p = spriteSlotPointers(b, c);
  var hl = p.hl, de = p.de, ix = p.ix, iy = p.iy;
  charge(10);                                        // 2C23 LD (HL),00h
  yield 'work';
  wr(hl, 0);                                         // the shot is gone
  charge(7+7);                                       // 2C25-2C26
  var a = rd(de);
  charge(24*7+24*10);
  yield 'work';                                      // settle the chain of tests
  if (a === 0x45) { wr(de, 0x19); shotHitScore(de, ix, iy); return; }
  if (a === 0x50 || a === 0x51) { vacuumSphereHit(hl, de, ix, iy); return; }
  if (a === 0x53 || a === 0x54 || a === 0x55 || a === 0x56 || a === 0x57 ||
      a === 0x40 || a === 0x43) { eyeballHit(hl, de, ix, iy); return; }
  if (a === 0x3C) { wr(de, 0x3D); shotHitScore(de, ix, iy); return; }
  if (a === 0x4A || a === 0x3E || a === 0x4B) { shotHitSpecial2000(de, ix); return; }
  if (a === 0x58 || a === 0x59) { yield* shotHitBigTarget(a, hl, ix); return; }
  if (a === 0x5A) { wr(de, 0x5B); shotHitScore(de, ix, iy); return; }
  if (a === 0x4D || a === 0x4E) { return; }          // 2C7Dh: NMI_EN stays 0
  if (a < 0x28) { wr(de, 0x2F); shotHitScore(de, ix, iy); return; }
  if (a < 0x2F) { wr(de, 0x3F); shotHitScore(de, ix, iy); return; }
  wr(de, 0x2F);
  shotHitScore(de, ix, iy);
} // shotHitEnemy

/** shotHitScore (2C8Eh) — 4300h[code-80h] units of ten points */
function shotHitScore(de, ix, iy) {
  charge(19+10+7+4+4+7);
  addPendingScore(rd(0x4300+((rd(iy+1)-0x80) & 0xFF)), de, ix);
} // shotHitScore

/** addPendingScore (2C99h) — pendingScore += a, then the shot's shadow is cleared */
function addPendingScore(a, de, ix) {
  charge(4+13+4+13+4+6+7+19+19+19+19+7+13+10);
  wr(0xC330, (rd(0xC330)+a) & 0xFF);
  wr(de+1, 0);
  wr(ix+0, 0); wr(ix+1, 0); wr(ix+2, 0); wr(ix+3, 0);
  wr(0xF001, 1);
} // addPendingScore

/** shotHitBigTarget (2CB6h) — the rock: 18h of damage, 320 points */
function* shotHitBigTarget(a, hl, ix) {
  charge(13+13+7+13+4+7+19+19+7+17);
  wr(0xF808, a);
  wr(0xC231, (rd(0xC231)+0x18) & 0xFF);
  wr(hl, 0);
  wr(ix+0, 0);
  wr(ix+3, 0);
  yield* addScore(0x20);
  charge(7+13+10);
  wr(0xF001, 1);
} // shotHitBigTarget

/** shotDeflect (2CF3h) — the shot bounces off: state 3 and the ping */
function shotDeflect(hl) {
  charge(10+6+10+7+13+13+7+10);
  wr(hl, 3);
  wr(hl+1, 0);
  wr(0xF001, 1);
  if (rd(0xC0A2) !== 5) {
    return;
  }
  charge(7+13+10);
  wr(0xF800, 0x10);
} // shotDeflect

/** vacuumSphereHit (2CE6h) — the vacuum only dies with its mouth (8Dh) open */
function vacuumSphereHit(hl, de, ix, iy) {
  charge(13+4+13+4+7+10);
  var b = rd(0xC140);
  var a = (rd(0xC1A0)-b) & 0xFF;
  if (a >= 0x20) {
    shotDeflect(hl);
    return;
  }
  charge(13+7+10);
  if (rd(0xC1A1) !== 0x8D) {
    shotDeflect(hl);
    return;
  }
  charge(7+13+4+13+7+10);
  wr(0xC230, 0x52);
  wr(0xC231, 0);
  addPendingScore(0xFF, de, ix);
} // vacuumSphereHit

/** eyeballHit (2D09h) — the closed eye (F4h/F5h) deflects, the open one dies */
function eyeballHit(hl, de, ix, iy) {
  charge(19+7+10+7+10);
  var s = rd(iy+1);
  if (s === 0xF4 || s === 0xF5) {
    shotDeflect(hl);
    return;
  }
  charge(7+7+10);
  wr(de, 0x44);
  shotHitScore(de, ix, iy);
} // eyeballHit

/** shotHitSpecial2000 (2D38h) — the rocket/hatch core: B slots 0 and 1 = 4Dh/4Eh */
function shotHitSpecial2000(de, ix) {
  charge(15+14+19+19+19+19+14+7+13+7+10);
  wr(0xC230, 0x4D);
  wr(0xC231, 0x00);
  wr(0xC232, 0x4E);
  wr(0xC233, 0x00);
  wr(0xF800, 0x22);
  addPendingScore(0xC8, de, ix);
} // shotHitSpecial2000

/** clearPlayerSprites (95F1h) — the shot, Bongo and the rear shot are wiped */
function clearPlayerSprites() {
  charge(4+10+7+17+10+7+17+10+7+17+10+7+17+10);
  fillBytes(0xC144, 4, 0);
  fillBytes(0xC158, 8, 0);
  fillBytes(0xC220, 4, 0);
  fillBytes(0xC22C, 4, 0);
} // clearPlayerSprites

/**
 * bongoVsEnemies (2D5Ah) — Bongo kills by touch. Unlike a shot it does not stop
 * at the first hit: the loop runs all ten slots every frame.
 */
function* bongoVsEnemies() {
  charge(13+7+5);
  if (rd(0xC22C) < 0x80) { charge(6); return; }   // 2D5F RET C is 11 T, not 5
  charge(7+7);                                   // 2D60-2D62 LD B,06h + LD C,02h
  var c;
  for (c = 2; c < 6; c++) {                      // settled per slot, like 2BD0h
    yield 'work';
    charge(17+7+10);
    if (spriteCollide(6, c) === 1) { charge(7); bongoHitEnemy(6, c); }
    charge(4+4+7+10);
  }
  charge(7);
  for (c = 8; c < 0x0E; c++) {
    yield 'work';
    charge(17+7+10);
    if (spriteCollide(6, c) === 1) { charge(7); bongoHitEnemy(6, c); }
    charge(4+4+7+10);
  }
  charge(10);
} // bongoVsEnemies

/**
 * bongoHitEnemy (2D85h) — the object in slot c has been touched. Bongo never
 * clears the enemy's sprite shadow (the 2Fh explosion handler does that), and
 * the two big targets 58h/59h only push bongoTimer to F0h, which sends Bongo
 * home on the next frame.
 */
function bongoHitEnemy(b, c) {
  charge(11+17);
  var p = spriteSlotPointers(b, c);
  var de = p.de, iy = p.iy;
  charge(7);
  var a = rd(de);
  charge(7+10);
  if (a === 0x4A) { bongoHit2000(); return; }
  charge(7+10);
  if (a === 0x4B) { bongoHit2000(); return; }
  charge(7+10);
  if (a === 0x3E) { bongoHit2000(); return; }
  charge(7+10);
  if (a === 0x4D) { charge(10+10); return; }
  charge(7+10);
  if (a === 0x4E) { charge(10+10); return; }
  charge(7+10);
  if (a === 0x2F) { charge(10+10); return; }
  charge(7+10);
  if (a === 0x39) { charge(10+10); return; }
  charge(7+10);
  if (a === 0x50) {
    charge(7+13+4+13+7+13+10+10);                // L_2DEC: the vacuum sphere
    wr(0xC230, 0x52);
    wr(0xC231, 0);
    wr(0xC330, 0xFF);
    return;
  }
  charge(7+10);
  if (a === 0x51) { charge(10+10); return; }
  charge(7+10);
  if (a === 0x52) { charge(10+10); return; }
  charge(7+10);
  if (a === 0x58) { charge(7+13+10+10); wr(0xC22D, 0xF0); return; }
  charge(7+10);
  if (a === 0x59) { charge(7+13+10+10); wr(0xC22D, 0xF0); return; }
  charge(5*4+7+7+4+6+7+19+7+10+4+7+4+13+4+13+10+10);
  wr(de, 0x2F);
  wr(de+1, 0);
  wr(0xC330, (rd(0xC330)+rd(0x4300+((rd(iy+1)-0x80) & 0xFF))) & 0xFF);
} // bongoHitEnemy

/** L_2DFC — types 4Ah/4Bh/3Eh: the rocket core opens and pays 2000 points */
function bongoHit2000() {
  charge(15+14+19+19+19+19+14+13+7+13+10+10);
  wr(0xC230, 0x4D);
  wr(0xC231, 0x00);
  wr(0xC232, 0x4E);
  wr(0xC233, 0x00);
  wr(0xC330, (rd(0xC330)+0xC8) & 0xFF);
} // bongoHit2000

/**
 * shipExplosion (3331h, entered at 3329h) — the ship becomes four sprites
 * (slots 0, 1, 6 and 7 of set 1) and steps through the twelve {code, colour}
 * rows of shipExplosionFrames 55A0h. Each step is three delayLoops, and the
 * wait loop at 3389h fires SND_BOOM (F808h) on every pass; because
 * frameCounterSeen (C0A1h) is never brought up to date the loop only ever spins
 * on the first pass, so the whole thing is 2 + 12*3 delay loops long.
 */
function* shipExplosion() {
  var ix = 0xC140;
  charge(14+19+4+7+19+19+19+19+19+19+4+7+19+19+19+19+19+19+
         19+4+7+19+19+4+7+19+19);
  var b = rd(ix+0);
  var a = (b-8) & 0xFF;
  wr(ix+0, a);
  wr(ix+1, 0xD7); wr(ix+2, 0x07);
  wr(ix+4, a);
  wr(ix+5, 0xD8); wr(ix+6, 0x07);
  a = (b+7) & 0xFF;
  wr(ix+24, a);
  wr(ix+25, 0xD5); wr(ix+26, 0x07);
  wr(ix+28, a);
  wr(ix+29, 0xD6); wr(ix+30, 0x07);
  b = rd(ix+3);
  a = (b-8) & 0xFF;
  wr(ix+3, a);
  wr(ix+27, a);
  a = (b+8) & 0xFF;
  wr(ix+7, a);
  wr(ix+31, a);
  yield* delayCalls(2);                              // 337F/3382
  charge(4+13);
  wr(0xC0D1, 0);
  for (;;) {
    // L_3389: the boom is retriggered on every pass of the wait loop
    for (;;) {
      charge(13+7+10);
      var st = rd(0xC0A2);
      if (st === 5) {
        charge(13);
        wr(0xF808, st);
      }
      charge(13+4+13+4+10);
      if (rd(0xC0A1) !== rd(0xC0A0)) {
        break;
      }
      yield 'work';                                  // 339C jumps back to 3389
    }
    yield* delayCalls(3);                            // 339F/33A2/33A5
    charge(13+8+8+8+10+4+4+7+19+6+7+19+6+7+19+6+7+19+
           6+7+19+6+7+19+6+7+19+6+7+19+13+4+13+7+10);
    var step = rd(0xC0D1);
    var hl = 0x5500|((0xA0+((step << 3) & 0xFF)) & 0xFF);
    wr(ix+1,  rd(hl+0));
    wr(ix+2,  rd(hl+1));
    wr(ix+5,  rd(hl+2));
    wr(ix+6,  rd(hl+3));
    wr(ix+25, rd(hl+4));
    wr(ix+26, rd(hl+5));
    wr(ix+29, rd(hl+6));
    wr(ix+30, rd(hl+7));
    step = (step+1) & 0xFF;
    wr(0xC0D1, step);
    if (step >= 0x0C) {
      break;
    }
  }
  charge(10);
  yield 'work';
} // shipExplosion

// ---------------------------------------------------------------- life loop
/** stageEndSequence (2EE4h) — the end-of-round fly-away; ST-M5 apart from the
 *  1UP blink and the eight-frame gate, which run before anything else */
function stageEndSequence() {
  charge(17);
  blinkUpLabel();
  charge(55+13+7+5);
  if (rd(0xC0A0) & 7) {
    return;
  }
  // 2EEEh onwards: the whole fly-away, box and stage-clear screen — ST-M5
} // stageEndSequence

/** playLifeP1 (S_2E31h) / playLifeP2 (S_33F2h) — one life of one player */
function* playLife(player) {
  var lifeStatus = player === 1 ? 0xC006 : 0xC007;
  var livesAddr = player === 1 ? 0xC0B1 : 0xC0B2;
  var sectionAddr = player === 1 ? 0xC0BB : 0xC0BC;
  charge(7+13+7+13+13+13+13);
  wr(0xF001, 1);
  wr(0xF800, 0);
  wr(0xC0B9, 0);
  wr(0xC0A1, rd(0xC0A0));
  for (;;) {
    // L_2E44: wait for the NMI to move the frame counter on. The original spins
    // in this eight-instruction loop, so it is charged for every turn of it
    // instead of being given away with `yield 'frame'`: the loop runs on into
    // the next frame and the partial turn it is in when the NMI fires decides
    // where in that frame the pass below starts. Giving the rest of the frame
    // away instead put the pass at T-state 0 of the frame every time, about
    // half a turn of the loop (60 T) out.
    var seen;
    for (;;) {
      charge(55+7+13+13+4+13+4+10);              // 2E44-2E52
      wr(0xF001, 1);
      seen = rd(0xC0A0);                         // 2E4D LD B,A latches the counter
      if (rd(0xC0A1) !== seen) {
        break;
      }
      yield 'work';
    }
    // 2E55 LD A,B and 2E56 LD (frameCounterSeen),A. The store has to be settled
    // first, because the NMI falls between the JP at 2E52 and it more often than
    // not: the body of the loop runs over the end of a frame, so the turn that
    // finds the counter changed is the last thing that fits in the frame and the
    // store happens only after the next NMI has run. Measured with
    // profile.mjs --write-at C0A1: play frame 676 stores CCh at T+36707, i.e.
    // right after that frame's NMI, and CCh is the value B latched in frame 675.
    // Charging the 2E59-2E5E test here as well put the write 30 T later than the
    // original makes it.
    charge(4+13);                                // 2E55-2E56
    yield 'work';
    wr(0xC0A1, seen);
    charge(13+7+10);                             // 2E59-2E5E
    if (rd(0xC515) !== 0) {
      charge(10+17+10);
      stageEndSequence();
      continue;
    }
    // The body is long enough to run over the end of a frame, so it is settled
    // in pieces — the original spends its time as it goes and the regression
    // sees each write in the frame the original made it in.
    yield 'work';
    // 2E61 CALL S_34A3 17 + the RET of S_34A3 itself 10 (34A3h is nothing but a
    // RET; its 10 T were missing), then 2E64 CALL blinkUpLabel 17
    charge(17+10+17);
    blinkUpLabel();
    charge(17);
    enemyLevelCalc();
    charge(17);
    yield* drawBottomHud();
    yield 'work';
    charge(4+16+4+4+7+10+16);                  // 2E6D-2E79 (2E71 INC L is 4 T)
    var pf = (rd16(0xC21C)+1) & 0xFFFF;
    if ((pf & 0xFF) === 0) {
      charge(4);
    }
    wr16(0xC21C, pf);
    charge(17);
    yield* shotVsEnemies(0xC222, 1, false);     // shot1VsEnemies 2BD0h
    yield 'work';
    charge(17);
    yield* shotVsEnemies(0xC23E, 15, true);     // shot2VsEnemies 2BFBh
    charge(17);
    yield* bongoVsEnemies();                    // bongoVsEnemies 2D5Ah
    charge(17);
    yield* shotVsEnemies(0xC22E, 7, true);      // rearShotVsEnemies 2C06h
    charge(17);
    yield* shotVsEnemies(0xC23C, 14, true);     // shot3VsEnemies 2C11h
    yield 'work';
    charge(17);
    yield* flushPendingScore();
    yield 'work';
    charge(17);
    yield* shipVsEnemies();
    charge(4+13+7+10);
    if (rd(lifeStatus) !== 3) {
      charge(13+7+10);
      if ((rd(0xC21C) & 0x3F) === 0) {
        charge(13+7+10+7+10+13);
        wr(0xF800, rd(sectionAddr) === 0x1F ? 0x0A : 0x20);
      }
    }
    charge(13+7+10);
    if (rd(0xC0B9) === 1) {
      break;
    }
    yield 'work';
  }
  // 2EBCh: the ship is gone
  charge(17);
  clearPlayerSprites();                        // 2EBC S_95F1
  charge(17);
  yield* shipExplosion();                      // 2EBF S_3329
  charge(4+4+13+13+13+13+13+4+13+10);
  wr(0xC001, 0);
  wr(0xF800, 0);
  wr(0xC0D0, 0);
  wr(0xC0D1, 0);
  wr(lifeStatus, 0);
  wr(livesAddr, (rd(livesAddr)-1) & 0xFF);
  yield 'work';
} // playLife

/** gameLoop1P (L_2AD5h) */
function* gameLoop1P() {
  for (;;) {
    charge(55+7+17);
    yield* startLife(1);
    charge(17);
    yield* playLife(1);
    charge(13+7+10);
    if (rd(0xC0B1) === 0) {
      break;
    }
  }
  charge(7+17);
  yield* gameOverPlayer(1);
  charge(7+13+10);
  wr(0xF005, 0);
} // gameLoop1P

/** gameLoop2P (L_2AF3h) — the same, alternating the two players after each life */
function* gameLoop2P() {
  for (;;) {
    charge(55+7+17);
    yield* startLife(1);
    charge(17);
    yield* playLife(1);
    charge(13+7+10);
    if (rd(0xC0B1) === 0) {
      // gameOverP1ContinueP2 2B25h
      charge(55+7+17);
      yield* gameOverPlayer(1);
      for (;;) {
        charge(55+7+17);
        yield* startLife(2);
        charge(17);
        yield* playLife(2);
        charge(13+7+10);
        if (rd(0xC0B2) === 0) {
          break;
        }
      }
      break;
    }
    charge(7+17);
    yield* startLife(2);
    charge(17);
    yield* playLife(2);
    charge(13+7+10);
    if (rd(0xC0B2) === 0) {
      break;
    }
  }
  // gameOver2P 2B14h
  charge(55+7+17);
  yield* gameOverPlayer(2);
  charge(13+7+10);
  if (rd(0xC0B1) !== 0) {
    yield* gameLoop1P();
  }
} // gameLoop2P

/** clearScores (2B3Fh) */
function clearScores() {
  charge(4+10+7+17+10);
  fillBytes(0xC06D, 0x0C, 0);
} // clearScores

/** start1P (2A85h) */
function start1P() {
  charge(55+13+4+13+13+17+4+13+13+7+13+13+13+7+13+10);
  var credits = (rd(0xC0AC)-1) & 0xFF;
  wr(0xC0AC, credits);
  wr(0xD05F, credits);
  clearScores();
  wr(0xC0B2, 0);
  wr(0xC2A1, 0);
  wr(0xC0AA, 1);
  wr(0xC0B1, rd(0xC0A8));
  wr(0xC2A0, 2);
} // start1P

/** start2P (2AADh) */
function start2P() {
  charge(55+13+4+4+13+13+17+7+13+13+13+13+7+13+13+10);
  var credits = (rd(0xC0AC)-2) & 0xFF;
  wr(0xC0AC, credits);
  wr(0xD05F, credits);
  clearScores();
  wr(0xC0AA, 2);
  wr(0xC0B1, rd(0xC0A8));
  wr(0xC0B2, rd(0xC0A8));
  wr(0xC2A0, 2);
  wr(0xC2A1, 2);
} // start2P

/**
 * pushStartScreen (L_296Bh) — the title with PUSH ... BUTTON over it. The wait
 * loop is not synchronised with the NMI: it redraws the text and polls IN0 as
 * fast as it can, about twice a frame.
 */
function* pushStartScreen() {
  for (;;) {
    charge(55+7+13+13+7+10);
    wr(0xF800, 0x90);
    if (rd(0xC0AC) < 1) {
      charge(7+13+10);
      wr(0xC0A2, 1);
      return;
    }
    charge(7+10+7+17);
    fillBytes(0xC280, 0x20, 0x10);
    charge(4+13+13+13+13+13+13+17);
    wr(0xC003, 0); wr(0xC004, 0);
    wr(0xC2A0, 0); wr(0xC2A1, 0);
    wr(0xC006, 0); wr(0xC007, 0);
    yield* drawTitle();
    charge(4+13+7);
    wr(0xC667, 0);
    for (var i = 0; i < 0x20; i++) {
      charge(17+13);
      titleRevealStep();
      yield 'work';
    }
    charge(-5+7+13+17);
    wr(0xC0A2, 5);
    yield* drawScores();
    charge(17);
    colorTableRows();
    charge(7+13+17);
    wr(0xC11F, 5);
    clearHudRows();
    charge(14+19+19+14+19+19);
    wr(0xC0BE, 0); wr(0xC0BF, 0);
    wr(0xC0BB, 0); wr(0xC0BC, 0);
    yield 'work';

    var players = yield* pushStartWait();
    if (players === 1) {
      start1P();
      charge(10);
      yield* gameLoop1P();
    } else {
      start2P();
      charge(10);
      yield* gameLoop2P();
    }
  }
} // pushStartScreen

/**
 * pushStartWait (29D7h) / pushStartWait2 (2A56h) — the PUSH ... BUTTON wait. It
 * is not synchronised with the NMI at all: the text is redrawn and IN0 polled as
 * fast as the CPU can go, which is a little over twice a frame. Returns 1 or 2.
 */
function* pushStartWait() {
  for (;;) {
    charge(55+10+10+17);                       // 29D7-29DE
    drawText32(0xD01F, 0x54A0);                // txtCredit
    charge(7+13+13+4+13+13+13+13+13+13+13+10+7+10);
    wr(0xF001, 1);
    wr(0xF002, 1);
    wr(0xF003, 0); wr(0xF004, 0); wr(0xF005, 0); wr(0xF006, 0); wr(0xF007, 0);
    var credits = rd(0xC0AC);
    wr(0xD05F, credits);
    yield 'work';
    if (credits >= 2) {
      charge(55+10+17);                        // pushStartWait2 2A56h
      drawText32(0xD00F, 0x5520);              // txtPush1or2Player
      charge(7+13+13+4+13+13+13+13+13+13+8);
      wr(0xF001, 1); wr(0xF002, 1);
      wr(0xF003, 0); wr(0xF004, 0); wr(0xF005, 0); wr(0xF006, 0); wr(0xF007, 0);
      yield 'work';
      var a2 = rd(0xF010);
      if (a2 & 0x10) {
        charge(10);
        return 1;
      }
      charge(10+8+10);                         // 2A7A JP NZ (not taken) / 2A7D BIT 3 / 2A7F JP Z
      if (a2 & 0x08) {
        charge(10);                            // 2A82 JP start2P
        return 2;
      }
      continue;                                // 2A7F jumps back to 29D7
    }
    charge(10+17);
    drawText32(0xD00F, 0x5500);                // txtPush1Player
    charge(13+7+10);
    if (rd(0xC500) !== 0) {
      // L_2A15: the dead TEST PLAY branch (C500h is never 1 in this ROM)
      charge(10+10+17);
      drawText32(0xD011, 0x4540);
      charge(7+13);
      wr(0xD05F, 1);
      for (;;) {
        charge(55+13+8+10);
        yield 'work';
        if (rd(0xF010) & 0x10) {
          break;
        }
      }
      return 1;
    }
    charge(55+13+8+10);                        // 2A4A RST 38h / LD A,(IN0) / BIT 4,A / JP Z
    yield 'work';
    if (rd(0xF010) & 0x10) {
      charge(10);                              // 2A53 JP start1P
      return 1;
    }
    // 2A50 JP Z jumps back to 29D7 -- its 10 T are already in the charge above;
    // they used to be charged a second time here, 10 T per turn of a loop that
    // runs about once a frame for the whole PUSH START screen.
  }
} // pushStartWait

// ---------------------------------------------------------------- the demo
/** checkCoinInDemo (1234h) — a credit dropped during the demo ends it at once */
function checkCoinInDemo() {
  charge(17);
  coinInput();
  charge(13+7+11);
  if (rd(0xC0AC) === 0) {
    return false;
  }
  clearScreens();                              // RST 10h
  charge(10+7+4+17+7+13+10+10);
  fillBytes(0xC220, 0x20, 0);
  wr(0xF800, 0x90);
  return true;
} // checkCoinInDemo

/** blinkHudColor (1434h) — the REST label flashes every 32 frames */
function blinkHudColor(a) {
  // 1436 RET NZ is 11 T when it returns (31 frames out of 32) and 5 T when it
  // does not; the 6 T of difference were on the wrong branch, which made the
  // routine 6 T too cheap on the usual path and 6 T too dear on the rare one.
  charge(7);                                   // 1434 AND 1Fh
  if (a & 0x1F) {
    charge(11);                                // 1436 RET NZ taken
    return;
  }
  charge(5+10+7+7+10);                         // 1436 not taken, 1437-143D
  wr(0xC11D, rd(0xC11D) === 0 ? 5 : 0);
  charge(10+10);                               // 1440h / 1443h LD (HL),n + RET
} // blinkHudColor

/** S_1446 — the demo's trigger: with no shot out, run the fire test */
function demoShotCheck() {
  charge(13+7+5);
  if (rd(0xC222) !== 0) {
    return;
  }
  charge(6+13+7+11);
  if (rd(0xC310) === 3) {
    return;
  }
  charge(10);
  shot1FireCheck();
} // demoShotCheck

/**
 * attractBongoAutopilot (1455h) — in a type 2 segment the demo spawns the supply
 * object itself and then flies the ship to it instead of replaying the recorded
 * joystick; state 2 is "docked", where it just fills the gauge every 32 frames
 * until a Bongo is in stock and the demo moves to its second loop (1358h).
 */
function attractBongoAutopilot() {
  charge(14+10+17);
  var c = roundTableByte(0x5700);
  charge(4+13+7+10);
  if (rd(0xC22C) === 0) {
    charge(4+7+10);
    if (c === 2) {
      charge(17+10);
      spawnSupplyObject();
      return;
    }
    charge(17+10);                             // L_1472
    playerInput();
    return;
  }
  charge(4+7+10);                              // L_1476
  if (c !== 2) { supplyDriftAway(); return; }
  charge(13+7+10);
  if (rd(0xC22C) === 0x02) { attractDockedFill(); return; }
  charge(13+7+10);
  if ((rd(0xC0A0) & 0x0F) === 0) {
    charge(19+8+10);
    var a = rd(0xC159);
    if (a & 1) { charge(8+10); a &= 0xFE; } else { charge(8); a |= 1; }
    charge(19+23);                             // L_149B
    wr(0xC159, a);
    wr(0xC158, (rd(0xC158)-1) & 0xFF);
  }
  charge(14+19+19+4+10);                       // L_14A1
  // The two conditional CALLs preserve the flags (both movement routines start
  // with PUSH AF and end with POP AF), so only one of the pair ever runs.
  var d = (rd(0xC158)-rd(0xC140)) & 0xFF;
  if (d !== 0) {
    charge(rd(0xC158) < rd(0xC140) ? 17+10 : 10+17);
    if (rd(0xC158) < rd(0xC140)) { shipMoveLeft(); } else { shipMoveRight(); }
  }
  charge(19+19+4+10);                          // L_14B5
  var e = (rd(0xC15B)-rd(0xC143)) & 0xFF;
  if (e !== 0) {
    charge((rd(0xC15B) < rd(0xC143) ? 17+10 : 10+17)+10);
    if (rd(0xC15B) < rd(0xC143)) { shipMoveUp(); } else { shipMoveDown(); }
    return;
  }
  charge(19+19+4+7+10);                        // L_14C6
  var f = (rd(0xC158)-rd(0xC140)) & 0xFF;
  if (f >= 0x10) {
    charge(7+5);
    if (f < 0xF0) { charge(6); return; }
  }
  charge(7+13+19+7+19+10);                     // L_14D5
  wr(0xC22C, 0x02);
  wr(0xC158, (rd(0xC140)+0x10) & 0xFF);
} // attractBongoAutopilot

/** L_14E3 — the demo's docked object: animate and fill one gauge tile every
 *  32 frames (the demo has no altitude zone 3, so 0798h is never used here) */
function attractDockedFill() {
  charge(13+7+5);
  if (rd(0xC0A0) & 0x1F) { charge(6); return; }
  charge(19+8+10);
  var a = rd(0xC159);
  if (a & 1) { charge(8+10); a &= 0xFE; } else { charge(8); a |= 1; }
  charge(19+17);                               // L_14F8
  wr(0xC159, a);
  fuelGaugeFill();
  charge(17);
  drain(drawBottomHud());                       // see drain(): the NMI path (053Fh)
  charge(10);
} // attractDockedFill

/**
 * demoStart (S_1252h) — the attract demo: round 4, three lives, the ship on the
 * recorded joystick track. Loop A (12CAh) runs until a Bongo turns up in stock
 * (which needs the enemies of ST-M5) or a coin is dropped.
 */
function* demoStart() {
  yield* clearScreensG();
  charge(7+13+7+13+4+13+13+13+13+13+13+13+7+10+7+17);
  wr(0xC0BB, 4);
  wr(0xC0B1, 3);
  wr(0xC521, 0); wr(0xC2A0, 0); wr(0xC523, 0);
  wr(0xC003, 0); wr(0xC004, 0); wr(0xC006, 0); wr(0xC007, 0);
  fillBytes(0xC280, 0x10, 0x10);
  charge(7+13+4+13+13+13+10+7+17+13+13+17);
  wr(0xC030, 1);
  wr(0xC21C, 0); wr(0xC21D, 0); wr(0xC008, 0);
  fillBytes(0xC220, 0x20, 0);
  wr(0xF006, 0); wr(0xF007, 0);
  var param = loadStageParam();
  charge(8+17);
  setVideoRegs(param | 1);
  charge(17);
  if (checkCoinInDemo()) {
    return true;
  }
  charge(17);
  yield* fgLevelInit();
  charge(17);
  yield* bgLevelInit();
  charge(7+13+4+7+13+13+10+10+17);
  wr(0xC310, 1);
  wr(0xC11D, 0);
  wr(0xD81D, 0);
  drawText32(0xD00E, 0x4560);                  // txtGameOverDemo
  charge(17);
  yield* drawBottomHud();
  charge(7+13);
  wr(0xF001, 1);
  yield 'work';

  for (;;) {                                   // demoLoopA 12CAh
    charge(55+17);
    if (checkCoinInDemo()) {
      return true;
    }
    charge(7+13+13+4+13+4+10);                   // 12CE-12DB
    wr(0xF800, 0x90);
    var seen1 = rd(0xC0A0);                     // 12D3 LD B,A latches the counter
    if (rd(0xC0A1) === seen1) {
      // the original keeps turning this loop (and calling checkCoinInDemo with
      // it) until the NMI moves the frame counter on; it does not idle away the
      // rest of the frame, so the turn is charged and the loop runs on
      yield 'work';
      continue;
    }
    // As in playLife 2E31h: the store of frameCounterSeen is settled first,
    // because the NMI falls between the JP and it whenever the turn that finds
    // the counter changed is the last thing that fits in the frame, and B keeps
    // the value read before that NMI. Without it the demo loop wrote the counter
    // one frame early (attract frame 3350, the only difference in the run).
    charge(4+13);                                // 12DE-12DF
    yield 'work';
    wr(0xC0A1, seen1);
    charge(17);
    blinkHudColor(seen1);
    charge(55+17);
    if (checkCoinInDemo()) {
      return true;
    }
    charge(17);
    var p = loadStageParam();
    charge(8+17);
    setVideoRegs(p | 1);
    charge(17);
    yield* drawBottomHud();
    charge(17);
    fgRecolour();
    charge(16+6+16+17);
    wr16(0xC21C, (rd16(0xC21C)+1) & 0xFFFF);
    if (checkCoinInDemo()) {
      return true;
    }
    charge(17);
    yield* shotVsEnemies(0xC222, 1);
    charge(17);
    calcAltitudeZone();
    charge(17);
    shipAnimate();
    charge(17);
    bgScrollStep();
    charge(17);
    attractBongoAutopilot();
    charge(17);
    nmiSpriteAux();
    charge(17);
    demoShotCheck();
    charge(13+7+10);
    if (rd(0xC310) === 3) {
      charge(55+13+8);
      if (rd(0xC0A0) & 1) {
        charge(17);
        fgScrollStep();
      } else {
        charge(10);
      }
    } else {
      charge(17+10);
      fgScrollStep();
    }
    charge(55+13+7+10);
    if (rd(0xC2A0) === 0) {
      yield 'work';
      continue;
    }
    break;                                     // 1333: a Bongo is in stock
  }

  // 1336-1355: three delay loops, then the demo calls the Bongo it has just won
  charge(17);
  yield* drawBottomHud();
  charge(17);
  if (checkCoinInDemo()) {
    return true;
  }
  yield* delayCalls(3);
  charge(17);
  if (checkCoinInDemo()) {
    return true;
  }
  charge(4+13+13+13+10+17);
  wr(0xC21C, 0);
  wr(0xC21D, 0);
  wr(0xC0B9, 0);
  bongoCall(0xC2A0);

  for (;;) {                                   // demoLoopB 1358h
    charge(55+17);
    if (checkCoinInDemo()) {
      return true;
    }
    charge(7+13+13+4+13+4+10);                   // 135C-1369
    wr(0xF800, 0x90);
    var seen2 = rd(0xC0A0);                     // 1361 LD B,A latches the counter
    if (rd(0xC0A1) === seen2) {
      // the original keeps turning this loop (and calling checkCoinInDemo with
      // it) until the NMI moves the frame counter on; it does not idle away the
      // rest of the frame, so the turn is charged and the loop runs on
      yield 'work';
      continue;
    }
    // As in playLife 2E31h: the store of frameCounterSeen is settled first,
    // because the NMI falls between the JP and it whenever the turn that finds
    // the counter changed is the last thing that fits in the frame, and B keeps
    // the value read before that NMI. Without it the demo loop wrote the counter
    // one frame early (attract frame 3350, the only difference in the run).
    charge(4+13);                                // 136C-136D
    yield 'work';
    wr(0xC0A1, seen2);
    charge(17);
    blinkHudColor(seen2);
    charge(17);
    var pb = loadStageParam();
    charge(8+17);
    setVideoRegs(pb | 1);
    charge(17);
    enemyLevelCalc();                          // 137B S_150B
    yield 'work';
    charge(17);
    yield* drawBottomHud();
    yield 'work';
    charge(17);
    fgRecolour();
    yield 'work';
    charge(17);
    if (checkCoinInDemo()) {
      return true;
    }
    charge(16+6+16+17);
    wr16(0xC21C, (rd16(0xC21C)+1) & 0xFFFF);
    yield* shotVsEnemies(0xC222, 1, false);
    yield 'work';
    charge(13+7+10);
    if (rd(0xC22C) !== 0) {
      charge(7);
      bongoActive();
    }
    yield 'work';
    charge(17);
    yield* bongoVsEnemies();
    yield 'work';
    charge(17);
    yield* shipVsEnemies();
    charge(13+7+10);
    if (rd(0xC0B9) !== 0) {
      break;
    }
    yield 'work';
  }

  // 13A7: the ship is gone — the explosion, then everything the demo owns is
  // wiped and the title comes back (1400h)
  charge(17);
  clearPlayerSprites();
  charge(17);
  if (checkCoinInDemo()) {
    return true;
  }
  charge(17);
  yield* shipExplosion();
  charge(4+10+7+17);
  fillBytes(0xC220, 4, 0);
  charge(10+7+17);
  fillBytes(0xC22C, 4, 0);
  charge(10+7+17);
  fillBytes(0xC140, 8, 0);
  charge(10+7+17);
  fillBytes(0xC158, 8, 0);
  charge(7);
  for (var w = 0x70; w > 0; w--) {             // L_13D3
    charge(4);
    yield* delayCalls(1);
    charge(11+17);
    if (checkCoinInDemo()) {
      return true;
    }
    charge(10+13);
  }
  charge(-5+10+7+4+17);
  fillBytes(0xC220, 0x20, 0);
  charge(10+7+17);
  fillBytes(0xC140, 0x20, 0);
  charge(10+7+17);
  fillBytes(0xC1A0, 0x20, 0);
  yield* clearScreensG();                      // 13F7 RST 10h
  charge(17);
  if (checkCoinInDemo()) {
    return true;
  }
  charge(7+17);
  setVideoRegs(0x00);

  // demoEndToTitle 1400h
  charge(10+10+10+0x40*LDIR_TSTATES-5);
  for (var i = 0; i < 0x40; i++) {
    wr(0xC100+i, rd(0x5400+i));
  }
  charge(17);
  if (checkCoinInDemo()) {
    return true;
  }
  charge(10+10+10+0x40*LDIR_TSTATES-5);
  for (i = 0; i < 0x40; i++) {
    wr(0xD800+i, rd(0x5400+i));
  }
  yield 'work';
  charge(10+10+17);
  drawText32(0xD000, 0x5480);                  // txtHud
  charge(17);
  yield* drawScores();
  charge(4+4+4+7+13+10);
  wr(0xC0A2, 1);
  return false;
} // demoStart

// ---------------------------------------------------------------- NMI (0066h)
/** coinInput (042Eh) — one coin slot: the credit is booked on the falling edge
 *  of the coin input, after coinsPerCredit coins, and the total stops at 9 */
function coinSlot(bit, prevAddr, counterAddr, perCreditAddr, creditsAddr, isB) {
  // The two slots are the same code twice, but not the same instructions: slot A
  // (042Eh) leaves every path with JP/JP cc into coinInputB and falls through at
  // the end, slot B (0476h) leaves with JR cc and RET/RET cc. That is why every
  // branch below is charged through `isB`; measured against tools/refemu, the
  // pair now costs exactly what 042Eh..04B6h costs (probe: per-call cost of
  // 042Eh inside the NMI).
  var prev = rd(prevAddr);
  charge(55+14+19+13+8+(isB ? 12 : 10));       // RST 38h, LD IX, LD B, IN0, BIT, JR/JP Z
  if (rd(0xF010) & bit) {
    charge(-(isB ? 5 : 0)+19+10);              // JR NZ is 7 not 12; LD (IX+0),1 + JP/RET
    wr(prevAddr, 1);
    return;
  }
  charge(19+4+7+(prev === 0 ? (isB ? 11 : 10) : (isB ? 5 : 10)));
  wr(prevAddr, 0);
  if (prev === 0) {
    return;
  }
  var n = (rd(counterAddr)+1) & 0xFF;
  var perCredit = rd(perCreditAddr);
  charge(13+4+13+4+13+4+(n !== perCredit ? (isB ? 11 : 10) : (isB ? 5 : 10)));
  wr(counterAddr, n);
  if (n !== perCredit) {
    return;
  }
  // 045Eh/049Fh: XOR A + LD (counter),A + LD A,(creditsPerCoin) + LD B,A +
  // LD A,(credits), then the INC A/DJNZ loop, the clamp at 9 and LD (credits),A
  var per = rd(creditsAddr);
  var credits = (rd(0xC0AC)+per) & 0xFF;
  charge(4+13+13+4+13+(per === 0 ? 256 : per)*17-5+7+
    (credits < 9 ? (isB ? 12 : 10) : (isB ? 7 : 10)+7)+13+(isB ? 10 : 0));
  wr(counterAddr, 0);
  wr(0xC0AC, credits < 9 ? credits : 9);
} // coinSlot

/** coinInput (042Eh) — coin A (IN0 bit 0) and coin B (IN0 bit 5) */
function coinInput() {
  coinSlot(0x01, 0xC3E0, 0xC0AB, 0xC0A7, 0xC0A6, 0);   // 042E
  coinSlot(0x20, 0xC543, 0xC542, 0xC540, 0xC541, 1);   // 0476 coinInputB
} // coinInput

/** rng (1694h): PUSH BC/HL, the 12 arithmetic instructions and the two POPs */
var RNG_TSTATES = 11+11+16+4+4+11+11+4+4+11+4+4+4+11+4+4+10+16+10+10+10;

/**
 * nmiEnemyScripts (36DBh) — the enemy engine of every frame: the script timer,
 * the spawn control, then the four A slots (records C224h+2n, shadows C148h+4n,
 * partner shadows C1A8h+4n) and the six B slots (records C230h+2n, shadows
 * C1A0h+4n). An empty A slot is offered to spawnRequestedA instead; an empty B
 * slot is skipped. IY is not reloaded for the B loop, so every B handler sees
 * C1B8h — the shadow of slot 14 — as its partner, exactly as the original does.
 */
function nmiEnemyScripts() {
  var t = rd(0xC531);
  charge(13+7+(t !== 0 ? 7+4+13 : 12));
  if (t !== 0) {
    wr(0xC531, (t-1) & 0xFF);
  }
  charge(55+17);
  enemySpawnCtrl();                            // 36E7 S_3743
  charge(55);                                  // 36EA-36F6 the four pointers
  var hl = 0xC240, de = 0xC224, ix = 0xC148, iy = 0xC1A8;
  for (var b = 0; b < 4; b++) {
    charge(55+7+7+10);
    if (rd(de) !== 0) {
      charge(17+10);                             // 3701 CALL run_script + 3704 JP
      run_script(de, ix, iy);
    } else {
      charge(17);
      spawnRequestedA(hl, de, ix);             // 3707 S_3ED0
    }
    charge(6+6+6+7+136+13);
    de += 2; hl += 1; ix += 4; iy += 4;
  }
  charge(-5+31);
  de = 0xC230; ix = 0xC1A0;
  for (b = 0; b < 6; b++) {
    charge(55+7+7);
    if (rd(de) !== 0) {
      charge(17);                                // 3726 CALL NZ,run_script
      run_script(de, ix, 0xC1B8);
    } else {
      charge(10);
    }
    charge(6+6+40+13);
    de += 2; ix += 4;
  }
  charge(-5+10);
} // nmiEnemyScripts

// ------------------------------------------------------- spawn (3436h..4144h)
// Everything below runs inside the NMI, so — like the enemy scripts — it does
// not charge its own T-states; the loop skeleton above pays for it in one lump.

/**
 * clearSpawnRequests (3DBBh) — XOR A 4 + LD HL 10 + LD B 7 + CALL fillBytes 17,
 * then fillBytes charges the body (4 x 24, less 5 for the last DJNZ, plus its
 * RET 10), and +10 for the RET at 3DC4h. 149 T in all, which is what
 * tools/refemu spends between 3DBBh and 3DC4h.
 */
function clearSpawnRequests() {
  charge(4+10+7+17+10);
  fillBytes(0xC240, 4, 0);
}

/**
 * enemySpawnCtrl (3743h) — which spawner gets to run this frame: the rock boss
 * in section 1Fh, a hangar hatch when its tiles are on screen, otherwise the
 * per-round schedule.
 */
function enemySpawnCtrl() {
  // 3743 LD IX,nn 14 + 3747 CALL clearSpawnRequests 17; the routine charges its
  // own 149 T. Then the two early exits, each LD A,(nn) 13 + CP 7 + RET Z
  // (11 taken, 5 not). Measured: 3743h costs 211 T without its CALL.
  charge(14+17);                                    // 3743-3747
  clearSpawnRequests();                             // 3747
  var lifeOver = rd(0xC0B9);
  charge(13+7+(lifeOver === 0x01 ? 11 : 5));        // 374A-374F
  if (lifeOver === 0x01) return;                    // no life running
  var playFrames = rd(0xC21C);
  charge(13+7+(playFrames === 0x00 ? 11 : 5));      // 3750-3755
  if (playFrames === 0x00) return;                  // no life has started yet
  var p = rd(0xC030);
  charge(10+13+7+(p === 1 ? 10 : 10+6)+7+7+10);
  var hl = p === 1 ? 0xC0BB : 0xC0BC;
  var a = rd(hl);
  if (a === 0x1F) { spawnRockCheck(); return; }     // 3765
  charge(7+(a & 0x03 ? 12 : 7+13+7+11));
  if ((a & 0x03) === 0 && rd(0xC160) < 0x30) return;
  // L_3772: the two hangars of the fortress
  charge(13+7+55+12);
  if (rd(0xE1CB) === 0x2F) {
    charge(-5+13+7+10);
    if (rd(0xE10B) === 0x02) { hatchSpawnLeft(); return; }
  }
  charge(13+7+10);
  if (rd(0xE1F2) !== 0xCA) { spawnDispatch(); return; }
  charge(13+7+10);
  if (rd(0xE092) === 0x51) { hatchSpawnRight(); return; }
  spawnDispatch();
}

/** spawnDispatch (3792h) — altitude zone 2 and 3 get the rocket spawner */
function spawnDispatch() {
  // 3792 CALL S_3736 17 + its body (LD B,04h 7 + RET 10), then 3795 LD B,04h,
  // which was missing, and 3797-379C
  charge(17+7+10+7+13+7+10);
  var z = rd(0xC310);
  if (z === 0x02) { charge(10); spawnRocketRandom(4); return; }
  charge(7+10);
  if (z === 0x03) { spawnRocketRandom(4); return; }
  charge(4+4+55);
  spawnFromSchedule();
}

/**
 * spawnFromSchedule (37A7h) — scheduleTable 4200h + 20h*(stage mod 4) + section
 * gives the index of the four-type set copied into the requests. FFh means the
 * vacuum sphere (or set 5Bh once the fortress has scrolled far enough).
 */
function spawnFromSchedule() {
  var p = rd(0xC030);
  var iy = p === 1 ? 0xC003 : 0xC004;
  var hl = p === 1 ? 0xC0BB : 0xC0BC;
  // 37BD/37C4/37DB/37DF/37E6/37F1/37F8 are all JR cc — 12 T taken, 7 T not.
  // They were charged as a flat 7 T (with two ad-hoc corrections), which cost
  // this routine 7 T per call on the common path.
  charge(10+14+13+7+(p === 1 ? 12 : 7+10+6)+19+7+(rd(iy) === 0x00 ? 7 : 12));
  if (rd(iy) === 0x00) {                            // 37BD: the first stage only
    var ground = rd(0xC130);
    charge(13+7+(ground < 0x50 ? 7 : 12));          // 37BF-37C4
    if (ground < 0x50) {
      charge(7+7+10);                               // 37C6-37C9
      if (rd(hl) === 0x1C) { spawnEyeballs(); return; }
      charge(9*4+55);                               // 37CC-37D5
    }
    // L_37D6
    var a = rd(hl) & 0x0F;
    charge(7+7+7+(a === 0x04 ? 12 : 7+7+(a === 0x0A ? 7 : 12)));
    if (a === 0x04 || a === 0x0A) {
      var scroll = rd(0xC160);
      charge(13+7+(scroll < 0x10 ? 7 : 12));        // 37E1-37E6
      if (scroll < 0x10) {
        var b0 = rd(0xC230), b2 = rd(0xC232);
        charge(14+19+7+(b0 === 0 ? 7 : 12)+(b0 === 0 ? 19+7+(b2 === 0 ? 7 : 12) : 0));
        if (b0 === 0x00 && b2 === 0x00) {
          // 37FA/3805: the pod pair 4Bh/3Eh with its two sprites
          charge(10+10+10+4*LDIR_TSTATES-5+10+10+10+8*LDIR_TSTATES-5);
          for (var i = 0; i < 4; i++) wr(0xC230+i, rd(0x3D28+i));
          for (i = 0; i < 8; i++) wr(0xC1A0+i, rd(0x3D2C+i));
        }
      }
    }
  }
  // L_3810: LD IX 14 + CALL S_3736 17, whose body is LD B,04h 7 + RET 10
  charge(14+17+7+10+19);
  var stage = rd(iy);
  while (stage >= 0x04) { charge(7+7+7+12); stage -= 0x04; }
  // 3828-3834: CP 01h then three JR cc, and one ADD HL,DE per step skipped.
  // 12 T when a JR is taken, 7 T when it is not; the trailing ADD HL,DE was
  // charged even for schedule 0, which never reaches one.
  charge(7+12+10+10+7+
    (stage === 0 ? 12 :
     stage === 1 ? 7+12+11 :
     stage === 2 ? 7+7+7+12+11+11 :
                   7+7+7+7+11+11+11));
  charge(17+7);                                     // 3835 CALL + 3838 CP FFh
  var k = roundTableByte(0x4200+0x20*stage);
  if (k !== 0xFF) { charge(55+12); spawnRequestSet(k); return; }
  // 3842 JR NZ,L_3849 is 12 T when formationLast is not FFh
  charge(55+7+13+7+(rd(0xC532) === 0xFF ? 7 : 12));
  if (rd(0xC532) === 0xFF) { charge(7+10); spawnRequestSet(0x5B); return; }
  charge(13+7+10);
  if (rd(0xC160) >= 0x50) { charge(7+10); spawnRequestSet(0x5B); return; }
  spawnVacuumSphere();
}

/** spawnEyeballs (3C3Bh) — requests 40h/41h/42h */
function spawnEyeballs() {
  charge(14+19+19+19+10);
  wr(0xC240, 0x40);
  wr(0xC241, 0x41);
  wr(0xC242, 0x42);
}

/**
 * scheduleIndexAdjust (3C4Ch) — outside section type 2 the set index climbs
 * with the score: every time frameCounter is exactly 10h the top digit pair of
 * the score is latched into scheduleScoreOfs (C526h) and added on, saturating
 * at B5h (the last set of requestSets).
 */
function scheduleIndexAdjust(a) {
  var c = a;
  charge(4+7+5);
  if (a === 0x00) { charge(6); return 0x00; }
  charge(10+17+7+10);
  if (roundTableByte(0x5700) === 0x02) { charge(4+10); return c; }
  a = rd(0xC21D) & 0x07;
  charge(13+7+(a === 0x00 ? 12 : 7));               // 3C5B-3C60 JR Z,L_3C8A
  if (a === 0x00) { charge(4+13+7+10); wr(0xC526, 0); return 0x5B; }
  charge(7+7+10);
  if (a === 0x04) { charge(4+4); return 0x00; }
  charge(13+7+10);
  if (rd(0xC000) < 0x02) { charge(4+10); return c; }
  charge(13+7+10);
  if (rd(0xC0A0) === 0x10) {
    charge(17+13+7+10+10+10+7+13);
    wr(0xC526, rd(rd(0xC030) === 1 ? 0xC06D : 0xC073));   // S_3C93
  }
  charge(13+4+7+5+7+4);
  var r = (rd(0xC526)+c) & 0xFF;
  return r < 0xB5 ? r : 0xB5;
}

/** spawnRequestSet (3899h) — requestSets 38BBh[k] into C240h..C243h */
function spawnRequestSet(k) {
  charge(11+17+10+7+5);
  var a = scheduleIndexAdjust(k);
  if (a >= 0xB6) { charge(6); return; }
  charge(10+10);
  var hl = 0x38BB;
  for (var n = a; n > 0; n--) {                     // L_38A7: the RST 38h loop
    charge(55+7+7+11+4+10);
    hl += 4;
  }
  charge(55+7+12);
  for (var i = 0; i < 4; i++) {
    charge(7+19+10+6+13);
    wr(0xC240+i, rd(hl+i));
  }
  charge(-5+10);
}

/**
 * spawnVacuumSphere (3851h) — the four-part vacuum (types 50h, 51h x3) needs
 * all of B slots 0..3 free; formationLast is set to FFh so the schedule keeps
 * asking for it.
 */
function spawnVacuumSphere() {
  charge(10+7);
  for (var i = 0; i < 4; i++) {
    charge(7+7+5+6+6+13);
    if (rd(0xC230+2*i) !== 0x00) { charge(-5+6); return; }
  }
  charge(-5+7+13+10+10+10+8*LDIR_TSTATES-5+10+10+10+16*LDIR_TSTATES-5+14+17+10);
  wr(0xC532, 0xFF);
  for (i = 0; i < 8; i++) wr(0xC230+i, rd(0x3881+i));
  for (i = 0; i < 16; i++) wr(0xC1A0+i, rd(0x3889+i));
  spawnPairAux(0xC1A0);
}

/**
 * spawnPairAux (34A4h) — a 2x2 object: sprites 1..3 of the group are placed
 * around sprite 0 (the cocktail cabinet mirrors the second player's copy).
 */
function spawnPairAux(ix) {
  charge(13+7+5+19+13+7+12+13+7+7+4+7+19+19+7+19+4+19+19+4+19+19+10);
  if (rd(0xC0B9) === 0x01) return;
  var b = rd(ix+0);
  if (rd(0xC0BD) === 0x01 && rd(0xC030) !== 0x01) {
    wr(ix+12, (b+0x11) & 0xFF);
  } else {
    wr(ix+12, (b+0x0F) & 0xFF);
  }
  wr(ix+4, b);
  wr(ix+8, (b+0x10) & 0xFF);
  var a = rd(ix+3);
  wr(ix+11, a);
  wr(ix+7, (a+0x10) & 0xFF);
  wr(ix+15, (a+0x10) & 0xFF);
}

/**
 * spawnRocketRandom (3CA4h) — inside the fortress (fgMapPageFlags 2). b is the
 * number of requests the filler group may fill and grows with the section.
 */
function spawnRocketRandom(b) {
  // The chain of tests below leaves at the first one that fires, so each of
  // them has to be charged where it is instead of in one lump up front: the
  // lump charged 463 T for 3CAC-3D04 while the path this routine actually takes
  // in the demo (P1, section < 8, stage 0) costs 154 T. Measured with a PC
  // trace of the reference machine over attract frame 3348, where the NMI was
  // 376 T dearer in the worker than in the original (309 T of that here, the
  // other 67 in spawnFillerGroup).
  charge(17+RNG_TSTATES+7+10);                 // 3CA4-3CA9
  if (rng() < 0x10) { spawnFromSchedule(); return; }
  var p = rd(0xC030);
  charge(10+14+13+7+10+(p === 1 ? 0 : 6+10)+7+4+13+7);   // 3CAC-3CC3
  var c = rd(p === 1 ? 0xC0BB : 0xC0BC);
  var stageAddr = p === 1 ? 0xC003 : 0xC004;
  if (rd(0xC530) !== 0x02) { charge(11); return; }        // 3CC5 RET NZ
  charge(5+7+4+7+10);                                     // 3CC5 not taken, 3CC6-3CCB
  b = 1;
  if (c >= 0x08) {
    charge(7+10);                                         // 3CCE-3CD0
    if (c >= 0x10) { charge(4); b++; }                    // 3CD3 INC B
    charge(4); b++;                                       // 3CD4 INC B
  }
  charge(19+7+10);                                        // 3CD5-3CDA
  if (rd(stageAddr) === 0x00) { spawnFillerGroup(b); return; }
  charge(13+7+10);                                        // 3CDD-3CE2
  if (rd(0xC000) < 0x08) { spawnFillerGroup(b); return; }
  charge(13+7+10);                                        // 3CE5-3CEA
  if (rd(0xE800) >= 0x20) { spawnFillerGroup(b); return; }
  charge(17+RNG_TSTATES+7);                               // 3CED-3CF0
  var r = rng();
  if (r < 0x90) { charge(11); return; }                   // 3CF2 RET C
  charge(5+7+10);                                         // 3CF2 not taken, 3CF3-3CF5
  if (r < 0xF0) { spawnFillerGroup(b); return; }
  charge(10+7+7+10);                                      // 3CF8-3CFE
  if (rd(0xC230) !== 0x00) { spawnFillerGroup(b); return; }
  charge(6+6+7+10);                                       // 3D01-3D04
  if (rd(0xC232) !== 0x00) { spawnFillerGroup(b); return; }
  charge(6+6+10+6+10+6+10+6+10+10+10+10+16*LDIR_TSTATES-5+10);   // 3D07-3D1F
  wr(0xC230, 0x4A); wr(0xC231, 0x00);
  wr(0xC232, 0x3E); wr(0xC233, 0x00);
  for (var i = 0; i < 16; i++) wr(0xC1A0+i, rd(0x3D20+i));
}

/** spawnFillerGroup (3D34h) — up to b requests from fillerGroups 3D67h */
function spawnFillerGroup(b) {
  charge(17+RNG_TSTATES+7+10);
  if (rng() < 0x80) { spawnFlowerMines(); return; }
  // 3D47/3D4C/3D51 are JP C: the chain leaves at the first one that fires, so
  // only the tests actually made are charged (the lump charged all four and all
  // three ADD HL,DE, 67 T too many on the enemyLevel < 2 path of attract 3348).
  charge(10+10+13+7+10);                       // 3D3C-3D47
  var lvl = rd(0xC000);
  var idx = 0;
  if (lvl >= 0x02) {
    charge(7+10);                              // 3D4A-3D4C
    if (lvl >= 0x05) {
      charge(7+10);                            // 3D4F-3D51
      if (lvl >= 0x07) { charge(11); idx++; }  // 3D54 ADD HL,DE
      charge(11); idx++;                       // 3D55 ADD HL,DE
    }
    charge(11); idx++;                         // 3D56 ADD HL,DE
  }
  charge(10);                                  // 3D57 LD DE,spawnReqA0
  var hl = 0x3D67+4*idx;
  var de = 0xC240;
  for (var n = (b === 0 ? 256 : b); n > 0; n--) {
    charge(17+RNG_TSTATES+7+5);
    if (rng() < 0x90) { charge(6); return; }
    charge(7+7+6+6+13);
    wr(de, rd(hl));
    hl++; de++;
  }
  charge(-5+10);
}

/** spawnFlowerMines (3D7Bh) — type 45h into the free A slots, from slot 3 down */
function spawnFlowerMines() {
  charge(10+14+13+4+4+7+7+4);
  var hl = 0xC22A, ix = 0xC154;
  var b = (rd(0xC000)+2) & 0xFF;
  if (b >= 0x04) b = 0x04;
  for (var n = (b === 0 ? 256 : b); n > 0; n--) {
    charge(7+7+10+6+6+10+10+10+10+13);
    if (rd(hl) === 0x00) {
      charge(10+6+10+6+19+19+19+17+RNG_TSTATES+7+19);
      wr(hl, 0x45);
      wr(hl+1, 0x00);
      wr(ix+0, 0xF0);
      wr(ix+1, 0xEA);
      wr(ix+2, 0x07);
      wr(ix+3, rng() | 0x98);
    }
    hl -= 2; ix -= 4;
  }
  charge(-5+10);
}

/** spawnRockCheck (3551h) — section 1Fh: the rock boss and its escort */
function spawnRockCheck() {
  var p = rd(0xC030);
  charge(55+14+13+7+(p === 1 ? 10 : 10+10)+19+7+11+13+7+10+13+7+10+13+7+11+19+7+10+13+7+11);
  var ix = p === 1 ? 0xC006 : 0xC007;
  if (rd(ix) === 0x03) return;                      // the rock is already gone
  if (rd(0xC230) === 0x58) { spawnRockEscort(); return; }
  if (rd(0xE14D) === 0xA9) { spawnRockBoss(); return; }
  if (rd(0xE18F) === 0xB4) return;
  if (rd(ix-3) >= 0x01) { spawnRockEscort(); return; }
  if ((rd(0xC0A0) & 0x0F) !== 0) return;
  spawnRockEscort();
}

/** spawnRockBoss (34E1h) — the rock itself (B slots) and its four turrets */
function spawnRockBoss() {
  charge(10+10+10+0x18*LDIR_TSTATES-5+14+17+
         10+10+10+0x0C*LDIR_TSTATES-5+
         10+10+10+0x10*LDIR_TSTATES-5+
         10+10+10+0x08*LDIR_TSTATES-5+10);
  for (var i = 0; i < 0x18; i++) wr(0xC1A0+i, rd(0x352D+i));
  spawnPairAux(0xC1A0);
  for (i = 0; i < 0x0C; i++) wr(0xC230+i, rd(0x3545+i));
  for (i = 0; i < 0x10; i++) wr(0xC148+i, rd(0x3515+i));
  for (i = 0; i < 0x08; i++) wr(0xC224+i, rd(0x3525+i));
}

/** spawnRockEscort (358Ah) — a ground launcher into every free A slot and B4/B5 */
function spawnRockEscort() {
  charge(13+7+10);
  if (rd(0xE800) < 0x30) { spawnFromSchedule(); return; }
  charge(14+14+7);
  var iy = 0xC224, ix = 0xC148, b;
  for (b = 0; b < 4; b++) {
    charge(19+7+(rd(iy) === 0x00 ? 17 : 10)+55+10+10+10+10+10+10+13);
    if (rd(iy) === 0x00) spawnRandomGroundType(iy, ix);
    iy += 2; ix += 4;
  }
  charge(-5+14+14+7);
  iy = 0xC238; ix = 0xC1B0;
  for (b = 0; b < 2; b++) {
    charge(19+7+(rd(iy) === 0x00 ? 17 : 10)+10+10+10+10+10+10+13);
    if (rd(iy) === 0x00) spawnRandomGroundType(iy, ix);
    iy += 2; ix += 4;
  }
  charge(-5+10);
}

/**
 * spawnRandomGroundType (35D4h) — one of the 29 ground launchers 90h..ADh, but
 * only if that type is not on screen already and the tile it sits on (from
 * rockEscortPos 365Fh) is still 50h.
 */
function spawnRandomGroundType(iy, ix) {
  charge(11+15+15);
  var a;
  do {
    charge(17+RNG_TSTATES+7+10+7+10);
    a = rng() & 0x1F;
  } while (a === 0x00 || a >= 0x1E);
  charge(11+7+4+10+7);
  var c = (a+0x8F) & 0xFF;
  var i;
  for (i = 0; i < 4; i++) {
    charge(7+4+10+6+6+13);
    if (rd(0xC224+2*i) === c) { charge(-5+10+10+14+14+10+10); return; }
  }
  charge(-5+10+7);
  for (i = 0; i < 3; i++) {
    charge(7+4+10+6+6+13);
    if (rd(0xC238+2*i) === c) { charge(-5+10+10+14+14+10+10); return; }
  }
  charge(-5+10+10+10);
  for (i = 0; i < a; i++) charge(11+4+10);
  charge(7+4+6+7+4+7+7+10);
  var hl = 0x365F+4*a;
  var de = rd(hl) | (rd(hl+1) << 8);
  if (rd(de) !== 0x50) { charge(14+14+10+10); return; }
  charge(19+19+13+4+6+7+4+19+19+19+6+7+19+19+7+7);
  wr(iy+0, c);
  wr(iy+1, 0x00);
  var cc = rd(0xC160);
  wr(ix+0, (rd(hl+2)+cc) & 0xFF);
  wr(ix+1, 0xEC);
  wr(ix+2, 0x04);
  wr(ix+3, rd(hl+3));
  if (rd(ix+0) >= 0xE0) {
    charge(-7+12+4+19+19+19+19+19+19);
    wr(ix+0, 0); wr(ix+1, 0); wr(ix+2, 0); wr(ix+3, 0);
    wr(iy+0, 0); wr(iy+1, 0);
  }
  charge(14+14+10+10);
}

/**
 * S_3DC5 (3DC5h) — the hangar gate: false means the routine POPped its caller's
 * return address, so hatchSpawnLeft/Right stop after spawnDispatch.
 */
function hatchGateOpen() {
  charge(17+13+7+5+13+7+8+5+8+5);
  if (rd(0xC000) >= 0x10) return true;
  var a = rd(0xC160) & 0xF0;
  if ((a & 0x10) === 0) return true;
  if ((a & 0x40) !== 0) return true;
  return false;
}

/** the tail shared by both hatches (3E2Fh / 3E4Eh) */
function hatchPodType(hl, ix, low) {
  charge(17+7+7+7+7+10+10);            // 3E2Fh CALL + the CP/JR tail; the
  var s = aimSector12(ix, hl);         // 300 T that used to stand for the call
                                       // are now charged by aimSector12 itself
  if (low) {
    if (s >= 0x0A) { wr(hl, 0x65); return; }
    if (s === 0x09) { wr(hl, 0x64); return; }
    if (s >= 0x06) { wr(hl, 0x63); return; }
    wr(hl, 0x64);
    return;
  }
  if (s < 0x03) { wr(hl, 0x46); return; }
  if (s === 0x03) { wr(hl, 0x47); return; }
  if (s < 0x07) { wr(hl, 0x48); return; }
  wr(hl, 0x47);
}

/** the free-B-slot search of both hatches (3DF1h / 3E7Fh) */
function hatchSpawn(offset, tileHiAddr, tileHiVal, tileLoAddr, tileLoVal, xHi, xLo) {
  charge(10+14+7);
  var hl = 0xC230, ix = 0xC1A0, b;
  for (b = 0; b < 6; b++) {
    charge(7+7+10);
    if (rd(hl) === 0x00) break;
    charge(6+6+10+10+10+10+13);
    hl += 2; ix += 4;
  }
  if (b === 6) { charge(-5+10); return; }
  charge(7+13+6+10+6+13+7+4+19+19+19+17+RNG_TSTATES+7+10+19+7+13+10);
  wr(0xF800, 0x14);
  wr(hl+1, 0x00);
  wr(ix+0, (rd(0xC160)+offset) & 0xFF);
  wr(ix+1, 0xCC);
  wr(ix+2, 0x06);
  if (rng() >= 0x80) {
    wr(ix+3, xHi);
    wr(tileHiAddr, tileHiVal);
    hatchPodType(hl, ix, false);
    return;
  }
  wr(ix+3, xLo);
  wr(tileLoAddr, tileLoVal);
  hatchPodType(hl, ix, true);
}

/** hatchSpawnLeft (3DD8h) — the left hangar opens and lets one pod out */
function hatchSpawnLeft() {
  charge(7+13+7+13+17+17);
  wr(0xE165, 0x16);
  wr(0xE16E, 0x1F);
  spawnDispatch();
  if (!hatchGateOpen()) return;
  hatchSpawn(0x99, 0xE165, 0xFC, 0xE16E, 0xFD, 0x25, 0x6F);
}

/** hatchSpawnRight (3E66h) */
function hatchSpawnRight() {
  charge(7+13+7+13+17+17+10);
  wr(0xE149, 0x94);
  wr(0xE158, 0xA3);
  spawnDispatch();
  if (!hatchGateOpen()) return;
  hatchSpawn(0xA5, 0xE149, 0xFE, 0xE158, 0xFF, 0x40, 0xBD);
}

/**
 * spawnRequestedA (3ED0h) — an empty A slot takes the request left in
 * C240h+n: types 70h..76h are the six-object formations, everything else is one
 * object initialised from objInitTable 4600h (a zero X or Y in the table means
 * "random").
 */
function spawnRequestedA(hl, de, ix) {
  charge(11+11+11+15+7+7+10);                        // 3ED0-3ED8
  var a = rd(hl);
  if (a === 0x00) { charge(14+10+10+10+10); return; } // 3ED8 jumps straight to L_3F24
  // 3EDB-3EE1: CP 70h + JR C (12 T when it goes to L_3EE3), then CP 77h + JR C
  // (12 T into spawnFormation). Both pairs used to be charged as if they always
  // ran, together with a second copy of the five POPs at the end.
  charge(7+(a < 0x70 ? 12 : 7+7+(a < 0x77 ? 12 : 7)));
  if (a >= 0x70 && a < 0x77) { spawnFormation(a); return; }
  charge(7+4+6+7+7+10+10);
  wr(de, a);
  wr(de+1, 0x00);
  var src = 0x4600;
  for (var n = a; n > 0; n--) { charge(7+10+11+4+10); src += 4; }
  charge(7+10+15+10+10+4*LDIR_TSTATES-5+19+7);
  for (var i = 0; i < 4; i++) wr(ix+i, rd(src+i));
  // The three CALL Z at 3F05/3F0A/3F12 cost 17 T when they are taken, and each
  // of the three routines opens with its own CALL rng (another 17 T on top of
  // RNG_TSTATES); neither was charged.
  var x = rd(ix+3);
  charge(x === 0x00 ? 17 : 10);                     // 3F05 CALL Z,randXLow
  if (x === 0x00) {                                 // randXLow 3F2Ah
    charge(17+RNG_TSTATES+7+7+10+19+10);
    x = rng() | 0x98;
    if (x === 0xFF) { charge(-10+7); x = 0xA8; }
    wr(ix+3, x);
  }
  // 3F0A and 3F12 are CALL Z: 17 T taken, 10 T not. The 10 T used to be charged
  // in the preceding lump as well as in the else branch, so the not-taken paths
  // paid it twice; and the fifteen NOPs of 3F15-3F23 were never charged at all.
  charge(7+(x === 0xFF ? 17 : 10));                 // 3F08-3F0A
  if (x === 0xFF) {                                 // randX7F 3F3Ah
    charge(17+RNG_TSTATES+7+19+10);
    wr(ix+3, rng() & 0x7F);
  }
  var code = rd(ix+0);
  charge(19+7+(code === 0x00 ? 17 : 10));           // 3F0D-3F12
  if (code === 0x00) {                              // randY20 3F43h
    charge(17+RNG_TSTATES+7+19+10);
    wr(ix+0, rng() | 0x20);
  }
  charge(15*4+14+10+10+10+10);                      // 3F15-3F29: 15 NOPs + POPs
}

/**
 * spawnFormation (3F50h) — seven rows of six objects across the six B slots.
 * Most of the time the requested type is rotated by the top of the score, and a
 * formation is never repeated back to back (formationLast C532h).
 */
function spawnFormation(type) {
  charge(4+17+RNG_TSTATES+7+7);
  var b = type, a;
  if (rng() >= 0x30) {
    charge(17+13+7+10+10+10+7+4+6+7+4+7+4);
    var hl = rd(0xC030) === 1 ? 0xC06D : 0xC073;    // S_3C93
    a = ((rd(hl)+rd(hl+1)) & 0x07);
    a = (a+b) & 0xFF;
    charge(7+10);
    while (a >= 0x77) { charge(-10+7+12+7+10); a -= 0x07; }
  } else {
    charge(12+4+7+10);
    a = b;
  }
  charge(7*7+10*7);
  var n = a-0x70;                                   // 0..6
  for (var guard = 0; guard < 7; guard++) {
    if (rd(0xC532) !== FORMATION_SPEC[n].type) break;
    n = (n+1) % 7;
  }
  var spec = FORMATION_SPEC[n];
  // formationNeedFreeB 3F88h: all six B slots have to be free
  charge(17+10+7);
  for (var i = 0; i < 6; i++) {
    charge(7+7+7+6+6+13);
    if (rd(0xC230+2*i) !== 0x00) { charge(-7+12+10+10); return; }
  }
  charge(-5+10+14+7+7+10);
  var hl2 = 0xC230, ix = 0xC1A0, c = spec.c0;
  if (spec.c0 === 0x60 && spec.type !== 0x70 && spec.type !== 0x71) charge(7);
  for (i = 0; i < 6; i++) {
    charge(10+6+7+19+19+19+19+6+10+10+10+10+7+
           Math.abs(spec.step)*(4+4+12)-5+13);
    wr(hl2, spec.type);
    wr(hl2+1, c);
    wr(ix+0, spec.y);
    wr(ix+1, spec.code);
    wr(ix+2, 0x06);
    wr(ix+3, spec.x === null ? c : spec.x);
    hl2 += 2; ix += 4;
    c = (c+spec.step) & 0xFF;
  }
  charge(-5+7+13+10);
  wr(0xC532, spec.type);
}

/** formation70..formation76 (3FA6h..4133h): {type, first counter, step, sprite} */
var FORMATION_SPEC = [
  {type: 0x70, c0: 0x10, step:  0x10, y: 0xFF, code: 0xC5, x: null},
  {type: 0x71, c0: 0x10, step:  0x10, y: 0xFF, code: 0xC5, x: 0x30},
  {type: 0x72, c0: 0x60, step: -0x08, y: 0xFF, code: 0xE5, x: 0x10},
  {type: 0x73, c0: 0x60, step: -0x0A, y: 0x10, code: 0xE5, x: 0x05},
  {type: 0x74, c0: 0x60, step: -0x08, y: 0xFF, code: 0xE5, x: 0xE0},
  {type: 0x75, c0: 0x60, step: -0x0A, y: 0x10, code: 0xE5, x: 0xF0},
  {type: 0x76, c0: 0x60, step: -0x10, y: 0xFF, code: 0xC5, x: 0x10}
];

/** nmi (0066h) — runs every frame while F001h bit 0 is set */
function nmiHandler() {
  var before = state.pending;
  // 11 T for accepting the NMI itself (the Z80 pushes PC and jumps to 0066h),
  // then 0066-006F: PUSH AF/BC/DE/HL/IX/IY and NMI_EN = 0, then the two shadow
  // copies (their LDIR bytes are charged by ldir(), the set-up is not).
  // The 11 T were missing; tools/refemu spends exactly 11 T there (z80.js
  // step(), the _nmiReq branch) and the per-frame NMI cost was 11 T short of
  // the reference in every frame that has no other error.
  charge(11+74+4+13+30-5+30-5+55);
  wr(0xF001, 0);                                 // 006E
  ldir(0xC100, 0xD800, 0x60);                    // 0072 attribute + sprite shadows of layer 1
  ldir(0xC160, 0xE800, 0x60);                    // 007D ... and layer 0
  watchdogKick();

  var f = (rd(0xC0A0)+1) & 0xFF;                 // 0089
  wr(0xC0A0, f);
  charge(13+4+13+7+10+13+7+10+13+8+10);
  if ((f & 0x0F) === 0) {
    charge(13+4+13);
    wr(0xC0B6, (rd(0xC0B6)+1) & 0xFF);           // 0095 every 16 frames
  }
  if ((f & 0x07) === 0) {
    charge(13+4+13);
    wr(0xC314, (rd(0xC314)+1) & 0xFF);           // 00A4 every 8 frames
  }
  if (f & 0x01) {
    charge(13+4+13);
    wr(0xC0B5, (rd(0xC0B5)+1) & 0xFF);           // 00B3 every odd frame
  }

  charge(17);
  coinInput();                                   // 00BA
  charge(55+13+7);

  // 00BE: stageEndPhase 0 = play normally, 1..C1h = the whole frame is skipped,
  // >= C2h = only the enemy scripts are skipped (notes/A.md has this the wrong
  // way round: it says >= C2h skips everything)
  var phase = rd(0xC515);
  charge(phase === 0 ? 12+55+17 : phase < 0xC2 ? 7+7+12 : 7+7+7+12);
  if (phase === 0) {
    nmiEnemyScripts();                           // 00CC S_36DB
  }
  if (phase === 0 || phase >= 0xC2) {
    charge(4*(55+17));
    nmiBongoPlayer();                          // 00D0 S_053F
    nmiShot1();                                // 00D4 S_2443
    nmiShot2();                                // 00D8 S_2623
    nmiShot3();                                // 00DC S_274F
    charge(55+13+7+10);
    if (rd(0xC0B9) !== 1) {
      charge(17);
      nmiGameLogic();                          // 00E8 S_0103
    }
  }

  charge(7+13+68+14);                            // 00EB-00F8 NMI_EN = 1, POPs, RETN
  wr(0xF001, 1);                                 // 00EB
  // whatever the NMI charged is taken off this frame, not off the foreground
  state.nmiCost = state.pending-before;
  state.pending = before;
} // nmiHandler

// ---------------------------------------------------------------- enemy scripts
/**
 * Stinger enemy scripts (ST-M4) — a 1:1 transcription of the main-CPU code at
 * 8000h..95F0h (sources/asm/stinger/main.asm). The "script interpreter" is not
 * an interpreter at all: the object type is a state-machine state and the
 * counter is the time spent in it, so every type 00h..ADh is one routine of
 * the original, kept here under its original name with its address.
 *
 * Registers of the original become parameters:
 *   DE = the two byte record {type, counter} (A slots C224h+2n, B slots C230h+2n)
 *   IX = the sprite shadow (A slots C148h+4n, B slots C1A0h+4n)
 *   IY = the partner shadow (A slot n -> C1A8h+4n, i.e. B slot 2+n)
 *   HL = whatever the original had in HL when the handler was entered; it only
 *        ever matters as the FFFFh marker aimSector12 (927Bh) tests for.
 * All state lives at its original address and is reached through rd/wr, so the
 * regression can compare RAM byte for byte against tools/refemu.
 *
 * Uses the worker globals: rd, wr, rng, fillBytes.
 */

/* ---- RAM / hardware / ROM addresses (main.asm EQU block) ------------------ */
var ENEMY_LEVEL        = 0xC000;   // enemyLevel
var LIFE_STATUS_P1     = 0xC006;   // lifeStatusP1 (P2 = C007h); 3 = rock destroyed
var CUR_PLAYER         = 0xC030;   // curPlayer
var FRAME_COUNTER      = 0xC0A0;   // frameCounter
var GAME_STATE         = 0xC0A2;   // gameState (5 = playing)
var FRAME_COUNTER_HALF = 0xC0B5;   // frameCounterHalf
var LIFE_OVER          = 0xC0B9;   // lifeOver
var FORTRESS_SECT_P1   = 0xC0BB;   // fortressSectionP1 (P2 = C0BCh)
var CABINET_COCKTAIL   = 0xC0BD;   // cabinetCocktail
var SPR1_PLAYER        = 0xC140;   // spr1Player (hw Y = horizontal position of the ship)
var SHIP_X             = 0xC143;   // shipX      (hw X = vertical position)
var SPR1_ENEMY0        = 0xC148;   // spr1Enemy0 — A slot shadows
var ATTR0_SHADOW       = 0xC160;   // attr0Shadow
var SPR0_EXPLO0        = 0xC1A0;   // spr0Explo0 — B slot 0 shadow
var SPR0_ENEMY0        = 0xC1A8;   // spr0Enemy0 — B slot 2 shadow
var OBJ_REC_A0         = 0xC224;   // objRecA0
var OBJ_REC_B0         = 0xC230;   // objRecB0
var OBJ_REC_B2         = 0xC234;   // objRecB2
var ALTITUDE_ZONE      = 0xC310;   // altitudeZone (3 = no re-aiming / no firing)
var FG_MAP_PAGE_FLAGS  = 0xC530;   // fgMapPageFlags (2 = inside the fortress)
var SCRIPT_TIMER       = 0xC531;   // scriptTimer
var SOUNDLATCH         = 0xF800;   // command to the sound CPU
var SND_BOOM           = 0xF808;   // discrete explosion trigger
var MOVE_PATHS         = 0x4400;   // movePaths (ROM, 4400h..450Fh)
var SPAWN_RATE_MASK_T  = 0x8233;   // spawnRateMask table (ROM, 7 bytes)
var ROUND_FG_BLOCK     = 0x5700;   // roundFgBlock (ROM, section type table)

/* Transcription helpers for INC (IX+d) / DEC (IX+d) — 8 bit wrap, no flags. */
function iinc(a) { wr(a, (rd(a) + 1) & 0xFF); }
function idec(a) { wr(a, (rd(a) - 1) & 0xFF); }

/* ------------------------------------------------------------------------- */
/*  Interpreter frame                                                         */
/* ------------------------------------------------------------------------- */

/**
 * objBoundsKill (957Eh) — kills the object before its handler runs. Its
 * T-states are counted from the instructions of 957Eh..95E2h; they used to be
 * covered by the flat per-slot figure of run_script.
 */
function objBoundsKill(de, ix) {
  var l = ix & 0xFF;
  charge(15+10+55+4+7+(l >= 0x5F ? 12 : 7));       // 957E-9585
  if (l >= 0x5F) {                                 // B slots: 95D0h
    var page = rd(FG_MAP_PAGE_FLAGS);
    charge(13+7+10);                               // 95D0-95D5 (JP NZ, 10 T either way)
    if (page === 0x02) {
      var y = rd(ix + 3);
      charge(19+7+10);                             // 95D8-95DD
      if (y >= 0xE0) {
        charge(10);                                // 95E0 JP L_959A
        objBoundsClear(de, ix);
        return;
      }
    }
  }
  var code = rd(ix + 0);
  charge(19+7+10);                                 // 9587-958C
  if (code >= 0x05) {
    var yy = rd(ix + 3);
    charge(19+7+10);                               // 958F-9594
    if (yy >= 0x04) {
      charge(7+(yy < 0xF0 ? 11 : 5));              // 9597-9599 RET C
      if (yy < 0xF0) {
        return;                                    // still on screen
      }
    }
  }
  objBoundsClear(de, ix);
}

/** objBoundsClear (959Ah) — clear the shadow; type 4Ah clears its second sprite too. */
function objBoundsClear(de, ix) {
  var t = rd(de);
  charge(4+19+19+19+19+7+7+10);                    // 959A-95AA
  wr(ix + 0, 0); wr(ix + 1, 0); wr(ix + 2, 0); wr(ix + 3, 0);
  if (t === 0x4A) {                                // 95B3h: rocket = 2 sprites, 2 records
    charge(4+11+14+19+19+19+19+19+19+19+19+10);    // 95B3-95CF
    wr(de + 0, 0); wr(de + 1, 0); wr(de + 2, 0); wr(de + 3, 0);
    wr(ix + 4, 0); wr(ix + 5, 0); wr(ix + 6, 0); wr(ix + 7, 0);
    return;
  }
  charge(4+7+6+7+6+10);                            // 95AD-95B2
  wr(de + 0, 0);
  wr(de + 1, 0);
}

/** scr_end (8034h): POP IY/IX/HL/DE/BC + RET — the tail of every handler. */
var SCR_END_TSTATES = 14+14+10+10+10+10;

/**
 * run_script (8000h) — bounds check, counter += 1, dispatch through 5A00h.
 * Everything down to the JP (HL) of 8033h is counted from the instructions;
 * the handler itself is charged from SCRIPT_HANDLER_TSTATES.
 */
function run_script(de, ix, iy) {
  charge(11+11+11+15+15+17);                       // 8000-8007 pushes + CALL
  objBoundsKill(de, ix);
  var t = rd(de);
  charge(55+7+7);                                  // 800A-800C
  if (t === 0x00) {                                // 800E JR Z,scr_end
    charge(12+SCR_END_TSTATES);
    return;
  }
  charge(7+7+10);                                  // 800E not taken, 8010-8012
  if (t === 0xFF) {
    charge(SCR_END_TSTATES);
    return;
  }
  var t2 = rd(de);                                 // 801Ah re-reads it after the counter
  charge(6+7+4+7+6+7+7+10);                        // 8015-801D
  wr(de + 1, (rd(de + 1) + 1) & 0xFF);             // 8015h
  if (t2 === 0xFF) {
    charge(SCR_END_TSTATES);
    return;
  }
  charge(11+7+4+8+8+10+11+7+4+6+7+4+4+10+4);       // 8020-8033 the dispatch
  charge(scriptHandlerTstates(t2, de));
  runScriptHandler(t2, de, ix, iy, scriptHandlerAddr(t2));
}

/**
 * SCRIPT_HANDLER_TSTATES — what one script handler costs, measured from the
 * JP (HL) of 8033h to the RET of scr_end, so it covers the handler body, every
 * routine it calls and the five POPs that end it.
 *
 * The 120 handlers of 8034h..91E4h are transcribed without their own T-states,
 * so this is the one place where the cost is measured instead of counted.
 * Method: tools/refemu was run over sources/reference/input-play.txt,
 * sources/reference/input-attract.txt and ten random-input runs (the scripts of
 * tools/regress.mjs --random 1..10), 4000 frames each, timing every dispatched
 * handler from 8033h to the RET of 803Bh and keying it on the type byte, the
 * slot and frameCounter AND 03h.
 *
 * The routines whose cost depends on the data, not on the type, are NOT in
 * these figures: they charge for themselves in the transcription and their
 * address ranges were excluded from the sample, so nothing is counted twice.
 * Those are spawnRateMask 820Dh-8232h, spawnRandomShot 823Ah-8270h, the
 * popcorn tail scr_popcornCommon 8423h-844Ah and 8466h-849Eh, the enemy-shot
 * stubs 8690h-86D7h, companionInitShot 9266h-927Ah, aimSector12 927Bh-93A7h,
 * the twelve movers 93A8h-9413h, scr_animPopcorn 9481h-9498h and scr_animShot
 * 9524h-957Dh. Before that, aimSector12 alone made the buckets of the two
 * commonest types swing by 1 696 T in a single frame, and no key on the type
 * could follow it.
 *
 * What is left in each bucket is nearly always a single value — every one of
 * the 7 104 calls of type 1Dh in an A slot costs 450 T, all four of its counter
 * rows included — so the figure used is the mode of the bucket, i.e. the cost
 * of the branch the handler actually takes; only where no branch holds half the
 * samples is the mean used instead. The four columns are the frame counter and
 * the rows are the slot and the object counter (see scriptHandlerTstates);
 * where the transcription now charges for the branch itself, the whole row is
 * flat, and that flatness is the check that nothing data-dependent is left in
 * the row. Types that never ran get SCRIPT_HANDLER_DEFAULT_TSTATES, the median
 * of the measured buckets. This is what replaces the single flat figure of
 * 1107 T for the whole of run_script, which could not follow the swing from
 * 4076 to 9218 T that tools/refemu/profile.mjs reports for 8000h..95FFh.
 */
var SCRIPT_HANDLER_DEFAULT_TSTATES = [269, 269, 269, 269];

/**
 * Types 30h..3Bh are the twelve enemy shots. scr_shotDirNN, its mover and
 * scr_animShot charge for themselves, so the only thing left in the table for
 * them is the 68 T of scr_end — the same value in every bucket of all four,
 * which is why they share one row object.
 */
var SHOT_TYPE_ROW = [SCR_END_TSTATES, SCR_END_TSTATES, SCR_END_TSTATES, SCR_END_TSTATES];
var SHOT_TYPE_ROWS = {a: SHOT_TYPE_ROW, b: SHOT_TYPE_ROW, aF: SHOT_TYPE_ROW,
  bF: SHOT_TYPE_ROW, aH: SHOT_TYPE_ROW, bH: SHOT_TYPE_ROW};

var SCRIPT_HANDLER_TSTATES = {
  0x01: {a: [297, 295, 259, 259], aF: [335, 335, 335, 335], aH: [259, 259, 259, 259]},
  0x02: {a: [269, 315, 303, 269], aF: [338, 338, 338, 338], aH: [269, 269, 269, 269]},
  0x03: {a: [269, 328, 269, 269], aF: [338, 338, 338, 338], aH: [269, 269, 269, 269]},
  0x04: {a: [269, 269, 335, 269], aF: [338, 338, 338, 338], aH: [269, 269, 269, 269]},
  0x07: {a: [324, 269, 269, 269], aH: [269, 269, 269, 269]},
  0x09: {a: [269, 322, 269, 269], aF: [338, 338, 338, 338], aH: [269, 269, 269, 269]},
  0x0A: {a: [269, 316, 311, 269], aF: [338, 338, 338, 338], aH: [269, 269, 269, 269]},
  0x0C: {a: [269, 338, 269, 269], aH: [269, 269, 269, 269]},
  0x15: {a: [222, 222, 222, 222], aF: [228, 228, 228, 228], aH: [222, 222, 222, 222]},
  0x18: {a: [600, 547, 547, 547], aF: [627, 547, 547, 547], aH: [547, 547, 547, 547]},
  0x19: {a: [194, 194, 202, 198], aH: [170, 170, 170, 170]},
  0x1D: {a: [450, 450, 450, 450], b: [450, 450, 450, 450], aF: [450, 450, 450, 450], bF: [450, 450, 450, 450], aH: [450, 450, 450, 450]},
  0x20: {a: [460, 460, 460, 460], b: [460, 460, 460, 460], aF: [460, 460, 460, 460], bF: [460, 460, 460, 460], aH: [460, 460, 460, 460]},
  0x21: {a: [756, 687, 687, 756], aF: [763, 687, 738, 763], aH: [756, 687, 687, 756]},
  0x22: {a: [325, 256, 256, 325], aF: [332, 332, 332, 332], aH: [325, 325, 325, 325]},
  0x29: {a: [304, 285, 338, 285], aF: [297, 339, 380, 339], aH: [253, 221, 253, 285]},
  0x2D: {a: [330, 285, 399, 285], aF: [399, 399, 399, 399], aH: [285, 285, 285, 285]},
  0x2E: {a: [363, 285, 432, 285]},
  0x2F: {a: [217, 219, 218, 218], b: [218, 218, 219, 221], aH: [238, 238, 238, 238], bH: [238, 238, 238, 238]},
  0x45: {a: [98, 98, 98, 98], aF: [98, 98, 98, 98], aH: [169, 98, 98, 98]},
  0x50: {b: [336, 335, 328, 334], bF: [238, 238, 238, 238], bH: [274, 279, 279, 279]},
  0x51: {b: [98, 98, 98, 98], bF: [98, 98, 98, 98], bH: [98, 98, 98, 98]},
  0x52: {b: [345, 378, 345, 378], bH: [357, 357, 357, 357]}
};
for (var shotType = 0x30; shotType <= 0x3B; shotType++) {
  SCRIPT_HANDLER_TSTATES[shotType] = SHOT_TYPE_ROWS;
}

/**
 * The cost of the handler of type t for the object record at de, on this frame.
 * Three things the worker already knows split the measurement cleanly:
 *  - frameCounter AND 03h, because the animation steps branch on it
 *    (scr_animPopcorn 9481h: LD A,(frameCounter) / AND 03h / JP NZ,scr_end);
 *  - whether the record is an A slot (C224h..C22Ah) or a B slot
 *    (C230h..C23Ah), because 8467h tests the low byte of the record pointer
 *    against 30h and only the A slots run the 51 T of type test behind it;
 *  - whether the object counter has just reached 30h or 15h. 8425h lets the
 *    object fire when the counter is 30h (spawnRandomShot 823Ah + aimSector12
 *    927Bh, rows `aF`/`bF`), and 8474h hangs a parasite on it when it is 15h
 *    (8479h-849Eh, rows `aH`/`bH`). Both of those now charge for themselves in
 *    scr_popcornCommon, so for the popcorn types the rows have collapsed onto
 *    one another; they still key the handlers that were only measured.
 * With all three keys nearly every bucket of the measurement is a single value
 * (5093 of 5093 calls of type 1Dh in a B slot cost 450 T), so the figure used
 * is the mode of the bucket, i.e. the cost of the branch the handler actually
 * takes, and only where no branch dominates (the mode is less than half the
 * samples) is the mean used instead.
 */
function scriptHandlerTstates(t, de) {
  var v = SCRIPT_HANDLER_TSTATES[t];
  if (v === undefined) {
    return SCRIPT_HANDLER_DEFAULT_TSTATES[rd(0xC0A0) & 0x03];
  }
  var b = (de & 0xFF) >= 0x30;
  var counter = rd(de + 1);
  var row = counter === 0x30 ? (b ? v.bF : v.aF)
    : counter === 0x15 ? (b ? v.bH : v.aH) : null;
  if (!row) {
    row = b ? v.b : v.a;
  }
  row = row || v.a || v.b || SCRIPT_HANDLER_DEFAULT_TSTATES;
  return row[rd(0xC0A0) & 0x03];
}

/**
 * script_handlers (5A00h) — address of the handler of a type. Only the value
 * itself is needed (aimSector12 tests HL for FFFFh), the dispatch is the switch.
 */
var SCRIPT_HANDLER_ADDR = [
  0x8034, 0x806D, 0x80B4, 0x80BD, 0x80C6, 0x80CF, 0x80D8, 0x80E1,
  0x80EA, 0x80F3, 0x80FC, 0x8105, 0x810E, 0x8117, 0x8140, 0x8169,
  0x8182, 0x82A3, 0x82B5, 0x82C7, 0x8307, 0x831B, 0x8336, 0x834F,
  0x837D, 0x83BF, 0x83E0, 0x83F9, 0x83FA, 0x841D, 0x844B, 0x8454,
  0x845D, 0x84A1, 0x84E8, 0x850C, 0x8526, 0x8530, 0x853A, 0x856F,
  0x8583, 0x8601, 0x860A, 0x8616, 0x8622, 0x862B, 0x863F, 0x8653,
  0x8690, 0x8696, 0x869C, 0x86A2, 0x86A8, 0x86AE, 0x86B4, 0x86BA,
  0x86C0, 0x86C6, 0x86CC, 0x86D2, 0x86D8, 0x86F6, 0x8732, 0x8746,
  0x8783, 0x8793, 0x8799, 0x879B, 0x87C1, 0x87DA, 0x87F2, 0x882E,
  0x8863, 0x88A1, 0x8938, 0x8A16, 0x8A70, 0x8ABB, 0x8B20, 0x8B23,
  0x8B3C, 0x8C72, 0x8C8F, 0x8CF1, 0x8DA0, 0x8DB0, 0x8DC0, 0x8DD0,
  0x8DDA, 0x8EA8, 0x8EB3, 0x8F48, 0x8F4E, 0x8F54, 0x8F5A, 0x8F60,
  0x8F66, 0x8F6C, 0x8F72, 0x8F78, 0x8FB8, 0x8FED, 0x902B, 0x908C,
  0x908F, 0x9092, 0x9095, 0x909E, 0x909B, 0x9098, 0x90C6, 0x90F7,
  0x9132, 0x918F, 0x9195, 0x91C0, 0x91C9, 0x91D2, 0x91DB
];

/** script_handlers[type] (5A00h): 77h-8Fh are filler, 90h-ADh all go to 49h. */
function scriptHandlerAddr(t) {
  if (t <= 0x76) return SCRIPT_HANDLER_ADDR[t];
  if (t <= 0x8F) return 0x9218 + 3 * (t - 0x77);
  return 0x9263;
}

/** scr_end (8034h) — nothing to do, the caller's registers are restored. */
function scr_end() { }

/* ------------------------------------------------------------------------- */
/*  Shared helpers                                                            */
/* ------------------------------------------------------------------------- */

/** scriptAbort (857Ah) — true when the handler must be cut short (mine death). */
function scriptAbort() { return rd(SCRIPT_TIMER) !== 0x00; }

/** companionInitShot (9266h) — partner shadow IY = position of IX, code D4h, color 6. */
function companionInitShot(ix, iy) {
  charge(19+19+19+19+19+19+10);                    // 9266-927A, counted
  wr(iy + 0, rd(ix + 0));
  wr(iy + 1, 0xD4);
  wr(iy + 2, 0x06);
  wr(iy + 3, rd(ix + 3));
}

/**
 * aimSector12 (927Bh) — direction 0..11 from IX to the ship (to C1A0h when HL==FFFFh).
 *
 * Counted from the instructions, branch by branch. The routine divides by
 * repeated subtraction (92CFh and its three siblings), so what it costs depends
 * on the data: 200 T when a coordinate matches and the routine leaves at once,
 * more than a thousand when the two differences are far apart. That is exactly
 * what SCRIPT_HANDLER_TSTATES, keyed on the type and the frame counter, cannot
 * carry, so the routine charges for itself and the rows of that table were
 * re-measured with 927Bh-93A7h left out of the sample.
 */
function aimSector12(ix, hl) {
  charge(15+4+7+10);                                               // 927B-9280
  var iy;
  if ((hl >> 8) !== 0xFF) {
    charge(14);                                                    // 9290
    iy = SPR1_PLAYER;
  } else if ((hl & 0xFF) !== 0xFF) {
    charge(4+7+10+14);                                             // 9283-9286, 9290
    iy = SPR1_PLAYER;
  } else {
    charge(4+7+10+14+10);                                          // 9283-928D
    iy = SPR0_EXPLO0;
  }
  var a, c;
  // Note: the "CP 01h / JP C" tests at 92DD, 930A, 9337, 9364 are dead code in
  // the original (A is never 0 there), so sectors 1, 4, 7 and 10 never occur.
  charge(19+19+4+10);                                              // 9294-929B
  if (rd(ix + 0) < rd(iy + 0)) {                                   // 92ABh
    charge(19+19+4+10);                                            // 92AB-92B2
    if (rd(ix + 3) < rd(iy + 3)) {                                 // 92E5h
      charge(19+19+4+10);                                          // 92E5-92EC
      a = (rd(iy + 0) - rd(ix + 0)) & 0xFF; if (a === 0) return aimExit(3);
      c = a;
      charge(4+19+19+4+10);                                        // 92EF-92F7
      a = (rd(iy + 3) - rd(ix + 3)) & 0xFF; if (a === 0) return aimExit(6);
      return aimDiv(a, c, 5, 3);                                   // 92FA-930F
    }
    charge(10+19+19+4+10);                                         // 92B5, 9312-9319
    a = (rd(iy + 0) - rd(ix + 0)) & 0xFF; if (a === 0) return aimExit(9);
    c = a;
    charge(4+19+19+4+10);                                          // 931C-9324
    a = (rd(ix + 3) - rd(iy + 3)) & 0xFF; if (a === 0) return aimExit(6);
    return aimDiv(a, c, 6, 8);                                     // 9327-933C
  }
  charge(19+19+4+10);                                              // 929E-92A5
  if (rd(ix + 3) < rd(iy + 3)) {                                   // 92B8h
    charge(19+19+4+10);                                            // 92B8-92BF
    a = (rd(ix + 0) - rd(iy + 0)) & 0xFF; if (a === 0) return aimExit(3);
    c = a;
    charge(4+19+19+4+10);                                          // 92C2-92CA
    a = (rd(iy + 3) - rd(ix + 3)) & 0xFF; if (a === 0) return aimExit(0);
    return aimDiv(a, c, 0, 2);                                     // 92CD-92E2
  }
  charge(10+19+19+4+10);                                           // 92A8, 933F-9346
  a = (rd(ix + 0) - rd(iy + 0)) & 0xFF; if (a === 0) return aimExit(0);
  c = a;
  charge(4+19+19+4+10);                                            // 9349-9351
  a = (rd(ix + 3) - rd(iy + 3)) & 0xFF; if (a === 0) return aimExit(9);
  return aimDiv(a, c, 11, 9);                                      // 9354-9369
}

/**
 * The divide and the test behind it, shared by the four quadrants (92CDh-92E2h
 * and its three copies): LD B,00h, the loop, then LD A,B / CP 00h / JP Z and
 * the dead CP 01h / JP C. Counted from the instructions.
 */
function aimDiv(a, c, ifZero, ifMore) {
  charge(7);                                                       // 92CD LD B,00h
  var b = divSteps(a, c);
  charge(4+7+10);                                                  // 92D7-92DA
  if (b === 0) return aimExit(ifZero);
  charge(7+10+10);                                                 // 92DD-92E2
  return aimExit(ifMore);
}

/**
 * The twelve exits 936Ch..93A3h: LD A,n and a JP to the POP IY / RET of 93A5h.
 * Sector 0Bh sits at 93A3h and falls through, so it is the one without the JP.
 */
function aimExit(s) {
  charge(7+(s === 0x0B ? 0 : 10)+14+10);                           // 936C-93A7
  return s;
}

/** aimSector12 inner loop (92CFh) — A / C by repeated subtraction. */
function divSteps(a, c) {
  var b = 0;
  while (a >= c) {
    charge(4+10+4+10);                                             // 92CF-92D4, no carry
    a -= c; b = (b + 1) & 0xFF;
  }
  charge(4+10);                                                    // 92CF-92D0, JP C taken
  return b;
}

/**
 * moveL2 (93A8h) .. moveL2U1 (940Ah) — the twelve 2 px/frame movers. Counted
 * from the instructions: 23 T per INC/DEC (IX+d) and 10 T for the RET, so 56 T
 * for the two straight directions and 79 T for the diagonals. They charge for
 * themselves, so 93A8h-9413h is left out of the SCRIPT_HANDLER_TSTATES sample.
 */
var MOVE2_TSTATES = 23+23+10;                     // straight: two INC/DEC + RET
var MOVE3_TSTATES = 23+23+23+10;                  // diagonal: three INC/DEC + RET

/** moveL2 (93A8h) — direction 0/12: Y-2. */
function moveL2(ix)   { charge(MOVE2_TSTATES); idec(ix + 0); idec(ix + 0); }
/** moveL2D1 (93AFh) — direction 1/12. */
function moveL2D1(ix) { charge(MOVE3_TSTATES); idec(ix + 0); idec(ix + 0); iinc(ix + 3); }
/** moveL1D2 (93B9h) — direction 2/12. */
function moveL1D2(ix) { charge(MOVE3_TSTATES); idec(ix + 0); iinc(ix + 3); iinc(ix + 3); }
/** moveD2 (93C3h) — direction 3/12. */
function moveD2(ix)   { charge(MOVE2_TSTATES); iinc(ix + 3); iinc(ix + 3); }
/** moveR1D2 (93CAh) — direction 4/12. */
function moveR1D2(ix) { charge(MOVE3_TSTATES); iinc(ix + 0); iinc(ix + 3); iinc(ix + 3); }
/** moveR2D1 (93D4h) — direction 5/12. */
function moveR2D1(ix) { charge(MOVE3_TSTATES); iinc(ix + 0); iinc(ix + 0); iinc(ix + 3); }
/** moveR2 (93DEh) — direction 6/12. */
function moveR2(ix)   { charge(MOVE2_TSTATES); iinc(ix + 0); iinc(ix + 0); }
/** moveR2U1 (93E5h) — direction 7/12. */
function moveR2U1(ix) { charge(MOVE3_TSTATES); iinc(ix + 0); iinc(ix + 0); idec(ix + 3); }
/** moveR1U2 (93EFh) — direction 8/12. */
function moveR1U2(ix) { charge(MOVE3_TSTATES); iinc(ix + 0); idec(ix + 3); idec(ix + 3); }
/** moveU2 (93F9h) — direction 9/12. */
function moveU2(ix)   { charge(MOVE2_TSTATES); idec(ix + 3); idec(ix + 3); }
/** moveL1U2 (9400h) — direction 10/12. */
function moveL1U2(ix) { charge(MOVE3_TSTATES); idec(ix + 0); idec(ix + 3); idec(ix + 3); }
/** moveL2U1 (940Ah) — direction 11/12. */
function moveL2U1(ix) { charge(MOVE3_TSTATES); idec(ix + 0); idec(ix + 0); idec(ix + 3); }

/**
 * pathStep (9414h) — one step of movePaths: byte HL[counter>>4], bits b0 Y-1,
 * b1 Y-1 X+1, b2 X+1, b3 X+1 Y+1, b4 Y+1, b5 Y+1 X-1, b6 X-1, b7 X-1 Y-1.
 * The second half of each diagonal is a `CALL NZ` that tests the flags left by
 * the INC/DEC of the first half, so it is skipped when that byte reached 0.
 */
function pathStep(de, ix, hl) {
  var a = rd(de + 1) >> 4;
  var addr = (hl & 0xFF00) | (((hl & 0xFF) + a) & 0xFF);   // ADD A,L without carry
  a = rd(addr);
  if (a & 0x01) { idec(ix + 0); }
  if (a & 0x02) { idec(ix + 0); if (rd(ix + 0) !== 0) iinc(ix + 3); }
  if (a & 0x04) { iinc(ix + 3); }
  if (a & 0x08) { iinc(ix + 3); if (rd(ix + 3) !== 0) iinc(ix + 0); }
  if (a & 0x10) { iinc(ix + 0); }
  if (a & 0x20) { iinc(ix + 0); if (rd(ix + 0) !== 0) idec(ix + 3); }
  if (a & 0x40) { idec(ix + 3); }
  if (a & 0x80) { idec(ix + 3); if (rd(ix + 3) !== 0) idec(ix + 0); }
}

/**
 * spawnRateMask (820Dh) — frame mask by enemyLevel, table 8233h. Counted from
 * the instructions: LD HL / LD A, then i pairs of CP + JR-not-taken (14 T each)
 * and i INC HL (6 T each), the taken JR (19 T with its CP) when one is taken,
 * and LD H,(HL) / RET. i = 6 falls off the end of the CP chain, so it has no
 * taken JR: 160 T against the 159 T of i = 5.
 */
function spawnRateMask() {
  var lvl = rd(ENEMY_LEVEL), i = 0;
  if (lvl >= 0x08) i++;
  if (lvl >= 0x10) i++;
  if (lvl >= 0x18) i++;
  if (lvl >= 0x20) i++;
  if (lvl >= 0x28) i++;
  if (lvl >= 0x30) i++;
  charge(10+13+14*i+(i < 6 ? 7+12 : 0)+6*i+7+10);  // 820D-8232
  return rd(SPAWN_RATE_MASK_T + i);
}

/**
 * spawnRandomShot (823Ah) — aimed shot 30h+dir into the first free B slot.
 *
 * Counted from the instructions. The routine is bimodal — the early RET NZ of
 * 8241h on most frames, the six-slot scan of L_824Dh plus aimSector12 on the
 * others — and the arm it takes cannot be read off the object type, so it too
 * charges for itself; 823Ah-8270h is left out of the SCRIPT_HANDLER_TSTATES
 * sample, and so are spawnRateMask and companionInitShot, which charge here.
 */
function spawnRandomShot(ix) {
  charge(17);                                      // 823A CALL spawnRateMask
  var mask = spawnRateMask();
  charge(13+4);                                    // 823D-8240
  if ((rd(FRAME_COUNTER) & mask) !== 0) {
    charge(11);                                    // 8241 RET NZ taken
    return;
  }
  charge(5+15+7+10+14);                            // 8241 not taken, 8242-8249
  var rec = OBJ_REC_B0, shadow = SPR0_EXPLO0;
  for (var b = 6; b > 0; b--) {
    charge(7+7+10);                                // 824D-8250
    if (rd(rec) === 0x00) {
      charge(17);                                  // 8262 CALL aimSector12
      var s = aimSector12(ix, rec);                // HL = the record found by the scan
      charge(7+7);                                 // 8265-8267
      wr(rec, (s + 0x30) & 0xFF);
      charge(6+10);                                // 8268-8269
      wr(rec + 1, 0x00);
      charge(17);                                  // 826B CALL companionInitShot
      companionInitShot(ix, shadow);
      charge(14+10);                               // 826E-8270
      return;
    }
    charge(6+6+10+10+10+10+(b > 1 ? 13 : 8));      // 8253-825D (DJNZ 13/8)
    rec += 2; shadow += 4;
  }
  charge(14+10);                                   // 825F-8261
}

/** spawnTypeC (8271h) — type C into the first free B slot, sprite from IX. */
function spawnTypeC(ix, c) {
  if ((rd(FRAME_COUNTER) & spawnRateMask()) !== 0) return;
  var rec = OBJ_REC_B0, shadow = SPR0_EXPLO0;
  for (var b = 6; b > 0; b--) {
    if (rd(rec) === 0x00) {
      wr(rec, c);
      wr(rec + 1, 0x00);
      companionInitShot(ix, shadow);
      return;
    }
    rec += 2; shadow += 4;
  }
}

// roundTableByte (1E1Dh) lives in the video section above — it also charges T-states.

/** lifeStatus address of the current player (8DE7h, 8E97h, 8EB3h). */
function lifeStatusAddr() {
  return rd(CUR_PLAYER) === 0x01 ? LIFE_STATUS_P1 : LIFE_STATUS_P1 + 1;
}

/* ------------------------------------------------------------------------- */
/*  Animations (9468h..9577h)                                                 */
/* ------------------------------------------------------------------------- */

/** scr_animOrb (9468h) — 9A..9C on odd half-frames. */
function scr_animOrb(ix) {
  if ((rd(FRAME_COUNTER_HALF) & 1) !== 0) return;
  var a = (rd(ix + 1) + 1) & 0xFF;
  if (a >= 0x9D) a = 0x9A;
  wr(ix + 1, a);
}

/**
 * scr_animPopcorn (9481h) — BB..BD every 4 frames. Counted from the
 * instructions: 31 T on the three frames in four that leave at 9486h, then
 * 19+4+7 for the read and the compare and 12 T for the JR C of 948Fh while the
 * code is still below BEh against 7+7 T when it wraps back to BBh — 101 T
 * without the wrap, 103 T with it. That two-T step was previously added on top
 * of the measured table by a helper that guessed the animation phase from the
 * sprite code before the handler had run; now the routine charges for itself
 * and 9481h-9498h is left out of the SCRIPT_HANDLER_TSTATES sample.
 */
function scr_animPopcorn(ix) {
  charge(13+7+10);                                 // 9481-9486
  if ((rd(FRAME_COUNTER) & 0x03) !== 0) return;
  var a = (rd(ix + 1) + 1) & 0xFF;
  charge(19+4+7+(a >= 0xBE ? 7+7 : 12)+19+10);     // 9489-9496
  if (a >= 0xBE) a = 0xBB;
  wr(ix + 1, a);
}

/** scr_animParasite (9499h) — BF..C1, color 3 every 32 frames. */
function scr_animParasite(ix) {
  if ((rd(FRAME_COUNTER) & 0x1F) === 0) wr(ix + 2, 0x03);
  if ((rd(FRAME_COUNTER_HALF) & 1) !== 0) return;
  var a = (rd(ix + 1) + 1) & 0xFF;
  if (a >= 0xC2) a = 0xBF;
  wr(ix + 1, a);
}

/** scr_animSaucer (94BEh) — 85..87 every 4 counter frames. */
function scr_animSaucer(de, ix) {
  if ((rd(de + 1) & 0x03) !== 0) return;
  var a = (rd(ix + 1) + 1) & 0xFF;
  if (a >= 0x88) a = 0x85;
  wr(ix + 1, a);
}

/** scr_animBeetle (94D6h) — 91..93 every 8 counter frames, color 4 every 32. */
function scr_animBeetle(de, ix) {
  if ((rd(FRAME_COUNTER) & 0x1F) === 0) wr(ix + 2, 0x04);
  if ((rd(de) & 0x07) !== 0) return;              // DE points at the counter here
  var a = (rd(ix + 1) + 1) & 0xFF;
  if (a >= 0x94) a = 0x91;
  wr(ix + 1, a);
}

/** scr_animWindmill (94F9h) — 8E -> 8F -> 90 on even counter frames. */
function scr_animWindmill(de, ix) {
  if ((rd(de) & 1) !== 0) return;                 // DE points at the counter here
  var a = rd(ix + 1);
  if (a === 0x8E) { wr(ix + 1, 0x8F); return; }
  if (a === 0x8F) { wr(ix + 1, 0x90); return; }
  wr(ix + 1, 0x8E);
}

/**
 * scr_animShot (9524h) — enemy shots on odd half-frames: 98<->99, D2<->D3,
 * D4->98, B9<->BA. Counted from the instructions: 31 T on the even half-frames
 * that leave at 9529h, otherwise 13+8+10+19 for the read, 17 T per CP/JP Z pair
 * of the 952Fh..954Ah chain (one to six of them) and 19+10 for the LD (IX+1)
 * and the JP to scr_end. The chain position depends on the sprite code, which
 * is why the 96..181 T of this routine cannot sit in a table keyed on the
 * object type; it charges for itself and 9524h-957Dh is left out of the sample.
 */
function scr_animShot(ix) {
  charge(13+8+10);                                 // 9524-9529
  if ((rd(FRAME_COUNTER_HALF) & 1) === 0) return;
  var a = rd(ix + 1);
  var k = a === 0x98 ? 1 : a === 0x99 ? 2 : a === 0xD2 ? 3
    : a === 0xD3 ? 4 : a === 0xD4 ? 5 : 6;         // CP/JP Z pairs executed
  charge(19+17*k+19+10);                           // 952C-9551
  if (a === 0x98) { wr(ix + 1, 0x99); return; }
  if (a === 0x99) { wr(ix + 1, 0xD4); return; }
  if (a === 0xD2) { wr(ix + 1, 0xD3); return; }
  if (a === 0xD3) { wr(ix + 1, 0xD2); return; }
  if (a === 0xD4) { wr(ix + 1, 0x98); return; }
  if (a === 0xB9) { wr(ix + 1, 0xBA); return; }
  wr(ix + 1, 0xB9);
}

/** scr_explosionFrames (865Ah) — sprite H+0/1/2 by the counter, then objClear. */
function scr_explosionFrames(de, ix, h) {
  var a = rd(de);                                 // DE points at the counter here
  if (a >= 0x18) { objClear(de, ix); return; }
  if (a >= 0x10) h = (h + 2) & 0xFF;
  else if (a >= 0x08) h = (h + 1) & 0xFF;
  wr(ix + 1, h);
  if (rd(GAME_STATE) !== 0x05) return;
  wr(SND_BOOM, 0x05);
}

/** objClear (866Ah) — wipe the record (DE points at the counter) and the shadow. */
function objClear(de, ix) {
  wr(de, 0x00);
  wr(de - 1, 0x00);
  wr(ix + 0, 0x00); wr(ix + 1, 0x00); wr(ix + 2, 0x00); wr(ix + 3, 0x00);
}

/* ------------------------------------------------------------------------- */
/*  01h-0Ch beetle                                                            */
/* ------------------------------------------------------------------------- */

/**
 * scr_steerByType (8042h) — with the counter in [10h,40h) the full 12-direction
 * move runs, otherwise only one axis by type. Returns DE advanced to the counter.
 */
function scr_steerByType(de, ix, move) {
  var c = rd(de);
  var a = rd(de + 1);
  if (a >= 0x10 && a < 0x40) { move(ix); return de + 1; }
  if (c < 0x03) idec(ix + 0);
  else if (c < 0x06) iinc(ix + 3);
  else if (c < 0x09) iinc(ix + 0);
  else idec(ix + 3);
  return de + 1;
}

/** scr_beetleCommon (8073h) — re-aim every 50h frames, then try to fire. */
function scr_beetleCommon(de, ix, iy, hl) {
  if (rd(de) >= 0x50 && rd(ALTITUDE_ZONE) !== 0x03) {
    wr(de, 0x00);
    wr(de - 1, (aimSector12(ix, hl) + 1) & 0xFF);
  }
  scr_beetleShoot(de, ix, iy);
}

/** scr_beetleShoot (808Ah) — shot into the partner B slot from enemyLevel 8. */
function scr_beetleShoot(de, ix, iy) {
  var lvl = rd(ENEMY_LEVEL);
  if (lvl < 0x08) { scr_animBeetle(de, ix); return; }
  if (lvl < 0x10 && rd(FRAME_COUNTER) >= 0x05) { scr_animBeetle(de, ix); return; }
  var hl = de + 0x0F;                             // partner record (C234h+2n)
  if (rd(hl) !== 0x00) { scr_animBeetle(de, ix); return; }
  wr(hl, (aimSector12(ix, hl) + 0x30) & 0xFF);
  companionInitShot(ix, iy);
  scr_animBeetle(de, ix);
}

/** scr_beetleDir01 (806Dh) — beetle 91-93, direction 0/12. */
function scr_beetleDir01(de, ix, iy) { scr_beetleCommon(scr_steerByType(de, ix, moveL2), ix, iy, 0x93A8); }
/** scr_beetleDir02 (80B4h) — direction 1/12. */
function scr_beetleDir02(de, ix, iy) { scr_beetleCommon(scr_steerByType(de, ix, moveL2D1), ix, iy, 0x93AF); }
/** scr_beetleDir03 (80BDh) — direction 2/12. */
function scr_beetleDir03(de, ix, iy) { scr_beetleCommon(scr_steerByType(de, ix, moveL1D2), ix, iy, 0x93B9); }
/** scr_beetleDir04 (80C6h) — direction 3/12. */
function scr_beetleDir04(de, ix, iy) { scr_beetleCommon(scr_steerByType(de, ix, moveD2), ix, iy, 0x93C3); }
/** scr_beetleDir05 (80CFh) — direction 4/12. */
function scr_beetleDir05(de, ix, iy) { scr_beetleCommon(scr_steerByType(de, ix, moveR1D2), ix, iy, 0x93CA); }
/** scr_beetleDir06 (80D8h) — direction 5/12. */
function scr_beetleDir06(de, ix, iy) { scr_beetleCommon(scr_steerByType(de, ix, moveR2D1), ix, iy, 0x93D4); }
/** scr_beetleDir07 (80E1h) — direction 6/12. */
function scr_beetleDir07(de, ix, iy) { scr_beetleCommon(scr_steerByType(de, ix, moveR2), ix, iy, 0x93DE); }
/** scr_beetleDir08 (80EAh) — direction 7/12. */
function scr_beetleDir08(de, ix, iy) { scr_beetleCommon(scr_steerByType(de, ix, moveR2U1), ix, iy, 0x93E5); }
/** scr_beetleDir09 (80F3h) — direction 8/12; also the filler for types 77h-8Fh. */
function scr_beetleDir09(de, ix, iy) { scr_beetleCommon(scr_steerByType(de, ix, moveR1U2), ix, iy, 0x93EF); }
/** scr_beetleDir10 (80FCh) — direction 9/12. */
function scr_beetleDir10(de, ix, iy) { scr_beetleCommon(scr_steerByType(de, ix, moveU2), ix, iy, 0x93F9); }
/** scr_beetleDir11 (8105h) — direction 10/12. */
function scr_beetleDir11(de, ix, iy) { scr_beetleCommon(scr_steerByType(de, ix, moveL1U2), ix, iy, 0x9400); }
/** scr_beetleDir12 (810Eh) — direction 11/12. */
function scr_beetleDir12(de, ix, iy) { scr_beetleCommon(scr_steerByType(de, ix, moveL2U1), ix, iy, 0x940A); }

/* ------------------------------------------------------------------------- */
/*  0Dh-10h orb with satellites                                               */
/* ------------------------------------------------------------------------- */

/**
 * scr_aimedShotIfAligned (819Bh) — fires 30h+dir into the partner B slot when
 * the ship is within 10h of the orb. Returns the value left in A, which the
 * caller compares against 10h to decide whether to keep moving.
 */
function scr_aimedShotIfAligned(de, ix, iy) {
  var a = rd(ix + 0);
  if (a >= 0xA0) return a;                        // 81A0h RET NC
  if (a >= 0x20) {
    a = rd(SHIP_X);
    var b = rd(ix + 3);
    if (a < b) { var c = a; a = b; b = c; }
    a = (a - b) & 0xFF;
    if (a >= 0x10) return a;                      // 81B5h RET NC
    if (rd(ENEMY_LEVEL) < 0x07) return 0;
  } else {
    if (rd(ENEMY_LEVEL) < 0x10) return 0;         // 81DAh
  }
  if ((de & 0xFF) >= 0x30) return 0;              // 81BDh: A slots only
  var hl = de + 0x10;
  if (rd(hl) !== 0x00) return 0;
  wr(hl, (aimSector12(ix, hl) + 0x30) & 0xFF);
  companionInitShot(ix, iy);
  wr(ix + 2, 0x06);
  return 0;
}

/** scr_fireOrbShot (81E3h) — A slot drops a satellite (type 0E/0F, sprite 9A) into its partner. */
function scr_fireOrbShot(de, iy) {
  if ((de & 0xFF) >= 0x2A) return;                // A slots 0..2 only
  var hl = de + 0x10;
  if (rd(hl) !== 0x00) return;
  wr(iy + 0, 0xFF);
  wr(iy + 1, 0x9A);
  wr(iy + 2, 0x03);
  var a = rng();
  wr(iy + 3, a);
  wr(hl, a >= 0x80 ? 0x0E : 0x0F);
  wr(hl + 1, 0x00);
}

/** scr_orbMineDown (8117h) — orb 9A-9C: Y-2 X+1; aligned with the ship -> type 0F. */
function scr_orbMineDown(de, ix, iy) {
  if (rd(ix + 0) >= 0xA0) spawnTypeC(ix, 0x30);
  scr_fireOrbShot(de, iy);
  var a = scr_aimedShotIfAligned(de, ix, iy);
  if (a < 0x10) { wr(de, 0x0F); wr(de + 1, 0x00); return; }
  idec(ix + 0); idec(ix + 0); iinc(ix + 3);
  scr_animOrb(ix);
}

/** scr_orbMineUp (8140h) — orb: Y-2 X-1; aligned -> type 10. */
function scr_orbMineUp(de, ix, iy) {
  if (rd(ix + 0) >= 0xA0) spawnTypeC(ix, 0x31);
  scr_fireOrbShot(de, iy);
  var a = scr_aimedShotIfAligned(de, ix, iy);
  if (a < 0x10) { wr(de, 0x10); wr(de + 1, 0x00); return; }
  idec(ix + 0); idec(ix + 0); idec(ix + 3);
  scr_animOrb(ix);
}

/** scr_orbDriftUpLeft (8169h) — Y-1, X-1 (-2/-3 once the counter passes 18h/28h). */
function scr_orbDriftUpLeft(de, ix) {
  var a = rd(de + 1);
  if (a >= 0x28) idec(ix + 3);
  if (a >= 0x18) idec(ix + 3);
  idec(ix + 0); idec(ix + 3);
  scr_animOrb(ix);
}

/** scr_orbDriftDownLeft (8182h) — Y-1, X+1 (+2/+3 by the counter). */
function scr_orbDriftDownLeft(de, ix) {
  var a = rd(de + 1);
  if (a >= 0x28) iinc(ix + 3);
  if (a >= 0x18) iinc(ix + 3);
  idec(ix + 0); iinc(ix + 3);
  scr_animOrb(ix);
}

/* ------------------------------------------------------------------------- */
/*  11h-14h unused / spiky ball                                               */
/* ------------------------------------------------------------------------- */

/** scr_unused11 (82A3h) — empty. */
function scr_unused11() { }
/** scr_unused12 (82B5h) — empty. */
function scr_unused12() { }

/** scr_spikyBallAnim (82EFh) — 88..8A every 8 counter frames. */
function scr_spikyBallAnim(de, ix) {
  if ((rd(de + 1) & 0x07) !== 0) return;
  var a = (rd(ix + 1) + 1) & 0xFF;
  if (a >= 0x8B) a = 0x88;
  wr(ix + 1, a);
}

/** scr_spikyBallLeft (82C7h) — spiky ball 88-8A: Y-2; rng >= FEh fires and switches to 14h. */
function scr_spikyBallLeft(de, ix, iy) {
  idec(ix + 0); idec(ix + 0);
  if (rng() >= 0xFE) {
    var hl = de + 0x10;
    if (rd(hl) === 0x00) {
      wr(de + 1, 0x00);
      wr(de, 0x14);
      wr(hl, (aimSector12(ix, hl) + 0x30) & 0xFF);
      companionInitShot(ix, iy);
    }
  }
  scr_spikyBallAnim(de, ix);
}

/** scr_spikyBallBack (8307h) — from counter 10h onwards Y+3 (backs off to the right). */
function scr_spikyBallBack(de, ix) {
  if (rd(de + 1) >= 0x10) { iinc(ix + 0); iinc(ix + 0); iinc(ix + 0); }
  scr_spikyBallAnim(de, ix);
}

/* ------------------------------------------------------------------------- */
/*  15h-18h jellyfish                                                         */
/* ------------------------------------------------------------------------- */

/** scr_jellyAnim (8365h) — 9D/9E every 8 frames. */
function scr_jellyAnim(ix) {
  if ((rd(FRAME_COUNTER) & 0x07) !== 0) return;
  var a = (rd(ix + 1) + 1) & 0xFF;
  if (a >= 0x9F) a = 0x9D;
  wr(ix + 1, a);
}

/** scr_jellyDiagDown (831Bh) — jellyfish 9D-9F: Y-2 X+2; counter 30h -> type 18. */
function scr_jellyDiagDown(de, ix) {
  idec(ix + 0); idec(ix + 0); iinc(ix + 3); iinc(ix + 3);
  if (rd(de + 1) < 0x30) { scr_jellyAnim(ix); return; }
  wr(de + 1, 0x00);
  wr(de, 0x18);
}

/** scr_jellyUpAccel (8336h) — Y-1, X-1..-3 by the counter. */
function scr_jellyUpAccel(de, ix) {
  idec(ix + 0);
  var a = rd(de + 1), b = 1;
  if (a >= 0x10) { b++; if (a >= 0x20) b++; }
  while (b-- > 0) idec(ix + 3);
  scr_jellyAnim(ix);
}

/** scr_jellyDownAccel (834Fh) — Y-1, X+1..+3 by the counter. */
function scr_jellyDownAccel(de, ix) {
  idec(ix + 0);
  var a = rd(de + 1), b = 1;
  if (a >= 0x10) { b++; if (a >= 0x20) b++; }
  while (b-- > 0) iinc(ix + 3);
  scr_jellyAnim(ix);
}

/** scr_jellyPath (837Dh) — path 44F0h; counter >= C0h picks 16h/17h by the ship. */
function scr_jellyPath(de, ix) {
  pathStep(de, ix, 0x44F0);
  if (rd(de + 1) >= 0xC0) {                        // 83ABh
    wr(de + 1, 0x00);
    wr(de, rd(SHIP_X) >= rd(ix + 3) ? 0x16 : 0x17);
    return;
  }
  if ((rd(FRAME_COUNTER) & 0x07) !== 0) return;
  var a = (rd(ix + 1) + 1) & 0xFF;
  if (a >= 0xA0) a = 0x9E;
  wr(ix + 1, a);
  if (a !== 0x9F) return;
  spawnTypeC(ix, 0x30);
}

/* ------------------------------------------------------------------------- */
/*  19h-1Ch, 22h death markers and parasite                                   */
/* ------------------------------------------------------------------------- */

/** scr_dieBonus300 (83BFh) — mine death: explosion B1-B3, then the "300" sign B4, then scriptTimer=FFh. */
function scr_dieBonus300(de, ix) {
  var a = rd(de + 1);
  if (a >= 0x18) { wr(SCRIPT_TIMER, 0xFF); objClear(de + 1, ix); return; }
  if (a < 0x10) { scr_explosionFrames(de + 1, ix, 0xB1); return; }
  wr(ix + 1, 0xB4);
  wr(ix + 2, 0x07);
}

/** scr_dieBonusB6 (83E0h) — explosion A8-AA, then the sign B6. */
function scr_dieBonusB6(de, ix) {
  var a = rd(de + 1);
  if (a >= 0x18) { objClear(de + 1, ix); return; }
  if (a < 0x10) { scr_explosionFrames(de + 1, ix, 0xA8); return; }
  wr(ix + 1, 0xB6);
  wr(ix + 2, 0x06);
}

/** scr_nop1B (83F9h) — NOP, falls into 1Ch. */
function scr_nop1B(de, ix) { scr_parasiteAttachedBelow(de, ix); }

/** scr_parasiteAttachedBelow (83FAh) — parasite BF-C1 stuck below the ship; after F0h -> 21h. */
function scr_parasiteAttachedBelow(de, ix) {
  wr(ix + 2, 0x06);
  var a = rd(de + 1);
  if (a < 0xF0) {
    wr(ix + 0, rd(SPR1_PLAYER));
    wr(ix + 3, (rd(SHIP_X) + 0x10) & 0xFF);
  } else {
    wr(de + 1, a);                                 // 8415h: the counter is kept
    wr(de, 0x21);
  }
  scr_animParasite(ix);
}

/** scr_parasiteAttachedAbove (84E8h) — stuck above the ship; after F0h -> 21h, counter 0. */
function scr_parasiteAttachedAbove(de, ix) {
  wr(ix + 2, 0x06);
  var a = rd(de + 1);
  if (a < 0xF0) {
    wr(ix + 0, rd(SPR1_PLAYER));
    wr(ix + 3, (rd(SHIP_X) - 0x10) & 0xFF);
  } else {
    wr(de + 1, 0x00);
    wr(de, 0x21);
  }
  scr_animParasite(ix);
}

/** scr_parasiteHunt (84A1h) — parasite BF-C1 on path 4400h, fires 33h, latches onto the ship. */
function scr_parasiteHunt(de, ix) {
  pathStep(de, ix, MOVE_PATHS);
  spawnTypeC(ix, 0x33);
  var a = (rd(SPR1_PLAYER) - rd(ix + 0)) & 0xFF;
  if (!(a < 0x08 || a >= 0xF8)) { scr_animParasite(ix); return; }
  a = rd(SHIP_X);
  var b = rd(ix + 3);
  if (a >= b) {
    if (((a - b) & 0xFF) >= 0x10) { scr_animParasite(ix); return; }
    wr(de, 0x22);
  } else {
    if (((b - a) & 0xFF) >= 0x10) { scr_animParasite(ix); return; }
    wr(de, 0x1C);
  }
  wr(de + 1, 0x00);
  scr_animParasite(ix);
}

/* ------------------------------------------------------------------------- */
/*  1Dh-20h, 26h, 27h popcorn                                                 */
/* ------------------------------------------------------------------------- */

/**
 * scr_popcornCommon (8423h) — at counter 30h fire and re-aim into 1Dh..20h,
 * otherwise an A slot copies itself into its partner B slot (level >= 7).
 */
function scr_popcornCommon(de, ix, iy, hl) {
  charge(6+7+7+10);                                // 8423-8427
  de = de + 1;
  if (rd(de) === 0x30) {
    charge(17);                                    // 842A CALL spawnRandomShot
    spawnRandomShot(ix);
    charge(17);                                    // 842D CALL aimSector12
    var a = aimSector12(ix, hl);
    // 8430-8443: LD C,1Dh and the CP/JP C chain that turns the sector into the
    // new type. Counted from the instructions; it is the only thing that moves
    // in this branch, and it moves by 46 T, which is exactly the spread the
    // measurement showed in the `aF`/`bF` rows before this was charged here.
    charge(7+(a < 0x03 ? 17 : a < 0x06 ? 34+4 : a < 0x09 ? 51+8 : 51+12));
    var c = 0x1D;
    if (a >= 0x09) c += 3; else if (a >= 0x06) c += 2; else if (a >= 0x03) c += 1;
    charge(6+4+7+6+10);                            // 8444-8448
    wr(de - 1, c);
    scr_animPopcorn(ix);
    return;
  }
  charge(4+7+10);                                  // 8466-8469
  if ((de & 0xFF) >= 0x30) { scr_animPopcorn(ix); return; }   // 8466h: A slots only
  charge(13+7+(rd(ENEMY_LEVEL) >= 0x07 ? 12 : 7)); // 846C-8471 (JR NC 12/7)
  if (rd(ENEMY_LEVEL) < 0x07) {
    charge(7+7+10);                                // 8473-8476
    if (rd(de) !== 0x15) { scr_animPopcorn(ix); return; }
  }
  charge(10+11+7+7+10);                            // 8479-8480
  var partner = de + 0x0F;
  if (rd(partner) !== 0x00) { scr_animPopcorn(ix); return; }
  // 8483-849E, 169 T counted from the instructions — the same 169 T the
  // measurement showed as the spread of the `aH`/`bH` rows.
  charge(19+19+19+19+19+11+14+19+7+6+7+10);
  wr(iy + 0, 0xFF);
  wr(iy + 1, 0xBB);
  wr(iy + 2, 0x07);
  wr(iy + 3, rd(ix + 3));
  var own = rd(partner - 0x10);                    // 8498h: LD A,(IY-16) = own type
  wr(partner, own);
  wr(partner + 1, own);                            // the counter gets the type too
  scr_animPopcorn(ix);
}

/** scr_popcornRight (841Dh) — popcorn BB-BD on path 4480h. */
function scr_popcornRight(de, ix, iy) { pathStep(de, ix, 0x4480); scr_popcornCommon(de, ix, iy, 0x4480); }
/** scr_popcornDownLeft (844Bh) — path 4490h. */
function scr_popcornDownLeft(de, ix, iy) { pathStep(de, ix, 0x4490); scr_popcornCommon(de, ix, iy, 0x4490); }
/** scr_popcornUpLeft (8454h) — path 44A0h. */
function scr_popcornUpLeft(de, ix, iy) { pathStep(de, ix, 0x44A0); scr_popcornCommon(de, ix, iy, 0x44A0); }
/** scr_popcornUpRight (845Dh) — path 44B0h. */
function scr_popcornUpRight(de, ix, iy) { pathStep(de, ix, 0x44B0); scr_popcornCommon(de, ix, iy, 0x44B0); }

/** scr_popcornTrack (853Ah) — closes in on the ship: Y-1 every 4 frames, or lines X up. */
function scr_popcornTrack(de, ix) {
  if (rd(SPR1_PLAYER) >= rd(ix + 0)) {             // no borrow -> 8555h
    if ((rd(FRAME_COUNTER) & 0x03) === 0) idec(ix + 0);
    scr_animPopcorn(ix);
    return;
  }
  var a = (rd(SHIP_X) - rd(ix + 3)) & 0xFF;
  if (a < 0x10) { idec(ix + 3); scr_animPopcorn(ix); return; }
  if (a >= 0xF0) { iinc(ix + 3); scr_animPopcorn(ix); return; }
  if ((rd(FRAME_COUNTER) & 0x03) === 0) idec(ix + 0);
  scr_animPopcorn(ix);
}

/** scr_popcornDash (856Fh) — Y -= 10h per frame. */
function scr_popcornDash(de, ix) {
  wr(ix + 0, (rd(ix + 0) - 0x10) & 0xFF);
  scr_animPopcorn(ix);
}

/* ------------------------------------------------------------------------- */
/*  23h-25h windmill                                                          */
/* ------------------------------------------------------------------------- */

/** scr_windmillLeft (850Ch) — windmill 8E-90: Y-1 and a shot into the partner slot. */
function scr_windmillLeft(de, ix, iy) {
  idec(ix + 0);
  de = de + 1;
  var hl = de + 0x0F;
  if (rd(hl) === 0x00) {
    wr(hl, 0x30);
    wr(hl + 1, 0x00);
    companionInitShot(ix, iy);
  }
  scr_animWindmill(de, ix);
}

/** scr_windmillUp (8526h) — path 4470h. */
function scr_windmillUp(de, ix) { pathStep(de, ix, 0x4470); scr_animWindmill(de + 1, ix); }
/** scr_windmillDown (8530h) — path 4480h. */
function scr_windmillDown(de, ix) { pathStep(de, ix, 0x4480); scr_animWindmill(de + 1, ix); }

/* ------------------------------------------------------------------------- */
/*  28h-2Eh saucer                                                            */
/* ------------------------------------------------------------------------- */

/**
 * scr_saucerCommon (8589h) — outside the fortress just Y-1; inside it re-aims
 * every 80h frames. Returns false when it has already run the animation itself
 * (the original throws the caller's return address away and jumps there).
 */
function scr_saucerCommon(de, ix, hl) {
  if (rd(FG_MAP_PAGE_FLAGS) !== 0x02) {            // 8591h
    idec(ix + 0);
    scr_animSaucer(de, ix);
    return false;
  }
  if (scriptAbort()) { scr_animSaucer(de, ix); return false; }
  if ((rd(de + 1) & 0x7F) !== 0) {                 // 85F7h
    if ((rd(FRAME_COUNTER) & 1) === 0) return true;
    scr_animSaucer(de, ix);
    return false;
  }
  var a = rng();
  var t;
  if (a >= 0xF8) t = 0x28;
  else if (a >= 0xE0) t = 0x2B;
  else if (a >= 0xD0) t = 0x2A;
  else {
    a = aimSector12(ix, hl);
    if (a === 0x00) t = 0x29;
    else if (a < 0x03) t = 0x2A;
    else if (a < 0x06) t = 0x2B;
    else if (a === 0x06) t = 0x2C;
    else if (a < 0x09) t = 0x2D;
    else t = 0x2E;
  }
  wr(de, t);
  scr_animSaucer(de, ix);
  return false;
}

/** scr_saucerIdle (8583h) — saucer 85-87, type 28h: no movement of its own. */
function scr_saucerIdle(de, ix, iy, hl) {
  if (!scr_saucerCommon(de, ix, hl)) return;
  scr_animSaucer(de, ix);
}
/** scr_saucerLeft (8601h) — Y-1. */
function scr_saucerLeft(de, ix, iy, hl) {
  if (!scr_saucerCommon(de, ix, hl)) return;
  idec(ix + 0);
  scr_animSaucer(de, ix);
}
/** scr_saucerLeftDown (860Ah) — Y-1, X+1. */
function scr_saucerLeftDown(de, ix, iy, hl) {
  if (!scr_saucerCommon(de, ix, hl)) return;
  idec(ix + 0); iinc(ix + 3);
  scr_animSaucer(de, ix);
}
/** scr_saucerRightDown (8616h) — Y+1, X+1. */
function scr_saucerRightDown(de, ix, iy, hl) {
  if (!scr_saucerCommon(de, ix, hl)) return;
  iinc(ix + 0); iinc(ix + 3);
  scr_animSaucer(de, ix);
}
/** scr_saucerRight (8622h) — Y+1. */
function scr_saucerRight(de, ix, iy, hl) {
  if (!scr_saucerCommon(de, ix, hl)) return;
  iinc(ix + 0);
  scr_animSaucer(de, ix);
}
/** scr_saucerRightUp (862Bh) — Y+1, X-1 (only from X >= 99h). */
function scr_saucerRightUp(de, ix, iy, hl) {
  if (!scr_saucerCommon(de, ix, hl)) return;
  iinc(ix + 0);
  if (rd(ix + 3) >= 0x99) idec(ix + 3);
  scr_animSaucer(de, ix);
}
/** scr_saucerLeftUp (863Fh) — Y-1, X-1 (only from X >= 99h). */
function scr_saucerLeftUp(de, ix, iy, hl) {
  if (!scr_saucerCommon(de, ix, hl)) return;
  idec(ix + 0);
  if (rd(ix + 3) >= 0x99) idec(ix + 3);
  scr_animSaucer(de, ix);
}

/* ------------------------------------------------------------------------- */
/*  2Fh explosion, 30h-3Bh enemy shots                                        */
/* ------------------------------------------------------------------------- */

/** scr_explodeCloud (8653h) — explosion A8/A9/AA every 8 frames, color 7, SND_BOOM. */
function scr_explodeCloud(de, ix) {
  wr(ix + 2, 0x07);
  scr_explosionFrames(de + 1, ix, 0xA8);
}

/**
 * scr_shotDir00 (8690h) .. scr_shotDir11 (86D2h) — the twelve enemy-shot types
 * 30h..3Bh. Each stub is a CALL to its mover and a JP to scr_animShot, 27 T
 * counted from the instructions; the mover and the animation charge for
 * themselves, so 8690h-86D7h, 93A8h-9413h and 9524h-957Dh are all left out of
 * the SCRIPT_HANDLER_TSTATES sample and what is left in its rows for these
 * types is the 68 T of scr_end.
 */
var SHOT_DIR_TSTATES = 17+10;                     // CALL mover + JP scr_animShot

/** scr_shotDir00 (8690h) — enemy shot, direction 0/12. */
function scr_shotDir00(de, ix) { charge(SHOT_DIR_TSTATES); moveL2(ix); scr_animShot(ix); }
/** scr_shotDir01 (8696h) — enemy shot, direction 1/12. */
function scr_shotDir01(de, ix) { charge(SHOT_DIR_TSTATES); moveL2D1(ix); scr_animShot(ix); }
/** scr_shotDir02 (869Ch) — enemy shot, direction 2/12. */
function scr_shotDir02(de, ix) { charge(SHOT_DIR_TSTATES); moveL1D2(ix); scr_animShot(ix); }
/** scr_shotDir03 (86A2h) — enemy shot, direction 3/12. */
function scr_shotDir03(de, ix) { charge(SHOT_DIR_TSTATES); moveD2(ix); scr_animShot(ix); }
/** scr_shotDir04 (86A8h) — enemy shot, direction 4/12. */
function scr_shotDir04(de, ix) { charge(SHOT_DIR_TSTATES); moveR1D2(ix); scr_animShot(ix); }
/** scr_shotDir05 (86AEh) — enemy shot, direction 5/12. */
function scr_shotDir05(de, ix) { charge(SHOT_DIR_TSTATES); moveR2D1(ix); scr_animShot(ix); }
/** scr_shotDir06 (86B4h) — enemy shot, direction 6/12. */
function scr_shotDir06(de, ix) { charge(SHOT_DIR_TSTATES); moveR2(ix); scr_animShot(ix); }
/** scr_shotDir07 (86BAh) — enemy shot, direction 7/12. */
function scr_shotDir07(de, ix) { charge(SHOT_DIR_TSTATES); moveR2U1(ix); scr_animShot(ix); }
/** scr_shotDir08 (86C0h) — enemy shot, direction 8/12. */
function scr_shotDir08(de, ix) { charge(SHOT_DIR_TSTATES); moveR1U2(ix); scr_animShot(ix); }
/** scr_shotDir09 (86C6h) — enemy shot, direction 9/12. */
function scr_shotDir09(de, ix) { charge(SHOT_DIR_TSTATES); moveU2(ix); scr_animShot(ix); }
/** scr_shotDir10 (86CCh) — enemy shot, direction 10/12. */
function scr_shotDir10(de, ix) { charge(SHOT_DIR_TSTATES); moveL1U2(ix); scr_animShot(ix); }
/** scr_shotDir11 (86D2h) — enemy shot, direction 11/12. */
function scr_shotDir11(de, ix) { charge(SHOT_DIR_TSTATES); moveL2U1(ix); scr_animShot(ix); }

/* ------------------------------------------------------------------------- */
/*  3Ch-3Fh dot sphere, rocket flame, saucer shell                            */
/* ------------------------------------------------------------------------- */

/** scr_dotSphere (86D8h) — dot sphere 8B-8D on path 44C0h. */
function scr_dotSphere(de, ix) {
  pathStep(de, ix, 0x44C0);
  if ((rd(de + 1) & 0x07) !== 0) return;
  var a = (rd(ix + 1) + 1) & 0xFF;
  if (a >= 0x8E) a = 0x8B;
  wr(ix + 1, a);
}

/**
 * scr_dotSphereDead (86F6h) — when hit, the sphere fills every free B slot with
 * a shot 30h+n starting at direction 0Ah and becomes type 1Ah.
 */
function scr_dotSphereDead(de, ix) {
  var rec = OBJ_REC_B0, shadow = SPR0_EXPLO0, c = 0x0A;
  for (var b = 6; b > 0; b--) {
    if (rd(rec) === 0x00) {
      var a = c;
      if (a >= 0x0C) { a = 0x00; c = 0x00; }
      wr(rec, (a + 0x30) & 0xFF);
      wr(rec + 1, 0x00);
      companionInitShot(ix, shadow);
      c = (c + 1) & 0xFF;
    }
    rec += 2; shadow += 4;
  }
  wr(de, 0x1A);
}

/** scr_rocketFlame (8732h) — vanishes once the previous slot (DE-2) is free. */
function scr_rocketFlame(de, ix) {
  if (rd(de - 2) !== 0x00) return;
  wr(de, 0x00);
  wr(ix + 0, 0x00);
  wr(ix + 3, 0x00);
}

/** scr_saucerShell (8746h) — shot-down saucer: explosion B1-B3, then gone. */
function scr_saucerShell(de, ix) {
  var a = rd(de + 1);
  var h = 0xB1;
  if (a >= 0x18) {
    wr(de + 1, 0x00); wr(de, 0x00);
    wr(ix + 0, 0x00); wr(ix + 1, 0x00); wr(ix + 2, 0x00); wr(ix + 3, 0x00);
    return;
  }
  if (a >= 0x10) h = 0xB3; else if (a >= 0x08) h = 0xB2;
  wr(ix + 2, 0x07);
  wr(ix + 1, h);
  if (rd(GAME_STATE) !== 0x05) return;
  wr(SND_BOOM, 0x05);
}

/* ------------------------------------------------------------------------- */
/*  40h-45h eyeball at the fortress, flower mine                              */
/* ------------------------------------------------------------------------- */

/** scr_eyeballStatic (8783h) — static eye F4; after 50h frames -> type 43. */
function scr_eyeballStatic(de, ix) {
  if (rd(de + 1) < 0x50) return;
  wr(de + 1, 0x00);
  wr(de, 0x43);
}
/** scr_eyeballStatic41 (8793h) — type 41 -> 40. */
function scr_eyeballStatic41(de) { wr(de, 0x40); }
/** scr_eyeballStatic42 (8799h) — type 42 -> 40. */
function scr_eyeballStatic42(de) { scr_eyeballStatic41(de); }

/** scr_eyeballMove (879Bh) — X-1 while the counter is below 90h, then X+1; anim F4-F6 every 16. */
function scr_eyeballMove(de, ix) {
  if (rd(de + 1) >= 0x90) iinc(ix + 3); else idec(ix + 3);
  if ((rd(FRAME_COUNTER) & 0x0F) !== 0) return;
  var a = (rd(ix + 1) + 1) & 0xFF;
  if (a >= 0xF7) a = 0xF4;
  wr(ix + 1, a);
}

/** scr_dieEyeball (87C1h) — explosion F1-F3, then the sign B5. */
function scr_dieEyeball(de, ix) {
  var a = rd(de + 1);
  if (a >= 0x18) { objClear(de + 1, ix); return; }
  if (a < 0x10) { scr_explosionFrames(de + 1, ix, 0xF1); return; }
  wr(ix + 1, 0xB5);
  wr(ix + 2, 0x07);
}

/** scr_flowerMine (87DAh) — flower mine E5-EA, static, animates every 8 frames. */
function scr_flowerMine(de, ix) {
  if ((rd(FRAME_COUNTER) & 0x07) !== 0) return;
  var a = (rd(ix + 1) + 1) & 0xFF;
  if (a >= 0xEB) a = 0xE5;
  wr(ix + 1, a);
}

/* ------------------------------------------------------------------------- */
/*  46h-48h, 63h-65h hangar pods                                              */
/* ------------------------------------------------------------------------- */

/** scr_podDownLeft (87F2h) — pod CC->D1->D2/D3: X+1 Y+1, then Y-1 X+1, doubled from 80h. */
function scr_podDownLeft(de, ix) {
  var a = rd(de + 1);
  if (a < 0x40) {
    if (a < 0x18) { iinc(ix + 0); idec(ix + 3); return; }
    wr(ix + 1, 0xD1);
    idec(ix + 0); iinc(ix + 3);
    return;
  }
  var s = (rd(ix + 1) + 1) & 0xFF;
  if (s >= 0xD4) s = 0xD2;
  wr(ix + 1, s);
  if (rd(de + 1) >= 0x80) { idec(ix + 0); iinc(ix + 3); }
  idec(ix + 0); iinc(ix + 3);
}

/** scr_podUp (882Eh) — pod: X-1, then X+1, doubled from 80h. */
function scr_podUp(de, ix) {
  var a = rd(de + 1);
  if (a < 0x40) {
    if (a < 0x18) { idec(ix + 3); return; }
    wr(ix + 1, 0xD1);
    iinc(ix + 3);
    return;
  }
  var s = (rd(ix + 1) + 1) & 0xFF;
  if (s >= 0xD4) s = 0xD2;
  wr(ix + 1, s);
  if (rd(de + 1) >= 0x80) iinc(ix + 3);
  iinc(ix + 3);
}

/** scr_podUpLeft (8863h) — pod: Y-1 X-1, then Y+1 X+1, doubled from 80h. */
function scr_podUpLeft(de, ix) {
  var a = rd(de + 1);
  if (a < 0x40) {
    if (a < 0x18) { idec(ix + 0); idec(ix + 3); return; }
    wr(ix + 1, 0xD1);
    iinc(ix + 0); iinc(ix + 3);
    return;
  }
  var s = (rd(ix + 1) + 1) & 0xFF;
  if (s >= 0xD4) s = 0xD2;
  wr(ix + 1, s);
  if (rd(de + 1) >= 0x80) { iinc(ix + 0); iinc(ix + 3); }
  iinc(ix + 0); iinc(ix + 3);
}

/** scr_pod63 (8F78h) — pod CD->D2..: Y-1 X-1, then Y+1 X-1, doubled from 41h. */
function scr_pod63(de, ix) {
  var a = rd(de + 1);
  if (a < 0x40) {
    if (a < 0x18) { idec(ix + 0); idec(ix + 3); return; }
    wr(ix + 1, 0xCD);
    iinc(ix + 0); idec(ix + 3);
    return;
  }
  var s = rd(ix + 1);
  s = (s === 0xD2) ? 0xD3 : 0xD2;
  wr(ix + 1, s);
  if (rd(de + 1) >= 0x41) { iinc(ix + 0); idec(ix + 3); }
  iinc(ix + 0); idec(ix + 3);
}

/** scr_pod64 (8FB8h) — pod: X+1, then X-1, doubled from 80h. */
function scr_pod64(de, ix) {
  var a = rd(de + 1);
  if (a < 0x40) {
    if (a < 0x18) { iinc(ix + 3); return; }
    wr(ix + 1, 0xCD);
    idec(ix + 3);
    return;
  }
  var s = rd(ix + 1);
  s = (s === 0xD2) ? 0xD3 : 0xD2;
  wr(ix + 1, s);
  if (rd(de + 1) >= 0x80) idec(ix + 3);
  idec(ix + 3);
}

/** scr_pod65 (8FEDh) — pod: Y+1 X-1, then Y-1 X-1, doubled from 80h. */
function scr_pod65(de, ix) {
  var a = rd(de + 1);
  if (a < 0x40) {
    if (a < 0x18) { iinc(ix + 0); idec(ix + 3); return; }
    wr(ix + 1, 0xD1);
    idec(ix + 0); idec(ix + 3);
    return;
  }
  var s = (rd(ix + 1) + 1) & 0xFF;
  if (s >= 0xD4) s = 0xD2;
  wr(ix + 1, s);
  if (rd(de + 1) >= 0x80) { idec(ix + 0); idec(ix + 3); }
  idec(ix + 0); idec(ix + 3);
}

/* ------------------------------------------------------------------------- */
/*  49h, 90h-ADh ground missile / launchers                                   */
/* ------------------------------------------------------------------------- */

/**
 * scr_groundMissile (88A1h) — ground missile EC..F0/FD..FF and back every 8
 * frames; at 70h it jumps Y-5, from 78h it turns into a shot 30h+dir (sprite B9).
 */
function scr_groundMissile(de, ix, iy, hl) {
  var a = rd(de + 1);
  var s;
  if (a < 0x08) s = 0xEC;
  else if (a < 0x10) s = 0xED;
  else if (a < 0x18) s = 0xEE;
  else if (a < 0x20) s = 0xEF;
  else if (a < 0x28) s = 0xF0;
  else if (a < 0x30) s = 0xFD;
  else if (a < 0x38) s = 0xFE;
  else if (a < 0x40) s = 0xFF;
  else if (a < 0x48) s = 0xFE;
  else if (a < 0x50) s = 0xFD;
  else if (a < 0x58) s = 0xF0;
  else if (a < 0x60) s = 0xEF;
  else if (a < 0x68) s = 0xEE;
  else if (a < 0x70) s = 0xED;
  else if (a === 0x70) { wr(ix + 0, (rd(ix + 0) - 0x05) & 0xFF); s = 0xEB; }
  else if (a < 0x78) s = 0xEB;
  else {
    wr(de, (aimSector12(ix, hl) + 0x30) & 0xFF);
    wr(ix + 1, 0xB9);
    wr(ix + 2, 0x04);
    wr(SOUNDLATCH, 0x14);
    return;
  }
  wr(ix + 1, s);
}

/* ------------------------------------------------------------------------- */
/*  4Ah-4Fh rocket                                                            */
/* ------------------------------------------------------------------------- */

/** rocketShotSpawn (89F7h) — shot type C with sprite D4 at Y+8 into a free B slot. */
function rocketShotSpawn(ix, iy, hl, c) {
  wr(hl, c);
  wr(iy + 0, (rd(ix + 0) + 0x08) & 0xFF);
  wr(iy + 1, 0xD4);
  wr(iy + 2, 0x03);
  wr(iy + 3, rd(ix + 3));
}

/** scr_rocketAnim (8A2Dh) — sound 0Ch, then both rocket sprites +2 every 8 counter frames. */
function scr_rocketAnim(de, ix) {
  if (rd(GAME_STATE) === 0x05) wr(SOUNDLATCH, 0x0C);
  if ((rd(de + 1) & 0x07) !== 0) return;
  var a = (rd(ix + 1) + 2) & 0xFF;
  if (a >= 0x95) a = 0x8F;
  wr(ix + 1, a);
  a = (rd(ix + 5) + 2) & 0xFF;
  if (a >= 0x95) a = 0x90;
  wr(ix + 5, a);
}

/** scr_rocketShots (8968h) — the rocket sprays shots 30h..33h into free B slots 2..5. */
function scr_rocketShots(de, ix) {
  var a = (rd(SHIP_X) - rd(ix + 3)) & 0xFF;
  if (a < 0x18 || a >= 0xF0) { wr(de, 0x4B); return; }
  var rec = OBJ_REC_B2, shadow = SPR0_ENEMY0, c = 0x30;
  for (var b = 4; b > 0; b--) {
    if (rd(rec) === 0x00) rocketShotSpawn(ix, shadow, rec, c);
    rec += 2; shadow += 4; c++;
  }
  scr_rocketAnim(de, ix);
}

/** scr_rocketRise (8938h) — rocket 8F/90 (2 sprites): rises, launches 4Ch/4Fh pods and shots. */
function scr_rocketRise(de, ix) {
  var launching = false;
  if (rd(LIFE_OVER) !== 0x01 && roundTableByte(ROUND_FG_BLOCK) === 0x02) {
    if (rd(de + 1) >= 0xF0) { wr(de, 0x4B); return; }
    if (rd(ix + 0) === 0x70) launching = true;
  }
  if (!launching) {
    var a = (rd(ix + 0) - 0x01) & 0xFF;
    wr(ix + 0, a);
    wr(ix + 4, (a + 0x10) & 0xFF);
    scr_rocketShots(de, ix);
    return;
  }
  if (rng() < 0xF0) { scr_rocketShots(de, ix); return; }      // 899Ah
  var lvl = rd(ENEMY_LEVEL);
  var slots = (lvl < 0x10) ? 2 : (lvl === 0x18 ? 3 : 4);
  var rec = OBJ_REC_A0, shadow = SPR1_ENEMY0, free = -1;
  for (var b = slots; b > 0; b--) {
    if (rd(rec) === 0x00) { free = rec; break; }
    rec += 2; shadow += 4;
  }
  if (free < 0) { scr_rocketShots(de, ix); return; }
  wr(free, rng() >= 0x80 ? 0x4C : 0x4F);
  wr(shadow + 0, (rd(ix + 0) + 0x08) & 0xFF);
  wr(shadow + 1, 0xE5);
  wr(shadow + 2, 0x04);
  wr(shadow + 3, rd(ix + 3));
  scr_rocketShots(de, ix);
}

/** scr_rocketFall (8A16h) — while the partner (DE+2) is 3Eh fall Y+3, otherwise vanish. */
function scr_rocketFall(de, ix) {
  if (rd(de + 2) !== 0x3E) {                       // 8A61h
    fillBytes(ix, 0x04, 0x00);
    wr(de, 0x00);
    wr(de + 1, 0x00);
    return;
  }
  var a = (rd(ix + 0) + 0x03) & 0xFF;
  wr(ix + 0, a);
  wr(ix + 4, (a + 0x10) & 0xFF);
  scr_rocketAnim(de, ix);
}

/** scr_launchedToSaucer (8A70h) — pod launched from the rocket: Y +-2, X+3, then type 28. */
function scr_launchedToSaucer(de, ix) {
  var a = rng();
  if (a >= 0x90) {
    if (a < 0xA0) wr(ix + 0, (rd(ix + 0) - 0x02) & 0xFF);
    else wr(ix + 0, (rd(ix + 0) + 0x02) & 0xFF);
  }
  a = (rd(ix + 3) + 0x03) & 0xFF;
  if (a < 0xA0) { wr(ix + 3, a); scr_animSaucer(de, ix); return; }
  if (a < 0xE0 && rng() >= 0xA0) {                 // 8AA5h
    wr(ix + 3, (rd(ix + 3) + 0x03) & 0xFF);
    scr_animSaucer(de, ix);
    return;
  }
  wr(de, 0x28);
  scr_animSaucer(de, ix);
}

/** scr_explodeRocket (8ABBh) — 2x2 explosion AB/AC, AD/AE, AF/B0, 95/96, then 8 bytes cleared. */
function scr_explodeRocket(de, ix) {
  if (rd(GAME_STATE) === 0x05) wr(SND_BOOM, 0x05);
  var a = rd(de + 1);
  if (a < 0x08) {
    wr(ix + 1, 0xAB); wr(ix + 2, 0x07); wr(ix + 5, 0xAC); wr(ix + 6, 0x07);
    return;
  }
  if (a < 0x10) { wr(ix + 1, 0xAD); wr(ix + 5, 0xAE); return; }
  if (a < 0x18) { wr(ix + 1, 0xAF); wr(ix + 5, 0xB0); return; }
  if (a < 0x20) { wr(ix + 1, 0x95); wr(ix + 5, 0x96); return; }
  fillBytes(ix, 0x08, 0x00);
  wr(de, 0x00);
  wr(de + 2, 0x00);
}

/** scr_explodeRocket2 (8B20h) — the second half of 4Dh: nothing of its own. */
function scr_explodeRocket2() { }

/** scr_launchedUp (8B23h) — pod launched from the rocket: X+2, Y-1; at X >= D0h -> type 28. */
function scr_launchedUp(de, ix) {
  var a = rd(ix + 3);
  if (a >= 0xD0) { wr(de, 0x28); scr_animSaucer(de, ix); return; }
  wr(ix + 3, (a + 0x02) & 0xFF);
  idec(ix + 0);
  scr_animSaucer(de, ix);
}

/* ------------------------------------------------------------------------- */
/*  50h-52h vacuum sphere                                                     */
/* ------------------------------------------------------------------------- */

/** scr_vacuumRetreat (8C5Bh) — sprites 85/86, all four parts move Y+1. */
function scr_vacuumRetreat(ix) {
  wr(ix + 1, 0x85);
  wr(ix + 5, 0x86);
  iinc(ix + 0); iinc(ix + 4); iinc(ix + 8); iinc(ix + 12);
}

/** scr_vacuumPull (8C07h) — drags the ship towards the sphere and beeps every frame. */
function scr_vacuumPull(ix, c) {
  var a = rd(SPR1_PLAYER);
  var b = rd(ix + 0);
  if (a >= b) return;                              // 8C0Eh: ship already past it
  b = (a + 1) & 0xFF;
  if ((c & 1) !== 0) {
    b = (b + 1) & 0xFF;
    if ((c & 0x03) === 0) b = (b + 1) & 0xFF;
  }
  wr(SPR1_PLAYER, b);
  wr(SOUNDLATCH, 0x08);
  a = rd(SHIP_X);
  var e = rd(ix + 3);
  if (a >= e) {                                    // 8C33h
    b = (a - 1) & 0xFF;
    if ((c & 1) !== 0) {
      b = (b - 1) & 0xFF;
      if ((c & 0x03) === 0) b = (b - 1) & 0xFF;
    }
  } else {                                         // 8C45h
    b = (a + 1) & 0xFF;
    if ((c & 1) !== 0) {
      b = (b + 1) & 0xFF;
      if ((c & 0x03) === 0) b = (b + 1) & 0xFF;
    }
  }
  wr(SHIP_X, b);
}

/**
 * scr_vacuumSphere (8B3Ch) — 2x2 vacuum sphere 85-8E. The counter only advances
 * one in eight frames (run_script adds 1, the handler takes 1 back in 7 of 8):
 * 0-6 approach, 7-1Fh flicker, 20h-DFh suction, E0h-EFh flicker, F0h+ retreat.
 */
function scr_vacuumSphere(de, ix) {
  if (rd(LIFE_OVER) === 0x01) { scr_vacuumRetreat(ix); return; }
  var c = rd(FRAME_COUNTER);
  if ((c & 0x07) !== 0) wr(de + 1, (rd(de + 1) - 1) & 0xFF);
  var a = rd(de + 1);
  if (a < 0x07) { idec(ix + 0); idec(ix + 4); idec(ix + 8); idec(ix + 12); return; }
  if (a < 0x0D || (a >= 0x10 && a < 0x15) || (a >= 0x18 && a < 0x1B)) {
    wr(ix + 1, 0x89); wr(ix + 5, 0x8A); return;    // 8BA0h
  }
  if (a < 0x20) { wr(ix + 1, 0x8B); wr(ix + 5, 0x8C); return; }   // 8BABh
  if (a >= 0xE0) {
    if (a < 0xE3 || (a >= 0xE8 && a < 0xEA)) { wr(ix + 1, 0x8B); wr(ix + 5, 0x8C); return; }
    if (a < 0xF0) { wr(ix + 1, 0x89); wr(ix + 5, 0x8A); return; }
    scr_vacuumRetreat(ix);
    return;
  }
  // 8BB6h: suction phase
  wr(ix + 1, 0x8D);
  wr(ix + 5, 0x8E);
  if (c < 0x80) {
    if (rd(ix + 3) < 0xB0) { iinc(ix + 3); iinc(ix + 7); iinc(ix + 11); iinc(ix + 15); }
  } else {
    if (rd(ix + 3) >= 0x10) { idec(ix + 3); idec(ix + 7); idec(ix + 11); idec(ix + 15); }
  }
  if ((c & 0x03) === 0) {                          // 8BEFh: colour cycles 3..6
    var col = (rd(ix + 2) + 3) & 0xFF;
    if (col >= 0x07) col = 0x03;
    wr(ix + 2, col);
    wr(ix + 6, col);
  }
  scr_vacuumPull(ix, c);
}

/** scr_vacuumPart (8C72h) — side sprite: vanishes unless C230h is 50h/52h/58h. */
function scr_vacuumPart(de, ix) {
  var a = rd(OBJ_REC_B0);
  if (a === 0x50 || a === 0x52 || a === 0x58) return;
  scr_partClear(de, ix);
}

/** scr_partClear (8C84h) — free the record and hide the sprite. */
function scr_partClear(de, ix) {
  wr(de, 0x00);
  wr(ix + 0, 0x00);
  wr(ix + 3, 0x00);
}

/** scr_explodeBig (8C8Fh) — 2x2 explosion D5/D9/DD/E1 (+1..3), then C230h-C237h and C1A0h-C1AFh cleared. */
function scr_explodeBig(de, ix) {
  wr(SND_BOOM, 0x8C);                              // A = high byte of the handler address
  var a = rd(de + 1);
  var base;
  if (a < 0x08) base = 0xD5;
  else if (a < 0x10) base = 0xD9;
  else if (a < 0x18) base = 0xDD;
  else if (a < 0x20) base = 0xE1;
  else {
    fillBytes(OBJ_REC_B0, 0x08, 0x00);
    fillBytes(SPR0_EXPLO0, 0x10, 0x00);
    return;
  }
  var p = SPR0_EXPLO0;                             // 8CCDh: always B slot 0
  wr(p + 1, base);
  wr(p + 5, (base + 1) & 0xFF);
  wr(p + 9, (base + 2) & 0xFF);
  wr(p + 13, (base + 3) & 0xFF);
  wr(p + 2, 0x07); wr(p + 6, 0x07); wr(p + 10, 0x07); wr(p + 14, 0x07);
}

/* ------------------------------------------------------------------------- */
/*  53h-57h eyeball                                                           */
/* ------------------------------------------------------------------------- */

/** scr_eyeAnim (8D79h) — F4-F6 every 32 frames (16 while on F6). */
function scr_eyeAnim(ix) {
  var b = (rd(ix + 1) === 0xF6) ? 0x0F : 0x1F;
  if ((rd(FRAME_COUNTER) & b) !== 0) return;
  var a = (rd(ix + 1) + 1) & 0xFF;
  if (a >= 0xF7) a = 0xF4;
  wr(ix + 1, a);
}

/** scr_eyeReaim (8D42h) — every 20h frames: rng < 40h stops (57h), otherwise aims 53h-56h. */
function scr_eyeReaim(de, ix, hl) {
  if (rd(ALTITUDE_ZONE) === 0x03) { scr_eyeAnim(ix); return; }
  wr(de + 1, 0x00);
  var t;
  if (rng() < 0x40) t = 0x57;
  else {
    var a = aimSector12(ix, hl);
    if (a < 0x03) t = 0x53;
    else if (a < 0x06) t = 0x54;
    else if (a < 0x09) t = 0x55;
    else t = 0x56;
  }
  wr(de, t);
  scr_eyeAnim(ix);
}

/** scr_eyeClone (8CFEh) — from enemyLevel 8 an A slot copies itself into its partner. */
function scr_eyeClone(de, ix, iy) {
  var lvl = rd(ENEMY_LEVEL);
  if (lvl < 0x08) return;
  var a = lvl >> 3;
  if (a > 0x04) a = 0x04;
  var b = (0x22 + 2 * a + 1) & 0xFF;               // 8D12h..8D19h
  if ((de & 0xFF) >= b) return;
  var hl = de + 0x0F;
  if (rd(hl) !== 0x00) return;
  wr(hl, 0x53);
  var r = rng();
  wr(hl + 1, r);
  wr(iy + 0, 0xFF);
  wr(iy + 1, 0xF4);
  wr(iy + 2, 0x06);
  wr(iy + 3, r);
}

/** scr_eyeDownLeft (8CF1h) — eye F4-F6: X+1, Y-1. */
function scr_eyeDownLeft(de, ix, iy, hl) {
  de = de + 1;
  if ((rd(de) & 0x1F) === 0) { scr_eyeReaim(de - 1, ix, hl); return; }
  iinc(ix + 3);
  idec(ix + 0);
  scr_eyeClone(de, ix, iy);
  scr_eyeAnim(ix);
}
/** scr_eyeDownRight (8DA0h) — Y+1, X+1. */
function scr_eyeDownRight(de, ix, iy, hl) {
  if ((rd(de + 1) & 0x1F) === 0) { scr_eyeReaim(de, ix, hl); return; }
  iinc(ix + 0); iinc(ix + 3);
  scr_eyeAnim(ix);
}
/** scr_eyeUpRight (8DB0h) — X-1, Y+1. */
function scr_eyeUpRight(de, ix, iy, hl) {
  if ((rd(de + 1) & 0x1F) === 0) { scr_eyeReaim(de, ix, hl); return; }
  idec(ix + 3); iinc(ix + 0);
  scr_eyeAnim(ix);
}
/** scr_eyeUpLeft (8DC0h) — Y-1, X-1. */
function scr_eyeUpLeft(de, ix, iy, hl) {
  if ((rd(de + 1) & 0x1F) === 0) { scr_eyeReaim(de, ix, hl); return; }
  idec(ix + 0); idec(ix + 3);
  scr_eyeAnim(ix);
}
/** scr_eyeStop (8DD0h) — the eye stands still. */
function scr_eyeStop(de, ix, iy, hl) {
  if ((rd(de + 1) & 0x1F) === 0) { scr_eyeReaim(de, ix, hl); return; }
  scr_eyeAnim(ix);
}

/* ------------------------------------------------------------------------- */
/*  58h/59h rock boss                                                         */
/* ------------------------------------------------------------------------- */

/** rockLayout (34A4h) — lays the four 2x2 rock sprites out around IX. */
function rockLayout(ix) {
  if (rd(LIFE_OVER) === 0x01) return;
  var b = rd(ix + 0);
  if (rd(CABINET_COCKTAIL) === 0x01 && rd(CUR_PLAYER) !== 0x01) wr(ix + 12, (b + 0x11) & 0xFF);
  else wr(ix + 12, (b + 0x0F) & 0xFF);
  wr(ix + 4, b);
  wr(ix + 8, (b + 0x10) & 0xFF);
  var a = rd(ix + 3);
  wr(ix + 11, a);
  wr(ix + 7, (a + 0x10) & 0xFF);
  wr(ix + 15, (a + 0x10) & 0xFF);
}

/**
 * scr_rockBoss (8DDAh) — 2x2 rock A0-A7/80-83. The counter at C231h is the
 * damage: run_script adds 1, the handler takes 1 back, hits add 18h; at F0h the
 * rock is destroyed (playPhase = 3). Y follows attr0Shadow, the colour the damage.
 */
function scr_rockBoss(de, ix) {
  var c = (rd(OBJ_REC_B0 + 1) - 1) & 0xFF;         // C231h = the rock's damage counter
  wr(OBJ_REC_B0 + 1, c);
  if (c >= 0xF0) { wr(lifeStatusAddr(), 0x03); return; }
  if (rd(lifeStatusAddr()) === 0x03) return;
  wr(SOUNDLATCH, 0x2A);
  var a = (rd(ATTR0_SHADOW) + 0x98) & 0xFF;
  if (a >= 0xE8) return;
  wr(ix + 0, a);
  rockLayout(ix);
  var b;
  if (c >= 0xD0) b = 0x06;
  else if (c >= 0xB0) b = 0x04;
  else if (c >= 0x90) b = 0x05;
  else if (c >= 0x70) b = 0x02;
  else if (c >= 0x50) b = 0x01;
  else if (c >= 0x30) b = 0x03;
  else b = 0x07;
  wr(ix + 2, b); wr(ix + 6, b); wr(ix + 10, b); wr(ix + 14, b);
  if ((rd(FRAME_COUNTER) & 0x07) !== 0) return;
  var s = rd(ix + 1);
  var q;
  if (s === 0xA2) q = [0xA6, 0xA7, 0xA4, 0xA5];
  else if (s === 0xA6) q = [0x82, 0x83, 0x80, 0x81];
  else q = [0xA2, 0xA3, 0xA0, 0xA1];
  wr(ix + 1, q[0]); wr(ix + 5, q[1]); wr(ix + 9, q[2]); wr(ix + 13, q[3]);
}

/** scr_rockPart (8EA8h) — side sprite of the rock: vanishes unless C230h is 58h. */
function scr_rockPart(de, ix) {
  if (rd(OBJ_REC_B0) === 0x58) return;
  scr_partClear(de, ix);
}

/* ------------------------------------------------------------------------- */
/*  5Ah-62h spinner                                                           */
/* ------------------------------------------------------------------------- */

/**
 * scr_spinnerIdle (8EB3h) — the shared tail of 5Ah-62h: gone once the rock is
 * destroyed, re-aims every 20h frames. Note rng < F0h leaves HL = FFFFh, so the
 * spinner then aims at C1A0h (the rock) and only rarely at the ship.
 */
function scr_spinnerIdle(de, ix, iy, hl) {
  if (rd(lifeStatusAddr()) === 0x03) {             // 8F37h
    wr(ix + 0, 0x00); wr(ix + 1, 0x00); wr(ix + 2, 0x00); wr(ix + 3, 0x00);
    wr(de, 0x00);
    return;
  }
  if ((rd(de + 1) & 0x1F) === 0) {
    if (rng() < 0xF0) hl = 0xFFFF;                 // 8ED4h
    var a = aimSector12(ix, hl);
    var t;
    if (a < 0x02) t = 0x5B;
    else if (a === 0x02) t = 0x5C;
    else if (a < 0x05) t = 0x5D;
    else if (a === 0x05) t = 0x5E;
    else if (a < 0x08) t = 0x5F;
    else if (a === 0x08) t = 0x60;
    else if (a < 0x0B) t = 0x61;
    else t = 0x62;
    wr(de, t);
  }
  if ((rd(FRAME_COUNTER) & 0x07) !== 0) return;
  var s = (rd(ix + 1) + 1) & 0xFF;
  if (s >= 0xFA) s = 0xF7;
  wr(ix + 1, s);
}

/** scr_spinnerL (8F48h) — spinner F7-F9, direction 1/12. */
function scr_spinnerL(de, ix, iy) { moveL2D1(ix); scr_spinnerIdle(de, ix, iy, 0x93AF); }
/** scr_spinnerLD (8F4Eh) — direction 2/12. */
function scr_spinnerLD(de, ix, iy) { moveL1D2(ix); scr_spinnerIdle(de, ix, iy, 0x93B9); }
/** scr_spinnerD (8F54h) — direction 4/12. */
function scr_spinnerD(de, ix, iy) { moveR1D2(ix); scr_spinnerIdle(de, ix, iy, 0x93CA); }
/** scr_spinnerRD (8F5Ah) — direction 5/12. */
function scr_spinnerRD(de, ix, iy) { moveR2D1(ix); scr_spinnerIdle(de, ix, iy, 0x93D4); }
/** scr_spinnerR (8F60h) — direction 7/12. */
function scr_spinnerR(de, ix, iy) { moveR2U1(ix); scr_spinnerIdle(de, ix, iy, 0x93E5); }
/** scr_spinnerRU (8F66h) — direction 8/12. */
function scr_spinnerRU(de, ix, iy) { moveR1U2(ix); scr_spinnerIdle(de, ix, iy, 0x93EF); }
/** scr_spinnerU (8F6Ch) — direction 10/12. */
function scr_spinnerU(de, ix, iy) { moveL1U2(ix); scr_spinnerIdle(de, ix, iy, 0x9400); }
/** scr_spinnerLU (8F72h) — direction 11/12. */
function scr_spinnerLU(de, ix, iy) { moveL2U1(ix); scr_spinnerIdle(de, ix, iy, 0x940A); }

/* ------------------------------------------------------------------------- */
/*  66h-6Dh spark, 6Eh mushroom, 6Fh propeller                                */
/* ------------------------------------------------------------------------- */

/** scr_sparkSpawn (902Bh) — spark FA-FC: an A slot copies itself, then picks 67h-6Dh. */
function scr_sparkSpawn(de, ix, iy) {
  if ((de & 0xFF) < 0x30) {
    var hl = de + 0x10;
    if (rd(hl) === 0x00) {
      wr(hl, 0x66);
      wr(iy + 0, 0xFF);
      wr(iy + 1, 0xFA);
      wr(iy + 2, 0x06);
      wr(iy + 3, rng());
    }
  }
  var a = rd(SHIP_X);
  var b = rd(ix + 3);
  var c;
  if (a >= b) {                                    // 9057h: the ship is below
    a = (a - b) & 0xFF;
    if (a >= 0xA0) c = 0x67;
    else if (a >= 0x60) c = 0x68;
    else if (a >= 0x20) c = 0x69;
    else c = 0x6A;
  } else {                                         // 9071h
    a = (b - a) & 0xFF;
    if (a < 0x20) c = 0x6A;
    else if (a < 0x60) c = 0x6B;
    else if (a < 0xA0) c = 0x6C;
    else c = 0x6D;
  }
  wr(de, c);
}

/** scr_sparkMove (90A1h) — every spark flies Y-3, colour 6, anim FA-FC every 4 frames. */
function scr_sparkMove(ix) {
  idec(ix + 0); idec(ix + 0); idec(ix + 0);
  wr(ix + 2, 0x06);
  if ((rd(FRAME_COUNTER) & 0x03) !== 0) return;
  var a = (rd(ix + 1) + 1) & 0xFF;
  if (a >= 0xFD) a = 0xFA;
  wr(ix + 1, a);
}

/** scr_spark0 (908Ch) — spark: X+3. */
function scr_spark0(de, ix) { iinc(ix + 3); iinc(ix + 3); iinc(ix + 3); scr_sparkMove(ix); }
/** scr_spark1 (908Fh) — X+2. */
function scr_spark1(de, ix) { iinc(ix + 3); iinc(ix + 3); scr_sparkMove(ix); }
/** scr_spark2 (9092h) — X+1. */
function scr_spark2(de, ix) { iinc(ix + 3); scr_sparkMove(ix); }
/** scr_spark3 (9095h) — straight. */
function scr_spark3(de, ix) { scr_sparkMove(ix); }
/** scr_spark4 (909Eh) — type 6Bh: X-1. */
function scr_spark4(de, ix) { idec(ix + 3); scr_sparkMove(ix); }
/** scr_spark5 (909Bh) — type 6Ch: X-2. */
function scr_spark5(de, ix) { idec(ix + 3); idec(ix + 3); scr_sparkMove(ix); }
/** scr_spark6 (9098h) — type 6Dh: X-3. */
function scr_spark6(de, ix) { idec(ix + 3); idec(ix + 3); idec(ix + 3); scr_sparkMove(ix); }

/** scr_mushroom (90C6h) — mushroom B7/B8/C8 by the counter nibble: Y-2, X-2, fires 31h. */
function scr_mushroom(de, ix) {
  spawnTypeC(ix, 0x31);
  idec(ix + 0); idec(ix + 0); idec(ix + 3); idec(ix + 3);
  var a = rd(de + 1) & 0x0F;
  if (a < 0x04) wr(ix + 1, 0xB7);
  else if (a < 0x08) wr(ix + 1, 0xB8);
  else if (a < 0x0C) wr(ix + 1, 0xC8);
  else wr(ix + 1, 0xB8);                           // 90E3h/90E5h fall through to B8h
}

/** scr_propeller (90F7h) — propeller C2-C4: counter bit 5 clear Y-3, set Y+1 plus shots 30h and 3Bh. */
function scr_propeller(de, ix) {
  if ((rd(de + 1) & 0x20) !== 0) {
    iinc(ix + 0);
    spawnTypeC(ix, 0x30);
    spawnTypeC(ix, 0x3B);
  } else {
    idec(ix + 0); idec(ix + 0); idec(ix + 0);
  }
  iinc(ix + 3);
  if ((rd(FRAME_COUNTER) & 0x01) !== 0) return;
  var a = (rd(ix + 1) + 1) & 0xFF;
  if (a >= 0xC5) a = 0xC2;
  wr(ix + 1, a);
}

/* ------------------------------------------------------------------------- */
/*  70h-76h formations                                                        */
/* ------------------------------------------------------------------------- */

/** scr_formationAnim (9177h) — C5-C7 every 16 frames. */
function scr_formationAnim(ix) {
  if ((rd(FRAME_COUNTER) & 0x0F) !== 0) return;
  var a = (rd(ix + 1) + 1) & 0xFF;
  if (a >= 0xC8) a = 0xC5;
  wr(ix + 1, a);
}

/** scr_formationKite (9132h) — kite C5-C7: counter nibble < 8 X+0/+2, else X-0/-2, Y-2. */
function scr_formationKite(de, ix) {
  var n = (rd(de + 1) >> 4) & 0x0F;
  var c;
  if (n < 0x08) {
    c = (n < 0x01) ? n : 0x02;
    while (c-- > 0) iinc(ix + 3);
  } else {
    var a = n - 0x08;
    c = (a < 0x01) ? a : 0x02;
    while (c-- > 0) idec(ix + 3);
  }
  idec(ix + 0); idec(ix + 0);
  scr_formationAnim(ix);
}

/** scr_formationKiteShoot (918Fh) — 70h plus a random aimed shot. */
function scr_formationKiteShoot(de, ix) {
  spawnRandomShot(ix);
  scr_formationKite(de, ix);
}

/** scr_formationCrabTail (91A1h) — crabs fire from counter E0h; anim E5-E7 every 4 frames. */
function scr_formationCrabTail(de, ix) {
  if (rd(de + 1) >= 0xE0) spawnRandomShot(ix);
  if ((rd(FRAME_COUNTER) & 0x03) !== 0) return;
  var a = (rd(ix + 1) + 1) & 0xFF;
  if (a >= 0xE8) a = 0xE5;
  wr(ix + 1, a);
}

/** scr_formationCrabFast (9195h) — crab E5-E7 on path 4410h, stepped twice per frame. */
function scr_formationCrabFast(de, ix) {
  pathStep(de, ix, 0x4410);
  pathStep(de, ix, 0x4410);
  scr_formationCrabTail(de, ix);
}
/** scr_formationCrab4420 (91C0h) — path 4420h. */
function scr_formationCrab4420(de, ix) { pathStep(de, ix, 0x4420); scr_formationCrabTail(de, ix); }
/** scr_formationCrab4430 (91C9h) — path 4430h. */
function scr_formationCrab4430(de, ix) { pathStep(de, ix, 0x4430); scr_formationCrabTail(de, ix); }
/** scr_formationCrab4440 (91D2h) — path 4440h. */
function scr_formationCrab4440(de, ix) { pathStep(de, ix, 0x4440); scr_formationCrabTail(de, ix); }

/** scr_formationKiteVert (91DBh) — kite: counter nibble < 8 Y-0/-2, else Y+0/+2, X+1. */
function scr_formationKiteVert(de, ix) {
  var n = (rd(de + 1) >> 4) & 0x0F;
  var c;
  if (n < 0x08) {
    c = (n < 0x01) ? n : 0x02;
    while (c-- > 0) idec(ix + 0);
  } else {
    var a = n - 0x08;
    c = (a < 0x01) ? a : 0x02;
    while (c-- > 0) iinc(ix + 0);
  }
  iinc(ix + 3);
  scr_formationAnim(ix);
}

/* ------------------------------------------------------------------------- */
/*  Dispatch (script_handlers 5A00h)                                          */
/* ------------------------------------------------------------------------- */

/**
 * runScriptHandler — the jump table at 5A00h. DE = record, IX = sprite shadow,
 * IY = partner shadow, HL = the value the original had in HL at JP (HL).
 */
function runScriptHandler(type, de, ix, iy, hl) {
  switch (type) {
    case 0x00: scr_end(); return;
    case 0x01: scr_beetleDir01(de, ix, iy); return;
    case 0x02: scr_beetleDir02(de, ix, iy); return;
    case 0x03: scr_beetleDir03(de, ix, iy); return;
    case 0x04: scr_beetleDir04(de, ix, iy); return;
    case 0x05: scr_beetleDir05(de, ix, iy); return;
    case 0x06: scr_beetleDir06(de, ix, iy); return;
    case 0x07: scr_beetleDir07(de, ix, iy); return;
    case 0x08: scr_beetleDir08(de, ix, iy); return;
    case 0x09: scr_beetleDir09(de, ix, iy); return;
    case 0x0A: scr_beetleDir10(de, ix, iy); return;
    case 0x0B: scr_beetleDir11(de, ix, iy); return;
    case 0x0C: scr_beetleDir12(de, ix, iy); return;
    case 0x0D: scr_orbMineDown(de, ix, iy); return;
    case 0x0E: scr_orbMineUp(de, ix, iy); return;
    case 0x0F: scr_orbDriftUpLeft(de, ix); return;
    case 0x10: scr_orbDriftDownLeft(de, ix); return;
    case 0x11: scr_unused11(); return;
    case 0x12: scr_unused12(); return;
    case 0x13: scr_spikyBallLeft(de, ix, iy); return;
    case 0x14: scr_spikyBallBack(de, ix); return;
    case 0x15: scr_jellyDiagDown(de, ix); return;
    case 0x16: scr_jellyUpAccel(de, ix); return;
    case 0x17: scr_jellyDownAccel(de, ix); return;
    case 0x18: scr_jellyPath(de, ix); return;
    case 0x19: scr_dieBonus300(de, ix); return;
    case 0x1A: scr_dieBonusB6(de, ix); return;
    case 0x1B: scr_nop1B(de, ix); return;
    case 0x1C: scr_parasiteAttachedBelow(de, ix); return;
    case 0x1D: scr_popcornRight(de, ix, iy); return;
    case 0x1E: scr_popcornDownLeft(de, ix, iy); return;
    case 0x1F: scr_popcornUpLeft(de, ix, iy); return;
    case 0x20: scr_popcornUpRight(de, ix, iy); return;
    case 0x21: scr_parasiteHunt(de, ix); return;
    case 0x22: scr_parasiteAttachedAbove(de, ix); return;
    case 0x23: scr_windmillLeft(de, ix, iy); return;
    case 0x24: scr_windmillUp(de, ix); return;
    case 0x25: scr_windmillDown(de, ix); return;
    case 0x26: scr_popcornTrack(de, ix); return;
    case 0x27: scr_popcornDash(de, ix); return;
    case 0x28: scr_saucerIdle(de, ix, iy, hl); return;
    case 0x29: scr_saucerLeft(de, ix, iy, hl); return;
    case 0x2A: scr_saucerLeftDown(de, ix, iy, hl); return;
    case 0x2B: scr_saucerRightDown(de, ix, iy, hl); return;
    case 0x2C: scr_saucerRight(de, ix, iy, hl); return;
    case 0x2D: scr_saucerRightUp(de, ix, iy, hl); return;
    case 0x2E: scr_saucerLeftUp(de, ix, iy, hl); return;
    case 0x2F: scr_explodeCloud(de, ix); return;
    case 0x30: scr_shotDir00(de, ix); return;
    case 0x31: scr_shotDir01(de, ix); return;
    case 0x32: scr_shotDir02(de, ix); return;
    case 0x33: scr_shotDir03(de, ix); return;
    case 0x34: scr_shotDir04(de, ix); return;
    case 0x35: scr_shotDir05(de, ix); return;
    case 0x36: scr_shotDir06(de, ix); return;
    case 0x37: scr_shotDir07(de, ix); return;
    case 0x38: scr_shotDir08(de, ix); return;
    case 0x39: scr_shotDir09(de, ix); return;
    case 0x3A: scr_shotDir10(de, ix); return;
    case 0x3B: scr_shotDir11(de, ix); return;
    case 0x3C: scr_dotSphere(de, ix); return;
    case 0x3D: scr_dotSphereDead(de, ix); return;
    case 0x3E: scr_rocketFlame(de, ix); return;
    case 0x3F: scr_saucerShell(de, ix); return;
    case 0x40: scr_eyeballStatic(de, ix); return;
    case 0x41: scr_eyeballStatic41(de); return;
    case 0x42: scr_eyeballStatic42(de); return;
    case 0x43: scr_eyeballMove(de, ix); return;
    case 0x44: scr_dieEyeball(de, ix); return;
    case 0x45: scr_flowerMine(de, ix); return;
    case 0x46: scr_podDownLeft(de, ix); return;
    case 0x47: scr_podUp(de, ix); return;
    case 0x48: scr_podUpLeft(de, ix); return;
    case 0x49: scr_groundMissile(de, ix, iy, hl); return;
    case 0x4A: scr_rocketRise(de, ix); return;
    case 0x4B: scr_rocketFall(de, ix); return;
    case 0x4C: scr_launchedToSaucer(de, ix); return;
    case 0x4D: scr_explodeRocket(de, ix); return;
    case 0x4E: scr_explodeRocket2(); return;
    case 0x4F: scr_launchedUp(de, ix); return;
    case 0x50: scr_vacuumSphere(de, ix); return;
    case 0x51: scr_vacuumPart(de, ix); return;
    case 0x52: scr_explodeBig(de, ix); return;
    case 0x53: scr_eyeDownLeft(de, ix, iy, hl); return;
    case 0x54: scr_eyeDownRight(de, ix, iy, hl); return;
    case 0x55: scr_eyeUpRight(de, ix, iy, hl); return;
    case 0x56: scr_eyeUpLeft(de, ix, iy, hl); return;
    case 0x57: scr_eyeStop(de, ix, iy, hl); return;
    case 0x58: scr_rockBoss(de, ix); return;
    case 0x59: scr_rockPart(de, ix); return;
    case 0x5A: scr_spinnerIdle(de, ix, iy, hl); return;
    case 0x5B: scr_spinnerL(de, ix, iy); return;
    case 0x5C: scr_spinnerLD(de, ix, iy); return;
    case 0x5D: scr_spinnerD(de, ix, iy); return;
    case 0x5E: scr_spinnerRD(de, ix, iy); return;
    case 0x5F: scr_spinnerR(de, ix, iy); return;
    case 0x60: scr_spinnerRU(de, ix, iy); return;
    case 0x61: scr_spinnerU(de, ix, iy); return;
    case 0x62: scr_spinnerLU(de, ix, iy); return;
    case 0x63: scr_pod63(de, ix); return;
    case 0x64: scr_pod64(de, ix); return;
    case 0x65: scr_pod65(de, ix); return;
    case 0x66: scr_sparkSpawn(de, ix, iy); return;
    case 0x67: scr_spark0(de, ix); return;
    case 0x68: scr_spark1(de, ix); return;
    case 0x69: scr_spark2(de, ix); return;
    case 0x6A: scr_spark3(de, ix); return;
    case 0x6B: scr_spark4(de, ix); return;
    case 0x6C: scr_spark5(de, ix); return;
    case 0x6D: scr_spark6(de, ix); return;
    case 0x6E: scr_mushroom(de, ix); return;
    case 0x6F: scr_propeller(de, ix); return;
    case 0x70: scr_formationKite(de, ix); return;
    case 0x71: scr_formationKiteShoot(de, ix); return;
    case 0x72: scr_formationCrabFast(de, ix); return;
    case 0x73: scr_formationCrab4420(de, ix); return;
    case 0x74: scr_formationCrab4430(de, ix); return;
    case 0x75: scr_formationCrab4440(de, ix); return;
    case 0x76: scr_formationKiteVert(de, ix); return;
    default:
      if (type >= 0x77 && type <= 0x8F) { scr_beetleDir09(de, ix, iy); return; }  // 9218h filler
      if (type >= 0x90 && type <= 0xAD) { scr_groundMissile(de, ix, iy, hl); return; }  // 9263h
      return;
  }
}

/*
 * Coverage of the handler table 5A00h, type -> function (00h..ADh, all present):
 *   00 scr_end                       01 scr_beetleDir01               02 scr_beetleDir02
 *   03 scr_beetleDir03               04 scr_beetleDir04               05 scr_beetleDir05
 *   06 scr_beetleDir06               07 scr_beetleDir07               08 scr_beetleDir08
 *   09 scr_beetleDir09               0A scr_beetleDir10               0B scr_beetleDir11
 *   0C scr_beetleDir12               0D scr_orbMineDown               0E scr_orbMineUp
 *   0F scr_orbDriftUpLeft            10 scr_orbDriftDownLeft          11 scr_unused11
 *   12 scr_unused12                  13 scr_spikyBallLeft             14 scr_spikyBallBack
 *   15 scr_jellyDiagDown             16 scr_jellyUpAccel              17 scr_jellyDownAccel
 *   18 scr_jellyPath                 19 scr_dieBonus300               1A scr_dieBonusB6
 *   1B scr_nop1B                     1C scr_parasiteAttachedBelow     1D scr_popcornRight
 *   1E scr_popcornDownLeft           1F scr_popcornUpLeft             20 scr_popcornUpRight
 *   21 scr_parasiteHunt              22 scr_parasiteAttachedAbove     23 scr_windmillLeft
 *   24 scr_windmillUp                25 scr_windmillDown              26 scr_popcornTrack
 *   27 scr_popcornDash               28 scr_saucerIdle                29 scr_saucerLeft
 *   2A scr_saucerLeftDown            2B scr_saucerRightDown           2C scr_saucerRight
 *   2D scr_saucerRightUp             2E scr_saucerLeftUp              2F scr_explodeCloud
 *   30 scr_shotDir00                 31 scr_shotDir01                 32 scr_shotDir02
 *   33 scr_shotDir03                 34 scr_shotDir04                 35 scr_shotDir05
 *   36 scr_shotDir06                 37 scr_shotDir07                 38 scr_shotDir08
 *   39 scr_shotDir09                 3A scr_shotDir10                 3B scr_shotDir11
 *   3C scr_dotSphere                 3D scr_dotSphereDead             3E scr_rocketFlame
 *   3F scr_saucerShell               40 scr_eyeballStatic             41 scr_eyeballStatic41
 *   42 scr_eyeballStatic42           43 scr_eyeballMove               44 scr_dieEyeball
 *   45 scr_flowerMine                46 scr_podDownLeft               47 scr_podUp
 *   48 scr_podUpLeft                 49 scr_groundMissile             4A scr_rocketRise
 *   4B scr_rocketFall                4C scr_launchedToSaucer          4D scr_explodeRocket
 *   4E scr_explodeRocket2            4F scr_launchedUp                50 scr_vacuumSphere
 *   51 scr_vacuumPart                52 scr_explodeBig                53 scr_eyeDownLeft
 *   54 scr_eyeDownRight              55 scr_eyeUpRight                56 scr_eyeUpLeft
 *   57 scr_eyeStop                   58 scr_rockBoss                  59 scr_rockPart
 *   5A scr_spinnerIdle               5B scr_spinnerL                  5C scr_spinnerLD
 *   5D scr_spinnerD                  5E scr_spinnerRD                 5F scr_spinnerR
 *   60 scr_spinnerRU                 61 scr_spinnerU                  62 scr_spinnerLU
 *   63 scr_pod63                     64 scr_pod64                     65 scr_pod65
 *   66 scr_sparkSpawn                67 scr_spark0                    68 scr_spark1
 *   69 scr_spark2                    6A scr_spark3                    6B scr_spark4
 *   6C scr_spark5                    6D scr_spark6                    6E scr_mushroom
 *   6F scr_propeller                 70 scr_formationKite             71 scr_formationKiteShoot
 *   72 scr_formationCrabFast         73 scr_formationCrab4420         74 scr_formationCrab4430
 *   75 scr_formationCrab4440         76 scr_formationKiteVert
 *   77..8F scr_beetleDir09 (filler, 9218h..9260h)
 *   90..AD scr_groundMissile (ground launchers, 9263h)
 */

// ---------------------------------------------------------------- frame
/**
 * One 60 Hz frame: the VBLANK NMI first (as on the board, where it fires at the
 * start of the vertical blank), then the foreground runs until it blocks again.
 */
function tick() {
  frameLatches = [];
  frameShots = 0;
  frameBooms = 0;
  frameShotSlots = [];
  frameBoomSlots = [];
  state.frameSpent = 0;

  if (state.inputScript) {
    applyInputScript();
  } else {
    applyControls();
  }

  var budget = FRAME_TSTATES;
  if (nmiEnable) {
    nmiHandler();
    budget -= state.nmiCost;
    state.frameSpent += state.nmiCost;
    state.lastNmi = state.nmiCost;
    state.nmiCost = 0;
  }

  // The foreground gets what is left of the frame. It runs until it has spent
  // the budget inside a long operation ('work'), or until it blocks on the NMI
  // ('frame') — exactly what the Z80 does between two vertical blanks.
  while (!state.stopped && budget > 0) {
    if (state.pending > 0) {
      var use = state.pending < budget ? state.pending : budget;
      state.pending -= use;
      budget -= use;
      state.frameSpent += use;
      if (budget <= 0) {
        break;
      }
    }
    var step = program.next();
    if (step.done) {
      state.stopped = true;
      break;
    }
    if (step.value === 'frame') {
      // The original does not stop spending when it starts waiting for the NMI:
      // the instructions it ran just before the wait belong to THIS frame. The
      // debt they ran up therefore has to come out of this frame's budget --
      // carrying it into the next frame delayed everything after the wait by
      // the length of the last pass of main_loop (measured as 1.7k T with
      // tools/refemu/profile.mjs --write-at C119 against the title screen).
      if (state.pending > 0) {
        var left = state.pending < budget ? state.pending : budget;
        state.pending -= left;
        budget -= left;
      }
      break;
    }
  }
  state.frame++;
} // tick

/** the video state and the game values the model needs (app/WORKER-PROTOCOL.md) */
function frameMessage() {
  return {
    id: 'frame',
    frame: state.frame,
    vram: [vram[0], vram[1]],
    attr: [attr[0], attr[1]],
    sprites: [spr[0], spr[1]],
    regs: {
      palbank: palbank[0] | (palbank[1] << 1),
      charbank: [charbank[0], charbank[1]],
      bgcolor: bgcolor,
      flip: [flip[0], flip[1]]
    },
    score: readScore(0xC06D),
    hiScore: readScore(0xC079),
    lives: rd(0xC0B1),
    round: rd(0xC0BB),
    state: playState(),
    soundBoard: {
      latch: frameLatches.slice(),          // [{slot: 0-3, value}] writes to F800h
      shot: frameShots, shotSlots: frameShotSlots.slice(),   // F80Ah, the discrete shot
      boom: frameBooms, boomSlots: frameBoomSlots.slice()    // F808h, the discrete explosion
    }
  };
} // frameMessage

/** six BCD digits, lowest first, displayed as the stored value times ten */
function readScore(addr) {
  var value = 0;
  for (var i = 5; i >= 0; i--) {
    value = value*10+(rd(addr+i) & 0x0F);
  }
  return value*10;
} // readScore

function playState() {
  switch (rd(0xC0A2)) {
    case 0: case 1: case 2: return 'title';
    case 4: return 'demo';
    case 5: return rd(0xC0B9) === 1 ? 'dying' : 'game';
  }
  return 'title';
} // playState

/**
 * The original program starts where the board starts: the power-on service
 * screen, the title, and the game only after a coin and a start button. The
 * remake has neither button, and the player has already chosen PLAY in the
 * menu — so the worker runs the original's own path at full speed and only
 * begins presenting frames once the game (or, in attract mode, the demo) is
 * really running.
 *
 * Nothing is skipped or faked: the coin and the start button are put on IN0
 * exactly as the hardware would see them, so it is the original code that sets
 * the game up. It takes roughly 230 frames of the original's time, which is a
 * few milliseconds here.
 *
 * Headless runs (tools/regress.mjs) are left alone — they compare frame by
 * frame from the reset and drive the inputs from their own script.
 */
var FAST_FORWARD_LIMIT = 4000;       // frames; the title alone takes about 900

function fastForwardToPlay() {
  if (state.headless || state.inputScript) {
    return;
  }
  var coinFrame = -1;
  for (var i = 0; i < FAST_FORWARD_LIMIT; i++) {
    var gameState = rd(0xC0A2);
    if (state.attract) {
      if (gameState === 4) {                     // the demo is running
        in0 = 0;
        return;
      }
    } else {
      // Stop as soon as start1P (2A85h) has handed out the lives — that is the
      // instant before gameLoop1P calls startLife (1860h). startLife is real game
      // content, not the boot: it draws PLAYER 1 READY / STAGE 1 and sends the
      // start-of-life tune (latch 02h). Fast forwarding through it would swallow
      // both, and the music would be missing until the next command.
      if (gameState === 5 && rd(0xC0AA) !== 0 && rd(0xC0B1) !== 0) {
        in0 = 0;
        return;
      }
      // Drop a coin as soon as the title is up. The credit is only counted on
      // the release edge (coinInput 042Eh), so the coin has to be let go; the
      // start button, on the other hand, is read by level in a blocking loop
      // (pushStartWait 29D7h) which the program does not reach for many frames,
      // so it is held down until the life actually starts.
      if (coinFrame < 0 && gameState === 2) {
        coinFrame = i;
      }
      if (coinFrame < 0) {
        in0 = 0;
      } else if (i < coinFrame+6) {
        in0 = 0x01;                              // coin A, held
      } else if (rd(0xC0AC) === 0) {
        in0 = 0;                                 // released: the credit is counted here
      } else {
        in0 = 0x10;                              // start 1P, held until the game runs
      }
    }
    tick();
  }
  in0 = 0;
  console.error('gameWorker: the game did not start within '+FAST_FORWARD_LIMIT+
    ' frames (gameState '+rd(0xC0A2)+')');
} // fastForwardToPlay

// ---------------------------------------------------------------- messages
var timer = null;
var accumulator = 0;
var lastTime = 0;

function startLoop() {
  if (state.headless || timer !== null) {
    return;
  }
  lastTime = performance.now();
  schedule();
} // startLoop

/**
 * ★ **Nikdy `setInterval`** (R-046): je nepřesný, a nepřesný **jinak** na
 * každém OS i stroji — období se zaokrouhluje na celé milisekundy, časovače
 * se slučují a když se obsluha opozdí, volání se hromadí. Jediné spolehlivé
 * je **rekurzivní `setTimeout`**, jak to dělá `manicminer/app/gameWorker.js`.
 * Akumulátor pod ním zůstává: ten drží **kadenci**, tohle drží **plánování**.
 */
function schedule() {
  timer = setTimeout(function() {
    var now = performance.now();
    accumulator += now-lastTime;
    lastTime = now;
    var guard = 0;
    while (accumulator >= TICK_MS && guard < 4) {
      accumulator -= TICK_MS;
      guard++;
      if (!state.paused && !state.stopped) {
        tick();
      }
    }
    if (guard > 0) {
      postMessage(frameMessage());
    }
    // ★ znovu naplánovat, ale jen když mezitím nikdo nezastavil
    if (timer !== null) {
      schedule();
    }
  }, 4);
} // schedule

function stopLoop() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
} // stopLoop

onmessage = function(event) {
  var data = event.data;
  switch (data.id) {
    case 'init':
      loadTables(data.initData && data.initData.tables);
      state = newState(data.initData);
      if (data.initData && data.initData.dsw0 !== undefined) dsw0 = data.initData.dsw0;
      if (data.initData && data.initData.dsw1 !== undefined) dsw1 = data.initData.dsw1;
      ram.fill(0);
      vram[0].fill(0); vram[1].fill(0);
      attr[0].fill(0); attr[1].fill(0);
      spr[0].fill(0); spr[1].fill(0);
      nmiEnable = 0; palbank = [0, 0]; charbank = [0, 0]; flip = [0, 0]; bgcolor = 0;
      in0 = 0; in1 = 0;
      program = mainProgram();
      fastForwardToPlay();
      startLoop();
      break;
    case 'controls':
      state.controls.left = !!data.left;
      state.controls.right = !!data.right;
      state.controls.up = !!data.up;
      state.controls.down = !!data.down;
      state.controls.fire = !!data.fire;
      state.controls.bongo = !!data.bongo;
      break;
    case 'tick':                                 // headless (tools/regress.mjs)
      tick();
      break;
    case 'pause': state.paused = true; break;
    case 'continue': state.paused = false; lastTime = performance.now(); break;
    case 'reset': stopLoop(); state.stopped = true; break;
  }
}; // onmessage

// tools/regress.mjs reaches into the worker through this handle
self.__st = {
  get state() { return state; },
  ram: ram, vram: vram, attr: attr, spr: spr,
  rd: rd, wr: wr, rng: rng,
  regs: function() { return {nmiEnable: nmiEnable, palbank: palbank, charbank: charbank, flip: flip, bgcolor: bgcolor}; },
  tick: tick,
  frameMessage: frameMessage
};
