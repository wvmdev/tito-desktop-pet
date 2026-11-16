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
  const state = { script: [], claude: [] }; // queued scripted replies: { text?, calls?: [{ id, name, args }] }
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
        if (state.claude.length) { // scripted Claude reply with a thinking block and tool calls
          const sc = state.claude.shift();
          sse('message_start', { type: 'message_start', message: { id: 'msg_s', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } });
          let idx = 0;
          sse('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '', signature: '' } });
          sse('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: 'SIG-123' } });
          sse('content_block_stop', { type: 'content_block_stop', index: idx++ });
          if (sc.text) {
            sse('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
            sse('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: sc.text } });
            sse('content_block_stop', { type: 'content_block_stop', index: idx++ });
          }
          for (const c of sc.calls || []) {
            sse('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } });
            sse('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.args) } });
            sse('content_block_stop', { type: 'content_block_stop', index: idx++ });
          }
          sse('message_delta', { type: 'message_delta', delta: { stop_reason: (sc.calls || []).length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } });
          sse('message_stop', { type: 'message_stop' });
          res.end();
          return;
        }
        sse('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } });
        sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        for (const t of ['Tito ', 'is ', 'connected.']) sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
        sse('content_block_stop', { type: 'content_block_stop', index: 0 });
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
        sse('message_stop', { type: 'message_stop' });
        res.end();
      } else if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'models/gemini-test-pro', object: 'model' }, { id: 'local-llm', object: 'model' }] }));
      } else if (req.url.startsWith('/v1/chat/completions')) {
        if (state.rejectImages && JSON.stringify(seen.at(-1).body).includes('image_url')) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: "'messages.3' : for 'role:user' the following must be satisfied: 'messages.3.content' : value must be a string", type: 'invalid_request_error' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const msgs = (seen.at(-1).body || {}).messages || [];
        const last = String((msgs[msgs.length - 1] || {}).content || '');
        const chunk = t => sse(null, { id: 'c1', object: 'chat.completion.chunk', model: 'local-llm', choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
        const finish = (why = 'stop') => { sse(null, { id: 'c1', object: 'chat.completion.chunk', model: 'local-llm', choices: [{ index: 0, delta: {}, finish_reason: why }] }); res.write('data: [DONE]\n\n'); res.end(); };
        if (state.script.length) {
          const sc = state.script.shift();
          if (sc.text) chunk(sc.text);
          (sc.calls || []).forEach((c, i) => sse(null, { id: 'c1', object: 'chat.completion.chunk', model: 'local-llm', choices: [{ index: 0, finish_reason: null,
            delta: { tool_calls: [{ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) } }] } }] }));
          finish((sc.calls || []).length ? 'tool_calls' : 'stop');
          return;
        }
        if (last.includes('slow')) { // streams for ~6s so the test can press Stop
          let i = 0;
          const iv = setInterval(() => { if (res.writableEnded || res.destroyed) { clearInterval(iv); return; } chunk(`word${i} `); if (++i >= 30) { clearInterval(iv); finish(); } }, 200);
          res.on('close', () => clearInterval(iv));
          return;
        }
        const parts = last.includes('format')
          ? ['Here is **bold** and `x = 1` <img src=x onerror="window.pwned=1">', '\n```js\nconsole.log(1)\n```']
          : ['Hello ', 'from ', 'custom.'];
        for (const t of parts) chunk(t);
        finish();
      } else { res.writeHead(404); res.end(); }
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, seen, state })));
}

const wait = ms => new Promise(r => setTimeout(r, ms));

