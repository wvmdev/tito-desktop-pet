// Chat window. Model output is untrusted: it is only ever inserted as text nodes
// (never innerHTML), with a tiny formatter for ``` code blocks, `inline code` and **bold**.
const api = window.tito.chat;
const log = document.getElementById('log');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const SEND_ICON = sendBtn.innerHTML;
const STOP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
if (window.tito.platform !== 'darwin') document.body.classList.add('no-vibrancy');

let busy = false;
let live = null; // the assistant bubble being streamed into
let liveText = '';

// ---------- safe rendering ----------
function inline(parent, text) {
  // `code` and **bold**; everything else is plain text.
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    const el = document.createElement(tok.startsWith('`') ? 'code' : 'strong');
    el.textContent = tok.startsWith('`') ? tok.slice(1, -1) : tok.slice(2, -2);
    parent.append(el);
    last = m.index + tok.length;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}
function render(el, text) {
  el.replaceChildren();
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) { // inside a code fence; drop an optional language tag line
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = part.replace(/^[a-zA-Z0-9_+-]*\n/, '').replace(/\n$/, '');
      pre.append(code);
      el.append(pre);
    } else if (part) inline(el, part);
  });
}

function bubble(role, text, meta) {
  log.querySelector('.empty')?.remove();
  const el = document.createElement('div');
  el.className = `msg ${role}${role === 'assistant' ? ' glass' : ''}`;
  const body = document.createElement('span');
  render(body, text);
  el.append(body);
  if (meta) el.append(Object.assign(document.createElement('span'), { className: 'meta', textContent: meta }));
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

// ---------- action log: every tool call Tito makes is shown as it happens ----------
const STATUS_TEXT = { asking: 'waiting for your OK', running: 'working…', done: '', denied: 'not allowed by you', blocked: 'blocked by your settings', error: 'failed' };
const actionRows = new Map();
function actionRow(a) {
  log.querySelector('.empty')?.remove();
  let row = actionRows.get(a.id);
  if (!row) {
    row = document.createElement('div');
    row.append(Object.assign(document.createElement('span'), { className: 'dot' }),
      Object.assign(document.createElement('span'), { className: 'what' }),
      Object.assign(document.createElement('span'), { className: 'more' }));
    actionRows.set(a.id, row);
    log.append(row);
  }
  row.className = `act ${a.status}`;
  row.children[1].textContent = a.title || 'Action';
  const bits = [STATUS_TEXT[a.status] || '', a.detail || '', ['error', 'blocked'].includes(a.status) ? (a.note || '') : ''].filter(Boolean);
  row.children[2].textContent = bits.join(' · ');
  log.scrollTop = log.scrollHeight;
}
// Close the bubble being streamed so what comes next appears below it, in order.
function endLive() {
  if (!live) return;
  if (liveText) live.classList.remove('typing'); else live.remove();
  live = null;
  liveText = '';
}

function showError(e, retryText) {
  const box = document.createElement('div');
  box.className = 'err';
  box.append(Object.assign(document.createElement('span'), { textContent: e.message || 'Something went wrong.' }));
  if (['no_key', 'config', 'auth', 'not_found', 'permission'].includes(e.code)) {
    const b = Object.assign(document.createElement('button'), { className: 'btn', textContent: 'Open Settings' });
    b.addEventListener('click', () => api.openSettings());
    box.append(b);
  }
  if (retryText && !e.kept && !['no_key', 'config', 'refused'].includes(e.code)) {
    const b = Object.assign(document.createElement('button'), { className: 'btn', textContent: 'Retry' });
    b.addEventListener('click', () => { box.remove(); log.lastElementChild?.classList.contains('user') && log.lastElementChild.remove(); send(retryText); });
    box.append(b);
  }
  log.append(box);
  log.scrollTop = log.scrollHeight;
}

function emptyState() {
  const d = document.createElement('div');
  d.className = 'empty';
  const img = Object.assign(document.createElement('img'), { src: '../../assets/sprites/saludando/saludando_0.png', alt: '' });
  d.append(img, document.createTextNode('Hi! Ask me anything, or ask me to do something on your Mac. I will ask before I change anything.'));
  log.append(d);
}

function setBusy(b) {
  busy = b;
  sendBtn.innerHTML = b ? STOP_ICON : SEND_ICON;
  sendBtn.setAttribute('aria-label', b ? 'Stop' : 'Send');
  sendBtn.title = b ? 'Stop (Esc)' : 'Send (Enter)';
  sendBtn.disabled = !b && !input.value.trim();
}

let lastSent = '';
function send(text) {
  const t = (text ?? input.value).trim();
  if (!t || busy) return;
  lastSent = t;
  bubble('user', t);
  input.value = '';
  autosize();
  live = bubble('assistant', '');
  live.classList.add('typing');
  liveText = '';
  setBusy(true);
  api.send(t);
}

api.onDelta(d => {
  if (!busy) return;
  if (!live) { live = bubble('assistant', ''); live.classList.add('typing'); liveText = ''; }
  liveText += d;
  render(live.firstChild, liveText);
  log.scrollTop = log.scrollHeight;
});
api.onAction(a => { endLive(); actionRow(a); });
api.onDone(({ stopped }) => {
  if (stopped) {
    if (!live) { live = bubble('assistant', ''); liveText = ''; }
    liveText += '…';
    render(live.firstChild, liveText);
    live.append(Object.assign(document.createElement('span'), { className: 'meta', textContent: 'Stopped' }));
    for (const row of actionRows.values()) if (/\b(asking|running)\b/.test(row.className)) { row.className = 'act denied'; row.children[2].textContent = 'stopped'; }
  }
  endLive();
});
api.onError(e => {
  endLive();
  if (e.code !== 'aborted') showError(e, lastSent);
});
api.onIdle(() => { setBusy(false); input.focus(); });
api.onStatus(s => { document.getElementById('sub').textContent = s; });

// ---------- input ----------
function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(140, input.scrollHeight)}px`; sendBtn.disabled = !busy && !input.value.trim(); }
input.addEventListener('input', autosize);
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
sendBtn.addEventListener('click', () => (busy ? api.stop() : send()));
window.addEventListener('keydown', e => { if (e.key === 'Escape' && busy) { e.preventDefault(); api.stop(); } });
document.getElementById('newChat').addEventListener('click', async () => {
  await api.clear();
  live = null; liveText = '';
  actionRows.clear();
  log.replaceChildren();
  emptyState();
  input.focus();
});

(async () => {
  const { history, status } = await api.get();
  document.getElementById('sub').textContent = status;
  if (!history.length) emptyState();
  for (const m of history) {
    if (m.role === 'action') actionRow({ ...m, id: `old-${m.turn}-${m.id}`, status: ['asking', 'running'].includes(m.status) ? 'denied' : m.status });
    else bubble(m.role, m.content, m.stopped ? 'Stopped' : '');
  }
  setBusy(false);
  input.focus();
})();
