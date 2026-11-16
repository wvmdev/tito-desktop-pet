// Persistent, non-secret settings (JSON in the app's userData folder).
// Secrets (API keys) will NOT live here — phase 5 stores them via safeStorage.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { PERSONALITIES, DEFAULT_PERSONALITY } = require('./personalities');

const SIZE_MIN = 0.5;
const SIZE_MAX = 2;
const DEFAULTS = { personality: DEFAULT_PERSONALITY, size: 1 };

const VALIDATORS = {
  personality: v => (PERSONALITIES[v] ? v : null),
  size: v => (typeof v === 'number' && Number.isFinite(v)
    ? Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, v)) * 100) / 100 : null),
};

class Settings extends EventEmitter {
  constructor() {
    super();
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.data = { ...DEFAULTS };
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    for (const k of Object.keys(DEFAULTS)) {
      const v = k in saved ? VALIDATORS[k](saved[k]) : null;
      if (v !== null) this.data[k] = v;
    }
    this._saveTimer = null;
  }

  get(key) { return this.data[key]; }
  all() { return { ...this.data }; }

  set(key, value) {
    if (!(key in VALIDATORS)) throw new Error(`Unknown setting: ${key}`);
    const v = VALIDATORS[key](value);
    if (v === null) throw new Error(`Invalid value for ${key}`);
    if (v === this.data[key]) return;
    this.data[key] = v;
    // Debounced write: the size slider fires many changes per second.
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._write(), 300);
    this.emit('change', key, v);
  }

  _write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

module.exports = { Settings, SIZE_MIN, SIZE_MAX };
