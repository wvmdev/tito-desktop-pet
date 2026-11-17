// Personality presets, chosen by the user in Settings.
// Each one shapes which idle animations get picked, how often/how he moves, and pacing.
// jugando, buscando, curioso, dando_amor, celebrando and cazando_mariposas turn their head/body
// mid-loop in the source art, so they're kept to personalities where that reads as playful.
//
// idle:        [animation, weight]
// idleLoops:   [min, max] loops an idle animation plays for
// idleChain:   chance of doing another idle instead of moving afterwards
// moves:       relative weights of movement types (walk/run/hops/stalk/climb/teleport)
// walkSpeed / animSpeed: multipliers

const PERSONALITIES = {
  balanced: {
    label: 'Balanced',
    description: 'A bit of everything: strolls, sits, looks around, climbs windows, plays now and then.',
    idle: [
      ['sentado', 6], ['de_pie', 3], ['tumbado', 2], ['mirando_arriba', 2],
      ['mirando_izquierda', 1], ['mirando_derecha', 1], ['levantando_pata', 1],
      ['estirandose', 2], ['bostezando', 1], ['jugando_pelota', 2], ['comiendo', 1],
      ['bebiendo', 1], ['saludando', 1], ['triunfante', 1], ['buscando', 1], ['curioso', 1],
      ['jugando', 1], ['dando_amor', 0.5], ['vomitando', 0.3],
    ],
    idleLoops: [1, 2.5],
    idleChain: 0.25,
    moves: { walk: 6, run: 1, hops: 1.5, stalk: 1, climb: 5, teleport: 0.3 },
    walkSpeed: 1,
    animSpeed: 1,
  },
  calm: {
    label: 'Calm',
    description: 'Unhurried. Long sits and lie-downs, slow short walks, rarely runs.',
    idle: [
      ['sentado', 8], ['tumbado', 5], ['de_pie', 2], ['mirando_arriba', 2],
      ['estirandose', 1], ['bostezando', 1], ['mirando_izquierda', 1], ['mirando_derecha', 1],
      ['dando_amor', 1], ['bebiendo', 1],
    ],
    idleLoops: [2, 4],
    idleChain: 0.45,
    moves: { walk: 10, run: 0, hops: 0.3, stalk: 0.3, climb: 3, teleport: 0 },
    walkSpeed: 0.75,
    animSpeed: 0.85,
  },
  excited: {
    label: 'Excited',
    description: 'Zoomies! Runs, hops, climbs, plays with his ball and celebrates constantly.',
    idle: [
      ['jugando_pelota', 5], ['jugando', 4], ['celebrando', 4], ['cazando_mariposas', 3],
      ['triunfante', 2], ['saludando', 2], ['levantando_pata', 1], ['sorprendido', 1],
    ],
    idleLoops: [1, 1.5],
    idleChain: 0.1,
    moves: { walk: 2, run: 5, hops: 4, stalk: 2, climb: 6, teleport: 0.8 },
    walkSpeed: 1.3,
    animSpeed: 1.3,
  },
  sleepy: {
    label: 'Sleepy',
    description: 'Mostly naps. Yawns, stretches, dozes off again, and shuffles a little.',
    idle: [
      ['durmiendo', 10], ['tumbado', 4], ['bostezando', 3], ['cansado', 3],
      ['estirandose', 1], ['sentado', 2],
    ],
    idleLoops: [3, 8],
    idleChain: 0.75,
    moves: { walk: 10, run: 0, hops: 0, stalk: 0, climb: 2, teleport: 0 },
    walkSpeed: 0.6,
    animSpeed: 0.8,
  },
  curious: {
    label: 'Curious',
    description: 'An explorer. Wanders, climbs onto windows, peeks, stalks and pounces.',
    idle: [
      ['mirando_arriba', 3], ['mirando_izquierda', 2], ['mirando_derecha', 2], ['buscando', 3],
      ['curioso', 3], ['escondido', 2], ['cazando_mariposas', 2], ['levantando_pata', 2],
      ['de_pie', 1], ['sentado', 2],
    ],
    idleLoops: [1, 2],
    idleChain: 0.15,
    moves: { walk: 6, run: 1, hops: 1.5, stalk: 4, climb: 8, teleport: 0.6 },
    walkSpeed: 1.05,
    animSpeed: 1,
  },
  grumpy: {
    label: 'Grumpy',
    description: "Not in the mood. Sits, glares, huffs, coughs up a hairball, won't go far.",
    idle: [
      ['enfadado', 5], ['sentado', 5], ['tumbado', 2], ['de_pie', 2], ['cansado', 1],
      ['asustado', 1], ['vomitando', 1],
    ],
    idleLoops: [2, 3],
    idleChain: 0.4,
    moves: { walk: 10, run: 0, hops: 0, stalk: 1, climb: 2, teleport: 0 },
    walkSpeed: 0.8,
    animSpeed: 1,
  },
};

