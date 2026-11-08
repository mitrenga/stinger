#!/usr/bin/env node
/**
 * regress — runs app/gameWorker.js headless in Node and compares it, frame by
 * frame, with the reference emulator tools/refemu (ST-M4).
 *
 * usage: node tools/regress.mjs [--frames N] [--script sources/reference/input-play.txt]
 *                               [--random SEED [--period P]] [--watch NAME]
 *                               [--dump-at F1,F2] [--first N] [--keep] [--quiet]
 *
 * Alignment: both sides start at the reset (frame 0) and get the same input
 * script. refemu writes its watch row after running frame n; the worker is
 * sampled after tick n. A difference is therefore always reported at the first
 * frame where the transcription and the original program part company, with the
 * address, the expected byte and the byte the worker produced.
 *
 * Watch groups (--watch, comma separated, default "frame"):
 *   frame   the frame/state variables of notes/A.md (counters, state, credits,
 *           lives, round, score, RNG)
 *   video   the attribute and sprite shadows C100-C1BF and the video registers
 *   player  ship, shots, Bongo, altitude zone (notes/C.md)
 *   enemy   the A and B object records, spawn requests, difficulty (notes/D.md)
 *   ram     the whole work RAM C000-C6FF (the stack page is excluded: the
 *           worker has no Z80 stack)
 *   all     every group
 * --dump-at additionally compares both video RAM pages, both attribute pages,
 * both sprite RAM pages and the video registers at the given frames (the picture
 * itself, which --watch never covers).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i+1] : def; };
const flag = (name) => args.includes(name);

const frames = parseInt(opt('--frames', '1200'), 10);
const firstOnly = parseInt(opt('--first', '10'), 10);
const quiet = flag('--quiet');
const tmp = flag('--keep') ? path.join(ROOT, 'tmp/regress')
  : (process.env.SCRATCHPAD || fs.mkdtempSync('/tmp/st-regress-'));
fs.mkdirSync(tmp, {recursive: true});

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');

// ---------------------------------------------------------------- watch groups
const range = (a, b) => { const out = []; for (let x = a; x <= b; x++) out.push(x); return out; };
const GROUPS = {
  frame: [
    ...range(0xC0A0, 0xC0AC), ...range(0xC0B1, 0xC0B9), ...range(0xC0BB, 0xC0BF),
    ...range(0xC06D, 0xC08A), 0xC000, 0xC003, 0xC004, 0xC005, 0xC006, 0xC007,
    0xC030, 0xC515, 0xC520, 0xC666, 0xC667
  ],
  video: [...range(0xC100, 0xC1BF), ...range(0xC0AF, 0xC0B0), ...range(0xC0B7, 0xC0B8),
    ...range(0xC260, 0xC263), 0xC525, ...range(0xC528, 0xC530)],
  player: [...range(0xC140, 0xC15F), ...range(0xC220, 0xC223), ...range(0xC22C, 0xC22F),
    ...range(0xC23C, 0xC23F), ...range(0xC280, 0xC2A1), 0xC310, 0xC330, 0xC533, 0xC534, 0xC00A],
  enemy: [...range(0xC224, 0xC243), 0xC526, 0xC531, 0xC532],
  ram: range(0xC000, 0xC6FF)
};
const wanted = opt('--watch', 'frame').split(',').map((s) => s.trim());
let watchAddrs = [];
if (wanted.includes('all')) {
  watchAddrs = GROUPS.ram.slice();
} else {
  for (const name of wanted) {
    if (!GROUPS[name]) {
      console.error('unknown watch group: '+name+' (have '+Object.keys(GROUPS).join(', ')+', all)');
      process.exit(2);
    }
    watchAddrs.push(...GROUPS[name]);
  }
}
watchAddrs = [...new Set(watchAddrs)].sort((a, b) => a-b);

// ---------------------------------------------------------------- input script
const START_SCRIPT = [];   // no input: pure attract
let inputScript;
let scriptFile = path.join(tmp, 'script.txt');
if (opt('--random', null) !== null) {
  let seed = parseInt(opt('--random', '1'), 10) >>> 0;
  const rnd = () => { seed = (seed*1103515245+12345) >>> 0; return (seed >>> 8) & 0xFFFF; };
  const period = parseInt(opt('--period', '7'), 10);
  inputScript = [{frame: 300, in0: 0x01}, {frame: 306, in0: 0}, {frame: 340, in0: 0x10}, {frame: 346, in0: 0}];
  for (let f = 400; f < frames; f += period) {
    const r = rnd();
    let a = 0, b = 0;
    if (r & 1) a |= 0x40;                        // fire
    if ((r >> 1) & 1) a |= 0x04;                 // bongo
    const dir = (r >> 2) % 5;
    if (dir === 1) b |= 0x01; else if (dir === 2) b |= 0x02;
    if ((r >> 5) % 3 === 1) b |= 0x10; else if ((r >> 5) % 3 === 2) b |= 0x20;
    inputScript.push({frame: f, in0: a, in1: b});
  }
} else {
  const file = path.resolve(ROOT, opt('--script', 'sources/reference/input-play.txt'));
  const KEYS0 = {c: 0x01, b: 0x04, '2': 0x08, '1': 0x10, f: 0x40};
  const KEYS1 = {r: 0x01, l: 0x02, u: 0x10, d: 0x20};
  inputScript = fs.readFileSync(file, 'utf8').split('\n')
    .map((line) => line.split('#')[0].trim()).filter((line) => line.length)
    .map((line) => {
      const parts = line.split(/\s+/);
      const keys = parts.length > 1 ? parts[1] : '';
      let a = 0, b = 0;
      for (const k of keys) { if (KEYS0[k]) a |= KEYS0[k]; if (KEYS1[k]) b |= KEYS1[k]; }
      return {frame: parseInt(parts[0], 10), in0: a, in1: b};
    });
}
// refemu reads the same scenario from a key-letter script
const LETTERS0 = [[0x01, 'c'], [0x04, 'b'], [0x08, '2'], [0x10, '1'], [0x40, 'f']];
const LETTERS1 = [[0x01, 'r'], [0x02, 'l'], [0x10, 'u'], [0x20, 'd']];
fs.writeFileSync(scriptFile, inputScript.map((e) => {
  let keys = '';
  for (const [bit, ch] of LETTERS0) if (e.in0 & bit) keys += ch;
  for (const [bit, ch] of LETTERS1) if ((e.in1 || 0) & bit) keys += ch;
  return e.frame+(keys ? ' '+keys : '');
}).join('\n')+'\n');

// ---------------------------------------------------------------- reference run
const watchFile = path.join(tmp, 'watch.tsv');
const addrArg = watchAddrs.map((a) => a.toString(16)).join(',');
if (!quiet) {
  console.log('reference: '+frames+' frames, '+watchAddrs.length+' watched addresses');
}
const dumpAt = [...new Set(opt('--dump-at', '').split(',').filter((s) => s.length).map((s) => parseInt(s, 10)))]
  .filter((f) => f >= 0 && f < frames).sort((a, b) => a-b);
const dumpArgs = [];
for (const f of dumpAt) {
  dumpArgs.push('--dump', f+'='+path.join(tmp, 'ref-'+f+'.bin'));
}
execFileSync('node', [path.join(ROOT, 'tools/refemu/run.mjs'),
  '--frames', String(frames), '--quiet', '--no-sound',
  '--input', scriptFile, '--watch', watchFile, '--watch-addrs', addrArg, ...dumpArgs],
  {cwd: ROOT, stdio: 'inherit'});

const lines = fs.readFileSync(watchFile, 'utf8').split('\n');
const header = lines[0].split('\t').slice(1);
const reference = lines.slice(1).filter((l) => l.length).map((l) => l.split('\t').slice(1));

// ---------------------------------------------------------------- worker run
const tables = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/tables.json'), 'utf8'));
const messages = [];
const sandbox = {
  postMessage: (m) => messages.push(m),
  // ★ R-046: worker plánuje **rekurzivním `setTimeout`**, ne `setInterval`.
  // Nástroj si ho krokuje sám, takže plánovač je tady naschvál **nečinný**;
  // `setInterval` tu zůstává jen proto, že ho sandbox mívá dokola.
  setTimeout: () => 0, clearTimeout: () => {},
  setInterval: () => 0, clearInterval: () => {},
  console, performance, Buffer
};
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/gameWorker.js'), 'utf8'), sandbox, {filename: 'gameWorker.js'});
sandbox.onmessage({data: {id: 'init', initData: {headless: true, tables, inputScript}}});
const worker = sandbox.__st;

// ---------------------------------------------------------------- compare
const found = [];
const videoProblems = [];
const dumpFrames = new Set(dumpAt);
let lastGood = -1;

/**
 * Compares the worker's video state with a refemu dump: VRAM1, ATTR1+SPR1,
 * VRAM0, ATTR0+SPR0 and the video registers, in the layout of
 * tools/refemu/run.mjs --dump (RAM first, which is already covered by --watch).
 */
