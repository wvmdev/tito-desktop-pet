// Settings / Chat popup.
const bar = document.getElementById('bar');
const note = document.getElementById('note');

document.getElementById('settings').addEventListener('click', () => window.tito.menu.openSettings());
document.getElementById('chat').addEventListener('click', () => window.tito.menu.openChat());
window.addEventListener('keydown', e => { if (e.key === 'Escape') window.tito.menu.close(); });

// Popup windows are reused: reset state and replay the entrance each time it's shown.
window.tito.onPopupOpen(() => {
  bar.classList.remove('noting', 'pop-in');
  void bar.offsetWidth;
  bar.classList.add('pop-in');
});
