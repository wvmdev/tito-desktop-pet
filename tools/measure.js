// Dev tool: measure apparent cat size per animation via iris (green) blob height.
// Prints JSON {anim: {eye, frames:[...]}} — eye = 75th-pct over frames of the largest iris bbox height (src px).
const { app, nativeImage } = require('electron');
const path = require('path');
const ROOT = path.join(__dirname, '..', 'assets', 'sprites');
const all = require('fs').readdirSync(ROOT).filter(d => !d.startsWith('.'));
function eyeHeights(file) {
  const img = nativeImage.createFromPath(file);
  const { width: w, height: h } = img.getSize();
  const px = img.toBitmap(); // BGRA
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const b = px[i * 4], g = px[i * 4 + 1], r = px[i * 4 + 2], a = px[i * 4 + 3];
    if (a > 200 && g > 60 && g > r + 18 && g > b + 12) mask[i] = 1;
  }
  const seen = new Uint8Array(w * h), blobs = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue;
    let minY = 1e9, maxY = -1, minX = 1e9, maxX = -1, n = 0; const st = [i]; seen[i] = 1;
    while (st.length) {
      const j = st.pop(), x = j % w, y = (j / w) | 0; n++;
      minY = Math.min(minY, y); maxY = Math.max(maxY, y); minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      for (const k of [j - 1, j + 1, j - w, j + w]) if (k >= 0 && k < w * h && mask[k] && !seen[k]) { seen[k] = 1; st.push(k); }
    }
    if (n > 10) blobs.push({ n, h: maxY - minY + 1, w: maxX - minX + 1 });
  }
  blobs.sort((a, b) => b.n - a.n);
  return blobs.length ? Math.max(blobs[0].h, blobs[0].w) : 0;
}
app.whenReady().then(() => {
  const res = {};
  for (const a of all) {
    const hs = [0,1,2,3,4,5,6,7].map(i => eyeHeights(path.join(ROOT, a, `${a}_${i}.png`)));
    const s = hs.filter(Boolean).sort((x, y) => x - y);
    res[a] = { eye: s.length ? s[Math.floor(s.length * 0.75)] : 0, frames: hs };
  }
  console.log(JSON.stringify(res));
  app.quit();
});
