// Pet window renderer: plays whatever the main-process brain asks for, and turns
// pointer input into click / double-click / drag. Transparent pixels click through.
const BASE_SCALE = 0.3; // screen px per source px for the reference animation (sentado) at size 1
const api = window.tito.pet;
const img = document.getElementById('tito');
let userSize = 1;

// Every animation is normalised to the same apparent cat size, times the user's size setting.
function applySize() {
  if (!img.naturalWidth || !player.name) return;
  const s = BASE_SCALE * TitoAnim.sizeFactor(player.name) * userSize;
  img.style.width = `${Math.round(img.naturalWidth * s)}px`;
  img.style.height = `${Math.round(img.naturalHeight * s)}px`;
}
img.addEventListener('load', applySize);

const player = new TitoAnim.SpritePlayer(img);
api.onPlay(({ name, facing, speed, frames, loop }) => {
  player.speed = speed || 1;
  player.play(name, { facing, frames, loop: loop !== false });
});
api.onSize(s => { userSize = s; applySize(); });
// Window clamped below the menu bar: draw Tito higher inside it so his feet stay where they belong.
const stage = document.getElementById('stage');
api.onLift(px => { stage.style.bottom = `${px}px`; stage.style.top = `${-px}px`; });

// ---------- pixel hit-testing (alpha masks, 1/4 resolution, cached per frame) ----------
const DS = 4;
const masks = new Map();
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

function maskFor(el) {
  const key = el.src;
  let m = masks.get(key);
  if (m) return m;
  const w = Math.ceil(el.naturalWidth / DS);
  const h = Math.ceil(el.naturalHeight / DS);
  canvas.width = w; canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(el, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const a = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = data[i * 4 + 3];
  m = { w, h, a };
  masks.set(key, m);
  return m;
}

// Forgiving hit test: anything within ~6 screen px of Tito's body counts, so thin parts
// (legs, tail, ears) and frame-to-frame wobble don't make clicks miss.
const HIT_SLOP = 6;
function hitTest(cx, cy) {
  if (!img.complete || !img.naturalWidth) return false;
  const r = img.getBoundingClientRect();
  if (cx < r.left - HIT_SLOP || cx >= r.right + HIT_SLOP || cy < r.top - HIT_SLOP || cy >= r.bottom + HIT_SLOP) return false;
  const m = maskFor(img);
  const flipped = img.style.transform.includes('-1');
  const rad = Math.max(1, Math.ceil(HIT_SLOP / (r.width / m.w)));
  let u = (cx - r.left) / r.width;
  if (flipped) u = 1 - u;
  const px = Math.floor(u * m.w);
  const py = Math.floor(((cy - r.top) / r.height) * m.h);
  for (let dy = -rad; dy <= rad; dy++) {
    for (let dx = -rad; dx <= rad; dx++) {
      const X = px + dx, Y = py + dy;
      if (X >= 0 && Y >= 0 && X < m.w && Y < m.h && m.a[Y * m.w + X] > 30) return true;
    }
  }
  return false;
}

// ---------- click-through toggling ----------
// Main polls the real cursor position and asks us whether it's over Tito's body.
// Always report: main de-duplicates and may have changed the state itself.
function setIgnore(v) { api.setIgnoreMouse(v); }
api.onHover(({ x, y }) => { if (!press) setIgnore(!hitTest(x, y)); });

// ---------- click / double-click / drag (any mouse button) ----------
const DRAG_THRESHOLD = 5;
const DBL_MS = 220; // short wait so a single click opens the popup almost instantly
let press = null; // { sx, sy, ox, oy, dragging }
let clickTimer = null;

window.addEventListener('contextmenu', e => e.preventDefault());

window.addEventListener('pointerdown', e => {
  // A new press while still "carrying" him means the earlier mouse-up was missed: put him down.
  if (press && press.dragging) { release(); return; }
  if (!hitTest(e.clientX, e.clientY)) return;
  e.preventDefault();
  document.documentElement.setPointerCapture(e.pointerId);
  press = { sx: e.screenX, sy: e.screenY, ox: e.clientX, oy: e.clientY, dragging: false };
});

window.addEventListener('pointermove', e => {
  if (!press) return;
  if (!press.dragging && Math.hypot(e.screenX - press.sx, e.screenY - press.sy) > DRAG_THRESHOLD) {
    press.dragging = true;
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    api.dragStart(press.ox, press.oy);
  }
  if (press.dragging) {
    api.dragMove(e.screenX, e.screenY);
    // Safety net for a missed mouse-up: let go after a long pause with no movement at all.
    // (Button state on move events isn't trustworthy here: the engine also sends synthetic
    // moves with no buttons whenever the sprite changes.)
    clearTimeout(dragWatchdog);
    dragWatchdog = setTimeout(() => release(), 8000);
  }
});

let dragWatchdog = null;
function release(e) {
  if (!press) return;
  // Losing pointer capture mid-drag (focus changes, window moving under the cursor) is not the
  // user letting go: keep carrying Tito until the real mouse-up arrives.
  if (e && e.type === 'lostpointercapture' && press.dragging) return;
  clearTimeout(dragWatchdog);
  const wasDrag = press.dragging;
  press = null;
  if (wasDrag) { api.dragEnd(); return; }
  // A single click waits briefly to see whether it becomes a double-click.
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
    api.dblclick();
  } else {
    clickTimer = setTimeout(() => { clickTimer = null; api.click(); }, DBL_MS);
  }
}
window.addEventListener('pointerup', release);
document.documentElement.addEventListener('lostpointercapture', release);

// Debug/smoke-test hooks.
window.titoPlayer = player;
window.titoHitTest = hitTest;

TitoAnim.preloadAll().then(() => api.ready());
