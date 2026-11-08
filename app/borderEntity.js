const { AbstractEntity } = await import('./svision/js/abstractEntity.js?ver='+window.srcVersion);
const { ButtonEntity } = await import('./svision/js/platform/canvas2D/buttonEntity.js?ver='+window.srcVersion);
const { TextEntity } = await import('./svision/js/platform/canvas2D/textEntity.js?ver='+window.srcVersion);
const { ZXColor } = await import('./svision/js/platform/canvas2D/zx/zxColor.js?ver='+window.srcVersion);
// begin code

/**
 * Border around the game area: optional exit (X) button, the two halves used
 * by the touch controls and the developer-mode banner. In SI-M3 the border
 * becomes the arcade bezel of ArcadePlatform (svision arcade/).
 */
export class BorderEntity extends AbstractEntity {

  constructor(enableExit, enableGameControls) {
    super(null, 0, 0, 0, 0, false, false);
    this.id = 'BorderEntity';

    this.enableExit = enableExit;
    this.enableGameControls = enableGameControls;

    this.escapeEntity = null;
    this.escapeScale = 2;

    this.leftControlEntity = null;
    this.rightControlEntity = null;
    this.devModeNameEntity = null;
  } // constructor

  init() {
    super.init();

    if (this.enableExit) {
      if (this.app.layout.ratio > 2) {
        this.escapeScale = 1;
      }
      this.escapeEntity = new ButtonEntity(this, this.app.fonts.zxFonts8x8Mono, 0, 0, this.escapeScale*8, this.escapeScale*8, 'X', {id: 'keyPress', key: 'Escape'}, [], false, false, {scale: this.escapeScale, clickColor: '#7a7a7aff'});
      this.addEntity(this.escapeEntity);
    }

    if (this.enableGameControls) {
      this.leftControlEntity = new AbstractEntity(this, 0, 0, 0, 0, false, false);
      this.addEntity(this.leftControlEntity);
      this.rightControlEntity = new AbstractEntity(this, 0, 0, 0, 0, false, false);
      this.addEntity(this.rightControlEntity);
    }

    if (this.app.devModeName !== false) {
      this.devModeNameEntity = new TextEntity(this, this.app.fonts.fonts5x5, 0, -7, 100, 7, '', false, false, {margin: 1});
      var cfgLen = this.app.devModeName.indexOf('}');
      this.devModeNameEntity.setText(this.app.devModeName.substring(cfgLen+1));
      var cfg = null;
      try {
        cfg = JSON.parse(this.app.devModeName.substring(1, cfgLen+1));
        Object.keys(cfg).forEach((item) => {
          this.devModeNameEntity[item] = cfg[item];
        });
      } catch (error) {
        console.error(error.message);
      }
      // no width in the configuration: the banner is as wide as its text (R-025)
      if (!cfg || !('width' in cfg)) {
        this.devModeNameEntity.width = this.devModeNameEntity.lineWidth(this.devModeNameEntity.text)+2;
      }
      this.addEntity(this.devModeNameEntity);
    }
  } // init

  drawEntity() {
    super.drawEntity();

    if (this.escapeEntity) {
      var penColor = ZXColor.brightWhite;
      switch (this.bkColor) {
        case ZXColor.white:
        case ZXColor.yellow:
        case ZXColor.cyan:
          penColor = ZXColor.black;
          break;
      }
      if (this.escapeEntity.penColor !== penColor) {
        this.escapeEntity.setPenColor(penColor);
      }
    }

    this.drawSubEntities();
  } // drawEntity

  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }
    switch (event.id) {
      case 'resizeModel':
        if (this.escapeEntity) {
          if (this.model.borderHeight < this.escapeScale*8) {
            this.escapeEntity.x = this.model.borderWidth+this.model.desktopEntity.width;
            this.escapeEntity.y = this.model.borderHeight;
          } else {
            this.escapeEntity.x = this.model.borderWidth+this.model.desktopEntity.width-this.escapeScale*8;
            this.escapeEntity.y = this.model.borderHeight-this.escapeScale*8;
          }
        }

        if (this.enableGameControls) {
          var w = Math.floor(this.width/2);

          this.leftControlEntity.x = 0;
          this.leftControlEntity.y = 0;
          this.leftControlEntity.width = w;
          this.leftControlEntity.height = this.height;

          this.rightControlEntity.x = this.width-w;
          this.rightControlEntity.y = 0;
          this.rightControlEntity.width = w;
          this.rightControlEntity.height = this.height;
        }

        if (this.devModeNameEntity) {
          this.devModeNameEntity.x = Math.floor((this.width-this.devModeNameEntity.width)/2);
          this.devModeNameEntity.y = Math.max(Math.floor((this.app.model.borderHeight-this.devModeNameEntity.height)/2), 0);
        }
        break;
    }
    return false;
  } // handleEvent

} // BorderEntity
