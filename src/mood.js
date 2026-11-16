// Mood inputs (main process): battery, weather, clock. Rules live in mood-rules.js.
//
// Network use (only when "Weather" is on in Settings):
//   - approximate location from IP: ipwho.is, get.geojs.io and ipinfo.io are asked together and
//     the city most of them agree on wins (IP location is often off on mobile / shared ISPs)
//   - or, with a city typed in Settings: Open-Meteo geocoding (the city name only)
//   - current weather: https://api.open-meteo.com  (latitude/longitude, 2 decimals)
// No keys, no accounts. Results are cached; failures just leave weather out of the mood.
const { net } = require('electron');
const { execFile } = require('child_process');
const EventEmitter = require('events');
const { computeMood } = require('./mood-rules');

const BATTERY_EVERY = 2 * 60 * 1000;
const WEATHER_EVERY = 30 * 60 * 1000;
const LOCATION_TTL = 6 * 60 * 60 * 1000;
const RECOMPUTE_EVERY = 60 * 1000;

// Each IP-location provider -> { city, lat, lon } or throws.
const IP_PROVIDERS = [
  { name: 'ipwho.is', url: 'https://ipwho.is/',
    parse: j => { if (j.success === false) throw new Error('failed'); return { city: j.city, country: j.country, lat: +j.latitude, lon: +j.longitude }; } },
  { name: 'geojs.io', url: 'https://get.geojs.io/v1/ip/geo.json',
    parse: j => ({ city: j.city, country: j.country, lat: +j.latitude, lon: +j.longitude }) },
  { name: 'ipinfo.io', url: 'https://ipinfo.io/json',
    parse: j => { const [lat, lon] = String(j.loc || '').split(',').map(Number); return { city: j.city, country: j.country, lat, lon }; } },
];

// Majority vote by city; ties go to the first provider in the list that answered.
function pickConsensus(answers) {
  const groups = new Map();
  for (const a of answers) {
    if (!a.city || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;
    const key = a.city.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  let best = null;
  for (const g of groups.values()) if (!best || g.length > best.length) best = g;
  if (!best) return null;
  const avg = k => best.reduce((t, a) => t + a[k], 0) / best.length;
  return { lat: avg('lat'), lon: avg('lon'), place: best[0].city, votes: best.length, asked: answers.length };
}

async function getJSON(url) {
  const res = await net.fetch(url, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function readBattery() {
  return new Promise(resolve => {
    if (process.platform !== 'darwin') return resolve(null);
    execFile('pmset', ['-g', 'batt'], { timeout: 4000 }, (err, out) => {
      if (err) return resolve(null);
      // e.g. " -InternalBattery-0 (id=1234)	85%; discharging; 4:12 remaining present: true"
      const m = /InternalBattery[^\t]*\t(\d+)%;\s*([a-zA-Z ]+);/.exec(out);
      if (!m) return resolve(null); // desktop Mac: no battery
      const state = m[2].trim().toLowerCase();
      resolve({ percent: +m[1], charging: state !== 'discharging' });
    });
  });
}

class Mood extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.battery = null;
    this.weather = null;
    this.weatherError = null;
    this._loc = null; // { lat, lon, place, at, key }
    this.state = computeMood({});
    this._timers = [];
  }

  start() {
    this.refreshBattery();
    this.refreshWeather();
    this._timers.push(
      setInterval(() => this.refreshBattery(), BATTERY_EVERY),
      setInterval(() => this.refreshWeather(), WEATHER_EVERY),
      setInterval(() => this.recompute(), RECOMPUTE_EVERY),
    );
  }

  stop() { this._timers.forEach(clearInterval); }

  async refreshBattery() {
    this.battery = await readBattery();
    this.recompute();
  }

  async refreshWeather() {
    if (!this.settings.get('weatherEnabled')) {
      this.weather = null; this.weatherError = null; this.recompute(); return;
    }
    try {
      const loc = await this._location();
      const q = `latitude=${loc.lat.toFixed(2)}&longitude=${loc.lon.toFixed(2)}&current=temperature_2m,weather_code,is_day`;
      const data = await getJSON(`https://api.open-meteo.com/v1/forecast?${q}`);
      const c = data.current || {};
      this.weather = { code: c.weather_code, tempC: c.temperature_2m, isDay: c.is_day === 1, place: loc.short };
      this.weatherError = null;
    } catch (e) {
      this.weatherError = e.message === 'City not found' ? e.message : 'Weather unavailable right now';
    }
    this.recompute();
  }

  // Settings changed (weather toggle / city): refetch.
  invalidateLocation() { this._loc = null; this.refreshWeather(); }

  async _location() {
    const city = (this.settings.get('locationOverride') || '').trim();
    const key = city || '@ip';
    if (this._loc && this._loc.key === key && Date.now() - this._loc.at < LOCATION_TTL) return this._loc;
    let loc;
    if (city) {
      const g = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`);
      const r = g.results && g.results[0];
      if (!r) throw new Error('City not found');
      loc = { lat: r.latitude, lon: r.longitude, place: r.name };
      loc.source = 'city';
      loc.place = [r.name, r.admin1, r.country].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(', ');
      loc.short = r.name;
    } else {
      const results = await Promise.allSettled(IP_PROVIDERS.map(p => getJSON(p.url).then(p.parse)));
      const answers = results.filter(r => r.status === 'fulfilled').map(r => r.value);
      const c = pickConsensus(answers);
      if (!c) throw new Error('No location');
      loc = { lat: c.lat, lon: c.lon, place: c.place, short: c.place, source: 'ip', agreement: `${c.votes}/${c.asked}` };
    }
    if (typeof loc.lat !== 'number' || typeof loc.lon !== 'number') throw new Error('No location');
    this._loc = { ...loc, at: Date.now(), key };
    return this._loc;
  }

  recompute() {
    this.state = computeMood({ date: new Date(), battery: this.battery, weather: this.weather });
    this.emit('change', this.summary());
  }

  // What the Settings window shows.
  summary() {
    const { mood, label, emoji, reasons, energy } = this.state;
    return {
      mood, label, emoji, reasons, energy,
      battery: this.battery,
      weather: this.weather,
      weatherError: this.weatherError,
      // Where the weather is for, so a wrong IP guess is easy to spot and fix in Settings.
      location: this._loc ? { place: this._loc.place, source: this._loc.source, agreement: this._loc.agreement } : null,
    };
  }
}

module.exports = { Mood };
