// Chat slash commands: /sleep, /hide, /run, and an emotion or pose for every animation Tito has.
// Shared by the chat window (autocomplete) and the main process (what a command does).
// kind 'pose': he holds the pose until you click him.  kind 'act': he does it once, then carries on.
(function (root) {
  const pose = (name, anim, desc) => ({ name, kind: 'pose', anim, desc });
  const act = (name, what, desc) => ({ name, kind: 'act', act: what, desc });
  const COMMANDS = [
    pose('sleep', 'durmiendo', 'Fall asleep'),
    pose('hide', 'escondido', 'Hide away'),
    act('run', 'run', 'Run across the screen'),
    act('walk', 'walk', 'Go for a walk'),
    act('jump', 'hops', 'Hop about'),
    act('hop', 'hops', 'Hop about'),
    act('climb', 'climb', 'Climb a window'),
    act('teleport', 'teleport', 'Vanish and reappear'),
    act('stalk', 'stalk', 'Creep up and pounce'),
    pose('sit', 'sentado', 'Sit down'),
    pose('stand', 'de_pie', 'Stand up'),
    pose('lie', 'tumbado', 'Lie down'),
    pose('belly', 'panza_arriba', 'Belly up'),
    pose('happy', 'celebrando', 'Happy dance'),
    pose('dance', 'celebrando', 'Dance'),
    pose('celebrate', 'celebrando', 'Celebrate'),
    pose('proud', 'triunfante', 'Proud and triumphant'),
    pose('triumph', 'triunfante', 'Triumphant'),
    pose('love', 'dando_amor', 'Show some love'),
    pose('wave', 'saludando', 'Wave hello'),
    pose('hello', 'saludando', 'Say hello'),
    pose('angry', 'enfadado', 'Get angry'),
    pose('grumpy', 'enfadado', 'Grumpy'),
    pose('scared', 'asustado', 'Get scared'),
    pose('surprised', 'sorprendido', 'Get surprised'),
    pose('curious', 'curioso', 'Look curious'),
    pose('tired', 'cansado', 'Look tired'),
    pose('sad', 'cansado', 'Look sad'),
    pose('sick', 'vomitando', 'Feel sick'),
    pose('vomit', 'vomitando', 'Throw up'),
    pose('eat', 'comiendo', 'Eat'),
    pose('drink', 'bebiendo', 'Drink'),
    pose('yawn', 'bostezando', 'Yawn'),
    pose('stretch', 'estirandose', 'Stretch'),
    pose('play', 'jugando', 'Play'),
    pose('ball', 'jugando_pelota', 'Play with a ball'),
    pose('butterflies', 'cazando_mariposas', 'Chase butterflies'),
    pose('hunt', 'cazando', 'Hunt'),
    pose('search', 'buscando', 'Look around for something'),
    pose('shake', 'sacudiendose', 'Shake it off'),
    pose('paw', 'levantando_pata', 'Lift a paw'),
    pose('lookup', 'mirando_arriba', 'Look up'),
    pose('lookleft', 'mirando_izquierda', 'Look left'),
    pose('lookright', 'mirando_derecha', 'Look right'),
    pose('slip', 'resbalando', 'Slip'),
    { name: 'stop', kind: 'undo', desc: 'Back to normal (or just click Tito)' },
    { name: 'wake', kind: 'undo', desc: 'Back to normal (or just click Tito)' },
  ];
  const api = {
    COMMANDS,
    find: name => COMMANDS.find(c => c.name === String(name).toLowerCase()) || null,
    // Commands whose name starts with what was typed after the slash.
    match: prefix => COMMANDS.filter(c => c.name.startsWith(String(prefix).toLowerCase())),
    // "/sleep" (and nothing else) is a command; "/Users/me/file" is just text for the AI.
    parse: text => { const m = /^\/([a-z]+)\s*$/i.exec(String(text).trim()); return m ? m[1].toLowerCase() : null; },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TitoCommands = api;
})(typeof self !== 'undefined' ? self : this);
