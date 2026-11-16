// Tito's behaviour state machine (main process).
// Owns position + mode; tells the renderer which animation to play via `play`.
//
// Tito always stands on a *surface*: the desktop floor (bottom of the work area) or the top edge
// of an app window (from bin/tito-windows). Windows arrive front-to-back; a window's top edge is
// only standable where no window in front of it covers that point.
//
// Modes: walk | run | hop | stalk | climb | teleport | idle | react | menu | held | fall | land | sleep | wake
const { screen } = require('electron');
const EventEmitter = require('events');
const { PERSONALITIES, DEFAULT_PERSONALITY } = require('./personalities');

const FRAME_MS = 550;
const LOOP_MS = FRAME_MS * 8;

const WALK_SPEED = 70;   // px/s at walkSpeed 1 and size 1
const RUN_SPEED = 220;
const STALK_SPEED = 22;
const CLIMB_SPEED = 150;
const GRAVITY = 2600;    // px/s²
const MAX_FALL = 2200;
const EDGE_MARGIN = 60;  // window may overhang the screen edge (sprite is centred in it)
const LEDGE_INSET = 28;  // keep Tito's feet this far inside a window's top edge
const SNAP_UP = 40;      // dropped this close below a window top -> stand on it

// Animation playback rates chosen so feet roughly match ground speed.
const WALK_ANIM = 2.2;
const RUN_ANIM = 3.5;
const HOP_ANIM = 3;

// Animations the brain uses outside the personality idle pools.
const MOVE_ANIMS = [
  'caminando', 'corriendo', 'saltando', 'cazando', 'escalando', 'teletransportarse',
  'sorprendido', 'saludando', 'dando_amor', 'sentado', 'levantando_pata', 'panza_arriba',
  'resbalando', 'sacudiendose',
];

const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
function pickWeighted(entries) {
  let r = Math.random() * entries.reduce((s, [, w]) => s + w, 0);
  for (const [k, w] of entries) if ((r -= w) < 0) return k;
  return entries[0][0];
}

class Brain extends EventEmitter {
  constructor({ width, height, setPosition, play, personality = DEFAULT_PERSONALITY, size = 1 }) {
    super();
    this.W = width;
    this.H = height;
    this.size = size;
    this._setPos = setPosition;
    this._play = play;
    this.mode = 'init';
    this.facing = 'left';
    this.stayPose = null; // set = "Stay still" mode: loop this pose, no wandering
    this.mood = null;     // from mood-rules.computeMood: { bias, extras, energy, ... }
    this.x = 0;
    this.y = 0;
    this.surface = { kind: 'ground' }; // or { kind: 'window', id, lastX }
    this.windows = [];
    this._timer = null;
    this._tickFn = null;
    this._last = 0;
    this._menuClosedAt = 0;
    this.setPersonality(personality);
    this._loop = setInterval(() => this._tick(), 16);
  }

  setPersonality(id) {
    this.personalityId = PERSONALITIES[id] ? id : DEFAULT_PERSONALITY;
    this.p = PERSONALITIES[this.personalityId];
    if (this._autonomous()) this._after(600, () => this.next());
  }

  // Window grows/shrinks with the user's size setting; keep feet planted.
  setDims(W, H, size) {
    this.x += (this.W - W) / 2;
    this.y += this.H - H;
    this.W = W; this.H = H; this.size = size;
    this._commit();
  }

  _autonomous() { return ['idle', 'walk', 'run', 'hop', 'stalk'].includes(this.mode); }

  // ---------- geometry ----------
  footX() { return this.x + this.W / 2; }
  footY() { return this.y + this.H; }
  area() {
    return screen.getDisplayNearestPoint({ x: Math.round(this.footX()), y: Math.round(this.footY() - 10) }).workArea;
  }
  floorTop() { const a = this.area(); return a.y + a.height; }

  _win(id) { return this.windows.find(w => w.id === id); }
  _occluded(idx, px, py) {
    for (let i = 0; i < idx; i++) {
      const w = this.windows[i];
      if (px >= w.x && px < w.x + w.w && py >= w.y - 2 && py < w.y + w.h) return true;
    }
    return false;
  }
  // Is (px, window top) a standable spot on window `w`?
  _standable(w, px) {
    const idx = this.windows.indexOf(w);
    if (idx < 0) return false;
    if (px < w.x + LEDGE_INSET || px > w.x + w.w - LEDGE_INSET) return false;
    const a = screen.getDisplayNearestPoint({ x: Math.round(px), y: Math.round(w.y) }).workArea;
    if (w.y < a.y + this.H * 0.6 || w.y > a.y + a.height - 20) return false; // no headroom / below floor
    return !this._occluded(idx, px, w.y);
  }
  // Top of the surface Tito currently stands on.
  surfaceTop() {
    if (this.surface.kind === 'window') {
      const w = this._win(this.surface.id);
      if (w) return w.y;
    }
    return this.floorTop();
  }
  standY() { return this.surfaceTop() - this.H; }

