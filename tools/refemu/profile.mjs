#!/usr/bin/env node
/**
 * profile — measures where the original program really spends its T-states
 * (ST-M4 aid).
 *
 * The worker in app/gameWorker.js is a hand transcription, so it cannot know how
 * long a routine takes; it has to be told. Guessing an average is not good
 * enough — the cost of the per-frame work swings by ten thousand T-states with
 * the number of live objects, and that decides whether the game loop fits
 * another iteration into the frame. This tool runs the reference machine, which
 * has an exact T-state Z80, and reports the real cost per PC range, per frame
 * and in total, so the charges in the transcription can be measured instead.
 *
 * usage: node tools/refemu/profile.mjs [--script FILE] [--frames N]
 *                                      [--from F] [--to F]
 *                                      [--range NAME=HEX-HEX ...] [--csv FILE]
 *                                      [--write-at HEX ...]
 *
 * --write-at reports, for every write to that address, the frame and how many
 * T-states into the frame the write happened. That is the instrument for phase
 * bugs: if the transcription writes the same byte a few hundred T-states later
 * than the original, it will land in the next frame and the regression shows a
 * one-frame shift with no other difference.
 *
 * The default ranges follow the structure of the program: the NMI core, its
 * callees, the enemy scripts, the spawn code and the collision code.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {StingerMachine} from './machine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i+1] : def; };

const DEFAULT_RANGES = [
  ['nmiCore', 0x0066, 0x0102],
  ['nmiCallees', 0x0103, 0x0FFF],
  ['mainLoop', 0x1000, 0x27FF],
  ['collide', 0x2820, 0x2CFF],
  ['gameLoop', 0x2D00, 0x33FF],
  ['spawn', 0x3400, 0x41FF],
  ['scripts', 0x8000, 0x95FF]
];
const ranges = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--range') {
    const [name, span] = args[i+1].split('=');
    const [from, to] = span.split('-').map((h) => parseInt(h, 16));
    ranges.push({name, from, to, tstates: 0, frameTstates: 0, frames: 0});
  }
}
if (!ranges.length) {
  for (const [name, from, to] of DEFAULT_RANGES) {
    ranges.push({name, from, to, tstates: 0, frameTstates: 0, frames: 0});
  }
}

const romDir = path.join(ROOT, 'sources/rom/stinger');
const roms = {
  opcodes: new Uint8Array(fs.readFileSync(path.join(romDir, 'decrypted/opcodes.bin'))),
  program: new Uint8Array(fs.readFileSync(path.join(romDir, 'decrypted/program.bin'))),
  sound: new Uint8Array(fs.readFileSync(path.join(romDir, '6-9f.bin')))
};
const machine = new StingerMachine(roms, {sound: false});
machine.profile = {ranges};

const KEYS0 = {c: 0x01, b: 0x04, '2': 0x08, '1': 0x10, f: 0x40};
const KEYS1 = {r: 0x01, l: 0x02, u: 0x10, d: 0x20};
const scriptFile = path.resolve(ROOT, opt('--script', 'sources/reference/input-play.txt'));
const events = fs.readFileSync(scriptFile, 'utf8').split('\n')
  .map((l) => l.split('#')[0].trim()).filter((l) => l.length)
  .map((l) => { const p = l.split(/\s+/); return {frame: parseInt(p[0], 10), keys: p.length > 1 ? p[1] : ''}; });

const frames = parseInt(opt('--frames', '900'), 10);
const from = parseInt(opt('--from', '0'), 10);
const to = parseInt(opt('--to', String(frames-1)), 10);
const csv = opt('--csv', null);
const rows = [];

const writeAt = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--write-at') {
    writeAt.push(parseInt(args[i+1], 16));
  }
}
const writeLog = [];
if (writeAt.length) {
  machine.bus.writeHook = (a, v) => {
    if (writeAt.indexOf(a) >= 0) {
      writeLog.push({frame: machine.frame, addr: a, value: v, offset: machine.frameOffset()});
    }
  };
}

let ei = 0;
for (let f = 0; f < frames; f++) {
  while (ei < events.length && events[ei].frame <= f) { machine.setKeys(events[ei].keys); ei++; }
  for (const r of ranges) r.frameTstates = 0;
  machine.runFrame();
  for (const r of ranges) {
    if (r.frameTstates) r.frames++;
  }
  if (f >= from && f <= to) {
    rows.push([f, ...ranges.map((r) => r.frameTstates)]);
  }
}

const pad = (v, n) => String(v).padStart(n);
if (writeLog.length) {
  console.log('writes (frame, address, value, T-states into the frame):');
  for (const w of writeLog) {
    if (w.frame < from || w.frame > to) continue;
    console.log('  frame '+pad(w.frame, 5)+'  '+w.addr.toString(16).toUpperCase().padStart(4, '0')+
      ' = '+w.value.toString(16).toUpperCase().padStart(2, '0')+'  at T+'+pad(w.offset, 6));
  }
  console.log('  ('+writeLog.length+' writes in total)');
  console.log();
}
if (rows.length) {
  console.log('frame  '+ranges.map((r) => pad(r.name, 10)).join(' '));
  for (const row of rows) {
    console.log(pad(row[0], 5)+'  '+row.slice(1).map((v) => pad(v, 10)).join(' '));
  }
  console.log();
}
console.log('over '+frames+' frames:');
console.log('  '+'range'.padEnd(12)+pad('total', 12)+pad('frames', 8)+pad('avg/frame', 12));
for (const r of ranges) {
  console.log('  '+r.name.padEnd(12)+pad(r.tstates, 12)+pad(r.frames, 8)+
    pad(r.frames ? Math.round(r.tstates/r.frames) : 0, 12));
}
if (csv) {
  fs.writeFileSync(csv, 'frame,'+ranges.map((r) => r.name).join(',')+'\n'+
    rows.map((row) => row.join(',')).join('\n')+'\n');
  console.log('\n'+csv+': '+rows.length+' rows');
}