const DEFAULT_PERSONALITY = 'balanced';

// Poses for "Stay still" mode (Settings). Each loops in place until the user turns it off.
const STAY_POSES = [
  { id: 'sentado', label: 'Sitting' },
  { id: 'de_pie', label: 'Standing' },
  { id: 'durmiendo', label: 'Sleeping' },
  { id: 'tumbado', label: 'Lying down' },
  { id: 'dando_amor', label: 'Giving love' },
  { id: 'jugando_pelota', label: 'Playing ball' },
  { id: 'comiendo', label: 'Eating' },
  { id: 'bebiendo', label: 'Drinking' },
  { id: 'mirando_arriba', label: 'Looking up' },
  { id: 'estirandose', label: 'Stretching' },
  { id: 'escondido', label: 'Peeking' },
  { id: 'celebrando', label: 'Celebrating' },
  { id: 'cansado', label: 'Tired' },
  { id: 'enfadado', label: 'Grumpy' },
];

// ---------- emotions, and custom personalities built from them ----------
// A personality is a mix of emotions. Every idle animation belongs to one emotion, so a preset's
// mix can be read off its pool, and a custom mix (percentages the user sets) builds a pool.
const EMOTIONS = ['happy', 'calm', 'curious', 'tired', 'grumpy', 'scared'];
const EMOTION_INFO = {
  happy: { label: 'Happy', emoji: '😺' }, calm: { label: 'Calm', emoji: '😌' }, curious: { label: 'Curious', emoji: '🧐' },
  tired: { label: 'Tired', emoji: '😪' }, grumpy: { label: 'Grumpy', emoji: '😾' }, scared: { label: 'Scared', emoji: '🙀' },
};
const EMOTION_ANIMS = {
  happy: ['jugando', 'jugando_pelota', 'saludando', 'triunfante', 'celebrando', 'dando_amor', 'cazando_mariposas'],
  calm: ['sentado', 'de_pie', 'tumbado', 'estirandose', 'comiendo', 'bebiendo'],
  curious: ['mirando_arriba', 'mirando_izquierda', 'mirando_derecha', 'levantando_pata', 'buscando', 'curioso', 'escondido'],
  tired: ['bostezando', 'durmiendo', 'cansado'],
  grumpy: ['enfadado', 'vomitando'],
  scared: ['asustado', 'sorprendido'],
};
const ANIM_EMOTION = Object.fromEntries(Object.entries(EMOTION_ANIMS).flatMap(([e, list]) => list.map(a => [a, e])));
// How each emotion likes to move: relative weights per movement.
const MOVE_KEYS = ['walk', 'run', 'hops', 'stalk', 'climb', 'teleport'];
const EMOTION_MOVES = {
  happy:   { walk: 2, run: 4, hops: 4, stalk: 1, climb: 3, teleport: 0.5 },
  calm:    { walk: 8, run: 0, hops: 0.3, stalk: 0.3, climb: 1, teleport: 0 },
  curious: { walk: 6, run: 1, hops: 1.5, stalk: 4, climb: 4, teleport: 0.6 },
  tired:   { walk: 9, run: 0, hops: 0, stalk: 0, climb: 0.5, teleport: 0 },
  grumpy:  { walk: 8, run: 0, hops: 0, stalk: 1, climb: 0.5, teleport: 0 },
  scared:  { walk: 3, run: 5, hops: 3, stalk: 0, climb: 1, teleport: 1 },
};
const MAX_CUSTOM = 12;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Whole-number percentages that add up to exactly 100 (largest remainder).
function percentages(raw, keys = EMOTIONS) {
  const total = keys.reduce((t, k) => t + (raw[k] || 0), 0);
  if (total <= 0) return Object.fromEntries(keys.map(k => [k, 0]));
  const exact = keys.map(k => (100 * (raw[k] || 0)) / total);
  const out = exact.map(Math.floor);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left-- > 0) out[i]++; });
  return Object.fromEntries(keys.map((k, i) => [k, out[i]]));
}

