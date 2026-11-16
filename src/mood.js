// Mood inputs (main process): battery, weather, clock. Rules live in mood-rules.js.
//
// Network use (only when "Weather" is on in Settings):
//   - approximate location from IP:  https://ipwho.is/   (fallback https://ipapi.co/json/)
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
      this.weather = { code: c.weather_code, tempC: c.temperature_2m, isDay: c.is_day === 1, place: loc.place };
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
    } else {
      try {
        const j = await getJSON('https://ipwho.is/');
        if (j.success === false) throw new Error('ipwho.is failed');
        loc = { lat: j.latitude, lon: j.longitude, place: j.city };
      } catch {
        const j = await getJSON('https://ipapi.co/json/');
        loc = { lat: j.latitude, lon: j.longitude, place: j.city };
      }
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
    };
  }
}

module.exports = { Mood };
