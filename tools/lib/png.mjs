/**
 * Minimal PNG encoder (RGBA8, no dependencies beyond node:zlib) used by the
 * project tools for visual checks (rom2tiles --preview, render-screen).
 */
import zlib from 'node:zlib';

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c;
}

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeData), 0);
  return Buffer.concat([len, typeData, crc]);
}

/**
 * Encodes RGBA pixels into a PNG file buffer.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array|Uint8ClampedArray} rgba - width*height*4 bytes
 * @param {number} [scale=1] - integer nearest-neighbour upscale
 * @returns {Buffer}
 */
export function encodePNG(width, height, rgba, scale = 1) {
  const w = width*scale, h = height*scale;
  const raw = Buffer.alloc((w*4+1)*h);
  for (let y = 0; y < h; y++) {
    const rowStart = y*(w*4+1);
    raw[rowStart] = 0;   // filter: none
    const sy = Math.floor(y/scale);
    for (let x = 0; x < w; x++) {
      const si = (sy*width+Math.floor(x/scale))*4;
      const di = rowStart+1+x*4;
      raw[di] = rgba[si]; raw[di+1] = rgba[si+1]; raw[di+2] = rgba[si+2]; raw[di+3] = rgba[si+3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, {level: 9})),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

export default encodePNG;
