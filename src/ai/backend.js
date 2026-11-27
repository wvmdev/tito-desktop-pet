// Picks the computer-control backend for this platform (see mac-backend.js and win-backend.js).
function createBackend(opts) {
  if (process.platform === 'win32') return require('./win-backend').createWinBackend(opts);
  return require('./mac-backend').createMacBackend(opts);
}
module.exports = { createBackend };
