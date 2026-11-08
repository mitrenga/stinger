const { RasterEntity } = await import('./svision/js/platform/canvas2D/rasterEntity.js?ver='+window.srcVersion);
const { TileMapRender } = await import('./tileMapRender.js?ver='+window.srcVersion);
// begin code

/**
 * The two tile layers of the Stinger video hardware (GAME-DESIGN chap. 2.3):
 * background color fill, layer 0 (E000, gfx2 — stars and the fortress) and
 * layer 1 (D000, gfx1 — HUD, texts, channels), 8x8 tiles in 3 bpp, two
 * character banks and four palette banks, with the per-row horizontal scroll
 * that the hardware implements as a per-column scroll before the ROT90.
 *
 * The pixels themselves are produced by TileMapRender, the same module the
 * reference emulator uses (tools/refemu), so the browser picture and the
 * refemu PNG are identical by construction rather than by luck. The entity
 * only owns the frame {@link RasterEntity} hands it: the picture is rendered
 * once per game frame and blitted, scaled by the layout ratio, on every draw.
 *
 * Feed it with setFrame() from the worker 'frame' message
 * (app/WORKER-PROTOCOL.md); SpriteLayerEntity draws on top of it.
 */
export class TileMapEntity extends RasterEntity {

  /**
   * @param {AbstractEntity} parentEntity - The parent entity.
   * @param {number} x - X position relative to the parent.
   * @param {number} y - Y position relative to the parent.
   * @param {TileMapRender} render - The shared renderer built from the ROM graphics data.
   */
  constructor(parentEntity, x, y, render) {
    super(parentEntity, x, y, TileMapRender.WIDTH, TileMapRender.HEIGHT, false, false);
    this.id = 'TileMapEntity';

    this.render = render;
    this.frameState = null;
  } // constructor

  /**
   * Stores the video state of the newest frame and invalidates the cache.
   * @param {Object} state - {vram, attr, sprites, regs} as sent by the worker.
   */
  setFrame(state) {
    this.frameState = state;
    this.cleanCache();
  } // setFrame

  /**
   * Nothing is drawn before the first frame of the worker has arrived: without
   * it there is no video state to render, only an empty picture.
   */
  drawEntity() {
    if (this.frameState === null) {
      return;
    }
    super.drawEntity();
  } // drawEntity

  /**
   * Fills the frame; RasterEntity calls it only when the cache is dirty.
   * @param {Uint8ClampedArray} data - The RGBA bytes of the frame.
   */
  paintRaster(data) {
    this.renderInto(data);
  } // paintRaster

  /**
   * Renders this entity's part of the picture. Overridden by SpriteLayerEntity.
   * @param {Uint8ClampedArray} rgba - The target RGBA buffer.
   */
  renderInto(rgba) {
    this.render.renderLayers(this.frameState, rgba);
  } // renderInto

} // TileMapEntity