  // Horizontal range for Tito's window x on the current surface.
  xBounds() {
    const a = this.area();
    let lo = a.x - EDGE_MARGIN;
    let hi = a.x + a.width - this.W + EDGE_MARGIN;
    if (this.surface.kind === 'window') {
      const w = this._win(this.surface.id);
      if (w) {
        lo = Math.max(lo, w.x + LEDGE_INSET - this.W / 2);
        hi = Math.min(hi, w.x + w.w - LEDGE_INSET - this.W / 2);
      }
    }
    return [lo, Math.max(lo, hi)];
  }
  _clampX() { const [lo, hi] = this.xBounds(); this.x = Math.min(hi, Math.max(lo, this.x)); }
  placeAt(x, y) { this.x = x; this.y = y; this._commit(); }

  // First surface hit when the feet move from y0 down to y1 at foot x px.
  _surfaceBetween(px, y0, y1) {
    let best = null;
    for (const w of this.windows) {
      if (w.y >= y0 && w.y <= y1 && this._standable(w, px) && (!best || w.y < best.top)) {
        best = { kind: 'window', id: w.id, top: w.y };
      }
    }
    if (best) return best;
    const floor = this.floorTop();
    if (floor <= y1) return { kind: 'ground', top: floor };
    return null;
  }

  // ---------- windows feed ----------
  setWindows(list) {
    this.windows = Array.isArray(list) ? list : [];
    if (this.surface.kind !== 'window' || !this._standsOnSurface()) return;
    const w = this._win(this.surface.id);
    const px = this.footX();
    if (!w || !this._standable(w, px)) { this._fall(); return; }
    // Ride along when the window is moved.
    const dx = w.x - (this.surface.lastX ?? w.x);
    this.surface.lastX = w.x;
    if (dx || Math.abs(this.y - (w.y - this.H)) > 0.5) {
      this.x += dx;
      this.y = w.y - this.H;
      this._commit();
    }
  }
  _standsOnSurface() { return !['held', 'fall', 'climb', 'teleport', 'init'].includes(this.mode); }
  _setSurface(s) {
    this.surface = s.kind === 'window' ? { kind: 'window', id: s.id, lastX: this._win(s.id)?.x } : { kind: 'ground' };
  }

