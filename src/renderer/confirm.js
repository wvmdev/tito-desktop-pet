// Confirmation popup. The title and detail are built by Tito's own code from the action's real
// arguments; the "reason" is the model's own words and is labelled as such. Everything is set
// as text, never as HTML.
const api = window.tito.confirm;
const $ = id => document.getElementById(id);
let current = null;
let enableTimer = null;

api.onShow(req => {
  current = req.id;
  $('title').textContent = req.title || 'Do something';
  $('detail').textContent = req.detail || '';
  $('detail').hidden = !req.detail;
  $('reason').textContent = req.reason ? `Tito says: ${req.reason}` : '';
  $('reason').hidden = !req.reason;
  $('why').textContent = req.why || '';
  // Allow is enabled after a short pause so a click already in flight can't approve by accident.
  $('allow').disabled = true;
  clearTimeout(enableTimer);
  enableTimer = setTimeout(() => { $('allow').disabled = false; }, 600);
});

function answer(allow) {
  if (current === null) return;
  const id = current;
  current = null;
  api.answer(id, allow);
}
$('allow').addEventListener('click', () => { if (!$('allow').disabled) answer(true); });
$('deny').addEventListener('click', () => answer(false));
