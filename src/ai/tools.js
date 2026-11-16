// Computer-control tools offered to the model, in a provider-neutral shape:
//   { name, description, schema (JSON Schema), toggle }
// plus classify(name, input) -> the permission-policy actions a call needs, and
// validate(name, input) -> error string or null (models can send malformed input).
const { ACTIONS } = require('./permissions');

const reason = { type: 'string', description: 'One short sentence telling the user why you are doing this.' };
const effect = {
  type: 'string',
  enum: ['routine', 'destructive', 'send_message', 'purchase'],
  description: 'What this does: "routine" for ordinary navigation and editing; "destructive" if it deletes, '
    + 'overwrites, closes without saving or cannot be undone; "send_message" if it sends or posts something to '
    + 'other people; "purchase" if it spends money. When unsure, do not choose "routine".',
};

const TOOLS = [
  { name: 'take_screenshot', toggle: 'screen',
    description: 'Capture the screen. Returns an image; click coordinates use this image\'s pixel grid. Always look before clicking.',
    schema: { type: 'object', properties: { reason }, required: ['reason'], additionalProperties: false } },
  { name: 'click', toggle: 'mouseKeyboard',
    description: 'Click at a point given in the pixel coordinates of the most recent screenshot.',
    schema: { type: 'object', properties: {
      x: { type: 'number' }, y: { type: 'number' },
      button: { type: 'string', enum: ['left', 'right'] },
      clicks: { type: 'integer', enum: [1, 2] },
      effect, reason,
    }, required: ['x', 'y', 'effect', 'reason'], additionalProperties: false } },
  { name: 'type_text', toggle: 'mouseKeyboard',
    description: 'Type text into whatever currently has keyboard focus. Click the field first.',
    schema: { type: 'object', properties: { text: { type: 'string' }, effect, reason },
      required: ['text', 'effect', 'reason'], additionalProperties: false } },
  { name: 'press_key', toggle: 'mouseKeyboard',
    description: 'Press a key or shortcut, e.g. "return", "tab", "escape", "cmd+c", "cmd+shift+s", "down".',
    schema: { type: 'object', properties: { keys: { type: 'string' }, effect, reason },
      required: ['keys', 'effect', 'reason'], additionalProperties: false } },
  { name: 'scroll', toggle: 'mouseKeyboard',
    description: 'Scroll at a point (screenshot coordinates). Positive dy scrolls down.',
    schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, dy: { type: 'number' }, reason },
      required: ['x', 'y', 'dy', 'reason'], additionalProperties: false } },
  { name: 'open_app', toggle: 'openApps',
    description: 'Open (or bring forward) an application by name, e.g. "Safari", "Notes".',
    schema: { type: 'object', properties: { name: { type: 'string' }, reason },
      required: ['name', 'reason'], additionalProperties: false } },
  { name: 'read_file', toggle: 'fileRead',
    description: 'Read a text file inside the user\'s home folder. Path may start with ~.',
    schema: { type: 'object', properties: { path: { type: 'string' }, reason },
      required: ['path', 'reason'], additionalProperties: false } },
  { name: 'list_folder', toggle: 'fileRead',
    description: 'List the files in a folder inside the user\'s home folder.',
    schema: { type: 'object', properties: { path: { type: 'string' }, reason },
      required: ['path', 'reason'], additionalProperties: false } },
  { name: 'write_file', toggle: 'fileWrite',
    description: 'Create or overwrite a text file inside the user\'s home folder.',
    schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, reason },
      required: ['path', 'content', 'reason'], additionalProperties: false } },
  { name: 'delete_file', toggle: 'fileWrite',
    description: 'Move a file or folder inside the user\'s home folder to the Trash.',
    schema: { type: 'object', properties: { path: { type: 'string' }, reason },
      required: ['path', 'reason'], additionalProperties: false } },
  { name: 'schedule_task', toggle: null,
    description: 'Create a repeating task that Tito runs on a timer until the user removes it, e.g. press a key every few minutes. The user must approve it.',
    schema: { type: 'object', properties: {
      kind: { type: 'string', enum: ['key', 'type', 'open'], description: '"key" = press a key or shortcut, "type" = type text, "open" = open an app' },
      value: { type: 'string', description: 'The key (e.g. "space"), the text, or the app name.' },
      every_seconds: { type: 'integer', description: 'Interval in seconds (10 to 86400).' },
      reason,
    }, required: ['kind', 'value', 'every_seconds', 'reason'], additionalProperties: false } },
  { name: 'list_tasks', toggle: null,
    description: "List the user's repeating tasks with their ids.",
    schema: { type: 'object', properties: { reason }, required: ['reason'], additionalProperties: false } },
  { name: 'cancel_task', toggle: null,
    description: 'Remove a repeating task by id (see list_tasks).',
    schema: { type: 'object', properties: { id: { type: 'string' }, reason }, required: ['id', 'reason'], additionalProperties: false } },
];
const BY_NAME = Object.fromEntries(TOOLS.map(t => [t.name, t]));

