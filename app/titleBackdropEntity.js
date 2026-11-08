const { TileMapEntity } = await import('./tileMapEntity.js?ver='+window.srcVersion);
// begin code

/**
 * The backdrop of the menu: the title screen of the original with only the
 * STINGER logo on it — the blue circuitry of layer 0 rolling under it exactly
 * as on the attract title (bgScrollDec 225Eh, one pixel a frame at 60 Hz).
 *
 * The video state is built from data/tables.json the way drawTitle (0F2Eh)
 * builds it: layer 1 is the title picture at 5000h with the logo reveal
 * (logoTiles 110Bh, all 32 steps) applied, layer 1 attributes from attrInit
 * 5400h (the logo columns keep its colour 4, see buildTitleState), layer 0 is
 * the fortress page 4C00h laid down column by column from the bottom
 * (titleBgFillLoop 0FE0h) with every scroll byte set to 1, and PALBANK0 = 1
 * (setVideoRegs 22C4h with 02h). Every text of the picture — HUD, SEIBU
 * DENSHI, INSERT COIN, coinage — is blanked (tile 10h, what clearScreens
 * fills with), because the menu is drawn over it; the logo rows 5..9 stay.
 *
 * Nothing here is game logic: it is a still of the title with the original's
 * scroll, so it lives in the main thread like the border decoration.
 */
export class TitleBackdropEntity extends TileMapEntity {

  /**
   * @param {AbstractEntity} parentEntity - The parent entity.
   * @param {number} x - X position relative to the parent.
   * @param {number} y - Y position relative to the parent.
   * @param {TileMapRender} render - The shared renderer built from the ROM graphics data.
   * @param {Object} tables - The parsed data/tables.json.
   */
  constructor(parentEntity, x, y, render, tables) {
    super(parentEntity, x, y, render);
    this.id = 'TitleBackdropEntity';

    this.startTime = false;
    this.scroll = 1;
    this.setFrame(this.buildTitleState(tables));
  } // constructor

  /**
   * Reads the tables the title needs out of data/tables.json into a sparse ROM
   * image (the format of gameWorker.js loadTables: {addr, data base64}).
   * @param {Object} tables - The parsed data/tables.json.
   * @returns {Uint8Array} The sparse ROM image (unlisted bytes are zero).
   */
  loadRom(tables) {
    var rom = new Uint8Array(0xA000);
    var list = tables && tables.tables ? tables.tables : tables;
    if (!Array.isArray(list)) {
      return rom;
    }
    list.forEach((entry) => {
      var addr = typeof entry.addr == 'string' ? parseInt(entry.addr, 16) : entry.addr;
      var bytes = entry.data;
      if (!Array.isArray(bytes)) {
        var binary = atob(bytes);
        bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
      }
      for (var j = 0; j < bytes.length; j++) {
        rom[addr+j] = bytes[j];
      }
    });
    return rom;
  } // loadRom

  /**
   * The video state of the finished title with the texts blanked.
   * @param {Object} tables - The parsed data/tables.json.
   * @returns {Object} {vram, attr, sprites, regs} for TileMapRender.
   */
  buildTitleState(tables) {
    var rom = this.loadRom(tables);
    var vram0 = new Uint8Array(0x400), vram1 = new Uint8Array(0x400);
    var attr0 = new Uint8Array(0x40), attr1 = new Uint8Array(0x40);

    // 0F73: the title picture; 0F58/0F68: attrInit -> ATTR1
    vram1.set(rom.subarray(0x5000, 0x5400));
    attr1.set(rom.subarray(0x5400, 0x5440));
    // titleRevealStep (10C4h), all 32 steps of the logo
    for (var c = 0; c < 0x20; c++) {
      var ix = 0x005+0x20*c, iy = 0x3E7-0x20*c, hl = 0x110B+5*c;
      vram1[ix] = rom[hl];
      vram1[ix+1] = rom[hl+1];
      vram1[iy] = rom[hl+2];
      vram1[iy+1] = rom[hl+3];
      vram1[iy+2] = rom[hl+4];
    }
    // titleRevealStep ends by writing colour 6 straight into ATTR1 (10FEh), but
    // the NMI copies the shadow C100h -> D800h every frame, and the shadow keeps
    // attrInit's colour 4 for the logo columns: the logo is white with a red
    // outline (bank 1, colour 4, pens 2 and 1), as on the machine. Colour 6
    // (yellow) is on screen for one frame at most, so it is not applied here.
    // only the logo stays: hardware rows 5..9 (the low 5 bits of the address)
    for (var a = 0; a < 0x400; a++) {
      var row = a & 0x1F;
      if (row < 5 || row > 9) {
        vram1[a] = 0x10;
      }
    }

    // titleBgFillLoop (0FE0h): 32 columns of 4C00h into layer 0, bottom row first
    var src = 0x4C00, dst = 0x3E0;
    for (var col = 0; col < 0x20; col++) {
      for (var k = 0; k < 0x20; k++) {
        vram0[dst+k] = rom[src+k];
      }
      src += 0x20;
      dst = (dst-0x20) & 0x3FF;
    }
    attr0.fill(1);                               // 0FD0: layer 0 scroll = 1

    return {
      vram: [vram0, vram1],
      attr: [attr0, attr1],
      sprites: [new Uint8Array(0x20), new Uint8Array(0x20)],
      regs: {palbank: 1, charbank: [0, 0], bgcolor: 0, flip: [0, 0]}
    };
  } // buildTitleState

  /**
   * bgScrollDec (225Eh): every even attribute byte of layer 0 is the scroll of
   * one column, and all of them step down by one every frame of the original.
   * @param {number} timestamp - The current frame timestamp in milliseconds.
   */
  loopEntity(timestamp) {
    if (this.startTime === false) {
      this.startTime = timestamp;
      return;
    }
    var scroll = (1-Math.floor((timestamp-this.startTime)*60/1000)) & 0xFF;
    if (scroll === this.scroll) {
      return;
    }
    this.scroll = scroll;
    var attr0 = this.frameState.attr[0];
    for (var i = 0; i < 0x20; i++) {
      attr0[2*i] = scroll;
    }
    this.cleanCache();
  } // loopEntity

} // TitleBackdropEntity
