// Dev recorder (TITO_RECORD=<dir>): captures Tito's rendered window + screen position over time,
// then composites a filmstrip of the bottom of the screen so motion/facing can be reviewed.
// Env: TITO_RECORD_SECS (default 30), TITO_RECORD_SCRIPT e.g. "walk,hops,run,stalk" (forced moves
// one after another, each ~5s), TITO_RECORD_PERSONALITY.
const fs = require('fs');
const path = require('path');
const { BrowserWindow, screen } = require('electron');

const wait = ms => new Promise(r => setTimeout(r, ms));
const FPS = 6;
const COLS = 3;
const ROWS = 5;
const SCALE = 0.25;
const STRIP_H = null; // null = whole work area

async function run({ app, petWin, brain }) {
  const out = process.env.TITO_RECORD;
  const secs = +process.env.TITO_RECORD_SECS || 30;
  const script = (process.env.TITO_RECORD_SCRIPT || '').split(',').filter(Boolean);
  if (process.env.TITO_RECORD_PERSONALITY) brain.setPersonality(process.env.TITO_RECORD_PERSONALITY);
  const fakeWindows = process.env.TITO_FAKE_WINDOWS ? JSON.parse(process.env.TITO_FAKE_WINDOWS) : null;
  if (fakeWindows) { brain.setWindows(fakeWindows); setInterval(() => brain.setWindows(fakeWindows), 250); }
  const wc = petWin.webContents;
  fs.mkdirSync(path.join(out, 'f'), { recursive: true });
  await new Promise(r => wc.once('did-finish-load', r));
  await wait(1500);

  // Forced moves, ~5s apart, each starting from a settled idle.
  // A script entry is a brain method name, or "drop" (pick him up high above the middle and let go).
  const stepMs = +process.env.TITO_RECORD_STEP_MS || 5000;
  script.forEach((move, i) => setTimeout(() => {
    if (move === 'drop') {
      const a = brain.area();
      brain.dragStart();
      brain.dragMove(a.x + a.width * 0.12 - brain.W / 2, a.y + 10);
      setTimeout(() => brain.dragEnd(), 400);
    } else { brain.mode = 'idle'; brain[move](); }
  }, i * stepMs));

  const frames = [];
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < secs * 1000) {
    const ts = Date.now();
    const b = petWin.getBounds();
    const img = await wc.capturePage();
    const [anim, frame, facing, transform] = await wc.executeJavaScript(
      '[titoPlayer.name, titoPlayer.frame, titoPlayer.facing, document.getElementById("tito").style.transform]');
    const file = `f/${String(n++).padStart(4, '0')}.png`;
    fs.writeFileSync(path.join(out, file), img.toPNG());
    frames.push({ t: ts - t0, x: b.x, y: b.y, w: b.width, h: b.height, mode: brain.mode, anim, frame, facing, flipped: transform.includes('-1'), file });
    await wait(Math.max(0, 1000 / FPS - (Date.now() - ts)));
  }

  const wa = screen.getPrimaryDisplay().workArea;
  const meta = { frames, wa, STRIP_H: STRIP_H || wa.height, SCALE, COLS, ROWS, windows: fakeWindows || [] };
  fs.writeFileSync(path.join(out, 'frames.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(out, 'sheet.html'), SHEET_HTML);

  // Composite sheets.
  const tileW = Math.round(wa.width * SCALE);
  const tileH = Math.round((STRIP_H || wa.height) * SCALE) + 18;
  const win = new BrowserWindow({ width: tileW * COLS, height: tileH * ROWS, show: false, enableLargerThanScreen: true });
  const perSheet = COLS * ROWS;
  const sheets = Math.ceil(frames.length / perSheet);
  for (let s = 0; s < sheets; s++) {
    await win.loadFile(path.join(out, 'sheet.html'), { query: { s: String(s) } });
    await win.webContents.executeJavaScript('window.done');
    await wait(400); // let the compositor present the finished canvas
    fs.writeFileSync(path.join(out, `sheet_${String(s).padStart(2, '0')}.png`), (await win.webContents.capturePage()).toPNG());
  }
  console.log(`RECORDED ${frames.length} frames -> ${sheets} sheets in ${out}`);
  app.exit(0);
}

const SHEET_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#222;font:11px -apple-system;color:#fff}
canvas{display:block}</style></head><body><canvas id=c></canvas><script>
window.done = (async () => {
  const meta = await (await fetch('frames.json')).json();
  const { frames, wa, STRIP_H, SCALE, COLS, ROWS, windows } = meta;
  const s = +new URLSearchParams(location.search).get('s');
  const tw = Math.round(wa.width * SCALE), th = Math.round(STRIP_H * SCALE) + 18;
  const c = document.getElementById('c'); c.width = tw * COLS; c.height = th * ROWS;
  const g = c.getContext('2d');
  const top = wa.y + wa.height - STRIP_H;
  const load = src => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = src; });
  const per = COLS * ROWS;
  const imgs = await Promise.all(frames.slice(s * per, s * per + per).map(f => load(f.file)));
  for (let k = 0; k < per; k++) {
    const idx = s * per + k; const f = frames[idx]; if (!f) break;
    const ox = (k % COLS) * tw, oy = Math.floor(k / COLS) * th;
    g.save(); g.beginPath(); g.rect(ox, oy, tw, th); g.clip();
    g.fillStyle = '#9db0c4'; g.fillRect(ox, oy + 18, tw, th - 18);
    g.fillStyle = '#5a6b7d'; g.fillRect(ox, oy + th - 3, tw, 3); // ground line (work-area bottom)
    for (const w of [...windows].reverse()) { // stand-in app windows (list is front-to-back, so draw back first)
      const wx = ox + (w.x - wa.x) * SCALE, wy = oy + 18 + (w.y - top) * SCALE;
      g.fillStyle = '#f4f5f7'; g.fillRect(wx, wy, w.w * SCALE, w.h * SCALE);
      g.fillStyle = '#d5d9df'; g.fillRect(wx, wy, w.w * SCALE, 7);
      g.strokeStyle = '#7b8794'; g.strokeRect(wx + .5, wy + .5, w.w * SCALE - 1, w.h * SCALE - 1);
    }
    // trail of previous positions (sprite foot point)
    for (let j = Math.max(0, idx - 12); j < idx; j++) {
      const p = frames[j]; g.fillStyle = 'rgba(200,30,30,' + (0.15 + 0.06 * (j - idx + 12)) + ')';
      g.fillRect(ox + (p.x + p.w / 2 - wa.x) * SCALE - 2, oy + 18 + (p.y + p.h - top) * SCALE - 4, 4, 4);
    }
    const img = imgs[k];
    g.drawImage(img, ox + (f.x - wa.x) * SCALE, oy + 18 + (f.y - top) * SCALE, f.w * SCALE, f.h * SCALE);
    const prev = frames[idx - 1];
    const vx = prev ? (f.x - prev.x) : 0;
    g.fillStyle = '#111'; g.fillRect(ox, oy, tw, 18);
    g.fillStyle = '#fff';
    const arrow = vx < -1 ? '\\u2190 moving' : vx > 1 ? 'moving \\u2192' : 'still';
    g.fillText('#' + idx + ' t=' + (f.t / 1000).toFixed(1) + 's ' + f.mode + ' | ' + f.anim + '[' + f.frame + '] face=' + f.facing + ' | ' + arrow, ox + 4, oy + 13);
    g.restore();
    g.strokeStyle = '#000'; g.strokeRect(ox + .5, oy + .5, tw - 1, th - 1);
  }
  return true;
})();
</script></body></html>`;

module.exports = { run };
