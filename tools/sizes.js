// Dev tool: all animations' frame N at one uniform scale, to compare apparent cat size.
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs');
const out = process.argv.at(-1);
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1350, height: 4 * 172, show: false, enableLargerThanScreen: true });
  await w.loadFile(path.join(__dirname, 'sizes.html'), { query: { f: '0' } });
  await new Promise(r => setTimeout(r, 1000));
  fs.writeFileSync(path.join(out, 'sizes.png'), (await w.webContents.capturePage()).toPNG());
  app.quit();
});
