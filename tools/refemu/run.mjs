#!/usr/bin/env node
/**
 * run.mjs — reference emulator of Stinger (ST-M3). Runs the real ROM on the JS
 * Z80 core (z80.js, verified against ZEXDOC/ZEXALL) with the machine model of
 * machine.js, and produces everything the remake is regressed against:
 *
 *   --shot N=out.png    picture after frame N, rendered by the very same code
 *                       the browser uses (app/tileMapRender.js)
 *   --dump N=out.bin    RAM + VRAM + attributes + sprite RAM + registers,
 *                       byte-compatible with tools/dis/trace-stinger.py --dump
 *   --state N=out.json  the video state alone (VRAM, attributes, sprite RAM and
 *                       registers, base64) in the worker 'frame' shape, so the
 *                       browser can display a refemu frame before ST-M4 exists
 *   --trace out.tsv     per frame: CPU registers, watched RAM bytes, sound
 *                       latches written to F800, F80A (shot) and F808 (explosion)
 *   --watch out.tsv     per frame: only the watched bytes, one hex pair per address —
 *                       the compact form tools/regress.mjs (ST-M4) compares the worker
 *                       against; --watch-addrs takes a comma list of hex addresses and
 *                       inclusive ranges, e.g. c0a0-c0bf,c140-c1bf,c224-c243
 *   --ay out.tsv        per frame: all 16 registers of both AY-3-8910 plus the
 *                       number of writes (ST-M6 compares its sequencer to this)
 *   --ay-nmi out.tsv    the same, but once per NMI of the sound CPU (240 Hz) and
 *                       with the latch value that NMI actually saw — that is the
 *                       granularity the sound program itself works at, so it is
 *                       the oracle app/soundDriver.js is regressed against
 *
 * Usage:
 *   node tools/refemu/run.mjs --frames 600 [--input sources/reference/input-game.txt]
 *        [--shot 200=out.png] [--dump 200=out.bin] [--trace t.tsv] [--ay ay.tsv]
 *        [--trace-addrs c0a2,c0bb] [--watch w.tsv --watch-addrs c140-c15f]
 *        [--dsw0 EF] [--dsw1 AE] [--no-sound] [--scale 1]
 *        [--layers N=out.png] [--sprites N=out.png] [--state N=out.json] [--quiet]
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {StingerMachine, DSW0_FACTORY, DSW1_FACTORY} from './machine.js';
import {TileMapRender} from '../../app/tileMapRender.js';
import {encodePNG} from '../lib/png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

function parseArgs(argv) {
  var out = {frames: 600, input: null, shot: {}, dump: {}, trace: null, ay: null,
    traceAddrs: 'c0a2', dsw0: DSW0_FACTORY, dsw1: DSW1_FACTORY, sound: true, scale: 1,
    layers: {}, sprites: {}, state: {}, watch: null, watchAddrs: '', ayNmi: null, quiet: false};
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    var pairInto = (target) => {
      var v = argv[++i];
      var eq = v.indexOf('=');
      target[parseInt(v.substring(0, eq), 10)] = v.substring(eq+1);
    };
    switch (a) {
      case '--frames': out.frames = parseInt(argv[++i], 10); break;
      case '--input': out.input = argv[++i]; break;
      case '--shot': pairInto(out.shot); break;
      case '--layers': pairInto(out.layers); break;
      case '--sprites': pairInto(out.sprites); break;
      case '--dump': pairInto(out.dump); break;
      case '--state': pairInto(out.state); break;
      case '--trace': out.trace = argv[++i]; break;
      case '--trace-addrs': out.traceAddrs = argv[++i]; break;
      case '--watch': out.watch = argv[++i]; break;
      case '--watch-addrs': out.watchAddrs = argv[++i]; break;
      case '--ay': out.ay = argv[++i]; break;
      case '--ay-nmi': out.ayNmi = argv[++i]; break;
      case '--dsw0': out.dsw0 = parseInt(argv[++i], 16); break;
      case '--dsw1': out.dsw1 = parseInt(argv[++i], 16); break;
      case '--no-sound': out.sound = false; break;
      case '--scale': out.scale = parseInt(argv[++i], 10); break;
      case '--quiet': out.quiet = true; break;
      default:
        console.error('unknown option: '+a);
        process.exit(2);
    }
  }
  return out;
}

/** input script: lines "frame keys", the state holds until the next line */
function loadInput(file) {
  if (!file) {
    return [];
  }
  return fs.readFileSync(file, 'utf8').split('\n')
    .map((line) => line.split('#')[0].trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      var parts = line.split(/\s+/);
      return {frame: parseInt(parts[0], 10), keys: parts.length > 1 ? parts[1] : ''};
    })
    .sort((x, y) => x.frame-y.frame);
}

