// begin code

/**
 * The Stinger sound board as an AudioWorklet processor (ST-M6).
 *
 * On the board the sound is a machine of its own: a second Z80 with two
 * AY-3-8910s, clocked only by its own 240 Hz NMI (GAME-DESIGN chap. 2.6,
 * notes/E.md). The main CPU never does more than drop a command byte into the
 * latch at F800h and pulse the two discrete circuits at F808h/F80Ah. This
 * processor is exactly that machine: it owns app/soundDriver.js (the 1:1
 * transcription of the sound program) and app/aySynth.js (the two chips), and
 * it runs them on a clock derived from the number of samples it has produced —
 * one driver.nmi() every sampleRate/240 samples. Nothing here waits for the
 * game thread, so a stutter of the worker or of the renderer cannot slow the
 * music down; the frames only deliver latch writes, as the main CPU does.
 *
 * The latch is a register, not an event. A frame message carries
 * `latch: [{slot: 0-3, value}]` (app/WORKER-PROTOCOL.md): which of the frame's
 * four sound NMIs the write fell into. In every NMI the writes of that slot are
 * applied in order and only then is the value read, and the value survives into
 * the following NMIs — exactly like the 74LS latch on the board. That matters
 * because the main CPU writes 00h to F800h every frame (0CB8h) to keep a held
 * command from restarting the tune.
 *
 * Two buses, one board (audioManager.js). Music and effects come out of the very
 * same voices, so the split into the two user buses is a mask rather than a mix:
 * the processor knows its `role` and silences (levels R8-R10 = 0) the chip whose
 * voices currently belong to the other one. The sound program owns exactly one
 * command per group at a time (curCmdA 2001h, curCmdB 2002h) and the command
 * table says how many channels it takes: the tunes 02-0Eh take all six, the
 * effects 10-16h only AY1 and everything of group B only AY2 — see
 * pushRegisters(). Both instances see the same latch stream and stay in
 * lockstep. The discrete circuits are effects and therefore only exist in the
 * 'sounds' role.
 *
 * Discrete circuits. The player's shot (F80Ah) and the explosion (F808h) are
 * not on the sound board at all; they are analogue circuitry of the main board
 * for which no schematic was found, so what is modelled here is MAME's
 * approximation (GAME-DESIGN chap. 2.6): an RC envelope times a square wave
 * (shot) resp. LFSR noise (explosion), with the triggers alternating between two
 * identical circuits so a retrigger does not cut the previous sound off. MAME
 * itself notes the shot "should contain noise" and does not add any, so a small
 * noise blend is in here as a named constant. Every constant below is meant to
 * be tuned by ear against a PCB recording — none of them is measured.
 *
 * Port messages:
 *   {id:'frame', soundBoard}  one worker frame (latch writes + discrete pulses)
 *   {id:'play', audioData:{script:[soundBoard, ...]}}  a scripted sequence played
 *                             at 60 Hz — the sample of the volume dialogs
 *   {id:'stop'}   silence: the queue and the script are dropped, the board is reset
 *   {id:'pause'} / {id:'continue'} / {id:'mute'} / {id:'unmute'}
 */

/** the AY clock the game's note table is tuned to (GAME-DESIGN chap. 2.6) */
var AY_CLOCK = 1500000;

/** the sound CPU's NMI rate: four per 60 Hz video frame */
var NMI_RATE = 240;
var FRAME_NMIS = 4;

/**
 * How many frame messages may wait to be played. The processor consumes one
 * frame per four NMIs = 60 Hz, the same rate the worker produces them, so the
 * queue only absorbs jitter; anything beyond this is a stalled game thread and
 * the oldest frames are dropped rather than adding latency.
 */
var MAX_QUEUED_FRAMES = 8;

/** AY mix: six channels, so 1/6 keeps the sum inside -1..1 (aySynth default) */
var AY_GAIN = 1/6;
// MIX_HEADROOM and softLimit() live in app/aySynth.js: the handler concatenates
// that module ahead of this one, and tools/render-sound.mjs imports it, so the
// browser and the offline renderer apply exactly the same output stage.

// ---------------------------------------------------------------- discrete circuits
// MAME approximation, all of it up for tuning by ear (chap. 2.6).
var DISCRETE_CIRCUITS = 2;        // triggers alternate between two identical circuits
var SHOT_FREQ = 2000;             // square wave of the shot circuit, Hz
var SHOT_DECAY = 0.20;            // RC envelope length, s (MAME: ~0.2)
var SHOT_NOISE = 0.30;            // noise blended into the square (MAME TODO: "should contain noise")
var SHOT_NOISE_FREQ = 6000;       // clock of that noise, Hz
var SHOT_GAIN = 0.45;             // level against the AY mix
var BOOM_FREQ = 1800;             // LFSR clock of the explosion circuit, Hz
var BOOM_DECAY = 0.25;            // RC envelope length, s (MAME: ~0.25)
var BOOM_GAIN = 0.55;             // level against the AY mix
var ENVELOPE_TAU = 4.6;           // decays to -40 dB within the length above


