// Dev tool: robust per-frame iris size (equivalent diameter of the largest round green blob),
// printed per animation. Usage: npx electron tools/eyes2.js
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const SPRITES = path.join(__dirname, '..', 'assets', 'sprites');

function irisDiameters(file) {
  const img = nativeImage.createFromPath(file);
  const { width: w, height: h } = img.getSize();
  const px = img.toBitmap();
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const b = px[i * 4], g = px[i * 4 + 1], r = px[i * 4 + 2], a = px[i * 4 + 3];
    if (a > 200 && g > 55 && g > r + 12 && g > b + 6) mask[i] = 1;
  }
  const seen = new Uint8Array(w * h), out = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue;
    let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, n = 0; const st = [i]; seen[i] = 1;
    while (st.length) {
      const j = st.pop(), x = j % w, y = (j / w) | 0; n++;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (const k of [j - 1, j + 1, j - w, j + w]) if (k >= 0 && k < w * h && mask[k] && !seen[k]) { seen[k] = 1; st.push(k); }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const fill = n / (bw * bh);               // a filled circle is ~0.78
    const round = Math.min(bw, bh) / Math.max(bw, bh);
    if (n >= 40 && fill > 0.45 && round > 0.55) out.push(Math.round(2 * Math.sqrt(n / Math.PI)));
  }
  return out.sort((a, b) => b - a);
}

app.whenReady().then(() => {
  const res = {};
  for (const a of fs.readdirSync(SPRITES).filter(d => !d.startsWith('.')).sort()) {
    res[a] = [0, 1, 2, 3, 4, 5, 6, 7].map(i => (irisDiameters(path.join(SPRITES, a, `${a}_${i}.png`))[0] || 0));
  }
  console.log('EYES2 ' + JSON.stringify(res));
  app.quit();
});
