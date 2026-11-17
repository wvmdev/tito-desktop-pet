// What is going on around Tito, without any screen access: is audio playing? (macOS keeps a
// "prevent idle sleep" assertion for playing audio, which `pmset -g assertions` lists.)
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
    this._timer = setInterval(() => this.poll(), POLL_MS);
    this.poll();
  }
  stop() { clearInterval(this._timer); }
  async poll() {
    const now = await audioPlaying();
    if (now !== this.music) { this.music = now; this.emit('music', now); }
  }
}

module.exports = { Awareness, audioPlaying, AUDIO_RE };