function loadRoms() {
  var dir = path.join(ROOT, 'sources/rom/stinger');
  var dec = path.join(dir, 'decrypted');
  for (var f of [path.join(dec, 'opcodes.bin'), path.join(dec, 'program.bin'), path.join(dir, '6-9f.bin')]) {
    if (!fs.existsSync(f)) {
      console.error('missing ROM image: '+f+'\nrun tools/decrypt-stinger.mjs first (the ROM set stays out of git)');
      process.exit(1);
    }
  }
  return {
    opcodes: new Uint8Array(fs.readFileSync(path.join(dec, 'opcodes.bin'))),
    program: new Uint8Array(fs.readFileSync(path.join(dec, 'program.bin'))),
    sound: new Uint8Array(fs.readFileSync(path.join(dir, '6-9f.bin')))
  };
}

function loadRenderer() {
  var read = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', name), 'utf8'));
  return new TileMapRender({tiles: read('tiles.json'), sprites: read('sprites.json'), palette: read('palette.json')});
}

/**
 * The video state as JSON: byte arrays base64-encoded, registers plain, in the
 * shape app/tileMapRender.js and the worker protocol use.
 */
function videoStateJSON(machine, frame) {
  var state = machine.videoState();
  var b64 = (a) => Buffer.from(a).toString('base64');
  return {
    source: 'tools/refemu/run.mjs',
    frame: frame,
    vram: state.vram.map(b64),
    attr: state.attr.map(b64),
    sprites: state.sprites.map(b64),
    regs: state.regs
  };
}

/**
 * Parses a comma separated list of hex addresses and inclusive ranges
 * ("c0a0,c140-c15f") into a flat array of addresses.
 */
function parseAddressList(text) {
  var out = [];
  for (var item of String(text).split(',')) {
    item = item.trim();
    if (!item.length) {
      continue;
    }
    var dash = item.indexOf('-');
    if (dash > 0) {
      var from = parseInt(item.substring(0, dash), 16);
      var to = parseInt(item.substring(dash+1), 16);
      for (var a = from; a <= to; a++) {
        out.push(a);
      }
    } else {
      out.push(parseInt(item, 16));
    }
  }
  return out;
}

