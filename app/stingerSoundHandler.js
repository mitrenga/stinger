const { AbstractAudioHandler } = await import('./svision/js/audio/abstractAudioHandler.js?ver='+window.srcVersion);
// begin code

/**
 * How many frames of sound-board input are kept while the AudioWorklet is still
 * loading. Twelve is a fifth of a second — enough to cover the module fetch on a
 * cold cache, and short enough that the catch-up is not audible as a delay.
 */
var BACKLOG_FRAMES = 12;

/**
 * Audio handler of the emulated sound board (ST-M6). The board itself lives in
 * the AudioWorklet app/stingerSoundProcessor.js — a second Z80 running the
 * transcribed sound program plus the two AY-3-8910s — and is driven by the
 * latch writes the worker reports in every frame (frame.soundBoard,
 * app/WORKER-PROTOCOL.md) through writeSoundBoard(). A `playSound`
 * audioData is a latch script ({script: [soundBoard, ...]}, one entry per
 * frame), which is how the volume dialogs play their sample.
 *
 * Modelled on the svision AudioWorkletHandler: the module is fetched and
 * registered from a blob URL so the service worker can serve it offline, one
 * registration per AudioContext, and the user/bus volume is a gain node between
 * the worklet node and the destination.
 *
 * Composing the worklet. An AudioWorklet module is a classic script, not an ES
 * module, so it cannot import app/aySynth.js and app/soundDriver.js — and those
 * two must stay ES modules, because tools/regress-sound.mjs and
 * tools/render-sound.mjs import them under Node, and that regression is what
 * proves the transcription. The handler therefore fetches all three files and
 * concatenates them itself, applying exactly the transformation svtool uses to
 * build the bundle (svision/tools/svtool, bundleCode()): keep what follows the
 * '// begin code' marker, drop the `export default X;` lines and strip the
 * leading `export ` from declarations. Nothing is duplicated and the three
 * files stay single-sourced.
 */

/** the files of the worklet, in dependency order */
var WORKLET_SOURCES = ['aySynth.js', 'soundDriver.js', 'stingerSoundProcessor.js'];

/**
 * The svtool bundle transformation (svision/tools/svtool, bundleCode()), so an
 * ES module can be concatenated into a classic script.
 */
function bundleCode(text, name) {
  var marker = '// begin code';
  var pos = text.indexOf(marker);
  var code = (pos < 0) ? text : text.substring(pos+marker.length);
  code = code.replace(/^[ \t]*export[ \t]+default[ \t]+[^\n;]+;[ \t]*$/gm, '');
  code = code.replace(/^([ \t]*)export[ \t]+/gm, '$1');
  return '// === '+name+' ===\n'+code;
} // bundleCode

/**
 * data/sound.json carries the note tables base64 encoded, and an
 * AudioWorkletGlobalScope is not a WindowOrWorkerGlobalScope: it has no atob.
 * The decoding therefore happens here, on the main thread; SoundDriver takes a
 * plain array of bytes just as happily as the base64 string.
 */
function decodeSoundData(soundData) {
  var list = (soundData && soundData.tables) ? soundData.tables : soundData;
  if (!Array.isArray(list)) {
    return null;
  }
  var tables = [];
  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    var data = entry.data;
    if (typeof data == 'string') {
      var binary = atob(data);
      data = new Array(binary.length);
      for (var b = 0; b < binary.length; b++) {
        data[b] = binary.charCodeAt(b);
      }
    }
    tables.push({addr: entry.addr, data: data});
  }
  return {tables: tables};
} // decodeSoundData

export class StingerSoundHandler extends AbstractAudioHandler {

  constructor(app) {
    super(app);
    this.id = 'StingerSoundHandler';
    this.node = null;
    this.gain = null;
    this.backlog = [];
    this.role = 'sounds';
    this.soundData = null;
    this.busFactor = 1.0;
    this.muted = false;
  } // constructor

  /**
   * @param {Object} options - beside the common ones: `role` ('sounds' or
   *   'music', which half of the board this bus renders) and `soundData` (the
   *   contents of data/sound.json, the note tables of the sound ROM).
   */
  openBus(bus, options, ctx) {
    super.openBus(bus, options, ctx);
    if (this.error === false && this.ctx != null) {
      this.muted = ('muted' in options) ? !!options.muted : false;
      this.role = (options.role === 'music') ? 'music' : 'sounds';
      this.soundData = options.soundData ? decodeSoundData(options.soundData) : null;
      this.openProcessor(options);
    } else {
      this.busy = false;
    }
  } // openBus

