const { app, BrowserWindow, Menu, ipcMain, screen, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
let petWindow, dragOrigin, savedPosition = null, scale = 1, panelMode = 'closed';
const baseSize = { width: 190, height: 210 };
const panelSize = { width: 390, chatHeight: 270, settingsHeight: 350, bottomSpace: 6 };
const settingsPath = () => path.join(app.getPath('userData'), 'assistant-settings.json');
const positionPath = () => path.join(app.getPath('userData'), 'pet-position.json');
const providers = new Set(['openai', 'anthropic', 'gemini', 'openrouter', 'compatible']);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function currentSize() {
  const w = Math.round(baseSize.width * scale), h = Math.round(baseSize.height * scale);
  if (panelMode === 'closed') return { width: w, height: h };
  if (panelMode === 'toolbar') return { width: Math.max(w, 124), height: h + 54 };
  const panelHeight = panelMode === 'settings' ? panelSize.settingsHeight : panelSize.chatHeight;
  const petStageHeight = Math.max(170, Math.round(168 * scale));
  return { width: Math.max(panelSize.width, w), height: petStageHeight + panelHeight + panelSize.bottomSpace };
}
function resizeForMode() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const old = petWindow.getBounds(), display = screen.getDisplayMatching(old), area = display.bounds, size = currentSize();
  const oldTop = old.y + old.height;
  let x = old.x + Math.round((old.width - size.width) / 2), y = oldTop - size.height;
  x = clamp(x, area.x, area.x + area.width - size.width);
  y = clamp(y, area.y, area.y + area.height - size.height);
  petWindow.setBounds({ x, y, ...size }, true);
}
function createPet() {
  const display = screen.getPrimaryDisplay(), area = display.workArea, bounds = display.bounds;
  const x = savedPosition ? clamp(savedPosition.x, bounds.x, bounds.x + bounds.width - baseSize.width) : area.x + area.width - baseSize.width - 24;
  const y = savedPosition ? clamp(savedPosition.y, bounds.y, bounds.y + bounds.height - baseSize.height) : area.y + area.height - baseSize.height - 20;
  petWindow = new BrowserWindow({
    x, y,
    width: baseSize.width, height: baseSize.height, frame: false, transparent: true, hasShadow: false,
    resizable: false, movable: true, alwaysOnTop: true, skipTaskbar: false, backgroundColor: '#00000000',
    title: 'Tito', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  petWindow.setAlwaysOnTop(true, 'floating');
  if (process.platform === 'darwin') petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWindow.setFullScreenable(false);
  petWindow.loadFile(path.join(__dirname, 'index.html'));
  petWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  petWindow.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('file://')) event.preventDefault(); });
  petWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.meta && input.key.toLowerCase() === 'q') || (input.control && input.key.toLowerCase() === 'q')) { event.preventDefault(); app.quit(); }
  });
  petWindow.on('closed', () => { petWindow = null; });
}
function trusted(event) { return petWindow && !petWindow.isDestroyed() && event.sender === petWindow.webContents; }
async function readSettings() {
  try { return JSON.parse(await fs.readFile(settingsPath(), 'utf8')); } catch { return {}; }
}
function legacyKeyProvider(saved) { return saved.keyProvider || saved.provider || 'openai'; }
function encryptedKeyFor(saved, provider) {
  if (saved.encryptedKeys?.[provider]) return saved.encryptedKeys[provider];
  return legacyKeyProvider(saved) === provider ? (saved.encryptedApiKey || '') : '';
}
function savedKeyProviders(saved) {
  const providersWithKeys = new Set(Object.keys(saved.encryptedKeys || {}));
  if (saved.encryptedApiKey) providersWithKeys.add(legacyKeyProvider(saved));
  return [...providersWithKeys];
}
async function publicSettings() {
  const saved = await readSettings();
  const provider = saved.provider || 'openai';
  return { provider, model: saved.model || 'gpt-6-luna', baseUrl: saved.baseUrl || '', hasApiKey: !!encryptedKeyFor(saved, provider), savedProviders: savedKeyProviders(saved) };
}
ipcMain.on('aura:begin-drag', (event, point) => { if (!trusted(event)) return; dragOrigin = { point, bounds: petWindow.getBounds() }; });
ipcMain.on('aura:move-drag', (event, delta) => {
  if (!trusted(event) || !dragOrigin) return;
  const bounds = dragOrigin.bounds, x = bounds.x + Math.round(delta.x), y = bounds.y + Math.round(delta.y);
  const display = screen.getDisplayNearestPoint({ x: x + Math.round(bounds.width / 2), y: y + Math.round(bounds.height / 2) });
  const area = display.bounds;
  petWindow.setPosition(clamp(x, area.x, area.x + area.width - bounds.width), clamp(y, area.y, area.y + area.height - bounds.height));
});
ipcMain.on('aura:end-drag', async event => {
  if (!trusted(event)) return;
  dragOrigin = null;
  savedPosition = { x: petWindow.getBounds().x, y: petWindow.getBounds().y };
  try { await fs.mkdir(path.dirname(positionPath()), { recursive: true }); await fs.writeFile(positionPath(), JSON.stringify(savedPosition), { mode: 0o600 }); } catch {}
});
ipcMain.on('aura:resize', (event, value) => { if (!trusted(event)) return; scale = clamp(Number(value) || 1, 0.65, 1.7); resizeForMode(); });
ipcMain.on('aura:panel-mode', (event, mode) => { if (!trusted(event) || !['closed', 'toolbar', 'chat', 'settings'].includes(mode)) return; panelMode = mode; resizeForMode(); });

