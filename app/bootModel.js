const { AbstractModel } = await import('./svision/js/abstractModel.js?ver='+window.srcVersion);
const { BorderEntity } = await import('./borderEntity.js?ver='+window.srcVersion);
const { TextEntity } = await import('./svision/js/platform/canvas2D/textEntity.js?ver='+window.srcVersion);
const { ZXColor } = await import('./svision/js/platform/canvas2D/zx/zxColor.js?ver='+window.srcVersion);
const { TileMapRender } = await import('./tileMapRender.js?ver='+window.srcVersion);
const { TileMapEntity } = await import('./tileMapEntity.js?ver='+window.srcVersion);
const { SpriteLayerEntity } = await import('./spriteLayerEntity.js?ver='+window.srcVersion);
// begin code

/**
 * Boot model of the remake — the counterpart of svision's ZXResetModel at the
 * resolution of the game (224x256). Where the ZX model plays the Spectrum reset
 * stripes, this one shows what the Stinger board shows after power-on: the RNG
 * snow on layer 1, the raw DIP values, the solid fill and the clear, exactly as
 * the original program draws them (main_start 0C85h -> powerOnScreen 0D4Ah).
 * It stops the instant drawTitle (0F2Eh) would start — the first picture of
 * the game itself — shows the copyright line, and hands over to the menu.
 *
 * The animation is produced by app/bootWorker.js, a separate classic worker
 * that runs only the boot sequence with the game worker's model of time, and
 * is drawn by the same TileMapEntity/SpriteLayerEntity as the game. The game
 * worker (app.worker) is not touched. Application data is loaded by the app,
 * not by this model (ZXResetModel pattern: retryLoadAppData from the error
 * panel's RETRY button).
 */
export class BootModel extends AbstractModel {

  /**
   * @param {Object} app - The application instance.
   * @param {string} copyright - The copyright text shown after the boot.
   */
  constructor(app, copyright) {
    super(app);
    this.id = 'BootModel';

    this.copyright = copyright;
    this.worker = null;
    this.booted = false;
    this.render = null;
    this.tileMapEntity = null;
    this.spriteLayerEntity = null;
    this.copyrightEntity = null;
  } // constructor

  newBorderEntity() {
    return new BorderEntity(false, false);
  } // newBorderEntity

  /**
   * Builds the picture entities and the copyright line, then schedules the
   * boot. Without the graphics data files there is nothing to animate, so the
   * model goes straight to the copyright.
   */
  init() {
    super.init();

    this.borderEntity.bkColor = '#000000';
    this.desktopEntity.bkColor = '#000000';

    this.copyrightEntity = new TextEntity(this.desktopEntity, this.app.fonts.fonts5x5, 0, this.desktopHeight-14, this.desktopWidth, 5,
      this.copyright.replace(/⋅/g, '-').replace(/␣/g, ' '), ZXColor.white, false, {align: 'center'});
    this.copyrightEntity.hide = true;
    this.desktopEntity.addEntity(this.copyrightEntity);

    // the video needs the data files: at once from localStorage, or from the
    // server when appData has come but they are missing there (R-062); while
    // appData is still on its way the boot goes on with what is stored
    if (this.app.appDataPending()) {
      this.startBoot(this.initVideo());
    } else {
      this.loadDataFiles(['tiles', 'sprites', 'palette'], (files) => {
        if (this.app.model === this) {
          this.startBoot(!!files && this.initVideo());
        }
      });
    }
  } // init

  /**
   * The reset with the video, or the copyright without it.
   * @param {boolean} video - Whether the video entities were created.
   */
  startBoot(video) {
    if (video) {
      this.sendEvent(500, {id: 'showReset'});
    } else {
      this.sendEvent(500, {id: 'showCopyright'});
    }
  } // startBoot

  shutdown() {
    super.shutdown();
    this.stopWorker();
  } // shutdown

  /**
   * The shared renderer and the two picture entities, as in MainModel.
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

  /** starts the boot worker; its frames arrive through handleWorkerMessage */
  startWorker() {
    this.worker = new Worker(this.app.importPath+'/bootWorker.js?ver='+window.srcVersion);
    this.worker.onmessage = (event) => {
      this.handleWorkerMessage(event);
    };
    this.worker.onerror = (error) => {
      console.error(error.message ? error.message : error);
      this.sendEvent(0, {id: 'showCopyright'});
    };
    this.worker.postMessage({id: 'init', initData: {}});
  } // startWorker

  stopWorker() {
    if (this.worker) {
      this.worker.postMessage({id: 'reset'});
      this.worker.terminate();
      this.worker = null;
    }
  } // stopWorker

  handleWorkerMessage(event) {
    var data = event.data;
    switch (data.id) {
      case 'frame':
        if (this.tileMapEntity && data.vram && data.attr && data.sprites && data.regs) {
          this.tileMapEntity.setFrame(data);
          this.spriteLayerEntity.setFrame(data);
        }
        break;
      case 'booted':
        // drawTitle would start now: the boot is over
        this.sendEvent(0, {id: 'showCopyright'});
        break;
    }
  } // handleWorkerMessage

  /**
   * showReset -> (boot animation, ~194 frames) -> showCopyright -> setMenuModel;
   * the ZXResetModel sequence with the boot worker in place of the stripes.
   * @param {Object} event - The event object, identified by its id property.
   * @returns {boolean} True if the event was handled.
   */
  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }

    switch (event.id) {
      case 'showReset':
        this.startWorker();
        // safety net: should the worker never report the end of the boot
        // (194 frames = 3.3 s), the menu still comes up
        this.sendEvent(8000, {id: 'showCopyright'});
        return true;
      case 'showCopyright':
        if (this.booted) {
          return true;
        }
        this.booted = true;
        this.cancelEvent('showCopyright');
        this.stopWorker();
        if (this.tileMapEntity) {
          this.tileMapEntity.hide = true;
          this.spriteLayerEntity.hide = true;
        }
        this.copyrightEntity.hide = false;
        this.drawModel();
        this.sendEvent(1200, {id: 'setMenuModel'});
        return true;
      case 'setMenuModel':
        // not before the application data has come or failed
        // (AbstractApp.appDataPending): on a slow line the boot stays
        if (this.app.appDataPending()) {
          this.sendEvent(100, {id: 'setMenuModel'});
          return true;
        }
        this.app.setModel('MenuModel');
        return true;
      case 'keyPress':
        // any key, mouse button or touch ends the boot at once
        if (this.desktopEntity.modalEntity) {
          break;
        }
        this.booted = true;
        this.cancelEvent('showCopyright');
        this.cancelEvent('setMenuModel');
        this.stopWorker();
        this.sendEvent(0, {id: 'menuWhenReady'});
        return true;
      case 'menuWhenReady':
        // a key can end the boot before the application data have arrived:
        // the menu waits for the request to be over (AbstractApp.appDataPending,
        // however long a slow line takes), then comes up at once
        if (this.app.appDataPending()) {
          this.sendEvent(100, {id: 'menuWhenReady'});
        } else {
          this.app.setModel('MenuModel');
        }
        return true;
      case 'retryLoadAppData':
        // sent by the error panel's RETRY button: reload the application data
        // and retry the menu handover once the request is over (setMenuModel
        // waits for it; offline there is none and the app falls back to
        // storage at once)
        this.app.loadAppData();
        this.sendEvent(0, {id: 'setMenuModel'});
        return true;
    }

    return false;
  } // handleEvent

  loopModel(timestamp) {
    super.loopModel(timestamp);
    this.drawModel();
  } // loopModel

} // BootModel
