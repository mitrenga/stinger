const { Version } = await import('./version.js?ver='+window.srcVersion);
const { AbstractApp } = await import('./svision/js/abstractApp.js?ver='+window.srcVersion);
const { AudioManager } = await import('./audioManager.js?ver='+window.srcVersion);
const { ZXFonts8x8 } = await import('./svision/js/platform/canvas2D/zx/zxFonts8x8.js?ver='+window.srcVersion);
const { Fonts5x5 } = await import('./svision/js/platform/canvas2D/fonts5x5.js?ver='+window.srcVersion);
const { Fonts3x3 } = await import('./svision/js/platform/canvas2D/fonts3x3.js?ver='+window.srcVersion);
const { BootModel } = await import('./bootModel.js?ver='+window.srcVersion);
const { MenuModel } = await import('./menuModel.js?ver='+window.srcVersion);
const { MainModel } = await import('./mainModel.js?ver='+window.srcVersion);
const { GameOverModel } = await import('./gameOverModel.js?ver='+window.srcVersion);
const { ZXErrorEntity } = await import('./svision/js/platform/canvas2D/zx/zxErrorEntity.js?ver='+window.srcVersion);
const { Tool } = await import('./svision/js/tool.js?ver='+window.srcVersion);
const { ZXColor } = await import('./svision/js/platform/canvas2D/zx/zxColor.js?ver='+window.srcVersion);
const { StingerFonts8x8 } = await import('./stingerFonts8x8.js?ver='+window.srcVersion);
// begin code

/**
 * Stinger application shell (ST-M2 skeleton, derived from the Pleiads skeleton).
 * The structure follows the Manic Miner kernel: LoadingModel (BootModel, the
 * board's power-on sequence from app/bootWorker.js) -> MenuModel -> MainModel
 * (the game) -> GameOverModel. Runs on the
 * shared svision ArcadePlatform (app/appPlatform.js, 224x256); the ZX helper
 * screens (settings, volume, player name, error) are the svision ones.
 */
export class GameApp extends AbstractApp {

