// Computer-control permission model (used by phase 7's tool runner; defined and tested now).
//
// decide(action, { level, perms, destructive }) -> { decision: 'allow' | 'ask' | 'deny', reason }
//
// Security levels (Settings):
//   lockdown  no computer control at all: chat only
//   guarded   (default) may look/read (screenshots, file reads); every other action asks first
//   trusted   routine actions run without asking; destructive/irreversible ones still ask
//   full      everything runs without asking (explicit opt-in with a warning)
// Per-action toggles sit on top: a switched-off category is always denied, at every level.
//
// Only the user's own click on a confirmation popup counts as approval. Text found in a
// screenshot, file, web page or model output is data, never a "yes" and never a command.

const LEVELS = ['lockdown', 'guarded', 'trusted', 'full'];

// Toggle categories shown in Settings, with defaults.
const PERM_TOGGLES = [
  { id: 'screen', label: 'See the screen (screenshots)', default: true },
  { id: 'mouseKeyboard', label: 'Control mouse and keyboard', default: true },
  { id: 'fileRead', label: 'Read files', default: true },
  { id: 'fileWrite', label: 'Write and delete files', default: true },
  { id: 'openApps', label: 'Open apps', default: true },
  { id: 'sendMessages', label: 'Send messages on my behalf', default: false },
];
const DEFAULT_PERMS = Object.fromEntries(PERM_TOGGLES.map(t => [t.id, t.default]));

// risk: observe (look/read), routine (low-risk change), destructive (irreversible / outward-facing)
const ACTIONS = {
  screenshot: { toggle: 'screen', risk: 'observe' },
  fileRead: { toggle: 'fileRead', risk: 'observe' },
  click: { toggle: 'mouseKeyboard', risk: 'routine' },
  type: { toggle: 'mouseKeyboard', risk: 'routine' },
  key: { toggle: 'mouseKeyboard', risk: 'routine' },
  scroll: { toggle: 'mouseKeyboard', risk: 'routine' },
  openApp: { toggle: 'openApps', risk: 'routine' },
  fileWrite: { toggle: 'fileWrite', risk: 'destructive' }, // can overwrite existing work
  fileDelete: { toggle: 'fileWrite', risk: 'destructive' },
  sendMessage: { toggle: 'sendMessages', risk: 'destructive' },
  closeApp: { toggle: 'openApps', risk: 'destructive' }, // may discard unsaved work
  purchase: { toggle: 'mouseKeyboard', risk: 'destructive' },
  // Creating a repeating task is a standing rule: it always needs the user's OK, at every level.
  scheduleTask: { toggle: null, risk: 'standing' },
  manageTasks: { toggle: null, risk: 'observe' }, // list / cancel
};

function decide(action, { level = 'guarded', perms = DEFAULT_PERMS, destructive = false } = {}) {
  const a = ACTIONS[action];
  if (!a) return { decision: 'deny', reason: `Unknown action "${action}"` };
  if (!LEVELS.includes(level)) level = 'guarded';
  if (level === 'lockdown') return { decision: 'deny', reason: 'Security level is Lockdown (chat only)' };
  if (a.toggle && (!perms || perms[a.toggle] !== true)) return { decision: 'deny', reason: `"${label(a.toggle)}" is switched off in Settings` };
  if (a.risk === 'standing') return { decision: 'ask', reason: 'Repeating tasks always need your OK' };
  // A routine action becomes destructive when what it targets is (e.g. clicking "Delete" or "Send").
  const risk = destructive ? 'destructive' : a.risk;
  if (level === 'full') return { decision: 'allow', reason: 'Full Access' };
  if (level === 'trusted') return risk === 'destructive' ? { decision: 'ask', reason: 'Destructive or irreversible' } : { decision: 'allow', reason: 'Trusted: routine action' };
  // guarded
  return risk === 'observe' ? { decision: 'allow', reason: 'Guarded: looking/reading only' } : { decision: 'ask', reason: 'Guarded: confirm every change' };
}

const label = id => (PERM_TOGGLES.find(t => t.id === id) || { label: id }).label;

function validatePerms(v) {
  if (!v || typeof v !== 'object') return null;
  const out = { ...DEFAULT_PERMS };
  for (const t of PERM_TOGGLES) if (typeof v[t.id] === 'boolean') out[t.id] = v[t.id];
  return out;
}

module.exports = { LEVELS, PERM_TOGGLES, DEFAULT_PERMS, ACTIONS, decide, validatePerms };
