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

// Shape sent to the settings UI (no functions, just labels).
const personalityList = () =>
  Object.entries(PERSONALITIES).map(([id, p]) => ({ id, label: p.label, description: p.description }));

module.exports = { PERSONALITIES, DEFAULT_PERSONALITY, personalityList, STAY_POSES };
