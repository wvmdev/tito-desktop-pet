// Tito — main process.
// Autonomous pet with personalities that walks on the desktop floor and on app windows,
// click -> Settings/Chat popup, double-click -> size slider, drag & drop with falling.
const { app, BrowserWindow, screen, ipcMain, protocol, net, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { Brain } = require('./brain');
const { Settings, SIZE_MIN, SIZE_MAX } = require('./settings');
const { personalityList, STAY_POSES } = require('./personalities');

const ROOT = path.join(__dirname, '..');
// Base window box at size 1. Sprites are normalised so Tito looks the same size in every
// animation; the box fits the longest pose (running) with room to spare.
const BASE_W = 280;
const BASE_H = 270; // tallest pose (panza_arriba while held) is ~251px
const isMac = process.platform === 'darwin';

// Serve the app from tito://app/... so renderer pages and sprites are same-origin
// (needed for canvas alpha hit-testing; file:// images taint canvases).
protocol.registerSchemesAsPrivileged([
  { scheme: 'tito', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let petWin = null;
let popupWin = null;   // the one small glass popup currently open: 'menu' or 'size'
let popupKind = null;
let settingsWin = null;
let tray = null;
let brain = null;
let settings = null;
let windowFeed = null;

const pageURL = name => `tito://app/src/renderer/${name}`;
const petDims = size => ({ W: Math.round(BASE_W * size), H: Math.round(BASE_H * size) });
const secureWebPrefs = () => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true, nodeIntegration: false, sandbox: true,
});

function serveAppFiles() {
  protocol.handle('tito', req => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(ROOT, decodeURIComponent(pathname)));
    if (!file.startsWith(ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

// ---------- the pet window ----------
function createPetWindow() {
  const size = settings.get('size');
  const { W, H } = petDims(size);
  const { workArea } = screen.getPrimaryDisplay();
  petWin = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(workArea.x + (workArea.width - W) / 2),
    y: Math.round(workArea.y + workArea.height - H),
    // A non-activating panel receives clicks without activating the app first, so every click
    // on Tito registers immediately (a normal window spends the first click on activation).
    ...(isMac ? { type: 'panel' } : {}),
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    backgroundColor: '#00000000',
    webPreferences: secureWebPrefs(),
  });
  // 'screen-saver' level keeps Tito above normal and floating windows (incl. full-screen apps).
  petWin.setAlwaysOnTop(true, 'screen-saver');
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  setIgnore(true);
  petWin.loadURL(pageURL('pet.html'));
  petWin.webContents.on('did-finish-load', () => petWin.webContents.send('pet:size', size));
  startCursorWatch();
  petWin.on('closed', () => { petWin = null; });

  brain = new Brain({
    width: W,
    height: H,
    size,
    setPosition: (x, y) => petWin && !petWin.isDestroyed() && petWin.setPosition(x, y),
    play: anim => petWin && !petWin.isDestroyed() && petWin.webContents.send('pet:play', anim),
    personality: settings.get('personality'),
  });
  const b = petWin.getBounds();
  brain.placeAt(b.x, b.y);
  brain.on('openMenu', () => openPopup('menu'));
  brain.on('openSize', () => openPopup('size'));
  brain.on('closeMenu', closePopup);
  if (process.env.TITO_DEBUG) brain.on('mode', (m, info) => console.log('[brain]', m, JSON.stringify(info), 'at', Math.round(brain.x), Math.round(brain.y)));
  if (settings.get('stayStill')) brain.setStay(settings.get('stayPose'));
  if (process.env.TITO_STAY) brain.setStay('sentado'); // dev: sit still for input testing
}

function applySize(size) {
  if (!petWin || !brain) return;
  const { W, H } = petDims(size);
  const nx = Math.round(brain.x + (brain.W - W) / 2);
  const ny = Math.round(brain.y + brain.H - H);
  petWin.setBounds({ x: nx, y: ny, width: W, height: H });
  brain.setDims(W, H, size);
  petWin.webContents.send('pet:size', size);
}

// ---------- click-through ----------
// The window ignores the mouse except while the real cursor is over Tito's body. We poll the
// cursor (macOS doesn't reliably forward mouse moves to ignored windows) so this also works
// when Tito walks under a stationary pointer.
let ignoring = null;
function setIgnore(v) {
  if (!petWin || petWin.isDestroyed() || v === ignoring) return;
  ignoring = v;
  petWin.setIgnoreMouseEvents(v, { forward: true });
}
function startCursorWatch() {
  if (process.env.TITO_SMOKE) return; // synthetic-input tests must not be disturbed by the real cursor
  setInterval(() => {
    if (!petWin || petWin.isDestroyed()) return;
    if (brain && brain.mode === 'held') return; // keep events while dragging
    const c = screen.getCursorScreenPoint();
    const b = petWin.getBounds();
    const inside = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
    if (inside) petWin.webContents.send('pet:hover', { x: c.x - b.x, y: c.y - b.y });
    else setIgnore(true);
  }, 25);
}

// ---------- other apps' windows (so Tito can stand on / climb them) ----------
function startWindowFeed() {
  if (!isMac || process.env.TITO_SMOKE || process.env.TITO_NO_WINDOWS || process.env.TITO_FAKE_WINDOWS) return;
  const bin = path.join(ROOT, 'bin', 'tito-windows');
  const src = path.join(ROOT, 'native', 'windows.swift');
  const run = () => {
    windowFeed = spawn(bin, [String(process.pid), '250'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    windowFeed.stdout.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        try { brain && brain.setWindows(JSON.parse(line)); } catch { /* partial line */ }
      }
    });
    windowFeed.on('exit', () => { windowFeed = null; });
  };
  if (fs.existsSync(bin)) return run();
  // First run from source: build the helper if the Swift toolchain is present.
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  execFile('swiftc', ['-O', src, '-o', bin], err => {
    if (err) console.warn('Window detection disabled: could not build bin/tito-windows (needs Xcode command line tools).');
    else run();
  });
}

// ---------- glass popups: 'menu' (Settings / Chat) and 'size' (slider) ----------
const POPUPS = {
  // Compact pills (window includes ~7px around the pill for its shadow).
  menu: { page: 'popup.html', w: 104, h: 50 },
  size: { page: 'size.html', w: 196, h: 50 },
};

// Popups are created once, hidden, and reused: showing an existing window is near-instant,
// building a new one each click took ~0.5s.
const popupWins = {};

function ensurePopup(kind) {
  const existing = popupWins[kind];
  if (existing && !existing.isDestroyed()) return existing;
  const spec = POPUPS[kind];
  const win = new BrowserWindow({
    width: spec.w, height: spec.h,
    show: false, transparent: true, frame: false, hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, acceptFirstMouse: true,
    backgroundColor: '#00000000',
    webPreferences: secureWebPrefs(),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadURL(pageURL(spec.page));
  win.on('blur', () => { if (popupWin === win) closePopup(); });
  win.on('closed', () => { if (popupWins[kind] === win) delete popupWins[kind]; });
  popupWins[kind] = win;
  return win;
}

function openPopup(kind) {
  if (!petWin) return;
  if (popupWin) closePopup();
  const spec = POPUPS[kind];
  const b = petWin.getBounds();
  const a = screen.getDisplayMatching(b).workArea;
  const size = settings.get('size');
  // Just above Tito's head (sitting sprite is ~130px tall at size 1, bottom-anchored).
  let x = Math.round(b.x + b.width / 2 - spec.w / 2);
  let y = Math.round(b.y + b.height - 130 * size - spec.h);
  x = Math.min(a.x + a.width - spec.w, Math.max(a.x, x));
  y = Math.min(a.y + a.height - spec.h, Math.max(a.y, y));

  const win = ensurePopup(kind);
  popupWin = win;
  popupKind = kind;
  win.setBounds({ x, y, width: spec.w, height: spec.h });
  const reveal = () => {
    if (popupWin !== win) return;
    win.webContents.send('popup:open');
    // Dock icon is hidden, so explicitly take focus — blur is how "click elsewhere" dismisses it.
    app.focus({ steal: true });
    win.show();
    win.focus();
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', reveal); else reveal();
}

function closePopup() {
  const win = popupWin;
  if (!win) return;
  popupWin = null;
  popupKind = null;
  if (!win.isDestroyed()) win.hide();
  brain && brain.menuClosed();
}

// ---------- IPC (only accepted from our own windows) ----------
const fromPet = e => petWin && e.sender === petWin.webContents;
const fromPopup = kind => e => { const w = popupWins[kind]; return !!w && !w.isDestroyed() && e.sender === w.webContents; };
const fromSettings = e => settingsWin && e.sender === settingsWin.webContents;
const isNum = n => typeof n === 'number' && Number.isFinite(n);

function registerIpc() {
  ipcMain.on('pet:ready', e => { if (fromPet(e)) brain.start(); });
  ipcMain.on('pet:ignore-mouse', (e, ignore) => { if (fromPet(e)) setIgnore(!!ignore); });
  ipcMain.on('pet:click', e => { if (fromPet(e)) brain.click(); });
  ipcMain.on('pet:dblclick', e => { if (fromPet(e)) brain.dblclick(); });
  let grab = { ox: 0, oy: 0 };
  ipcMain.on('pet:drag-start', (e, p) => {
    if (!fromPet(e) || !p || !isNum(p.ox) || !isNum(p.oy)) return;
    grab = { ox: p.ox, oy: p.oy };
    brain.dragStart();
  });
  ipcMain.on('pet:drag-move', (e, p) => {
    if (!fromPet(e) || !p || !isNum(p.sx) || !isNum(p.sy)) return;
    brain.dragMove(p.sx - grab.ox, p.sy - grab.oy);
  });
  ipcMain.on('pet:drag-end', e => { if (fromPet(e)) brain.dragEnd(); });

  const fromMenu = fromPopup('menu');
  ipcMain.on('menu:close', e => { if (fromMenu(e)) closePopup(); });
  ipcMain.on('menu:settings', e => { if (fromMenu(e)) { closePopup(); openSettings(); } });

  const fromSize = fromPopup('size');
  ipcMain.handle('size:get', e => {
    if (!fromSize(e)) throw new Error('denied');
    return { value: settings.get('size'), min: SIZE_MIN, max: SIZE_MAX };
  });
  ipcMain.on('size:set', (e, v) => { if (fromSize(e) && isNum(v)) settings.set('size', v); });
  ipcMain.on('size:close', e => { if (fromSize(e)) closePopup(); });

  ipcMain.handle('settings:get', e => {
    if (!fromSettings(e)) throw new Error('denied');
    return { settings: settings.all(), personalities: personalityList(), sizeRange: [SIZE_MIN, SIZE_MAX], stayPoses: STAY_POSES };
  });
  ipcMain.handle('settings:set', (e, key, value) => {
    if (!fromSettings(e)) throw new Error('denied');
    settings.set(key, value);
    return settings.all();
  });
}

// ---------- settings window (native macOS blur behind translucent "glass" cards) ----------
function openSettings() {
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 500, height: 640, minWidth: 440, minHeight: 460,
    title: 'Tito Settings', show: false,
    ...(isMac ? {
      vibrancy: 'under-window', visualEffectState: 'active',
      titleBarStyle: 'hiddenInset', transparent: true, backgroundColor: '#00000000',
    } : {}),
    webPreferences: secureWebPrefs(),
  });
  settingsWin.loadURL(pageURL('settings.html'));
  settingsWin.once('ready-to-show', () => { app.focus({ steal: true }); settingsWin.show(); settingsWin.focus(); });
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ---------- menu-bar icon (Dock icon is hidden, so this is how you quit) ----------
function createTray() {
  const icon = nativeImage
    .createFromPath(path.join(ROOT, 'assets/sprites/sentado/sentado_0.png'))
    .resize({ height: 18 });
  tray = new Tray(icon);
  tray.setToolTip('Tito');
  refreshTrayMenu();
}
// Rebuilt whenever stay-still changes so the checkbox always matches Settings.
function refreshTrayMenu() {
  if (!tray) return;
  const pose = STAY_POSES.find(p => p.id === settings.get('stayPose'));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Settings…', click: openSettings },
    { label: 'Size…', click: () => openPopup('size') },
    { label: `Stay still (${pose ? pose.label.toLowerCase() : 'sitting'})`, type: 'checkbox',
      checked: settings.get('stayStill'), click: item => settings.set('stayStill', item.checked) },
    { type: 'separator' },
    { label: 'Quit Tito', role: 'quit' },
  ]));
}

app.whenReady().then(() => {
  if (isMac && app.dock) app.dock.hide();
  serveAppFiles();
  settings = new Settings();
  settings.on('change', (key, value) => {
    if (key === 'personality' && brain) brain.setPersonality(value);
    if (key === 'size') applySize(value);
    if (key === 'stayStill' || key === 'stayPose') {
      if (brain) brain.setStay(settings.get('stayStill') ? settings.get('stayPose') : null);
      refreshTrayMenu();
      if (settingsWin) settingsWin.webContents.send('settings:changed', settings.all());
    }
  });
  registerIpc();
  createPetWindow();
  createTray();
  ensurePopup('menu');
  ensurePopup('size');
  startWindowFeed();
  if (process.env.TITO_SMOKE) {
    require('./smoke').run({
      app, petWin, brain, settings, openSettings, openPopup,
      getPopup: () => ({ win: popupWin, kind: popupKind }), getSettingsWin: () => settingsWin,
    });
  }
  if (process.env.TITO_RECORD) require('./record').run({ app, petWin, brain });
});

app.on('will-quit', () => { if (windowFeed) windowFeed.kill(); });
app.on('window-all-closed', () => app.quit());
