// Mood rules — pure functions (no Electron, no I/O) so they're easy to test.
//
// computeMood({ date, battery, weather }) scores five mood buckets from time of day, battery,
// weather and day of week, picks the strongest, and returns:
//   { mood, label, emoji, scores, reasons[], bias: {animation: weightMultiplier}, energy }
// The brain multiplies its personality's idle weights by `bias`, and `energy` (<1 = sluggish)
// makes him idle more and move less.

const BUCKETS = {
  happy: ['jugando', 'celebrando', 'saludando', 'jugando_pelota', 'triunfante', 'dando_amor', 'cazando_mariposas'],
  tired: ['cansado', 'bostezando', 'tumbado', 'durmiendo', 'estirandose'],
  grumpy: ['enfadado', 'sentado', 'vomitando'],
  scared: ['asustado', 'sorprendido', 'escondido'],
  calm: ['sentado', 'tumbado', 'mirando_arriba', 'mirando_izquierda', 'mirando_derecha', 'bebiendo', 'comiendo'],
};

const MOODS = {
  happy: { label: 'Happy', emoji: '😺', energy: 1.25 },
  tired: { label: 'Tired', emoji: '😪', energy: 0.6 },
  grumpy: { label: 'Grumpy', emoji: '😾', energy: 0.85 },
  scared: { label: 'Scared', emoji: '🙀', energy: 1.1 },
  calm: { label: 'Calm', emoji: '😌', energy: 0.9 },
};

// WMO weather codes (Open-Meteo).
function weatherKind(code) {
  if (code == null) return null;
  if (code >= 95) return 'thunder';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if (code === 45 || code === 48) return 'fog';
  if (code <= 1) return 'clear';
  return 'cloudy';
}

const WEATHER_TEXT = {
  thunder: 'Thunderstorm', snow: 'Snowing', rain: 'Rainy', fog: 'Foggy', clear: 'Clear skies', cloudy: 'Cloudy',
};

/**
 * @param {object} input
 * @param {Date} input.date
 * @param {{percent:number, charging:boolean}|null} input.battery  null = no battery / unknown
 * @param {{code:number, tempC:number, isDay:boolean, place?:string}|null} input.weather
 */
function computeMood({ date = new Date(), battery = null, weather = null } = {}) {
  const s = { happy: 0.5, tired: 0, grumpy: 0, scared: 0, calm: 0.5 };
  const reasons = [];
  const extraBias = {};
  const add = (bucket, n, reason) => { s[bucket] += n; if (reason && !reasons.includes(reason)) reasons.push(reason); };

  // Time of day
  const h = date.getHours();
  if (h < 6) add('tired', 2.5, 'Middle of the night');
  else if (h < 9) { add('tired', 1, 'Early morning'); add('calm', 0.5); }
  else if (h < 12) { add('happy', 0.5, 'Morning'); add('calm', 0.5); }
  else if (h < 14) { add('calm', 0.8, 'Lunchtime'); extraBias.comiendo = 3; extraBias.bebiendo = 2; }
  else if (h < 18) add('happy', 1, 'Afternoon');
  else if (h < 21) { add('calm', 1, 'Evening'); add('happy', 0.3); }
  else add('tired', 1.5, 'Getting late');

  // Battery
  if (battery && typeof battery.percent === 'number' && !battery.charging) {
    if (battery.percent <= 10) { add('grumpy', 2, `Battery very low (${battery.percent}%)`); add('tired', 1.5); }
    else if (battery.percent <= 20) { add('tired', 1.5, `Battery low (${battery.percent}%)`); add('grumpy', 0.8); }
  } else if (battery && battery.charging && battery.percent < 100) {
    add('happy', 0.3, 'Charging');
  }

  // Weather
  const kind = weather ? weatherKind(weather.code) : null;
  if (kind) {
    const where = weather.place ? ` in ${weather.place}` : '';
    const t = typeof weather.tempC === 'number' ? `, ${Math.round(weather.tempC)}°C` : '';
    const text = `${WEATHER_TEXT[kind]}${where}${t}`;
    if (kind === 'thunder') add('scared', 2.5, text);
    else if (kind === 'rain') { add('calm', 1, text); add('grumpy', 0.7); }
    else if (kind === 'snow') { add('happy', 0.8, text); add('calm', 0.5); }
    else if (kind === 'fog') add('calm', 0.7, text);
    else if (kind === 'clear' && weather.isDay) add('happy', 1, text);
    else reasons.push(text);
    if (typeof weather.tempC === 'number') {
      if (weather.tempC <= 0) { add('tired', 0.5, 'Freezing'); add('calm', 0.3); }
      else if (weather.tempC >= 30) add('tired', 1, 'Hot');
    }
  }

  // Day of week
  const d = date.getDay();
  if (d === 0 || d === 6) add('happy', 1, 'Weekend');
  else if (d === 1) add('grumpy', 0.6, 'Monday');
  else if (d === 5) add('happy', 0.5, 'Friday');

  const mood = Object.keys(s).reduce((a, b) => (s[b] > s[a] ? b : a));
  const max = s[mood] || 1;

  // Animation bias: every bucket boosts its animations in proportion to its strength.
  const bias = {};
  for (const [bucket, anims] of Object.entries(BUCKETS)) {
    const strength = Math.max(0, s[bucket] / max); // 0..1
    for (const a of anims) bias[a] = Math.max(bias[a] || 1, 1 + 2 * strength);
  }
  for (const [a, f] of Object.entries(extraBias)) bias[a] = (bias[a] || 1) * f;

  return {
    mood,
    label: MOODS[mood].label,
    emoji: MOODS[mood].emoji,
    energy: MOODS[mood].energy,
    scores: s,
    reasons,
    bias,
    // Mood-bucket animations he may do even if his personality's pool lacks them.
    extras: BUCKETS[mood],
  };
}

module.exports = { computeMood, weatherKind, BUCKETS, MOODS };
