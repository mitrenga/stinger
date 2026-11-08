// begin code

/**
 * Pixel-exact software renderer of the Stinger video hardware (GAME-DESIGN
 * chap. 2.3). Deliberately free of DOM and Node dependencies so that the very
 * same code runs in the browser (tileMapEntity.js, spriteLayerEntity.js) and
 * in the reference emulator (tools/refemu/run.mjs) — pixel identity between
 * the remake and refemu is then structural, not a thing to be re-verified.
 *
 * Hardware model:
 *   - raster 256x256, visible hardware rows 16..239 -> 256 (w) x 224 (h);
 *     the cabinet is ROT90, so the player sees 224 (w) x 256 (h):
 *     player (px, py) == hardware (hx = py, hy = 239 - px)
 *   - two tile layers of 32x32 codes, 8x8 tiles, 3 bpp, two character banks
 *     each: layer 0 (background, E000) draws gfx2, layer 1 (foreground, D000)
 *     draws gfx1
 *   - per hardware column scroll: attr[2*sx] scrolls the column,
 *     attr[2*sx+1] & 7 is its color; after ROT90 this is the per-row
 *     horizontal scroll of both layers
 *   - 16x16 sprites, 3 bpp, 4 bytes per entry {y, code, color & 7, x};
 *     x == 0 or y == 0 hides the sprite, sy = 240 - y, and the first three
 *     sprites of set 0 are drawn one line higher ("like Galaxian")
 *   - drawing order: bgcolor fill -> layer 0 -> layer 1 -> sprite set 1
 *     (gfx1) -> sprite set 0 (gfx2); pen 0 is transparent everywhere, so both
 *     layers show the background color through
 *   - pen index = 64 * palbank + 8 * color + pixel, into the 256 color PROM
 *     palette (data/palette.json)
 *
 * The frame state is exactly what the worker sends (app/WORKER-PROTOCOL.md):
 *   {vram: [l0, l1], attr: [a0, a1], sprites: [s0, s1],
 *    regs: {palbank, charbank: [b0, b1], bgcolor, flip: [x, y]}}
 * Flip x/y are cocktail-cabinet registers; the remake ignores them.
 */
export class TileMapRender {

  static get WIDTH() { return 224; }
  static get HEIGHT() { return 256; }

  /**
   * Builds the renderer from the ROM conversion data.
   * @param {Object} graphics - {tiles, sprites, palette}: the parsed contents of
   *   data/tiles.json, data/sprites.json and data/palette.json.
   */
  constructor(graphics) {
    this.id = 'TileMapRender';

    this.pens = new Uint8Array(256*3);
    var pens = graphics.palette.pens;
    for (var p = 0; p < 256 && p < pens.length; p++) {
      this.pens[p*3] = parseInt(pens[p].substring(1, 3), 16);
      this.pens[p*3+1] = parseInt(pens[p].substring(3, 5), 16);
      this.pens[p*3+2] = parseInt(pens[p].substring(5, 7), 16);
    }

    this.tiles = {gfx1: this.decodeBanks(graphics.tiles.gfx1, 64), gfx2: this.decodeBanks(graphics.tiles.gfx2, 64)};
    this.sprites = {gfx1: this.decodeSet(graphics.sprites.gfx1, 256), gfx2: this.decodeSet(graphics.sprites.gfx2, 256)};

    // hardware framebuffer of pen indices, -1 = transparent
    this.hw = new Int16Array(256*256);
  } // constructor

  /**
   * Decodes the character banks of one graphics region from '0'..'7' strings
   * into byte arrays, keeping the original in-string pixel order.
   * @param {Array} banks - Array of banks, each an array of tile strings.
   * @param {number} size - Number of pixels per tile.
   * @returns {Array} Array of banks of Uint8Array tiles.
   */
  decodeBanks(banks, size) {
    return banks.map((bank) => this.decodeSet(bank, size));
  } // decodeBanks

  /**
   * Decodes one set of '0'..'7' pixel strings into byte arrays.
   * @param {Array} set - Array of pixel strings.
   * @param {number} size - Number of pixels per element.
   * @returns {Array} Array of Uint8Array elements.
   */
  decodeSet(set, size) {
    return set.map((text) => {
      var data = new Uint8Array(size);
      for (var i = 0; i < size; i++) {
        data[i] = text.charCodeAt(i)-48;
      }
      return data;
    });
  } // decodeSet

  /**
   * Fills the hardware framebuffer with a single pen (or -1 for transparent).
   * @param {number} pen - The pen index to fill with.
   */
  fillHW(pen) {
    this.hw.fill(pen);
  } // fillHW