function compareVideo(frame) {
  const dump = fs.readFileSync(path.join(tmp, 'ref-'+frame+'.bin'));
  let p = 0x800;                       // skip the work RAM
  const take = (n) => { const s = dump.subarray(p, p+n); p += n; return s; };
  const parts = [
    ['VRAM1 D000', take(0x400), worker.vram[1]],
    ['ATTR1 D800', take(0x40), worker.attr[1]],
    ['SPR1  D840', take(0x20), worker.spr[1]],
    ['VRAM0 E000', take(0x400), worker.vram[0]],
    ['ATTR0 E800', take(0x40), worker.attr[0]],
    ['SPR0  E840', take(0x20), worker.spr[0]]
  ];
  for (const [name, expected, got] of parts) {
    let differing = 0, firstAt = -1;
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] !== got[i]) {
        differing++;
        if (firstAt < 0) firstAt = i;
      }
    }
    if (differing) {
      videoProblems.push({frame, name, differing, total: expected.length, firstAt,
        expected: expected[firstAt], got: got[firstAt]});
    }
  }
  const regs = worker.regs();
  const refRegs = [dump[p], dump[p+1], dump[p+2], dump[p+3], dump[p+4], dump[p+5]];
  const ours = [regs.nmiEnable, regs.palbank[0], regs.palbank[1], regs.charbank[0], regs.charbank[1], regs.bgcolor];
  const names = ['NMI_EN', 'PALBANK0', 'PALBANK1', 'CHARBANK0', 'CHARBANK1', 'BGCOLOR'];
  for (let i = 0; i < 6; i++) {
    if (refRegs[i] !== ours[i]) {
      videoProblems.push({frame, name: names[i], differing: 1, total: 1, firstAt: 0,
        expected: refRegs[i], got: ours[i]});
    }
  }
} // compareVideo

