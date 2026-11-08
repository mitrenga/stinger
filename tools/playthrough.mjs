#!/usr/bin/env node
/**
 * playthrough — drives app/gameWorker.js through a whole game and reports what
 * happened (ST-M4 functional check).
 *
 * tools/regress.mjs proves the transcription matches the original byte for byte;
 * this proves the other thing the milestone asks for — that the game actually
 * plays: coin, start, the rounds advancing every 1024 frames, the deaths, the
 * game over, and the attract cycle resuming afterwards. It needs no reference
 * emulator, so it also works as a quick smoke test after any change.
 *
 * usage: node tools/playthrough.mjs [--seed N] [--frames N] [--quiet]
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i+1] : def; };
const quiet = args.includes('--quiet');
const frames = parseInt(opt('--frames', '40000'), 10);

const tables = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/tables.json'), 'utf8'));
// ★ R-046: plánovač workeru je `setTimeout`; nástroj si krokuje sám, tak je nečinný
const sandbox = {postMessage() {}, setTimeout: () => 0, clearTimeout() {},
                 setInterval: () => 0, clearInterval() {}, console, performance, Buffer};
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/gameWorker.js'), 'utf8'), sandbox, {filename: 'gameWorker.js'});

// coin, start, then a random joystick/fire/bongo combination every 7 frames
let seed = parseInt(opt('--seed', '7'), 10) >>> 0;
const rnd = () => { seed = (seed*1103515245+12345) >>> 0; return (seed >>> 8) & 0xFFFF; };
const inputScript = [{frame: 300, in0: 0x01}, {frame: 306, in0: 0}, {frame: 340, in0: 0x10}, {frame: 346, in0: 0}];
for (let f = 400; f < frames; f += 7) {
  const r = rnd();
  let a = 0, b = 0;
  if (r & 1) a |= 0x40;                                  // fire
  if ((r >> 1) & 1) a |= 0x04;                           // bongo
  const dir = (r >> 2)%5;
  if (dir === 1) b |= 0x01; else if (dir === 2) b |= 0x02;
  const vert = (r >> 5)%3;
  if (vert === 1) b |= 0x10; else if (vert === 2) b |= 0x20;
  inputScript.push({frame: f, in0: a, in1: b});
}

sandbox.onmessage({data: {id: 'init', initData: {headless: true, tables, inputScript}}});
const worker = sandbox.__st;

const STATE = {0: 'init', 1: 'redraw title', 2: 'title', 4: 'demo', 5: 'game'};
const score = () => { let v = 0; for (let i = 5; i >= 0; i--) v = v*10+(worker.rd(0xC06D+i) & 0x0F); return v*10; };

const events = [];
let previous = {};
let deaths = 0, gameOvers = 0, maxRound = 0, maxScore = 0;
for (let f = 0; f < frames; f++) {
  worker.tick();
  const now = {state: worker.rd(0xC0A2), lives: worker.rd(0xC0B1), round: worker.rd(0xC0BB)};
  if (now.state !== previous.state) {
    events.push('f'+String(f).padStart(6)+'  state -> '+(STATE[now.state] || now.state));
    if (previous.state === 5 && now.state === 1) gameOvers++;
  }
  if (now.lives !== previous.lives) {
    events.push('f'+String(f).padStart(6)+'  lives -> '+now.lives+(now.lives < previous.lives ? '  (death)' : ''));
    if (previous.lives !== undefined && now.lives < previous.lives) deaths++;
  }
  if (now.round !== previous.round && now.round > previous.round) {
    events.push('f'+String(f).padStart(6)+'  round -> '+now.round);
  }
  if (now.round > maxRound) maxRound = now.round;
  const s = score();
  if (s > maxScore) maxScore = s;
  previous = now;
}

if (!quiet) {
  console.log(events.slice(0, 60).join('\n'));
  if (events.length > 60) console.log('... and '+(events.length-60)+' more events');
  console.log();
}
console.log('seed '+opt('--seed', '7')+', '+frames+' frames: '+deaths+' deaths, '+gameOvers+
  ' game over(s), highest round '+maxRound+', best score '+maxScore);
if (deaths === 0 || gameOvers === 0) {
  console.error('the game never reached a game over — the playthrough proves nothing');
  process.exit(1);
}
