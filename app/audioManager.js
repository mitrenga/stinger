const { AbstractAudioManager } = await import('./svision/js/audio/abstractAudioManager.js?ver='+window.srcVersion);
const { StingerSoundHandler } = await import('./stingerSoundHandler.js?ver='+window.srcVersion);
const { Tool } = await import('./svision/js/tool.js?ver='+window.srcVersion);
const { createShotSampleScore, createMelodySampleScore } = await import('./soundEffects.js?ver='+window.srcVersion);
// begin code

/**
 * Audio manager (ST-M6). Both buses are the emulated sound board: the
 * AudioWorklet app/stingerSoundProcessor.js, which owns the transcribed sound
 * program (app/soundDriver.js) and the two AY-3-8910s (app/aySynth.js) and runs
 * them on its own 240 Hz clock. playFrame() only delivers the latch writes and
 * the discrete pulses of the frame, exactly as the main CPU does on the board.
 *
 * Why two buses for one board. The board has a single mono output and music and
 * effects come out of the same six voices — but never out of the same one at the
 * same time: the sound program holds one command per group and the command table
 * says how far it reaches (the tunes 02-0Eh take all six channels, the effects
 * 10-16h only AY1, everything of group B only AY2), so a new effect *takes over*
 * the channels rather than mixing into them. At any instant a chip therefore
 * belongs to exactly one of the two user buses, and the split is a mask rather
 * than a mix. Each bus runs its own instance of the board, both fed the
 * identical latch stream, and each silences the chip that currently belongs to
 * the other one (the `role` of the processor); the discrete shot and explosion
 * are effects and exist only in the 'sounds' role. The alternative — one bus for
 * everything — would be cheaper (the sound CPU is about three quarters of the
 * cost, so two instances mean roughly twice the audio-thread load), but it would
 * leave the MUSIC level and the M key with nothing to control and the menu's
 * MUSIC dialog with nothing of the original to play.
 */
var EFFECT_BUSES = ['sounds'];

export class AudioManager extends AbstractAudioManager {

  constructor(app) {
    super(app);
    this.id = 'AudioManager';
    this.volume = {};
    this.volume.sounds = Math.min(10, Math.max(0, Math.round(Number(Tool.readCookie('audioBusSoundsLevel', 7)))));
    this.volume.music = Math.min(10, Math.max(0, Math.round(Number(Tool.readCookie('audioBusMusicLevel', 7)))));
    this.latencyHint = 'interactive';
    this.soundData = null;
  } // constructor

  static get effectBuses() {
    return EFFECT_BUSES;
  } // effectBuses

  // the user level a bus follows
  volumeKey(bus) {
    return (bus === 'music') ? 'music' : 'sounds';
  } // volumeKey

  createAudioHandler(bus, options) {
    return new StingerSoundHandler(this.app);
  } // createAudioHandler

  volumeFactor(volume) {
    var levels = [0, 0.005, 0.01, 0.02, 0.04, 0.07, 0.1, 0.14, 0.18, 0.23, 0.29];
    return levels[volume]/levels[10];
  } // volumeFactor

  /**
   * The note tables of the sound ROM (data/sound.json), delivered with appData
   * into localStorage; the processor needs them to run the sound program.
   */
  loadSoundData() {
    if (this.soundData === null) {
      try {
        var stored = localStorage.getItem(window.appPrefix+'.sound');
        this.soundData = (stored === null) ? false : JSON.parse(stored);
      } catch (error) {
        console.error(error.message);
        this.soundData = false;
      }
    }
    return this.soundData;
  } // loadSoundData

  openBus(bus, options) {
    options = options || {};
    options.role = this.volumeKey(bus);
    options.soundData = this.loadSoundData() || null;
    super.openBus(bus, options);
    this.refreshVolume(bus);
    this.muteBus(bus, ('muted' in options) ? options.muted : false);
  } // openBus

  refreshVolume(bus) {
    var handler = this.buses[bus];
    if (handler === undefined) {
      return;
    }
    handler.setBusVolume(this.volumeFactor(this.volume[this.volumeKey(bus)]));
  } // refreshVolume

  // muting 'sounds' mutes every effect bus
  muteBus(bus, muted) {
    if (bus === 'sounds') {
      EFFECT_BUSES.forEach((b) => super.muteBus(b, muted));
      return;
    }
    super.muteBus(bus, muted);
  } // muteBus

  /**
   * One worker frame (frame.soundBoard = {latch, shot, shotSlots, boom,
   * boomSlots}, WORKER-PROTOCOL.md), handed to every open instance of the board.
   * Never throws: a missing bus or a worklet that failed to start is silence,
   * not a broken game.
   */
  playFrame(frame) {
    if (!frame || !frame.soundBoard) {
      return;
    }
    var buses = Object.keys(this.buses);
    for (var i = 0; i < buses.length; i++) {
      var handler = this.buses[buses[i]];
      if (handler && typeof handler.writeSoundBoard == 'function') {
        handler.writeSoundBoard(frame.soundBoard);
      }
    }
  } // playFrame

  audioData(bus, sound, options) {
    var data = super.audioData(bus, sound, options);
    if (data !== false) {
      return data;
    }
    switch (sound) {
      case 'exampleFireSound': return createShotSampleScore();
      case 'exampleMelodySound': return createMelodySampleScore();
    }
    return false;
  } // audioData

} // AudioManager
