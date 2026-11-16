// Animation catalogue + sprite player shared by the pet window.

const SPRITE_ROOT = '../../assets/sprites';
const FRAME_COUNT = 8;
const FRAME_MS = 550; // matches the reference preview (real/index.html BASE_INTERVAL)

const ANIMATIONS = [
  'sentado', 'caminando', 'de_pie', 'tumbado', 'mirando_arriba', 'mirando_izquierda',
  'mirando_derecha', 'levantando_pata', 'panza_arriba', 'jugando', 'escalando', 'escondido',
  'teletransportarse', 'asustado', 'cazando', 'corriendo', 'buscando', 'cazando_mariposas',
  'saltando', 'resbalando', 'saludando', 'sacudiendose', 'estirandose', 'triunfante',
  'bebiendo', 'jugando_pelota', 'durmiendo', 'bostezando', 'comiendo', 'curioso',
  'enfadado', 'dando_amor', 'celebrando', 'cansado', 'sorprendido', 'vomitando',
];

// Which way each animation's art actually faces (audited frame-by-frame with tools/sheet.js).
// 'R' = drawn facing right, 'N' = orientation-neutral (never flipped), everything else faces left.
const NATIVE_FACING = {
  caminando: 'R', corriendo: 'R', mirando_derecha: 'R', jugando_pelota: 'R',
  jugando: 'R', curioso: 'R', dando_amor: 'R', celebrando: 'R', // mixed-direction loops, mostly right
  durmiendo: 'N', escalando: 'N', escondido: 'N', panza_arriba: 'N', teletransportarse: 'N',
};
const nativeFacing = name => NATIVE_FACING[name] || 'L';

// The art was generated at different zoom levels per animation. Iris size (source px, measured
// with tools/measure.js; hand-estimated where the eyes are closed/hidden) is used as a ruler so
// Tito renders at the same size in every animation.
const EYE_PX = {
  sentado: 45, caminando: 54, de_pie: 52, tumbado: 37, mirando_arriba: 45, mirando_izquierda: 49,
  mirando_derecha: 43, levantando_pata: 33, panza_arriba: 38, jugando: 34, escalando: 51,
  escondido: 35, teletransportarse: 46, asustado: 31, cazando: 28, corriendo: 45, buscando: 30,
  cazando_mariposas: 30, saltando: 29, resbalando: 30, saludando: 50, sacudiendose: 49,
  estirandose: 31, triunfante: 34, bebiendo: 33, jugando_pelota: 34, durmiendo: 37,
  bostezando: 45, comiendo: 33, curioso: 41, enfadado: 36, dando_amor: 41, celebrando: 40,
  cansado: 37, sorprendido: 44, vomitando: 50,
};
const REF_EYE = 45; // sentado is the reference
const sizeFactor = name => REF_EYE / (EYE_PX[name] || REF_EYE);

const ALL_FRAMES = [0, 1, 2, 3, 4, 5, 6, 7];

function framePath(name, i) {
  return `${SPRITE_ROOT}/${name}/${name}_${i}.png`;
}

// Preload every frame so switching animations never flashes an empty image.
function preloadAll() {
  const jobs = [];
  for (const name of ANIMATIONS) {
    for (let i = 0; i < FRAME_COUNT; i++) {
      const img = new Image();
      img.src = framePath(name, i);
      jobs.push(img.decode().catch(() => console.warn('missing frame', img.src)));
    }
  }
  return Promise.all(jobs);
}

/**
 * Drives an <img> element through an animation's frames.
 * play(name, { facing, frames, loop }) — frames is an optional sequence of frame indices
 * (e.g. [2,3,4] or reversed for "appear"); non-looping sequences hold their last frame.
 */
class SpritePlayer {
  constructor(img) {
    this.img = img;
    this.name = null;
    this.seq = ALL_FRAMES;
    this.idx = 0;
    this.frame = 0;
    this.loop = true;
    this.facing = 'left';
    this.speed = 1;
    this._next = 0;
    this._raf = requestAnimationFrame(t => this._tick(t));
  }

  play(name, { facing = this.facing, frames = null, loop = true } = {}) {
    if (!ANIMATIONS.includes(name)) throw new Error(`Unknown animation: ${name}`);
    this.name = name;
    this.seq = Array.isArray(frames) && frames.length ? frames : ALL_FRAMES;
    this.idx = 0;
    this.loop = loop;
    this.frame = this.seq[0];
    this._next = performance.now() + FRAME_MS / this.speed;
    this.img.src = framePath(name, this.frame);
    this.setFacing(facing);
  }

  setFacing(facing) {
    this.facing = facing;
    const native = nativeFacing(this.name);
    const flip = native !== 'N' && (native === 'R') !== (facing === 'right');
    this.img.style.transform = flip ? 'scaleX(-1)' : 'none';
  }

  _tick(now) {
    if (this.name && now >= this._next) {
      if (this.idx + 1 < this.seq.length) this.idx++;
      else if (this.loop) this.idx = 0;
      if (this.seq[this.idx] !== this.frame) {
        this.frame = this.seq[this.idx];
        this.img.src = framePath(this.name, this.frame);
      }
      this._next = now + FRAME_MS / this.speed;
    }
    this._raf = requestAnimationFrame(t => this._tick(t));
  }
}

window.TitoAnim = { ANIMATIONS, NATIVE_FACING, EYE_PX, FRAME_MS, sizeFactor, SpritePlayer, preloadAll };
