// Dev harness (TITO_TRIAL=<prompts.json> TITO_TRIAL_OUT=<log>): feeds prompts through the real chat +
// agent loop with the provider saved in Settings, logging every step (actions, replies, errors).
// It never approves a confirmation popup (they are auto-declined) and runs on a copy of the profile.
const fs = require('fs');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function run({ app, chat, prompts, out, gapMs = 15000 }) {
  const w = line => fs.appendFileSync(out, line + '\n');
  chat.d.confirm = async () => 'deny';
  let reply = '';
  chat.on('delta', d => { reply += d; });
  chat.on('action', a => w(`  [action] ${a.status.padEnd(8)} ${a.title}${a.detail ? ` (${a.detail})` : ''}${a.note ? ` — ${a.note}` : ''}`));
  chat.on('error', e => w(`  [error] ${e.code}: ${e.message}`));
  w(`TRIAL START ${new Date().toISOString()}`);
  for (const prompt of prompts) {
    reply = '';
    w(`\n> ${prompt}`);
    const t0 = Date.now();
    const r = await chat.send(prompt);
    w(`  [reply] ${reply.trim().replace(/\s+/g, ' ').slice(0, 400) || '(none)'}`);
    w(`  [result] ok=${!!(r && r.ok)} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await wait(gapMs);
  }
  w('TRIAL DONE');
  app.exit(0);
}

module.exports = { run };