  /**
   * Draws one tile layer into the hardware framebuffer, applying the per-column
   * scroll and color from the attribute RAM. Pen 0 stays transparent.
   * @param {Object} state - The frame state.
   * @param {number} layer - 0 for the background layer, 1 for the foreground layer.
   * @param {string} region - 'gfx2' for layer 0, 'gfx1' for layer 1.
   */
  drawLayer(state, layer, region) {
    var bank = this.tiles[region][state.regs.charbank[layer] & 1];
    var vram = state.vram[layer];
    var attr = state.attr[layer];
    var palBase = 64*(state.regs.palbank & 3);
    var hw = this.hw;

    for (var offs = 0x3FF; offs >= 0; offs--) {
      var sx = offs & 0x1F;
      var sy = offs >> 5;
      var tile = bank[vram[offs]];
      var penBase = palBase+8*(attr[(sx << 1) | 1] & 7);
      var scroll = (8*sy+256-attr[sx << 1]) & 0xFF;
      var column = sx*8;
      for (var iy = 0; iy < 8; iy++) {
        var row = (((scroll+iy) & 0xFF) << 8)+column;
        var base = 7-iy;
        for (var ix = 0; ix < 8; ix++) {
          var pixel = tile[ix*8+base];
          if (pixel) {
            hw[row+ix] = penBase+pixel;
          }
        }
      }
    }
  } // drawLayer

  /**
   * Draws one sprite set into the hardware framebuffer. Entries with x == 0 or
   * y == 0 are hidden, sy = 240 - y, and the first three sprites of set 0 are
   * shifted one line up (a hardware quirk the program does not compensate for).
   * @param {Object} state - The frame state.
   * @param {number} set - 0 for the gfx2 set (E840), 1 for the gfx1 set (D840).
   * @param {string} region - 'gfx1' or 'gfx2'.
   */
  drawSprites(state, set, region) {
    var data = state.sprites[set];
    var bank = this.sprites[region];
    var palBase = 64*(state.regs.palbank & 3);
    var hw = this.hw;

    for (var offs = 0x1C; offs >= 0; offs -= 4) {
      var sy = data[offs];
      var sx = data[offs+3];
      if (!sx || !sy) {
        continue;
      }
      if (set == 0 && offs <= 8) {
        sy = (sy-1) & 0xFF;
      }
      sy = 240-sy;
      var sprite = bank[data[offs+1]];
      var penBase = palBase+8*(data[offs+2] & 7);
      for (var iy = 0; iy < 16; iy++) {
        var hy = sy+iy;
        if (hy < 0 || hy > 255) {
          continue;
        }
        var row = hy << 8;
        var base = 15-iy;
        for (var ix = 0; ix < 16; ix++) {
          var hx = sx+ix;
          if (hx < 0 || hx > 255) {
            continue;
          }
          var pixel = sprite[ix*16+base];
          if (pixel) {
            hw[row+hx] = penBase+pixel;
          }
        }
      }
    }
  } // drawSprites

  /**
   * Rotates the hardware framebuffer into the player's 224x256 view and
   * converts pen indices to RGBA. Transparent pens (-1) get alpha 0.
   * @param {Uint8ClampedArray|Uint8Array} rgba - Target buffer, 224*256*4 bytes.
   */
  blit(rgba) {
    var hw = this.hw;
    var pens = this.pens;
    var i = 0;
    for (var py = 0; py < 256; py++) {
      var column = py;                    // hx == py
      for (var px = 0; px < 224; px++) {
        var pen = hw[((239-px) << 8)+column];
        if (pen < 0) {
          rgba[i] = 0; rgba[i+1] = 0; rgba[i+2] = 0; rgba[i+3] = 0;
        } else {
          var c = pen*3;
          rgba[i] = pens[c]; rgba[i+1] = pens[c+1]; rgba[i+2] = pens[c+2]; rgba[i+3] = 255;
        }
        i += 4;
      }
    }
  } // blit

  /**
   * Renders the background color and both tile layers, opaque.
   * @param {Object} state - The frame state.
   * @param {Uint8ClampedArray|Uint8Array} rgba - Target buffer, 224*256*4 bytes.
   */
  renderLayers(state, rgba) {
    this.fillHW(state.regs.bgcolor & 0xFF);
    this.drawLayer(state, 0, 'gfx2');
    this.drawLayer(state, 1, 'gfx1');
    this.blit(rgba);
  } // renderLayers

  /**
   * Renders both sprite sets over a transparent background, in hardware order
   * (set 1 first, then set 0).
   * @param {Object} state - The frame state.
   * @param {Uint8ClampedArray|Uint8Array} rgba - Target buffer, 224*256*4 bytes.
   */
  renderSprites(state, rgba) {
    this.fillHW(-1);
    this.drawSprites(state, 1, 'gfx1');
    this.drawSprites(state, 0, 'gfx2');
    this.blit(rgba);
  } // renderSprites

  /**
   * Renders the complete picture — background, both layers and both sprite
   * sets — in one opaque buffer, exactly in hardware drawing order.
   * @param {Object} state - The frame state.
   * @param {Uint8ClampedArray|Uint8Array} rgba - Target buffer, 224*256*4 bytes.
   */
  renderFrame(state, rgba) {
    this.fillHW(state.regs.bgcolor & 0xFF);
    this.drawLayer(state, 0, 'gfx2');
    this.drawLayer(state, 1, 'gfx1');
    this.drawSprites(state, 1, 'gfx1');
    this.drawSprites(state, 0, 'gfx2');
    this.blit(rgba);
  } // renderFrame

} // TileMapRender
