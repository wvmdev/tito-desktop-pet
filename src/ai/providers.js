// Provider-agnostic chat backend.
//
//   const p = createProvider({ provider: 'anthropic' | 'openai' | 'custom', apiKey, model, baseURL });
//   const { text, stopReason, model, refused } = await p.sendMessage(messages, { system, onText, signal });
//
// `messages` is the plain chat history: [{ role: 'user' | 'assistant', content: string }].
// `onText(delta)` streams text as it arrives. Adding a provider = one class with sendMessage().
// Chat logic (phase 6) and tool use (phase 7) only ever talk to this interface.
//
// API keys are passed in by the caller (decrypted from secrets.js just in time) and are never
// logged; errors are normalised and scrubbed of anything key-like before leaving this module.
const AnthropicSDK = require('@anthropic-ai/sdk');
const OpenAISDK = require('openai');

const Anthropic = AnthropicSDK.default || AnthropicSDK;
const OpenAI = OpenAISDK.default || OpenAISDK;

const DEFAULT_MODELS = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-5',
  custom: '',
};

// Suggestions shown in Settings (the field also accepts any other model id).
const MODEL_SUGGESTIONS = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'],
  openai: ['gpt-5', 'gpt-5-mini'],
  custom: [],
};

const REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_MAX_TOKENS = 16000;

// ---------- Anthropic (Claude) ----------
// Server-side refusal fallbacks: on a policy decline the API re-runs the request on a suitable
// fallback model inside the same call. Not offered for Haiku models.
const supportsFallbacks = model => /^claude-(opus-5-5|fable-5-2|sonnet-5-5)/.test(model);
// `output_config.effort` exists on current models; skip it for anything older the user types in.
const supportsEffort = model => /^claude-(opus|sonnet|haiku|fable|mythos)-[5-9]/.test(model) || /^claude-opus-4-[6-8]/.test(model);

class AnthropicProvider {
  constructor({ apiKey, model, baseURL, maxRetries = 2 }) {
    this.name = 'anthropic';
    this.model = model || DEFAULT_MODELS.anthropic;
    this.client = new Anthropic({ apiKey, baseURL: baseURL || undefined, maxRetries, timeout: REQUEST_TIMEOUT_MS });
  }

  async sendMessage(messages, { system, onText, signal, maxTokens = DEFAULT_MAX_TOKENS, effort = 'medium' } = {}) {
    const params = { model: this.model, max_tokens: maxTokens, messages };
    if (system) params.system = system;
    if (supportsEffort(this.model)) params.output_config = { effort };
    if (supportsFallbacks(this.model)) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }
    const stream = this.client.beta.messages.stream(params, { signal });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && onText) onText(event.delta.text);
    }
    const msg = await stream.finalMessage();
    const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return { text, stopReason: msg.stop_reason, model: msg.model, refused: msg.stop_reason === 'refusal' };
  }
}

// ---------- OpenAI and any OpenAI-compatible endpoint ----------
class OpenAICompatProvider {
  constructor({ provider, apiKey, model, baseURL, maxRetries = 2 }) {
    this.name = provider;
    this.model = model || DEFAULT_MODELS[provider];
    if (!this.model) throw Object.assign(new Error('Choose a model for the custom endpoint.'), { code: 'config' });
    this.client = new OpenAI({ apiKey, baseURL: baseURL || undefined, maxRetries, timeout: REQUEST_TIMEOUT_MS });
  }

  async sendMessage(messages, { system, onText, signal } = {}) {
    const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
    const stream = await this.client.chat.completions.create({ model: this.model, messages: msgs, stream: true }, { signal });
    let text = '';
    let finish = null;
    let model = this.model;
    for await (const chunk of stream) {
      if (chunk.model) model = chunk.model;
      const choice = chunk.choices && chunk.choices[0];
      const delta = choice && choice.delta && choice.delta.content;
      if (delta) { text += delta; if (onText) onText(delta); }
      if (choice && choice.finish_reason) finish = choice.finish_reason;
    }
    return { text, stopReason: finish, model, refused: finish === 'content_filter' };
  }
}

function createProvider({ provider, apiKey, model, baseURL, maxRetries }) {
  if (!apiKey) throw Object.assign(new Error('No API key saved for this provider yet.'), { code: 'no_key' });
  if (provider === 'anthropic') return new AnthropicProvider({ apiKey, model, baseURL, maxRetries });
  if (provider === 'openai') return new OpenAICompatProvider({ provider, apiKey, model, maxRetries });
  if (provider === 'custom') {
    if (!baseURL) throw Object.assign(new Error('Enter the base URL of your OpenAI-compatible endpoint.'), { code: 'config' });
    return new OpenAICompatProvider({ provider, apiKey, model, baseURL, maxRetries });
  }
  throw Object.assign(new Error(`Unknown provider: ${provider}`), { code: 'config' });
}

// ---------- errors ----------
// Remove anything that looks like a credential from text that may be shown, logged or copied.
function redact(text, secrets = []) {
  let s = String(text == null ? '' : text);
  for (const secret of secrets) if (secret && secret.length >= 6) s = s.split(secret).join('[redacted]');
  return s
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_\-]{8,}/g, '[redacted]')
    .replace(/\b(sk-ant|sk-proj)[A-Za-z0-9_\-]*/g, '[redacted]')
    .replace(/(bearer\s+)[A-Za-z0-9._\-]{8,}/gi, '$1[redacted]')
    .replace(/((?:x-)?api[-_]?key["'\s:=]+)[A-Za-z0-9._\-]{8,}/gi, '$1[redacted]');
}

// SDK error -> { code, message } safe to show the user. Most specific first.
function normalizeError(err, secrets = []) {
  const A = Anthropic;
  const O = OpenAI;
  const is = name => (A[name] && err instanceof A[name]) || (O[name] && err instanceof O[name]);
  let code = 'unknown';
  let message = 'Something went wrong talking to the AI provider.';
  if (err && err.code === 'no_key') { code = 'no_key'; message = err.message; }
  else if (err && err.code === 'config') { code = 'config'; message = err.message; }
  else if (is('APIUserAbortError') || (err && err.name === 'AbortError')) { code = 'aborted'; message = 'Stopped.'; }
  else if (is('AuthenticationError')) { code = 'auth'; message = 'The API key was rejected. Check that it is correct and active.'; }
  else if (is('PermissionDeniedError')) { code = 'permission'; message = 'This key is not allowed to use that model.'; }
  else if (is('NotFoundError')) { code = 'not_found'; message = 'Model or endpoint not found. Check the model name (and base URL).'; }
  else if (is('RateLimitError')) { code = 'rate_limit'; message = 'Rate limited or out of credit. Try again in a moment.'; }
  else if (is('BadRequestError')) { code = 'bad_request'; message = `The provider rejected the request: ${err.message}`; }
  else if (is('APIConnectionTimeoutError')) { code = 'timeout'; message = 'The provider took too long to answer.'; }
  else if (is('APIConnectionError')) { code = 'network'; message = 'Could not reach the provider. Check your connection (and base URL).'; }
  else if (is('InternalServerError') || (err && err.status >= 500)) { code = 'server'; message = 'The provider had a server error. Try again shortly.'; }
  else if (is('APIError')) { code = 'api'; message = `Provider error${err.status ? ` ${err.status}` : ''}: ${err.message}`; }
  return { code, message: redact(message, secrets) };
}

module.exports = { createProvider, normalizeError, redact, DEFAULT_MODELS, MODEL_SUGGESTIONS, supportsFallbacks };
