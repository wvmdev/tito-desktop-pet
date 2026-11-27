// Windows: runs native/windows/TitoWindows.cs (bin-win/tito-windows.exe) and turns what it prints into events.
//   'windows' -> [{ id, pid, x, y, w, h }, ...]  front to back, in Electron's device-independent pixels
//   'audio'   -> true | false                     is sound playing right now
//   'battery' -> { percent, charging } | null     null on a desktop PC
// The helper sends physical pixels; `toDip` (screen.screenToDipRect in the app) converts them so the
// brain sees the same coordinates Electron uses for windows. If the helper stops it is restarted a few
// times; if it cannot run at all (blocked, missing) Tito simply stays on the taskbar and the floor.
const EventEmitter = require('events');

const MAX_RESTARTS = 4;
const RESTART_MS = 3000;

class WinFeed extends EventEmitter {
  constructor({ spawn, bin, ownPid = process.pid, toDip = r => r, intervalMs = 250, exists = () => true }) {
    super();
    Object.assign(this, { spawn, bin, ownPid, toDip, intervalMs, exists });
    this.child = null;
    this.buf = '';
    this.restarts = 0;
    this.stopped = false;
    this.battery = null;
  }

  start() {
    if (this.child || this.stopped) return false;
    if (!this.exists(this.bin)) { this.emit('unavailable', 'the window helper is missing'); return false; }
    let child;
    try {
      child = this.spawn(this.bin, [String(this.ownPid), String(this.intervalMs), String(process.pid)], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch (err) { this.emit('unavailable', err.message); return false; }
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.write(chunk));
    child.on('error', err => { this.child = null; this.emit('unavailable', err.message); });
    child.on('exit', () => {
      this.child = null;
      if (this.stopped) return;
      if (this.restarts++ < MAX_RESTARTS) this._timer = setTimeout(() => this.start(), RESTART_MS);
      else this.emit('unavailable', 'the window helper keeps stopping');
    });
    return true;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this._timer);
    if (this.child) { try { this.child.kill(); } catch { /* already gone */ } this.child = null; }
  }

  // Feed raw helper output (may arrive in pieces); every complete line is handled.
  write(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.handleLine(line);
    }
    if (this.buf.length > 1e6) this.buf = ''; // never grow without bound on garbage
  }

  handleLine(line) {
    let v;
    try { v = JSON.parse(line); } catch { return; } // a partial line
    if (Array.isArray(v)) {
      const out = [];
      for (const w of v) {
        if (!w || ![w.x, w.y, w.w, w.h].every(Number.isFinite)) continue;
        const r = this.toDip({ x: w.x, y: w.y, width: w.w, height: w.h });
        out.push({ id: w.id, pid: w.pid, x: r.x, y: r.y, w: r.width, h: r.height });
      }
      this.emit('windows', out);
    } else if (v && typeof v === 'object') {
      if (typeof v.audio === 'boolean') this.emit('audio', v.audio);
      if ('battery' in v) {
        const b = v.battery && Number.isFinite(v.battery.percent) ? { percent: v.battery.percent, charging: !!v.battery.charging } : null;
        this.battery = b;
        this.emit('battery', b);
      }
    }
  }
}

module.exports = { WinFeed, MAX_RESTARTS };
