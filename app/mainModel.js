const { AbstractModel } = await import('./svision/js/abstractModel.js?ver='+window.srcVersion);
const { BorderEntity } = await import('./borderEntity.js?ver='+window.srcVersion);
const { TextEntity } = await import('./svision/js/platform/canvas2D/textEntity.js?ver='+window.srcVersion);
const { PauseGameEntity } = await import('./pauseGameEntity.js?ver='+window.srcVersion);
const { ZXColor } = await import('./svision/js/platform/canvas2D/zx/zxColor.js?ver='+window.srcVersion);
const { TileMapRender } = await import('./tileMapRender.js?ver='+window.srcVersion);
const { TileMapEntity } = await import('./tileMapEntity.js?ver='+window.srcVersion);
const { SpriteLayerEntity } = await import('./spriteLayerEntity.js?ver='+window.srcVersion);
// begin code

/**
 * The game screen. The worker (app/gameWorker.js, WORKER-PROTOCOL.md) runs at
 * the fixed 60 Hz tick and sends a 'frame' after every tick; this model routes
 * the controls (keyboard, mouse, gamepad, touch — the SI/MM wiring) to the
 * worker as a full {left, right, up, down, fire, bongo} state and reacts to
 * gameOver.
 *
 * ST-M3: the picture is drawn by TileMapEntity (background color + both tile
 * layers with the per-row scroll) and SpriteLayerEntity (the 16 hardware
 * sprites) from the video state in the 'frame' message. The HUD (score, lives,
 * Bongo) is part of the video RAM exactly as in the original, so no text entity
 * draws it.
 *
 * ★ Until ST-M4 the model showed a still frame from the reference emulator
 * (data/screens.json) while the stub sent no video. **That is gone**: the real
 * worker sends video, and the still frame only ever reached the screen for a
 * single display frame before the worker's first — measured off a 120 fps
 * recording, one frame in stinger and one in pleiades — which is what it looked
 * like, a picture flashing by as the game started. Now nothing is drawn until
 * the worker has something to draw ({@link TileMapEntity#drawEntity}).
 * data/screens.json stays where it is — tools/refemu still makes it and checks
 * against it — the game just does not read it any more.
 *
 * The touch controls are the MM/SI horizontal joystick + one button for now —
 * the 2-axis joystick + 2 buttons come in ST-M7 (GAME-DESIGN chap. 5).
 */
export class MainModel extends AbstractModel {

  constructor(app, attract) {
    super(app);
    this.id = 'MainModel';

    this.attract = attract;
    this.gameOver = false;
    this.frame = null;
    this.framesReceived = 0;
    this.controlsState = {left: false, right: false, up: false, down: false, fire: false, bongo: false};
    this.worker = null;
    this.statusEntity = null;
    this.fpsEntity = null;
    this.render = null;
    this.tileMapEntity = null;
    this.spriteLayerEntity = null;
    this.fps = {frames: 0, workerFrames: 0, ticks: 0, since: false, lastFrame: false};
  } // constructor

  newBorderEntity() {
    return new BorderEntity(true, this.app.controls.touchscreen.supported);
  } // newBorderEntity

  init() {
    super.init();

    this.borderEntity.bkColor = '#000000';
    this.desktopEntity.bkColor = '#000000';

    // the data files: at once from localStorage, or from the server when they
    // are missing there (R-062)
    this.loadDataFiles(['tiles', 'sprites', 'palette', 'tables'], (files, error) => this.initData(files, error));
  } // init