  // ---------- plumbing ----------
  // `|| 0` also turns -0 into 0: Electron's setPosition rejects -0 (not an int32) and crashes.
  _commit() {
    if (!Number.isFinite(this.x) || !Number.isFinite(this.y)) {
      this.surface = { kind: 'ground' };
      this.x = this.area().x + 200; this.y = this.standY();
    }
    this._setPos(Math.round(this.x) || 0, Math.round(this.y) || 0);
  }
  _setMode(mode, info = {}) { this.mode = mode; this.emit('mode', mode, info); }
  _clear() { clearTimeout(this._timer); this._timer = null; this._tickFn = null; }
  _after(ms, fn) { clearTimeout(this._timer); this._timer = setTimeout(fn, ms); }
  _anim(name, speed = 1, extra = {}) {
    this.anim = name;
    this._play({ name, facing: this.facing, speed, ...extra });
  }
  _tick() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - (this._last || now)) / 1000);
    this._last = now;
    if (this._tickFn) this._tickFn(dt, now);
  }

  // ---------- autonomous loop ----------
  start() { this.y = this.standY(); this._commit(); this.idle({ forever: !!this.stayPose }); }

  next() {
    if (this.stayPose) return this.idle({ forever: true });
    if (this.mode !== 'idle') return this.idle(); // after any move, settle into an idle
    // Low-energy moods idle more and move less.
    const energy = this.mood ? this.mood.energy : 1;
    const chain = Math.min(0.9, Math.max(0, this.p.idleChain + (1 - energy) * 0.5));
    if (Math.random() < chain) return this.idle();
    const moves = Object.entries(this.p.moves).filter(([k, w]) => w > 0 && this._canDo(k));
    if (!moves.length) return this.idle();
    return this[pickWeighted(moves)]();
  }
  _canDo(kind) {
    if (kind === 'climb') return this.surface.kind === 'ground' && !!this._climbTarget();
    return true;
  }

  // Prefer to keep going the way he's facing; turn around only when there's little room ahead.
  _chooseDir(minRoom) {
    const [lo, hi] = this.xBounds();
    const ahead = this.facing === 'left' ? this.x - lo : hi - this.x;
    const behind = this.facing === 'left' ? hi - this.x : this.x - lo;
    const keep = ahead >= minRoom && (Math.random() < 0.75 || behind < minRoom);
    const dir = (this.facing === 'left') === keep ? -1 : 1;
    return { dir, room: Math.max(0, dir < 0 ? this.x - lo : hi - this.x) };
  }

  // Lost footing (walked off a ledge, window vanished/covered)?
  _lostFooting() {
    if (this.surface.kind !== 'window') return false;
    const w = this._win(this.surface.id);
    return !w || !this._standable(w, this.footX());
  }

  _travelTo(target, { mode, anim, animSpeed, speed, onArrive, info = {} }) {
    this._clear();
    const dir = Math.sign(target - this.x) || 1;
    this.facing = dir < 0 ? 'left' : 'right';
    this.y = this.standY();
    this._setMode(mode, { target: Math.round(target), dir, ...info });
    this._anim(anim, animSpeed);
    this._tickFn = dt => {
      const fx0 = this.footX();
      this.x += dir * speed * dt;
      const arrived = (target - this.x) * dir <= 0;
      if (arrived) this.x = target;
      const wall = this._wallCrossed(fx0, this.footX());
      if (wall) { this._hitWall(wall, dir, { mode, anim, animSpeed, speed }); return; }
      if (this._lostFooting()) { this._commit(); this._fall(); return; }
      this._commit();
      if (arrived) (onArrive || (() => this.next()))();
    };
  }

  _travel(mode, anim, animSpeed, speed, minDist, maxDist) {
    const s = this.size;
    const { dir, room } = this._chooseDir(minDist * s);
    let dist = Math.min(room, rand(minDist, maxDist) * s);
    // On a window ledge, sometimes walk right off the end and drop down.
    if (this.surface.kind === 'window' && room < maxDist * s && Math.random() < 0.3) dist = room + 60 * s;
    this._travelTo(this.x + dir * dist, { mode, anim, animSpeed, speed });
  }

  walk() {
    const s = this.p.walkSpeed;
    this._travel('walk', 'caminando', WALK_ANIM * s, WALK_SPEED * s * this.size, 120, 520);
  }

  run() { this._travel('run', 'corriendo', RUN_ANIM, RUN_SPEED * this.size, 250, 800); }

  // A few hops in a row: saltando frames 0 crouch, 1-3 airborne, 4 touch-down, 5-7 settle.
  hops(count = Math.round(rand(2, 4)), opts = {}) {
    this._clear();
    const s = this.size;
    const dist = (opts.dist || 75) * s;
    const height = (opts.height || 48) * s;
    const { dir } = this._chooseDir(dist * 1.5);
    this.facing = dir < 0 ? 'left' : 'right';
    this._setMode('hop', { count, dir });
    const frameMs = FRAME_MS / HOP_ANIM;
    let left = count;
    const hop = () => {
      const t0 = performance.now();
      const x0 = this.x;
      const g = this.standY();
      const last = left === 1;
      this._anim('saltando', HOP_ANIM);
      this._tickFn = (_dt, now) => {
        const f = (now - t0) / frameMs;
        const fx0 = this.footX();
        if (f >= 1 && f < 4) {
          const p = (f - 1) / 3;
          this.x = x0 + dir * dist * p;
          this.y = g - height * 4 * p * (1 - p);
        } else if (f >= 4) {
          this.x = x0 + dir * dist;
          this.y = g;
        }
        if (this.surface.kind === 'ground') this._clampX();
        const wall = this._wallCrossed(fx0, this.footX());
        if (wall) { this.y = g; this._hitWall(wall, dir); return; }
        if (f >= 4 && this._lostFooting()) { this._commit(); this._fall(); return; }
        this._commit();
        if (f >= (last ? 8 : 5)) {
          left--;
          if (left > 0) hop(); else this.next();
        }
      };
    };
    hop();
  }

  // Creep forward low (cazando), then pounce with one big hop.
  stalk() {
    this._clear();
    const { dir } = this._chooseDir(200 * this.size);
    this.facing = dir < 0 ? 'left' : 'right';
    this.y = this.standY();
    this._setMode('stalk', { dir });
    this._anim('cazando', 1.2);
    const until = performance.now() + (LOOP_MS / 1.2) * Math.round(rand(1, 2));
    this._tickFn = (dt, now) => {
      const fx0 = this.footX();
      this.x += dir * STALK_SPEED * this.size * dt;
      this._clampX();
      const wall = this._wallCrossed(fx0, this.footX());
      if (wall) { this._hitWall(wall, dir); return; }
      this._commit();
      if (now >= until) this.hops(1, { dist: 120, height: 70 });
    };
  }

  // ---------- windows in the way: climb them or turn back ----------
  // The side of a window counts as a wall when the window overlaps Tito's body height and that
  // part of its side isn't hidden behind another window. Returns the nearest side crossed while
  // the feet moved from fx0 to fx1.
  _wallCrossed(fx0, fx1) {
    if (fx0 === fx1) return null;
    const fy = this.footY();
    const bandTop = fy - 70 * this.size;
    const bandBot = fy - 6;
    let best = null;
    this.windows.forEach((w, i) => {
      if (this.surface.kind === 'window' && w.id === this.surface.id) return;
      if (w.y > bandBot || w.y + w.h < bandTop) return;
      const side = fx1 > fx0 ? 'left' : 'right'; // moving right meets a left side, and vice versa
      const sx = side === 'left' ? w.x : w.x + w.w;
      const crossed = fx1 > fx0 ? fx0 < sx && fx1 >= sx : fx0 > sx && fx1 <= sx;
      if (!crossed) return;
      const py = Math.min(w.y + w.h - 1, Math.max(w.y + 1, fy - 30 * this.size));
      if (this._occluded(i, side === 'left' ? sx + 1 : sx - 1, py)) return;
      if (!best || Math.abs(sx - fx0) < Math.abs(best.sx - fx0)) best = { w, side, sx };
    });
    return best;
  }

  // Bumped into a window: climb it (personality-dependent) or look up at it and go back.
  _hitWall(wall, dir, travel = null) {
    this._clear();
    this.x = wall.sx - dir * 16 * this.size - this.W / 2;
    this.y = this.standY();
    this._commit();
    const t = this._climbInfo(wall.w, wall.side);
    const c = this.p.moves.climb || 0;
    const climbChance = Math.min(0.8, Math.max(0.15, c / (c + 2)));
    this.emit('wall', { window: wall.w.id, climbable: !!t });
    if (t && this.surface.kind === 'ground' && Math.random() < climbChance) { this._climbUp(t); return; }
    this._setMode('idle', { name: 'mirando_arriba', wall: true });
    this.facing = dir < 0 ? 'left' : 'right';
    this._anim('mirando_arriba', 2);
    this._after(1100, () => {
      const back = -dir;
      const [lo, hi] = this.xBounds();
      const room = back < 0 ? this.x - lo : hi - this.x;
      const dist = Math.min(room, rand(150, 450) * this.size);
      const tr = travel && travel.mode !== 'walk' && travel.mode !== 'run' ? null : travel;
      const s = this.p.walkSpeed;
      this._travelTo(this.x + back * Math.max(dist, 20), tr || {
        mode: 'walk', anim: 'caminando', animSpeed: WALK_ANIM * s, speed: WALK_SPEED * s * this.size,
      });
    });
  }

  // Can Tito climb this side of window w and stand on top? Returns a climb target or null.
  _climbInfo(w, side) {
    const a = this.area();
    if (w.y < a.y + this.H || w.y > this.floorTop() - 120) return null; // too high / too low
    const sx = side === 'left' ? w.x : w.x + w.w;
    if (sx < a.x + 40 || sx > a.x + a.width - 40) return null;
    const landX = side === 'left' ? w.x + LEDGE_INSET + 20 : w.x + w.w - LEDGE_INSET - 20;
    if (!this._standable(w, landX)) return null;
    return { w, side, sx, landX };
  }

  // ---------- climbing a window's side (escalando) ----------
  _climbTarget() {
    const a = this.area();
    const fx = this.footX();
    const options = [];
    for (const w of this.windows) {
      if (w.y < a.y + this.H || w.y > this.floorTop() - 120) continue;  // too high / too low
      if (w.x + w.w < a.x || w.x > a.x + a.width) continue;
      for (const side of ['left', 'right']) {
        const t = this._climbInfo(w, side);
        if (t) options.push({ ...t, d: Math.abs(t.sx - fx) });
      }
    }
    options.sort((p, q) => p.d - q.d);
    return options[0] || null;
  }

  climb() {
    const t = this._climbTarget();
    if (!t) return this.idle();
    // Walk to just outside the window's side, then climb straight up it.
    const outside = t.side === 'left' ? -1 : 1;
    const startFoot = t.sx + outside * 18 * this.size;
    const s = this.p.walkSpeed;
    this._travelTo(startFoot - this.W / 2, {
      mode: 'walk', anim: 'caminando', animSpeed: WALK_ANIM * s, speed: WALK_SPEED * s * this.size,
      info: { toClimb: t.w.id },
      onArrive: () => this._climbUp(t),
    });
  }

  _climbUp(t) {
    this._clear();
    this._setMode('climb', { window: t.w.id, side: t.side });
    this.facing = t.side === 'left' ? 'right' : 'left';
    this._anim('escalando', 1.6);
    this._tickFn = dt => {
      const w = this._win(t.w.id);
      if (!w) { this._fall(); return; }
      this.y -= CLIMB_SPEED * this.size * dt;
      if (this.footY() <= w.y + 4) {
        // Pull up onto the top.
        this.x = (t.side === 'left' ? w.x + LEDGE_INSET + 20 : w.x + w.w - LEDGE_INSET - 20) - this.W / 2;
        this.y = w.y - this.H;
        this._setSurface({ kind: 'window', id: w.id });
        this._commit();
        this._land(false);
        return;
      }
      this._commit();
    };
  }

  // ---------- teleport (teletransportarse): vanish, reappear on another surface ----------
  teleport() {
    this._clear();
    this._setMode('teleport');
    const speed = 4; // ~1.1s to vanish, ~1.1s to reappear
    const ms = (8 * FRAME_MS) / speed;
    this._anim('teletransportarse', speed, { frames: [0, 1, 2, 3, 4, 5, 6, 7], loop: false });
    this._after(ms, () => {
      const a = this.area();
      const spots = [{ kind: 'ground' }];
      for (const w of this.windows) if (this._standable(w, w.x + w.w / 2)) spots.push({ kind: 'window', id: w.id });
      const spot = pick(spots);
      if (spot.kind === 'window') {
        const w = this._win(spot.id);
        this.x = rand(w.x + LEDGE_INSET, w.x + w.w - LEDGE_INSET) - this.W / 2;
      } else {
        this.x = rand(a.x, a.x + a.width - this.W);
      }
      this._setSurface(spot);
      this.y = this.standY();
      this._clampX();
      this._commit();
      this._anim('teletransportarse', speed, { frames: [7, 6, 5, 4, 3, 2, 1, 0], loop: false });
      this._after(ms, () => { this.mode = 'land'; this.next(); });
    });
  }

  idle({ forever = false } = {}) {
    this._clear();
    this.y = this.standY();
    this._commit();
    const name = forever ? (this.stayPose || 'sentado') : pickWeighted(this._idlePool());
    const [lo, hi] = this.p.idleLoops;
    const loops = Math.max(1, Math.round(rand(lo, hi)));
    const speed = this.p.animSpeed;
    this._setMode('idle', { name, loops });
    this._anim(name, speed);
    if (!forever) this._after((loops * LOOP_MS) / speed, () => this.next());
  }

  // Personality idle weights, re-weighted by the current mood. The mood's own animations are
  // mixed in at a low weight even if the personality doesn't normally use them.
  _idlePool() {
    const pool = new Map(this.p.idle);
    if (this.mood) {
      for (const a of this.mood.extras || []) if (!pool.has(a)) pool.set(a, 0.6);
      for (const [a, w] of pool) pool.set(a, w * (this.mood.bias[a] || 1));
    }
    return [...pool].filter(([, w]) => w > 0);
  }

  setMood(state) { this.mood = state; }

  // ---------- sleep (no user activity) ----------
  sleep() {
    if (!['idle', 'walk', 'run', 'hop', 'stalk', 'land'].includes(this.mode)) return false;
    this._clear();
    this.y = this.standY();
    this._commit();
    this._setMode('sleep');
    this._anim('durmiendo', 0.8);
    return true;
  }

  // Yawn, stretch, then carry on.
  wake() {
    if (this.mode !== 'sleep') return;
    this._clear();
    this._setMode('wake');
    const speed = 1.6;
    this._anim('bostezando', speed);
    this._after(LOOP_MS / speed, () => {
      this._anim('estirandose', speed);
      this._after(LOOP_MS / speed, () => { this.mode = 'idle'; this.next(); });
    });
  }

  // "Stay still": pose id to hold, or null to wander again.
  setStay(pose) {
    this.stayPose = pose || null;
    if (this._autonomous()) { this.mode = 'idle'; this.next(); }
  }

  // ---------- click: react once, then ask main to open the popup ----------
  click() { this._interact('openMenu', ['sorprendido', 'saludando', 'dando_amor']); }
  dblclick() { this._interact('openSize', ['saludando']); }

  _interact(event, reactions) {
    if (this.mode === 'menu') { this.emit('closeMenu'); return; }
    // The click that dismissed a popup (via blur) shouldn't immediately reopen it.
    if (performance.now() - this._menuClosedAt < 400) return;
    if (['held', 'fall', 'climb', 'teleport'].includes(this.mode)) return;
    this._clear();
    this.y = this.standY();
    this._commit();
    // Popup opens right away; the reaction plays underneath it, then he settles into a sit.
    this._setMode('menu');
    this.emit(event);
    const speed = 2.5;
    this._anim(pick(reactions), speed);
    this._after(LOOP_MS / speed, () => { if (this.mode === 'menu') this._anim('sentado'); });
  }

  menuClosed() {
    this._menuClosedAt = performance.now();
    if (this.mode !== 'menu' && this.mode !== 'react') return;
    this._clear();
    this._setMode('idle', { name: 'sentado', loops: 0 });
    this._after(800, () => this.next());
  }

  // ---------- drag: pick up, carry, drop, fall ----------
  dragStart() {
    if (this.mode === 'menu') this.emit('closeMenu');
    this._clear();
    this._setMode('held');
    this._anim(Math.random() < 0.35 ? 'panza_arriba' : 'levantando_pata');
  }

  dragMove(x, y) {
    if (this.mode !== 'held') return;
    this.x = x; this.y = y; this._commit();
  }

  dragEnd() {
    if (this.mode !== 'held') return;
    // Dropped just below a window's top edge? Put him on it rather than through it.
    const fx = this.footX(), fy = this.footY();
    for (const w of this.windows) {
      if (fy >= w.y && fy <= w.y + SNAP_UP * this.size && this._standable(w, fx)) {
        this._setSurface({ kind: 'window', id: w.id });
        this.y = w.y - this.H;
        this._commit();
        this._land(false);
        return;
      }
    }
    this._fall();
  }

  // Falls from the current position until the first surface below the feet.
  // The flailing pose (resbalando frames 2-4) starts on the very first frame of the fall.
  _fall() {
    this._clear();
    const a = this.area();
    this.x = Math.min(a.x + a.width - this.W + EDGE_MARGIN, Math.max(a.x - EDGE_MARGIN, this.x));
    const start = this.footY();
    const now = this._surfaceBetween(this.footX(), start - 2, start + 2);
    if (now) { this._setSurface(now); this.y = now.top - this.H; this._commit(); this._land(false); return; }
    this._setMode('fall');
    this._anim('resbalando', 2.4, { frames: [2, 3, 4], loop: true });
    let vy = 0;
    this._tickFn = dt => {
      const y0 = this.footY();
      vy = Math.min(vy + GRAVITY * dt, MAX_FALL);
      const y1 = y0 + vy * dt;
      const hit = this._surfaceBetween(this.footX(), y0, y1);
      if (hit) {
        this._setSurface(hit);
        this.y = hit.top - this.H;
        this._commit();
        this._land(this.footY() - start > 120);
        return;
      }
      this.y = y1 - this.H;
      this._commit();
    };
  }

  _land(hard) {
    this._clear();
    this._setMode('land', { hard, surface: this.surface.kind });
    if (hard) {
      // resbalando frames 5-7: the crash/stumble on impact.
      const speed = 2;
      this._anim('resbalando', speed, { frames: [5, 6, 7], loop: false });
      this._after((3 * FRAME_MS) / speed + 250, () => { this.mode = 'idle'; this.next(); });
    } else {
      const speed = 1.8;
      this._anim('sacudiendose', speed);
      this._after(LOOP_MS / speed, () => { this.mode = 'idle'; this.next(); });
    }
  }

  destroy() { this._clear(); clearInterval(this._loop); }
}

module.exports = { Brain, LOOP_MS, MOVE_ANIMS };
