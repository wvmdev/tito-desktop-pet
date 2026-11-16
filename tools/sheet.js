// Dev tool: render contact sheets of all animation frames. Usage: npx electron tools/sheet.js <outdir>
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs');
const out = process.argv.at(-1);
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1135, height: 6 * 119, show: false });
  for (let p = 0; p < 6; p++) {
    await w.loadFile(path.join(__dirname, 'sheet.html'), { query: { p: String(p) } });
    await new Promise(r => setTimeout(r, 600));
    fs.writeFileSync(path.join(out, `sheet${p}.png`), (await w.webContents.capturePage()).toPNG());
  }
  app.quit();
});
