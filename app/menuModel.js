const { AbstractModel } = await import('./svision/js/abstractModel.js?ver='+window.srcVersion);
const { BorderEntity } = await import('./borderEntity.js?ver='+window.srcVersion);
const { TextEntity } = await import('./svision/js/platform/canvas2D/textEntity.js?ver='+window.srcVersion);
const { ButtonEntity } = await import('./svision/js/platform/canvas2D/buttonEntity.js?ver='+window.srcVersion);
const { MenuEntity } = await import('./svision/js/platform/canvas2D/menuEntity.js?ver='+window.srcVersion);
const { ZXPlayerNameEntity } = await import('./svision/js/platform/canvas2D/zx/zxPlayerNameEntity.js?ver='+window.srcVersion);
const { HallOfFameEntity } = await import('./hallOfFameEntity.js?ver='+window.srcVersion);
const { ZXVolumeEntity } = await import('./svision/js/platform/canvas2D/zx/zxVolumeEntity.js?ver='+window.srcVersion);
const { ZXSettingsEntity } = await import('./svision/js/platform/canvas2D/zx/zxSettingsEntity.js?ver='+window.srcVersion);
const { AboutEntity } = await import('./aboutEntity.js?ver='+window.srcVersion);
const { ZXWaitForAudioEventEntity } = await import('./svision/js/platform/canvas2D/zx/zxWaitForAudioEventEntity.js?ver='+window.srcVersion);
const { ZXColor } = await import('./svision/js/platform/canvas2D/zx/zxColor.js?ver='+window.srcVersion);
const { ZXDialogEntity } = await import('./svision/js/platform/canvas2D/zx/zxDialogEntity.js?ver='+window.srcVersion);
const { ZXDialogProperties } = await import('./svision/js/platform/canvas2D/zx/zxDialogProperties.js?ver='+window.srcVersion);
const { TileMapRender } = await import('./tileMapRender.js?ver='+window.srcVersion);
const { TitleBackdropEntity } = await import('./titleBackdropEntity.js?ver='+window.srcVersion);
// begin code

/**
 * Main menu (GAME-DESIGN chap. 3): same structure as Manic Miner. The menu
 * itself never touches the audio buses (no open, no close); items that need
 * sound go through ZXWaitForAudioEventEntity first when the browser requires
 * a user gesture (MM pattern: needEventForAudio() -> startGame2). ATTRACT MODE
 * is a placeholder until ST-M7 (it starts the placeholder game for now).
 */
export class MenuModel extends AbstractModel {

  constructor(app, selectionItem) {
    super(app);
    this.id = 'MenuModel';

    this.menuItems = [
      {t1: 'START GAME', event: {id: 'startGame'}},
      {t1: 'PLAYER NAME', event: {id: 'setPlayerName'}},
      {t1: 'HALL OF FAME', event: {id: 'showHallOfFame'}},
      {t1: 'SOUNDS', event: {id: 'setSounds'}},
      {t1: 'MUSIC', event: {id: 'setMusic'}},
      {t1: 'SETTINGS', event: {id: 'setSettings'}},
      {t1: 'ATTRACT MODE', event: {id: 'startAttract'}},
      {t1: 'ABOUT GAME', event: {id: 'showAbout'}}
    ];
    this.menuOptions = {
      fonts: this.app.fonts.stingerFonts8x8,   // the arcade letters of the game
      leftMargin: 9,
      rightMargin: 9,
      topMargin: 8,
      itemHeight: 12,
      t1LeftMargin: 3,
      t1TopMargin: 2,
      t2Width: 96,
      t2RightMargin: 3,
      t2TopMargin: 2,
      textColor: ZXColor.brightWhite,
      selectionTextColor: ZXColor.black,
      selectionBarColor: ZXColor.brightGreen,
      hoverColor: '#333333ff',
      selectionHoverColor: ZXColor.green,
      clickColor: '#444444ff',
      selectionClickColor: '#00aa00ff',
      selection: selectionItem
    }
    // the dialogs opened from the menu: the window (ZXDialogEntity), its place
    // and colours, and the colours of the contents from svision; what is not
    // set here is the default of ZXDialogProperties (the look of Manic Miner)
    this.dialogProperties = ZXDialogProperties.merge({
      x: 11,
      y: 61,
      width: 202,
      height: 134,
      titleColor: ZXColor.brightMagenta,
      bkColor: ZXColor.brightWhite,
      theme: {keyboardButtonsBkColor: ZXColor.brightGreen},
      waitForAudioEvent: {frameColor: ZXColor.black, bkColor: ZXColor.brightGreen, theme: {penColor: ZXColor.black}}
    });

    this.copyrightEntity = null;
    this.versionEntity = null;
    this.backdropEntity = null;
    this.menuEntity = null;
    this.newVersionAvailable = false;
  } // constructor

