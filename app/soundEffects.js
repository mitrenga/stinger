// begin code

/**
 * The samples the menu's two volume dialogs play (ST-M6).
 *
 * Both buses are the emulated sound board (app/stingerSoundProcessor.js), so a
 * sample is not a score for an oscillator any more: it is a short script of
 * what the main CPU would write to the sound latch F800h, one entry per 60 Hz
 * frame, in the same shape the worker sends every frame (frame.soundBoard,
 * app/WORKER-PROTOCOL.md). The processor plays it on its own 240 Hz clock, so
 * what the dialog produces is literally the original's sound.
 *
 * The two commands (command table 0520h, GAME-DESIGN chap. 2.6):
 *   10h  the short beep of the Bongo call, ~0.2 s — the SOUNDS sample, played
 *        together with one pulse of the discrete shot circuit (F80Ah), the other
 *        thing that bus carries;
 *   02h  the tune that starts a new life, 4.8 s — the MUSIC sample.
 *
 * A held latch would restart the command over and over, which is exactly why
 * the main CPU writes 00h to F800h in every frame (0CB8h); the scripts do the
 * same.
 */

/** the original's frame rate — one script entry is one frame */
var FRAME_RATE = 60;

/**
 * One command written in the first frame, then 00h for the rest of them.
 * @param {number} command - the byte written to F800h.
 * @param {number} seconds - how long the script keeps the board running.
 * @param {Object} [first] - extra fields of the first entry (discrete pulses).
 * @returns {Object} {script: [soundBoard, ...]} for AudioManager.playSound.
 */
function latchScript(command, seconds, first) {
  var frames = Math.round(seconds*FRAME_RATE);
  var script = [];
  for (var i = 0; i < frames; i++) {
    var entry = {latch: [{slot: 0, value: (i === 0) ? command : 0x00}],
      shot: 0, shotSlots: [], boom: 0, boomSlots: []};
    if (i === 0 && first) {
      for (var key in first) {
        entry[key] = first[key];
      }
    }
    script.push(entry);
  }
  return {script: script};
} // latchScript

/** SOUNDS sample: command 10h (Bongo call beep) plus one discrete shot */
export function createShotSampleScore() {
  return latchScript(0x10, 1.2, {shot: 1});
} // createShotSampleScore

/** MUSIC sample: command 02h, the 4.8 s tune that starts a life */
export function createMelodySampleScore() {
  return latchScript(0x02, 5.2);
} // createMelodySampleScore
