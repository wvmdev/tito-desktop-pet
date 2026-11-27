// What is going on around Tito, without any screen access: is audio playing? (macOS keeps a
// "prevent idle sleep" assertion for playing audio, which `pmset -g assertions` lists. On Windows the
// window helper reports the output's peak meter, see winfeed.js, and calls push().)
const { execFile } = require('child_process');
const EventEmitter = require('events');

const POLL_MS = 12 * 1000;
const AUDIO_RE = /com\.apple\.audio\.[^\n]*preventuseridlesleep/i;

function audioPlaying() {
  return new Promise(resolve => {
    if (process.platform !== 'darwin') return resolve(false);
    execFile('pmset', ['-g', 'assertions'], { timeout: 4000 }, (err, out) => resolve(!err && AUDIO_RE.test(String(out))));
  });
}

class Awareness extends EventEmitter {
  constructor() { super(); this.music = false; this._timer = null; }
  start() {
    if (process.platform === 'win32') return; // Windows pushes updates instead, see push()
    this._timer = setInterval(() => this.poll(), POLL_MS);
    this.poll();
  }
  push(now) { // an update from outside (the Windows helper)
    now = !!now;
    if (now !== this.music) { this.music = now; this.emit('music', now); }
  }
  stop() { clearInterval(this._timer); }
  async poll() {
    const now = await audioPlaying();
    if (now !== this.music) { this.music = now; this.emit('music', now); }
  }
}

module.exports = { Awareness, audioPlaying, AUDIO_RE };
