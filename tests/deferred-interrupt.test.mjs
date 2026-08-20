// Deferred direct interrupt — the SOFT (⏸) tier of Instance.interrupt().
//
// ⏸ no longer injects a steering user message: it ARMS a real
// `control_request subtype:interrupt` and fires it at the first quiescent point
// (nothing mid-stream, every dispatched tool returned its result). These tests
// prove WHEN it fires by reading the fake CLI's stdin capture
// (FAKE_CLAUDE_TRANSCRIPT) — the only view of what actually reached the CLI —
// and drive the boundary events synthetically via inst._handleStdoutLine(), so
// nothing depends on subprocess timing.
//
// The negative assertions ("not fired yet") pair the stdin read with
// `inst._interruptFired`: the transcript is appended asynchronously by the
// engine, so the flag is the exact, synchronous gate on the one code path that
// can send the request.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-deferred-interrupt.json');
// Lines 4–66 of a real debug capture (one "summarize the repo" turn: thinking,
// text, three tool_uses, their results, then a whole extra API round-trip),
// long string payloads truncated. See the trace test at the bottom.
const TRACE = path.join(__dirname, 'fixtures', 'trace-quiescent-boundary.jsonl');
// Capture line 32 (fixture index 28) — the first tool_use envelope, i.e. the
// window in which the old steer was written. Capture line 56 (index 52) is the
// last tool_result: the first quiescent point after that arm.
const TRACE_ARM_IDX = 28;
const TRACE_BOUNDARY_IDX = 52;

let ctx, baseUrl, instances, home, transcriptPath;
let seq = 0;
const cleanupListeners = [];

before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  ctx.projectsRoot = r.projectsRoot;
  ctx.claudeProjectsRoot = r.claudeProjectsRoot;
  // Per-test capture file, set BEFORE any instance launches (the engine reads
  // it from the env handed to that launch).
  transcriptPath = path.join(home, `stdin-${++seq}.jsonl`);
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;
});
afterEach(async () => {
  await instances.shutdown();
  for (const fn of cleanupListeners.splice(0)) fn();
  delete process.env.FAKE_CLAUDE_TRANSCRIPT;
  await rmrf(home);
});

async function stdinLines() {
  try {
    return (await fs.readFile(transcriptPath, 'utf8'))
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; } // engine has not opened the file yet ⇒ nothing sent
}
const interruptsIn = (lines) => lines.filter(
  l => l.type === 'control_request' && l.request?.subtype === 'interrupt');
async function interruptCount() { return interruptsIn(await stdinLines()).length; }
const waitInterrupts = (n) => waitFor(async () => (await interruptCount()) === n);

async function setupInstance({ mode = 'bypassPermissions' } = {}) {
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode });
  assert.equal(r.status, 201);
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  return inst;
}

function collect(inst) {
  const evs = [];
  const handler = (ev) => evs.push(ev);
  inst.on('event', handler);
  cleanupListeners.push(() => inst.off('event', handler));
  return evs;
}

const inject = (inst, obj) => inst._handleStdoutLine(JSON.stringify(obj));
const blockStop = (index = 0) => ({ type: 'stream_event', event: { type: 'content_block_stop', index } });
const toolResult = (id) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false }] },
  parent_tool_use_id: null,
});
const turnEnd = () => ({
  type: 'result', subtype: 'success', stop_reason: 'end_turn',
  duration_ms: 5, total_cost_usd: 0.0001, is_error: false,
});

// Drive a turn that leaves a text block open mid-stream.
async function armedMidTextBlock() {
  const inst = await setupInstance();
  const evs = collect(inst);
  inst.prompt('open text');
  await waitFor(() => evs.some(e => e.kind === 'text_delta'));
  assert.equal(inst.status, 'turn');
  await inst.interrupt();
  assert.equal(inst.interrupting, true, 'armed');
  assert.equal(inst._interruptFired, false, 'mid-block ⇒ nothing sent yet');
  assert.equal(await interruptCount(), 0, 'no control_request on stdin yet');
  return { inst, evs };
}