  /**
   * The part of init() that needs the data files. Runs inside init() when
   * they are in localStorage, later when they had to come from the server.
   * @param {Object|null} files - The data files, or null.
   * @param {Error} [error] - Why they are missing.
   */
  initData(files, error) {
    if (this.app.model !== this) {
      return;
    }
    if (!files) {
      this.app.showErrorMessage(error ? error.message : 'Game data could not be loaded.', 'restart');
    }
    if (!this.initVideo()) {
      var y = 8*8;
      this.desktopEntity.addEntity(new TextEntity(this.desktopEntity, this.app.fonts.zxFonts8x8, 0, y, this.desktopWidth, 8, 'STINGER', ZXColor.brightWhite, false, {align: 'center'}));
      this.desktopEntity.addEntity(new TextEntity(this.desktopEntity, this.app.fonts.fonts5x5, 8, y+16, this.desktopWidth-16, 40,
        'GRAPHICS DATA MISSING (data/tiles.json, sprites.json, palette.json).', ZXColor.brightGreen, false, {align: 'center', textWrap: true}));
      this.statusEntity = new TextEntity(this.desktopEntity, this.app.fonts.zxFonts8x8Mono, 0, y+104, this.desktopWidth, 8, '', ZXColor.brightYellow, false, {align: 'center'});
      this.desktopEntity.addEntity(this.statusEntity);
    }

    if (this.app.devModeName !== false) {
      this.fpsEntity = new TextEntity(this.desktopEntity, this.app.fonts.fonts3x3, this.desktopWidth-40, this.desktopHeight-5, 40, 4, '', ZXColor.brightGreen, false, {align: 'right'});
      this.desktopEntity.addEntity(this.fpsEntity);
    }

    // the menu keeps the audio closed; the game opens its buses here (MM pattern)
    this.sendEvent(0, {id: 'openAudioBus', bus: 'sounds', options: {muted: this.app.muted.sounds}});
    this.sendEvent(0, {id: 'openAudioBus', bus: 'music', options: {muted: this.app.muted.music}});

    this.worker = this.app.worker;
    this.app.inputEventsManager.sendEventsActiveKeys('Press');
    this.sendWorkerMessage({
      id: 'init',
      initData: {
        headless: false,
        dip: {lives: this.app.lives || 3, bonus: [20000, 50000], bongoTime: 'medium', hard: false},
        tables: this.loadDataFile('tables'),
        hiScore: this.app.hiScore || 0,
        attract: this.attract
      }
    });
    this.updateStatus();
  } // initData

  shutdown() {
    super.shutdown();
    this.sendWorkerMessage({id: 'reset'});
    this.sendEvent(0, {id: 'stopAllAudioBuses'});
  } // shutdown


  /**
   * Builds the shared renderer from the ROM graphics data and adds the two
   * picture entities. Returns false when the data files are not available, so
   * the model can fall back to a plain message instead of a blank screen.
   * @returns {boolean} True when the video entities were created.
   */
  initVideo() {
    var tiles = this.loadDataFile('tiles');
    var sprites = this.loadDataFile('sprites');
    var palette = this.loadDataFile('palette');
    if (!tiles || !sprites || !palette) {
      return false;
    }
    try {
      this.render = new TileMapRender({tiles: tiles, sprites: sprites, palette: palette});
    } catch (error) {
      console.error(error.message);
      return false;
    }
    this.tileMapEntity = new TileMapEntity(this.desktopEntity, 0, 0, this.render);
    this.desktopEntity.addEntity(this.tileMapEntity);
    this.spriteLayerEntity = new SpriteLayerEntity(this.desktopEntity, 0, 0, this.render);
    this.desktopEntity.addEntity(this.spriteLayerEntity);
    return true;
  } // initVideo

  /**
   * Hands one video state to both picture entities.
   * @param {Object} state - {vram, attr, sprites, regs}.
   */
  setVideoFrame(state) {
    if (this.tileMapEntity) {
      this.tileMapEntity.setFrame(state);
      this.spriteLayerEntity.setFrame(state);
    }
  } // setVideoFrame

  sendWorkerMessage(event) {
    if (this.worker) {
      this.worker.postMessage(event);
    }
  } // sendWorkerMessage

  /**
   * Sets one control and sends the whole state to the worker when it changed
   * (protocol: {id:'controls', left, right, up, down, fire, bongo}).
   */
  setControl(action, value) {
    if (!(action in this.controlsState) || this.controlsState[action] === value) {
      return;
    }
    this.controlsState[action] = value;
    this.sendWorkerMessage(Object.assign({id: 'controls'}, this.controlsState));
  } // setControl