// Shortcuts that can lose work even if the model called them routine.
const RISKY_KEYS = /^(cmd\+q|cmd\+w|cmd\+shift\+w|cmd\+option\+w|cmd\+alt\+w|cmd\+delete|cmd\+backspace|cmd\+shift\+delete|cmd\+shift\+backspace|cmd\+option\+escape|cmd\+alt\+escape)$/;

// -> [{ action, destructive }] : every entry must be permitted; the strictest answer wins.
function classify(name, input = {}) {
  switch (name) {
    case 'take_screenshot': return [{ action: 'screenshot' }];
    case 'read_file': case 'list_folder': return [{ action: 'fileRead' }];
    case 'write_file': return [{ action: 'fileWrite' }];
    case 'delete_file': return [{ action: 'fileDelete' }];
    case 'open_app': return [{ action: 'openApp' }];
    case 'scroll': return [{ action: 'scroll' }];
    case 'schedule_task': {
      const under = { key: 'key', type: 'type', open: 'openApp' }[input.kind];
      return [{ action: 'scheduleTask' }, ...(under ? [{ action: under }] : [])];
    }
    case 'list_tasks': case 'cancel_task': return [{ action: 'manageTasks' }];
    case 'click': case 'type_text': case 'press_key': {
      const base = name === 'click' ? 'click' : name === 'type_text' ? 'type' : 'key';
      const keys = String(input.keys || '').toLowerCase().replace(/\s+/g, '');
      const destructive = input.effect !== 'routine' || (name === 'press_key' && RISKY_KEYS.test(keys));
      const out = [{ action: base, destructive }];
      if (input.effect === 'send_message') out.push({ action: 'sendMessage' });
      if (input.effect === 'purchase') out.push({ action: 'purchase' });
      return out;
    }
    default: return null;
  }
}

function validate(name, input) {
  const t = BY_NAME[name];
  if (!t) return `Unknown tool "${name}".`;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Tool input must be an object.';
  const { properties, required } = t.schema;
  for (const k of required) if (input[k] === undefined || input[k] === null) return `Missing "${k}".`;
  for (const [k, v] of Object.entries(input)) {
    const spec = properties[k];
    if (!spec) return `Unexpected field "${k}".`;
    if (spec.type === 'number' && !(typeof v === 'number' && Number.isFinite(v))) return `"${k}" must be a number.`;
    if (spec.type === 'integer' && !Number.isInteger(v)) return `"${k}" must be a whole number.`;
    if (spec.type === 'string' && typeof v !== 'string') return `"${k}" must be text.`;
    if (spec.enum && !spec.enum.includes(v)) return `"${k}" must be one of: ${spec.enum.join(', ')}.`;
  }
  if (typeof input.text === 'string' && input.text.length > 5000) return 'Text is too long (max 5000 characters).';
  if (typeof input.content === 'string' && input.content.length > 500000) return 'File content is too large.';
  if (typeof input.keys === 'string' && !/^[a-z0-9+\-=\[\];',./\\` ]{1,40}$/i.test(input.keys)) return 'Unrecognised key combination.';
  return null;
}

// Tools available under the current settings (Lockdown -> none; switched-off categories omitted).
function availableTools(level, perms) {
  if (level === 'lockdown') return [];
  return TOOLS.filter(t => t.toggle === null || (perms && perms[t.toggle] === true));
}

// Sanity: every classified action exists in the policy table.
for (const t of TOOLS) for (const c of classify(t.name, { effect: 'purchase', kind: 'key' }) || []) {
  if (!ACTIONS[c.action]) throw new Error(`tools.js: unknown policy action ${c.action}`);
}

module.exports = { TOOLS, classify, validate, availableTools };
