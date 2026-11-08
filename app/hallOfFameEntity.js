const { AbstractEntity } = await import('./svision/js/abstractEntity.js?ver='+window.srcVersion);
const { TextEntity } = await import('./svision/js/platform/canvas2D/textEntity.js?ver='+window.srcVersion);
const { ButtonEntity } = await import('./svision/js/platform/canvas2D/buttonEntity.js?ver='+window.srcVersion);
const { ZXColor } = await import('./svision/js/platform/canvas2D/zx/zxColor.js?ver='+window.srcVersion);
// begin code

export class HallOfFameEntity extends AbstractEntity {

  constructor(parentEntity, x, y, width, height, bkColor) {
    super(parentEntity, x, y, width, height, false, false);
    this.id = 'HallOfFameEntity';

    this.panelBkColor = bkColor;
} // constructor

  init() {
    super.init();
    
    this.addEntity(new AbstractEntity(this, 0, 0, this.width, this.height, false, ZXColor.black));
    this.addEntity(new TextEntity(this, this.app.fonts.fonts5x5, 0, 0, this.width, 9, 'HALL OF FAME', ZXColor.brightWhite, false, {align: 'center', topMargin: 2}));
    this.addEntity(new AbstractEntity(this, 1, 9, this.width-2, this.height-10, false, this.panelBkColor));

    this.addEntity(new ButtonEntity(this, this.app.fonts.fonts5x5, this.width-39, this.height-16, 36, 13, 'CLOSE', {id: 'closeHallOfFame'}, ['Enter', 'Escape', ' ', 'GamepadOK', 'GamepadExit'], ZXColor.brightWhite, ZXColor.brightBlue, {align: 'center', margin: 4}));

    if (navigator.onLine) {
      this.fetchData('hallOfFame.db', false, {});
    } else {
      this.showOfflineNotice();
    }
  } // init

  setData(data) {
    for (var i = 0; i < Object.keys(data.data).length; i++) {
      var y = 12+i*10;
      this.addEntity(new TextEntity(this, this.app.fonts.zxFonts8x8, 2, y, 18, 8, (i+1)+'.', ZXColor.black, false, {align: 'right'}));
      this.addEntity(new TextEntity(this, this.app.fonts.zxFonts8x8, 24, y, 120, 8, data.data[i].name, ZXColor.black, false, {}));
      this.addEntity(new TextEntity(this, this.app.fonts.zxFonts8x8Mono, this.width-108, y, 102, 8, data.data[i].score, ZXColor.black, false, {align: 'right'}));
      if (i == 0) {
        this.app.hiScore = data.data[0].score;
      }
    }
  } // setData

  errorData(error) {
    this.showOfflineNotice();
  } // errorData

  showOfflineNotice() {
    this.addEntity(new TextEntity(this, this.app.fonts.zxFonts8x8, 0, this.height/2-20, this.width, 32, 'SYSTEM OFFLINE', ZXColor.brightRed, false, {align: 'center', textWrap: true}));
  } // showOfflineNotice

  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }

    switch (event.id) {
      case 'closeHallOfFame':
        this.destroy();
        return true;
    }

    return false;
  } // handleEvent

} // HallOfFameEntity
