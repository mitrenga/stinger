// begin code

/**
 * AY-3-8910 sound generator (ST-M6). Stinger has two of them, driven by the
 * sound CPU (app/soundDriver.js); this module turns their register state into
 * samples and is deliberately free of DOM and Node dependencies, so the same
 * code runs in the AudioWorklet and in the offline renderer tools/render-sound.mjs.
 *
 * Model (AY-3-8910 datasheet, sources/mame/ay8910.cpp):
 *   - three tone channels with a 12-bit period (R0/R1, R2/R3, R4/R5); period 0
 *     behaves as 1. The datasheet gives f = clock / (16 * period), and that is
 *     the relation the game's note table is tuned to, so the internal counters
 *     here run at clock/8 and the output bit flips every `period` steps: two
 *     flips make one wave, which lands exactly on clock/(16*period). (Counting
 *     at clock/16 instead — the other reading of the datasheet — comes out an
 *     octave low; MAME divides by 8 for the same reason.)
 *   - noise: a 17-bit LFSR (taps 0 and 3) shifted every 2*R6 internal steps,
 *     i.e. clock/(16*R6); R6 is 5 bits and 0 behaves as 1.
 *   - mixer R7: bits 0-2 disable the tone of A/B/C, bits 3-5 the noise; a
 *     channel is on when (tone | toneDisabled) & (noise | noiseDisabled).
 *   - level R8/R9/R10: bits 0-3 the fixed level, bit 4 switches to the envelope.
 *   - envelope: R11/R12 period; one of the 16 steps every 32 internal steps per
 *     unit of period, i.e. clock/(256*period). R13 is the shape (bit 0 hold,
 *     1 alternate, 2 attack, 3 continue).
 *
 * Stinger itself uses only the tone generators: the sound program never writes
 * a non-zero noise period and never touches R11-R13, and drives the levels
 * directly, decaying them in software (notes/E.md (f)). Noise and envelopes are
 * modelled anyway — the chip is shared with the rest of the arcade family, and
 * the discrete shot and explosion of the main board are a different circuit
 * (GAME-DESIGN chap. 2.6).
 *
 * The DAC is logarithmic. The 16 levels below are the measured AY-3-8910 curve
 * (fpgaarcade measurements, the ones sources/mame/ay8910.cpp cites in its
 * header discussion); using a linear ramp instead makes the software decay of
 * the music sound wrong, since that decay is exactly a walk down these steps.
 *
 * Clock: GAME-DESIGN chap. 2.1 — MAME derives 1.536 MHz from an 18.432 MHz
 * crystal, but the game's own note table only lands in tune at 1.5 MHz
 * (notes/E.md: every note is 0.3-0.4 semitones sharp at 1.536). The default is
 * therefore 1.5 MHz, and the constructor takes a clock so the two can be
 * compared by ear.
 */

/** measured relative amplitudes of the 16 fixed levels */
var AY_LEVELS = [
  0.0000, 0.0137, 0.0205, 0.0291, 0.0423, 0.0618, 0.0847, 0.1369,
  0.1691, 0.2647, 0.3527, 0.4499, 0.5704, 0.6873, 0.8482, 1.0000
];

/**
 * Headroom for the two buses.
 *
 * The board has one mono output; the split into SOUNDS and MUSIC is a mask, so
 * the two bus outputs sum back to the whole board — and they are summed again at
 * the destination, where nothing limits them together. Measured on a game
 * segment with the start-of-life tune over a burst of explosions, the sum
 * reached 1.36 while each bus alone stayed under 0.8. This factor brings the
 * worst case just under full scale so the limiter below only ever has to bend
 * rare transients instead of holding back a permanently overdriven mix.
 */
var MIX_HEADROOM = 0.66;

/**
 * Soft limiter on the bus output. The two buses are masks of the same board and
 * are summed again at the destination, and the discrete circuits are added on
 * top of the AY mix, so a loud moment can add up past full scale — measured 1.16
 * peak on a game segment where the start tune overlaps a burst of explosions.
 * Hard clipping there would buzz; tanh bends the peaks instead and is
 * transparent below about 0.7 (the same approach the Pleiads board model uses).
 */
export function softLimit(sample) {
  return Math.tanh(sample*MIX_HEADROOM);
} // softLimit

export class AySynth {

  /**
   * @param {Object} [options] - {clock, sampleRate, chips}: the AY clock in Hz
   *   (default 1 500 000), the output sample rate and how many chips to model
   *   (Stinger has two).
   */
  constructor(options) {
    options = options || {};
    this.id = 'AySynth';
    this.clock = options.clock || 1500000;
    this.sampleRate = options.sampleRate || 48000;
    this.chipCount = options.chips || 2;

    // internal counters run at clock/8 (see the note on tuning above)
    this.stepsPerSample = (this.clock/8)/this.sampleRate;

    this.chips = [];
    for (var i = 0; i < this.chipCount; i++) {
      this.chips.push(this.newChip());
    }
    this.stepFraction = 0;
  } // constructor

  newChip() {
    return {
      regs: new Uint8Array(16),
      toneCounter: [0, 0, 0],
      toneOutput: [1, 1, 1],
      noiseCounter: 0,
      noiseLfsr: 1,
      noiseOutput: 1,
      envCounter: 0,
      envStep: 0,
      envVolume: 0,
      envHolding: false
    };
  } // newChip

  reset() {
    for (var i = 0; i < this.chips.length; i++) {
      this.chips[i] = this.newChip();
    }
    this.stepFraction = 0;
  } // reset

