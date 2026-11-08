const { TileMapEntity } = await import('./tileMapEntity.js?ver='+window.srcVersion);
// begin code

/**
 * The 16 hardware sprites of Stinger (GAME-DESIGN chap. 2.3), drawn over
 * TileMapEntity in hardware order: set 1 (D840, gfx1 — ship, shot, enemies,
 * Bongo) first, then set 0 (E840, gfx2 — the ship explosion, second halves of
 * enemies, projectiles). An entry is {y, code, color & 7, x}; x == 0 or y == 0
 * hides it, sy = 240 - y, and the first three sprites of set 0 sit one line
 * higher — a hardware quirk ("like Galaxian") the original program does not
 * compensate for, so the remake must reproduce it.
 *
 * It shares TileMapEntity's cache mechanics and the shared TileMapRender; only
 * the render pass differs, and its buffer keeps alpha 0 wherever no sprite
 * pixel was drawn, so the tile layers show through.
 */
export class SpriteLayerEntity extends TileMapEntity {

  constructor(parentEntity, x, y, render) {
    super(parentEntity, x, y, render);
    this.id = 'SpriteLayerEntity';
  } // constructor

  renderInto(rgba) {
    this.render.renderSprites(this.frameState, rgba);
  } // renderInto

} // SpriteLayerEntity