ipcMain.handle('aura:settings:get', async event => trusted(event) ? publicSettings() : null);
ipcMain.handle('aura:settings:save', async (event, data = {}) => {
  if (!trusted(event)) throw new Error('Request not allowed.');
  const provider = providers.has(data.provider) ? data.provider : 'openai';
  const model = String(data.model || '').trim().slice(0, 120);
  const baseUrl = String(data.baseUrl || '').trim().slice(0, 500);
  const saved = await readSettings();
  const encryptedKeys = { ...(saved.encryptedKeys || {}) };
  if (saved.encryptedApiKey && !encryptedKeys[legacyKeyProvider(saved)]) encryptedKeys[legacyKeyProvider(saved)] = saved.encryptedApiKey;
  if (data.clearApiKey) delete encryptedKeys[provider];
  const apiKey = String(data.apiKey || '').trim();
  if (apiKey) {
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Secure key storage is unavailable on this computer.');
    encryptedKeys[provider] = (await safeStorage.encryptStringAsync(apiKey)).toString('base64');
  }
  const encryptedApiKey = encryptedKeys[provider] || '';
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify({ provider, model, baseUrl, encryptedKeys, encryptedApiKey, keyProvider: provider }, null, 2), { mode: 0o600 });
  await fs.chmod(settingsPath(), 0o600);
  return { provider, model, baseUrl, hasApiKey: !!encryptedApiKey, savedProviders: savedKeyProviders({ encryptedKeys }) };
});
ipcMain.handle('aura:settings:clear-key', async event => {
  if (!trusted(event)) throw new Error('Request not allowed.');
  const saved = await readSettings(), provider = saved.provider || 'openai';
  saved.encryptedKeys = { ...(saved.encryptedKeys || {}) };
  if (saved.encryptedApiKey && !saved.encryptedKeys[legacyKeyProvider(saved)]) saved.encryptedKeys[legacyKeyProvider(saved)] = saved.encryptedApiKey;
  delete saved.encryptedKeys[provider];
  saved.encryptedApiKey = '';
  saved.keyProvider = provider;
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(saved, null, 2), { mode: 0o600 });
  await fs.chmod(settingsPath(), 0o600);
  return { ok: true };
});
async function apiKeyFor(saved, provider) {
  const encryptedApiKey = encryptedKeyFor(saved, provider);
  if (!encryptedApiKey) throw new Error(`Add a ${provider} API key in Tito Settings first. API keys are saved separately for each provider.`);
  if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Secure key storage is unavailable.');
  const { result } = await safeStorage.decryptStringAsync(Buffer.from(encryptedApiKey, 'base64'));
  return result;
}
function endpointFor(provider, baseUrl, model) {
  if (provider === 'openai') return { url: 'https://api.openai.com/v1/chat/completions', model: model || 'gpt-6-luna' };
  if (provider === 'openrouter') return { url: 'https://openrouter.ai/api/v1/chat/completions', model: model || 'openai/gpt-6-luna' };
  if (!String(model || '').trim()) throw new Error('Enter a model name in Settings.');
  const raw = baseUrl || '';
  let url;
  try { url = new URL(raw); } catch { throw new Error('Enter a valid HTTPS API base URL in Settings.'); }
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname))) throw new Error('Custom API URLs must use HTTPS.');
  const trimmed = url.toString().replace(/\/+$/, '');
  const full = trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
  return { url: full, model: model || '' };
}
async function responseJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${data?.error?.message || data?.message || response.statusText || 'The provider rejected the request.'}`);
  return data;
}
async function fetchGeminiWithRetry(url, options) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, options);
    if (response.status !== 503 || attempt >= 2) return response;
    await new Promise(resolve => setTimeout(resolve, 900 * (2 ** attempt)));
  }
}
async function requestCompletion({ provider, model, baseUrl, key, messages, test = false }) {
  const persona = 'You are Tito, a warm, concise desktop companion. Be helpful and friendly. Keep responses clear and fairly short.';
  const timeout = AbortSignal.timeout(60000);
  if (provider === 'anthropic') {
    const response = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: timeout, headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: model || 'claude-haiku-4-5-20251001', max_tokens: test ? 16 : 1200, system: persona, messages }) });
    const data = await responseJson(response);
    const answer = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    if (!answer) throw new Error(`Anthropic returned no text${data.stop_reason ? ` (stop reason: ${data.stop_reason})` : ''}.`);
    return answer;
  }
  if (provider === 'gemini') {
    const selectedModel = model || 'gemini-3.8-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent`;
    const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const response = await fetchGeminiWithRetry(url, { method: 'POST', signal: timeout, headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ systemInstruction: { parts: [{ text: persona }] }, contents, generationConfig: { maxOutputTokens: test ? 16 : 1200 } }) });
    const data = await responseJson(response);
    const answer = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    if (!answer) {
      const reason = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason;
      throw new Error(reason ? `Gemini returned no text (reason: ${reason}).` : 'Gemini returned no text. Check the selected model and its response settings.');
    }
    return answer;
  }
  const target = endpointFor(provider, baseUrl, model);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
  if (provider === 'openrouter') headers['http-referer'] = 'https://aura.local';
  const response = await fetch(target.url, { method: 'POST', signal: timeout, headers, body: JSON.stringify({ model: target.model, messages: [{ role: 'system', content: persona }, ...messages] }) });
  const data = await responseJson(response);
  const answer = data.choices?.[0]?.message?.content;
  const text = Array.isArray(answer) ? answer.map(part => part.text || '').join('') : String(answer || '');
  if (!text.trim()) throw new Error('The provider returned no text. Check that the model supports chat completions.');
  return text.trim();
}
ipcMain.handle('aura:settings:test', async (event, data = {}) => {
  if (!trusted(event)) throw new Error('Request not allowed.');
  const provider = providers.has(data.provider) ? data.provider : 'openai';
  const model = String(data.model || '').trim().slice(0, 120);
  const baseUrl = String(data.baseUrl || '').trim().slice(0, 500);
  const saved = await readSettings();
  const enteredKey = String(data.apiKey || '').trim();
  const key = enteredKey || await apiKeyFor(saved, provider);
  await requestCompletion({ provider, model, baseUrl, key, test: true, messages: [{ role: 'user', content: 'Reply with exactly: OK.' }] });
  return { ok: true, provider, model };
});
ipcMain.handle('aura:chat:send', async (event, payload = {}) => {
  if (!trusted(event)) throw new Error('Request not allowed.');
  const saved = await readSettings(), provider = providers.has(saved.provider) ? saved.provider : 'openai';
  const key = await apiKeyFor(saved, provider);
  const incoming = Array.isArray(payload.messages) ? payload.messages.slice(-18) : [];
  const messages = incoming.filter(m => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string').map(m => ({ role: m.role, content: m.content.slice(0, 12000) }));
  if (!messages.length || messages[messages.length - 1].role !== 'user') throw new Error('Type a message first.');
  return requestCompletion({ provider, model: saved.model, baseUrl: saved.baseUrl, key, messages });
});

app.whenReady().then(async () => {
  app.setName('Tito'); Menu.setApplicationMenu(null);
  try { savedPosition = JSON.parse(await fs.readFile(positionPath(), 'utf8')); } catch {}
  createPet();
  app.on('activate', () => { if (!petWindow) createPet(); else petWindow.show(); });
});
app.on('window-all-closed', () => app.quit());
