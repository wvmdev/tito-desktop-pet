// Settings window: personality picker + size (AI settings arrive in phase 5).
const api = window.tito.settings;
const ICON = {
  balanced: 'sentado', calm: 'tumbado', excited: 'jugando_pelota',
  sleepy: 'durmiendo', curious: 'mirando_arriba', grumpy: 'enfadado',
};
if (window.tito.platform !== 'darwin') document.body.classList.add('no-vibrancy');

async function init() {
  const { personalities, settings, sizeRange, stayPoses, mood, ai, security } = await api.get();

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
  const modelKey = { anthropic: 'anthropicModel', openai: 'openaiModel', custom: 'customModel' };
  const $ = id => document.getElementById(id);
  const provider = () => settings.aiProvider;
  const renderProvider = () => {
    const p = provider();
    for (const r of document.querySelectorAll('input[name=provider]')) r.checked = r.value === p;
    $('model').value = settings[modelKey[p]] || '';
    $('model').placeholder = p === 'custom' ? 'e.g. llama3.1' : '';
    $('modelList').replaceChildren(...(aiState.suggestions[p] || []).map(m => Object.assign(document.createElement('option'), { value: m })));
    $('baseRow').hidden = p !== 'custom';
    $('baseURL').value = settings.customBaseURL || '';
    const k = aiState.keys[p];
    $('keyState').textContent = !aiState.encryptionAvailable ? 'Secure storage unavailable: keys cannot be saved on this system.'
      : k.saved ? `Key saved (ending …${k.hint})` : 'No key saved yet';
    $('keyState').classList.toggle('ok', !!k.saved);
    $('removeKey').hidden = !k.saved;
    $('apiKey').value = '';
    $('apiKey').placeholder = k.saved ? 'Paste a new key to replace it' : 'Paste your key';
    $('testResult').textContent = '';
  };
  for (const r of document.querySelectorAll('input[name=provider]')) {
    r.addEventListener('change', async () => { Object.assign(settings, await api.set('aiProvider', r.value)); renderProvider(); });
  }
  $('model').addEventListener('change', async () => {
    try { Object.assign(settings, await api.set(modelKey[provider()], $('model').value)); }
    catch { $('testResult').className = 'result bad'; $('testResult').textContent = 'That model name has unsupported characters.'; }
  });
  $('baseURL').addEventListener('change', async () => {
    try { Object.assign(settings, await api.set('customBaseURL', $('baseURL').value)); $('testResult').textContent = ''; }
    catch { $('testResult').className = 'result bad'; $('testResult').textContent = 'Use an https:// address (http:// only for localhost).'; }
  });
  const saveKey = async () => {
    const v = $('apiKey').value;
    if (!v) return;
    $('apiKey').value = ''; // never keep the key in the page longer than needed
    const r = await aiApi.saveKey(provider(), v);
    aiState = r.ai;
    renderProvider();
    $('testResult').className = r.ok ? 'result ok' : 'result bad';
    $('testResult').textContent = r.ok ? 'Key saved.' : r.error;
  };
  $('saveKey').addEventListener('click', saveKey);
  $('apiKey').addEventListener('keydown', e => { if (e.key === 'Enter') saveKey(); });
  $('removeKey').addEventListener('click', async () => { aiState = (await aiApi.removeKey(provider())).ai; renderProvider(); });
  $('testBtn').addEventListener('click', async () => {
    $('testBtn').disabled = true;
    $('testResult').className = 'result';
    $('testResult').textContent = 'Testing…';
    const r = await aiApi.test();
    $('testBtn').disabled = false;
    $('testResult').className = r.ok ? 'result ok' : 'result bad';
    $('testResult').textContent = r.ok ? `Connected to ${r.model} (${(r.ms / 1000).toFixed(1)}s): "${r.text}"` : r.error.message;
  });
  renderProvider();

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
