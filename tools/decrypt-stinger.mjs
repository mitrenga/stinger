#!/usr/bin/env node
/**
 * decrypt-stinger — builds the decrypted OPCODE image of the Stinger main CPU ROM
 * (ST-M1, GAME-DESIGN chap. 2.7). Port of MAME `stinger_state::init_stinger`
 * (sources/mame/wiz.cpp, BSD-3-Clause, Zsolt Vasvari).
 *
 * usage: node tools/decrypt-stinger.mjs [romDir] [outDir]
 *   romDir  default sources/rom/stinger   (1-5j.bin .. 5-10j.bin, SHA1 checked)
 *   outDir  default sources/rom/stinger/decrypted
 *
 * Only M1 (opcode) fetches are encrypted on the board; operands and data are read
 * unencrypted. Therefore two images are written:
 *   program.bin  40 KiB, the ROMs concatenated (data / operand image)
 *   opcodes.bin  40 KiB, the same bytes decrypted (opcode image)
 * A disassembler must take the opcode byte from opcodes.bin and the operand bytes
 * from program.bin (tools/dis/disz80.py does).
 *
 * Encryption (init_stinger): addresses with (a & 0x2040) != 0 are NOT encrypted.
 * Otherwise row = bit3(a) + 2*bit5(a) selects {s0, s1, s2, xor} from
 *   { 7,3,5, 0xa0 }, { 3,7,5, 0x88 }, { 5,3,7, 0x80 }, { 5,7,3, 0x28 }
 * and dec = bitswap<8>(src, s0,6,s1,4,s2,2,1,0) ^ xor, i.e. result bits 7,5,3 are
 * taken from source bits s0,s1,s2 (a permutation of 7,5,3) and bits 6,4,2,1,0 stay.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROMS = [
  ['1-5j.bin', 0x0000, '473e89f2c49f6e6f38df5d6fc2267ffecf84c6c8'],
  ['2-6j.bin', 0x2000, '38bb589b3bfd962415b31d1151adf4bdb661122f'],
  ['3-8j.bin', 0x4000, 'c23eac49e06ff38564062c0e8c8cdadf877f1d6a'],
  ['4-9j.bin', 0x6000, '31d54d9fd5254c33f07c605bd6112c7eb53c42a1'],
  ['5-10j.bin', 0x8000, 'e03860813c03ca1c737935accc2b5fe87c6b624a']
];
const SIZE = 0xA000;
const TABLE = [[7, 3, 5, 0xa0], [3, 7, 5, 0x88], [5, 3, 7, 0x80], [5, 7, 3, 0x28]];

const here = path.dirname(new URL(import.meta.url).pathname);
const romDir = process.argv[2] || path.join(here, '..', 'sources', 'rom', 'stinger');
const outDir = process.argv[3] || path.join(romDir, 'decrypted');

const program = Buffer.alloc(SIZE);
for (const [name, off, sha] of ROMS) {
  const data = fs.readFileSync(path.join(romDir, name));
  const got = crypto.createHash('sha1').update(data).digest('hex');
  if (got !== sha) {
    console.error(`${name}: SHA1 ${got} != ${sha}`);
    process.exit(1);
  }
  data.copy(program, off);
}

const bit = (v, n) => (v >> n) & 1;
export function decryptByte(a, src) {
  if (a & 0x2040) return src;
  const [s0, s1, s2, x] = TABLE[bit(a, 3) + 2*bit(a, 5)];
  const dec = (bit(src, s0) << 7) | (bit(src, 6) << 6) | (bit(src, s1) << 5) | (bit(src, 4) << 4)
            | (bit(src, s2) << 3) | (src & 0x07);
  return dec ^ x;
}

const opcodes = Buffer.alloc(SIZE);
for (let a = 0; a < SIZE; a++) opcodes[a] = decryptByte(a, program[a]);

fs.mkdirSync(outDir, {recursive: true});
fs.writeFileSync(path.join(outDir, 'program.bin'), program);
fs.writeFileSync(path.join(outDir, 'opcodes.bin'), opcodes);

// sanity: entry points should look like code
const hex = (b, n = 8) => Array.from(b.subarray(0, n)).map((x) => x.toString(16).padStart(2, '0')).join(' ');
console.log(`written ${outDir}/program.bin, opcodes.bin (${SIZE} bytes each)`);
console.log('opcodes @0000:', hex(opcodes.subarray(0x0000)));
console.log('opcodes @0038:', hex(opcodes.subarray(0x0038)));
console.log('opcodes @0066:', hex(opcodes.subarray(0x0066)));