  newBorderEntity() {
    return new BorderEntity(false, false);
  } // newBorderEntity

  init() {
    super.init();

    this.borderEntity.bkColor = ZXColor.black;
    this.desktopEntity.bkColor = ZXColor.black;

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
    // the backdrop: the original title screen with the STINGER logo (y 40..79)
    // and the rolling blue circuitry; the menu sits below the logo on it with
    // no background of its own. Without the graphics data the menu stays on black.
    this.initBackdrop();
    this.menuEntity = new MenuEntity(this.desktopEntity, 0, 88, 224, 139, this.backdropEntity ? false : this.desktopEntity.bkColor, this.menuOptions, this, this.getMenuData);
    this.desktopEntity.addEntity(this.menuEntity);

    this.versionEntity = new ButtonEntity(this.desktopEntity, this.app.fonts.fonts5x5, 160, 231, 55, 5, 'Ⓥ'+this.app.version, {id: 'upgradeApp'}, [], ZXColor.brightWhite, ZXColor.black, {align: 'center'});
    this.desktopEntity.addEntity(this.versionEntity);
    // suppress the hover/click colors resolved in init(), so the button always
    // looks like plain text
    this.versionEntity.hoverColor = false;
    this.versionEntity.clickColor = false;
    this.checkServerVersion();

    this.copyrightEntity = new TextEntity(this.desktopEntity, this.app.fonts.fonts5x5, 0, this.desktopHeight-14, this.desktopWidth, 5, this.app.copyright.replace(/⋅/g, '-').replace(/␣/g, ' '), ZXColor.white, false, {align: 'center'});
    this.desktopEntity.addEntity(this.copyrightEntity);

    // R-024: the menu is silent on purpose. A browser will not start audio
    // before a user gesture and the menu is the one screen reachable without
    // one, so the buses close here and sound begins a floor below, behind the
    // menu item the player picked.
    // the flash clock of the ZX attributes (app.stack.flashState, 330 ms like
    // the ROM's 16 frames): the blinking cursor of the remap dialog and of the
    // player name input reads it, so the menu has to keep it going like every
    // other model
    this.app.stack.flashState = false;
    this.sendEvent(330, {id: 'changeFlashState'});

    this.sendEvent(0, {id: 'closeAllAudioBuses'});
  } // initData

  /**
   * Builds the title backdrop from the ROM graphics data and the tables.
   * @returns {boolean} True when the backdrop entity was created.
   */
  initBackdrop() {
    var tiles = this.loadDataFile('tiles');
    var sprites = this.loadDataFile('sprites');
    var palette = this.loadDataFile('palette');
    var tables = this.loadDataFile('tables');
    if (!tiles || !sprites || !palette || !tables) {
      return false;
    }
    try {
      var render = new TileMapRender({tiles: tiles, sprites: sprites, palette: palette});
      this.backdropEntity = new TitleBackdropEntity(this.desktopEntity, 0, 0, render, tables);
    } catch (error) {
      console.error(error.message);
      this.backdropEntity = null;
      return false;
    }
    this.desktopEntity.addEntity(this.backdropEntity);
    return true;
  } // initBackdrop

  checkServerVersion() {
    var receiver = {
      id: this.id+'Version',
      fetchDataId: '',
      setData: (data) => {
        if (data.data.version && data.data.version !== 'unknown' && data.data.version !== this.app.version) {
          this.newVersionAvailable = true;
          this.versionEntity.setText('UPGRADE !');
          this.versionEntity.setPenColor(ZXColor.brightRed);
        }
      },
      errorData: () => {}
    };
    receiver.fetchDataId = this.app.fetchData('version.db', false, {}, receiver);
  } // checkServerVersion

  getMenuData(self, key, row) {
    switch (key) {

      case 'numberOfItems':
        return self.menuItems.length;

      case 't2':
        switch (row) {
          case 1:
            return self.app.playerName;
          case 3:
            return ZXVolumeEntity.levelText(self.app.audioManager.volume.sounds);
          case 4:
            return ZXVolumeEntity.levelText(self.app.audioManager.volume.music);
        }
        break;

      default:
        if (key in self.menuItems[row]) {
          return self.menuItems[row][key];
        }
        break;

    }
    return '';
  } // getMenuData

