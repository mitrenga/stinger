/**
 * Stinger boot worker — the power-on sequence of the board, and nothing else.
 *
 * The game worker (gameWorker.js) is a 1:1 transcription of the whole program
 * and fast-forwards the boot on `init`, because the player has already chosen
 * PLAY in the menu. This worker exists for the opposite purpose: BootModel
 * (bootModel.js) shows the boot the way the machine shows it, as the
 * loading animation of the remake, and hands over to the menu the moment the
 * title picture would start to appear.
 *
 * What the board does between the reset and the title (main_start 0C85h):
 *
 *   initRam 0CEAh       RAM cleared, RNG seeded (365Ah), both layers cleared
 *   decodeDsw0/1        the DIP switches decoded into RAM
 *   powerOnScreen 0D4Ah layer 1 filled with 8 passes of RNG "snow", cleared,
 *                       the raw coinage/lives values printed, the whole layer
 *                       set to the solid tile 3Fh, cleared again
 *   drawTitle 0F2Eh     -- not here: this is where the worker stops
 *
 * The NMI is off throughout, so nothing advances except the wall clock, and
 * none of it reads a ROM table — the sequence is pure code — which is why this
 * worker needs no data/tables.json. The T-state accounting is the same as in
 * gameWorker.js (charge before acting, FRAME_TSTATES a frame), with the same
 * constants, so the boot lasts the same 194 frames as on the reference
 * emulator (tools/refemu) and the RNG snow stops on the same frame. The copies
 * of ROM tables into RAM inside initRam (high-score defaults) have no visible
 * effect on the boot screen; only their time is charged.
 *
 * Protocol (app/WORKER-PROTOCOL.md, "bootWorker"):
 *   model -> worker  {id:'init', initData:{dsw0?, dsw1?}}   {id:'reset'}
 *   worker -> model  {id:'frame', frame, vram, attr, sprites, regs, state:'boot'}
 *                    {id:'booted', frame}   once, when drawTitle would start
 *
 * Classic worker script (importScripts world): no import/export.
 */

var TICK_MS = 1000/60;
var FRAME_TSTATES = 51200;           // 3.072 MHz / 60 Hz
var DELAY_LOOP_TSTATES = 54861;      // delayLoop S_160B (160Bh), see gameWorker.js
var FILL_PAGES_TSTATES = 21;         // fillPages 15C4h, per byte
var FILL_BYTES_TSTATES = 24;         // fillBytes 15CEh, per byte
var LDIR_TSTATES = 21;               // LDIR, per byte
var MEMCPY_WD_TSTATES = 162;         // RST 08h 0334h: two watchdog kicks per byte
var RNG_FILL_TSTATES = 284;          // one byte of the 0D50h loop (gameWorker.js)
var RESET_OVERHEAD_TSTATES = 900;    // straight-line code of main_start, calibrated in gameWorker.js

// ---------------------------------------------------------------- memory
var ram = new Uint8Array(0x800);         // C000h-C7FFh
var vram = [new Uint8Array(0x400), new Uint8Array(0x400)];   // [0] = E000h layer 0, [1] = D000h layer 1
var attr = [new Uint8Array(0x40), new Uint8Array(0x40)];     // [0] = E800h, [1] = D800h
var spr = [new Uint8Array(0x20), new Uint8Array(0x20)];      // [0] = E840h, [1] = D840h

var palbank = [0, 0];                // F002h / F003h
var charbank = [0, 0];               // F004h / F005h
var flip = [0, 0];                   // F006h / F007h
var bgcolor = 0;                     // F818h
var dsw0 = 0xEF;                     // F000h, factory default (GAME-DESIGN chap. 2.4)
var dsw1 = 0xAE;                     // F008h

function rd(a) {
  a &= 0xFFFF;
  if (a >= 0xC000 && a < 0xC800) return ram[a-0xC000];
  if (a >= 0xD000 && a < 0xD400) return vram[1][a-0xD000];
  if (a >= 0xD800 && a < 0xD840) return attr[1][a-0xD800];
  if (a >= 0xD840 && a < 0xD860) return spr[1][a-0xD840];
  if (a >= 0xE000 && a < 0xE400) return vram[0][a-0xE000];
  if (a >= 0xE800 && a < 0xE840) return attr[0][a-0xE800];
  if (a >= 0xE840 && a < 0xE860) return spr[0][a-0xE840];
  if (a == 0xF000) return dsw0;
  if (a == 0xF008) return dsw1;
  return 0xFF;                       // ROM is never read by the boot; unmapped reads as FFh
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
  if (a == 0xF002 || a == 0xF003) { palbank[a-0xF002] = v & 1; return; }
  if (a == 0xF004 || a == 0xF005) { charbank[a-0xF004] = v & 1; return; }
  if (a == 0xF006 || a == 0xF007) { flip[a-0xF006] = v & 1; return; }
  if (a == 0xF818) { bgcolor = v; return; }
  // F001h NMI enable (stays off), F800h sound latch (90h = stop, 00h): no effect here
} // wr

