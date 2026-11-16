// Dev tool: all animations at their current normalized scale on a ruler grid (20px lines).
// Usage: npx electron tools/qa.js <outdir> [frame-map.json]
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs');
const out = process.argv[2];
const frames = process.argv[3] ? fs.readFileSync(process.argv[3], 'utf8') : '{}';
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1250, height: 2 * 216, show: false });
  for (const page of process.env.QA_LIST ? [] : [0, 1, 2]) {
    await w.loadFile(path.join(__dirname, 'qa.html'), { query: { f: frames, p: String(page) } });
    await new Promise(r => setTimeout(r, 1200));
    fs.writeFileSync(path.join(out, `qa${page}.png`), (await w.webContents.capturePage()).toPNG());
  }
  if (process.env.QA_LIST) {
    await w.loadFile(path.join(__dirname, 'qa.html'), { query: { f: frames, list: process.env.QA_LIST } });
    await new Promise(r => setTimeout(r, 1200));
    fs.writeFileSync(path.join(out, 'qa-list.png'), (await w.webContents.capturePage()).toPNG());
  }
  app.quit();
});
