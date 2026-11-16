// Chat session (main process): keeps the conversation, streams replies from whichever provider
// is configured in Settings (through the provider-agnostic sendMessage), and supports Stop.
// Text only in this phase; computer-control tools are added in phase 7.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const MAX_HISTORY = 40;       // messages sent to the model (older ones are dropped from the request)
const MAX_SAVED = 200;        // messages kept on disk
const MAX_INPUT = 8000;       // characters per user message

function systemPrompt(moodLabel) {
  return [
    'You are Tito, a small, friendly cat who lives on the user\'s desktop and helps them.',
    'Keep answers short and warm, with the occasional light cat touch (no more than one per reply).',
    'Use plain text; short lists and `code` are fine.',
    'You cannot control the computer yet: if asked to click, type, open apps or change files, say that ability is coming soon and explain how the user can do it themselves.',
    moodLabel ? `Your current mood is ${moodLabel.toLowerCase()}; let it colour your tone a little.` : '',
  ].filter(Boolean).join('\n');
}

class ChatSession extends EventEmitter {
  constructor({ getProvider, getSecretsForRedaction, normalizeError, getMood }) {
    super();
    this.getProvider = getProvider;
    this.secretsForRedaction = getSecretsForRedaction;
    this.normalizeError = normalizeError;
    this.getMood = getMood;
    this.file = path.join(app.getPath('userData'), 'chat.json');
    this.messages = [];
    this._gen = 0;
    this.busy = false;
    this._abort = null;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(saved)) this.messages = saved.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
    } catch { /* no history yet */ }
  }

  history() { return this.messages.slice(); }

  async send(text) {
    if (this.busy) return { ok: false, error: { code: 'busy', message: 'Tito is still answering.' } };
    const content = String(text || '').trim().slice(0, MAX_INPUT);
    if (!content) return { ok: false, error: { code: 'empty', message: '' } };

    this.busy = true;
    const gen = this._gen; // "New chat" mid-answer bumps this; late results are then discarded
    const abort = new AbortController();
    this._abort = abort;
    this.messages.push({ role: 'user', content, at: Date.now() });
    this.emit('start', { user: content });
    let partial = '';
    try {
      const provider = this.getProvider();
      // Requests must start with a user turn; keep the most recent turns only.
      let req = this.messages.slice(-MAX_HISTORY).map(({ role, content: c }) => ({ role, content: c }));
      while (req.length && req[0].role !== 'user') req.shift();
      const mood = this.getMood && this.getMood();
      const r = await provider.sendMessage(req, {
        system: systemPrompt(mood && mood.label),
        signal: abort.signal,
        onText: d => { partial += d; this.emit('delta', d); },
      });
      if (gen !== this._gen) return { ok: false };
      // Some SDK streams end quietly on abort instead of throwing: treat that as Stop too.
      if (abort.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (r.refused) {
        this.messages.pop(); // don't keep a turn the model declined
        this.emit('error', { code: 'refused', message: "Tito can't help with that one." });
        return { ok: false };
      }
      const reply = r.text || partial;
      this.messages.push({ role: 'assistant', content: reply, at: Date.now(), model: r.model });
      this._save();
      this.emit('done', { text: reply, model: r.model });
      return { ok: true };
    } catch (err) {
      if (gen !== this._gen) return { ok: false };
      const e = this.normalizeError(err, this.secretsForRedaction());
      if (e.code === 'aborted' && partial) {
        // Keep what arrived before Stop so the conversation stays consistent.
        this.messages.push({ role: 'assistant', content: `${partial}…`, at: Date.now(), stopped: true });
        this._save();
        this.emit('done', { text: `${partial}…`, stopped: true });
        return { ok: true, stopped: true };
      }
      this.messages.pop(); // the user turn had no answer; the UI offers Retry
      this.emit('error', e);
      return { ok: false, error: e };
    } finally {
      // After "New chat" the session was already reset (and may be answering a new message).
      if (this._abort === abort) { this.busy = false; this._abort = null; this.emit('idle'); }
    }
  }

  stop() { if (this._abort) this._abort.abort(); }

  clear() {
    this._gen++;
    const wasBusy = this.busy;
    this.stop();
    this.busy = false;
    this._abort = null;
    if (wasBusy) this.emit('idle');
    this.messages = [];
    this._save();
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.messages.slice(-MAX_SAVED)), { mode: 0o600 });
  }
}

module.exports = { ChatSession, systemPrompt };
