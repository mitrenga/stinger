#!/usr/bin/env node
/**
 * match-boot — app/bootWorker.js against app/gameWorker.js, frame by frame.
 *
 * The boot worker is a copy of the power-on sequence (main_start 0C85h ->
 * powerOnScreen 0D4Ah) taken out of the 1:1 transcription so that BootModel
 * can show it as the loading animation. The game worker is the oracle: both
 * are ticked from the reset in lockstep and the video state (both layers,
 * attributes, sprite registers, video registers) has to be identical on every
 * frame until the boot worker reports the end of the boot. The tool also
 * prints where the game worker begins to draw the title, which must come after
 * that frame.
 *
 *   node tools/match-boot.mjs            -> "0 differences" is the acceptance
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadWorker(file) {
  // ★ R-046: plánovač workeru je `setTimeout`
  const sandbox = {console, performance, Buffer, setTimeout, clearTimeout,
                   setInterval, clearInterval, postMessage() {}};
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, {filename: file});
  return sandbox;
} // loadWorker

const tables = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/tables.json'), 'utf8'));
const game = loadWorker('app/gameWorker.js');
game.onmessage({data: {id: 'init', initData: {headless: true, tables}}});
const boot = loadWorker('app/bootWorker.js');
boot.onmessage({data: {id: 'init', initData: {}}});
const G = game.__st, B = boot.__boot;

let differences = 0;
let bootEnd = -1;
let titleStart = -1;
let lastVideo = null;

function compare(frame, name, expected, got) {
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== got[i]) {
      differences++;
      console.log(`frame ${frame}: ${name}[${i.toString(16).toUpperCase()}h] game=${expected[i]} boot=${got[i]}`);
      return;
    }
  }
} // compare

for (let f = 0; f < 400 && titleStart < 0; f++) {
  G.tick();
  if (bootEnd < 0) {
    B.tick();
    if (B.state.booted) {
      // the boot ended inside this frame and the game worker spent the rest of
      // it in drawTitle, so this frame is the first one that may differ
      bootEnd = B.state.frame;
      continue;
    }
    const frame = G.state.frame;
    compare(frame, 'VRAM1 D000', G.vram[1], B.vram[1]);
    compare(frame, 'VRAM0 E000', G.vram[0], B.vram[0]);
    compare(frame, 'ATTR1 D800', G.attr[1], B.attr[1]);
    compare(frame, 'ATTR0 E800', G.attr[0], B.attr[0]);
    compare(frame, 'SPR1 D840', G.spr[1], B.spr[1]);
    compare(frame, 'SPR0 E840', G.spr[0], B.spr[0]);
    const gr = G.regs(), br = B.regs();
    compare(frame, 'REGS', [gr.palbank[0], gr.palbank[1], gr.charbank[0], gr.charbank[1], gr.bgcolor],
                           [br.palbank[0], br.palbank[1], br.charbank[0], br.charbank[1], br.bgcolor]);
  } else {
    // after the boot: the first frame on which the game worker's picture changes
    // is the start of drawTitle (0F2Eh)
    const video = Buffer.concat([G.vram[0], G.vram[1], G.attr[0], G.attr[1]]).toString('hex');
    if (lastVideo !== null && video !== lastVideo) {
      titleStart = G.state.frame;
    }
    lastVideo = video;
  }
}

console.log(`boot ends at frame ${bootEnd}, the title starts to be drawn at frame ${titleStart}`);
console.log(`${differences} differences over ${bootEnd} frames`);
if (differences || bootEnd < 0 || titleStart <= bootEnd) {
  process.exit(1);
}
