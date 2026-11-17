// Tito — main process.
// Autonomous pet with personalities that walks on the desktop floor and on app windows,
// click -> Settings/Chat popup, double-click -> size slider, drag & drop with falling.
const { app, BrowserWindow, screen, ipcMain, protocol, net, Tray, Menu, nativeImage, powerMonitor, dialog, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { Brain } = require('./brain');
const { Settings, SIZE_MIN, SIZE_MAX } = require('./settings');
const { personalityList, STAY_POSES, EMOTIONS, EMOTION_INFO } = require('./personalities');
const { Mood } = require('./mood');
const CR = require('./companion-rules');
const { Awareness } = require('./awareness');
const { SecretStore } = require('./ai/secrets');
const { createProvider, normalizeError, PROVIDERS, providerList } = require('./ai/providers');
const { LEVELS, PERM_TOGGLES } = require('./ai/permissions');
const { ChatSession } = require('./chat');
const { availableTools } = require('./ai/tools');
const { Executor } = require('./ai/executor');
const { createMacBackend } = require('./ai/mac-backend');
const { TaskScheduler } = require('./tasks');

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

// Dev runs (smoke test / recorder) use a throwaway profile so they never touch real settings.
if (process.env.TITO_SMOKE || process.env.TITO_RECORD || process.env.TITO_SHOT || process.env.TITO_DEV_DROP || process.env.TITO_TRIAL || process.env.TITO_DEV || process.env.TITO_SHOT_PERS) {
  const real = app.getPath('userData');
  const tmp = path.join(require('os').tmpdir(), `tito-dev-${process.pid}`);
  app.setPath('userData', tmp);
  // A trial uses the user's saved provider/model/key from a COPY of the profile (the real one is never written).
  if (process.env.TITO_TRIAL) {
    fs.mkdirSync(tmp, { recursive: true });
    for (const f of ['settings.json', 'secrets.json']) { try { fs.copyFileSync(path.join(real, f), path.join(tmp, f)); } catch { /* none yet */ } }
  }
}

// One Tito at a time: launching again just brings the existing one's Settings forward.
const DEV_RUN = !!(process.env.TITO_SMOKE || process.env.TITO_RECORD || process.env.TITO_SHOT || process.env.TITO_DEV_DROP || process.env.TITO_TRIAL || process.env.TITO_DEV || process.env.TITO_SHOT_PERS);
if (!DEV_RUN && !app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { if (settings) openSettings(); });

// Our windows only ever show our own pages: no navigation, no new windows.
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', (e, url) => { if (!url.startsWith('tito://app/')) e.preventDefault(); });
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
});

let petWin = null;
let popupWin = null;   // the one small glass popup currently open: 'menu' or 'size'
let popupKind = null;
let settingsWin = null;
let tray = null;
let brain = null;
let settings = null;
let windowFeed = null;
let mood = null;
let secrets = null;
let chat = null;
let chatWin = null;
let executor = null;
let confirmWin = null;
let pendingConfirm = null; // { id, resolve }
let scheduler = null;

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
    setPosition: placePet,
    getCursor: () => screen.getCursorScreenPoint(),
    play: anim => petWin && !petWin.isDestroyed() && petWin.webContents.send('pet:play', anim),
    personality: settings.get('personality'),
    getCustoms: () => settings.get('customPersonalities'),
  });
  const b = petWin.getBounds();
  brain.placeAt(b.x, b.y);
  brain.on('openMenu', () => openPopup('menu'));
  brain.on('openSize', () => openPopup('size'));
  brain.on('closeMenu', closePopup);
  brain.on('pet', petted);
  if (process.env.TITO_DEBUG) brain.on('wall', w => console.log('[wall]', w.climbable ? 'climbable' : `NOT climbable: ${w.why}`));
  if (process.env.TITO_DEBUG) brain.on('mode',(m, info) => console.log('[brain]', m, JSON.stringify(info), 'at', Math.round(brain.x), Math.round(brain.y)));
  if (settings.get('stayStill')) brain.setStay(settings.get('stayPose'));
  if (process.env.TITO_STAY) brain.setStay('sentado'); // dev: sit still for input testing
}

// macOS keeps windows below the menu bar. When Tito stands high up (e.g. on a window whose top is
// near the menu bar) his window would need to start above it, so instead the window stops at the
// menu bar and the sprite is drawn higher inside it ("lift"). The window's top part is empty anyway.
let lastLift = 0;
function placePet(x, y) {
  if (!petWin || petWin.isDestroyed()) return;
  const b = petWin.getBounds();
  const a = screen.getDisplayNearestPoint({ x: Math.round(x + b.width / 2), y: Math.round(y + b.height) }).workArea;
  const lift = y < a.y ? Math.round(a.y - y) : 0;
  petWin.setPosition(x, y + lift);
  if (lift !== lastLift) { lastLift = lift; petWin.webContents.send('pet:lift', lift); }
}

