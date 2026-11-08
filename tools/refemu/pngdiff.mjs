#!/usr/bin/env node
/**
 * pngdiff.mjs — compares two PNG files pixel by pixel (RGB, alpha ignored).
 *
 * Needed because a byte comparison is useless here: the ST-M1 Python tracer
 * writes 8-bit RGB PNGs and tools/lib/png.mjs writes RGBA ones, so identical
 * pictures produce different files. Decodes both (all five filter types,
 * 8 bits per channel, colour types 2 and 6) and reports how many pixels differ.
 *
 * Usage: node tools/refemu/pngdiff.mjs a.png b.png [--diff out.png]
 * Exit code 0 when the pictures are identical, 1 when they are not.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import {encodePNG} from '../lib/png.mjs';

/** decodes a PNG into {width, height, rgb: Uint8Array(width*height*3)} */
export function decodePNG(file) {
  const data = fs.readFileSync(file);
  let pos = 8, width = 0, height = 0, colorType = 0, depth = 0;
  const idat = [];
  while (pos < data.length) {
    const length = data.readUInt32BE(pos);
    const type = data.toString('latin1', pos+4, pos+8);
    const body = data.subarray(pos+8, pos+8+length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
    } else if (type === 'IDAT') {
      idat.push(body);
    }
    pos += 12+length;
  }
  if (depth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(file+': only 8-bit RGB/RGBA PNGs are supported (depth '+depth+', color type '+colorType+')');
  }
  const bpp = colorType === 2 ? 3 : 4;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width*bpp;
  const rgb = new Uint8Array(width*height*3);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p+stride));
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x-bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x-bpp] : 0;
      switch (filter) {
        case 1: line[x] = (line[x]+a) & 0xFF; break;
        case 2: line[x] = (line[x]+b) & 0xFF; break;
        case 3: line[x] = (line[x]+((a+b) >> 1)) & 0xFF; break;
        case 4: {
          const pp = a+b-c;
          const pa = Math.abs(pp-a), pb = Math.abs(pp-b), pc = Math.abs(pp-c);
          line[x] = (line[x]+(pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 0xFF;
          break;
        }
      }
    }
    prev = line;
    for (let x = 0; x < width; x++) {
      rgb[(y*width+x)*3] = line[x*bpp];
      rgb[(y*width+x)*3+1] = line[x*bpp+1];
      rgb[(y*width+x)*3+2] = line[x*bpp+2];
    }
  }
  return {width, height, rgb};
}

/** compares two decoded pictures; returns {different, first} */
export function comparePictures(a, b) {
  let different = 0;
  let first = null;
  for (let i = 0, pixel = 0; i < a.rgb.length; i += 3, pixel++) {
    if (a.rgb[i] !== b.rgb[i] || a.rgb[i+1] !== b.rgb[i+1] || a.rgb[i+2] !== b.rgb[i+2]) {
      different++;
      if (first === null) {
        first = {x: pixel%a.width, y: Math.floor(pixel/a.width)};
      }
    }
  }
  return {different, first};
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  if (process.argv.length < 4) {
    console.error('usage: node tools/refemu/pngdiff.mjs a.png b.png [--diff out.png]');
    process.exit(2);
  }
  const a = decodePNG(process.argv[2]);
  const b = decodePNG(process.argv[3]);
  if (a.width !== b.width || a.height !== b.height) {
    console.log('DIFFERENT size: '+a.width+'x'+a.height+' vs '+b.width+'x'+b.height);
    process.exit(1);
  }
  const result = comparePictures(a, b);
  const diffIndex = process.argv.indexOf('--diff');
  if (diffIndex > 0 && process.argv[diffIndex+1]) {
    const rgba = new Uint8ClampedArray(a.width*a.height*4);
    for (let i = 0, p = 0; p < a.rgb.length; i += 4, p += 3) {
      const same = a.rgb[p] === b.rgb[p] && a.rgb[p+1] === b.rgb[p+1] && a.rgb[p+2] === b.rgb[p+2];
      rgba[i] = same ? (a.rgb[p] >> 2) : 255;
      rgba[i+1] = same ? (a.rgb[p+1] >> 2) : 0;
      rgba[i+2] = same ? (a.rgb[p+2] >> 2) : 255;
      rgba[i+3] = 255;
    }
    fs.writeFileSync(process.argv[diffIndex+1], encodePNG(a.width, a.height, rgba));
  }
  if (result.different === 0) {
    console.log('identical ('+a.width+'x'+a.height+')');
    process.exit(0);
  }
  console.log('DIFFERENT: '+result.different+' of '+(a.width*a.height)+' pixels, first at '+result.first.x+','+result.first.y);
  process.exit(1);
}
