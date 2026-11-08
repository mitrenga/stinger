const { AbstractEntity } = await import('./svision/js/abstractEntity.js?ver='+window.srcVersion);
const { TextEntity } = await import('./svision/js/platform/canvas2D/textEntity.js?ver='+window.srcVersion);
const { ButtonEntity } = await import('./svision/js/platform/canvas2D/buttonEntity.js?ver='+window.srcVersion);
const { ZXColor } = await import('./svision/js/platform/canvas2D/zx/zxColor.js?ver='+window.srcVersion);
// begin code

export class AboutEntity extends AbstractEntity {

  constructor(parentEntity, x, y, width, height, bkColor) {
    super(parentEntity, x, y, width, height, false, false);
    this.id = 'AboutEntity';

    this.panelBkColor = bkColor;
    this.clickCounter = 0;
  } // constructor

  init() {
    super.init();

    this.addEntity(new AbstractEntity(this, 0, 0, this.width, this.height, false, ZXColor.black));
    this.addEntity(new ButtonEntity(this, this.app.fonts.fonts5x5, 0, 0, this.width, 9, 'ABOUT GAME', {id: 'clickLabel'}, [], ZXColor.brightWhite, false, {align: 'center', topMargin: 2, member: 'titleBar', hoverColor: ZXColor.black, clickColor: ZXColor.black}));
    this.addEntity(new AbstractEntity(this, 1, 9, this.width-2, this.height-10, false, this.panelBkColor));

    this.aboutText = 'STINGER IS A REMAKE OF THE ORIGINAL 1983 SEIBU DENSHI ARCADE GAME.\n' +
                    'THE GAME LOGIC IS BEING REWRITTEN FROM THE ORIGINAL PROGRAM ROM SO THAT THE GAME PLAYS ' +
                    'LIKE THE ARCADE MACHINE, INCLUDING ITS QUIRKS.\n' +
                    'THE HIGH SCORES ARE KEPT IN THE HALL OF FAME ON THE SERVER.';
    this.addEntity(new TextEntity(this, this.app.fonts.fonts5x5, 1, 9, this.width-2, this.height-25, this.aboutText, ZXColor.black, false, {align: 'justify', textWrap: true, margin: 2, member: 'aboutText'}));
    this.addEntity(new ButtonEntity(this, this.app.fonts.fonts5x5, 3, this.height-16, 54, 13, 'MORE INFO', {id: 'openAboutURL'}, ['Enter', 'GamepadOK'], ZXColor.brightWhite, ZXColor.green, {align: 'center', margin: 4}));
    this.addEntity(new ButtonEntity(this, this.app.fonts.fonts5x5, this.width-39, this.height-16, 36, 13, 'CLOSE', {id: 'closeAbout'}, ['Escape', 'GamepadExit'], ZXColor.brightWhite, ZXColor.blue, {align: 'center', margin: 4}));

    this.statsText = 'error:\nstatistics data not available!';
    this.fetchData('stats.db', false, {});
  } // init

  setData(data) {
    this.statsText = '';
    Object.entries(data.data).forEach(([periodKey, periodValue]) => {
      this.statsText += periodKey + ': [';
      Object.entries(periodValue).forEach(([key, value]) => {
        this.statsText += key + ':' + value + ', ';
      });
      this.statsText = this.statsText.slice(0, -2) + ']\n';
    });
  } // setData

  errorData(error) {
  } // errorData

  updateAbout() {
    switch (Math.floor(this.clickCounter/5)) {
      case 1:
        this.sendEvent(0, 0, {id: 'updateEntity', member: 'titleBar', text: 'GAME STATS'});
        this.sendEvent(0, 0, {id: 'updateEntity', member: 'aboutText', text: this.statsText});
        break;
      case 2:
        this.sendEvent(0, 0, {id: 'updateEntity', member: 'titleBar', text: 'SYSTEM INFO'});
        var ipLabelSeparator = ' ';
        if (window.clientIP.indexOf(':') >= 0) {
          ipLabelSeparator = '\n';
        }
        var sysInfoText =
          'version: ' + this.app.version + '\n' +
          'element: ' + this.app.element.clientWidth + ' x ' + this.app.element.clientHeight + '\n' +
          'canvas: ' + this.app.element.width + ' x ' + this.app.element.height + '\n' +
          'ratio: ' + this.app.layout.ratio + '\n' +
          'ip:' + ipLabelSeparator + window.clientIP + '\n';
        this.sendEvent(0, 0, {id: 'updateEntity', member: 'aboutText', text: sysInfoText});
        break;
      default:
        this.sendEvent(0, 0, {id: 'updateEntity', member: 'titleBar', text: 'ABOUT GAME'});
        this.sendEvent(0, 0, {id: 'updateEntity', member: 'aboutText', text: this.aboutText});
        break;
    }
  } // updateAbout

  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }
    switch (event.id) {

      case 'closeAbout':
        this.destroy();
        return true;

      case 'clickLabel':
        if (this.clickCounter < 14) {
          this.clickCounter++;
        } else {
          this.clickCounter = 0;
        }
        if (this.clickCounter%5 == 0) {
          this.updateAbout();
        }
        return true;

      case 'resizeModel':
        if (this.clickCounter > 9) {
          this.updateAbout();
        }
        return false;

      case 'openAboutURL':
        window.location.href = 'about';
        return true;
    }
    return false;
  } // handleEvent

} // AboutEntity
