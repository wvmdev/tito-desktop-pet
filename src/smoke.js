// Dev smoke test (TITO_SMOKE=<output dir>). Drives the real app with synthetic input and fake
// window lists, printing PASS/FAIL lines. Screenshots of popups go to the output dir.
const fs = require('fs');
const path = require('path');
const { screen } = require('electron');
const { PERSONALITIES } = require('./personalities');
const { MOVE_ANIMS } = require('./brain');
const { computeMood } = require('./mood-rules');
const http = require('http');
const { createProvider, normalizeError, redact } = require('./ai/providers');
const { decide, DEFAULT_PERMS } = require('./ai/permissions');

// Minimal mock of the Anthropic Messages stream + an OpenAI-compatible chat stream.
function startMockAI() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      const sse = (event, data) => res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
      if (req.url.startsWith('/v1/messages')) {
        const sentKey = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer /, '');
        if (sentKey !== 'sk-ant-test-GOODKEY-123456') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${sentKey}` } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        sse('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } });
        sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        for (const t of ['Tito ', 'is ', 'connected.']) sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
        sse('content_block_stop', { type: 'content_block_stop', index: 0 });
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
        sse('message_stop', { type: 'message_stop' });
        res.end();
      } else if (req.url.startsWith('/v1/chat/completions')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const t of ['Hello ', 'from ', 'custom.']) sse(null, { id: 'c1', object: 'chat.completion.chunk', model: 'local-llm', choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
        sse(null, { id: 'c1', object: 'chat.completion.chunk', model: 'local-llm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        res.write('data: [DONE]\n\n');
        res.end();
      } else { res.writeHead(404); res.end(); }
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, seen })));
}

const wait = ms => new Promise(r => setTimeout(r, ms));

async function run({ app, petWin, brain, settings, openSettings, getPopup, getSettingsWin, checkActivity, getMood, getSecrets, testConnection }) {
  const out = process.env.TITO_SMOKE;
  const wc = petWin.webContents;
  const results = [];
  const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
  const modes = [];
  brain.on('mode', (m, info) => modes.push({ m, info }));
  const shot = async (win, file) => fs.writeFileSync(path.join(out, file), (await win.webContents.capturePage()).toPNG());
  const js = code => wc.executeJavaScript(code);
  const settle = async () => { brain.mode = 'idle'; brain.idle({ forever: true }); await wait(500); };
  const wa = screen.getPrimaryDisplay().workArea;
  const timeout = setTimeout(() => { console.log('SMOKE TIMEOUT'); app.exit(2); }, 150000);

  await new Promise(r => wc.once('did-finish-load', r));
  await wait(1500);
  settings.set('size', 1);
  await wait(200);

  // ---- every animation is used and every frame loads ----
  const used = new Set(MOVE_ANIMS);
  for (const p of Object.values(PERSONALITIES)) for (const [a] of p.idle) used.add(a);
  const all = await js('TitoAnim.ANIMATIONS');
  check('all 36 animations are used', all.length === 36 && all.every(a => used.has(a)), `unused=${all.filter(a => !used.has(a))}`);
  const broken = await js(`Promise.all(TitoAnim.ANIMATIONS.flatMap(a => [0,1,2,3,4,5,6,7].map(i =>
    new Promise(r => { const im = new Image(); im.onload = () => r(null); im.onerror = () => r(a + '_' + i); im.src = '../../assets/sprites/' + a + '/' + a + '_' + i + '.png'; }))))
    .then(x => x.filter(Boolean))`);
  check('all 288 frames load', broken.length === 0, broken.join(','));

  // ---- constant apparent size: rendered eye size should match across animations ----
  const eyeSizes = await js(`(async () => { const res = [];
    for (const a of TitoAnim.ANIMATIONS) {
      titoPlayer.play(a, { facing: 'left' });
      await new Promise(r => setTimeout(r, 60));
      const im = document.getElementById('tito');
      res.push([a, TitoAnim.EYE_PX[a] * parseFloat(im.style.width) / im.naturalWidth, parseFloat(im.style.width) <= innerWidth && parseFloat(im.style.height) <= innerHeight]);
    } return res; })()`);
  const vals = eyeSizes.map(([, v]) => v);
  check('normalised size (eye px equal across anims)', Math.max(...vals) / Math.min(...vals) < 1.06,
    `min=${Math.min(...vals).toFixed(1)} max=${Math.max(...vals).toFixed(1)}`);
  const tooBig = eyeSizes.filter(([a, , fit]) => !fit && a !== 'teletransportarse').map(([a]) => a);
  check('every pose fits the window', tooBig.length === 0, tooBig.join(','));
  await settle();

  // ---- input ----
  const findPt = () => js(`(() => {
    const r = document.getElementById('tito').getBoundingClientRect();
    for (let y = r.top + r.height * 0.55; y < r.bottom; y += 3)
      for (let x = r.left + r.width * 0.3; x < r.right; x += 3)
        if (titoHitTest(x, y)) return { x: Math.round(x + 8), y: Math.round(y + 8) };
    return null; })()`);
  let pt = await findPt();
  check('found opaque point on Tito', !!pt, JSON.stringify(pt));
  check('window corner is click-through', (await js('titoHitTest(2, 2)')) === false);
  const ev = (type, x, y, button = 'left') => {
    const b = petWin.getBounds();
    wc.sendInputEvent({ type, x, y, globalX: b.x + x, globalY: b.y + y, button, clickCount: 1 });
  };
  const click = (button = 'left') => { ev('mouseDown', pt.x, pt.y, button); ev('mouseUp', pt.x, pt.y, button); };

  for (const button of ['left', 'right']) {
    await settle();
    pt = await findPt();
    const tClick = Date.now();
    click(button);
    let p = getPopup();
    while (!(p.win && p.win.isVisible()) && Date.now() - tClick < 3000) { await wait(20); p = getPopup(); }
    const ms = Date.now() - tClick;
    check(`${button} click -> menu popup appears right away`, p.kind === 'menu' && ms < 800, `${ms}ms`);
    check(`${button} click -> reaction plays alongside`, ['sorprendido', 'saludando', 'dando_amor'].includes(brain.anim), `anim=${brain.anim}`);
    if (button === 'left' && p.win) { await wait(300); await shot(p.win, 'popup-menu.png'); }
    if (p.win) p.win.emit('blur');
    await wait(600);
  }

  await settle();
  pt = await findPt();
  click(); await wait(80); click();
  await wait(800);
  const p = getPopup();
  check('double click -> size popup', p.win && p.kind === 'size', `kind=${p.kind}`);
  if (p.win) {
    await wait(300);
    await shot(p.win, 'popup-size.png');
    const foot0 = { x: brain.footX(), y: brain.footY() };
    await p.win.webContents.executeJavaScript(`(() => { const i = document.getElementById('size'); i.value = 1.5; i.dispatchEvent(new Event('input')); })()`);
    await wait(400);
    const b = petWin.getBounds();
    check('size slider resizes Tito, feet stay put', b.width === 420 && b.height === 405 && Math.abs(brain.footX() - foot0.x) < 2 && Math.abs(brain.footY() - foot0.y) < 2,
      `bounds=${JSON.stringify(b)}`);
    const scaleNow = 'parseFloat(document.getElementById("tito").style.width) / document.getElementById("tito").naturalWidth / TitoAnim.sizeFactor(titoPlayer.name)';
    const w15 = await js(scaleNow);
    settings.set('size', 1);
    await wait(300);
    const w10 = await js(scaleNow);
    check('sprite scales with size', Math.abs(w15 / w10 - 1.5) < 0.05, `${w15} vs ${w10}`);
    p.win.hide(); p.win.emit('blur');
    await wait(600);
  }

  // ---- drag & fall: falling pose starts immediately ----
  await settle();
  pt = await findPt();
  const g0 = petWin.getBounds();
  // Like a real cursor: given a global position, deliver it in the window's *current* coordinates.
  const send = (type, x, y) => {
    const gx = g0.x + x, gy = g0.y + y, b = petWin.getBounds();
    wc.sendInputEvent({ type, x: gx - b.x, y: gy - b.y, globalX: gx, globalY: gy, button: 'left', clickCount: 1,
      modifiers: type === 'mouseMove' ? ['leftButtonDown'] : [] });
  };
  send('mouseDown', pt.x, pt.y);
  for (let i = 1; i <= 10; i++) { send('mouseMove', pt.x, pt.y - i * 30); await wait(30); }
  await wait(200);
  check('drag -> held, window follows', brain.mode === 'held' && g0.y - petWin.getBounds().y > 250, `anim=${brain.anim}`);
  send('mouseUp', pt.x, pt.y - 300);
  await wait(40);
  const fallAnim = await js('[titoPlayer.name, titoPlayer.seq.join(",")]');
  check('falling pose starts immediately', brain.mode === 'fall' && fallAnim[0] === 'resbalando' && fallAnim[1] === '2,3,4', JSON.stringify(fallAnim));
  await wait(1200);
  check('lands on the floor', brain.surface.kind === 'ground' && petWin.getBounds().y === brain.standY(), `mode=${brain.mode}`);

  // ---- app windows as surfaces (fake window list) ----
  const winA = { id: 1, pid: 99, x: wa.x + 300, y: wa.y + 320, w: 600, h: 300 };
  const dropOnto = async (w, above = 250) => {
    brain.dragStart();
    brain.dragMove(w.x + 200 - brain.W / 2, w.y - above - brain.H);
    brain.dragEnd();
    await wait(1000);
  };
  brain.setWindows([winA]);
  await settle();
  await dropOnto(winA);
  check('falls onto a window top and rests there', brain.surface.kind === 'window' && brain.surface.id === 1 && Math.abs(brain.footY() - winA.y) < 1,
    `surface=${JSON.stringify(brain.surface)} foot=${brain.footY()} top=${winA.y}`);
  await settle();
  const fx = brain.footX();
  brain.setWindows([{ ...winA, x: winA.x + 50, y: winA.y + 30 }]);
  check('rides along when the window moves', Math.abs(brain.footX() - fx - 50) < 1 && Math.abs(brain.footY() - (winA.y + 30)) < 1);
  brain.setWindows([winA]);
  await wait(50);

  // Walking on a ledge never leaves it unless he deliberately drops off (then he falls).
  let ledgeOk = true;
  for (let i = 0; i < 6 && brain.surface.kind === 'window'; i++) {
    brain.mode = 'idle';
    brain._travel('walk', 'caminando', 2.2, 1500, 120, 520);
    for (let k = 0; k < 20 && brain.mode === 'walk'; k++) {
      await wait(25);
      const inRange = brain.footX() >= winA.x + 27 && brain.footX() <= winA.x + winA.w - 27;
      if (brain.surface.kind === 'window' && brain.mode === 'walk' && !inRange) ledgeOk = false;
    }
  }
  check('stays on the ledge while walking (or drops off and falls)', ledgeOk);
  await wait(1500);

  // Window closes -> falls
  await settle();
  brain.setWindows([winA]);
  if (brain.surface.kind !== 'window') await dropOnto(winA, 100);
  await settle();
  brain.setWindows([]);
  await wait(60);
  check('window closes -> falls with falling pose', brain.mode === 'fall' && brain.anim === 'resbalando', `mode=${brain.mode}`);
  await wait(1300);
  check('...and lands on the floor', brain.surface.kind === 'ground');

  // Covered ledge -> falls
  brain.setWindows([winA]);
  await dropOnto(winA, 100);
  await settle();
  brain.setWindows([{ id: 2, pid: 98, x: winA.x - 20, y: winA.y - 60, w: 700, h: 400 }, winA]);
  await wait(60);
  check('ledge covered by a window in front -> falls', brain.mode === 'fall', `mode=${brain.mode}`);
  await wait(1300);

  // ---- climbing a window side ----
  brain.setWindows([winA]);
  await settle();
  brain.surface = { kind: 'ground' };
  brain.x = winA.x - 160 - brain.W / 2; brain.y = brain.standY(); brain._commit();
  const t = brain._climbTarget();
  check('finds a window side to climb', !!t, t ? `${t.side} side of window ${t.w.id}` : '');
  brain.climb();
  let sawClimb = false;
  for (let i = 0; i < 100 && brain.surface.kind !== 'window'; i++) {
    await wait(100);
    if (brain.mode === 'climb' && brain.anim === 'escalando') sawClimb = true;
  }
  check('climbs up (escalando) and ends on the window top', sawClimb && brain.surface.kind === 'window', `surface=${brain.surface.kind}`);

  // A window edge hidden behind a window in front is not climbable.
  const front = { id: 11, pid: 95, x: wa.x + 200, y: wa.y + 200, w: 700, h: 600 };
  const back = { id: 12, pid: 94, x: wa.x + 300, y: wa.y + 195, w: 300, h: 600 };
  brain.setWindows([front, back]);
  check('edges hidden behind a front window are not climbable', !brain._climbInfo(back, 'left') && !brain._climbInfo(back, 'right') && !!brain._climbInfo(front, 'left'));
  brain.setWindows([]);

  // ---- teleport ----
  await settle();
  brain.teleport();
  await wait(300);
  const tp = await js('[titoPlayer.name, titoPlayer.seq.join(",")]');
  check('teleport vanishes (frames 0..7)', tp[0] === 'teletransportarse' && tp[1] === '0,1,2,3,4,5,6,7');
  await wait(1300);
  const tp2 = await js('[titoPlayer.name, titoPlayer.seq.join(",")]');
  check('teleport reappears (frames 7..0)', tp2[0] === 'teletransportarse' && tp2[1] === '7,6,5,4,3,2,1,0', JSON.stringify(tp2));
  await wait(3000);
  brain.setWindows([]);
  await wait(1500);

  // ---- walls: a window in his path is climbed or makes him turn back ----
  const floor = brain.floorTop();
  const wall = { id: 7, pid: 97, x: wa.x + 700, y: floor - 320, w: 300, h: 320 };
  const realRandom = Math.random;
  for (const [label, r] of [['climbs it', 0], ['turns back', 0.99]]) {
    brain.setWindows([wall]);
    await settle();
    brain.surface = { kind: 'ground' };
    brain.facing = 'right';
    brain.x = wall.x - 250 - brain.W / 2; brain.y = brain.standY(); brain._commit();
    Math.random = () => r;
    brain._travelTo(wall.x + 300 - brain.W / 2, { mode: 'walk', anim: 'caminando', animSpeed: 2.2, speed: 300 });
    await wait(1100);
    Math.random = realRandom;
    const crossed = brain.footX() > wall.x + 5 && brain.surface.kind === 'ground';
    if (r === 0) {
      let ok = brain.mode === 'climb';
      for (let i = 0; i < 40 && brain.surface.kind !== 'window'; i++) await wait(100);
      check(`walking into a window: ${label}`, ok && brain.surface.kind === 'window' && brain.surface.id === 7 && !crossed,
        `mode=${brain.mode} surface=${brain.surface.kind}`);
    } else {
      const looked = brain.anim === 'mirando_arriba' || modes.slice(-3).some(m => m.info && m.info.wall);
      await wait(1300);
      check(`walking into a window: ${label}`, looked && !crossed && brain.facing === 'left' && brain.footX() < wall.x,
        `mode=${brain.mode} facing=${brain.facing} foot=${Math.round(brain.footX())} wall=${wall.x}`);
    }
  }
  // In front of a big window that reaches down behind the Dock (the usual real layout):
  // reaching its edge from inside also means climb or turn.
  const big = { id: 8, pid: 96, x: wa.x + 60, y: wa.y + 160, w: 900, h: wa.height + 100 };
  for (const [label, r] of [['climbs it', 0], ['turns back', 0.99]]) {
    brain.setWindows([big]);
    await settle();
    brain.surface = { kind: 'ground' };
    brain.facing = 'right';
    brain.x = big.x + big.w - 200 - brain.W / 2; brain.y = brain.standY(); brain._commit();
    Math.random = () => r;
    brain._travelTo(big.x + big.w + 200 - brain.W / 2, { mode: 'run', anim: 'corriendo', animSpeed: 3.5, speed: 400 });
    await wait(800);
    Math.random = realRandom;
    if (r === 0) {
      for (let i = 0; i < 60 && brain.surface.kind !== 'window'; i++) await wait(100);
      const b = petWin.getBounds();
      const lift = await js('parseFloat(document.getElementById("stage").style.bottom || "0")');
      check(`in front of a window, reaching its edge: ${label}`, brain.surface.kind === 'window' && brain.surface.id === 8,
        `mode=${brain.mode} surface=${brain.surface.kind}`);
      check('stands on a window near the menu bar (sprite lifted, window below menu bar)',
        Math.abs(brain.footY() - big.y) < 1 && b.y >= wa.y && Math.abs(b.y + b.height - lift - big.y) < 2,
        `foot=${brain.footY()} top=${big.y} winY=${b.y} lift=${lift}`);
    } else {
      await wait(1300);
      check(`in front of a window, reaching its edge: ${label}`, brain.facing === 'left' && brain.footX() < big.x + big.w,
        `facing=${brain.facing} foot=${Math.round(brain.footX())} edge=${big.x + big.w}`);
    }
  }
  brain.setWindows([]);
  await wait(1500);

  // ---- stay still ----
  settings.set('stayPose', 'durmiendo');
  settings.set('stayStill', true);
  await wait(300);
  const sx0 = brain.x;
  await wait(2500);
  check('stay still holds the chosen pose in place', brain.anim === 'durmiendo' && brain.mode === 'idle' && brain.x === sx0, `anim=${brain.anim} mode=${brain.mode} x=${brain.x} x0=${sx0}`);
  brain.dragStart(); brain.dragMove(brain.x + 150, brain.y - 200); brain.dragEnd();
  await wait(2800);
  check('after a drag he lands and goes back to the pose', brain.anim === 'durmiendo', `anim=${brain.anim} mode=${brain.mode}`);
  settings.set('stayStill', false);
  await wait(200);
  check('turning stay still off lets him wander again', brain.stayPose === null);

  // ---- every move faces its travel direction ----
  for (const move of ['walk', 'run', 'stalk']) {
    await settle();
    brain.surface = { kind: 'ground' };
    brain.y = brain.standY();
    brain[move]();
    const sx = brain.x;
    await wait(400);
    const f = await js('titoPlayer.facing');
    const dir = brain.x > sx ? 'right' : 'left';
    check(`${move}: faces travel direction`, f === dir, `moving ${dir}, facing ${f}`);
  }

  // ---- phase 4: sleep when the user is away ----
  await settle();
  brain.mode = 'idle'; brain.next();
  settings.set('sleepAfterMin', 5);
  checkActivity(4 * 60);
  check('awake before the limit', brain.mode !== 'sleep');
  checkActivity(5 * 60 + 1);
  check('asleep after 5 min idle (durmiendo)', brain.mode === 'sleep' && brain.anim === 'durmiendo', `mode=${brain.mode}`);
  const sleepX = brain.x;
  await wait(1500);
  checkActivity(9999);
  check('stays asleep, no wandering', brain.mode === 'sleep' && brain.x === sleepX);
  checkActivity(0.5);
  check('wakes on activity with a yawn', brain.mode === 'wake' && brain.anim === 'bostezando', `anim=${brain.anim}`);
  await wait(3000);
  check('...then stretches', brain.anim === 'estirandose', `anim=${brain.anim}`);
  await wait(2600);
  check('...then carries on', !['sleep', 'wake'].includes(brain.mode), `mode=${brain.mode}`);
  settings.set('sleepAfterMin', 0);
  await settle(); brain.mode = 'idle'; brain.next();
  checkActivity(99999);
  check('"Never" keeps him awake', brain.mode !== 'sleep');
  settings.set('sleepAfterMin', 5);

  // ---- phase 4: mood ----
  const weightOf = a => (brain._idlePool().find(([n]) => n === a) || [, 0])[1];
  brain.setMood(null);
  const base = weightOf('bostezando');
  brain.setMood(computeMood({ date: new Date(2026, 10, 17, 2) })); // Tuesday 2am -> tired
  check('2am mood is tired', brain.mood.mood === 'tired');
  check('tired mood boosts yawning', weightOf('bostezando') > base * 2, `${base} -> ${weightOf('bostezando')}`);
  brain.setMood(computeMood({ date: new Date(2026, 10, 19, 10), weather: { code: 95, tempC: 18, isDay: true } }));
  check('thunderstorm makes him scared and adds scared animations', brain.mood.mood === 'scared' && weightOf('asustado') > 0 && weightOf('escondido') > 0);
  brain.setMood(computeMood({ date: new Date(2026, 10, 18, 16), battery: { percent: 8, charging: false } }));
  check('battery 8% makes him grumpy', brain.mood.mood === 'grumpy' && weightOf('enfadado') > 0);
  getMood().recompute(); // back to the real mood

  // ---- phase 5: permission policy ----
  const d = (action, level, extra = {}) => decide(action, { level, perms: DEFAULT_PERMS, ...extra }).decision;
  const matrix = [
    ['screenshot', 'lockdown', 'deny'], ['click', 'lockdown', 'deny'],
    ['screenshot', 'guarded', 'allow'], ['fileRead', 'guarded', 'allow'], ['click', 'guarded', 'ask'],
    ['type', 'guarded', 'ask'], ['openApp', 'guarded', 'ask'], ['fileWrite', 'guarded', 'ask'],
    ['openApp', 'trusted', 'allow'], ['fileRead', 'trusted', 'allow'], ['click', 'trusted', 'allow'],
    ['fileDelete', 'trusted', 'ask'], ['closeApp', 'trusted', 'ask'], ['purchase', 'trusted', 'ask'],
    ['fileDelete', 'full', 'allow'], ['sendMessage', 'full', 'deny'], // sendMessages toggle is off by default
  ];
  const wrong = matrix.filter(([a, l, want]) => d(a, l) !== want).map(([a, l, want]) => `${a}@${l}: ${d(a, l)} != ${want}`);
  check('permission matrix (levels x actions)', wrong.length === 0, wrong.join('; '));
  check('click on a destructive target asks even when Trusted', d('click', 'trusted', { destructive: true }) === 'ask');
  check('a switched-off toggle denies even at Full Access', decide('click', { level: 'full', perms: { ...DEFAULT_PERMS, mouseKeyboard: false } }).decision === 'deny');
  check('unknown actions are denied', d('formatDisk', 'full') === 'deny');

  // ---- phase 5: API keys at rest ----
  const sec = getSecrets();
  const KEY = 'sk-ant-test-GOODKEY-123456';
  sec.set('anthropic', KEY);
  const onDisk = fs.readFileSync(sec.file, 'utf8');
  check('key is encrypted on disk (no plain text)', !onDisk.includes(KEY) && !onDisk.includes('GOODKEY'));
  check('key decrypts for main only; renderer status shows just a hint', sec.get('anthropic') === KEY && JSON.stringify(sec.status()) === JSON.stringify({ anthropic: { saved: true, hint: '3456' }, openai: { saved: false }, custom: { saved: false } }));
  let rejected = false;
  try { sec.set('openai', 'short'); } catch { rejected = true; }
  check('obviously invalid keys are refused', rejected);

  // ---- phase 5: providers against local mock servers ----
  const mock = await startMockAI();
  const mockBase = `http://127.0.0.1:${mock.port}`;
  let streamed = '';
  const claude = createProvider({ provider: 'anthropic', apiKey: KEY, model: 'claude-opus-5-5', baseURL: mockBase, maxRetries: 0 });
  const r1 = await claude.sendMessage([{ role: 'user', content: 'hi' }], { onText: t => { streamed += t; } });
  const req1 = mock.seen.at(-1);
  check('Claude: streams text through sendMessage', r1.text === 'Tito is connected.' && streamed === r1.text && r1.stopReason === 'end_turn', JSON.stringify(r1));
  check('Claude: model, effort, refusal fallbacks and key header sent',
    req1.body.model === 'claude-opus-5-5' && req1.body.output_config.effort === 'medium' && req1.body.fallbacks === 'default'
    && String(req1.headers['anthropic-beta']).includes('server-side-fallback-2026-07-01')
    && (req1.headers['x-api-key'] === KEY || req1.headers.authorization === `Bearer ${KEY}`),
    JSON.stringify({ beta: req1.headers['anthropic-beta'], fb: req1.body.fallbacks }));
  const haiku = createProvider({ provider: 'anthropic', apiKey: KEY, model: 'claude-haiku-5-5', baseURL: mockBase, maxRetries: 0 });
  await haiku.sendMessage([{ role: 'user', content: 'hi' }]);
  check('Claude Haiku: no fallbacks requested', mock.seen.at(-1).body.fallbacks === undefined);
  const BAD = 'sk-ant-WRONG-key-987654321';
  let err = null;
  try { await createProvider({ provider: 'anthropic', apiKey: BAD, model: 'claude-opus-5-5', baseURL: mockBase, maxRetries: 0 }).sendMessage([{ role: 'user', content: 'hi' }]); }
  catch (e) { err = normalizeError(e, [BAD]); }
  check('bad key -> friendly "auth" error without the key in it', err && err.code === 'auth' && !JSON.stringify(err).includes('WRONG'), JSON.stringify(err));
  check('redact() scrubs keys and bearer tokens', !/sk-ant|abcdef123456/.test(redact('x-api-key: sk-ant-abc123456789 Authorization: Bearer abcdef123456', [])));
  streamed = '';
  const custom = createProvider({ provider: 'custom', apiKey: 'local-key-1234567890', model: 'local-llm', baseURL: `${mockBase}/v1`, maxRetries: 0 });
  const r2 = await custom.sendMessage([{ role: 'user', content: 'hi' }], { system: 'be brief', onText: t => { streamed += t; } });
  const req2 = mock.seen.at(-1);
  check('Custom (OpenAI-compatible): streams text', r2.text === 'Hello from custom.' && streamed === r2.text && r2.stopReason === 'stop', JSON.stringify(r2));
  check('Custom: system prompt + bearer key sent', req2.body.messages[0].role === 'system' && req2.headers.authorization === 'Bearer local-key-1234567890');
  // End-to-end through Settings: custom provider at a localhost base URL.
  settings.set('aiProvider', 'custom');
  settings.set('customBaseURL', `${mockBase}/v1`);
  settings.set('customModel', 'local-llm');
  sec.set('custom', 'local-key-1234567890');
  const t1 = await testConnection();
  check('Test connection (custom endpoint)', t1.ok && t1.text === 'Hello from custom.', JSON.stringify(t1));
  sec.remove('custom');
  const t2 = await testConnection();
  check('Test connection without a key explains what to do', !t2.ok && t2.error.code === 'no_key', JSON.stringify(t2.error));
  let badURL = false;
  try { settings.set('customBaseURL', 'http://example.com/v1'); } catch { badURL = true; }
  check('plain http base URLs only allowed for localhost', badURL);
  settings.set('aiProvider', 'anthropic');
  mock.server.close();

  // ---- settings ----
  settings.set('personality', 'sleepy');
  check('personality applied', brain.personalityId === 'sleepy');
  settings.set('personality', 'balanced');
  openSettings();
  await wait(1500);
  const sw = getSettingsWin();
  const cards = sw && await sw.webContents.executeJavaScript('document.querySelectorAll("label.card").length');
  check('settings lists 6 personalities', cards === 6, `cards=${cards}`);
  const moodText = sw && await sw.webContents.executeJavaScript('document.getElementById("moodLabel").textContent');
  // Full Access needs the native warning dialog's explicit yes (stubbed here: Cancel, then Enable).
  const { dialog } = require('electron');
  const realBox = dialog.showMessageBox;
  let asked = 0;
  dialog.showMessageBox = async () => { asked++; return { response: asked === 1 ? 0 : 1 }; };
  await sw.webContents.executeJavaScript('window.tito.settings.set("securityLevel", "full")');
  check('Full Access: Cancel in the warning keeps the current level', asked === 1 && settings.get('securityLevel') === 'guarded');
  await sw.webContents.executeJavaScript('window.tito.settings.set("securityLevel", "full")');
  check('Full Access: only enabled after the user confirms', asked === 2 && settings.get('securityLevel') === 'full');
  dialog.showMessageBox = realBox;
  settings.set('securityLevel', 'guarded');
  const keyLeak = await sw.webContents.executeJavaScript('document.body.innerText');
  check('settings page never shows a saved key', !keyLeak.includes('GOODKEY') && keyLeak.includes('ending …3456'));
  check('settings shows the current mood', /^Feeling /.test(moodText || ''), moodText);
  if (sw) {
    await shot(sw, 'settings.png');
    await sw.webContents.executeJavaScript('document.getElementById("moodLabel").scrollIntoView({ block: "start" })');
    await wait(300);
    await shot(sw, 'settings-mood.png');
  }

  clearTimeout(timeout);
  console.log(results.every(Boolean) ? 'SMOKE OK' : 'SMOKE FAILED');
  app.exit(results.every(Boolean) ? 0 : 1);
}

module.exports = { run };
