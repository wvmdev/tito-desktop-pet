// Settings window: personality picker + size (AI settings arrive in phase 5).
const api = window.tito.settings;
const ICON = {
  balanced: 'sentado', calm: 'tumbado', excited: 'jugando_pelota',
  sleepy: 'durmiendo', curious: 'mirando_arriba', grumpy: 'enfadado',
};
if (window.tito.platform !== 'darwin') document.body.classList.add('no-vibrancy');

async function init() {
  const { personalities, settings, sizeRange, stayPoses, mood, ai, security, tasks } = await api.get();

  const grid = document.getElementById('personalities');
  for (const p of personalities) {
    const label = document.createElement('label');
    label.className = 'card glass';
    const input = Object.assign(document.createElement('input'), {
      type: 'radio', name: 'personality', value: p.id, checked: p.id === settings.personality,
    });
    const img = Object.assign(document.createElement('img'), {
      src: `../../assets/sprites/${ICON[p.id]}/${ICON[p.id]}_0.png`, alt: '',
    });
    const text = document.createElement('div');
    text.append(
      Object.assign(document.createElement('div'), { className: 'name', textContent: p.label }),
      Object.assign(document.createElement('div'), { className: 'desc', textContent: p.description }),
    );
    label.append(input, img, text);
    input.addEventListener('change', async () => {
      await api.set('personality', p.id);
      document.getElementById('saved').textContent = `Tito is now ${p.label.toLowerCase()}.`;
    });
    grid.append(label);
  }

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
    $('localText').textContent = pi.local ? `No key needed. Make sure ${pi.label.replace(/ \(.*/, '')} is running on this Mac.` : '';
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
