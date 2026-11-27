// The play-mode ball: pure physics (no Electron), so it can be tested without a window.
//
// The ball lives in the same world as Tito. It never leaves the screen and never falls through:
// it rests on the floor or on the *visible* top edge of any app window (the same rule Tito uses),
// rolls to a stop, follows its window when that is moved, and drops again when the window goes away
// or its resting spot gets covered. `world` supplies the surfaces:
//   world.ballSurface(px, y0, y1) -> { id: 'ground' | windowId, top } | null   first surface the ball centre-line meets
//   world.windowById(id)          -> { x, y, w, h } | null
//   world.area(px, py)            -> work area { x, y, width, height } of the display there
const EventEmitter = require('events');

const RADIUS = 14;
const GRAVITY = 2400;      // px/s²
const MAX_SPEED = 3400;    // px/s, a hard flick
const BOUNCE = 0.5;        // keeps this much speed bouncing off the floor / a window top
const WALL_BOUNCE = 0.55;
const ROLL_FRICTION = 2.6; // 1/s: how fast a rolling ball slows down
const REST_SPEED = 90;     // a bounce slower than this just settles
const STOP_SPEED = 10;     // a roll slower than this stops

// Advance one plain state object by dt. Used for the real ball and for predicting where a throw ends.
function step(s, dt, world, r = RADIUS) {
  const a = world.area(s.x, s.y);
  if (s.surface) {
    // Resting or rolling on a surface.
    let top;
    if (s.surface === 'ground') top = a.y + a.height;
    else {
      const w = world.windowById(s.surface);
      if (!w) { s.surface = null; s.rest = false; return; }
      if (s.winX != null) s.x += w.x - s.winX; // ride along when the window is moved
      s.winX = w.x;
      top = w.y;
    }
    s.vx *= Math.max(0, 1 - ROLL_FRICTION * dt);
    if (Math.abs(s.vx) < STOP_SPEED) s.vx = 0;
    s.x += s.vx * dt;
    if (s.x < a.x + r) { s.x = a.x + r; s.vx = -s.vx * WALL_BOUNCE; }
    if (s.x > a.x + a.width - r) { s.x = a.x + a.width - r; s.vx = -s.vx * WALL_BOUNCE; }
    s.y = top - r;
    // Still something to stand on under the centre? (rolled off the end, or got covered)
    const under = world.ballSurface(s.x, top - 3, top + 3);
    if (!under || under.id !== s.surface) { s.surface = null; s.winX = null; s.vy = 0; }
    s.rest = !!s.surface && s.vx === 0;
    return;
  }
  s.rest = false;
  s.vy = Math.min(s.vy + GRAVITY * dt, MAX_SPEED);
  const x1 = s.x + s.vx * dt;
  const y0 = s.y + r, y1 = s.y + s.vy * dt + r; // the ball's bottom
  s.x = x1;
  if (s.x < a.x + r) { s.x = a.x + r; s.vx = Math.abs(s.vx) * WALL_BOUNCE; }
  if (s.x > a.x + a.width - r) { s.x = a.x + a.width - r; s.vx = -Math.abs(s.vx) * WALL_BOUNCE; }
  if (s.y < a.y + r && s.vy < 0) { s.y = a.y + r; s.vy = Math.abs(s.vy) * 0.4; return; } // the ceiling
  const hit = s.vy > 0 ? world.ballSurface(s.x, y0, y1) : null;
  if (hit) {
    s.y = hit.top - r;
    if (s.vy > REST_SPEED * 3) { s.vy = -s.vy * BOUNCE; return; } // a real bounce
    s.vy = 0;
    s.surface = hit.id;
    s.winX = hit.id === 'ground' ? null : world.windowById(hit.id)?.x ?? null;
    return;
  }
  s.y += s.vy * dt;
}

class Ball extends EventEmitter {
  constructor(world) {
    super();
    this.world = world;
    this.r = RADIUS;
    this.visible = false;
    this.held = false;
    this.s = { x: 0, y: 0, vx: 0, vy: 0, surface: null, winX: null, rest: false };
    this._samples = [];
    this._landing = null;
    this._landingAt = 0;
    this.throws = 0; // counts releases by the user, so Tito knows a new throw happened
  }

  get x() { return this.s.x; }
  get y() { return this.s.y; }