// ---------------------------------------------------------------- time
var state = null;
var program = null;

function charge(tstates) {
  state.pending += tstates;
} // charge

/** rng (1694h) — the same generator as in gameWorker.js; the snow is its output */
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
  a = ((hl >> 8) | (hl & 0xFF)) & 0xFF;        // LD A,H / OR L  -> returned
  if (hl === 0) {
    hl = 0x5A36;
  }
  ram[0x0A4] = hl & 0xFF;
  ram[0x0A5] = (hl >> 8) & 0xFF;
  return a;
} // rng

// ---------------------------------------------------------------- block routines
/** fillPages (15C4h): b pages of 256 bytes from hl set to a */
function* fillPagesG(hl, b, a) {
  for (var page = 0; page < b; page++) {
    for (var i = 0; i < 256; i++) {
      wr(hl+page*256+i, a);
    }
    charge(256*FILL_PAGES_TSTATES+4+(page === b-1 ? 8 : 13));
    yield 'work';
  }
} // fillPagesG

/** fillBytes (15CEh): b bytes (0 = 256) from hl set to a */
function fillBytes(hl, b, a) {
  var count = b === 0 ? 256 : b;
  for (var i = 0; i < count; i++) {
    wr(hl+i, a);
  }
  charge(count*FILL_BYTES_TSTATES-5+10);
} // fillBytes

/** RST 08h (0334h): memcpy with the watchdog kicked twice per byte */
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

/** delayLoop (S_160B) n times, from a DJNZ loop; `extra` = the stray NOP of 0D78h */
function* delay(n, extra) {
  charge(n*(17+DELAY_LOOP_TSTATES+13+(extra || 0))-5);
  yield 'work';
} // delay

/** clearScreens (0342h) via RST 10h: both layers, sprite shadows, attributes, BGCOLOR */
function* clearScreensG() {
  charge(11+10+55+7+13+7+10+7+17);
  wr(0xF001, 0);
  yield* fillPagesG(0xD000, 4, 0x10);
  charge(65+55+10+7+17);
  yield* fillPagesG(0xE000, 4, 0x10);
  charge(65+55+4+10+7+17);
  fillBytes(0xC100, 0xC0, 0);
  charge(10+7+17);
  fillBytes(0xD800, 0x60, 0);
  charge(10+7+17);
  fillBytes(0xE800, 0x60, 0);
  charge(13+55+10);
  wr(0xF818, 0);
  yield 'work';
} // clearScreensG

// ---------------------------------------------------------------- the boot
/** initRam (0CEAh) */
function* initRam() {
  yield* fillPagesG(0xC000, 7, 0);               // C000h-C6FFh
  wr(0xC0A4, 0x5A);                              // RNG seed 365Ah (low byte first)
  wr(0xC0A5, 0x36);
  yield* clearScreensG();
  // 0D01-0D18: default high-score table, names and HUD high score are copied
  // out of ROM (2Ah + 14h + 06h bytes by LDIR). Nothing of it reaches the boot
  // screen, so only the time is paid.
  charge((0x2A+0x14+0x06)*LDIR_TSTATES);
  fillBytes(0xC280, 0x20, 0x10);                 // both Bongo gauges empty
  wr(0xF800, 0x90);                              // stop the sound program
  wr(0xC515, 0);
  fillBytes(0xF002, 0x06, 0);                    // palette banks, char banks, flip
  wr(0xC0B9, 1);
  yield 'work';
} // initRam

/**
 * decodeDsw0 (0D89h) / decodeDsw1 (0E58h) — only the values the power-on
 * screen prints: coinage A (C0A6h/C0A7h), lives (C0A8h), coinage B (C540h/
 * C541h). The rest of the decoding lives in gameWorker.js; its time is part of
 * RESET_OVERHEAD_TSTATES.
 */
