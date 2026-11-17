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
const { PERSONALITIES, DEFAULT_PERSONALITY, resolvePersonality } = require('./personalities');
const SPRITE = require('./sprite-metrics');
const { mouseChance, cursorReaction } = require('./companion-rules'); // visible extent of every animation (tools/metrics.js)

const FRAME_MS = 550;
const LOOP_MS = FRAME_MS * 8;

const WALK_SPEED = 70;   // px/s at walkSpeed 1 and size 1
const RUN_SPEED = 220;
const STALK_SPEED = 22;
const CLIMB_SPEED = 150;
const GRAVITY = 2600;    // px/s²
const MAX_FALL = 2200;
const LEDGE_INSET = 28;  // keep Tito's feet this far inside a window's top edge
const SNAP_UP = 40;      // dropped this close below a window top -> stand on it
const HEADROOM = 118;    // px above a window top needed for Tito's body (walking height is ~116 at size 1)
const EDGE_PAD = 12;     // keep this far from a window that covers part of an edge
const MIN_SEGMENT = 40;  // a visible stretch of edge must be at least this wide (px at size 1)
const CLIMB_AT_WALL = 0.5; // meeting a climbable window while on the move: climb it half the time
const MOUSE_CHANCE = 0.2; // 1 in 5 walks/runs head for the mouse pointer (unless an app is full screen)

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
  constructor({ width, height, setPosition, play, getCursor = null, personality = DEFAULT_PERSONALITY, getCustoms = () => [], size = 1 }) {
    super();
    this.W = width;
    this.H = height;
    this.size = size;
    this._setPos = setPosition;
    this.getCursor = getCursor; // () => { x, y } screen point of the mouse pointer
    this.getCustoms = getCustoms; // () => the user's custom personalities
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
    this.bond = 0;              // 0..100, from the companion rules (set by main)
    this.reactionsOn = true;    // play with the cursor, dance to music
    this.music = false;
    this._cp = { at: 0, prev: null, shyAt: 0, playAt: 0 };
    this.setPersonality(personality);
    this._loop = setInterval(() => this._tick(), 16);
  }

  setPersonality(id) {
    const p = resolvePersonality(id, this.getCustoms());
    this.personalityId = p ? id : DEFAULT_PERSONALITY;
    this.p = p || PERSONALITIES[DEFAULT_PERSONALITY];
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
  // Windows are listed front to back. A point of window `idx` is visible only if no window in front of
  // it (index < idx) covers it: hidden parts of a window don't count for anything.
  _occluded(idx, px, py) {
    for (let i = 0; i < idx; i++) {
      const w = this.windows[i];
      if (px >= w.x && px < w.x + w.w && py >= w.y - 2 && py < w.y + w.h) return true;
    }
    return false;
  }

  // The stretches of window `w`'s top edge that are actually visible (not covered by a window in
  // front), as [x0, x1] screen intervals inset from the corners and from the covering windows. Any
  // window counts wherever it sits in the stack; only what you can see counts.
  _edgeSegments(w) {
    const idx = this.windows.indexOf(w);
    if (idx < 0) return [];
    const a = this.area();
    let segs = [[Math.max(w.x + LEDGE_INSET, a.x), Math.min(w.x + w.w - LEDGE_INSET, a.x + a.width)]];
    for (let i = 0; i < idx; i++) {
      const o = this.windows[i];
      if (!(o.y <= w.y + 1 && o.y + o.h > w.y + 1)) continue; // doesn't reach this edge's height
      const c0 = o.x - EDGE_PAD, c1 = o.x + o.w + EDGE_PAD;
      segs = segs.flatMap(([s0, s1]) => (c1 <= s0 || c0 >= s1 ? [[s0, s1]] : [[s0, Math.min(s1, c0)], [Math.max(s0, c1), s1]]));
    }
    return segs.filter(([x0, x1]) => x1 - x0 >= MIN_SEGMENT * this.size);
  }

  // Enough room above a window top for his body, and not below the floor?
  _edgeHeightOk(w, px) {
    const a = screen.getDisplayNearestPoint({ x: Math.round(px), y: Math.round(w.y) }).workArea;
    return !(w.y < a.y + HEADROOM * this.size || w.y > a.y + a.height - 20);
  }

  // Is (px, window top) a standable spot on window `w`: visible, with headroom?
  _standable(w, px) {
    if (this.windows.indexOf(w) < 0 || !this._edgeHeightOk(w, px)) return false;
    return this._edgeSegments(w).some(([x0, x1]) => px >= x0 && px <= x1);
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

  // Half the visible width of an animation, in px at the current size: how far Tito's visible
  // pixels reach from the window centre. The whole sprite must stay on screen, so this (not the
  // window) decides how close to the screen edge he can get.
  _halfW(anim = this.anim) { const m = SPRITE[anim]; return ((m && m.half) || 100) * this.size; }

  // Horizontal range for Tito's window x: whole sprite on the display, and on a window's top
  // edge while he stands on a window.
  xBounds(anim = this.anim) {
    const a = this.area();
    const h = this._halfW(anim);
    let lo = a.x + h - this.W / 2;
    let hi = a.x + a.width - h - this.W / 2;
    if (this.surface.kind === 'window' && this._standsOnSurface()) {
      const w = this._win(this.surface.id);
      if (w) {
        // Stay on the visible stretch of the edge he is standing on.
        const fx = this.footX();
        const segs = this._edgeSegments(w);
        let seg = segs.find(([x0, x1]) => fx >= x0 - 1 && fx <= x1 + 1);
        if (!seg && segs.length) seg = segs.reduce((b, c) => (Math.abs((c[0] + c[1]) / 2 - fx) < Math.abs((b[0] + b[1]) / 2 - fx) ? c : b));
        if (seg) { lo = Math.max(lo, seg[0] - this.W / 2); hi = Math.min(hi, seg[1] - this.W / 2); }
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
    this._clampX(); // never let any part of him leave the screen
    this._setPos(Math.round(this.x) || 0, Math.round(this.y) || 0);
  }
  _setMode(mode, info = {}) { this.mode = mode; this.emit('mode', mode, info); }
  _clear() { clearTimeout(this._timer); this._timer = null; this._tickFn = null; }
  _after(ms, fn) { clearTimeout(this._timer); this._timer = setTimeout(fn, ms); }
  _anim(name, speed = 1, extra = {}) {
    this.anim = name;
    if (this.mode !== 'init') { this._clampX(); this._commit(); } // a wider pose may need a nudge inwards
    this._play({ name, facing: this.facing, speed, ...extra });
  }
  _tick() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - (this._last || now)) / 1000);
    this._last = now;
    if (this._tickFn) this._tickFn(dt, now);
    this._cursorPlay(now);
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
  _chooseDir(minRoom, anim = this.anim) {
    const [lo, hi] = this.xBounds(anim);
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

  _travelTo(target, { mode, anim, animSpeed, speed, onArrive, info = {}, ignoreWindow = null }) {
    this._clear();
    { const [lo, hi] = this.xBounds(anim); target = Math.min(hi, Math.max(lo, target)); } // stay on screen in the walking pose
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
      const wall = this._wallCrossed(fx0, this.footX(), ignoreWindow);
      if (wall) { this._hitWall(wall, dir, { mode, anim, animSpeed, speed }); return; }
      if (this._lostFooting()) { this._commit(); this._fall(); return; }
      this._commit();
      if (arrived) (onArrive || (() => this.next()))();
    };
  }

  _travel(mode, anim, animSpeed, speed, minDist, maxDist, onArrive = null) {
    const s = this.size;
    const { dir, room } = this._chooseDir(minDist * s, anim);
    let dist = Math.min(room, rand(minDist, maxDist) * s);
    // On a window ledge, sometimes walk right off the end and drop down.
    if (this.surface.kind === 'window' && room < maxDist * s && Math.random() < 0.3) dist = room + 60 * s;
    this._travelTo(this.x + dir * dist, { mode, anim, animSpeed, speed });
  }

  walk() {
    const s = this.p.walkSpeed;
    const spec = { mode: 'walk', anim: 'caminando', animSpeed: WALK_ANIM * s, speed: WALK_SPEED * s * this.size };
    if (this._goToMouse(spec)) return;
    this._travel('walk', 'caminando', spec.animSpeed, spec.speed, 120, 520);
  }

  run() {
    const spec = { mode: 'run', anim: 'corriendo', animSpeed: RUN_ANIM, speed: RUN_SPEED * this.size };
    if (this._goToMouse(spec)) return;
    this._travel('run', 'corriendo', spec.animSpeed, spec.speed, 250, 800);
  }

  // Is any app covering the whole display (full-screen app or video)?
  fullscreenHere() {
    const d = screen.getDisplayNearestPoint({ x: Math.round(this.footX()), y: Math.round(this.footY() - 10) }).bounds;
    return this.windows.some(w => w.x <= d.x + 2 && w.y <= d.y + 2 && w.w >= d.width - 4 && w.h >= d.height - 4);
  }

  // One walk/run in five heads for the mouse pointer, stopping beside it. Never while an app is
  // full screen, never when the pointer is already close or on another display.
  _goToMouse(spec) {
    if (!this.getCursor || Math.random() >= mouseChance(this.bond, MOUSE_CHANCE)) return false;
    if (this.fullscreenHere()) return false;
    const c = this.getCursor();
    const a = this.area();
    if (!c || c.x < a.x || c.x > a.x + a.width) return false;
    const fx = this.footX();
    if (Math.abs(c.x - fx) < 140 * this.size) return false;
    const dir = c.x > fx ? 1 : -1;
    const [lo, hi] = this.xBounds(spec.anim);
    const target = Math.min(hi, Math.max(lo, c.x - dir * 70 * this.size - this.W / 2));
    if (Math.abs(target - this.x) < 40) return false;
    this._travelTo(target, { ...spec, info: { mouse: true }, onArrive: () => this._arriveAtMouse() });
    return true;
  }

  // Reached the pointer: look at it for a moment.
  _arriveAtMouse() {
    this._clear();
    this._setMode('idle', { name: 'curioso', mouse: true });
    const speed = this.p.animSpeed;
    this._anim('curioso', speed);
    this._after(LOOP_MS / speed, () => this.next());
  }

  // A few hops in a row: saltando frames 0 crouch, 1-3 airborne, 4 touch-down, 5-7 settle.
  hops(count = Math.round(rand(2, 4)), opts = {}) {
    this._clear();
    const s = this.size;
    const dist = (opts.dist || 75) * s;
    const height = (opts.height || 48) * s;
    const { dir } = this._chooseDir(dist * 1.5, 'saltando');
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
    const { dir } = this._chooseDir(200 * this.size, 'cazando');
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
  // Any visible vertical window edge Tito reaches counts as a wall, whether he arrives from outside the
  // window or walks in front of it (windows often reach down behind the Dock), wherever the window sits
  // in the stacking order; parts of a side hidden behind another window don't count. An edge counts when
  // the window overlaps his body height there. Returns the nearest edge crossed as the feet moved fx0->fx1.
  _wallCrossed(fx0, fx1, ignoreId = null) {
    if (fx0 === fx1) return null;
    const fy = this.footY();
    const bandTop = fy - 110 * this.size; // roughly his body height
    const bandBot = fy - 6;
    const a = this.area();
    const right = fx1 > fx0;
    let best = null;
    this.windows.forEach((w, i) => {
      if (this.surface.kind === 'window' && w.id === this.surface.id) return;
      if (w.id === ignoreId) return;
      if (w.y > bandBot || w.y + w.h < bandTop) return;
      for (const side of ['left', 'right']) {
        const sx = side === 'left' ? w.x : w.x + w.w;
        if (sx < a.x + 20 || sx > a.x + a.width - 20) continue; // edge off-screen
        // On a window top the visible stretch stops EDGE_PAD short of a window in front, so reaching that
        // stop is reaching the wall.
        const m = this.surface.kind === 'window' ? EDGE_PAD + 0.5 : 0;
        const crossed = right ? fx0 < sx - m && fx1 >= sx - m : fx0 > sx + m && fx1 <= sx + m;
        if (!crossed) continue;
        const py = Math.min(w.y + w.h - 1, Math.max(w.y + 1, fy - 40 * this.size));
        if (this._occluded(i, side === 'left' ? sx + 1 : sx - 1, py)) continue; // that part of the side is hidden
        if (!best || Math.abs(sx - fx0) < Math.abs(best.sx - fx0)) best = { w, side, sx };
      }
    });
    return best;
  }

  // Ran into the side of a window while on the move (walking, running, hopping, stalking), whichever
  // layer it is on: a straight 50/50, and he never stops either way. Half the time he starts climbing
  // it on the spot; otherwise he turns round and carries on the other way at the same pace.
  _hitWall(wall, dir, travel = null) {
    this._clear();
    this.x = wall.sx - dir * 16 * this.size - this.W / 2; // just short of the edge, whichever side
    this.y = this.standY();
    this._commit();
    // From the floor or from the top of another window: any visible side that rises above his feet.
    const t = this._climbInfo(wall.w, wall.side, this.footY());
    this.emit('wall', { window: wall.w.id, climbable: !!t, why: t ? '' : this.climbWhy });
    if (t && Math.random() < CLIMB_AT_WALL) { this._climbUp(t); return; }
    const back = -dir;
    const [lo, hi] = this.xBounds();
    const room = back < 0 ? this.x - lo : hi - this.x;
    const dist = Math.min(room, rand(150, 450) * this.size);
    const s = this.p.walkSpeed;
    const spec = travel && (travel.mode === 'walk' || travel.mode === 'run') ? travel : {
      mode: 'walk', anim: 'caminando', animSpeed: WALK_ANIM * s, speed: WALK_SPEED * s * this.size,
    };
    this._travelTo(this.x + back * Math.max(dist, 20), spec);
  }

  // Can Tito climb this side of window w and stand on top? Returns a climb target or null.
  // `fromFoot` is the height he starts climbing from: the floor, or the top of the window he stands on.
  _climbInfo(w, side, fromFoot = this.floorTop()) {
    const no = why => { this.climbWhy = why; return null; }; // why the last refusal happened (debug)
    const a = this.area();
    if (w.y < a.y + HEADROOM * this.size) return no(`top too close to the top of the screen (${Math.round(w.y - a.y)}px, needs ${Math.round(HEADROOM * this.size)})`);
    if (w.y > fromFoot - 60 * this.size) return no('its top is not above his feet');
    const sx = side === 'left' ? w.x : w.x + w.w;
    if (sx < a.x + 40 || sx > a.x + a.width - 40) return no('side at the edge of the screen');
    const landX = side === 'left' ? w.x + LEDGE_INSET + 20 : w.x + w.w - LEDGE_INSET - 20;
    if (!this._standable(w, landX)) return no('no visible spot to land on top');
    // The side he climbs must be visible all the way up: no climbing "inside" a window in front of it.
    const idx = this.windows.indexOf(w);
    const edgeX = side === 'left' ? sx + 1 : sx - 1;
    const bottom = Math.min(w.y + w.h, fromFoot) - 4;
    for (let y = w.y + 4; y <= bottom; y += 30) if (this._occluded(idx, edgeX, y)) return no('side hidden behind another window');
    return { w, side, sx, landX };
  }

  // ---------- climbing a window's side (escalando) ----------
  _climbTarget() {
    const a = this.area();
    const fx = this.footX();
    const options = [];
    for (const w of this.windows) {
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
      ignoreWindow: t.w.id,
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
      for (const w of this.windows) {
        const segs = this._edgeSegments(w).filter(([x0, x1]) => this._edgeHeightOk(w, (x0 + x1) / 2));
        if (segs.length) spots.push({ kind: 'window', id: w.id, segs });
      }
      const spot = pick(spots);
      if (spot.kind === 'window') {
        const seg = pick(spot.segs);
        this.x = rand(seg[0], seg[1]) - this.W / 2;
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
    // Music playing: he dances now and then.
    if (this.music && this.reactionsOn) {
      pool.set('celebrando', (pool.get('celebrando') || 0.5) + 3);
      pool.set('jugando', (pool.get('jugando') || 0.5) + 1.5);
    }
    // On a window he likes to perch: sitting, lying, dozing and watching the world, most of all
    // right at the edge where his legs can dangle.
    if (this.surface.kind === 'window') {
      const [lo, hi] = this.xBounds();
      const atEdge = this.x - lo < 55 * this.size || hi - this.x < 55 * this.size;
      for (const a of ['sentado', 'tumbado', 'durmiendo', 'mirando_izquierda', 'mirando_derecha', 'mirando_arriba']) {
        const edge = atEdge && (a === 'sentado' || a === 'tumbado' || a === 'durmiendo') ? 2 : 1;
        pool.set(a, (pool.get(a) || 0.6) * 2.5 * edge);
      }
    }
    return [...pool].filter(([, w]) => w > 0);
  }

  setMood(state) { this.mood = state; }
  setCompanion({ bond }) { if (typeof bond === 'number') this.bond = bond; }
  setReactions(on) { this.reactionsOn = !!on; }
  setMusic(on) {
    on = !!on;
    if (on === this.music) return;
    this.music = on;
    if (on && this.reactionsOn) this.react('celebrando', { loops: 3, speed: 2.2 });
  }

  // A one-off pose (a startle, a dance, a nudge), then back to normal. Never interrupts a drag, a
  // fall, a climb, a menu or sleep, and never breaks "stay still".
  react(anims, { loops = 2, speed = 2 } = {}) {
    if (this.stayPose || !this._autonomous()) return false;
    this._clear();
    this.y = this.standY();
    this._commit();
    const name = Array.isArray(anims) ? pick(anims) : anims;
    this._setMode('idle', { name, loops, react: true });
    this._anim(name, speed);
    this._after((loops * LOOP_MS) / speed, () => this.next());
    return true;
  }

  // Fed by the user: he eats, then perks up.
  eat() { return this.react('comiendo', { loops: 3, speed: 1.6 }); }

  // The mouse pointer next to him: a quick swipe startles him (less so the better friends you are);
  // a slow wiggle makes him play. Cooldowns keep it from being constant.
  _cursorPlay(now) {
    const cp = this._cp;
    if (now - cp.at < 150) return;
    const dt = (now - (cp.at || now - 150)) / 1000;
    cp.at = now;
    if (!this.getCursor) return;
    const c = this.getCursor();
    const prev = cp.prev;
    cp.prev = c;
    if (!prev || !this.reactionsOn || this.stayPose || !this._autonomous()) return;
    const speed = Math.hypot(c.x - prev.x, c.y - prev.y) / dt;
    const dx = c.x - this.footX();
    const dy = c.y - (this.footY() - 50 * this.size);
    const distance = Math.hypot(dx, dy) / this.size;
    const r = cursorReaction({ distance, speed, bond: this.bond });
    if (r === 'shy' && now - cp.shyAt > 12000) {
      cp.shyAt = now;
      this.facing = dx < 0 ? 'right' : 'left'; // turns away from it
      this.react(['asustado', 'escondido'], { loops: 2, speed: 2 });
    } else if (r === 'play' && this.mode === 'idle' && now - cp.playAt > 20000) {
      cp.playAt = now;
      this.facing = dx < 0 ? 'left' : 'right'; // looks at it
      this.react(['jugando_pelota', 'cazando_mariposas', 'curioso'], { loops: 2, speed: 2 });
    }
  }

  // While a chat reply is being written Tito sits and watches; a little wave when it arrives.
  setChatting(on) {
    if (on) {
      if (!this._autonomous() || this.stayPose) return;
      this._clear();
      this.y = this.standY();
      this._commit();
      this._setMode('idle', { name: 'curioso', chat: true });
      this._anim('curioso');
      this._chatPose = true;
    } else if (this._chatPose) {
      this._chatPose = false;
      if (this.mode !== 'idle') return; // he was picked up, fell asleep, etc.
      this._clear();
      const speed = 2;
      this._anim('saludando', speed);
      this._after(LOOP_MS / speed, () => this.next());
    }
  }

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
  click() { this._interact('openMenu', this.bond >= 40 ? ['dando_amor', 'saludando'] : ['sorprendido', 'saludando', 'dando_amor']); }
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
    if (event === 'openMenu') this.emit('pet'); // a click on him counts as petting
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
    // The window may hang off the screen where it's empty, but not the cat: keep his visible
    // pixels inside the display while he is carried.
    const d = screen.getDisplayNearestPoint({ x: Math.round(x + this.W / 2), y: Math.round(y + this.H / 2) }).bounds;
    const m = SPRITE[this.anim];
    const visH = (m ? m.height : this.H) * this.size;
    this.x = x;
    this.y = Math.min(d.y + d.height - this.H, Math.max(d.y - (this.H - visH), y));
    this._commit();
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
    this._clampX();
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
