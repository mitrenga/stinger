const { ArcadePlatform } = await import('./svision/js/platform/canvas2D/arcade/arcadePlatform.js?ver='+window.srcVersion);
// begin code

/**
 * Stinger: 224x256 portrait raster (hardware 256x224 rotated 90 degrees,
 * GAME-DESIGN chap. 2.3) — the same logical screen as Space Invaders. Black
 * bezel without a minimal border (chap. 4); no cellophane overlay, the colors
 * come from the PROM palette.
 */
export function appPlatform() {
  return new ArcadePlatform({
    width: 224,
    height: 256,
    bezelColor: '#000000',
    screenColor: '#000000',
    minimalBorder: 0,
    overlay: {enabled: false, bands: []}
  });
} // appPlatform