function main() {
  var opt = parseArgs(process.argv.slice(2));
  var machine = new StingerMachine(loadRoms(), {dsw0: opt.dsw0, dsw1: opt.dsw1, sound: opt.sound});
  var events = loadInput(opt.input);
  var wantsPicture = Object.keys(opt.shot).length+Object.keys(opt.layers).length+Object.keys(opt.sprites).length > 0;
  var renderer = wantsPicture ? loadRenderer() : null;
  var rgba = wantsPicture ? new Uint8ClampedArray(TileMapRender.WIDTH*TileMapRender.HEIGHT*4) : null;

  var traceAddrs = parseAddressList(opt.traceAddrs);
  var watchAddrs = parseAddressList(opt.watchAddrs);
  var traceFile = opt.trace ? fs.openSync(opt.trace, 'w') : null;
  if (traceFile) {
    fs.writeSync(traceFile, 'frame\tPC\tSP\tAF\tBC\tDE\tHL\tIX\tIY\t'+
      traceAddrs.map((x) => x.toString(16).toUpperCase().padStart(4, '0')).join('\t')+
      '\tlatch\tshot\tboom\n');
  }
  var watchFile = opt.watch ? fs.openSync(opt.watch, 'w') : null;
  if (watchFile) {
    fs.writeSync(watchFile, 'frame\t'+watchAddrs.map((x) => x.toString(16).toUpperCase().padStart(4, '0')).join('\t')+'\n');
  }
  var ayNmiFile = opt.ayNmi ? fs.openSync(opt.ayNmi, 'w') : null;
  if (ayNmiFile) {
    machine.logSoundSlices = true;
    var nmiCols = [];
    for (var chip = 1; chip <= 2; chip++) {
      for (var r = 0; r < 16; r++) {
        nmiCols.push('AY'+chip+'R'+r);
      }
    }
    fs.writeSync(ayNmiFile, 'frame\tnmi\tlatch\t'+nmiCols.join('\t')+'\n');
  }
  var ayFile = opt.ay ? fs.openSync(opt.ay, 'w') : null;
  if (ayFile) {
    var cols = [];
    for (var chip = 1; chip <= 2; chip++) {
      for (var r = 0; r < 16; r++) {
        cols.push('AY'+chip+'R'+r);
      }
    }
    fs.writeSync(ayFile, 'frame\twrites\t'+cols.join('\t')+'\n');
  }

  var hex2 = (v) => v.toString(16).toUpperCase().padStart(2, '0');
  var hex4 = (v) => v.toString(16).toUpperCase().padStart(4, '0');
  var totals = {latches: 0, shots: 0, booms: 0, ayWrites: 0};
  var firstLatches = [];
  var ei = 0;

  var writePicture = (name, mode) => {
    var state = machine.videoState();
    if (mode == 'layers') renderer.renderLayers(state, rgba);
    else if (mode == 'sprites') renderer.renderSprites(state, rgba);
    else renderer.renderFrame(state, rgba);
    fs.mkdirSync(path.dirname(path.resolve(name)), {recursive: true});
    fs.writeFileSync(name, encodePNG(TileMapRender.WIDTH, TileMapRender.HEIGHT, rgba, opt.scale));
    if (!opt.quiet) console.log('frame '+machine.frame+': '+name+(mode == 'frame' ? '' : ' ('+mode+')'));
  };

  for (var frame = 0; frame < opt.frames; frame++) {
    while (ei < events.length && events[ei].frame <= frame) {
      machine.setKeys(events[ei].keys);
      ei++;
    }
    var log = machine.runFrame();

    totals.latches += log.latches.length;
    totals.shots += log.shots;
    totals.booms += log.booms;
    totals.ayWrites += log.ayWrites.length;
    for (var v of log.latches) {
      if (firstLatches.length < 20) firstLatches.push([frame, hex2(v)]);
    }

    if (traceFile) {
      var r = machine.registers();
      fs.writeSync(traceFile, frame+'\t'+[r.pc, r.sp, r.af, r.bc, r.de, r.hl, r.ix, r.iy].map(hex4).join('\t')+'\t'+
        traceAddrs.map((x) => hex2(machine.bus.read(x))).join('\t')+'\t'+
        log.latches.map(hex2).join(',')+'\t'+log.shots+'\t'+log.booms+'\n');
    }
    if (watchFile) {
      var cells = new Array(watchAddrs.length);
      for (var w = 0; w < watchAddrs.length; w++) {
        cells[w] = hex2(machine.bus.read(watchAddrs[w]));
      }
      fs.writeSync(watchFile, frame+'\t'+cells.join('\t')+'\n');
    }
    if (ayNmiFile) {
      for (var slice of machine.soundSlices) {
        var cells = [];
        for (var chip = 0; chip < 2; chip++) {
          for (var r = 0; r < 16; r++) {
            cells.push(hex2(slice.ay[chip][r]));
          }
        }
        fs.writeSync(ayNmiFile, frame+'\t'+slice.nmi+'\t'+hex2(slice.latch)+'\t'+cells.join('\t')+'\n');
      }
    }
    if (ayFile) {
      var regs = [];
      for (var chip = 0; chip < 2; chip++) {
        var src = machine.soundBus ? machine.soundBus.ay[chip] : new Uint8Array(16);
        for (var i2 = 0; i2 < 16; i2++) regs.push(hex2(src[i2]));
      }
      fs.writeSync(ayFile, frame+'\t'+log.ayWrites.length+'\t'+regs.join('\t')+'\n');
    }

    if (frame in opt.shot) writePicture(opt.shot[frame], 'frame');
    if (frame in opt.layers) writePicture(opt.layers[frame], 'layers');
    if (frame in opt.sprites) writePicture(opt.sprites[frame], 'sprites');
    if (frame in opt.state) {
      var target = path.resolve(opt.state[frame]);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.writeFileSync(target, JSON.stringify(videoStateJSON(machine, frame), null, 1));
      if (!opt.quiet) console.log('frame '+frame+': '+opt.state[frame]+' (state)');
    }
    if (frame in opt.dump) {
      fs.mkdirSync(path.dirname(path.resolve(opt.dump[frame])), {recursive: true});
      fs.writeFileSync(opt.dump[frame], Buffer.from(machine.dump()));
      if (!opt.quiet) console.log('frame '+frame+': '+opt.dump[frame]+' (dump)');
    }
  }

  if (traceFile) fs.closeSync(traceFile);
  if (watchFile) fs.closeSync(watchFile);
  if (ayFile) fs.closeSync(ayFile);
  if (ayNmiFile) fs.closeSync(ayNmiFile);

  if (!opt.quiet) {
    var reg = machine.registers();
    console.log('frames: '+opt.frames+', main CPU T-states: '+reg.tstates);
    console.log('sound latches: '+totals.latches+', shots (F80A): '+totals.shots+', explosions (F808): '+totals.booms+
      ', AY writes: '+totals.ayWrites);
    console.log('first latches: '+firstLatches.map((x) => x[0]+':'+x[1]).join(' '));
    console.log('PC='+hex4(reg.pc)+' SP='+hex4(reg.sp)+' halted='+reg.halted+' nmiEnable='+machine.bus.nmiEnable);
  }
}

main();
