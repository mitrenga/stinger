#!/usr/bin/env node
/**
 * rom2tiles — converts the Stinger graphics ROMs and color PROMs into
 * data/tiles.json, data/sprites.json and data/palette.json (ST-M1; used by
 * app/tileMapRender.js, app/spriteLayerEntity.js). Derived from the Pleiads tool
 * (~/sw/pleiades/tools/rom2tiles.mjs), extended to 3 bitplanes, two tile banks
 * per region, 16x16 sprites and three 4-bit PROMs.
 *
 * usage: node tools/rom2tiles.mjs [spec.json] [--preview [out.png]]
 *
 * TILE FORMAT (MAME wiz.cpp `charlayout`): 8x8 pixels, 3 bitplanes at region
 * offsets 0x4000 (MSB, pixel bit 2), 0x2000 (bit 1), 0 (bit 0) - i.e. the three
 * ROM files of a region are the three planes, LSB plane first; 256 chars per
 * bank, 8 consecutive bytes per char (one byte per row), bank 0 at 0x0000, bank 1
 * at 0x0800 of every plane. xoffs {0..7} = MAME bit offsets counted from the MSB,
 * so hardware pixel x is bit (7-x) of the row byte.
 *
 * SPRITE FORMAT (`spritelayout`): 16x16, same planes, 32 bytes per sprite:
 * rows 0-7 left half bytes 0-7, right half bytes 8-15; rows 8-15 left half bytes
 * 16-23, right half 24-31. 256 sprites per region.
 *
 * ORIENTATION: the cabinet is ROT90 (MAME: 90 degrees clockwise). Hardware
 * (hx, hy) -> player (px, py) = (H-1-hy, hx); inside a tile px = 7-hy, py = hx
 * (16x16: px = 15-hy, py = hx). All tiles and sprites are stored ALREADY ROTATED
 * into the player orientation, so the renderer never rotates anything. (The
 * hardware flip-screen registers F006/F007 are not used by the remake.)
 *
 * PALETTE (wiz_state::palette, resnet.cpp compute_resistor_weights, ported 1:1):
 * 3 PROMs 256x4 (R, G, B); per gun resistors {1000, 470, 220, 100} ohm for bits
 * 0..3, pulldown 470 ohm, no pullup, autoscale to 0..255;
 * component = int(sum(weight[bit]*bit) + 0.5). 256 pens; pen of a pixel =
 * (paletteBank << 3 | color) * 8 + pixel, color = 3-bit color code of the tile
 * column / sprite, paletteBank = F002 bit 0 | F003 bit 0 << 1. Pixel 0 is
 * transparent for both tile layers and the sprites (MAME transpen 0); the
 * screen is filled with pen `bgcolor` (F818) first.
 *
 * tiles.json:   {format, gfx1: [bank0[256], bank1[256]], gfx2: [...], meta}
 *               tile = 64 chars '0'..'7', row-major, player orientation
 * sprites.json: {format, gfx1: [256], gfx2: [256], meta}   sprite = 256 chars
 * palette.json: {format, pens: [256 "#rrggbb"], weights, meta}
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {encodePNG} from './lib/png.mjs';

const args = process.argv.slice(2);
const preview = args.includes('--preview');
const positional = args.filter((a) => !a.startsWith('--'));
const here = path.dirname(new URL(import.meta.url).pathname);
const specFile = positional[0] || path.join(here, 'rom2tiles.spec.json');
const specDir = path.dirname(path.resolve(specFile));
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const num = (v) => (typeof v === 'string') ? parseInt(v, 16) : v;

const files = {};
function readRom(name) {
  const buf = fs.readFileSync(path.join(specDir, spec.romDir, name));
  files[name] = crypto.createHash('sha1').update(buf).digest('hex');
  return buf;
}

// ---------------------------------------------------------------- tiles & sprites

/** pixel (hx, hy) of char `code` in `bank` (hardware orientation) */
function tilePixel(planes, bank, code, hx, hy) {
  const off = bank*0x800+code*8+hy;
  const bit = 7-hx;
  return ((planes[0][off] >> bit) & 1) | (((planes[1][off] >> bit) & 1) << 1) | (((planes[2][off] >> bit) & 1) << 2);
}

/** pixel (hx, hy) of sprite `code` (hardware orientation) */
function spritePixel(planes, code, hx, hy) {
  const off = code*32+(hy & 7)+((hy >> 3)*16)+((hx >> 3)*8);
  const bit = 7-(hx & 7);
  return ((planes[0][off] >> bit) & 1) | (((planes[1][off] >> bit) & 1) << 1) | (((planes[2][off] >> bit) & 1) << 2);
}

function decodeTiles(planes, bank) {
  const tiles = [];
  for (let code = 0; code < 256; code++) {
    const chars = new Array(64);
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        chars[py*8+px] = String(tilePixel(planes, bank, code, py, 7-px));   // hx = py, hy = 7-px
      }
    }
    tiles.push(chars.join(''));
  }
  return tiles;
}

function decodeSprites(planes) {
  const sprites = [];
  for (let code = 0; code < 256; code++) {
    const chars = new Array(256);
    for (let py = 0; py < 16; py++) {
      for (let px = 0; px < 16; px++) {
        chars[py*16+px] = String(spritePixel(planes, code, py, 15-px));
      }
    }
    sprites.push(chars.join(''));
  }
  return sprites;
}

// ---------------------------------------------------------------- palette (resnet.cpp port)

/**
 * compute_resistor_weights for ONE network (count resistors, pulldown pd, pullup
 * pu, minval 0, maxval 255, autoscale). Returns scaled weights.
 */