/**
 * Group commands that are music rather than an effect (command table 0520h,
 * GAME-DESIGN chap. 2.6): 02-0A are the six-channel tunes of group A, 0C/0E the
 * two with the broken pointers, 20 the long tune of group B. Everything else
 * that a group can hold (10-16, 22-2A) is an effect.
 */
function commandIsMusic(cmd) {
  return (cmd >= 0x02 && cmd <= 0x0E) || cmd === 0x20;
} // commandIsMusic

/** an RC envelope of one discrete circuit */
function newCircuit() {
  return {level: 0, phase: 0, lfsr: 0x1D2F, noise: 1, noiseCounter: 0};
} // newCircuit

class StingerSoundProcessor extends AudioWorkletProcessor {

  constructor(options) {
    super();
    var opt = (options && options.processorOptions) ? options.processorOptions : {};
    this.role = (opt.role === 'music') ? 'music' : 'sounds';
    this.rate = sampleRate;
    this.dt = 1/this.rate;

    this.driver = null;
    this.synth = new AySynth({clock: AY_CLOCK, sampleRate: this.rate, chips: 2});
    this.shadow = new Uint8Array(16);        // the register set handed to a masked chip
    this.chipIsMusic = [false, false];       // sticky: a chip keeps its bus while it decays
    this.lastCmd = [0, 0];                   // curCmdA / curCmdB of the previous NMI

    this.nmiPeriod = this.rate/NMI_RATE;
    this.toNextNmi = 0;                      // samples still to render before the next NMI
    this.nmiIndex = 0;                       // 0-3 within the frame
    this.latch = 0;                          // the latch register itself
    this.queue = [];
    this.frame = null;
    this.running = false;                    // no input yet: the driver is not run at all
    this.paused = false;
    this.muted = false;

    this.script = false;
    this.scriptPos = 0;

    this.shot = [];
    this.boom = [];
    for (var i = 0; i < DISCRETE_CIRCUITS; i++) {
      this.shot.push(newCircuit());
      this.boom.push(newCircuit());
    }
    this.shotNext = 0;
    this.boomNext = 0;

    if (opt.soundData) {
      this.loadData(opt.soundData);
    }
    if (Array.isArray(opt.script)) {
      // a script handed over at construction time, so an OfflineAudioContext
      // does not have to race a port message (tools/refemu/browser-sound-check)
      this.script = opt.script;
      this.running = true;
    }

    this.port.onmessage = (event) => {
      var d = event.data;
      switch (d.id) {
        case 'data':
          this.loadData(d.soundData);
          break;
        case 'frame':
          this.pushFrame(d.soundBoard);
          break;
        case 'play':
          this.script = (d.audioData && Array.isArray(d.audioData.script)) ? d.audioData.script : false;
          this.scriptPos = 0;
          this.paused = false;
          if (this.script === false) {
            this.silence();
          } else {
            this.running = true;
          }
          break;
        case 'stop':
          this.silence();
          break;
        case 'pause': this.paused = true; break;
        case 'continue': this.paused = false; break;
        case 'mute': this.muted = true; break;
        case 'unmute': this.muted = false; break;
      }
    }; // onmessage
  } // constructor

  /** the contents of data/sound.json: the note tables of the sound ROM */
  loadData(soundData) {
    try {
      this.driver = new SoundDriver(soundData);
      this.driver.reset();
    } catch (error) {
      this.driver = null;
      this.port.postMessage({id: 'soundBoardError', message: error.message});
    }
  } // loadData

  /** back to the state right after the sound CPU's reset */
  silence() {
    this.script = false;
    this.queue.length = 0;
    this.frame = null;
    this.latch = 0;
    this.nmiIndex = 0;
    this.running = false;
    this.lastCmd[0] = 0;
    this.lastCmd[1] = 0;
    this.chipIsMusic[0] = false;
    this.chipIsMusic[1] = false;
    if (this.driver) {
      this.driver.reset();
    }
    this.synth.reset();
    for (var i = 0; i < DISCRETE_CIRCUITS; i++) {
      this.shot[i].level = 0;
      this.boom[i].level = 0;
    }
  } // silence

