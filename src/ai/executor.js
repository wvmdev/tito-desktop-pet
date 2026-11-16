// Runs one (already permitted) tool call and returns { text, image?, isError? }.
// The executor never decides *whether* something is allowed (see agent.js + permissions.js); it
// enforces the rules that hold at every level:
//   - files only inside the allowed roots (the user's home), never credential stores
//   - never click or type into Tito's own windows (so the model can't change Tito's settings
//     or answer its own confirmation prompts)
//   - everything read is scrubbed of secrets before it is returned for the model
// `backend` does the real work (mac-backend.js); tests inject a fake one.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { redactText } = require('./redact');

const MAX_READ = 200 * 1024;
const MAX_LIST = 200;

// Paths that are off-limits even inside the home folder.
const SENSITIVE = [
  /\/\.ssh(\/|$)/, /\/\.gnupg(\/|$)/, /\/\.aws(\/|$)/, /\/\.kube(\/|$)/, /\/\.docker\/config\.json$/,
  /\/\.netrc$/, /\/\.npmrc$/, /\/\.env(\.[^/]*)?$/, /\/\.git-credentials$/,
  /\/Library\/Keychains(\/|$)/, /\/Library\/Cookies(\/|$)/, /\/Library\/Application Support\/tito-desktop-pet(\/|$)/,
  /\/Library\/Application Support\/[^/]*\/(Cookies|Login Data|Local Storage)(\/|$)/,
  /\/(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$/, /\.(pem|p12|pfx|keychain|keychain-db)$/i,
];

class Executor {
  constructor({ backend, roots = [os.homedir()], tasks = null }) {
    this.backend = backend;
    this.tasks = tasks; // TaskScheduler, for the schedule_task / list_tasks / cancel_task tools
    this.roots = roots.map(r => fs.realpathSync(r));
    this.shot = null; // geometry of the latest screenshot, for mapping click coordinates
  }

  // ---- paths ----
  _resolve(p, { mustExist = true } = {}) {
    if (typeof p !== 'string' || !p.trim()) throw new Error('No path given.');
    let full = p.trim();
    if (full === '~' || full.startsWith('~/')) full = path.join(os.homedir(), full.slice(1));
    full = path.resolve(os.homedir(), full);
    // Resolve symlinks on the deepest existing ancestor so links can't lead outside the roots.
    let probe = full;
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    const real = path.join(fs.realpathSync(probe), path.relative(probe, full));
    if (!this.roots.some(r => real === r || real.startsWith(r + path.sep))) throw new Error("That path is outside the user's home folder, which Tito may not touch.");
    if (SENSITIVE.some(re => re.test(real))) throw new Error('That location holds credentials or private app data; Tito may not access it.');
    if (mustExist && !fs.existsSync(real)) throw new Error('No such file or folder.');
    return real;
  }

  // ---- screen geometry ----
  _toScreen(x, y) {
    if (!this.shot) throw new Error('Take a screenshot first so the coordinates mean something.');
    const { scale, originX, originY, width, height } = this.shot;
    if (x < 0 || y < 0 || x > width || y > height) throw new Error(`Point is outside the screenshot (${width}x${height}).`);
    return { sx: Math.round(originX + x / scale), sy: Math.round(originY + y / scale) };
  }
  _guardOwnWindows(sx, sy) {
    for (const r of this.backend.ownWindowRects()) {
      if (sx >= r.x && sx < r.x + r.width && sy >= r.y && sy < r.y + r.height) {
        throw new Error("That point is on one of Tito's own windows, which Tito may not control.");
      }
    }
  }
  _guardOwnFocus() {
    if (this.backend.ownWindowFocused()) throw new Error("Tito's own window has keyboard focus. Click inside the target app first.");
  }

  async run(name, input, { secrets = [], signal } = {}) {
    const clean = text => redactText(text, secrets).text;
    try {
      if (signal && signal.aborted) throw new Error('Stopped by the user.');
      switch (name) {
        case 'take_screenshot': {
          const shot = await this.backend.capture({ secrets });
          this.shot = shot.geometry;
          const note = shot.redacted ? ` ${shot.redacted} secret-looking item(s) were blacked out.` : '';
          return { text: `Screenshot ${shot.geometry.width}x${shot.geometry.height} pixels. Use these pixel coordinates for click and scroll.${note}`,
            image: { mediaType: 'image/jpeg', base64: shot.base64 } };
        }
        case 'click': {
          const { sx, sy } = this._toScreen(input.x, input.y);
          this._guardOwnWindows(sx, sy);
          await this.backend.input(['click', String(sx), String(sy), input.button || 'left', String(input.clicks || 1)]);
          return { text: `Clicked at (${Math.round(input.x)}, ${Math.round(input.y)}).` };
        }
        case 'scroll': {
          const { sx, sy } = this._toScreen(input.x, input.y);
          this._guardOwnWindows(sx, sy);
          const dy = Math.max(-2000, Math.min(2000, Math.round(input.dy)));
          await this.backend.input(['scroll', String(sx), String(sy), '0', String(-dy)]);
          return { text: `Scrolled ${dy > 0 ? 'down' : 'up'} ${Math.abs(dy)}px.` };
        }
        case 'type_text': {
          this._guardOwnFocus();
          await this.backend.input(['type'], input.text);
          return { text: `Typed ${input.text.length} character(s).` };
        }
        case 'press_key': {
          this._guardOwnFocus();
          const keys = input.keys.toLowerCase().replace(/\s+/g, '');
          await this.backend.input(['key', keys]);
          return { text: `Pressed ${keys}.` };
        }
        case 'open_app': {
          const app = input.name.trim();
          if (!/^[\w .&+\-']{1,80}$/.test(app)) throw new Error('That does not look like an app name.');
          await this.backend.openApp(app);
          return { text: `Opened ${app}.` };
        }
        case 'read_file': {
          const p = this._resolve(input.path);
          const st = fs.statSync(p);
          if (st.isDirectory()) throw new Error('That is a folder; use list_folder.');
          if (st.size > MAX_READ) throw new Error(`File is too large to read (${Math.round(st.size / 1024)} KB; limit ${MAX_READ / 1024} KB).`);
          const buf = fs.readFileSync(p);
          if (buf.includes(0)) throw new Error('That is not a text file.');
          return { text: clean(buf.toString('utf8')) || '(empty file)' };
        }
        case 'list_folder': {
          const p = this._resolve(input.path);
          if (!fs.statSync(p).isDirectory()) throw new Error('That is a file, not a folder.');
          const names = fs.readdirSync(p, { withFileTypes: true })
            .filter(d => !SENSITIVE.some(re => re.test(path.join(p, d.name))))
            .map(d => (d.isDirectory() ? `${d.name}/` : d.name)).sort();
          const shown = names.slice(0, MAX_LIST);
          return { text: clean(shown.join('\n') + (names.length > shown.length ? `\n… and ${names.length - shown.length} more` : '')) || '(empty folder)' };
        }
        case 'write_file': {
          const p = this._resolve(input.path, { mustExist: false });
          if (fs.existsSync(p) && fs.statSync(p).isDirectory()) throw new Error('A folder with that name already exists.');
          const existed = fs.existsSync(p);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, input.content);
          return { text: `${existed ? 'Overwrote' : 'Created'} ${path.basename(p)} (${input.content.length} characters).` };
        }
        case 'delete_file': {
          const p = this._resolve(input.path);
          if (this.roots.includes(p)) throw new Error('Tito will not delete the home folder.');
          await this.backend.trash(p);
          return { text: `Moved ${path.basename(p)} to the Trash.` };
        }
        case 'schedule_task': {
          if (!this.tasks) throw new Error('Scheduling is not available.');
          const t = this.tasks.add({ kind: input.kind, value: input.value, everySec: input.every_seconds });
          return { text: `Scheduled (id ${t.id}). It repeats until removed in Settings or with cancel_task.` };
        }
        case 'list_tasks': {
          if (!this.tasks) throw new Error('Scheduling is not available.');
          const all = this.tasks.list();
          return { text: clean(all.length ? all.map(t => `${t.id}: ${t.summary}${t.enabled ? '' : ' (off)'}`).join('\n') : 'No scheduled tasks.') };
        }
        case 'cancel_task': {
          if (!this.tasks) throw new Error('Scheduling is not available.');
          if (!this.tasks.remove(String(input.id))) throw new Error('No task with that id.');
          return { text: 'Removed.' };
        }
        default:
          throw new Error(`Unknown tool "${name}".`);
      }
    } catch (err) {
      const e = { text: clean(err && err.message ? err.message : 'The action failed.'), isError: true };
      if (err && err.permission) e.permission = err.permission; // 'accessibility' | 'screen'
      return e;
    }
  }
}

module.exports = { Executor, SENSITIVE };