function resistorWeights(resistances, pd, pu) {
  const n = resistances.length;
  const w = [];
  for (let k = 0; k < n; k++) {
    let R0 = (pd === 0) ? 1.0/1e12 : 1.0/pd;
    let R1 = (pu === 0) ? 1.0/1e12 : 1.0/pu;
    for (let j = 0; j < n; j++) {
      if (j === k) R1 += 1.0/resistances[j];
      else R0 += 1.0/resistances[j];
    }
    R0 = 1.0/R0; R1 = 1.0/R1;
    const vout = 255*R0/(R1+R0);
    w.push(Math.min(255, Math.max(0, vout)));
  }
  const sum = w.reduce((a, b) => a+b, 0);
  const scale = 255/sum;               // autoscale: all three nets are identical, so the max net is this one
  return w.map((x) => x*scale);
}

/** combine_weights: int(sum(tab[i]*bit_i) + 0.5) */
function combine(weights, value) {
  let v = 0;
  for (let i = 0; i < weights.length; i++) v += weights[i]*((value >> i) & 1);
  return Math.trunc(v+0.5);
}

// ---------------------------------------------------------------- main

const regions = {};
for (const name of Object.keys(spec.gfx)) {
  const planes = spec.gfx[name].planes.map(readRom);
  regions[name] = {
    tiles: [decodeTiles(planes, 0), decodeTiles(planes, 1)],
    sprites: decodeSprites(planes)
  };
}
const promR = readRom(spec.proms.r), promG = readRom(spec.proms.g), promB = readRom(spec.proms.b);
const weights = resistorWeights([1000, 470, 220, 100], 470, 0);
const pensRGB = [];
for (let i = 0; i < 256; i++) {
  pensRGB.push([combine(weights, promR[i] & 15), combine(weights, promG[i] & 15), combine(weights, promB[i] & 15)]);
}
const hex = (rgb) => '#'+rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
const pens = pensRGB.map(hex);

const meta = {source: 'MAME set stinger (Seibu Denshi), tools/rom2tiles.mjs, spec '+path.basename(specFile), files, generated: new Date().toISOString()};
const write = (key, obj) => {
  const f = path.resolve(specDir, spec.outputs[key]);
  fs.writeFileSync(f, JSON.stringify(obj).replace(/\],\[/g, '],\n[').replace(/","/g, '",\n"')+'\n');
  console.log('written '+f+' ('+fs.statSync(f).size+' bytes)');
};
write('tiles', {
  format: {tile: '64 chars 0-7, row-major, player orientation (ROT90 applied), index = y*8+x', banks: 'region[bank][code]; layer 1 (fg, D000) draws gfx1[F005 bit0], layer 0 (bg, E000) draws gfx2[F004 bit0]', pen: '(palbank<<3 | color)*8 + pixel; pixel 0 transparent'},
  gfx1: regions.gfx1.tiles, gfx2: regions.gfx2.tiles, meta
});
write('sprites', {
  format: {sprite: '256 chars 0-7, row-major 16x16, player orientation', sets: 'sprite set 1 (D840) draws gfx1, set 0 (E840) draws gfx2', pen: '(palbank<<3 | color)*8 + pixel; pixel 0 transparent'},
  gfx1: regions.gfx1.sprites, gfx2: regions.gfx2.sprites, meta
});
write('palette', {
  format: {pens: '256 "#rrggbb"; pen index = (palbank<<3 | color)*8 + pixel', proms: 'R = stinger.a7, G = stinger.b7, B = stinger.a8, bits 0..3 -> 1k/470/220/100 ohm, pulldown 470'},
  pens, weights, meta
});

if (preview) {
  const palbank = 0;
  const show = (s, w) => {
    for (let y = 0; y < w; y++) console.log('  '+s.substr(y*w, w).replace(/0/g, '.'));
  };
  for (const name of Object.keys(spec.previewTiles || {})) {
    const p = spec.previewTiles[name];
    p.codes.forEach((c) => { console.log(name+' bank '+p.bank+' tile 0x'+num(c).toString(16).padStart(2, '0')); show(regions[name].tiles[p.bank][num(c)], 8); });
  }
  // sheet: for each region: bank0 tiles (16x16 grid), bank1 tiles, sprites (16x16 grid of 16x16) side by side
  const cols = 16*8+8+16*8+8+16*16, rowsPer = 16*16, sheetW = cols, sheetH = 2*rowsPer+8;
  const rgba = new Uint8ClampedArray(sheetW*sheetH*4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const put = (x, y, pen) => {
    const [r, g, b] = pensRGB[pen];
    const di = (y*sheetW+x)*4; rgba[di] = r; rgba[di+1] = g; rgba[di+2] = b;
  };
  const drawGrid = (items, size, ox, oy, colorOf) => {
    items.forEach((s, code) => {
      const color = colorOf(code);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const pix = s.charCodeAt(y*size+x)-48;
        put(ox+(code & 15)*size+x, oy+(code >> 4)*size+y, (palbank << 3 | color)*8+pix);
      }
    });
  };
  Object.keys(regions).forEach((name, ri) => {
    const oy = ri*(rowsPer+8);
    const r = regions[name];
    drawGrid(r.tiles[0], 8, 0, oy, () => 1);
    drawGrid(r.tiles[1], 8, 16*8+8, oy, () => 1);
    drawGrid(r.sprites, 16, 2*(16*8+8), oy, () => 1);
  });
  const pngFile = positional[1] || path.join(process.env.SCRATCHPAD || os.tmpdir(), 'stinger-gfx.png');
  fs.writeFileSync(pngFile, encodePNG(sheetW, sheetH, rgba, 3));
  console.log('preview PNG: '+pngFile+' (rows: gfx1, gfx2; columns: tiles bank 0, tiles bank 1, sprites; color code 1, palette bank 0)');
}
