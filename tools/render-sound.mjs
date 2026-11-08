#!/usr/bin/env node
/**
 * render-sound — renders the AY-3-8910 music to a WAV file so it can be listened
 * to (ST-M6; the milestone's last check is an A/B against a recording).
 *
 * Two sources:
 *   --from-log FILE   an --ay-nmi log from tools/refemu/run.mjs, i.e. the register
 *                     state of the real sound program, 240 times a second. This
 *                     needs nothing but app/aySynth.js and is the reference sound.
 *   --from-driver     app/soundDriver.js fed with the latch column of that same
 *                     log — the remake's own sequencer. Rendering both and
 *                     comparing is how the transcription gets an ear test on top
 *                     of the byte-exact one in tools/regress-sound.mjs.
 *   --from-board      the whole board as the browser hears it: the AudioWorklet
 *                     app/stingerSoundProcessor.js driven by the worker's own
 *                     soundBoard messages, so the discrete shot and explosion
 *                     circuits (F80Ah / F808h) are in the mix too. This is the
 *                     rendering to A/B against a recording of the machine.
 *   --limit           apply the AudioWorklet's output stage (headroom + soft
 *                     limiter from app/aySynth.js) so the rendering can be
 *                     compared with the browser like with like
 *   --live            with --from-board: start the worker the way the app does
 *                     (fast forward to the start of a life) instead of replaying
 *                     an input script from the reset.
 *
 * usage: node tools/render-sound.mjs --out sound.wav [--from-log FILE | --from-driver]
 *                                    [--script FILE] [--frames N] [--from F] [--to F]
 *                                    [--clock 1500000] [--rate 48000]
 *
 * With no --from-log the log is generated on the spot from --script/--frames.
 */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {AySynth, softLimit} from '../app/aySynth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i+1] : def; };
const flag = (name) => args.includes(name);

const outFile = path.resolve(ROOT, opt('--out', 'sound.wav'));
const rate = parseInt(opt('--rate', '48000'), 10);
const clock = parseInt(opt('--clock', '1500000'), 10);
const fromFrame = parseInt(opt('--from', '0'), 10);
const toFrame = parseInt(opt('--to', '999999'), 10);
const useDriver = flag('--from-driver');
const useBoard = flag('--from-board');
// --limit applies the same output stage the AudioWorklet does (headroom + soft
// limiter, both from app/aySynth.js), so a rendering can be compared with the
// browser like with like. The plain --from-driver path deliberately leaves it
// off: that is the one that has to come out byte-identical to the reference.
const useLimit = flag('--limit');

// ---------------------------------------------------------------- the whole board
/**
 * Runs app/stingerSoundProcessor.js outside a browser. The worklet is a classic
 * script with AudioWorkletProcessor/registerProcessor globals, so it is put
 * together exactly the way app/stingerSoundHandler.js does it (the bundleCode
 * transformation of svtool: the code after '// begin code', without the export
 * keywords) and evaluated with those two globals stubbed. Nothing is duplicated
 * — this renders the same code the browser runs.
 */
async function renderBoard() {
  const {default: vm} = await import('node:vm');
  const strip = (file) => {
    let code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const marker = code.indexOf('// begin code');
    if (marker >= 0) {
      code = code.slice(marker+'// begin code'.length);
    }
    return code.replace(/^[ \t]*export[ \t]+default[ \t]+[^\n;]+;[ \t]*$/gm, '')
      .replace(/^([ \t]*)export[ \t]+/gm, '$1');
  };
  const source = ['app/aySynth.js', 'app/soundDriver.js', 'app/stingerSoundProcessor.js']
    .map(strip).join('\n');

  let processor = null;
  const sandbox = {
    sampleRate: rate,
    currentTime: 0,
    console,
    AudioWorkletProcessor: class { constructor() { this.port = {onmessage: null, postMessage() {}}; } },
    registerProcessor: (name, cls) => { sandbox.__cls = cls; }
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, {filename: 'stingerSoundProcessor.js'});
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/sound.json'), 'utf8'));
  // the worklet has no atob, so the handler hands it plain byte arrays
  const tables = (data.tables || []).map((t) => Object.assign({}, t,
    {data: Array.from(Buffer.from(t.data, 'base64'))}));
  var roles = opt('--role', 'both') === 'both' ? ['sounds', 'music'] : [opt('--role', 'both')];
  return roles.map((role) => new sandbox.__cls({processorOptions: {role: role,
    soundData: Object.assign({}, data, {tables})}}));
}

