#!/usr/bin/env node
/**
 * render-dump.mjs — renders a machine dump into a PNG with app/tileMapRender.js.
 *
 * Accepts the dump layout shared by tools/refemu/run.mjs --dump and
 * tools/dis/trace-stinger.py --dump, so the ST-M1 Python tracer and refemu can be
 * compared through the very same renderer (tools/refemu/compare-python.sh).
 *
 * Usage: node tools/refemu/render-dump.mjs dump.bin out.png [scale]
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {TileMapRender} from '../../app/tileMapRender.js';
import {encodePNG} from '../lib/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

if (process.argv.length < 4) {
  console.error('usage: node tools/refemu/render-dump.mjs dump.bin out.png [scale]');
  process.exit(2);
}

const dump = new Uint8Array(fs.readFileSync(process.argv[2]));
let p = 0;
const take = (n) => { const s = dump.subarray(p, p+n); p += n; return s; };
take(0x800);                                                   // RAM, not used by the video hardware
const vram1 = take(0x400), attr1 = take(0x40), spr1 = take(0x20);
const vram0 = take(0x400), attr0 = take(0x40), spr0 = take(0x20);
const [, palbank0, palbank1, charbank0, charbank1, bgcolor] = take(6);

const read = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', name), 'utf8'));
const render = new TileMapRender({tiles: read('tiles.json'), sprites: read('sprites.json'), palette: read('palette.json')});

const state = {
  vram: [vram0, vram1],
  attr: [attr0, attr1],
  sprites: [spr0, spr1],
  regs: {palbank: palbank0 | (palbank1 << 1), charbank: [charbank0, charbank1], bgcolor: bgcolor, flip: [0, 0]}
};
const rgba = new Uint8ClampedArray(TileMapRender.WIDTH*TileMapRender.HEIGHT*4);
render.renderFrame(state, rgba);
fs.writeFileSync(process.argv[3], encodePNG(TileMapRender.WIDTH, TileMapRender.HEIGHT, rgba, parseInt(process.argv[4] || '1', 10)));
console.log(process.argv[3]+': palbank '+state.regs.palbank+', charbank '+state.regs.charbank.join('/')+', bgcolor '+bgcolor);