for (let f = 0; f < frames; f++) {
  try {
    worker.tick();
  } catch (error) {
    console.error('worker threw at frame '+f+': '+error.message);
    console.error(error.stack.split('\n').slice(1, 4).join('\n'));
    break;
  }
  const row = reference[f];
  if (!row) {
    break;
  }
  let ok = true;
  for (let i = 0; i < watchAddrs.length; i++) {
    const expected = parseInt(row[i], 16);
    const got = worker.rd(watchAddrs[i]);
    if (expected !== got) {
      ok = false;
      if (found.length < firstOnly) {
        found.push({frame: f, addr: watchAddrs[i], expected, got});
      }
    }
  }
  if (ok && lastGood === f-1) {
    lastGood = f;
  }
  if (dumpFrames.has(f)) {
    compareVideo(f);
  }
  if (found.length >= firstOnly) {
    break;
  }
}

// ---------------------------------------------------------------- report
function reportVideo() {
  if (!dumpAt.length) {
    return;
  }
  if (!videoProblems.length) {
    console.log('video: '+dumpAt.length+' compared frame(s), identical');
    return;
  }
  console.log('video differences:');
  for (const v of videoProblems.slice(0, 20)) {
    console.log('  frame '+v.frame+'  '+v.name+': '+v.differing+' of '+v.total+
      ' bytes, first at +'+hex4(v.firstAt)+' (refemu '+hex2(v.expected)+', worker '+hex2(v.got)+')');
  }
}

if (found.length === 0) {
  console.log('OK: '+frames+' frames, '+watchAddrs.length+' addresses, 0 differences');
  reportVideo();
  process.exit(videoProblems.length ? 1 : 0);
}
console.log('first difference at frame '+found[0].frame+' (frames 0-'+lastGood+' agree)');
const byFrame = new Map();
for (const d of found) {
  if (!byFrame.has(d.frame)) byFrame.set(d.frame, []);
  byFrame.get(d.frame).push(d);
}
for (const [frame, list] of byFrame) {
  console.log('  frame '+frame+':');
  for (const d of list.slice(0, 12)) {
    console.log('    '+hex4(d.addr)+'  refemu '+hex2(d.expected)+'  worker '+hex2(d.got));
  }
  if (list.length > 12) {
    console.log('    ... and '+(list.length-12)+' more addresses');
  }
}
reportVideo();
process.exit(1);