  show(x, y, vx = 0, vy = 0) {
    this.visible = true;
    this.held = false;
    Object.assign(this.s, { x, y, vx, vy, surface: null, winX: null, rest: false });
    this._landing = null;
    this._clampIn();
  }
  hide() { this.visible = false; this.held = false; this._landing = null; }

  _clampIn() {
    const a = this.world.area(this.s.x, this.s.y);
    this.s.x = Math.min(a.x + a.width - this.r, Math.max(a.x + this.r, this.s.x));
    this.s.y = Math.min(a.y + a.height - this.r, Math.max(a.y + this.r, this.s.y));
  }

  // ---------- the user's hand ----------
  grab(x, y, now = performance.now()) {
    if (!this.visible) return;
    this.held = true;
    this._landing = null;
    Object.assign(this.s, { surface: null, winX: null, rest: false, vx: 0, vy: 0 });
    this._samples = [];
    this._grabAt = { x, y, t: now };
    this.dragTo(x, y, now);
  }
  dragTo(x, y, now = performance.now()) {
    if (!this.held) return;
    this.s.x = x; this.s.y = y;
    this._clampIn();
    this._samples.push({ t: now, x: this.s.x, y: this.s.y });
    while (this._samples.length > 2 && now - this._samples[0].t > 120) this._samples.shift();
  }
  // Let go: the ball keeps the speed the hand had over the last ~100 ms.
  release(now = performance.now()) {
    if (!this.held) return false;
    // A click (hardly any movement, quickly let go): the ball stays in place for a moment so the caller
    // can tell a single click (shoot()) from a double click; nothing is thrown yet.
    const g = this._grabAt;
    if (g && Math.hypot(this.s.x - g.x, this.s.y - g.y) < 6 && now - g.t < 350) { this._samples = []; return 'click'; }
    this.held = false;
    const recent = this._samples.filter(p => now - p.t <= 110);
    let vx = 0, vy = 0;
    if (recent.length >= 2) {
      const f = recent[0], l = recent[recent.length - 1];
      const dt = Math.max(0.016, (l.t - f.t) / 1000);
      vx = (l.x - f.x) / dt; vy = (l.y - f.y) / dt;
    }
    const sp = Math.hypot(vx, vy);
    if (sp > MAX_SPEED) { vx *= MAX_SPEED / sp; vy *= MAX_SPEED / sp; }
    Object.assign(this.s, { vx, vy });
    this._samples = [];
    this.throws++;
    this._landing = null;
    this.emit('thrown');
    return 'throw';
  }

  // Shoot it off in a random direction (upwards, anywhere from left to right).
  shoot() {
    if (!this.visible) return;
    this.held = false;
    const ang = (-170 + Math.random() * 160) * Math.PI / 180;
    const sp = 1100 + Math.random() * 1500;
    Object.assign(this.s, { vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, surface: null, winX: null, rest: false });
    this.throws++;
    this._landing = null;
    this.emit('thrown');
  }

  // ---------- simulation ----------
  tick(dt) {
    if (!this.visible || this.held) return;
    step(this.s, Math.min(dt, 0.033), this.world, this.r);
  }

  // Where the ball will come to rest if nothing changes: { surface, x } (or null if it never does).
  predict() {
    if (this.s.surface) return { surface: this.s.surface, x: this.s.x };
    const c = { ...this.s };
    for (let i = 0; i < 420; i++) {
      step(c, 1 / 60, this.world, this.r);
      if (c.surface) return { surface: c.surface, x: c.x };
    }
    return null;
  }

  // What Tito sees. `landing` is cached for a moment so it isn't recomputed every frame.
  getState(now = performance.now()) {
    if (!this.visible) return null;
    const airborne = !this.s.surface;
    if (airborne && !this.held && (!this._landing || now - this._landingAt > 200)) {
      this._landing = this.predict();
      this._landingAt = now;
    }
    return {
      x: this.s.x, y: this.s.y, vx: this.s.vx, vy: this.s.vy, r: this.r,
      held: this.held, airborne,
      surface: this.s.surface,
      landing: airborne ? this._landing : { surface: this.s.surface, x: this.s.x },
    };
  }
}

module.exports = { Ball, step, RADIUS, GRAVITY, MAX_SPEED };
