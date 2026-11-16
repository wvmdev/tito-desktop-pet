// One chat turn with computer control: ask the model, run the tool calls it makes (each one
// checked against the permission policy, with a confirmation popup where required), feed the
// results back, repeat until it answers in plain text.
//
// Safety properties enforced here:
//   - Every tool call goes through decide(); "ask" waits for the user's own click in Tito's
//     confirmation window. Nothing the model says, and nothing read from the screen or a file,
//     can approve an action.
//   - Calls run strictly one at a time, so the model can never act while a confirmation is open.
//   - The policy is re-read before every call: switching to Lockdown mid-task takes effect at once.
//   - Stop (Esc) aborts between and during calls.
//   - During the loop the conversation is append-only and the system prompt and tool list are
//     frozen (required for Claude's thinking blocks to stay valid).
const { decide } = require('./permissions');
const { classify, validate } = require('./tools');
const { cleanTask, describeTask } = require('../tasks');

const MAX_STEPS = 25;
const ORDER = { allow: 0, ask: 1, deny: 2 };

const short = (s, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Human-readable description of a call, built from its real arguments (not from the model's words).
function describe(name, input = {}) {
  switch (name) {
    case 'take_screenshot': return { title: 'Look at the screen' };
    case 'click': return { title: `${input.clicks === 2 ? 'Double-click' : input.button === 'right' ? 'Right-click' : 'Click'} at (${Math.round(input.x)}, ${Math.round(input.y)})` };
    case 'type_text': return { title: 'Type text', detail: short(String(input.text), 300) };
    case 'press_key': return { title: `Press ${String(input.keys).toLowerCase()}` };
    case 'scroll': return { title: `Scroll ${input.dy > 0 ? 'down' : 'up'}` };
    case 'open_app': return { title: `Open ${short(String(input.name), 60)}` };
    case 'read_file': return { title: 'Read a file', detail: short(String(input.path), 200) };
    case 'list_folder': return { title: 'List a folder', detail: short(String(input.path), 200) };
    case 'write_file': return { title: 'Write a file', detail: `${short(String(input.path), 200)} (${String(input.content).length} characters)` };
    case 'delete_file': return { title: 'Move to the Trash', detail: short(String(input.path), 200) };
    case 'schedule_task': {
      let summary = 'Repeat a task';
      try { summary = `Repeat: ${describeTask(cleanTask({ kind: input.kind, value: input.value, everySec: input.every_seconds }))}`; } catch { /* shown as invalid when run */ }
      return { title: short(summary, 70), detail: 'Runs until you remove it in Settings.' };
    }
    case 'list_tasks': return { title: 'Check scheduled tasks' };
    case 'cancel_task': return { title: 'Remove a scheduled task', detail: short(String(input.id), 40) };
    default: return { title: short(String(name), 60) };
  }
}

function abortError() { return Object.assign(new Error('aborted'), { name: 'AbortError' }); }

/**
 * @param {object} o
 * @param o.provider      from createProvider()
 * @param o.system        system prompt (frozen for the turn)
 * @param o.messages      neutral history ending with the new user message (not mutated)
 * @param o.tools         neutral tools available this turn ([] = chat only)
 * @param o.executor      Executor
 * @param o.getPolicy     () => ({ level, perms }), read before every call
 * @param o.confirm       async ({ id, title, detail, reason, why }) => 'allow' | 'deny'
 * @param o.emit          (type, data): 'delta' text, 'action' { id, title, detail, status, note }
 * @param o.signal        AbortSignal
 * @param o.secrets       strings to scrub from anything returned to the model
 */
async function runAgentTurn({ provider, system, messages, tools, executor, getPolicy, confirm, emit, signal, secrets = [] }) {
  const convo = messages.slice();
  const texts = [];
  let refused = false;
  let model = null;
  let n = 0;

  for (let step = 0; ; step++) {
    if (signal.aborted) throw abortError();
    const r = await provider.sendMessage(convo, { system, tools, signal, onText: d => emit('delta', d) });
    if (signal.aborted) throw abortError(); // some streams end quietly on abort
    model = r.model;
    if (r.refused) { refused = true; break; }
    if (r.text) texts.push(r.text);
    const calls = r.toolCalls || [];
    // Never run tools from a cut-off reply: its arguments may be incomplete.
    if (!calls.length || r.stopReason === 'max_tokens' || r.stopReason === 'length') break;
    convo.push({ role: 'assistant', content: r.text, toolCalls: calls, native: r.native });

    const results = [];
    for (const call of calls) {
      if (signal.aborted) throw abortError();
      const id = `a${++n}`;
      const base = { id: call.id, name: call.name };
      const invalid = call.input === null ? 'The tool arguments were not valid JSON.' : validate(call.name, call.input);
      if (invalid) {
        emit('action', { id, title: describe(call.name, call.input || {}).title, status: 'error', note: invalid });
        results.push({ ...base, text: invalid, isError: true });
        continue;
      }
      const d = describe(call.name, call.input);
      const reason = typeof call.input.reason === 'string' ? short(call.input.reason, 200) : '';

      // Permission: strictest answer across everything this call needs.
      const { level, perms } = getPolicy();
      let verdict = { decision: 'allow', reason: '' };
      for (const c of classify(call.name, call.input) || [{ action: '?' }]) {
        const v = decide(c.action, { level, perms, destructive: !!c.destructive });
        if (ORDER[v.decision] > ORDER[verdict.decision]) verdict = v;
      }
      if (verdict.decision === 'deny') {
        emit('action', { id, ...d, status: 'blocked', note: verdict.reason });
        results.push({ ...base, text: `Not allowed: ${verdict.reason}. This is the user's setting; do not try to get around it.`, isError: true });
        continue;
      }
      if (verdict.decision === 'ask') {
        emit('action', { id, ...d, status: 'asking', note: reason });
        const answer = await confirm({ id, ...d, reason, why: verdict.reason });
        if (signal.aborted) throw abortError();
        if (answer !== 'allow') {
          emit('action', { id, ...d, status: 'denied' });
          results.push({ ...base, text: 'The user declined this action. Do not retry it; ask what they would like instead.', isError: true });
          continue;
        }
      }
      emit('action', { id, ...d, status: 'running', note: reason });
      const out = await executor.run(call.name, call.input, { secrets, signal });
      if (signal.aborted) throw abortError();
      emit('action', { id, ...d, status: out.isError ? 'error' : 'done', note: out.isError ? out.text : reason });
      results.push({ ...base, text: out.text, image: out.image, isError: !!out.isError });
    }
    convo.push({ role: 'tool', results });

    if (step + 1 >= MAX_STEPS) {
      const note = `(I stopped after ${MAX_STEPS} steps. Tell me if I should continue.)`;
      emit('delta', note);
      texts.push(note);
      break;
    }
  }
  return { text: texts.join('\n\n'), refused, model, steps: n };
}

module.exports = { runAgentTurn, describe, MAX_STEPS };