  /** fetches, composes and registers the worklet module; once per context */
  loadProcessorModule() {
    if (!this.ctx.stingerSoundModule) {
      this.ctx.stingerSoundModule = (async () => {
        var parts = [];
        for (var i = 0; i < WORKLET_SOURCES.length; i++) {
          var name = WORKLET_SOURCES[i];
          var response = await fetch(this.app.importPath+'/'+name+'?ver='+window.srcVersion);
          if (!response.ok) {
            throw new Error(name+' '+response.status);
          }
          parts.push(bundleCode(await response.text(), name));
        }
        var blobURL = URL.createObjectURL(new Blob([parts.join('\n')], {type: 'text/javascript'}));
        try {
          await this.ctx.audioWorklet.addModule(blobURL);
        } finally {
          URL.revokeObjectURL(blobURL);
        }
      })().catch((error) => {
        this.ctx.stingerSoundModule = null;
        throw error;
      });
    }
    return this.ctx.stingerSoundModule;
  } // loadProcessorModule

  async openProcessor(options) {
    try {
      await this.loadProcessorModule();
      this.node = new AudioWorkletNode(this.ctx, 'StingerSoundProcessor', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: {role: this.role, soundData: this.soundData}
      });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.muted ? 0.0 : this.busFactor;
      this.node.connect(this.gain);
      this.gain.connect(this.ctx.destination);
      this.node.port.onmessage = (event) => {
        this.app.model.sendEvent(1, {id: event.data.id, data: event.data});
      };
    } catch (error) {
      console.error('StingerSoundHandler: '+error.message);
      this.node = null;
      this.app.model.sendEvent(1, {id: 'unsupportedAudioBus', bus: this.bus});
    } finally {
      this.busy = false;
    }
  } // openProcessor

  closeBus() {
    if (this.waitForBusy('closeAudioBus')) {
      return false;
    }
    if (this.node) {
      this.node.port.postMessage({id: 'stop'});
      this.node.disconnect();
      this.node = null;
    }
    this.backlog.length = 0;
    if (this.gain) {
      this.gain.disconnect();
      this.gain = null;
    }
    return super.closeBus();
  } // closeBus

  post(message) {
    if (this.node != null) {
      this.node.port.postMessage(message);
    }
  } // post

  /**
   * One frame of the sound board's inputs (frame.soundBoard).
   *
   * Opening the bus is asynchronous — the worklet module is fetched, turned into
   * a blob and registered — while the worker starts sending frames immediately.
   * Dropping those would lose whatever the sound program was told in the
   * meantime, and the first thing it is told is the start-of-life tune, so the
   * game would begin in silence. They are therefore held until the node exists
   * and then handed over in order. The backlog is bounded: if the node never
   * appears (unsupported audio) it must not grow without limit, and the sound
   * board only ever needs the recent past, since its state is the latch history.
   */
  writeSoundBoard(soundBoard) {
    if (!soundBoard) {
      return;
    }
    if (this.node == null) {
      this.backlog.push(soundBoard);
      while (this.backlog.length > BACKLOG_FRAMES) {
        this.backlog.shift();
      }
      return;
    }
    this.flushBacklog();
    this.node.port.postMessage({id: 'frame', soundBoard: soundBoard});
  } // writeSoundBoard

  /** hands over the frames that arrived while the worklet was still loading */
  flushBacklog() {
    if (this.backlog.length === 0 || this.node == null) {
      return;
    }
    for (var i = 0; i < this.backlog.length; i++) {
      this.node.port.postMessage({id: 'frame', soundBoard: this.backlog[i]});
    }
    this.backlog.length = 0;
  } // flushBacklog

  stopBus() {
    this.post({id: 'stop'});
  } // stopBus

  pauseBus() {
    this.post({id: 'pause'});
  } // pauseBus

  continueBus() {
    this.post({id: 'continue'});
  } // continueBus

  muteBus(muted) {
    this.muted = !!muted;
    if (this.gain) {
      this.gain.gain.value = this.muted ? 0.0 : this.busFactor;
    }
  } // muteBus

  setBusVolume(factor) {
    this.busFactor = factor;
    if (this.gain && !this.muted) {
      this.gain.gain.value = factor;
    }
  } // setBusVolume

  busIsReady() {
    return this.node != null;
  } // busIsReady

  playSound(audioData, options) {
    if (audioData === false || !audioData) {
      this.post({id: 'stop'});
      return;
    }
    this.post({id: 'play', audioData: {script: audioData.script || []}, options: options});
  } // playSound

} // StingerSoundHandler