  pushFrame(soundBoard) {
    if (!soundBoard) {
      return;
    }
    this.queue.push(soundBoard);
    while (this.queue.length > MAX_QUEUED_FRAMES) {
      this.queue.shift();
    }
    this.running = true;
  } // pushFrame

  // ---------------------------------------------------------------- the 240 Hz clock

  /**
   * One NMI of the sound CPU. Slot 0 starts a new frame; the latch writes of the
   * slot are applied first, then the driver reads the latch — the pairing the
   * worker measured in T-states, so a command lands in the very NMI it did on
   * the board.
   */
  stepNmi() {
    var slot = this.nmiIndex;
    if (slot === 0) {
      this.frame = this.nextFrame();
    }
    var frame = this.frame;
    if (frame) {
      var writes = frame.latch;
      if (writes) {
        for (var i = 0; i < writes.length; i++) {
          if (writes[i] && writes[i].slot === slot) {
            this.latch = writes[i].value & 0xFF;
          }
        }
      }
      if (this.role !== 'music') {
        this.triggerDiscrete(frame, slot);
      }
    }
    if (this.driver) {
      this.driver.nmi(this.latch);
      this.pushRegisters();
    }
    this.nmiIndex = (this.nmiIndex+1) % FRAME_NMIS;
  } // stepNmi

  /** the next frame message: the queue first, then the scripted sample */
  nextFrame() {
    if (this.queue.length) {
      return this.queue.shift();
    }
    if (this.script !== false) {
      if (this.scriptPos < this.script.length) {
        return this.script[this.scriptPos++];
      }
      this.script = false;
      this.running = false;
    }
    return null;                             // nothing new: the latch keeps its value
  } // nextFrame

  /**
   * Hands the driver's register shadow to the synthesis, silencing the chip
   * whose voices currently belong to the other bus.
   *
   * Which voice is whose is decided by the sound program, not by the chips.
   * AY1 is channels 0-2 and AY2 channels 3-5, and the command table 0520h says
   * how far a command reaches: the tunes 02-0Eh are six channel (start_6ch
   * 0552h, both chips), the effects 10-16h are AY1 only (start_ay1 0C4Eh) and
   * everything of group B, 20-2Ah, is AY2 only (start_ay2 0C63h). A group B
   * command therefore steals channels 3-5 from a tune that is still running on
   * them. Ownership is taken on the edge — the NMI in which curCmdA 2001h or
   * curCmdB 2002h changes to a new non-zero command — and held from then on, so
   * a sound still decays into its own bus after the program has released the
   * priority.
   */
  pushRegisters() {
    var cmdA = this.driver.rd(0x2001);                       // curCmdA
    var cmdB = this.driver.rd(0x2002);                       // curCmdB
    if (cmdA !== this.lastCmd[0]) {
      this.lastCmd[0] = cmdA;
      if (cmdA !== 0) {
        this.chipIsMusic[0] = commandIsMusic(cmdA);
        if (this.chipIsMusic[0]) {
          this.chipIsMusic[1] = true;                        // a six channel tune takes AY2 too
        }
      }
    }
    if (cmdB !== this.lastCmd[1]) {
      this.lastCmd[1] = cmdB;
      if (cmdB !== 0) {
        this.chipIsMusic[1] = commandIsMusic(cmdB);
      }
    }
    var mine = (this.role === 'music');
    for (var chip = 0; chip < 2; chip++) {
      var regs = this.driver.ay[chip];
      if (this.chipIsMusic[chip] === mine) {
        this.synth.setRegisters(chip, regs);
      } else {
        this.shadow.set(regs);
        this.shadow[8] = 0;
        this.shadow[9] = 0;
        this.shadow[10] = 0;
        this.synth.setRegisters(chip, this.shadow);
      }
    }
  } // pushRegisters

  // ---------------------------------------------------------------- discrete circuits

  /**
   * The pulses of F80Ah / F808h that fell into this NMI. The worker counts them
   * per frame and the `shotSlots` / `boomSlots` lists say where in the frame they
   * were; when the lists are empty (the counts are all the worker has) the
   * pulses are spread over the frame's four NMIs, which is close enough — the
   * circuits are retriggered for many frames in a row anyway (the explosion of
   * the ship writes F808h on every pass of its wait loop).
   */
  triggerDiscrete(frame, slot) {
    this.fireCircuit(this.shot, 'shotNext', this.countPulses(frame.shot, frame.shotSlots, slot));
    this.fireCircuit(this.boom, 'boomNext', this.countPulses(frame.boom, frame.boomSlots, slot));
  } // triggerDiscrete

