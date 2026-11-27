// Settings window.
const api = window.tito.settings;
const ICON = {
  balanced: 'sentado', calm: 'tumbado', excited: 'jugando_pelota',
  sleepy: 'durmiendo', curious: 'mirando_arriba', grumpy: 'enfadado',
};
if (window.tito.platform !== 'darwin') document.body.classList.add('no-vibrancy');
if (window.tito.platform === 'win32') document.body.classList.add('win');
const COMPUTER = window.tito.platform === 'win32' ? 'PC' : 'Mac';
{ const n = document.getElementById('keystoreNote'); if (n && window.tito.platform === 'win32') n.textContent = 'Keys are encrypted with Windows (the same protection that guards your saved passwords)'; }

async function init() {
  const { personalities, settings, sizeRange, stayPoses, mood, ai, security, tasks, emotions, companion } = await api.get();

  // ---- personalities: every one shows its emotion mix; the user can build their own ----
  const grid = document.getElementById('personalities');
  const emoInfo = Object.fromEntries(emotions.map(e => [e.id, e]));
  const percent = raw => { // whole percentages that add up to exactly 100
    const ids = emotions.map(e => e.id);
    const total = ids.reduce((t, k) => t + (raw[k] || 0), 0);
    if (total <= 0) return Object.fromEntries(ids.map(k => [k, 0]));
    const exact = ids.map(k => (100 * (raw[k] || 0)) / total);
    const out = exact.map(Math.floor);
    let left = 100 - out.reduce((a, b) => a + b, 0);
    exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left-- > 0) out[i]++; });
    return Object.fromEntries(ids.map((k, i) => [k, out[i]]));
  };
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const mixBar = mix => el('div', { className: 'stackbar', title: emotions.map(e => `${e.label} ${mix[e.id]}%`).join(', ') },
    ...emotions.filter(e => mix[e.id] > 0).map(e => { const sp = el('span'); sp.style.width = `${mix[e.id]}%`; sp.style.background = `var(--e-${e.id})`; return sp; }));
  const legend = mix => el('div', { className: 'legend' },
    ...emotions.filter(e => mix[e.id] > 0).map(e => el('span', {}, `${e.emoji} ${e.label} `, el('b', { textContent: `${mix[e.id]}%` }))));

  let list = personalities;
  let customs = settings.customPersonalities || [];
  const saved = document.getElementById('saved');

  function renderPersonalities() {
    grid.replaceChildren(...list.map(p => {
      const label = el('label', { className: 'card glass' });
      const input = Object.assign(el('input'), { type: 'radio', name: 'personality', value: p.id, checked: p.id === settings.personality });
      const icon = ICON[p.id] || 'sentado';
      const img = el('img', { src: `../../assets/sprites/${icon}/${icon}_0.png`, alt: '' });
      const text = el('div', {}, el('div', { className: 'name', textContent: p.label }), el('div', { className: 'desc', textContent: p.description }));
      const mix = el('div', { className: 'mix' }, mixBar(p.mix), legend(p.mix),
        el('div', { className: 'stats', textContent: `Moves ${p.movePct}% of the time · climbing is ${p.climbPct}% of his moves` }));
      label.append(input, img, text, mix);
      if (p.custom) {
        const edit = el('button', { type: 'button', textContent: '✎', title: 'Edit' });
        edit.setAttribute('aria-label', `Edit ${p.label}`);
        edit.addEventListener('click', e => { e.preventDefault(); openEditor(p.params); });
        label.append(el('div', { className: 'cardbtns' }, edit));
      }
      input.addEventListener('change', async () => {
        Object.assign(settings, await api.set('personality', p.id));
        saved.textContent = `Tito is now ${p.label.toLowerCase()}.`;
      });
      return label;
    }));
  }
  renderPersonalities();

  async function refreshPersonalities() {
    const fresh = await api.get();
    list = fresh.personalities;
    customs = fresh.settings.customPersonalities || [];
    Object.assign(settings, fresh.settings);
    renderPersonalities();
  }

  // ---- the editor ----
  const $e = id => document.getElementById(id);
  const editor = $e('editor');
  let editing = null; // custom being edited (has id) or null for a new one
  let confirmDelete = false;
  const rawEmo = {};
  const emoRows = $e('emoRows');
  for (const e of emotions) {
    const range = el('input', { type: 'range', min: 0, max: 100, id: `emo-${e.id}` });
    const out = el('output', { htmlFor: `emo-${e.id}` });
    range.addEventListener('input', () => { rawEmo[e.id] = +range.value; updateEditor(); });
    emoRows.append(el('div', { className: `erow e-${e.id}` }, el('label', { className: 'el', htmlFor: `emo-${e.id}`, textContent: `${e.emoji} ${e.label}` }), range, out));
  }
  function updateEditor() {
    const mix = percent(rawEmo);
    for (const e of emotions) emoRows.querySelector(`#emo-${e.id}`).nextSibling.textContent = `${mix[e.id]}%`;
    $e('editBar').replaceChildren(...mixBar(mix).children);
    for (const [r, o] of [['pAct', 'pActV'], ['pSpeed', 'pSpeedV'], ['pClimb', 'pClimbV']]) $e(o).textContent = `${$e(r).value}%`;
  }
  for (const r of ['pAct', 'pSpeed', 'pClimb']) $e(r).addEventListener('input', updateEditor);

  function openEditor(c) {
    editing = c || null;
    confirmDelete = false;
    $e('pDelete').textContent = 'Delete';
    $e('pName').value = c ? c.label : '';
    const start = c ? c.emotions : { happy: 25, calm: 25, curious: 25, tired: 10, grumpy: 5, scared: 10 };
    for (const e of emotions) { rawEmo[e.id] = start[e.id] ?? 0; $e(`emo-${e.id}`).value = rawEmo[e.id]; }
    $e('pAct').value = c ? c.activity : 50;
    $e('pSpeed').value = c ? c.speed : 50;
    $e('pClimb').value = c ? c.climb : 50;
    $e('pDelete').hidden = !c;
    $e('pErr').textContent = '';
    editor.hidden = false;
    updateEditor();
    $e('pName').focus();
    editor.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  const closeEditor = () => { editor.hidden = true; editing = null; };
  $e('addPersonality').addEventListener('click', () => openEditor(null));
  $e('pCancel').addEventListener('click', closeEditor);

  $e('pSave').addEventListener('click', async () => {
    const def = {
      label: $e('pName').value, emotions: { ...rawEmo },
      activity: +$e('pAct').value, speed: +$e('pSpeed').value, climb: +$e('pClimb').value,
    };
    if (editing) def.id = editing.id;
    const before = new Set(customs.map(c => c.id));
    const next = editing ? customs.map(c => (c.id === editing.id ? def : c)) : [...customs, def];
    try { await api.set('customPersonalities', next); }
    catch { $e('pErr').textContent = 'Give it a name, keep every slider in 0–100 and at least one emotion above 0 (up to 12 personalities).'; return; }
    await refreshPersonalities();
    const made = customs.find(c => !before.has(c.id));
    const pick = editing ? editing.id : (made && made.id);
    if (pick) Object.assign(settings, await api.set('personality', pick));
    renderPersonalities();
    saved.textContent = `Saved. Tito is now ${def.label.trim().toLowerCase()}.`;
    closeEditor();
  });

  $e('pDelete').addEventListener('click', async () => {
    if (!editing) return;
    if (!confirmDelete) { confirmDelete = true; $e('pDelete').textContent = 'Click again to delete'; return; }
    await api.set('customPersonalities', customs.filter(c => c.id !== editing.id));
    await refreshPersonalities();
    saved.textContent = 'Deleted.';
    closeEditor();
  });

  // ---- stay still ----
  const stay = document.getElementById('stay');
  const posesEl = document.getElementById('poses');
  const syncStay = all => {
    stay.checked = all.stayStill;
    posesEl.classList.toggle('off', !all.stayStill);
    for (const r of posesEl.querySelectorAll('input')) r.checked = r.value === all.stayPose;
  };
  for (const pose of stayPoses) {
    const label = document.createElement('label');
    label.className = 'pose glass';
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'pose', value: pose.id });
    const img = Object.assign(document.createElement('img'), {
      src: `../../assets/sprites/${pose.id}/${pose.id}_0.png`, alt: '',
    });
    label.append(input, img, Object.assign(document.createElement('span'), { textContent: pose.label }));
    // Picking a pose also turns "Stay still" on.
    input.addEventListener('change', async () => {
      await api.set('stayPose', pose.id);
      if (!stay.checked) await api.set('stayStill', true);
    });
    posesEl.append(label);
  }
  stay.addEventListener('change', () => api.set('stayStill', stay.checked));
  syncStay(settings);
  api.onChanged(syncStay); // e.g. toggled from the menu-bar icon

  // ---- companion: bond, hunger, feeding, lively reactions ----
  const showCompanion = c => {
    if (!c) return;
    document.getElementById('bondTier').textContent = c.tier;
    const hearts = Math.round(c.bond / 20); // 0..5
    document.getElementById('bondHearts').textContent = '♥'.repeat(hearts) + '♡'.repeat(5 - hearts) + `  ${Math.round(c.bond)}%`;
    document.getElementById('hungerLabel').textContent = c.hungerLabel;
    document.getElementById('feedBtn').disabled = !c.canFeed;
  };
  showCompanion(companion);
  window.tito.companion.onChange(showCompanion);
  const feedNote = document.getElementById('feedNote');
  document.getElementById('feedBtn').addEventListener('click', async () => {
    const r = await window.tito.companion.feed();
    showCompanion(r.info);
    feedNote.textContent = r.message;
  });
  const reactions = document.getElementById('reactions');
  reactions.checked = settings.reactions;
  reactions.addEventListener('change', () => api.set('reactions', reactions.checked));

  // ---- mood & sleep ----
  const showMood = m => {
    if (!m) return;
    document.getElementById('moodEmoji').textContent = m.emoji;
    document.getElementById('moodLabel').textContent = `Feeling ${m.label.toLowerCase()}`;
    const ul = document.getElementById('moodReasons');
    ul.replaceChildren(...m.reasons.map(r => Object.assign(document.createElement('li'), { textContent: r })));
    if (m.battery) ul.append(Object.assign(document.createElement('li'), { textContent: `Battery ${m.battery.percent}%${m.battery.charging ? ' ⚡' : ''}` }));
    document.getElementById('weatherWarn').textContent = m.weatherError || '';
    const loc = m.location;
    document.getElementById('locLine').textContent = !loc
      ? 'Leave empty to guess from your IP address.'
      : loc.source === 'city'
        ? `Using ${loc.place}.`
        : `Guessed from your IP: ${loc.place} (${loc.agreement.replace('/', ' of ')} services agree). Wrong? Type your city.`;
  };
  showMood(mood);
  api.onMood(showMood);

  const sleepAfter = document.getElementById('sleepAfter');
  sleepAfter.value = String(settings.sleepAfterMin);
  if (!sleepAfter.value) { // a custom value not in the list
    sleepAfter.append(Object.assign(document.createElement('option'), { value: String(settings.sleepAfterMin), textContent: `After ${settings.sleepAfterMin} min` }));
    sleepAfter.value = String(settings.sleepAfterMin);
  }
  sleepAfter.addEventListener('change', () => api.set('sleepAfterMin', +sleepAfter.value));

  const weather = document.getElementById('weather');
  const city = document.getElementById('city');
  weather.checked = settings.weatherEnabled;
  city.value = settings.locationOverride;
  city.disabled = !settings.weatherEnabled;
  weather.addEventListener('change', () => { city.disabled = !weather.checked; api.set('weatherEnabled', weather.checked); });
  const saveCity = () => { if (city.value.trim() !== settings.locationOverride) { settings.locationOverride = city.value.trim(); api.set('locationOverride', city.value); } };
  city.addEventListener('change', saveCity);
  city.addEventListener('keydown', e => { if (e.key === 'Enter') city.blur(); });

  // ---- AI provider ----
  const aiApi = window.tito.ai;
  let aiState = ai;
  const $ = id => document.getElementById(id);
  const info = id => aiState.providers.find(p => p.id === id);
  const provider = () => settings.aiProvider;
  const loaded = {}; // provider -> model ids fetched with "Load models"
  const setResult = (cls, text) => { $('testResult').className = `result ${cls}`; $('testResult').textContent = text; };

  $('provider').replaceChildren(...aiState.providers.map(p => Object.assign(document.createElement('option'), { value: p.id, textContent: p.label })));
  const renderProvider = () => {
    const p = provider();
    const pi = info(p);
    $('provider').value = p;
    $('model').value = (settings.aiModels || {})[p] || '';
    $('model').placeholder = pi.suggestions.length ? '' : 'Load models, or type one';
    const options = [...new Set([...(pi.suggestions || []), ...(loaded[p] || [])])];
    $('modelList').replaceChildren(...options.map(m => Object.assign(document.createElement('option'), { value: m })));
    // Presets come with their address filled in (read-only); only Custom is typed by hand.
    $('baseURL').readOnly = !pi.custom;
    $('baseURL').value = pi.custom ? (settings.customBaseURL || '') : pi.baseURL;
    $('baseURL').title = pi.custom ? '' : 'Built-in address for this provider';
    $('builtin').hidden = pi.custom;
    $('keyPage').hidden = !pi.hasKeyPage;
    // Local servers need no key.
    $('localNote').hidden = !pi.local;
    $('localText').textContent = pi.local ? `No key needed. Make sure ${pi.label.replace(/ \(.*/, '')} is running on this ${COMPUTER}.` : '';
    $('keyRow').hidden = pi.local;
    $('keyStateRow').hidden = pi.local;
    const k = aiState.keys[p] || { saved: false };
    $('keyState').textContent = !aiState.encryptionAvailable ? 'Secure storage unavailable: keys cannot be saved on this system.'
      : k.saved ? `Key saved (ending …${k.hint})` : 'No key saved yet';
    $('keyState').classList.toggle('ok', !!k.saved);
    $('removeKey').hidden = !k.saved;
    $('apiKey').value = '';
    $('apiKey').placeholder = k.saved ? 'Paste a new key to replace it' : 'Paste your key';
    setResult('', '');
  };
  $('provider').addEventListener('change', async () => { Object.assign(settings, await api.set('aiProvider', $('provider').value)); renderProvider(); });
  $('model').addEventListener('change', async () => {
    try { Object.assign(settings, await api.set('aiModels', { ...settings.aiModels, [provider()]: $('model').value })); }
    catch { setResult('bad', 'That model name has unsupported characters.'); }
  });
  $('baseURL').addEventListener('change', async () => {
    if (!info(provider()).custom) return;
    try { Object.assign(settings, await api.set('customBaseURL', $('baseURL').value)); setResult('', ''); }
    catch { setResult('bad', 'Use an https:// address (http:// only for localhost).'); }
  });
  $('keyPage').addEventListener('click', () => aiApi.openKeyPage(provider()));
  $('loadModels').addEventListener('click', async () => {
    $('loadModels').disabled = true;
    setResult('', 'Loading models…');
    const r = await aiApi.listModels();
    $('loadModels').disabled = false;
    if (!r.ok) { setResult('bad', r.error.message); return; }
    loaded[provider()] = r.models;
    const keep = $('model').value;
    renderProvider();
    $('model').value = keep;
    setResult('ok', `${r.models.length} models available. Click the Model field to pick one.`);
    $('model').focus();
  });
  const saveKey = async () => {
    const v = $('apiKey').value;
    if (!v) return;
    $('apiKey').value = ''; // never keep the key in the page longer than needed
    const r = await aiApi.saveKey(provider(), v);
    aiState = r.ai;
    renderProvider();
    setResult(r.ok ? 'ok' : 'bad', r.ok ? 'Key saved.' : r.error);
  };
  $('saveKey').addEventListener('click', saveKey);
  $('apiKey').addEventListener('keydown', e => { if (e.key === 'Enter') saveKey(); });
  $('removeKey').addEventListener('click', async () => { aiState = (await aiApi.removeKey(provider())).ai; renderProvider(); });
  $('testBtn').addEventListener('click', async () => {
    $('testBtn').disabled = true;
    setResult('', 'Testing…');
    const r = await aiApi.test();
    $('testBtn').disabled = false;
    setResult(r.ok ? 'ok' : 'bad', r.ok ? `Connected to ${r.model} (${(r.ms / 1000).toFixed(1)}s): "${r.text}"` : r.error.message);
  });
  renderProvider();

  // ---- scheduled tasks ----
  const tasksApi = window.tito.tasks;
  const ago = at => { const s = Math.round((Date.now() - at) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
  const renderTasks = list => {
    const box = $('taskList');
    if (!list.length) { box.replaceChildren(Object.assign(document.createElement('div'), { className: 'notasks', textContent: 'No tasks yet.' })); return; }
    box.replaceChildren(...list.map(t => {
      const row = document.createElement('div');
      row.className = 'task';
      const text = document.createElement('div');
      text.className = 't';
      const last = Object.assign(document.createElement('div'), { className: `last${t.last && !t.last.ok ? ' bad' : ''}`,
        textContent: t.last ? `${ago(t.last.at)}: ${t.last.text}` : (t.enabled ? 'Waiting for its first run' : 'Off') });
      text.append(Object.assign(document.createElement('div'), { className: 'sum', textContent: t.summary }), last);
      const sw = document.createElement('span');
      sw.className = 'switch';
      const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: t.enabled });
      cb.setAttribute('role', 'switch');
      cb.setAttribute('aria-label', `${t.summary}: on`);
      cb.addEventListener('change', () => tasksApi.toggle(t.id, cb.checked));
      sw.append(cb, Object.assign(document.createElement('span'), { className: 'track' }), Object.assign(document.createElement('span'), { className: 'knob' }));
      const del = Object.assign(document.createElement('button'), { className: 'x', textContent: '×', title: 'Remove task' });
      del.setAttribute('aria-label', `Remove: ${t.summary}`);
      del.addEventListener('click', () => tasksApi.remove(t.id));
      row.append(text, sw, del);
      return row;
    }));
  };
  renderTasks(tasks);
  tasksApi.onChange(renderTasks);
  const PLACEHOLDER = { key: 'space', type: 'text to type', open: 'Safari' };
  $('taskKind').addEventListener('change', () => { $('taskValue').placeholder = PLACEHOLDER[$('taskKind').value]; });
  const addTask = async () => {
    const r = await tasksApi.add({ kind: $('taskKind').value, value: $('taskValue').value, everySec: Number($('taskEvery').value) * Number($('taskUnit').value) });
    $('taskErr').textContent = r.ok ? '' : r.error;
    if (r.ok) $('taskValue').value = '';
  };
  $('taskAdd').addEventListener('click', addTask);
  $('taskValue').addEventListener('keydown', e => { if (e.key === 'Enter') addTask(); });

  // ---- computer control: security level + per-action toggles ----
  const LEVEL_TEXT = {
    lockdown: ['Lockdown', 'Chat only', 'No computer control at all.'],
    guarded: ['Guarded', 'Recommended', 'Can look and read. Asks before every click, keystroke, file change or app launch.'],
    trusted: ['Trusted', '', 'Routine actions run without asking. Deleting, sending, closing without saving or buying always asks.'],
    full: ['Full Access', 'Use with care', 'Runs everything without asking, including irreversible actions.'],
  };
  const levelsEl = $('levels');
  for (const id of security.levels) {
    const [name, tag, desc] = LEVEL_TEXT[id];
    const label = document.createElement('label');
    label.className = `level glass${id === 'full' ? ' danger' : ''}`;
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'level', value: id });
    label.append(input,
      Object.assign(document.createElement('span'), { className: 'tag', textContent: tag }),
      Object.assign(document.createElement('span'), { className: 'name', textContent: name, style: 'font-weight:650' }),
      Object.assign(document.createElement('span'), { className: 'desc', textContent: desc }));
    input.addEventListener('change', async () => {
      Object.assign(settings, await api.set('securityLevel', id)); // main asks for confirmation before Full Access
      renderSecurity();
    });
    levelsEl.append(label);
  }
  const togglesEl = $('toggles');
  for (const t of security.toggles) {
    const row = document.createElement('div');
    row.className = 'toggle-row';
    const tid = `perm-${t.id}`;
    row.innerHTML = `<label class="t" for="${tid}"></label><span class="switch"><input type="checkbox" id="${tid}" role="switch"><span class="track"></span><span class="knob"></span></span>`;
    row.querySelector('label').textContent = t.label;
    row.querySelector('input').addEventListener('change', async e => {
      Object.assign(settings, await api.set('actionPerms', { ...settings.actionPerms, [t.id]: e.target.checked }));
      renderSecurity();
    });
    togglesEl.append(row);
  }
  function renderSecurity() {
    for (const r of levelsEl.querySelectorAll('input')) r.checked = r.value === settings.securityLevel;
    for (const t of security.toggles) $(`perm-${t.id}`).checked = !!settings.actionPerms[t.id];
    togglesEl.classList.toggle('off', settings.securityLevel === 'lockdown');
  }
  renderSecurity();

  const size = document.getElementById('size');
  const sizeVal = document.getElementById('sizeVal');
  [size.min, size.max] = sizeRange;
  size.value = settings.size;
  sizeVal.textContent = `${Math.round(settings.size * 100)}%`;
  size.addEventListener('input', () => {
    sizeVal.textContent = `${Math.round(size.value * 100)}%`;
    api.set('size', +size.value);
  });
}
init();