  constructor(platform, importPath, wsURL, devModeName, appIconSprite) {
    super(platform, 'bodyApp', importPath, wsURL);

    this.worker = new Worker(this.importPath+'/gameWorker.js?ver='+window.srcVersion);
    this.worker.onmessage = (event) => {
      if (this.model) {
        this.model.handleWorkerMessage(event);
      }
    };

    this.version = Version;
    this.copyright = '©␣2026␣Libor␣Mitrenga, CC␣BY⋅NC⋅SA';
    this.devModeName = devModeName;
    this.appIconSprite = appIconSprite;

    this.audioManager = new AudioManager(this);
    this.muted = {sounds: false, music: false};

    this.fonts = {
      zxFonts8x8Mono: new ZXFonts8x8(this, false),
      zxFonts8x8: new ZXFonts8x8(this, true),
      fonts5x5: new Fonts5x5(this),
      fonts3x3: new Fonts3x3(this),
      stingerFonts8x8: new StingerFonts8x8(this, false)   // the arcade letters of the game, monospace 8 px
    };
    // Hard/short spaces live in the game (svision core fonts have the normal space only).
    this.fonts.fonts5x5.addSpace('␣', {width: 2, breaking: false, stretch: true});

    this.fonts.zxFonts8x8.addSpace('␣', {width: 3, breaking: false, stretch: false});

    // arcade controls: 4-way stick + FIRE + BONGO CALL (GAME-DESIGN chap. 5)
    this.controlsOptions = {
      keyboard: {
        device: 'keyboard',
        keys: [
          {action: 'left', label: 'MOVING LEFT'},
          {action: 'right', label: 'MOVING RIGHT'},
          {action: 'up', label: 'MOVING UP'},
          {action: 'down', label: 'MOVING DOWN'},
          {action: 'fire', label: 'FIRE'},
          {action: 'bongo', label: 'BONGO CALL'},
          {action: 'music', label: 'MUTE MUSIC'},
          {action: 'sounds', label: 'MUTE SOUNDS'}
        ]
      },
      mouse: {
        device: 'mouse',
        keys: [
          {action: 'left', label: 'MOVING LEFT'},
          {action: 'right', label: 'MOVING RIGHT'},
          {action: 'fire', label: 'FIRE'}
        ]
      },
      gamepads: {
        device: 'gamepads',
        keys: [
          {action: 'left', label: 'MOVING LEFT', eventKey: 'GamepadLeft'},
          {action: 'right', label: 'MOVING RIGHT', eventKey: 'GamepadRight'},
          {action: 'up', label: 'MOVING UP', eventKey: 'GamepadUp'},
          {action: 'down', label: 'MOVING DOWN', eventKey: 'GamepadDown'},
          {action: 'fire', label: 'FIRE', eventKey: 'GamepadJump'},
          {action: 'bongo', label: 'BONGO CALL', eventKey: 'GamepadOK'},
          {action: 'exit', label: 'EXIT', eventKey: 'GamepadExit'}
        ]
      },
      touchscreen: {
        device: 'touchscreen',
        types: {
          keys: [
            'leftFire',
            'rightFire'
          ],
          leftFire: {
            left: {
              type: 'button',
              control: false,
              action: 'fire',
              actions: false,
              sprite: 'fire'
            },
            right: {
              type: 'joystick',
              control: 'horizontal',
              action: false,
              actions: ['left', 'right'],
              sprite: 'left-right'
            }
          },
          rightFire: {
            left: {
              type: 'joystick',
              control: 'horizontal',
              action: false,
              actions: ['left', 'right'],
              sprite: 'left-right'
            },
            right: {
              type: 'button',
              control: false,
              action: 'fire',
              actions: false,
              sprite: 'fire'
            }
          }
        },
        icons: {
          // TODO ST-M7: 2-axis joystick + FIRE and BONGO buttons with proper icons; the MM icons are placeholders
          fire: {
            compressedSpriteData: 'lP101300N0A970111030Z0510122382012345617171859'
          },
          'left-right': {
            compressedSpriteData: 'lP101300N08B701050P020N06910121213421245641465421243121217'
          }
        }
      }
    }

    this.controls = {
      keyboard: this.getControls('keyboard'),
      mouse: this.getControls('mouse'),
      touchscreen: this.getControls('touchscreen'),
      gamepads: this.getControls('gamepads')
    };

    this.attract = false;
    this.lives = 3;   // DIP default: STINGER WOLF 3 (GAME-DESIGN chap. 2.4)
    this.score = 0;
    this.hiScore = false;
    this.playerName = Tool.readCookie('playerName', '');
    this.globalData = false;
    this.id = 'GameApp';
    this.fetchDataId = '';
    this.setModel('LoadingModel');
    this.loadAppData();
  } // constructor

