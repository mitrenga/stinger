const { AbstractModel } = await import('./svision/js/abstractModel.js?ver='+window.srcVersion);
const { TextEntity } = await import('./svision/js/platform/canvas2D/textEntity.js?ver='+window.srcVersion);
const { ButtonEntity } = await import('./svision/js/platform/canvas2D/buttonEntity.js?ver='+window.srcVersion);
const { ZXColor } = await import('./svision/js/platform/canvas2D/zx/zxColor.js?ver='+window.srcVersion);
// begin code

/**
 * Game over: shows the score, stores it in the server hall of fame (same
 * saveGame.db API as Manic Miner) and returns to the menu after a countdown.
 */
export class GameOverModel extends AbstractModel {

  constructor(app, nextModel) {
    super(app);
    this.id = 'GameOverModel';

    this.nextModel = nextModel;
    this.countdownLength = 8;
    this.buttonEntity = null;
    this.timerEntity = null;
  } // constructor

  init() {
    super.init();

    this.desktopEntity.bkColor = ZXColor.black;
    this.borderEntity.bkColor = ZXColor.black;

    this.desktopEntity.addEntity(new TextEntity(this.desktopEntity, this.app.fonts.zxFonts8x8, 0, 10*8, this.desktopWidth, 8, 'GAME OVER', ZXColor.brightRed, false, {align: 'center'}));
    this.desktopEntity.addEntity(new TextEntity(this.desktopEntity, this.app.fonts.zxFonts8x8Mono, 0, 13*8, this.desktopWidth, 8, 'SCORE '+String(this.app.score).padStart(4, '0'), ZXColor.brightWhite, false, {align: 'center'}));
    var hiScore = Math.max(this.app.hiScore || 0, this.app.score || 0);
    var hiText = (this.app.score > 0 && this.app.score >= (this.app.hiScore || 0)) ? 'NEW HI-SCORE !' : 'HI-SCORE '+String(hiScore).padStart(4, '0');
    this.desktopEntity.addEntity(new TextEntity(this.desktopEntity, this.app.fonts.zxFonts8x8Mono, 0, 15*8, this.desktopWidth, 8, hiText, ZXColor.brightGreen, false, {align: 'center'}));
    this.buttonEntity = new ButtonEntity(this.desktopEntity, this.app.fonts.zxFonts8x8Mono, this.desktopWidth/2-35, 22*8-4, 70, 12, 'MENU', {id: this.nextModel}, ['Enter', 'Escape', ' ', 'GamepadOK', 'GamepadExit'], ZXColor.brightWhite, ZXColor.green, {topMargin: 2, align: 'center'});
    this.desktopEntity.addEntity(this.buttonEntity);
    this.timerEntity = new TextEntity(this.buttonEntity, this.app.fonts.fonts5x5, 8, 4, 10, 5, String(this.countdownLength), ZXColor.white, false, {align: 'center'});
    this.buttonEntity.addEntity(this.timerEntity);

    if (this.app.score) {
      this.fetchData('saveGame.db', false, {name: this.app.playerName, score: this.app.score});
    }
  } // init

  shutdown() {
    super.shutdown();
    this.sendEvent(0, {id: 'stopAllAudioBuses'});
  } // shutdown

  setData(data) {
    this.app.hiScore = data.data.hiScore;
  } // setData

  errorData(data) {
  } // errorData

  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }

    switch (event.id) {
      case 'MenuModel':
        this.app.setModel('MenuModel');
        return true;
    }

    return false;
  } // handleEvent

  loopModel(timestamp) {
    super.loopModel(timestamp);

    if (this.timer === false) {
      this.timer = timestamp;
    }
    var countdown = this.countdownLength-Math.floor((timestamp-this.timer)/1000);
    if (countdown < 0) {
      this.sendEvent(1, {id: this.nextModel});
    } else {
      this.timerEntity.setText(countdown.toString());
    }

    this.drawModel();
  } // loopModel

} // GameOverModel
