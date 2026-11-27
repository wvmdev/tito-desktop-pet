// The Windows backend for the executor (same shape as mac-backend.js): screenshots (Electron
// desktopCapturer + on-device redaction), mouse/keyboard (bin-win/tito-input.exe), opening apps from the
// Start menu, moving files to the Recycle Bin. Windows needs no permission prompts for any of this; the
// one limit is that Windows blocks a normal program from typing into an app running as administrator.
const { BrowserWindow, desktopCapturer, screen, shell, nativeImage } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { patternsWith } = require('./redact');
const { redactImage } = require('./redact-image');

const ROOT = path.join(__dirname, '..', '..');
const HELPER = name => path.join(ROOT, 'bin-win', name);
const SCRIPT = name => path.join(ROOT, 'native', 'windows', name);
const OCR_WIDTH = 1920;   // the screenshot is read at (up to) this width so small text is still found
const SEND_WIDTH = 1280;  // and sent at this width, like on the Mac

// Programs that give a shell: opening one by name is not what "open an app" means.
const NOT_APPS = /^(cmd|command|powershell|powershell_ise|pwsh|wscript|cscript|mshta|bash|wsl|regedit|reg|rundll32|msiexec|certutil|bitsadmin|mmc|control)(\.exe)?$/i;

function runHelper(bin, args, stdin, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin == null ? '' : stdin);
  });
}

function createWinBackend({ getPetDisplayPoint }) {
  return {
    ownWindowRects: () => BrowserWindow.getAllWindows().filter(w => !w.isDestroyed() && w.isVisible() && w.getOpacity() > 0.05).map(w => w.getBounds()),
    ownWindowFocused: () => !!BrowserWindow.getFocusedWindow(),

    async capture({ secrets }) {
      const display = screen.getDisplayNearestPoint(getPetDisplayPoint());
      const physW = Math.round(display.bounds.width * display.scaleFactor);
      const width = Math.min(OCR_WIDTH, physW);
      const height = Math.round(width * display.bounds.height / display.bounds.width);
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
      const src = sources.find(s => String(s.display_id) === String(display.id)) || sources[0];
      if (!src || src.thumbnail.isEmpty()) throw new Error('Windows would not let Tito capture the screen.');

      // Redact on-device before the image goes anywhere. No redaction -> no screenshot.
      let red;
      try { red = await redactImage(src.thumbnail.toPNG(), { secrets, patterns: patternsWith(secrets) }); }
      catch (e) { throw new Error('Could not check the screenshot for secrets, so it was not sent.'); }
      let img = nativeImage.createFromBuffer(red.jpeg);
      if (red.width > SEND_WIDTH) img = img.resize({ width: SEND_WIDTH, quality: 'best' });
      const size = img.getSize();
      return {
        base64: img.toJPEG(72).toString('base64'),
        redacted: red.redacted,
        geometry: { scale: size.width / display.bounds.width, originX: display.bounds.x, originY: display.bounds.y, width: size.width, height: size.height },
      };
    },

    async input(args, stdin) {
      const bin = HELPER('tito-input.exe');
      if (!fs.existsSync(bin)) throw new Error('Tito\'s input helper is missing, so it cannot use the mouse or keyboard.');
      // Points arrive in Electron's units; the helper wants real screen pixels.
      if ((args[0] === 'click' || args[0] === 'scroll') && args.length >= 3) {
        const p = screen.dipToScreenPoint({ x: Number(args[1]), y: Number(args[2]) });
        args = [args[0], String(p.x), String(p.y), ...args.slice(3)];
      }
      const r = await runHelper(bin, args, stdin);
      if (r.code !== 0) throw new Error(r.err.trim() || 'The input helper failed.');
    },

    openApp: name => new Promise((resolve, reject) => {
      if (NOT_APPS.test(name)) return reject(new Error(`"${name}" is not an app Tito may open.`));
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT('open-app.ps1'), name],
        { timeout: 25000, windowsHide: true }, err => (err ? reject(new Error(`Could not open "${name}". Is it installed?`)) : resolve()));
    }),

    trash: p => shell.trashItem(p),
  };
}

module.exports = { createWinBackend, runHelper, NOT_APPS };