// Check/clean a list of custom personalities from untrusted input. Returns the clean list or null.
function cleanCustoms(v) {
  if (!Array.isArray(v) || v.length > MAX_CUSTOM) return null;
  const out = [];
  const seen = new Set();
  for (const c of v) {
    if (!c || typeof c !== 'object') return null;
    const label = typeof c.label === 'string' ? c.label.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24) : '';
    if (!label || !c.emotions || typeof c.emotions !== 'object') return null;
    const emotions = {};
    for (const e of EMOTIONS) {
      const n = Number(c.emotions[e] ?? 0);
      if (!Number.isFinite(n)) return null;
      emotions[e] = Math.round(clamp(n, 0, 100));
    }
    if (EMOTIONS.every(e => emotions[e] === 0)) return null;
    const num = (k, d) => { const n = Number(c[k] ?? d); return Number.isFinite(n) ? Math.round(clamp(n, 0, 100)) : d; };
    let id = typeof c.id === 'string' && /^c-[a-z0-9]{4,12}$/.test(c.id) ? c.id : `c-${Math.random().toString(36).slice(2, 10)}`;
    while (seen.has(id)) id = `c-${Math.random().toString(36).slice(2, 10)}`;
    seen.add(id);
    out.push({ id, label, emotions, activity: num('activity', 50), speed: num('speed', 50), climb: num('climb', 50) });
  }
  return out;
}

// Turn a custom definition into the same shape as a preset.
function buildPersonality(c) {
  const mix = percentages(c.emotions);
  const share = Object.fromEntries(EMOTIONS.map(e => [e, mix[e] / 100]));
  const pool = new Map();
  for (const e of EMOTIONS) {
    const list = EMOTION_ANIMS[e];
    if (share[e] > 0) for (const a of list) pool.set(a, (pool.get(a) || 0) + (share[e] * 92) / list.length);
  }
  // A little filler so a one-emotion personality doesn't loop two poses forever.
  pool.set('sentado', (pool.get('sentado') || 0) + 5);
  pool.set('de_pie', (pool.get('de_pie') || 0) + 3);
  const moves = {};
  for (const m of MOVE_KEYS) moves[m] = EMOTIONS.reduce((t, e) => t + share[e] * EMOTION_MOVES[e][m], 0);
  moves.climb *= c.climb <= 50 ? c.climb / 50 : 1 + ((c.climb - 50) / 50) * 3; // 0 = never, 50 = as the mix says, 100 = x4
  const top = EMOTIONS.filter(e => mix[e] > 0).sort((a, b) => mix[b] - mix[a]).slice(0, 2);
  return {
    label: c.label,
    description: `Your own mix: ${top.map(e => `${mix[e]}% ${EMOTION_INFO[e].label.toLowerCase()}`).join(', ')}.`,
    idle: [...pool],
    idleLoops: [1 + ((100 - c.activity) / 100) * 2, 2 + ((100 - c.activity) / 100) * 5],
    idleChain: 0.8 - (0.7 * c.activity) / 100,
    moves,
    walkSpeed: 0.5 + c.speed / 100,
    animSpeed: 0.8 + (0.5 * c.speed) / 100,
    custom: true,
  };
}

// id -> personality (preset or one of the user's), or null.
function resolvePersonality(id, customs = []) {
  if (PERSONALITIES[id]) return PERSONALITIES[id];
  const c = customs.find(x => x.id === id);
  return c ? buildPersonality(c) : null;
}

// What the settings page shows for any personality: emotion %, how often he climbs, how often he moves.
function personalityStats(p, rawEmotions = null) {
  let mix;
  if (rawEmotions) mix = percentages(rawEmotions);
  else {
    const t = Object.fromEntries(EMOTIONS.map(e => [e, 0]));
    for (const [a, w] of p.idle) t[ANIM_EMOTION[a]] += w;
    mix = percentages(t);
  }
  const mv = Object.values(p.moves).reduce((a, b) => a + b, 0) || 1;
  return { mix, climbPct: Math.round((100 * (p.moves.climb || 0)) / mv), movePct: Math.round(100 * (1 - p.idleChain)) };
}

// Shape sent to the settings UI (no functions, just labels and numbers).
const personalityList = (customs = []) => [
  ...Object.entries(PERSONALITIES).map(([id, p]) => ({ id, label: p.label, description: p.description, custom: false, ...personalityStats(p) })),
  ...customs.map(c => {
    const p = buildPersonality(c);
    return { id: c.id, label: c.label, description: p.description, custom: true, params: c, ...personalityStats(p, c.emotions) };
  }),
];

module.exports = {
  PERSONALITIES, DEFAULT_PERSONALITY, personalityList, STAY_POSES,
  EMOTIONS, EMOTION_INFO, EMOTION_ANIMS, MAX_CUSTOM, cleanCustoms, buildPersonality, resolvePersonality, personalityStats, percentages,
};
