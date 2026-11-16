// The real macOS backend for the executor: screenshots (Electron desktopCapturer + on-device
// redaction), mouse/keyboard (bin/tito-input), opening apps, moving files to the Trash.
// When macOS denies Accessibility or Screen Recording, the matching System Settings pane is
// opened and the error says so, instead of failing silently.
const { BrowserWindow, desktopCapturer, screen, shell, systemPreferences } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { patternsWith } = require('./redact');

const ROOT = path.join(__dirname, '..', '..');
const BIN = name => path.join(ROOT, 'bin', name);
const SRC = name => path.join(ROOT, 'native', `${name}.swift`);
const MAX_SHOT_WIDTH = 1280;

const PANES = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
};

function permissionError(kind) {
  shell.openExternal(PANES[kind]);
  const what = kind === 'screen' ? 'Screen Recording' : 'Accessibility';
  return Object.assign(new Error(`macOS has not given Tito the ${what} permission. System Settings was opened on that page: `
    + 'switch it on for the app that runs Tito, then try again.'), { permission: kind });
}

// Build a helper from source on first use (needs the Xcode command line tools).
const building = {};
function ensureHelper(name, source) {
  const bin = BIN(name);
  if (fs.existsSync(bin)) return Promise.resolve(bin);
  if (!building[name]) {
    building[name] = new Promise((resolve, reject) => {
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      execFile('swiftc', ['-O', SRC(source), '-o', bin], { timeout: 240000 }, err => {
        delete building[name];
        if (err) reject(new Error(`Could not build the ${name} helper (the Xcode command line tools are needed).`));
        else resolve(bin);
      });
    });
  }
  return building[name];
}

function runHelper(bin, args, stdin, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
    child.stdin.end(stdin == null ? '' : stdin);
  });
}

function createMacBackend({ getPetDisplayPoint }) {
  return {
    ownWindowRects: () => BrowserWindow.getAllWindows().filter(w => !w.isDestroyed() && w.isVisible()).map(w => w.getBounds()),
    ownWindowFocused: () => !!BrowserWindow.getFocusedWindow(),

    async capture({ secrets }) {
      if (['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('screen'))) throw permissionError('screen');
      const display = screen.getDisplayNearestPoint(getPetDisplayPoint());
      const scale = Math.min(1, MAX_SHOT_WIDTH / display.bounds.width);
      const width = Math.round(display.bounds.width * scale);
      const height = Math.round(display.bounds.height * scale);
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
      const src = sources.find(s => String(s.display_id) === String(display.id)) || sources[0];
      if (!src || src.thumbnail.isEmpty()) throw permissionError('screen');
      if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') throw permissionError('screen');
      const size = src.thumbnail.getSize();

      // Redact on-device before the image goes anywhere. No redaction -> no screenshot.
      const bin = await ensureHelper('tito-redact', 'redact');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tito-shot-'));
      const inFile = path.join(dir, 'in.png');
      const outFile = path.join(dir, 'out.jpg');
      try {
        fs.writeFileSync(inFile, src.thumbnail.toPNG(), { mode: 0o600 });
        const r = await runHelper(bin, [inFile, outFile], JSON.stringify(patternsWith(secrets)), 60000);
        if (r.code !== 0) throw new Error('Could not check the screenshot for secrets, so it was not sent.');
        const redacted = (JSON.parse(r.out || '{}').redacted) || 0;
        return {
          base64: fs.readFileSync(outFile).toString('base64'),
          redacted,
          geometry: { scale: size.width / display.bounds.width, originX: display.bounds.x, originY: display.bounds.y, width: size.width, height: size.height },
        };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },

    async input(args, stdin) {
      const bin = await ensureHelper('tito-input', 'input');
      const r = await runHelper(bin, args, stdin);
      if (r.code === 2) {
        systemPreferences.isTrustedAccessibilityClient(true); // also shows the system prompt
        throw permissionError('accessibility');
      }
      if (r.code !== 0) throw new Error(r.err.trim() || 'The input helper failed.');
    },

    openApp: name => new Promise((resolve, reject) => {
      execFile('open', ['-a', name], { timeout: 15000 }, err => (err ? reject(new Error(`Could not open "${name}". Is it installed?`)) : resolve()));
    }),

    trash: p => shell.trashItem(p),
  };
}

module.exports = { createMacBackend, ensureHelper, runHelper, BIN };
