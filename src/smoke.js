// Dev smoke test (TITO_SMOKE=<output dir>). Drives the real app with synthetic input and fake
// window lists, printing PASS/FAIL lines. Screenshots of popups go to the output dir.
const fs = require('fs');
const path = require('path');
const { screen } = require('electron');
const { PERSONALITIES } = require('./personalities');
const { MOVE_ANIMS } = require('./brain');

const wait = ms => new Promise(r => setTimeout(r, ms));

async function run({ app, petWin, brain, settings, openSettings, getPopup, getSettingsWin }) {
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

  // ---- settings ----
  settings.set('personality', 'sleepy');
  check('personality applied', brain.personalityId === 'sleepy');
  settings.set('personality', 'balanced');
  openSettings();
  await wait(1500);
  const sw = getSettingsWin();
  const cards = sw && await sw.webContents.executeJavaScript('document.querySelectorAll("label.card").length');
  check('settings lists 6 personalities', cards === 6, `cards=${cards}`);
  if (sw) await shot(sw, 'settings.png');

  clearTimeout(timeout);
  console.log(results.every(Boolean) ? 'SMOKE OK' : 'SMOKE FAILED');
  app.exit(results.every(Boolean) ? 0 : 1);
}

module.exports = { run };
