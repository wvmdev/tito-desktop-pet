// Scheduled tasks: simple actions Tito repeats on a timer ("press space every 6 minutes").
// A task only exists because the user created it themselves: in Settings, or by approving the
// confirmation popup when asking in chat. Each run still respects the security settings
// (Lockdown or a switched-off category skips it) and can be paused from the menu-bar icon.
const EventEmitter = require('events');
const { decide } = require('./ai/permissions');

const MIN_EVERY = 10;          // seconds
const MAX_EVERY = 24 * 3600;
const MAX_TASKS = 20;
const KINDS = {
  key: { tool: 'press_key', action: 'key', input: v => ({ keys: v, effect: 'routine', reason: 'scheduled task' }) },
  type: { tool: 'type_text', action: 'type', input: v => ({ text: v, effect: 'routine', reason: 'scheduled task' }) },
  open: { tool: 'open_app', action: 'openApp', input: v => ({ name: v, reason: 'scheduled task' }) },
};
const KEY_RE = /^[a-z0-9+\-=\[\];',./\\`]{1,40}$/i;

function fmtEvery(sec) {
  if (sec % 3600 === 0) return `${sec / 3600} h`;
  if (sec % 60 === 0) return `${sec / 60} min`;
  return `${sec} s`;
}
function describeTask(t) {
  const what = t.kind === 'key' ? `Press ${t.value}` : t.kind === 'open' ? `Open ${t.value}` : `Type "${t.value.length > 40 ? `${t.value.slice(0, 39)}…` : t.value}"`;
  return `${what} every ${fmtEvery(t.everySec)}`;
}

// Returns a clean task or throws with a message fit to show the user / the model.
function cleanTask(t) {
  if (!t || typeof t !== 'object') throw new Error('Invalid task.');
  if (!KINDS[t.kind]) throw new Error('Task kind must be "key", "type" or "open".');
  let value = typeof t.value === 'string' ? t.value.trim() : '';
  if (t.kind === 'type') value = typeof t.value === 'string' ? t.value : '';
  if (!value) throw new Error('The task needs a key, some text or an app name.');
  if (t.kind === 'key') { value = value.toLowerCase().replace(/\s+/g, ''); if (!KEY_RE.test(value)) throw new Error('That key combination is not recognised.'); }
  if (t.kind === 'type' && value.length > 500) throw new Error('Text is too long (max 500 characters).');
  if (t.kind === 'open' && !/^[\w .&+\-']{1,80}$/.test(value)) throw new Error('That does not look like an app name.');
  const everySec = Math.round(Number(t.everySec));
  if (!Number.isFinite(everySec) || everySec < MIN_EVERY || everySec > MAX_EVERY) throw new Error(`The interval must be between ${MIN_EVERY} seconds and 24 hours.`);
  const id = typeof t.id === 'string' && /^[a-z0-9]{4,16}$/.test(t.id) ? t.id : Math.random().toString(36).slice(2, 10);
  return { id, kind: t.kind, value, everySec, enabled: t.enabled !== false };
}

function validateTasks(v) {
  if (!Array.isArray(v) || v.length > MAX_TASKS) return null;
  try { return v.map(cleanTask); } catch { return null; }
}

class TaskScheduler extends EventEmitter {
  /** deps: settings, getExecutor(), getSecrets() */
  constructor({ settings, getExecutor, getSecrets }) {
    super();
    this.settings = settings;
    this.getExecutor = getExecutor;
    this.getSecrets = getSecrets;
    this.timers = new Map();
    this.status = {}; // id -> { at, ok, text }
  }

  list() { return this.settings.get('tasks').map(t => ({ ...t, summary: describeTask(t), last: this.status[t.id] || null })); }

  add(task) {
    const t = cleanTask(task);
    const all = this.settings.get('tasks');
    if (all.length >= MAX_TASKS) throw new Error(`There can be at most ${MAX_TASKS} tasks.`);
    this.settings.set('tasks', [...all, t]);
    return t;
  }

  remove(id) {
    const all = this.settings.get('tasks');
    if (!all.some(t => t.id === id)) return false;
    this.settings.set('tasks', all.filter(t => t.id !== id));
    delete this.status[id];
    return true;
  }

  // (Re)start timers to match settings. Call after any change to tasks / tasksPaused.
  sync() {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    if (this.settings.get('tasksPaused')) return;
    for (const task of this.settings.get('tasks')) {
      if (task.enabled) this.timers.set(task.id, setInterval(() => this.runNow(task.id), task.everySec * 1000));
    }
  }

  async runNow(id) {
    const task = this.settings.get('tasks').find(t => t.id === id);
    if (!task) return null;
    const kind = KINDS[task.kind];
    const v = decide(kind.action, { level: this.settings.get('securityLevel'), perms: this.settings.get('actionPerms') });
    let result;
    if (v.decision === 'deny') result = { ok: false, text: `Skipped: ${v.reason}` };
    else {
      const out = await this.getExecutor().run(kind.tool, kind.input(task.value), { secrets: this.getSecrets() });
      result = { ok: !out.isError, text: out.text };
    }
    this.status[id] = { at: Date.now(), ...result };
    this.emit('ran', id, this.status[id]);
    return this.status[id];
  }

  stop() { for (const t of this.timers.values()) clearInterval(t); this.timers.clear(); }
}

module.exports = { TaskScheduler, validateTasks, cleanTask, describeTask, fmtEvery, MIN_EVERY, MAX_EVERY };
