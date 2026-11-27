// Play-mode ball: grab it, move the cursor, let go to throw it. Main owns the physics.
const el = document.getElementById('ball');
const api = window.tito.ball;
let held = false;

el.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  held = true;
  el.setPointerCapture(e.pointerId);
  el.classList.add('held');
  api.grab(e.screenX, e.screenY);
});
el.addEventListener('pointermove', e => { if (held) api.move(e.screenX, e.screenY); });
function drop(e) {
  if (!held) return;
  held = false;
  el.classList.remove('held');
  try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  api.release();
}
el.addEventListener('pointerup', drop);
el.addEventListener('pointercancel', drop);

// Right click: the ball disappears (and play mode ends).
el.addEventListener('contextmenu', e => { e.preventDefault(); api.hide(); });