// ---------------------------------------------------------------- whole board
if (useBoard) {
  const {default: vm2} = await import('node:vm');
  const processors = await renderBoard();
  // drive the game worker headless and hand the board its own frame messages
  const tables = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/tables.json'), 'utf8'));
  const KEYS0 = {c: 0x01, b: 0x04, '2': 0x08, '1': 0x10, f: 0x40};
  const KEYS1 = {r: 0x01, l: 0x02, u: 0x10, d: 0x20};
  const scriptPath = path.resolve(ROOT, opt('--script', 'sources/reference/input-play.txt'));
  const inputScript = fs.readFileSync(scriptPath, 'utf8').split('\n')
    .map((l) => l.split('#')[0].trim()).filter((l) => l.length)
    .map((l) => {
      const p2 = l.split(/\s+/);
      let a = 0, b = 0;
      for (const k of (p2[1] || '')) { if (KEYS0[k]) a |= KEYS0[k]; if (KEYS1[k]) b |= KEYS1[k]; }
      return {frame: parseInt(p2[0], 10), in0: a, in1: b};
    });
  // ★ R-046: plánovač workeru je `setTimeout`; nástroj si krokuje sám, tak je nečinný
  const box = {postMessage() {}, setTimeout: () => 0, clearTimeout() {},
               setInterval: () => 0, clearInterval() {}, console, performance, Buffer};
  box.self = box;
  vm2.createContext(box);
  vm2.runInContext(fs.readFileSync(path.join(ROOT, 'app/gameWorker.js'), 'utf8'), box, {filename: 'gameWorker.js'});
  // --live starts the worker the way the app does: it fast forwards through the
  // service screen, the title and the coin, and hands over at the start of a
  // life — so the rendering begins where the player's does, tune included.
  box.onmessage({data: {id: 'init', initData: flag('--live')
    ? {headless: false, attract: false, tables}
    : {headless: true, tables, inputScript}}});
  const worker = box.__st;

  const quantum = 128;
  const perFrame = Math.round(rate/60);
  const chunks = [];
  let rendered = 0;
  for (let f = 0; f <= toFrame; f++) {
    worker.tick();
    if (f < fromFrame) {
      continue;
    }
    const soundBoard = worker.frameMessage().soundBoard;
    for (const processor of processors) {
      processor.port.onmessage({data: {id: 'frame', soundBoard}});
    }
    for (let s2 = 0; s2 < perFrame; s2 += quantum) {
      const mixed = new Float32Array(quantum);
      for (const processor of processors) {
        const block = new Float32Array(quantum);
        processor.process([], [[block]], {});
        for (let i = 0; i < quantum; i++) {
          mixed[i] += block[i];
        }
      }
      chunks.push(mixed);
      rendered += quantum;
    }
  }
  const board = new Float32Array(rendered);
  let at = 0;
  for (const c of chunks) { board.set(c, at); at += c.length; }
  writeWav(board, rendered, 'app/stingerSoundProcessor.js ('+
    (processors.length > 1 ? 'both buses' : opt('--role', 'both'))+')');
  process.exit(0);
}

// ---------------------------------------------------------------- the log
let logFile = opt('--from-log', null);
if (!logFile) {
  const frames = parseInt(opt('--frames', '1200'), 10);
  const script = path.resolve(ROOT, opt('--script', 'sources/reference/input-play.txt'));
  logFile = path.join(process.env.SCRATCHPAD || fs.mkdtempSync('/tmp/st-sound-'), 'ay-nmi.tsv');
  console.log('reference: '+frames+' frames of '+path.relative(ROOT, script));
  execFileSync('node', [path.join(ROOT, 'tools/refemu/run.mjs'),
    '--frames', String(frames), '--quiet', '--input', script, '--ay-nmi', logFile],
    {cwd: ROOT, stdio: 'inherit'});
} else {
  logFile = path.resolve(ROOT, logFile);
}

const rows = fs.readFileSync(logFile, 'utf8').split('\n').slice(1).filter((l) => l.length)
  .map((line) => {
    const cell = line.split('\t');
    return {frame: parseInt(cell[0], 10), latch: parseInt(cell[2], 16),
      ay: cell.slice(3, 35).map((h) => parseInt(h, 16))};
  })
  .filter((row) => row.frame >= fromFrame && row.frame <= toFrame);

if (!rows.length) {
  console.error('no NMI rows in that frame range');
  process.exit(1);
}

// ---------------------------------------------------------------- render
let driver = null;
if (useDriver) {
  const {SoundDriver} = await import(path.join(ROOT, 'app/soundDriver.js'));
  driver = new SoundDriver(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/sound.json'), 'utf8')));
  driver.reset();
}

const synth = new AySynth({clock, sampleRate: rate, chips: 2});
const samplesPerNmi = rate/240;                 // the sound CPU's NMI is 240 Hz
const total = Math.floor(rows.length*samplesPerNmi);
const buffer = new Float32Array(total);
let written = 0;
let carry = 0;
for (const row of rows) {
  if (driver) {
    driver.nmi(row.latch);
    synth.setRegisters(0, driver.ay[0]);
    synth.setRegisters(1, driver.ay[1]);
  } else {
    synth.setRegisters(0, row.ay.slice(0, 16));
    synth.setRegisters(1, row.ay.slice(16, 32));
  }
  carry += samplesPerNmi;
  const take = Math.min(Math.floor(carry), total-written);
  carry -= take;
  if (take > 0) {
    synth.render(buffer.subarray(written, written+take), take);
    if (useLimit) {
      for (let i = written; i < written+take; i++) {
        buffer[i] = softLimit(buffer[i]);
      }
    }
    written += take;
  }
}

// ---------------------------------------------------------------- WAV
writeWav(buffer, written, driver ? 'app/soundDriver.js' : 'refemu log');

function writeWav(buffer, written, sourceName) {
let peak = 0;
for (let i = 0; i < written; i++) {
  const v = Math.abs(buffer[i]);
  if (v > peak) peak = v;
}
const scale = peak > 0 ? 0.89/peak : 1;
const pcm = Buffer.alloc(written*2);
for (let i = 0; i < written; i++) {
  let v = Math.round(buffer[i]*scale*32767);
  if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
  pcm.writeInt16LE(v, i*2);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36+pcm.length, 4);
header.write('WAVEfmt ', 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);                    // PCM
header.writeUInt16LE(1, 22);                    // mono
header.writeUInt32LE(rate, 24);
header.writeUInt32LE(rate*2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);
fs.mkdirSync(path.dirname(outFile), {recursive: true});
fs.writeFileSync(outFile, Buffer.concat([header, pcm]));

console.log(path.relative(ROOT, outFile)+': '+(written/rate).toFixed(2)+' s, '+rate+' Hz, AY clock '+
  (clock/1e6).toFixed(3)+' MHz, source '+sourceName+', peak '+peak.toFixed(3));
}