  updateStatus() {
    if (this.statusEntity) {
      this.statusEntity.setText('SCORE '+String(this.app.score || 0).padStart(6, '0')+'  LIVES '+String(this.app.lives || 0));
    }
  } // updateStatus

  handleWorkerMessage(event) {
    var data = event.data;
    switch (data.id) {
      case 'frame':
        this.frame = data;
        this.framesReceived++;
        this.fps.workerFrames++;
        // ★ R-045: a tiky světa zvlášť, odečtené z čítače ve zprávě
        if (this.fps.lastFrame !== false) { this.fps.ticks += data.frame-this.fps.lastFrame; }
        this.fps.lastFrame = data.frame;
        if (data.vram && data.attr && data.sprites && data.regs) {
          this.setVideoFrame(data);
        }
        if (typeof data.score == 'number') {
          this.app.score = data.score;
        }
        if (typeof data.hiScore == 'number' && data.hiScore > (this.app.hiScore || 0)) {
          this.app.hiScore = data.hiScore;
        }
        if (typeof data.lives == 'number') {
          this.app.lives = data.lives;
        }
        if (data.soundBoard && this.app.audioManager && typeof this.app.audioManager.playFrame == 'function') {
          this.app.audioManager.playFrame(data);   // ST-M6: sound board
        }
        this.updateStatus();
        break;
      case 'gameOver':
        if (!this.gameOver) {
          this.gameOver = true;
          if (typeof data.score == 'number') {
            this.app.score = data.score;
          }
          this.app.setModel('GameOverModel');
        }
        break;
      case 'roundComplete':
        break;
    }
  } // handleWorkerMessage