  getControls(device) {
    var result = {};

    switch(device) {
      case 'keyboard':
        result = {left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', fire: ' ', bongo: 'B', music: 'M', sounds: 'S'};
        break;
      case 'mouse':
        result = {enable: false, left: 'Mouse1', right: 'Mouse2', fire: 'Mouse4'};
        break;
      case 'touchscreen':
        result = {supported: false, type: 'leftFire'};
        break;
      case 'gamepads':
        result = {supported: false, devices: {}};
        break;
    }

    switch (device) {
      case 'keyboard':
      case 'mouse':
      case 'touchscreen':
        var cfgString = Tool.readCookie(device, false);
        if (cfgString !== false) {
          try {
            var cfg = JSON.parse(cfgString);
            Object.keys(cfg).forEach((item) => {
              result[item] = cfg[item];
              if (device == 'touchscreen' && !(result[item] in this.controlsOptions.touchscreen.types)) {
                result[item] = this.controlsOptions.touchscreen.types.keys[0];
              }
            });
          } catch (error) {
            console.error(error.message);
          }
        }
        break;
      case 'gamepads':
        var devicesString = Tool.readCookie('gamepads', false);
        if (devicesString !== false) {
          try {
            var devices = JSON.parse(devicesString);
          } catch (error) {
            console.error(error.message);
          } finally {
            if (Array.isArray(devices)) {
              devices.forEach((id) => {
                var deviceString = Tool.readCookie(id, false);
                if (deviceString !== false) {
                  try {
                    var device = JSON.parse(deviceString);
                  } catch (error) {
                    console.error(error.message);
                  } finally {
                    result.devices[id] = device;
                  }
                }
              });
            }
          }
        }
        break;
    }
    return result;
  } // getControls

  setModel(model) {
    if (model == 'MenuModel' && this.globalData === false) {
      // the fetch may still be pending or has failed: as a last resort try the
      // data cached in localStorage before bothering the user
      if (!this.loadGlobalDataFromStorage()) {
        this.showErrorMessage('Game data could not be loaded.', 'retry');
        return;
      }
    }
    var needResizeApp = false;
    var selectionItem = 0;
    if (this.model) {
      if (this.model.id == 'MainModel' && this.attract) {
        selectionItem = 6;
      }
      this.model.shutdown();
      needResizeApp = true;
    }
    switch (model) {
      case 'LoadingModel':
        this.model = new BootModel(this, this.copyright);
        break;
      case 'MenuModel':
        this.model = new MenuModel(this, selectionItem);
        break;
      case 'MainModel':
        this.model = new MainModel(this, this.attract);
        break;
      case 'GameOverModel':
        this.model = new GameOverModel(this, 'MenuModel');
        break;
    } // switch
    this.model.init();
    if (needResizeApp) {
      this.resizeApp();
    }
  } // setModel

  startGame(attract) {
    this.attract = attract;
    this.score = 0;
    this.lives = 3;
    this.setModel('MainModel');
  } // startGame

  applyGlobalData(global) {
    this.globalData = global;
  } // applyGlobalData

  setGlobalData(data) {
    this.applyGlobalData(data.data.global);

    var files = {};
    Object.keys(data.data).forEach((key) => {
      if (key == 'hiScore') {
        this.hiScore = data.data[key];
      } else if (key != 'global') {
        files[key] = data.data[key];
      }
    });
    // global goes last; a full localStorage is cleared and tried once more
    // (R-062)
    this.saveAppDataToStorage(files, data.data.global);
  } // setGlobalData

  // Load the application data: from the server when online (which also refreshes
  // localStorage), or rehydrate the global data from localStorage when offline.
  loadAppData() {
    if (navigator.onLine) {
      this.fetchDataId = this.fetchData('appData.db', false, {}, this, 2000);
    } else {
      this.loadGlobalDataFromStorage();
    }
  } // loadAppData

  loadGlobalDataFromStorage() {
    var stored = localStorage.getItem(window.appPrefix+'.global');
    if (stored !== null) {
      try {
        this.applyGlobalData(JSON.parse(stored));
        return true;
      } catch (error) {
        console.error(error.message);
      }
    }
    return false;
  } // loadGlobalDataFromStorage

  setData(data) {
    this.setGlobalData(data);
  } // setData

  errorData(error) {
    if (!this.loadGlobalDataFromStorage()) {
      console.error(error.message ? error.message : error);
      return;
    }
    if (this.model && this.model.id == 'BootModel'
        && !this.model.events.some((queued) => queued.id == 'setMenuModel')
        && !this.model.desktopEntity.modalEntity) {
      this.setModel('MenuModel');
    }
  } // errorData

  showErrorMessage(message, action) {
    var topModalEntity = this.model.desktopEntity.topModalEntity();
    topModalEntity.addModalEntity(
      new ZXErrorEntity(
        topModalEntity,
        -topModalEntity.absoluteX(),
        -topModalEntity.absoluteY(),
        this.fonts.zxFonts8x8,
        message,
        action,
        ZXColor.white,
        ZXColor.red
      )
    );
  } // showErrorMessage

} // GameApp