  countPulses(total, slots, slot) {
    if (slots && slots.length) {
      var n = 0;
      for (var i = 0; i < slots.length; i++) {
        if (slots[i] === slot) {
          n++;
        }
      }
      return n;
    }
    total = total | 0;
    if (total <= 0) {
      return 0;
    }
    // spread evenly: slot s gets the pulses whose index maps onto it
    return Math.floor((total*(slot+1))/FRAME_NMIS) - Math.floor((total*slot)/FRAME_NMIS);
  } // countPulses

  fireCircuit(circuits, cursor, count) {
    for (var i = 0; i < count; i++) {
      var c = circuits[this[cursor]];
      c.level = 1;
      c.phase = 0;
      this[cursor] = (this[cursor]+1) % DISCRETE_CIRCUITS;
    }
  } // fireCircuit

  /** one sample of the two shot circuits: square wave with a little noise */
  shotSample() {
    var sum = 0;
    for (var i = 0; i < DISCRETE_CIRCUITS; i++) {
      var c = this.shot[i];
      if (c.level <= 0.0005) {
        c.level = 0;
        continue;
      }
      c.level *= Math.exp(-this.dt*ENVELOPE_TAU/SHOT_DECAY);
      c.phase += SHOT_FREQ*this.dt;
      if (c.phase >= 1) {
        c.phase -= Math.floor(c.phase);
      }
      c.noiseCounter -= SHOT_NOISE_FREQ;
      while (c.noiseCounter <= 0) {
        c.noiseCounter += this.rate;
        c.noise = this.stepLfsr(c);
      }
      var tone = (c.phase < 0.5) ? 1 : -1;
      sum += c.level*tone*((1-SHOT_NOISE) + SHOT_NOISE*(c.noise ? 1 : -1));
    }
    return sum;
  } // shotSample

  /** one sample of the two explosion circuits: LFSR noise under an RC envelope */
  boomSample() {
    var sum = 0;
    for (var i = 0; i < DISCRETE_CIRCUITS; i++) {
      var c = this.boom[i];
      if (c.level <= 0.0005) {
        c.level = 0;
        continue;
      }
      c.level *= Math.exp(-this.dt*ENVELOPE_TAU/BOOM_DECAY);
      c.noiseCounter -= BOOM_FREQ;
      while (c.noiseCounter <= 0) {
        c.noiseCounter += this.rate;
        c.noise = this.stepLfsr(c);
      }
      sum += c.level*(c.noise ? 1 : -1);
    }
    return sum;
  } // boomSample

  /** the 16-bit LFSR both circuits use (MAME's Asteroids noise) */
  stepLfsr(c) {
    var bit = ((c.lfsr >> 0) ^ (c.lfsr >> 2) ^ (c.lfsr >> 3) ^ (c.lfsr >> 5)) & 1;
    c.lfsr = ((c.lfsr >> 1) | (bit << 15)) & 0xFFFF;
    return c.lfsr & 1;
  } // stepLfsr

  discreteActive() {
    for (var i = 0; i < DISCRETE_CIRCUITS; i++) {
      if (this.shot[i].level > 0 || this.boom[i].level > 0) {
        return true;
      }
    }
    return false;
  } // discreteActive

  // ---------------------------------------------------------------- rendering

  process(inputs, outputs, parameters) {
    var out = outputs[0];
    var buffer = out[0];
    var n = buffer.length;
    // muting is the handler's gain node; here it only silences the output, the
    // board keeps running so unmuting drops back into the tune where it is
    if (this.paused || this.driver === null ||
        (this.running === false && this.queue.length === 0 && !this.discreteActive())) {
      for (var c0 = 0; c0 < out.length; c0++) {
        out[c0].fill(0);
      }
      return true;
    }

    var written = 0;
    while (written < n) {
      if (this.toNextNmi <= 0) {
        this.stepNmi();
        this.toNextNmi += this.nmiPeriod;
      }
      var take = Math.min(n-written, Math.ceil(this.toNextNmi));
      this.synth.render(buffer.subarray(written, written+take), take, AY_GAIN);
      if (this.role !== 'music') {
        for (var i = written; i < written+take; i++) {
          buffer[i] = softLimit(buffer[i] + this.shotSample()*SHOT_GAIN + this.boomSample()*BOOM_GAIN);
        }
      } else {
        for (var i2 = written; i2 < written+take; i2++) {
          buffer[i2] = softLimit(buffer[i2]);
        }
      }
      this.toNextNmi -= take;
      written += take;
    }
    if (this.muted) {
      buffer.fill(0);
    }
    for (var c = 1; c < out.length; c++) {
      out[c].set(buffer);
    }
    return true;
  } // process

} // StingerSoundProcessor

registerProcessor('StingerSoundProcessor', StingerSoundProcessor);