  /** maps a key/gamepad/mouse event to a control action, or false */
  controlAction(key, pressed) {
    var kb = this.app.controls.keyboard, mouse = this.app.controls.mouse;
    var mouseOk = (k) => mouse.enable && this.app.inputEventsManager.keysMap[k] === false;
    switch (key) {
      case kb.left: case 'GamepadLeft': return 'left';
      case kb.right: case 'GamepadRight': return 'right';
      case kb.up: case 'GamepadUp': return 'up';
      case kb.down: case 'GamepadDown': return 'down';
      case kb.fire: case 'GamepadJump': return 'fire';
      case kb.bongo: case 'GamepadOK': return 'bongo';
      case mouse.left: return mouseOk(mouse.left) ? 'left' : false;
      case mouse.right: return mouseOk(mouse.right) ? 'right' : false;
      case mouse.fire: return mouseOk(mouse.fire) ? 'fire' : false;
    }
    return false;
  } // controlAction

  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }

    switch (event.id) {

      case 'exitGame':
        this.app.setModel('MenuModel');
        return true;

      case 'blurWindow':
        this.pauseGame();
        return true;

      case 'continueGame':
        this.sendWorkerMessage({id: 'continue'});
        this.sendEvent(0, {id: 'continueAllAudioBuses'});
        return true;

      case 'keyPress':
        var key = event.key;
        if (key.length == 1) {
          key = key.toUpperCase();
        }
        switch (key) {
          case 'Escape':
          case 'P':
          case 'GamepadExit':
            this.pauseGame();
            return true;
          case 'Touch':
            if (this.borderEntity.leftControlEntity && this.borderEntity.leftControlEntity.pointOnEntity(event)) {
              this.app.inputEventsManager.touchesMap[event.identifier] = this.borderEntity.leftControlEntity;
              this.touchStart(event, 'left');
              return true;
            }
            if (this.borderEntity.rightControlEntity && this.borderEntity.rightControlEntity.pointOnEntity(event)) {
              this.app.inputEventsManager.touchesMap[event.identifier] = this.borderEntity.rightControlEntity;
              this.touchStart(event, 'right');
              return true;
            }
            break;
          case 'RetryTouch':
            this.setControl(event.action, true);
            return true;
          case this.app.controls.keyboard.sounds:
            this.app.muted.sounds = !this.app.muted.sounds;
            this.sendEvent(0, {id: 'muteAudioBus', bus: 'sounds', muted: this.app.muted.sounds});
            return true;
          case this.app.controls.keyboard.music:
            this.app.muted.music = !this.app.muted.music;
            this.sendEvent(0, {id: 'muteAudioBus', bus: 'music', muted: this.app.muted.music});
            return true;
        }
        var action = this.controlAction(key, true);
        if (action !== false) {
          this.setControl(action, true);
          return true;
        }
        break;

      case 'keyRelease':
        var rkey = event.key;
        if (rkey.length == 1) {
          rkey = rkey.toUpperCase();
        }
        if (rkey == 'Touch') {
          this.touchEnd(event);
          return true;
        }
        var raction = this.controlAction(rkey, false);
        if (raction !== false) {
          this.setControl(raction, false);
          return true;
        }
        break;

      case 'keyMove':
        if (event.key == 'Touch') {
          this.touchMove(event);
          return true;
        }
        break;

      case 'errorAudioBus':
        this.app.showErrorMessage(event.error, 'reopen');
        return true;
    }

    return false;
  } // handleEvent

  // pause the worker and open the pause menu (RESUME / SOUNDS / MUSIC / EXIT GAME)
  pauseGame() {
    if (this.desktopEntity.modalEntity || this.gameOver) {
      return;
    }
    this.sendWorkerMessage({id: 'pause'});
    this.sendEvent(0, {id: 'pauseAllAudioBuses'});
    this.desktopEntity.addModalEntity(new PauseGameEntity(this.desktopEntity, 36, 86, 153, 85, 'PAUSE GAME', 'MenuModel'));
  } // pauseGame

  // touch controls (SI/MM pattern): the border's left/right control areas carry a
  // button or a horizontal joystick according to controlsOptions.touchscreen.types
  touchStart(event, side) {
    var ts = this.app.controlsOptions.touchscreen.types[this.app.controls.touchscreen.type][side];
    if (ts.type == 'button') {
      this.setControl(ts.action, true);
    }
    this.app.inputEventsManager.touchesGameControls[event.identifier] = {center: {x: event.x, y: event.y}, type: ts.type, control: ts.control, action: ts.action, actions: ts.actions};
  } // touchStart

  touchEnd(event) {
    var tgc = this.app.inputEventsManager.touchesGameControls;
    if (event.identifier in tgc) {
      if (tgc[event.identifier].action !== false) {
        this.setControl(tgc[event.identifier].action, false);
      }
      delete tgc[event.identifier];
    }
  } // touchEnd

  touchMove(event) {
    var tgc = this.app.inputEventsManager.touchesGameControls;
    if (!(event.identifier in tgc)) {
      return;
    }
    var control = tgc[event.identifier];
    var action = control.action;
    if (control.type == 'joystick' && control.control == 'horizontal') {
      if (event.x-control.center.x < -10) {
        action = control.actions[0];
        control.center.x = event.x;
      }
      if (event.x-control.center.x > 10) {
        action = control.actions[1];
        control.center.x = event.x;
      }
      if (control.action !== action) {
        if (control.action !== false) {
          this.setControl(control.action, false);
        }
        control.action = action;
        this.setControl(control.action, true);
      }
    }
  } // touchMove

  updateFps(timestamp) {
    if (!this.fpsEntity) {
      return;
    }
    this.fps.frames++;
    if (this.fps.since === false) {
      this.fps.since = timestamp;
      return;
    }
    var elapsed = timestamp-this.fps.since;
    if (elapsed >= 1000) {
      var draw = Math.round(this.fps.frames*1000/elapsed);
      var worker = Math.round(this.fps.workerFrames*1000/elapsed);
      var ticks = Math.round(this.fps.ticks*1000/elapsed);
      this.fpsEntity.setText(draw+'/'+worker+'/'+ticks+' FPS');
      this.fps.frames = 0;
      this.fps.workerFrames = 0;
      this.fps.ticks = 0;
      this.fps.since = timestamp;
    }
  } // updateFps

  loopModel(timestamp) {
    super.loopModel(timestamp);

    if (this.desktopEntity.modalEntity) {
      this.desktopEntity.modalEntity.loopEntity(timestamp);
    }

    this.updateFps(timestamp);
    this.drawModel();
  } // loopModel

} // MainModel