test('armed mid-text-block: fires exactly at the block close, and no steer is ever written', async () => {
  const { inst } = await armedMidTextBlock();

  inject(inst, blockStop(0));
  assert.equal(inst._interruptFired, true, 'fired at text_end');
  await waitInterrupts(1);

  const lines = await stdinLines();
  assert.equal(interruptsIn(lines).length, 1, 'exactly one interrupt control_request');
  const userLines = lines.filter(l => l.type === 'user');
  assert.equal(userLines.length, 1, 'the prompt is the ONLY user message written — no steer');
  assert.match(JSON.stringify(userLines[0]), /open text/);
  assert.ok(!JSON.stringify(lines).includes('[[cc:soft-interrupt]]'), 'no soft-interrupt marker');
});

test('armed with a tool in flight: the closing tool block does not fire, its tool_result does', async () => {
  const inst = await setupInstance();
  const evs = collect(inst);
  inst.prompt('open tool');
  await waitFor(() => evs.some(e => e.kind === 'tool_use_start'));
  await inst.interrupt();
  assert.equal(inst._interruptFired, false);

  // Tool block finalized — the tool is now DISPATCHED, its span still open.
  inject(inst, blockStop(0));
  assert.ok(evs.some(e => e.kind === 'tool_use'), 'tool_use event emitted');
  assert.equal(inst._interruptFired, false, 'in-flight tool holds the interrupt');
  assert.equal(await interruptCount(), 0);

  inject(inst, toolResult('tu_di_bash'));
  assert.equal(inst._interruptFired, true, 'fires when the tool_result lands');
  await waitInterrupts(1);
  assert.equal(interruptsIn(await stdinLines()).length, 1);
});

test('armed at a quiescent gap: fires synchronously inside interrupt()', async () => {
  const inst = await setupInstance();
  const evs = collect(inst);
  inst.prompt('gap');
  await waitFor(() => evs.some(e => e.kind === 'text_end'));
  assert.equal(inst.status, 'turn');
  assert.equal(inst._quiescence.empty, true, 'nothing open, nothing pending');

  await inst.interrupt();
  assert.equal(inst._interruptFired, true, 'fired inside the interrupt() call');
  await waitInterrupts(1);
});

test('turn ends before the boundary: nothing is ever sent and the arm is cleared', async () => {
  const { inst } = await armedMidTextBlock();

  inject(inst, turnEnd());
  assert.equal(inst.status, 'idle', '_setStatus ran before turn_end was emitted');
  assert.equal(inst.interrupting, false, 'arm cleared on exit from turn');
  assert.equal(inst._interruptArmed, false);
  assert.equal(inst._interruptFired, false);
  assert.equal(await interruptCount(), 0, 'no control_request ever left the orchestrator');
});

test('repeated soft while armed is a no-op: exactly one control_request', async () => {
  const { inst } = await armedMidTextBlock();

  await inst.interrupt();
  assert.equal(inst.interrupting, true, 'still armed');
  assert.equal(inst._interruptFired, false, 'the repeat did not fire anything');

  inject(inst, blockStop(0));
  await waitInterrupts(1);

  // A third call after the fire, plus a later boundary, add nothing.
  await inst.interrupt();
  inject(inst, toolResult('tu_di_bash'));
  assert.equal(interruptsIn(await stdinLines()).length, 1);
});