function decodeDsw() {
  var d0 = rd(0xF000);
  var coinage = [[3, 2], [4, 1], [3, 1], [2, 3], [2, 1], [1, 3], [1, 2], [1, 1]][d0 & 7];
  wr(0xC0A7, coinage[0]);                        // coins per credit
  wr(0xC0A6, coinage[1]);                        // credits per coin
  wr(0xC0A8, 2+((d0 >> 3) & 3));                 // lives 2-5
  fillBytes(0xC07F, 0x0C, 0);                    // bonus thresholds cleared (their values are not shown)
  var d1 = rd(0xF008);
  var coinageB = [[5, 1], [2, 3], [3, 2], [1, 2], [4, 1], [2, 1], [3, 1], [1, 1]][(d1 >> 1) & 7];
  wr(0xC540, coinageB[0]);
  wr(0xC541, coinageB[1]);
} // decodeDsw

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
    charge(7+7+0x20*22-4+13);
  }
  wr(hl, a);
  charge(7+10);
} // showCoinageRaw

/** powerOnScreen (0D4Ah) — transcribed exactly as in gameWorker.js */
function* powerOnScreen() {
  wr(0xF005, 1);                                 // RST 18h: char bank 1 for layer 1
  charge(7);                                     // LD B,08h
  for (var pass = 0; pass < 8; pass++) {
    charge(10);                                  // LD HL,VRAM1+40h
    for (var hl = 0xD040; hl < 0xD400; hl++) {
      charge(RNG_FILL_TSTATES);                  // pay first, then act
      yield 'work';
      wr(hl, rng());
    }
    charge(13);                                  // DJNZ closing the pass
  }
  yield* clearScreensG();
  showCoinageRaw();
  yield* delay(0x30);
  wr(0xD000, 0x3F);
  yield* memcpyWdG(0xD000, 0xD001, 0x3FF);       // RST 08h: propagate 3Fh over the whole layer
  yield* delay(0x50, 4);                         // 0D78h has a NOP in the loop
  yield* clearScreensG();
} // powerOnScreen

/** main_start (0C85h) up to the CALL drawTitle (0F2Eh) */
function* bootProgram() {
  yield* initRam();
  decodeDsw();
  charge(RESET_OVERHEAD_TSTATES);
  yield 'work';
  yield* powerOnScreen();
  wr(0xF800, 0x00);
  // 0CA0h: JP drawTitle -- the title picture starts here; the boot is over
} // bootProgram

// ---------------------------------------------------------------- frames
/**
 * One frame: the foreground gets FRAME_TSTATES and runs until it has spent
 * them. There is no NMI to fire — the boot keeps it off — and the boot never
 * blocks on the frame counter, so 'work' is the only thing the program yields.
 */
function tick() {
  var budget = FRAME_TSTATES;
  while (!state.booted && budget > 0) {
    if (state.pending > 0) {
      var use = state.pending < budget ? state.pending : budget;
      state.pending -= use;
      budget -= use;
      if (budget <= 0) {
        break;
      }
    }
    var step = program.next();
    if (step.done) {
      state.booted = true;
      break;
    }
  }
  state.frame++;
} // tick

/** the video state in the shape of the game worker's 'frame' (WORKER-PROTOCOL.md) */
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
    state: 'boot'
  };
} // frameMessage

var timer = null;
var accumulator = 0;
var lastTime = 0;

function startLoop() {
  if (timer !== null) {
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
    while (accumulator >= TICK_MS && guard < 4 && !state.booted) {
      accumulator -= TICK_MS;
      guard++;
      tick();
    }
    if (guard > 0) {
      postMessage(frameMessage());
    }
    if (state.booted) {
      stopLoop();
      postMessage({id: 'booted', frame: state.frame});
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
      stopLoop();
      if (data.initData && data.initData.dsw0 !== undefined) dsw0 = data.initData.dsw0;
      if (data.initData && data.initData.dsw1 !== undefined) dsw1 = data.initData.dsw1;
      ram.fill(0);
      vram[0].fill(0); vram[1].fill(0);
      attr[0].fill(0); attr[1].fill(0);
      spr[0].fill(0); spr[1].fill(0);
      palbank = [0, 0]; charbank = [0, 0]; flip = [0, 0]; bgcolor = 0;
      state = {frame: 0, pending: 0, booted: false};
      accumulator = 0;
      program = bootProgram();
      startLoop();
      break;
    case 'reset':
      stopLoop();
      break;
  }
}; // onmessage

// tools (headless checks in Node) reach into the worker through this handle
self.__boot = {
  get state() { return state; },
  vram: vram, attr: attr, spr: spr,
  regs: function() { return {palbank: palbank, charbank: charbank, bgcolor: bgcolor}; },
  tick: tick
};
