// Dev tool: size of the collar+heart-tag component per frame (a rigid object on the cat, so a pose-independent ruler).
const { app, nativeImage } = require('electron');
const fs = require('fs'), path = require('path');
const SPRITES = path.join(__dirname, '..', 'assets', 'sprites');
function collar(file) {
  const img = nativeImage.createFromPath(file);
  const { width: w, height: h } = img.getSize();
  const px = img.toBitmap();
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const B = px[i * 4], G = px[i * 4 + 1], R = px[i * 4 + 2], A = px[i * 4 + 3];
    // dark, slightly purple: the collar and heart tag
    if (A > 200 && R >= 56 && R <= 112 && G >= 36 && G <= 80 && B >= 52 && B <= 104 && R >= G + 8 && B >= G + 8) m[i] = 1;
  }
  const seen = new Uint8Array(w * h); let best = 0;
  for (let i = 0; i < w * h; i++) {
    if (!m[i] || seen[i]) continue;
    let n = 0; const st = [i]; seen[i] = 1;
    while (st.length) { const j = st.pop(), x = j % w; n++;
      for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w]) if (k >= 0 && k < w * h && m[k] && !seen[k]) { seen[k] = 1; st.push(k); } }
    if (n > best) best = n;
  }
  return Math.round(Math.sqrt(best));
}
app.whenReady().then(() => {
  const res = {};
  for (const a of fs.readdirSync(SPRITES).filter(d => !d.startsWith('.')).sort())
    res[a] = [0, 1, 2, 3, 4, 5, 6, 7].map(i => collar(path.join(SPRITES, a, `${a}_${i}.png`)));
  console.log('COLLAR ' + JSON.stringify(res));
  app.quit();
});