test('forced escalation while armed: fires at once, and the later boundary adds no second interrupt', async () => {
  const { inst, evs } = await armedMidTextBlock();

  // Not awaited: _controlRequest writes to stdin synchronously, so the boundary
  // injection below lands in the same tick — still `turn`, still armed — which
  // is exactly the case the _interruptFired guard has to cover.
  const forced = inst.interrupt({ force: true });
  assert.equal(inst._interruptFired, true, 'force disarms the pending fire');
  inject(inst, blockStop(0));
  await forced;

  assert.ok(inst._drainListener !== null, 'drain window opened by the forced abort');
  await waitInterrupts(1);
  await waitFor(() => inst.status === 'idle');
  assert.equal(interruptsIn(await stdinLines()).length, 1, 'one interrupt total');
  assert.equal(inst.interrupting, false);

  // The CLI's marker line came back on the aborted turn: never a user bubble.
  assert.equal(evs.filter(e => e.kind === 'user_echo' && /interrupted by user/.test(e.text ?? '')).length, 0);
});

test('the CLI interrupt marker annotates instead of bubbling, and is dropped while draining', async () => {
  const inst = await setupInstance();
  const evs = collect(inst);
  const marker = (text) => ({
    type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null,
  });
  const annotations = () => evs.filter(e => e.kind === 'system' && e.subtype === 'soft_interrupted');
  const echoCountBefore = inst._userEchoCount;

  inject(inst, marker('[Request interrupted by user]'));
  assert.equal(annotations().length, 1, 'renders as the ⏸ annotation');
  assert.equal(evs.filter(e => e.kind === 'user_echo').length, 0, 'never a user bubble');
  assert.equal(inst._userEchoCount, echoCountBefore, 'never shifts the rewind/fork index');

  // Inside a drain window the annotation is redundant with drain_abort.
  inst._openDrainWindow();
  inject(inst, marker('[Request interrupted by user for tool use]'));
  assert.equal(annotations().length, 1, 'suppressed while a drain window is open');
  inst._closeDrainWindow();

  inject(inst, marker('[Request interrupted by user for tool use]'));
  assert.equal(annotations().length, 2, 'the "for tool use" variant annotates too');
});

test('a follow-up prompt while armed: the abort fires, but the new turn is not drained', async () => {
  const { inst } = await armedMidTextBlock();

  // The prompt's own user_echo is a quiescence reset, so the armed abort fires
  // inside prompt() — and must not leave a drain window that would sever the
  // turn this prompt is starting.
  await inst.prompt('gap');
  assert.equal(inst._interruptFired, true, 'the arm fired on the prompt boundary');
  assert.equal(inst._drainListener, null, 'no drain window left open over the new turn');
  assert.equal(inst._drainTimer, null);
  await waitInterrupts(1);

  const lines = await stdinLines();
  assert.equal(lines.filter(l => l.type === 'user').length, 2, 'both prompts reached the CLI');
});

test('no active turn: soft interrupt writes nothing', async () => {
  const inst = await setupInstance();
  assert.equal(inst.status, 'idle');

  await inst.interrupt();
  assert.equal(inst.interrupting, false);
  assert.equal(inst._interruptArmed, false);
  assert.equal(await interruptCount(), 0);
});

test('process exits after arming: a later boundary event is harmless', async () => {
  const { inst } = await armedMidTextBlock();

  await inst.kill();
  await waitFor(() => inst.proc === null);
  assert.equal(inst.interrupting, false, 'arm cleared by the exit');

  inject(inst, blockStop(0)); // must not throw
  assert.equal(inst._interruptFired, false);
  assert.equal(await interruptCount(), 0);
});

// An ask-mode PreToolUse callback the hook broker holds open, with a stub
// Response that records what we eventually answer it.
function fakeHookRes() {
  return {
    headersSent: false, statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; },
  };
}

