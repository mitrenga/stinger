#!/usr/bin/env node
/**
 * regress-sound — compares app/soundDriver.js with the sound board of the
 * reference emulator, one NMI at a time (ST-M6).
 *
 * The sound board is a second Z80 running its own program at 240 Hz (four NMIs
 * per frame, notes/E.md). app/soundDriver.js is a 1:1 transcription of that
 * program: it takes the latch value the sound CPU would see at each NMI and
 * produces the register shadow of both AY-3-8910. This tool drives it with the
 * exact latch sequence the original saw — taken from refemu's --ay-nmi log —
 * and requires every one of the 32 registers to match at every NMI.
 *
 * That isolates the sequencer from every timing question: the latch pairing
 * comes from the reference, so any difference is the transcription's.
 *
 * usage: node tools/regress-sound.mjs [--frames N] [--script FILE]
 *                                     [--first N] [--keep] [--quiet]
 */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i+1] : def; };
const flag = (name) => args.includes(name);

const frames = parseInt(opt('--frames', '1200'), 10);
const firstOnly = parseInt(opt('--first', '10'), 10);
const quiet = flag('--quiet');
const scriptFile = path.resolve(ROOT, opt('--script', 'sources/reference/input-attract.txt'));
const tmp = flag('--keep') ? path.join(ROOT, 'tmp/regress-sound')
  : (process.env.SCRATCHPAD || fs.mkdtempSync('/tmp/st-sound-'));
fs.mkdirSync(tmp, {recursive: true});

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

// ---------------------------------------------------------------- reference
const logFile = path.join(tmp, 'ay-nmi.tsv');
if (!quiet) {
  console.log('reference: '+frames+' frames ('+(frames*4)+' NMIs) of '+path.relative(ROOT, scriptFile));
}
execFileSync('node', [path.join(ROOT, 'tools/refemu/run.mjs'),
  '--frames', String(frames), '--quiet', '--input', scriptFile, '--ay-nmi', logFile],
  {cwd: ROOT, stdio: 'inherit'});

const rows = fs.readFileSync(logFile, 'utf8').split('\n').slice(1).filter((l) => l.length)
  .map((line) => {
    const cell = line.split('\t');
    return {
      frame: parseInt(cell[0], 10),
      nmi: parseInt(cell[1], 10),
      latch: parseInt(cell[2], 16),
      ay: cell.slice(3, 35).map((h) => parseInt(h, 16))
    };
  });

// ---------------------------------------------------------------- the driver
const {SoundDriver} = await import(path.join(ROOT, 'app/soundDriver.js'));
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/sound.json'), 'utf8'));
const driver = new SoundDriver(data);
driver.reset();

// ---------------------------------------------------------------- compare
const found = [];
let lastGood = -1;
for (const row of rows) {
  driver.nmi(row.latch);
  let ok = true;
  for (let i = 0; i < 32; i++) {
    const expected = row.ay[i];
    const got = driver.ay[i >> 4][i & 15];
    if (expected !== got) {
      ok = false;
      if (found.length < firstOnly) {
        found.push({frame: row.frame, nmi: row.nmi, latch: row.latch,
          chip: (i >> 4)+1, reg: i & 15, expected, got});
      }
    }
  }
  if (ok && lastGood === (row.frame*4+row.nmi)-1) {
    lastGood = row.frame*4+row.nmi;
  }
  if (found.length >= firstOnly) {
    break;
  }
}

if (found.length === 0) {
  console.log('OK: '+rows.length+' NMIs ('+frames+' frames), 32 registers, 0 differences');
  process.exit(0);
}
const first = found[0];
console.log('first difference at frame '+first.frame+' NMI '+first.nmi+
  ' (NMIs 0-'+lastGood+' agree, latch '+hex2(first.latch)+')');
for (const d of found) {
  console.log('  f'+String(d.frame).padStart(5)+'.'+d.nmi+'  AY'+d.chip+' R'+String(d.reg).padStart(2)+
    '  refemu '+hex2(d.expected)+'  driver '+hex2(d.got));
}
process.exit(1);
