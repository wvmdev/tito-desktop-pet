// Size slider popup (double-click Tito). Changes apply live.
const api = window.tito.size;
const input = document.getElementById('size');
const out = document.getElementById('val');

function show(v) {
  out.textContent = `${Math.round(v * 100)}%`;
  const pct = ((v - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--pct', `${pct}%`);
}

const bar = document.querySelector('.bar');
function refresh() {
  return api.get().then(({ value, min, max }) => {
    input.min = min; input.max = max; input.value = value;
    show(value);
  });
}
refresh();
// Popup windows are reused: pick up the current size and replay the entrance each time.
window.tito.onPopupOpen(() => {
  refresh();
  bar.classList.remove('pop-in');
  void bar.offsetWidth;
  bar.classList.add('pop-in');
});
input.addEventListener('input', () => { const v = +input.value; show(v); api.set(v); });
window.addEventListener('keydown', e => { if (e.key === 'Escape' || e.key === 'Enter') api.close(); });
