#!/usr/bin/env node
// zexrun.mjs — CP/M harness pro ZEXDOC / ZEXALL.
// Použití: node tools/refemu/zexrun.mjs sources/reference/zex/zexdoc.com

import fs from 'node:fs';
import { Z80 } from './z80.js';

const file = process.argv[2];
if (!file) {
  process.stderr.write('použití: node zexrun.mjs <soubor.com>\n');
  process.exit(2);
}

const mem = new Uint8Array(65536);
const prog = fs.readFileSync(file);
mem.set(prog, 0x0100);
mem[0x0000] = 0x76;  // ukončení běhu (návrat na 0x0000)
mem[0x0005] = 0xC9;  // BDOS -> RET (obsluha se dělá před krokem)

const bus = {
  read(a) { return mem[a]; },
  write(a, v) { mem[a] = v; },
  fetch(a) { return mem[a]; },
  in() { return 0xFF; },
  out() { },
};

const cpu = new Z80(bus);
cpu.reset();
cpu.pc = 0x0100;
cpu.sp = 0xF000;

// průběžný výstup po řádcích
let lineBuf = '';
let okCount = 0, errCount = 0;
let lastLine = '';

function putch(ch) {
  const s = String.fromCharCode(ch);
  process.stdout.write(s);
  if (s === '\n') {
    const line = lineBuf.replace(/\r/g, '');
    if (line.trim() !== '') lastLine = line;
    if (line.includes('ERROR')) errCount++;
    else if (/\bOK\b/.test(line)) okCount++;
    lineBuf = '';
  } else if (s !== '\r') {
    lineBuf += s;
  } else {
    lineBuf += s;
  }
}

function bdos() {
  const c = cpu.c;
  if (c === 2) {
    putch(cpu.e);
  } else if (c === 9) {
    let addr = ((cpu.d << 8) | cpu.e) & 0xFFFF;
    for (let guard = 0; guard < 65536; guard++) {
      const ch = mem[addr];
      if (ch === 0x24) break; // '$'
      putch(ch);
      addr = (addr + 1) & 0xFFFF;
    }
  }
}

const t0 = Date.now();
let instrs = 0;
for (;;) {
  const pc = cpu.pc;
  if (pc === 0x0000) break;
  if (pc === 0x0005) bdos();
  cpu.step();
  instrs++;
  if (cpu.halted) break;
}

if (lineBuf.trim() !== '') {
  process.stdout.write('\n');
  if (lineBuf.includes('ERROR')) errCount++;
  else if (/\bOK\b/.test(lineBuf)) okCount++;
  lastLine = lineBuf;
}

const secs = (Date.now() - t0) / 1000;
process.stdout.write(
  `\n--- souhrn ---\n` +
  `testů OK:      ${okCount}\n` +
  `testů ERROR:   ${errCount}\n` +
  `T-stavů:       ${cpu.tstates}\n` +
  `instrukcí:     ${instrs}\n` +
  `čas:           ${secs.toFixed(1)} s\n` +
  `poslední řádek: ${lastLine.trim()}\n`
);

process.exit(errCount > 0 ? 1 : 0);