function applySize(size) {
  if (!petWin || !brain) return;
  const { W, H } = petDims(size);
  petWin.setSize(W, H);
  brain.setDims(W, H, size); // re-places the window (with lift) keeping his feet planted
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

// ---------- sleep when the user is away ----------
// Electron reports how long since the last mouse/keyboard input (no permissions needed).
let nudged = false;
function checkActivity(idleSec = powerMonitor.getSystemIdleTime()) {
  if (!brain) return;
  const limit = settings.get('sleepAfterMin');
  if (brain.mode === 'sleep') { if (idleSec < 3) brain.wake(); return; }
  // Quiet for a while but not yet asleep: a little wave, once per quiet spell.
  const nudgeAt = limit > 0 ? Math.min(180, limit * 60 * 0.6) : 180;
  if (idleSec < 5) nudged = false;
  else if (!nudged && idleSec >= nudgeAt && settings.get('reactions')) { nudged = true; brain.react(['saludando', 'buscando'], { loops: 2 }); }
  if (limit > 0 && idleSec >= limit * 60) brain.sleep();
}
function startActivityWatch() {
  if (process.env.TITO_SMOKE) return; // tests call checkActivity() with fake idle times
  setInterval(() => checkActivity(), 2000);
  powerMonitor.on('lock-screen', () => brain && brain.sleep());
  powerMonitor.on('unlock-screen', () => brain && brain.wake());
}

// ---------- companion: bond, hunger, petting ----------
let lastPetAt = 0;
let awareness = null;
const companionState = () => ({ bond: settings.get('bond'), hunger: CR.hunger(settings.get('lastFed')) });
function companionInfo() {
  const { bond, hunger } = companionState();
  return { bond, tier: CR.bondTier(bond).label, hunger, hungerLabel: CR.hungerLabel(hunger), canFeed: hunger >= CR.FEED_MIN_HUNGER };
}
function pushCompanion() {
  if (brain) brain.setCompanion(companionState());
  if (mood) mood.recompute();
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:companion', companionInfo());
}
function initCompanion() {
  const now = Date.now();
  if (!settings.get('lastFed')) settings.set('lastFed', now); // starts full
  settings.set('bond', CR.decay(settings.get('bond'), settings.get('lastSeen'), now));
  settings.set('lastSeen', now);
  setInterval(() => { settings.set('lastSeen', Date.now()); pushCompanion(); }, 10 * 60 * 1000);
}
function petted() {
  const r = CR.pet(settings.get('bond'), lastPetAt);
  if (!r.counted) return;
  lastPetAt = Date.now();
  settings.set('bond', r.bond);
  pushCompanion();
}
// Returns { ok, message }.
function feedTito() {
  const r = CR.feed(settings.get('bond'), settings.get('lastFed'));
  if (!r.ok) { if (brain) brain.react('sentado', { loops: 1 }); return { ok: false, message: r.reason }; }
  settings.set('bond', r.bond);
  settings.set('lastFed', r.lastFed);
  if (brain) brain.eat();
  pushCompanion();
  refreshTrayMenu();
  return { ok: true, message: 'Yum!' };
}
// Music, battery and long idle spells (needs no screen access).
let lowBatteryFired = 0;
function startAwareness() {
  if (process.env.TITO_SMOKE) return;
  awareness = new Awareness();
  awareness.on('music', on => { if (brain && settings.get('reactions')) brain.setMusic(on); });
  awareness.start();
  mood.on('change', () => {
    const b = mood.battery;
    if (!b || b.charging || typeof b.percent !== 'number') { lowBatteryFired = 0; return; }
    const level = b.percent <= 10 ? 2 : b.percent <= 20 ? 1 : 0;
    if (level > lowBatteryFired && brain && settings.get('reactions')) brain.react(level === 2 ? 'asustado' : 'cansado', { loops: 2 });
    lowBatteryFired = level;
  });
}

// ---------- mood (time of day, battery, weather, day of week) ----------
function startMood() {
  mood = new Mood(settings);
  mood.companion = companionState;
  mood.on('change', summary => {
    if (brain) brain.setMood(mood.state);
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:mood', summary);
  });
  if (!process.env.TITO_SMOKE) mood.start(); else mood.recompute();
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
  menu: { page: 'popup.html', w: 146, h: 50 },
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
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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
  // Just above Tito's head (sitting sprite is ~130px tall at size 1; feet at brain.footY()).
  let x = Math.round(brain.footX() - spec.w / 2);
  let y = Math.round(brain.footY() - 130 * size - spec.h);
  x = Math.min(a.x + a.width - spec.w, Math.max(a.x, x));
  y = Math.min(a.y + a.height - spec.h, Math.max(a.y, y));

  const win = ensurePopup(kind);
  popupWin = win;
  popupKind = kind;
  win.setBounds({ x, y, width: spec.w, height: spec.h });
  const reveal = () => {
    if (popupWin !== win) return;
    win.webContents.send('popup:open');
    // Show without activating the app: taking focus here is what made macOS jump to another window or
    // desktop (Claude's) whenever Tito was clicked. With no focus there is no blur event, so a small
    // watcher closes the popup once the mouse has left it (or it was never used).
    win.showInactive();
    watchPopup(win);
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', reveal); else reveal();
}

let popupTimer = null;
function watchPopup(win) {
  clearInterval(popupTimer);
  if (process.env.TITO_SMOKE) return; // tests drive the popups by hand
  const t0 = Date.now();
  let entered = false, leftAt = 0;
  popupTimer = setInterval(() => {
    if (popupWin !== win || win.isDestroyed()) { clearInterval(popupTimer); return; }
    const c = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const m = 14;
    const inside = c.x >= b.x - m && c.x <= b.x + b.width + m && c.y >= b.y - m && c.y <= b.y + b.height + m;
    if (inside) { entered = true; leftAt = 0; return; }
    if (entered) { if (!leftAt) leftAt = Date.now(); if (Date.now() - leftAt > 700) closePopup(); }
    else if (Date.now() - t0 > 4000) closePopup();
  }, 120);
}

function closePopup() {
  clearInterval(popupTimer);
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
  ipcMain.on('menu:chat', e => { if (fromMenu(e)) { closePopup(); openChat(); } });
  ipcMain.on('menu:feed', e => { if (fromMenu(e)) { const r = feedTito(); if (r.ok) closePopup(); else e.sender.send('popup:note', r.message); } });
  ipcMain.handle('companion:get', e => { if (!fromSettings(e)) throw new Error('denied'); return companionInfo(); });
  ipcMain.handle('companion:feed', e => { if (!fromSettings(e)) throw new Error('denied'); return { ...feedTito(), info: companionInfo() }; });

  const fromChat = e => chatWin && e.sender === chatWin.webContents;
  ipcMain.handle('chat:get', e => {
    if (!fromChat(e)) throw new Error('denied');
    return { history: chat.history(), status: chatStatus(), expanded: settings.get('chatExpanded') };
  });
  ipcMain.on('chat:send', (e, text) => { if (fromChat(e) && typeof text === 'string') chat.send(text); });
  ipcMain.on('chat:stop', e => { if (fromChat(e)) stopTask(); });
  // Approval can only come from the confirmation window itself, for the question now showing.
  ipcMain.on('confirm:answer', (e, id, allow) => {
    if (!confirmWin || e.sender !== confirmWin.webContents) return;
    resolveConfirm(allow === true ? 'allow' : 'deny', id);
  });
  ipcMain.handle('chat:clear', e => { if (!fromChat(e)) throw new Error('denied'); chat.clear(); });
  ipcMain.on('chat:open-settings', e => { if (fromChat(e)) openSettings(); });
  ipcMain.on('chat:set-expanded', (e, on) => { if (fromChat(e)) { settings.set('chatExpanded', !!on); resizeChat(); } });

  const fromSize = fromPopup('size');
  ipcMain.handle('size:get', e => {
    if (!fromSize(e)) throw new Error('denied');
    return { value: settings.get('size'), min: SIZE_MIN, max: SIZE_MAX };
  });
  ipcMain.on('size:set', (e, v) => { if (fromSize(e) && isNum(v)) settings.set('size', v); });
  ipcMain.on('size:close', e => { if (fromSize(e)) closePopup(); });

  ipcMain.handle('settings:get', e => {
    if (!fromSettings(e)) throw new Error('denied');
    return {
      settings: settings.all(), personalities: personalityList(settings.get('customPersonalities')), sizeRange: [SIZE_MIN, SIZE_MAX],
      stayPoses: STAY_POSES, mood: mood && mood.summary(), companion: companionInfo(), ai: aiStatus(), tasks: scheduler.list(),
      emotions: EMOTIONS.map(id => ({ id, ...EMOTION_INFO[id] })),
      security: { levels: LEVELS, toggles: PERM_TOGGLES },
    };
  });
  ipcMain.handle('settings:set', async (e, key, value) => {
    if (!fromSettings(e)) throw new Error('denied');
    // Full Access needs an explicit yes in a native dialog (only the user's own click counts).
    if (key === 'securityLevel' && value === 'full' && settings.get('securityLevel') !== 'full') {
      const { response } = await dialog.showMessageBox(settingsWin, {
        type: 'warning',
        buttons: ['Cancel', 'Enable Full Access'],
        defaultId: 0,
        cancelId: 0,
        message: 'Give Tito full access to your computer?',
        detail: 'With Full Access, Tito can click, type, open apps, change and delete files, and send messages '
          + 'without asking you first, including irreversible actions. Mistakes or instructions hidden in '
          + 'web pages or files could cause real damage.\n\nYou can press Esc to stop any action, and switch back '
          + 'to Guarded at any time.',
      });
      if (response !== 1) return settings.all();
    }
    settings.set(key, value);
    return settings.all();
  });

  // ---- scheduled tasks (created here by the user's own clicks) ----
  ipcMain.handle('tasks:add', (e, task) => {
    if (!fromSettings(e)) throw new Error('denied');
    try { scheduler.add(task); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('tasks:remove', (e, id) => { if (!fromSettings(e)) throw new Error('denied'); scheduler.remove(String(id)); });
  ipcMain.handle('tasks:toggle', (e, id, on) => {
    if (!fromSettings(e)) throw new Error('denied');
    settings.set('tasks', settings.get('tasks').map(t => (t.id === id ? { ...t, enabled: !!on } : t)));
  });

  // ---- AI provider: keys and connection test (keys never travel back to the renderer) ----
  ipcMain.handle('ai:save-key', (e, provider, key) => {
    if (!fromSettings(e)) throw new Error('denied');
    try {
      secrets.set(provider, key);
      if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('chat:status', chatStatus());
      return { ok: true, ai: aiStatus() };
    }
    catch (err) { return { ok: false, error: err.message, ai: aiStatus() }; }
  });
  ipcMain.handle('ai:remove-key', (e, provider) => {
    if (!fromSettings(e)) throw new Error('denied');
    secrets.remove(provider);
    if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('chat:status', chatStatus());
    return { ok: true, ai: aiStatus() };
  });
  ipcMain.handle('ai:list-models', async e => {
    if (!fromSettings(e)) throw new Error('denied');
    const key = secrets.get(settings.get('aiProvider'));
    try { return { ok: true, models: await currentProvider({ requireModel: false }).listModels() }; }
    catch (err) { return { ok: false, error: normalizeError(err, [key]) }; }
  });
  // Opens the provider's own key page; only URLs from the built-in registry, never one from the page.
  ipcMain.handle('ai:open-key-page', (e, id) => {
    if (!fromSettings(e)) throw new Error('denied');
    const url = PROVIDERS[id] && PROVIDERS[id].keyPage;
    if (url) shell.openExternal(url);
  });
  ipcMain.handle('ai:test', async e => {
    if (!fromSettings(e)) throw new Error('denied');
    return testConnection();
  });
}

// ---------- AI provider ----------
function aiStatus() {
  return { keys: secrets.status(), encryptionAvailable: secrets.available(), providers: providerList() };
}

// The provider currently chosen in Settings, with its key decrypted just in time.
function currentProvider(overrides = {}) {
  const provider = settings.get('aiProvider');
  return createProvider({
    provider, model: settings.get('aiModels')[provider], apiKey: secrets.get(provider),
    baseURL: provider === 'custom' ? settings.get('customBaseURL') : undefined,
    ...overrides,
  });
}

async function testConnection(overrides) {
  const provider = settings.get('aiProvider');
  const key = secrets.get(provider);
  const t0 = Date.now();
  try {
    const p = currentProvider(overrides);
    const r = await p.sendMessage([{ role: 'user', content: 'Reply with exactly: Tito is connected.' }],
      { maxTokens: 200, effort: 'low' });
    if (r.refused) return { ok: false, error: { code: 'refused', message: 'The model declined the test message.' } };
    return { ok: true, text: r.text.trim().slice(0, 200), model: r.model, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: normalizeError(err, [key]) };
  }
}

// ---------- chat ----------
function chatStatus() {
  const id = settings.get('aiProvider');
  const p = PROVIDERS[id];
  const needsKey = !p.local && !secrets.get(id);
  const model = settings.get('aiModels')[id];
  if (needsKey) return `${p.label}: add an API key in Settings`;
  return model ? `${p.label} · ${model}` : `${p.label}: choose a model in Settings`;
}

function startChat() {
  // The Esc key the model itself presses must not trip our own global Stop shortcut.
  const backend = createMacBackend({ getPetDisplayPoint: () => ({ x: Math.round(brain.footX()), y: Math.round(brain.footY()) }) });
  const rawInput = backend.input;
  backend.input = async (args, stdin) => {
    const esc = args[0] === 'key' && /(^|\+)(esc|escape)$/.test(args[1] || '');
    if (esc) globalShortcut.unregister('Escape');
    try { return await rawInput(args, stdin); }
    finally { if (esc && chat && chat.busy) setTimeout(() => { if (chat.busy) registerStopKey(); }, 250); }
  };
  executor = new Executor({ backend });
  scheduler = new TaskScheduler({
    settings,
    getExecutor: () => executor,
    getSecrets: () => Object.keys(PROVIDERS).map(id => secrets.get(id)).filter(Boolean),
  });
  executor.tasks = scheduler;
  const pushTasks = () => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:tasks', scheduler.list()); };
  scheduler.on('ran', pushTasks);
  settings.on('change', key => { if (key === 'tasks' || key === 'tasksPaused') { scheduler.sync(); pushTasks(); refreshTrayMenu(); } });
  if (!process.env.TITO_SMOKE) scheduler.sync();

  chat = new ChatSession({
    getProvider: () => currentProvider(),
    getSecrets: () => Object.keys(PROVIDERS).map(id => secrets.get(id)).filter(Boolean),
    normalizeError,
    getMood: () => mood && mood.summary(),
    getModelKey: () => `${settings.get('aiProvider')}:${settings.get('aiModels')[settings.get('aiProvider')]}`,
    getTools: () => availableTools(settings.get('securityLevel'), settings.get('actionPerms')),
    getPolicy: () => ({ level: settings.get('securityLevel'), perms: settings.get('actionPerms') }),
    executor,
    confirm: askUser,
    // Esc stops Tito from anywhere, but only while a task that can act is running.
    onTurnStart: hasTools => { if (hasTools) registerStopKey(); },
    onTurnEnd: () => { globalShortcut.unregister('Escape'); resolveConfirm('deny'); },
  });
  const toWin = (ch, data) => { if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send(ch, data); };
  chat.on('start', () => brain && brain.setChatting(true));
  chat.on('delta', d => toWin('chat:delta', d));
  chat.on('action', a => toWin('chat:action', a));
  chat.on('done', d => toWin('chat:done', d));
  chat.on('error', e => toWin('chat:error', e));
  chat.on('idle', () => { toWin('chat:idle'); if (brain) brain.setChatting(false); });
}

function registerStopKey() {
  if (!globalShortcut.isRegistered('Escape')) globalShortcut.register('Escape', stopTask);
}
// Stop whatever Tito is doing right now (Esc, the Stop button, or closing the chat).
function stopTask() {
  if (chat) chat.stop();
  resolveConfirm('deny');
}

// ---------- confirmation popup ----------
// The only way an "ask" action gets approved: the user's own click on Allow in this window.
// It is a non-activating panel, so answering it doesn't pull keyboard focus away from the app
// Tito is working in.
function ensureConfirmWin() {
  if (confirmWin && !confirmWin.isDestroyed()) return confirmWin;
  confirmWin = new BrowserWindow({
    width: 360, height: 190, show: false,
    ...(isMac ? { type: 'panel' } : {}),
    transparent: true, frame: false, hasShadow: false, resizable: false, movable: true,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
    alwaysOnTop: true, acceptFirstMouse: true, focusable: false, backgroundColor: '#00000000',
    webPreferences: secureWebPrefs(),
  });
  confirmWin.setAlwaysOnTop(true, 'screen-saver');
  confirmWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  confirmWin.loadURL(pageURL('confirm.html'));
  confirmWin.on('closed', () => { confirmWin = null; resolveConfirm('deny'); });
  return confirmWin;
}

function askUser(request) {
  resolveConfirm('deny'); // never more than one question at a time
  return new Promise(resolve => {
    const win = ensureConfirmWin();
    pendingConfirm = { id: request.id, resolve };
    const a = screen.getDisplayNearestPoint({ x: Math.round(brain.footX()), y: Math.round(brain.footY()) }).workArea;
    win.setPosition(a.x + a.width - 360 - 16, a.y + 16);
    const show = () => {
      if (!pendingConfirm || pendingConfirm.id !== request.id) return;
      win.webContents.send('confirm:show', request);
      win.showInactive();
    };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', show); else show();
  });
}

function resolveConfirm(answer, id) {
  const p = pendingConfirm;
  if (!p || (id !== undefined && id !== p.id)) return;
  pendingConfirm = null;
  if (confirmWin && !confirmWin.isDestroyed()) confirmWin.hide();
  p.resolve(answer === 'allow' ? 'allow' : 'deny');
}

const CHAT_SIZES = { compact: { W: 340, H: 190 }, expanded: { W: 400, H: 560 } };
const chatSize = () => CHAT_SIZES[settings.get('chatExpanded') ? 'expanded' : 'compact'];

// Float above other apps, on every desktop (Space) and over full-screen apps.
function floatEverywhere(win) {
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

// Switch between the compact bar and the full window, keeping the bottom-left corner in place.
function resizeChat() {
  if (!chatWin || chatWin.isDestroyed()) return;
  const { W, H } = chatSize();
  const b = chatWin.getBounds();
  const a = screen.getDisplayMatching(b).workArea;
  const x = Math.min(a.x + a.width - W, Math.max(a.x, b.x));
  const y = Math.min(a.y + a.height - H, Math.max(a.y, b.y + b.height - H));
  chatWin.setMinimumSize(280, settings.get('chatExpanded') ? 360 : 150);
  chatWin.setBounds({ x, y, width: W, height: H }, true);
  chatWin.webContents.send('chat:expanded', settings.get('chatExpanded'));
}

function openChat() {
  if (chatWin) { chatWin.show(); chatWin.focus(); return; }
  const { W, H } = chatSize();
  const a = screen.getDisplayNearestPoint({ x: Math.round(brain.footX()), y: Math.round(brain.footY()) }).workArea;
  // Beside Tito, on whichever side has room.
  let x = Math.round(brain.footX() + 90 * settings.get('size'));
  if (x + W > a.x + a.width) x = Math.round(brain.footX() - 90 * settings.get('size') - W);
  x = Math.min(a.x + a.width - W, Math.max(a.x, x));
  const y = Math.max(a.y, Math.round(a.y + a.height - H - 20));
  chatWin = new BrowserWindow({
    width: W, height: H, x, y, minWidth: 280, minHeight: settings.get('chatExpanded') ? 360 : 150,
    title: 'Chat with Tito', show: false, alwaysOnTop: true,
    ...(isMac ? {
      vibrancy: 'under-window', visualEffectState: 'active',
      titleBarStyle: 'hiddenInset', transparent: true, backgroundColor: '#00000000',
    } : {}),
    webPreferences: secureWebPrefs(),
  });
  floatEverywhere(chatWin); // above apps on every desktop, below Tito
  chatWin.loadURL(pageURL('chat.html'));
  chatWin.once('ready-to-show', () => { app.focus({ steal: true }); chatWin.show(); chatWin.focus(); });
  chatWin.on('closed', () => { chatWin = null; });
}

// ---------- settings window (native macOS blur behind translucent "glass" cards) ----------
function openSettings() {
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 500, height: 640, minWidth: 440, minHeight: 460,
    title: 'Tito Settings', show: false, alwaysOnTop: true,
    ...(isMac ? {
      vibrancy: 'under-window', visualEffectState: 'active',
      titleBarStyle: 'hiddenInset', transparent: true, backgroundColor: '#00000000',
    } : {}),
    webPreferences: secureWebPrefs(),
  });
  floatEverywhere(settingsWin);
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
    { label: 'Chat…', click: openChat },
    { label: 'Settings…', click: openSettings },
    { label: 'Size…', click: () => openPopup('size') },
    { label: 'Feed Tito', click: () => feedTito() },
    ...(settings.get('tasks').length ? [{ label: `Pause scheduled tasks (${settings.get('tasks').length})`, type: 'checkbox',
      checked: settings.get('tasksPaused'), click: item => settings.set('tasksPaused', item.checked) }] : []),
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
  if (process.env.TITO_DEV_SIZE) settings.data.size = +process.env.TITO_DEV_SIZE; // dev: try a size without touching the saved one
  secrets = new SecretStore();
  settings.on('change', (key, value) => {
    if (key === 'personality' && brain) brain.setPersonality(value);
    if (key === 'reactions' && brain) { brain.setReactions(value); if (!value) brain.setMusic(false); }
    if (key === 'customPersonalities' && brain) brain.setPersonality(settings.get('personality')); // an edit to the one in use applies at once
    if (key === 'securityLevel' && value === 'lockdown' && chat && chat.busy) stopTask();
    if (['aiProvider', 'aiModels'].includes(key) && chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('chat:status', chatStatus());
    if (settingsWin && !settingsWin.isDestroyed() && key !== 'size') settingsWin.webContents.send('settings:changed', settings.all());
    if (key === 'size') applySize(value);
    if ((key === 'weatherEnabled' || key === 'locationOverride') && mood) mood.invalidateLocation();
    if (key === 'sleepAfterMin') checkActivity();
    if (key === 'stayStill' || key === 'stayPose') {
      if (brain) brain.setStay(settings.get('stayStill') ? settings.get('stayPose') : null);
      refreshTrayMenu();
    }
  });
  registerIpc();
  createPetWindow();
  createTray();
  startMood();
  startChat();
  startActivityWatch();
  initCompanion();
  startAwareness();
  if (brain) { brain.setCompanion(companionState()); brain.setReactions(settings.get('reactions')); }
  ensurePopup('menu');
  ensurePopup('size');
  startWindowFeed();
  if (process.env.TITO_SMOKE) {
    require('./smoke').run({
      app, petWin, brain, settings, openSettings, openPopup, checkActivity, getMood: () => mood,
      getSecrets: () => secrets, testConnection, openChat, getChatWin: () => chatWin, getChat: () => chat,
      getExecutor: () => executor, getConfirmWin: () => confirmWin, stopTask, getScheduler: () => scheduler,
      getPopup: () => ({ win: popupWin, kind: popupKind }), getSettingsWin: () => settingsWin,
    }).catch(e => { console.log('SMOKE ERROR', e && e.stack); app.exit(3); });
  }
  if (process.env.TITO_RECORD) require('./record').run({ app, petWin, brain });
  // Dev: TITO_PROBE=1 logs Electron's idea of the pet window every second (to compare with the system's).
  if (process.env.TITO_PROBE_EDGE) setTimeout(() => { brain.setStay('sentado'); brain.x = -9999; brain._commit(); console.log('EDGE forced, brain.x =', brain.x); }, 3000);
  if (process.env.TITO_PROBE) setInterval(() => { const b = petWin.getBounds(); console.log('PROBE', Date.now(), `${b.x},${b.y} ${b.width}x${b.height}`, brain.mode, brain.anim, `size=${settings.get('size')}`); }, 1000);
  if (process.env.TITO_TRIAL) {
    brain.setStay('sentado');
    require('./trial').run({
      app, chat, prompts: JSON.parse(fs.readFileSync(process.env.TITO_TRIAL, 'utf8')),
      out: process.env.TITO_TRIAL_OUT || path.join(require('os').tmpdir(), 'tito-trial.log'),
      gapMs: +process.env.TITO_TRIAL_GAP || 15000,
    }).catch(e => { console.log('TRIAL ERROR', e && e.stack); app.exit(3); });
  }
  // Dev: TITO_DEV_CLIMB=1 logs, every few seconds, why each real window side can or can't be climbed
  // and then sends Tito to climb the nearest one (on the real screen, with the real window feed).
  if (process.env.TITO_DEV_CLIMB) {
    setInterval(() => {
      const a = brain.area();
      console.log('AREA', JSON.stringify(a), 'mode', brain.mode, 'surface', brain.surface.kind, 'windows', brain.windows.length);
      for (const w of brain.windows) for (const side of ['left', 'right']) {
        const t = brain._climbInfo(w, side);
        console.log(' ', `win ${w.id} ${w.x},${w.y} ${w.w}x${w.h}`, side, t ? 'CLIMBABLE' : `no: ${brain.climbWhy}`);
      }
      if (brain.surface.kind === 'ground' && !['climb', 'held', 'fall'].includes(brain.mode)) { console.log('  -> climb()'); brain.climb(); }
    }, 6000);
    brain.on('mode', (m, info) => console.log('MODE', m, JSON.stringify(info)));
  }
  // Dev: TITO_DEV_ONLOW=1 puts Tito on the top of the lowest real test window and sends him walking
  // into the side of the window overlapping it (the case of standing on one window, climbing another).
  if (process.env.TITO_DEV_ONLOW) {
    const iv = setInterval(() => {
      const low = brain.windows.find(w => w.y === 420 && w.w === 560);
      const tall = brain.windows.find(w => w.y === 200 && w.w === 450);
      if (!low || !tall) return;
      clearInterval(iv);
      brain.surface = { kind: 'window', id: low.id, lastX: low.x };
      brain.facing = 'right';
      brain.x = low.x + 120 - brain.W / 2; brain.y = brain.standY(); brain._commit();
      brain.sleep = () => {}; // the idle-sleep would interrupt the walk while nobody touches the Mac
      brain.on('wall', w => console.log('WALL', JSON.stringify(w)));
      brain.on('mode', (m, info) => console.log('MODE', m, JSON.stringify(info), 'surface', brain.surface.kind, brain.surface.id));
      const go = () => { if (brain.surface.id === low.id) { Math.random = () => 0.1; brain._travelTo(tall.x + 200 - brain.W / 2, { mode: 'walk', anim: 'caminando', animSpeed: 2.2, speed: 160 }); } };
      setInterval(() => { if (brain.mode === 'sleep') { brain.wake(); return; } if (brain.surface.id === low.id && !['walk', 'climb', 'land', 'fall', 'wake'].includes(brain.mode)) { brain.x = low.x + 120 - brain.W / 2; brain.y = brain.standY(); brain._commit(); go(); } }, 700);
    }, 300);
  }
  // Dev: TITO_DEV_DROP=1 drops Tito onto the first real window the feed reports, so the result can be
  // checked on the real screen (screencapture).
  if (process.env.TITO_DEV_DROP) {
    brain.setStay('sentado');
    const iv = setInterval(() => {
      const w = brain.windows.find(x => x.w < 900 && x.y > 200);
      if (!w) return;
      clearInterval(iv);
      console.log('DROP onto', JSON.stringify(w));
      brain.dragStart();
      brain.dragMove((+process.env.TITO_DEV_DROP_X || (w.x + w.w / 2)) - brain.W / 2, w.y - 250 - brain.H);
      brain.dragEnd();
      setTimeout(async () => {
        const r = await petWin.webContents.executeJavaScript('(() => { const i = document.getElementById("tito").getBoundingClientRect(); return { imgTop: i.top, imgBottom: i.bottom, imgH: i.height, innerH: innerHeight, anim: titoPlayer.name, frame: titoPlayer.frame, nat: document.getElementById("tito").naturalHeight, style: document.getElementById("tito").style.height }; })()');
        console.log('PROBE', JSON.stringify({ win: petWin.getBounds(), surfaceTop: w.y, foot: brain.footY(), r }));
      }, 1500);
    }, 300);
  }
  // Dev: TITO_SHOT=<dir> [TITO_SHOT_PROVIDERS=groq,custom,...] screenshots the AI section of Settings.
  if (process.env.TITO_SHOT_PERS) {
    settings.set('customPersonalities', [{ label: 'Cloud chaser', emotions: { happy: 40, calm: 20, curious: 30, scared: 10 }, activity: 70, speed: 60, climb: 80 }]);
    settings.set('personality', settings.get('customPersonalities')[0].id);
    openSettings();
    setTimeout(async () => {
      const wc = settingsWin.webContents;
      const shot = async name => require('fs').writeFileSync(path.join(process.env.TITO_SHOT_PERS, name), (await wc.capturePage()).toPNG());
      await wc.executeJavaScript(`document.querySelector('h2').scrollIntoView({ block: 'start' })`);
      await new Promise(r => setTimeout(r, 400));
      await shot('pers-1.png');
      await wc.executeJavaScript(`window.scrollBy(0, 420)`);
      await new Promise(r => setTimeout(r, 400));
      await shot('pers-2.png');
      await wc.executeJavaScript(`document.querySelector('.cardbtns button').click(); document.getElementById('editor').scrollIntoView({ block: 'start' })`);
      await new Promise(r => setTimeout(r, 700));
      await shot('pers-3.png');
      app.exit(0);
    }, 2200);
  }
  if (process.env.TITO_SHOT) {
    openSettings();
    setTimeout(async () => {
      const ids = (process.env.TITO_SHOT_PROVIDERS || 'groq').split(',');
      const wc = settingsWin.webContents;
      for (const id of ids) {
        await wc.executeJavaScript(`(() => { const s = document.getElementById('provider'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change')); s.scrollIntoView({ block: 'start' }); window.scrollBy(0, -60); })()`);
        await new Promise(r => setTimeout(r, 500));
        require('fs').writeFileSync(path.join(process.env.TITO_SHOT, `ai-${id}.png`), (await wc.capturePage()).toPNG());
      }
      app.exit(0);
    }, 2000);
  }
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); if (scheduler) scheduler.stop(); if (windowFeed) windowFeed.kill(); if (settings) settings.flush(); });
app.on('window-all-closed', () => app.quit());