test('tool parked on a permission card: fires despite an unreturned tool, and releases the card', async () => {
  const inst = await setupInstance({ mode: 'ask' });
  const evs = collect(inst);
  inst.prompt('open tool');
  await waitFor(() => evs.some(e => e.kind === 'tool_use_start'));
  inject(inst, blockStop(0)); // dispatched: the tool span is open
  assert.equal(inst._quiescence.empty, false, 'a tool is outstanding');

  const res = fakeHookRes();
  inst.handleHookCallback({ tool_use_id: 'tu_di_bash', tool_name: 'Bash', tool_input: {} }, res);
  assert.equal(inst._blockedOnPermission(), true, 'a decision is pending');
  assert.equal(res.headersSent, false, 'the hook response is held open');

  await inst.interrupt();
  assert.equal(inst._interruptFired, true, 'a never-started tool does not hold the interrupt');
  // The fire is synchronous inside interrupt(); the ACK cannot have arrived yet
  // (it takes I/O), and the card must NOT be released ahead of it.
  assert.equal(res.headersSent, false, 'still held open until the abort is ACKed');
  await waitInterrupts(1);

  // The severed turn will never run that tool: the held-open hook response and
  // the UI card resolve on the ACK instead of waiting out the 9-min broker
  // timeout. Deliberately NOT before the request — see
  // Instance._releaseParkedPermissions.
  await waitFor(() => inst._hooks.pendingCount === 0);
  assert.equal(res.headersSent, true, 'the hook response was answered');
  assert.equal(res.body?.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(res.body?.hookSpecificOutput?.permissionDecisionReason ?? '', /interrupted/);
  const resolved = evs.filter(e => e.kind === 'permission_resolved');
  assert.equal(resolved.length, 1, 'the card was resolved for every subscribed tab');
  assert.equal(resolved[0].allow, false);
  assert.equal(resolved[0].toolUseId, 'tu_di_bash');
  assert.equal(resolved[0].reason, 'interrupted', 'distinguishable from an exit-time discard');
});

// Park a dispatched tool at an ask-mode permission card: the tool span is open
// (so quiescence is false) and the hook response is held open by the broker.
async function parkedOnPermission() {
  const inst = await setupInstance({ mode: 'ask' });
  const evs = collect(inst);
  inst.prompt('open tool');
  await waitFor(() => evs.some(e => e.kind === 'tool_use_start'));
  inject(inst, blockStop(0));
  const res = fakeHookRes();
  inst.handleHookCallback({ tool_use_id: 'tu_di_bash', tool_name: 'Bash', tool_input: {} }, res);
  assert.equal(inst._hooks.pendingCount, 1, 'a decision is pending');
  assert.equal(res.headersSent, false, 'held open');
  return { inst, evs, res };
}

test('forced abort over a parked permission: released on the ACK, not before it', async () => {
  const { inst, evs, res } = await parkedOnPermission();

  // Not awaited: _controlRequest writes synchronously, so this window is after
  // the request left and before its ACK came back.
  const forced = inst.interrupt({ force: true });
  assert.equal(inst._hooks.pendingCount, 1, 'not released ahead of the request');
  assert.equal(res.headersSent, false, 'hook response still open pre-ACK');

  await forced; // the force branch releases right after its ACK
  assert.equal(inst._hooks.pendingCount, 0, 'released once the abort was ACKed');
  assert.equal(res.headersSent, true);
  assert.equal(res.body?.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(res.body?.hookSpecificOutput?.permissionDecisionReason ?? '', /interrupted/);
  const resolved = evs.filter(e => e.kind === 'permission_resolved');
  assert.equal(resolved.length, 1);
  assert.deepEqual(
    [resolved[0].toolUseId, resolved[0].allow, resolved[0].reason],
    ['tu_di_bash', false, 'interrupted'],
  );
});

test('a failed fire leaves a parked permission alone: the abort never landed', async () => {
  const { inst, res } = await parkedOnPermission();
  let attempts = 0;
  inst._controlRequest = async () => { attempts += 1; throw new Error('boom'); };

  await inst.interrupt(); // fires despite the parked tool, then rejects
  assert.equal(attempts, 1, 'a request was attempted');
  await waitFor(() => inst.interrupting === false);

  // The turn was NOT severed, so the tool may still run: the card must survive
  // for the user to answer (and the stop stays re-armable).
  assert.equal(inst._hooks.pendingCount, 1, 'permission still pending');
  assert.equal(res.headersSent, false, 'hook response still held open');
  assert.equal(inst._interruptFired, false, 're-armable');
  const stderr = inst.ring.toArray().filter(e => e.kind === 'system' && e.subtype === 'stderr');
  assert.match(stderr.at(-1)?.data?.line ?? '', /interrupt failed: boom/);
});

// The `windDown()` steer this file used to pin — a mid-turn user message that
// raised `interrupting` without arming an abort — is gone with card 2026-0183: the
// resume-restart drain and the overage conductor stop are plain aborts now, so
// nothing writes a steer here any more. `_interruptArmed` remains the fire's gate
// (not `interrupting`), pinned by the forced-escalation test above; the marker's
// READ path is pinned by tests/soft-interrupt-filter.test.mjs, which still matters
// for historical jsonls.

test('a failed fire is re-armable within the same turn', async () => {
  const { inst } = await armedMidTextBlock();

  // Force the control request to fail (a real timeout is 5s of wall clock).
  const real = inst._controlRequest.bind(inst);
  let attempts = 0;
  inst._controlRequest = async () => { attempts += 1; throw new Error('boom'); };

  inject(inst, blockStop(0));
  assert.equal(attempts, 1, 'the boundary fired a request');
  await waitFor(() => inst.interrupting === false);
  assert.equal(inst._interruptArmed, false, 'disarmed by the failure');
  assert.equal(inst._interruptFired, false, 'and re-armable — the abort never landed');
  const evs = inst.ring.toArray().filter(e => e.kind === 'system' && e.subtype === 'stderr');
  assert.match(evs.at(-1)?.data?.line ?? '', /interrupt failed: boom/);
  assert.equal(attempts, 1, 'the failure annotation must not spin a retry');
  assert.equal(await interruptCount(), 0, 'nothing reached the CLI');

  // Re-arm: the turn is still running, so a second ⏸ must try again. The text
  // block is already closed, so this one fires straight away.
  assert.equal(inst.status, 'turn');
  inst._controlRequest = real;
  await inst.interrupt();
  assert.equal(inst.interrupting, true, 're-armed');
  assert.equal(inst._interruptFired, true, 'second attempt fired');
  await waitInterrupts(1);
});

test('real capture: the armed interrupt fires at the last tool_result, before the extra round-trip', async () => {
  const inst = await setupInstance();
  const lines = (await fs.readFile(TRACE, 'utf8')).split('\n').filter(Boolean);
  assert.equal(lines.length, 63, 'trace fixture is capture lines 4–66');

  // 'trace' matches no scenario turn, so the fake emits only its startup init:
  // the instance sits in `turn` with a clean scan, and the capture drives
  // everything from here. Wait that init out first — it lands on the first
  // stdin line and would otherwise arrive mid-capture, where the drain window
  // this fire opens would read it as a spurious turn.
  const evs = collect(inst);
  inst.prompt('trace');
  await waitFor(() => evs.some(e => e.kind === 'system' && e.subtype === 'init'));
  assert.equal(inst.status, 'turn');

  let firedAt = null;
  for (let i = 0; i < lines.length; i++) {
    if (i === TRACE_ARM_IDX) await inst.interrupt();
    if (lines[i].includes('"type":"result"')) break; // stop before capture line 66
    inst._handleStdoutLine(lines[i]);
    if (firedAt === null && inst._interruptFired) firedAt = i;
  }

  assert.equal(firedAt, TRACE_BOUNDARY_IDX,
    `fired at fixture index ${firedAt} (capture line ${firedAt + 4}), expected the last tool_result at capture line 56`);
  await waitInterrupts(1);
  inst._closeDrainWindow(); // the fire opened one; don't leave it armed for teardown
});
