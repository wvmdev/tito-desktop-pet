// Dev tool: a plain framed window at a known place, to see how Tito stands on a real window.
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const w = new BrowserWindow({ x: 300, y: 300, width: 600, height: 380, title: 'Test window', backgroundColor: '#ffffff' });
  w.loadURL('data:text/html,<body style="font:20px -apple-system;padding:30px">Test window for Tito</body>');
  setTimeout(() => app.quit(), +process.env.LIFE || 25000);
});