  /**
   * Writes one register. Writing the envelope shape (R13) restarts the envelope,
   * exactly as the chip does.
   * @param {number} chip - 0 or 1.
   * @param {number} reg - 0-15.
   * @param {number} value - the byte written.
   */
  writeRegister(chip, reg, value) {
    var c = this.chips[chip];
    if (!c) {
      return;
    }
    c.regs[reg & 15] = value & 0xFF;
    if ((reg & 15) === 13) {
      c.envCounter = 0;
      c.envStep = 0;
      c.envHolding = false;
      c.envVolume = (value & 0x04) ? 0 : 15;   // attack starts low, decay high
    }
  } // writeRegister

  /**
   * Replaces a chip's whole register set, which is how the sound board works:
   * the CPU writes its 11-register shadow to the chip in every NMI.
   * @param {number} chip - 0 or 1.
   * @param {Uint8Array|Array} regs - 16 register values.
   */
  setRegisters(chip, regs) {
    for (var r = 0; r < 16; r++) {
      if (r === 13) {
        if (this.chips[chip] && this.chips[chip].regs[13] !== (regs[13] & 0xFF)) {
          this.writeRegister(chip, 13, regs[13]);
        }
        continue;                              // R13 only restarts on a real write
      }
      if (this.chips[chip]) {
        this.chips[chip].regs[r] = regs[r] & 0xFF;
      }
    }
  } // setRegisters

  /** one step of a chip at clock/16 */
  stepChip(c) {
    var regs = c.regs;

    for (var ch = 0; ch < 3; ch++) {
      var period = (regs[ch*2] | ((regs[ch*2+1] & 0x0F) << 8)) || 1;
      if (++c.toneCounter[ch] >= period) {
        c.toneCounter[ch] = 0;
        c.toneOutput[ch] ^= 1;
      }
    }

    var noisePeriod = ((regs[6] & 0x1F) || 1)*2;
    if (++c.noiseCounter >= noisePeriod) {
      c.noiseCounter = 0;
      // 17-bit LFSR, taps 0 and 3 (datasheet)
      var bit = ((c.noiseLfsr ^ (c.noiseLfsr >> 3)) & 1);
      c.noiseLfsr = (c.noiseLfsr >> 1) | (bit << 16);
      c.noiseOutput = c.noiseLfsr & 1;
    }

    var envPeriod = ((regs[11] | (regs[12] << 8)) || 1)*32;   // clock/256 in units of clock/8
    if (++c.envCounter >= envPeriod) {
      c.envCounter = 0;
      this.stepEnvelope(c);
    }
  } // stepChip

  /** one step of the 16-level envelope, shape in R13 */
  stepEnvelope(c) {
    if (c.envHolding) {
      return;
    }
    var shape = c.regs[13] & 0x0F;
    var attack = (shape & 0x04) !== 0;
    var alternate = (shape & 0x02) !== 0;
    var hold = (shape & 0x01) !== 0;
    var continueBit = (shape & 0x08) !== 0;

    c.envStep++;
    if (c.envStep > 15) {
      c.envStep = 0;
      if (!continueBit) {
        c.envVolume = 0;                       // the four non-continuing shapes end silent
        c.envHolding = true;
        return;
      }
      if (alternate) {
        attack = !attack;
        c.regs[13] ^= 0x04;                    // remember the direction for the next cycle
      }
      if (hold) {
        c.envVolume = attack ? 15 : 0;
        c.envHolding = true;
        return;
      }
    }
    c.envVolume = attack ? c.envStep : 15-c.envStep;
  } // stepEnvelope

  /** the chip's analogue output for the current state, -1..1 before mixing */
  chipOutput(c) {
    var regs = c.regs;
    var mixer = regs[7];
    var sum = 0;
    for (var ch = 0; ch < 3; ch++) {
      var toneOn = ((mixer >> ch) & 1) ? 1 : c.toneOutput[ch];
      var noiseOn = ((mixer >> (ch+3)) & 1) ? 1 : c.noiseOutput;
      if (!(toneOn & noiseOn)) {
        continue;
      }
      var level = regs[8+ch];
      sum += AY_LEVELS[(level & 0x10) ? (c.envVolume & 15) : (level & 0x0F)];
    }
    return sum;
  } // chipOutput

  /**
   * Renders mono samples. Each output sample is the average of the chip states
   * over its period, which both mixes the chips and takes the edge off the
   * aliasing of the square waves.
   * @param {Float32Array} out - target buffer.
   * @param {number} [count] - samples to render (default out.length).
   * @param {number} [gain] - overall gain (default 1/6, three channels per chip).
   */
  render(out, count, gain) {
    count = count === undefined ? out.length : count;
    gain = gain === undefined ? 1/6 : gain;
    for (var i = 0; i < count; i++) {
      this.stepFraction += this.stepsPerSample;
      var steps = Math.floor(this.stepFraction);
      this.stepFraction -= steps;
      var accumulated = 0;
      var taken = 0;
      for (var s = 0; s < steps; s++) {
        for (var k = 0; k < this.chips.length; k++) {
          this.stepChip(this.chips[k]);
        }
        for (var k2 = 0; k2 < this.chips.length; k2++) {
          accumulated += this.chipOutput(this.chips[k2]);
        }
        taken++;
      }
      if (taken === 0) {                       // sample rate above the chip rate
        for (var k3 = 0; k3 < this.chips.length; k3++) {
          accumulated += this.chipOutput(this.chips[k3]);
        }
        taken = 1;
      }
      out[i] = (accumulated/taken)*gain;
    }
  } // render

} // AySynth