  /**
   * Opens a dialog from the menu: the window with the title (ZXDialogEntity),
   * placed and coloured by the dialog properties, and the contents the factory
   * makes for it, as the modal of the desktop.
   * @param {string} title - The text of the title bar.
   * @param {Function} contentFactory - Called with the window, returns the contents entity.
   */
  openDialog(title, contentFactory) {
    var p = this.dialogProperties;
    this.desktopEntity.addModalEntity(new ZXDialogEntity(this.desktopEntity, p.x, p.y, p.width, p.height, title, p, contentFactory));
  } // openDialog

  /**
   * Asks for the browser's gesture for audio before an action that plays
   * sound: ZXWaitForAudioEventEntity in a window without a title, centred on
   * the screen, coloured by the `waitForAudioEvent` dialog properties.
   * @param {string} continueEvent - The event sent when the gesture comes.
   */
  openWaitForAudioEvent(continueEvent) {
    var p = this.dialogProperties.waitForAudioEvent;
    this.desktopEntity.addModalEntity(new ZXDialogEntity(this.desktopEntity, 50, 107, 124, 41, false, p, (dialog) => new ZXWaitForAudioEventEntity(dialog, dialog.innerX, dialog.innerY, dialog.innerWidth, dialog.innerHeight, continueEvent, p)));
  } // openWaitForAudioEvent

  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }

    switch (event.id) {
      case 'startGame':
        if (!this.app.playerName.length) {
          this.openDialog('PLAYER NAME', (dialog) => new ZXPlayerNameEntity(dialog, dialog.innerX, dialog.innerY, dialog.innerWidth, dialog.innerHeight, true, this.dialogProperties));
          return true;
        } else {
          if (this.app.inputEventsManager.needEventForAudio()) {
            this.openWaitForAudioEvent('startGame2');
            return true;
          }
        }
      case 'startGame2':
        this.app.startGame(false);
        return true;

      case 'setPlayerName':
        this.openDialog('PLAYER NAME', (dialog) => new ZXPlayerNameEntity(dialog, dialog.innerX, dialog.innerY, dialog.innerWidth, dialog.innerHeight, false, this.dialogProperties));
        return true;

      case 'showHallOfFame':
        this.desktopEntity.addModalEntity(new HallOfFameEntity(this.desktopEntity, 11, 61, 202, 134, this.dialogProperties.bkColor));
        return true;

      case 'setSounds':
        this.openDialog('sounds', (dialog) => new ZXVolumeEntity(dialog, dialog.innerX, dialog.innerY, dialog.innerWidth, dialog.innerHeight, 'sounds', 'audioBusSoundsLevel', 'exampleFireSound', this.dialogProperties));
        return true;

      case 'setMusic':
        this.openDialog('music', (dialog) => new ZXVolumeEntity(dialog, dialog.innerX, dialog.innerY, dialog.innerWidth, dialog.innerHeight, 'music', 'audioBusMusicLevel', 'exampleMelodySound', this.dialogProperties));
        return true;

      case 'setSettings':
        this.openDialog('SETTINGS', (dialog) => new ZXSettingsEntity(dialog, dialog.innerX, dialog.innerY, dialog.innerWidth, dialog.innerHeight, this.app.controlsOptions, this.dialogProperties));
        return true;

      case 'startAttract':
        if (this.app.inputEventsManager.needEventForAudio()) {
          this.openWaitForAudioEvent('startAttract2');
          return true;
        }
      case 'startAttract2':
        this.app.startGame(true);
        return true;

      case 'showAbout':
        this.desktopEntity.addModalEntity(new AboutEntity(this.desktopEntity, 11, 61, 202, 134, this.dialogProperties.bkColor));
        return true;

      case 'upgradeApp':
        if (this.newVersionAvailable) {
          this.app.upgradeApp();
        }
        return true;

      case 'changeFlashState':
        this.app.stack.flashState = !this.app.stack.flashState;
        this.sendEvent(330, {id: 'changeFlashState'});
        return true;
    }

    return false;
  } // handleEvent

  loopModel(timestamp) {
    super.loopModel(timestamp);

    if (this.backdropEntity) {
      this.backdropEntity.loopEntity(timestamp);
    }
    if (this.desktopEntity.modalEntity) {
      this.desktopEntity.modalEntity.loopEntity(timestamp);
    } else if (this.menuEntity) {
      // the value column (t2) is a SlidingTextEntity: a player's name too long
      // for its column ping-pongs, and it is this call that moves it (Sabre Wulf)
      this.menuEntity.loopEntity(timestamp);
    }

    this.drawModel();
  } // loopModel

} // MenuModel
