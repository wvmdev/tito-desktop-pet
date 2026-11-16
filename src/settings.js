// Persistent, non-secret settings (JSON in the app's userData folder).
// Secrets (API keys) will NOT live here — phase 5 stores them via safeStorage.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { PERSONALITIES, DEFAULT_PERSONALITY, STAY_POSES } = require('./personalities');
const { LEVELS, DEFAULT_PERMS, validatePerms } = require('./ai/permissions');
const { DEFAULT_MODELS, PROVIDER_IDS } = require('./ai/providers');

const MODEL_RE = /^[A-Za-z0-9._:\/@-]{1,120}$/;
// Custom endpoints: https anywhere, plain http only for this machine (local model servers).
function validBaseURL(v) {
  if (v === '') return '';
  try {
    const u = new URL(v);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return u.toString().replace(/\/$/, '');
  } catch { /* invalid */ }
  return null;
}

const SIZE_MIN = 0.5;
const SIZE_MAX = 2;
const DEFAULTS = {
  personality: DEFAULT_PERSONALITY,
  size: 1,
  stayStill: false,
  stayPose: 'sentado',
  sleepAfterMin: 5,       // fall asleep after this many minutes without mouse/keyboard; 0 = never
  weatherEnabled: true,   // let weather influence mood (uses approximate location, see mood.js)
  locationOverride: '',   // city name; empty = approximate location from IP
  aiProvider: 'anthropic',
  aiModels: DEFAULT_MODELS, // model chosen per provider, e.g. { anthropic: 'claude-opus-5-5', groq: '...' }
  customBaseURL: '',
  securityLevel: 'guarded',
  actionPerms: DEFAULT_PERMS,
};

const VALIDATORS = {
  personality: v => (PERSONALITIES[v] ? v : null),
  size: v => (typeof v === 'number' && Number.isFinite(v)
    ? Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, v)) * 100) / 100 : null),
  stayStill: v => (typeof v === 'boolean' ? v : null),
  stayPose: v => (STAY_POSES.some(p => p.id === v) ? v : null),
  sleepAfterMin: v => (Number.isInteger(v) && v >= 0 && v <= 240 ? v : null),
  weatherEnabled: v => (typeof v === 'boolean' ? v : null),
  aiProvider: v => (PROVIDER_IDS.includes(v) ? v : null),
  aiModels: v => {
    if (!v || typeof v !== 'object') return null;
    const out = { ...DEFAULT_MODELS };
    for (const id of PROVIDER_IDS) {
      const m = typeof v[id] === 'string' ? v[id].trim() : undefined;
      if (m === undefined) continue;
      if (m !== '' && !MODEL_RE.test(m)) return null;
      out[id] = m;
    }
    return out;
  },
  customBaseURL: v => (typeof v === 'string' ? validBaseURL(v.trim()) : null),
  securityLevel: v => (LEVELS.includes(v) ? v : null),
  actionPerms: v => validatePerms(v),
  locationOverride: v => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) : null),
};

class Settings extends EventEmitter {
  constructor() {
    super();
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.data = { ...DEFAULTS };
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    // Older versions stored one model setting per provider.
    if (!saved.aiModels && (saved.anthropicModel || saved.openaiModel || saved.customModel)) {
      saved.aiModels = { anthropic: saved.anthropicModel, openai: saved.openaiModel, custom: saved.customModel };
    }
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
    if (JSON.stringify(v) === JSON.stringify(this.data[key])) return;
    this.data[key] = v;
    // Debounced write: the size slider fires many changes per second.
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this._write(); }, 300);
    this.emit('change', key, v);
  }

  // Write any pending change now (called on quit so a last-second change isn't lost).
  flush() { if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; this._write(); } }

  _write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

module.exports = { Settings, SIZE_MIN, SIZE_MAX };