async function run({ app, petWin, brain, settings, openSettings, getPopup, getSettingsWin, checkActivity, getMood, getSecrets, testConnection, openChat, getChatWin, getChat, getExecutor, getConfirmWin, stopTask, getScheduler }) {
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
  const timeout = setTimeout(() => { console.log('SMOKE TIMEOUT'); app.exit(2); }, 330000);

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
  click(); click();
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

  // ---- the whole sprite stays on screen ----
  const SPRITE = require('./sprite-metrics');
  const disp = screen.getPrimaryDisplay();
  brain.setWindows([]);
  await settle();
  brain.surface = { kind: 'ground' };
  let offs = [];
  for (const anim of ['corriendo', 'mirando_derecha', 'cazando', 'sentado', 'escalando']) {
    brain._anim(anim);
    for (const x of [-2000, 5000]) {
      brain.x = x; brain.y = brain.standY(); brain._commit();
      const left = brain.footX() - SPRITE[anim].half, right = brain.footX() + SPRITE[anim].half;
      if (left < wa.x - 1 || right > wa.x + wa.width + 1) offs.push(`${anim}@${x}: ${Math.round(left)}..${Math.round(right)}`);
    }
  }
  check('sprite never leaves the screen horizontally (any animation, both edges)', offs.length === 0, offs.join('; '));
  brain.mode = 'idle'; brain.idle({ forever: true });
  brain.dragStart();
  brain.dragMove(-3000, -3000);
  const hb = brain.anim && SPRITE[brain.anim];
  check('carrying him far off screen keeps all of him on the display', brain.footX() - hb.half >= disp.bounds.x - 1 && brain.y + (brain.H - hb.height * brain.size) >= disp.bounds.y - 1,
    `x=${Math.round(brain.footX())} y=${Math.round(brain.y)} anim=${brain.anim}`);
  brain.dragMove(9000, 9000);
  check('...and at the bottom-right corner', brain.footX() + hb.half <= disp.bounds.x + disp.bounds.width + 1 && brain.footY() <= disp.bounds.y + disp.bounds.height + 1);
  brain.dragEnd();
  await wait(1500);
  await settle();
  // wide poses are planned with their own width: a long run along the edge reaches its target
  brain.x = wa.x + 200; brain.facing = 'left'; brain.y = brain.standY(); brain._commit();
  const runModes = [];
  const onMode = (m, info) => runModes.push({ m, info });
  brain.on('mode', onMode);
  Math.random = () => 0.5;
  brain.run();
  Math.random = realRandom;
  const rt = runModes.find(m => m.m === 'run').info.target;
  const [lo0] = brain.xBounds('corriendo');
  check('run target respects the running pose width at the screen edge', rt >= lo0 - 0.5, `target=${rt} min=${Math.round(lo0)}`);
  brain.off('mode', onMode);
  await settle();

  // ---- one walk in five heads for the mouse, unless an app is full screen ----
  const cursor = { x: wa.x + 700, y: 300 };
  brain.getCursor = () => cursor;
  const mouseWalk = async (rand, windows = []) => {
    brain.setWindows(windows);
    await settle();
    brain.surface = { kind: 'ground' };
    brain.facing = 'left';
    brain.x = wa.x + 300 - brain.W / 2; brain.y = brain.standY(); brain._commit();
    const seenModes = [];
    const on = (m, info) => seenModes.push({ m, info });
    brain.on('mode', on);
    Math.random = () => rand;
    brain.walk();
    Math.random = realRandom;
    brain.off('mode', on);
    return seenModes.find(m => m.m === 'walk');
  };
  const w1 = await mouseWalk(0.19);
  check('a walk (1 chance in 5) heads for the mouse pointer', w1 && w1.info.mouse === true && w1.info.dir === 1, JSON.stringify(w1));
  const tgtFoot = w1.info.target + brain.W / 2;
  check('...and stops beside the pointer, not on it', Math.abs(tgtFoot - (cursor.x - 70)) <= 1, `targetFoot=${Math.round(tgtFoot)} cursor=${cursor.x}`);
  const w2 = await mouseWalk(0.21);
  check('the other four walks in five ignore the mouse', w2 && !w2.info.mouse, JSON.stringify(w2));
  const w3 = await mouseWalk(0.0, [{ id: 90, pid: 90, x: disp.bounds.x, y: disp.bounds.y, w: disp.bounds.width, h: disp.bounds.height }]);
  check('with an app in full screen he never goes for the mouse', brain.fullscreenHere() && w3 && !w3.info.mouse, JSON.stringify(w3));
  const w4 = await mouseWalk(0.0, [{ id: 91, pid: 91, x: 100, y: 200, w: 900, h: 500 }]);
  check('an ordinary window does not count as full screen', !brain.fullscreenHere() && w4 && w4.info.mouse === true, JSON.stringify(w4));
  // Arrives and looks at the pointer.
  cursor.x = wa.x + 560;
  const w5 = await mouseWalk(0.0);
  let arrived = false;
  for (let i = 0; i < 80 && !arrived; i++) { await wait(100); arrived = brain.mode === 'idle' && brain.anim === 'curioso'; }
  check('he reaches the pointer and looks at it (curioso)', w5 && arrived && Math.abs(brain.footX() - (cursor.x - 70)) <= 3, `foot=${Math.round(brain.footX())} anim=${brain.anim}`);
  cursor.x = wa.x + 340; // start foot is at wa.x + 300
  const w6 = await mouseWalk(0.0);
  check('a pointer that is already close does not trigger the trip', w6 && !w6.info.mouse);
  brain.getCursor = null;
  brain.setWindows([]);
  await settle();

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
  check('key decrypts for main only; renderer status shows just a hint', sec.get('anthropic') === KEY
    && JSON.stringify(sec.status().anthropic) === JSON.stringify({ saved: true, hint: '3456' })
    && !JSON.stringify(sec.status()).includes('GOODKEY'));
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
  settings.set('aiModels', { ...settings.get('aiModels'), custom: 'local-llm' });
  sec.set('custom', 'local-key-1234567890');
  const t1 = await testConnection();
  check('Test connection (custom endpoint)', t1.ok && t1.text === 'Hello from custom.', JSON.stringify(t1));
  sec.remove('custom');
  const t2 = await testConnection();
  check('Test connection without a key explains what to do', !t2.ok && t2.error.code === 'no_key', JSON.stringify(t2.error));
  let badURL = false;
  try { settings.set('customBaseURL', 'http://example.com/v1'); } catch { badURL = true; }
  check('plain http base URLs only allowed for localhost', badURL);
  // Presets: same OpenAI-compatible path with a built-in base URL (overridden to the mock here).
  const groq = createProvider({ provider: 'groq', apiKey: 'gsk_test_key_1234567890', model: 'local-llm', baseURL: `${mockBase}/v1`, maxRetries: 0 });
  const r3 = await groq.sendMessage([{ role: 'user', content: 'hi' }]);
  check('preset provider (Groq) works through the shared interface', r3.text === 'Hello from custom.');
  const gem = createProvider({ provider: 'gemini', apiKey: 'AIza-test-key-1234567890', baseURL: `${mockBase}/v1`, requireModel: false, maxRetries: 0 });
  const gm = await gem.listModels();
  check('Load models: lists ids (Gemini "models/" prefix stripped)', gm.includes('gemini-test-pro') && gm.includes('local-llm'), gm.join(','));
  const oll = createProvider({ provider: 'ollama', model: 'local-llm', baseURL: `${mockBase}/v1`, maxRetries: 0 });
  check('local provider (Ollama) needs no key', (await oll.sendMessage([{ role: 'user', content: 'hi' }])).text === 'Hello from custom.');
  let noModel = null;
  try { createProvider({ provider: 'mistral', apiKey: 'mistral-key-1234567890' }); } catch (e) { noModel = normalizeError(e); }
  check('a provider without a chosen model says to load/pick one', noModel && noModel.code === 'config' && /Load models/.test(noModel.message));
  check('every preset has a base URL or is Claude/OpenAI/custom', Object.entries(require('./ai/providers').PROVIDERS)
    .every(([id, p]) => p.baseURL || p.custom || ['anthropic', 'openai'].includes(id)));
  // Old settings files (one model key per provider) migrate to aiModels.
  const { Settings } = require('./settings');
  const savedJSON = fs.readFileSync(settings.file, 'utf8');
  fs.writeFileSync(settings.file, JSON.stringify({ anthropicModel: 'claude-sonnet-5-5', openaiModel: 'gpt-5-mini' }));
  const migrated = new Settings();
  check('old per-provider model settings migrate', migrated.get('aiModels').anthropic === 'claude-sonnet-5-5' && migrated.get('aiModels').openai === 'gpt-5-mini');
  fs.writeFileSync(settings.file, savedJSON);
  settings.set('aiProvider', 'anthropic');
  mock.server.close();

  // ---- phase 6: chat ----
  const cmock = await startMockAI();
  sec.set('custom', 'local-key-1234567890');
  settings.set('aiProvider', 'custom');
  settings.set('customBaseURL', `http://127.0.0.1:${cmock.port}/v1`);
  settings.set('aiModels', { ...settings.get('aiModels'), custom: 'local-llm' });
  getChat().clear();
  openChat();
  await wait(1500);
  const cw = getChatWin();
  const cjs = code => cw.webContents.executeJavaScript(code);
  const typeAndSend = t => cjs(`(() => { const i = document.getElementById('input'); i.value = ${JSON.stringify(t)}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  check('chat window opens with the provider in the header', /Custom .*local-llm/.test(await cjs('document.getElementById("sub").textContent')));
  // Compact first; the button expands it and the choice is remembered.
  const b0 = cw.getBounds();
  check('chat opens as a small compact window', b0.width === 340 && b0.height === 190 && (await cjs('document.body.classList.contains("compact")')), JSON.stringify(b0));
  check('chat floats on top, on every desktop', cw.isAlwaysOnTop() && cw.isVisibleOnAllWorkspaces());
  await cjs('document.getElementById("toggleSize").click()');
  await wait(600);
  const b1 = cw.getBounds();
  check('expand button grows it to the full chat (bottom edge stays put)', b1.width === 400 && b1.height === 560 && !(await cjs('document.body.classList.contains("compact")'))
    && Math.abs((b1.y + b1.height) - (b0.y + b0.height)) <= 1 && settings.get('chatExpanded') === true, JSON.stringify(b1));
  await cjs('document.getElementById("toggleSize").click()');
  await wait(600);
  check('and shrinks back to compact', cw.getBounds().height === 190 && settings.get('chatExpanded') === false);
  await typeAndSend('Hi Tito');
  await wait(800);
  const bubbles = await cjs('[...document.querySelectorAll(".msg")].map(m => m.className.split(" ")[1] + ":" + m.firstChild.textContent)');
  check('chat: user message and streamed reply shown', JSON.stringify(bubbles) === JSON.stringify(['user:Hi Tito', 'assistant:Hello from custom.']), JSON.stringify(bubbles));
  const firstReq = cmock.seen.at(-1).body.messages;
  check('chat: Tito system prompt sent', firstReq[0].role === 'system' && /You are Tito/.test(firstReq[0].content));
  await typeAndSend('And again');
  await wait(800);
  const second = cmock.seen.at(-1).body.messages.filter(m => m.role !== 'system').map(m => m.role + ':' + m.content);
  check('chat: follow-ups include the conversation so far', JSON.stringify(second) === JSON.stringify(['user:Hi Tito', 'assistant:Hello from custom.', 'user:And again']), JSON.stringify(second));
  await typeAndSend('please format');
  await wait(800);
  const fmt = await cjs('(() => { const m = [...document.querySelectorAll(".msg.assistant")].pop(); return { img: !!m.querySelector("img"), strong: m.querySelector("strong")?.textContent, code: m.querySelector("code")?.textContent, pre: m.querySelector("pre code")?.textContent, pwned: !!window.pwned, text: m.textContent }; })()');
  check('chat: replies are rendered as text (HTML in a reply is not executed)', !fmt.img && !fmt.pwned && fmt.text.includes('<img src=x'), JSON.stringify(fmt));
  check('chat: **bold**, `code` and ``` blocks formatted', fmt.strong === 'bold' && fmt.code === 'x = 1' && fmt.pre === 'console.log(1)', JSON.stringify(fmt));
  brain.mode = 'idle'; brain.stayPose = null;
  await typeAndSend('go slow please');
  await wait(1200);
  check('Tito watches curiously while a reply is being written', brain.anim === 'curioso', `anim=${brain.anim}`);
  await cjs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await wait(600);
  const stopped = await cjs('(() => { const m = [...document.querySelectorAll(".msg.assistant")].pop(); return { text: m.firstChild.textContent, meta: m.querySelector(".meta")?.textContent, sendLabel: document.getElementById("send").getAttribute("aria-label") }; })()');
  check('Esc stops a reply mid-stream and keeps what arrived', /^word0 /.test(stopped.text) && stopped.text.endsWith('…') && stopped.meta === 'Stopped' && stopped.sendLabel === 'Send', JSON.stringify(stopped));
  check('Tito waves when the reply ends', brain.anim === 'saludando', `anim=${brain.anim}`);
  const saved = JSON.parse(fs.readFileSync(getChat().file, 'utf8'));
  check('conversation is saved for next time', saved.length === 8 && saved[0].content === 'Hi Tito' && saved[7].stopped === true, `len=${saved.length}`);
  // "New chat" while a reply is streaming must leave a truly empty conversation.
  await typeAndSend('go slow again');
  await wait(700);
  await cjs('document.getElementById("newChat").click()');
  await wait(900);
  check('New chat mid-answer leaves nothing behind', getChat().history().length === 0 && !getChat().busy && (await cjs('document.querySelectorAll(".msg").length')) === 0,
    `history=${getChat().history().length}`);
  await typeAndSend('Hi Tito');
  await wait(800);
  // ================= phase 7: computer control (fake "hands": nothing real is clicked) =================
  const { globalShortcut, ipcMain } = require('electron');
  const os = require('os');
  const { runAgentTurn } = require('./ai/agent');
  const { redactText } = require('./ai/redact');
  const { ensureHelper, runHelper } = require('./ai/mac-backend');
  const ex = getExecutor();
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tito-files-')));
  const fake = {
    calls: [], rects: [], focused: false,
    ownWindowRects() { return this.rects; },
    ownWindowFocused() { return this.focused; },
    async capture() { this.calls.push({ capture: true }); return { base64: 'QUJD', redacted: 1, geometry: { scale: 0.5, originX: 100, originY: 50, width: 640, height: 400 } }; },
    async input(args, stdin) { this.calls.push({ args, stdin }); },
    async openApp(n) { this.calls.push({ open: n }); },
    async trash(f) { this.calls.push({ trash: f }); fs.rmSync(f, { recursive: true }); },
  };
  ex.backend = fake;
  ex.roots = [sandbox];
  const waitFor = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await wait(40); } return null; };
  const confirmShown = () => waitFor(() => { const w = getConfirmWin(); return w && !w.isDestroyed() && w.isVisible() ? w : null; });
  const answer = async allow => { const w = await confirmShown(); if (!w) return false; await wait(750); await w.webContents.executeJavaScript(`document.getElementById('${allow ? 'allow' : 'deny'}').click()`); return true; };
  const turnDone = () => waitFor(() => !getChat().busy, 8000);
  const rows = () => cjs('[...document.querySelectorAll(".act")].map(r => r.className.replace("act ", "") + ":" + r.children[1].textContent)');
  const lastToolMsgs = () => cmock.seen.at(-1).body.messages.filter(m => m.role === 'tool').map(m => m.content);
  const say = (text, script) => { cmock.state.script = script; fake.calls = []; return typeAndSend(text); };
  const R = 'because the user asked';

  // Guarded: looking is free, every change asks; Allow comes only from the popup.
  settings.set('securityLevel', 'guarded');
  await say('click the button', [
    { text: 'Let me look.', calls: [{ id: 't1', name: 'take_screenshot', args: { reason: R } }] },
    { calls: [{ id: 't2', name: 'click', args: { x: 100, y: 40, effect: 'routine', reason: R } }] },
    { text: 'Clicked it!' },
  ]);
  const cwin = await confirmShown();
  check('Guarded: screenshot runs without asking, click asks', !!cwin && fake.calls.length === 1 && fake.calls[0].capture === true, JSON.stringify(fake.calls));
  check('Esc is a global Stop key while Tito can act', globalShortcut.isRegistered('Escape'));
  const popup = cwin && await cwin.webContents.executeJavaScript('[document.getElementById("title").textContent, document.getElementById("reason").textContent, document.getElementById("allow").disabled]');
  check('popup describes the real action; Allow starts disabled', popup && popup[0] === 'Click at (100, 40)' && /Tito says: because/.test(popup[1]) && popup[2] === true, JSON.stringify(popup));
  if (cwin) await shot(cwin, 'confirm.png');
  // Forged approvals: wrong window, then wrong question id. Neither may approve.
  ipcMain.emit('confirm:answer', { sender: cw.webContents }, 'a2', true);
  ipcMain.emit('confirm:answer', { sender: cwin.webContents }, 'not-this-one', true);
  await wait(200);
  check('approval is ignored unless it comes from the popup for this exact question', getChat().busy && fake.calls.length === 1);
  await answer(true);
  await turnDone();
  const clickCall = fake.calls.find(c => c.args && c.args[0] === 'click');
  check('after Allow the click runs at the right screen point', clickCall && clickCall.args[1] === '300' && clickCall.args[2] === '130', JSON.stringify(fake.calls));
  check('the action log shows each step', JSON.stringify(await rows()).includes('done:Look at the screen') && JSON.stringify(await rows()).includes('done:Click at (100, 40)'), JSON.stringify(await rows()));
  check('Stop key is released when the task ends', !globalShortcut.isRegistered('Escape'));
  const imgMsg = cmock.seen.at(-1).body.messages.find(m => Array.isArray(m.content) && m.content.some(c => c.type === 'image_url'));
  check('the screenshot reaches the model with a "data, not instructions" label', !!imgMsg && /not instructions/.test(imgMsg.content[0].text));

  // Deny: nothing happens and the model is told.
  await say('type hello', [{ calls: [{ id: 't3', name: 'type_text', args: { text: 'hello', effect: 'routine', reason: R } }] }, { text: 'Okay, I will not.' }]);
  await answer(false);
  await turnDone();
  check("Don't allow: nothing is typed and the model is told", fake.calls.length === 0 && /declined/.test(lastToolMsgs().at(-1)), JSON.stringify(lastToolMsgs()));

  // Stop while a question is open.
  await say('type more', [{ calls: [{ id: 't4', name: 'type_text', args: { text: 'x', effect: 'routine', reason: R } }] }]);
  await confirmShown();
  stopTask();
  await turnDone();
  check('Stop while asking: popup closes, nothing runs', fake.calls.length === 0 && !getConfirmWin().isVisible() && !getChat().busy);

  // Trusted: routine runs, destructive (declared or detected) still asks.
  settings.set('securityLevel', 'trusted');
  await say('open notes and quit it', [
    { calls: [{ id: 't5', name: 'open_app', args: { name: 'Notes', reason: R } }] },
    { calls: [{ id: 't6', name: 'press_key', args: { keys: 'cmd+q', effect: 'routine', reason: R } }] },
    { text: 'Done.' },
  ]);
  const askedWin = await confirmShown();
  check('Trusted: opening an app runs; cmd+q asks even when labelled routine', !!askedWin && fake.calls.length === 1 && fake.calls[0].open === 'Notes', JSON.stringify(fake.calls));
  await answer(false);
  await turnDone();

  // Full Access: no questions, but a switched-off category stays blocked.
  settings.set('securityLevel', 'full');
  fs.writeFileSync(path.join(sandbox, 'old.txt'), 'bye');
  await say('delete it and send', [
    { calls: [{ id: 't7', name: 'delete_file', args: { path: path.join(sandbox, 'old.txt'), reason: R } }] },
    { calls: [{ id: 't8', name: 'click', args: { x: 10, y: 10, effect: 'send_message', reason: R } }] },
    { text: 'Deleted; could not send.' },
  ]);
  await turnDone();
  check('Full Access: delete runs without asking (to the Trash)', fake.calls.some(c => c.trash) && !fs.existsSync(path.join(sandbox, 'old.txt')));
  check('Full Access: "send messages" switched off is still blocked', !fake.calls.some(c => c.args) && /Not allowed/.test(lastToolMsgs().at(-1)), JSON.stringify(lastToolMsgs()));

  // Files: secrets scrubbed; outside the home folder and credential stores refused.
  fs.writeFileSync(path.join(sandbox, 'notes.txt'), 'shopping list\napi_key = sk-live-ABCDEFGHIJKLMNOP123456\nmilk');
  await say('read files', [
    { calls: [
      { id: 't9', name: 'read_file', args: { path: path.join(sandbox, 'notes.txt'), reason: R } },
      { id: 't10', name: 'read_file', args: { path: '/etc/hosts', reason: R } },
      { id: 't11', name: 'read_file', args: { path: path.join(sandbox, '.ssh', 'id_rsa'), reason: R } },
      { id: 't12', name: 'write_file', args: { path: path.join(sandbox, 'sub', 'new.txt'), content: 'hi', reason: R } },
      { id: 't13', name: 'click', args: '{not json', },
    ] },
    { text: 'Read.' },
  ]);
  await turnDone();
  const fr = lastToolMsgs();
  check('file contents are scrubbed of secrets before the model sees them', fr[0].includes('shopping list') && fr[0].includes('[redacted]') && !JSON.stringify(cmock.seen.at(-1).body).includes('ABCDEFGHIJKLMNOP'), fr[0]);
  check('files outside the home folder are refused', /outside/.test(fr[1]), fr[1]);
  check('credential locations are refused', /credentials/.test(fr[2]), fr[2]);
  check('write_file creates the file', fs.readFileSync(path.join(sandbox, 'sub', 'new.txt'), 'utf8') === 'hi' && /Created/.test(fr[3]));
  check('malformed tool arguments are rejected, not run', /not valid JSON/.test(fr[4]), fr[4]);

  // Tito may not operate his own windows.
  fake.rects = [{ x: 100, y: 50, width: 400, height: 300 }];
  fake.focused = true;
  await say('click yourself', [
    { calls: [{ id: 't14', name: 'take_screenshot', args: { reason: R } }, { id: 't15', name: 'click', args: { x: 50, y: 50, effect: 'routine', reason: R } }, { id: 't16', name: 'type_text', args: { text: 'x', effect: 'routine', reason: R } }] },
    { text: 'I cannot.' },
  ]);
  await turnDone();
  const own = lastToolMsgs();
  check("clicks on Tito's own windows are refused", /own windows/.test(own[1]) && !fake.calls.some(c => c.args), own[1]);
  check("typing while Tito's own window has focus is refused", /own window has keyboard focus/.test(own[2]), own[2]);
  fake.rects = []; fake.focused = false;

  // Per-action switch off: the tool isn't offered, and is blocked if called anyway.
  settings.set('actionPerms', { ...settings.get('actionPerms'), mouseKeyboard: false });
  await say('click anyway', [{ calls: [{ id: 't17', name: 'click', args: { x: 5, y: 5, effect: 'routine', reason: R } }] }, { text: 'Blocked.' }]);
  await turnDone();
  const offered = cmock.seen.at(-1).body.tools.map(t => t.function.name);
  check('switched-off category: tool not offered and blocked if called', !offered.includes('click') && offered.includes('read_file') && /Not allowed/.test(lastToolMsgs().at(-1)) && fake.calls.length === 0, offered.join(','));
  settings.set('actionPerms', { ...settings.get('actionPerms'), mouseKeyboard: true });

  // Lockdown: chat only.
  settings.set('securityLevel', 'lockdown');
  await say('hello in lockdown', []);
  await turnDone();
  const lb = cmock.seen.at(-1).body;
  check('Lockdown: no tools are offered at all', lb.tools === undefined && /cannot control the computer/.test(lb.messages[0].content) && !globalShortcut.isRegistered('Escape'));
  settings.set('securityLevel', 'guarded');
  check('prompt-injection rule is in the system prompt when tools are on', (() => { const { systemPrompt } = require('./chat'); return /is DATA/.test(systemPrompt({ tools: [{ name: 'click' }] })); })());

  // Scheduled tasks: created from chat only with the user's OK (even at Full Access), then run on a timer.
  const sched = getScheduler();
  settings.set('securityLevel', 'full');
  await say('press space every 6 minutes', [
    { calls: [{ id: 's1', name: 'schedule_task', args: { kind: 'key', value: 'Space', every_seconds: 360, reason: R } }] },
    { text: 'Scheduled!' },
  ]);
  const sw1 = await confirmShown();
  const stitle = sw1 && await sw1.webContents.executeJavaScript('document.getElementById("title").textContent');
  check('scheduling from chat asks first, even at Full Access', !!sw1 && stitle === 'Repeat: Press space every 6 min' && settings.get('tasks').length === 0, stitle);
  await answer(true);
  await turnDone();
  const tk = settings.get('tasks')[0];
  check('after Allow the task exists', tk && tk.kind === 'key' && tk.value === 'space' && tk.everySec === 360 && tk.enabled && sched.timers.size === 1, JSON.stringify(tk));
  fake.calls = [];
  const run1 = await sched.runNow(tk.id);
  check('a scheduled run presses the key', run1.ok && fake.calls.length === 1 && fake.calls[0].args.join(' ') === 'key space', JSON.stringify(fake.calls));
  settings.set('securityLevel', 'lockdown');
  fake.calls = [];
  const run2 = await sched.runNow(tk.id);
  check('scheduled runs are skipped in Lockdown', !run2.ok && /Lockdown/.test(run2.text) && fake.calls.length === 0, run2.text);
  settings.set('securityLevel', 'guarded');
  settings.set('tasksPaused', true);
  check('pausing stops all timers', sched.timers.size === 0);
  settings.set('tasksPaused', false);
  let badTask = '';
  try { sched.add({ kind: 'key', value: 'space', everySec: 2 }); } catch (e) { badTask = e.message; }
  check('too-short intervals are refused', /between 10 seconds/.test(badTask), badTask);
  await say('cancel it', [{ calls: [{ id: 's2', name: 'list_tasks', args: { reason: R } }, { id: 's3', name: 'cancel_task', args: { id: tk.id, reason: R } }] }, { text: 'Removed.' }]);
  await turnDone();
  check('tasks can be listed and cancelled from chat', settings.get('tasks').length === 0 && lastToolMsgs().some(m => m.includes('Press space every 6 min')), JSON.stringify(lastToolMsgs()));
  sched.add({ kind: 'open', value: 'Notes', everySec: 3600 });

  // Claude: thinking blocks go back unchanged inside a tool loop; screenshot attached to the tool result.
  const amock = await startMockAI();
  amock.state.claude = [{ text: 'Looking.', calls: [{ id: 'toolu_1', name: 'take_screenshot', args: { reason: R } }] }, { text: 'All good.' }];
  const claudeP = createProvider({ provider: 'anthropic', apiKey: KEY, model: 'claude-opus-5-5', baseURL: `http://127.0.0.1:${amock.port}`, maxRetries: 0 });
  const ar = await runAgentTurn({
    provider: claudeP, system: 'sys', messages: [{ role: 'user', content: 'look' }], tools: require('./ai/tools').TOOLS, executor: ex,
    getPolicy: () => ({ level: 'guarded', perms: settings.get('actionPerms') }), confirm: async () => 'deny', emit: () => {}, signal: new AbortController().signal,
  });
  const a2 = amock.seen.at(-1).body;
  const asst = a2.messages[1].content;
  const tr = a2.messages[2].content[0];
  check('Claude tool loop: final text returned', ar.text === 'Looking.\n\nAll good.' && ar.steps === 1, JSON.stringify(ar));
  check('Claude: thinking block replayed unchanged, in order', asst[0].type === 'thinking' && asst[0].signature === 'SIG-123' && asst.at(-1).type === 'tool_use', JSON.stringify(asst.map(b => b.type)));
  check('Claude: tool result carries text + redacted screenshot', tr.type === 'tool_result' && tr.tool_use_id === 'toolu_1' && tr.content[1].type === 'image' && a2.tools.length === 13 && a2.system === 'sys');
  amock.server.close();

  // A model without image input: the screenshot is dropped, sight tools switch off, work carries on.
  const vmock = await startMockAI();
  vmock.state.rejectImages = true;
  vmock.state.script = [
    { calls: [{ id: 'v1', name: 'take_screenshot', args: { reason: R } }] },   // rejected once the image is in the request
    { calls: [{ id: 'v2', name: 'open_app', args: { name: 'Notes', reason: R } }] },
    { text: 'Opened Notes.' },
  ];
  const visionP = createProvider({ provider: 'custom', apiKey: 'local-key-1234567890', model: 'text-only', baseURL: `http://127.0.0.1:${vmock.port}/v1`, maxRetries: 0 });
  const evts = [];
  let noVisionFlag = false;
  fake.calls = [];
  settings.set('securityLevel', 'trusted');
  const vr = await runAgentTurn({
    provider: visionP, system: 'sys', messages: [{ role: 'user', content: 'open notes' }], tools: require('./ai/tools').availableTools('trusted', settings.get('actionPerms')),
    executor: ex, getPolicy: () => ({ level: 'trusted', perms: settings.get('actionPerms') }), confirm: async () => 'deny',
    emit: (t, d) => evts.push([t, d]), signal: new AbortController().signal, onNoVision: () => { noVisionFlag = true; },
  });
  const lastTools = (vmock.seen.at(-1).body.tools || []).map(t => t.function.name);
  check('text-only model: images dropped, screenshot/click/scroll switched off, the rest still works',
    noVisionFlag && vr.text.includes('Opened Notes.') && fake.calls.some(c => c.open === 'Notes') && !lastTools.includes('take_screenshot') && !lastTools.includes('click') && lastTools.includes('open_app')
    && evts.some(([t, d]) => t === 'action' && d.id === 'vision'), JSON.stringify({ noVisionFlag, text: vr.text, lastTools }));
  vmock.server.close();
  settings.set('securityLevel', 'guarded');

  // The real redaction helper, on a real image containing a fake key.
  const { BrowserWindow } = require('electron');
  const tw = new BrowserWindow({ width: 700, height: 220, show: false });
  await tw.loadURL('data:text/html,' + encodeURIComponent('<body style="font:22px Helvetica;background:white;padding:20px">Hello there, this is fine.<br><br>api key: sk-ant-api03-TESTKEY1234567890abcd<br><br>Another normal line.</body>'));
  await wait(400);
  const png = path.join(sandbox, 'shot.png');
  const jpg = path.join(sandbox, 'shot.jpg');
  fs.writeFileSync(png, (await tw.webContents.capturePage()).toPNG());
  tw.destroy();
  const { patternsWith } = require('./ai/redact');
  const bin = await ensureHelper('tito-redact', 'redact');
  const h1 = await runHelper(bin, [png, jpg], JSON.stringify(patternsWith([])), 30000);
  const h2 = await runHelper(bin, [jpg, path.join(sandbox, 'again.jpg')], JSON.stringify(patternsWith([])), 30000);
  check('screenshot redaction: the key is found and blacked out on-device', h1.code === 0 && JSON.parse(h1.out).redacted >= 1 && h2.code === 0 && JSON.parse(h2.out).redacted === 0, `${h1.out.trim()} then ${h2.out.trim()} ${h1.err}`);
  fs.copyFileSync(jpg, path.join(out, 'redacted.jpg'));
  check('text redaction keeps ordinary text', redactText('hello world 12345').text === 'hello world 12345');
  const ih = await runHelper(await ensureHelper('tito-input', 'input'), ['check']);
  check('input helper reports Accessibility status', /"trusted":(true|false)/.test(ih.out), ih.out.trim());
  fs.rmSync(sandbox, { recursive: true, force: true });

  // No key -> friendly error with a way to fix it
  settings.set('aiProvider', 'groq');
  sec.remove('groq');
  await typeAndSend('hello?');
  await wait(600);
  const chatErr = await cjs('(() => { const e = [...document.querySelectorAll(".err")].pop(); return e ? { text: e.querySelector("span").textContent, buttons: [...e.querySelectorAll("button")].map(b => b.textContent) } : null; })()');
  check('chat: missing key shows a clear error with "Open Settings"', chatErr && /No API key/.test(chatErr.text) && chatErr.buttons.includes('Open Settings'), JSON.stringify(chatErr));
  await cw.webContents.executeJavaScript('document.querySelector(".msg.user:last-of-type")');
  await wait(200);
  await shot(cw, 'chat.png');
  // New chat clears history
  await cjs('document.getElementById("newChat").click()');
  await wait(300);
  check('New chat clears the conversation', getChat().history().length === 0 && (await cjs('document.querySelectorAll(".msg").length')) === 0);
  settings.set('aiProvider', 'anthropic');
  cmock.server.close();
  cw.close();

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
  check('settings floats on top, on every desktop', sw.isAlwaysOnTop() && sw.isVisibleOnAllWorkspaces());
  const taskRows = await sw.webContents.executeJavaScript('[...document.querySelectorAll(".task .sum")].map(e => e.textContent)');
  check('settings lists scheduled tasks', taskRows.length === 1 && taskRows[0] === 'Open Notes every 1 h', JSON.stringify(taskRows));
  await sw.webContents.executeJavaScript('(() => { document.getElementById("taskKind").value = "key"; document.getElementById("taskValue").value = "space"; document.getElementById("taskEvery").value = "6"; document.getElementById("taskAdd").click(); })()');
  await wait(400);
  check('a task can be added in settings', settings.get('tasks').length === 2 && settings.get('tasks')[1].everySec === 360 && (await sw.webContents.executeJavaScript('document.querySelectorAll(".task").length')) === 2);
  await sw.webContents.executeJavaScript('document.querySelector(".task .x").click()');
  await wait(300);
  check('and removed again', settings.get('tasks').length === 1);
  settings.set('tasks', []);
  const nProviders = await sw.webContents.executeJavaScript('document.querySelectorAll("#provider option").length');
  check('provider dropdown lists all presets', nProviders === 14, `options=${nProviders}`);
  await sw.webContents.executeJavaScript('(() => { const s = document.getElementById("provider"); s.value = "ollama"; s.dispatchEvent(new Event("change")); })()');
  await wait(300);
  const localUI = await sw.webContents.executeJavaScript('[document.getElementById("keyRow").hidden, document.getElementById("localText").textContent]');
  check('local provider hides the key field', localUI[0] === true && (await sw.webContents.executeJavaScript('getComputedStyle(document.getElementById("keyRow")).display')) === 'none' && /No key needed/.test(localUI[1]), JSON.stringify(localUI));
  await sw.webContents.executeJavaScript('(() => { const s = document.getElementById("provider"); s.value = "groq"; s.dispatchEvent(new Event("change")); })()');
  await wait(300);
  const groqURL = await sw.webContents.executeJavaScript('[document.getElementById("baseURL").value, document.getElementById("baseURL").readOnly, getComputedStyle(document.getElementById("baseRow")).display]');
  check('presets show their built-in base URL (read-only)', groqURL[0] === 'https://api.groq.com/openai/v1' && groqURL[1] === true && groqURL[2] !== 'none', JSON.stringify(groqURL));
  await sw.webContents.executeJavaScript('(() => { const s = document.getElementById("provider"); s.value = "custom"; s.dispatchEvent(new Event("change")); })()');
  await wait(300);
  check('Custom base URL is editable', (await sw.webContents.executeJavaScript('document.getElementById("baseURL").readOnly')) === false);
  const keyRowShown = await sw.webContents.executeJavaScript('getComputedStyle(document.getElementById("keyRow")).display');
  check('key row really visible for providers that need a key', keyRowShown !== 'none');
  await sw.webContents.executeJavaScript('(() => { const s = document.getElementById("provider"); s.value = "anthropic"; s.dispatchEvent(new Event("change")); })()');
  await wait(300);
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
