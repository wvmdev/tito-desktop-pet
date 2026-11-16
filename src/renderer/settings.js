// Settings window: personality picker + size (AI settings arrive in phase 5).
const api = window.tito.settings;
const ICON = {
  balanced: 'sentado', calm: 'tumbado', excited: 'jugando_pelota',
  sleepy: 'durmiendo', curious: 'mirando_arriba', grumpy: 'enfadado',
};
if (window.tito.platform !== 'darwin') document.body.classList.add('no-vibrancy');

async function init() {
  const { personalities, settings, sizeRange } = await api.get();

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
