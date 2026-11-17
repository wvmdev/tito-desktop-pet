// Dev tool: a plain framed window at a known place, to see how Tito stands on a real window.
// Env: WX WY WW WH (bounds), TITLE, LIFE (ms).
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const n = (k, d) => (process.env[k] ? +process.env[k] : d);
  const w = new BrowserWindow({ x: n('WX', 300), y: n('WY', 300), width: n('WW', 600), height: n('WH', 380), title: process.env.TITLE || 'Test window', backgroundColor: '#ffffff' });
  w.loadURL(`data:text/html,<body style="font:20px -apple-system;padding:30px">${process.env.TITLE || 'Test window'} for Tito</body>`);
  setTimeout(() => app.quit(), n('LIFE', 25000));
});
