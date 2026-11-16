// Settings window: personality picker + size (AI settings arrive in phase 5).
const api = window.tito.settings;
const ICON = {
  balanced: 'sentado', calm: 'tumbado', excited: 'jugando_pelota',
  sleepy: 'durmiendo', curious: 'mirando_arriba', grumpy: 'enfadado',
};
if (window.tito.platform !== 'darwin') document.body.classList.add('no-vibrancy');

async function init() {
  const { personalities, settings, sizeRange, stayPoses, mood } = await api.get();

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
