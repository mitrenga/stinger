const { GameApp } = await import('./gameApp.js?ver='+window.srcVersion);
const { appPlatform } = await import('./appPlatform.js?ver='+window.srcVersion);
const { bootstrapApp } = await import('./svision/js/appBootstrap.js?ver='+window.srcVersion);
// begin code

const gameApp = new GameApp(appPlatform(), window.importPath, window.wsURL, window.devModeName, window.appIconSprite);

bootstrapApp(gameApp);
