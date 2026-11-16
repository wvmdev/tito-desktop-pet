// API keys, encrypted at rest with Electron safeStorage (macOS: a key held in the Keychain).
// - Keys are never written in plain text: if encryption isn't available, saving fails.
// - Only main reads them back, just before a request. The renderer only ever learns
//   whether a key is saved and its last 4 characters.
// - Nothing here logs a key or includes it in an error.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const PROVIDERS = ['anthropic', 'openai', 'custom'];

class SecretStore {
  constructor(file = path.join(app.getPath('userData'), 'secrets.json')) {
    this.file = file;
    this.data = {};
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch { this.data = {}; }
  }

  available() { return safeStorage.isEncryptionAvailable(); }

  set(provider, key) {
    if (!PROVIDERS.includes(provider)) throw new Error('Unknown provider');
    if (typeof key !== 'string') throw new Error('Invalid key');
    const k = key.trim();
    if (k.length < 10 || k.length > 500 || /\s/.test(k)) throw new Error("That doesn't look like an API key.");
    if (!this.available()) throw new Error('Secure storage is not available on this system, so the key was not saved.');
    this.data[provider] = {
      enc: safeStorage.encryptString(k).toString('base64'),
      hint: k.slice(-4),
      savedAt: new Date().toISOString(),
    };
    this._write();
  }

  get(provider) {
    const e = this.data[provider];
    if (!e || !e.enc) return null;
    try { return safeStorage.decryptString(Buffer.from(e.enc, 'base64')); } catch { return null; }
  }

  remove(provider) {
    delete this.data[provider];
    this._write();
  }

  // Safe to send to the renderer.
  status() {
    const out = {};
    for (const p of PROVIDERS) out[p] = this.data[p] ? { saved: true, hint: this.data[p].hint } : { saved: false };
    return out;
  }

  _write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }
}

module.exports = { SecretStore, PROVIDERS };
