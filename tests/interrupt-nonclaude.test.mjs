// Card 2026-0230 — a soft (⏸) interrupt against a worker on a non-Claude backend
// appeared to be a no-op: the arm was placed, the turn ran to completion, no
// error, no annotation.
//
// There is no per-backend adapter (every backend runs the same `claude` CLI, see
// resolveBackendLaunch), so the defect is not a missing translation layer. It is
// that a streaming block had exactly ONE way to be retired — its own close event
// — and a substitution gateway can frame a stream so that event never arrives:
// a `content_block_start` with no `content_block.type` (the block then opens on
// its first text_delta) makes `content_block_stop` fall through every branch of
// the parser and emit nothing. The arm then latches for the rest of the turn and
// is cleared silently at `turn_end`.
//
// The fix adds a SECOND discharge path — the appearance of a different
// `(msgId, blockIdx)` key retires the stale block — plus the arm-relative
// bookkeeping the abort needs to see it (`boundarySeq` vs an arm-time snapshot).
// Tool spans are deliberately NOT progressed: they discharge only on a matching
// `tool_result` or a turn boundary, which is why the S-cases below must HOLD.
//
// Everything after the arm is driven synthetically via inst._handleStdoutLine(),
// the idiom of tests/deferred-interrupt.test.mjs — nothing depends on subprocess
// timing — and "did it fire" is read from `inst._interruptFired` (synchronous)
// plus the fake CLI's stdin capture (FAKE_CLAUDE_TRANSCRIPT, the only view of
// what actually reached the CLI).

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-gateway-unclosed-block.json');

let ctx, instances, home, transcriptPath;
let seq = 0;
const cleanupListeners = [];

before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO });
  ({ instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  ctx.projectsRoot = r.projectsRoot;
  ctx.claudeProjectsRoot = r.claudeProjectsRoot;
  transcriptPath = path.join(home, `stdin-${++seq}.jsonl`);
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });
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
  } catch { return []; }
}
const interruptsIn = (lines) => lines.filter(
  l => l.type === 'control_request' && l.request?.subtype === 'interrupt');
async function interruptCount() { return interruptsIn(await stdinLines()).length; }
const waitInterrupts = (n) => waitFor(async () => (await interruptCount()) === n);

// A worker on a SUBSTITUTION backend — the configuration the defect was reported
// against. `create()` directly (not the REST route) because the backend/model
// pair is an MCP-level field.
async function setupInstance() {
  const inst = await instances.create({
    project: 'demo', mode: 'bypassPermissions', backend: 'ollama', model: 'gemma4:cloud',
  });
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  assert.equal(inst.backend, 'ollama', 'bound to a non-Claude backend row');
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
const stream = (event) => ({ type: 'stream_event', event });
// A gateway-framed block start: NO content_block.type, so the parser emits
// nothing here and nothing at its content_block_stop either.
const openTypeless = (index) => stream({ type: 'content_block_start', index, content_block: { text: '' } });
const textDelta = (index, text) => stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
const blockStop = (index) => stream({ type: 'content_block_stop', index });
const msgStart = (id) => stream({ type: 'message_start', message: { id, role: 'assistant' } });
const openTool = (index, id) => stream({
  type: 'content_block_start', index,
  content_block: { type: 'tool_use', id, name: 'Bash', input: {} },
});
const jsonDelta = (index, partial) => stream({
  type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partial },
});
const toolResult = (id) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false }] },
  parent_tool_use_id: null,
});
const turnEnd = () => ({
  type: 'result', subtype: 'success', stop_reason: 'end_turn',
  duration_ms: 5, total_cost_usd: 0.0001, is_error: false,
});

// Arm inside a gateway-framed text block whose close will never arrive.
async function armedInUnclosedBlock() {
  const inst = await setupInstance();
  const evs = collect(inst);
  inst.prompt('gw-text');
  await waitFor(() => evs.some(e => e.kind === 'text_delta'));
  assert.equal(inst.status, 'turn');
  await inst.interrupt();
  assert.equal(inst.interrupting, true, 'armed');
  assert.equal(inst._interruptFired, false, 'mid-block ⇒ nothing sent yet');
  return { inst, evs };
}

// Arm with a tool genuinely dispatched and unreturned (block finalized, span open).
async function armedWithToolInFlight() {
  const inst = await setupInstance();
  const evs = collect(inst);
  inst.prompt('gw-tool');
  await waitFor(() => evs.some(e => e.kind === 'tool_use_start'));
  inject(inst, blockStop(0)); // typed tool block ⇒ finalizes, span stays open
  assert.ok(evs.some(e => e.kind === 'tool_use'), 'tool dispatched');
  await inst.interrupt();
  assert.equal(inst._interruptFired, false, 'an unreturned tool holds the arm');
  return { inst, evs };
}

// ── THE CARD'S FAILING TEST ───────────────────────────────────────────────
//
// INVARIANT: an armed soft interrupt fires at the NEXT block boundary even when
// the current block's close never arrives. Unfixed: `_interruptFired` stays
// false, zero interrupts reach the CLI, and the arm is cleared silently at the
// turn's end. This is the one test the whole change exists to pass, and it is
// what kills the removal of EITHER single line — the progression mark in
// QuiescenceScan.apply, or the `boundarySeq > armSeq` clause in
// Instance._atInterruptBoundary.
test('gateway stream with no block close: the armed interrupt fires at the next block key', async () => {
  const { inst } = await armedInUnclosedBlock();

  // The gateway DOES send a content_block_stop — it just carries no usable type,
  // so the parser emits nothing and the block stays open. This is the event that
  // would have discharged the arm on a well-formed stream.
  inject(inst, blockStop(0));
  assert.equal(inst._interruptFired, false, 'the swallowed close discharges nothing');
  assert.equal(await interruptCount(), 0);
  assert.equal(inst._quiescence.empty, false, 'the block is still open — this never becomes empty');

  // A second block opens. Its first delta is the first event carrying a
  // DIFFERENT (msgId, blockIdx), so it retires the stale block.
  inject(inst, openTypeless(1));
  assert.equal(inst._interruptFired, false, 'a typeless block start emits no UiEvent at all');
  inject(inst, textDelta(1, 'more'));
  assert.equal(inst._interruptFired, true, 'fired at the next block key');

  // Read BEFORE awaiting the ACK: the fake answers the abort with a `result`,
  // which resets the scan. The stale block is still counted as open (it is
  // unfinished, permanently) — so the abort saw the BOUNDARY, not an empty state.
  assert.equal(inst._quiescence.empty, false, 'not empty — the fire was boundary-relative');

  await waitInterrupts(1);
  const lines = await stdinLines();
  assert.equal(interruptsIn(lines).length, 1, 'exactly one interrupt control_request');
  assert.equal(lines.filter(l => l.type === 'user').length, 1, 'the prompt only — no steer');
});

// The same latch across a MESSAGE boundary (class C+): the next block key is
// (new msgId, 0) rather than (same msgId, 1).
test('gateway stream with no block close: a new message key discharges it too', async () => {
  const { inst } = await armedInUnclosedBlock();
  inject(inst, blockStop(0));
  assert.equal(inst._interruptFired, false);

  inject(inst, msgStart('msg_gw1b'));
  assert.equal(inst._interruptFired, false, 'message_start alone names no block');
  inject(inst, openTypeless(0));
  inject(inst, textDelta(0, 'next message'));
  assert.equal(inst._interruptFired, true, 'fired at the new message\'s first block key');
  await waitInterrupts(1);
});

// ── THE GUARD (S5) ────────────────────────────────────────────────────────
//
// The retire reads ONLY events carrying BOTH a msgId and a numeric blockIdx.
// This is the pin for that guard: with a text block open and NO tool pending,
// the pendingTools clause cannot be what holds the arm — only the guard can. A
// candidate that read progression from any event fired at index 35 of
// tests/fixtures/trace-quiescent-boundary.jsonl while Bash `3iXWNctP` ran until
// index 47.
test('S5: msgId-less events retire nothing — system, tool_result and a bare assistant message', async () => {
  const { inst } = await armedInUnclosedBlock();
  inject(inst, blockStop(0));

  inject(inst, { type: 'system', subtype: 'init', session_id: 's', cwd: '/tmp', model: 'm', permissionMode: 'bypassPermissions', uuid: 'sys-1' });
  assert.equal(inst._interruptFired, false, 'a system event names no block');
  inject(inst, toolResult('tu_never_dispatched'));
  assert.equal(inst._interruptFired, false, 'a tool_result names no block');
  inject(inst, {
    type: 'assistant',
    message: { id: 'msg_gw1', role: 'assistant', content: [{ type: 'text', text: 'reconciled' }] },
    parent_tool_use_id: null,
  });
  assert.equal(inst._interruptFired, false, 'a reconciled assistant message names no block');
  assert.equal(await interruptCount(), 0);

  // …and the real next block key still discharges it, so the hold above is the
  // guard doing its job rather than the arm being dead.
  inject(inst, openTypeless(1));
  inject(inst, textDelta(1, 'next'));
  assert.equal(inst._interruptFired, true);
  await waitInterrupts(1);
});

// ── TOOL SPANS STAY STRICT (S1, S2, S3, S6, S7, S8) ───────────────────────
//
// WHICH TEST PINS WHAT — these are two different invariants and only one of them
// is the pin for "progression never discharges a span":
//   S8 IS THAT PIN. It is the only case here where the progression mark loop
//     actually runs with a span open (a display block is open AND a new key
//     arrives), so it is what fails if progression is ever extended to
//     `pendingTools`. Do not weaken it.
//   S1 pins something narrower: an unreturned span holds the arm across events
//     that name no new block. Its own display block was already closed by
//     `tool_use` before the arm, so the mark loop is a no-op here and this case
//     would survive a progression-clears-spans mutation. Stated, and asserted
//     below, so the distinction is not re-attributed by a later reader.

test('S1: a dispatched tool with no result holds the arm indefinitely', async () => {
  const { inst } = await armedWithToolInFlight();
  // The tool's own display block closed at `tool_use`, so nothing is open here…
  assert.equal(inst._quiescence.openBlocks.size, 0, 'no display block open — see the note above');
  // …and a later block key therefore retires nothing. What holds the arm is the
  // span alone. (This is NOT the tool-span-strictness pin — S8 is.)
  inject(inst, openTypeless(1));
  inject(inst, textDelta(1, 'while the tool runs'));
  assert.equal(inst._interruptFired, false, 'the span, not the block, is what holds');
  assert.equal(await interruptCount(), 0);
});

test('S2: two tools in one message, only the first resolved ⇒ still held', async () => {
  const { inst } = await armedWithToolInFlight();
  inject(inst, openTool(1, 'tu_gw_bash2'));
  inject(inst, jsonDelta(1, '{"command":"pwd"}'));
  inject(inst, blockStop(1));
  inject(inst, toolResult('tu_gw_bash'));
  assert.equal(inst._interruptFired, false, 'the second span is still open');
  inject(inst, toolResult('tu_gw_bash2'));
  assert.equal(inst._interruptFired, true, 'both returned ⇒ fires');
  await waitInterrupts(1);
});

test('S3: a tool followed by later text in the same message ⇒ still held', async () => {
  const { inst } = await armedWithToolInFlight();
  inject(inst, openTypeless(1));
  inject(inst, textDelta(1, 'commentary'));
  inject(inst, blockStop(1));
  assert.equal(inst._interruptFired, false);
  assert.equal(await interruptCount(), 0);
});

test('S6: a NEW msgId while a tool is genuinely in flight ⇒ still held', async () => {
  const { inst } = await armedWithToolInFlight();
  inject(inst, msgStart('msg_gw2b'));
  inject(inst, openTypeless(0));
  inject(inst, textDelta(0, 'a whole new message'));
  assert.equal(inst._interruptFired, false, 'a message boundary is not a tool_result');
  assert.equal(await interruptCount(), 0);
});

// THE tool-span-strictness pin (see the note above): the only case whose
// progression mark loop runs with a span open. Its `pendingTools.size === 1`
// assertion is what fails if progression is ever extended to tool spans.
test('S8: a new BLOCK KEY while a tool is in flight retires the display block, not the span', async () => {
  const { inst } = await armedWithToolInFlight();
  // A gateway-framed text block streams alongside the still-open span…
  inject(inst, openTypeless(1));
  inject(inst, textDelta(1, 'while it runs'));
  const before = inst._quiescence.boundarySeq;
  // …and the next block key retires THAT block.
  inject(inst, openTypeless(2));
  inject(inst, textDelta(2, 'and on'));
  assert.ok(inst._quiescence.boundarySeq > before, 'a boundary WAS crossed');
  assert.equal(inst._quiescence.pendingTools.size, 1, 'and the span survived it');
  assert.equal(inst._interruptFired, false, 'so the abort still holds');
});

test('S7: once the tool_result lands the hold is released — it was a lag, not a wedge', async () => {
  const { inst } = await armedWithToolInFlight();
  inject(inst, openTypeless(1));
  inject(inst, textDelta(1, 'more output'));
  assert.equal(inst._interruptFired, false);

  inject(inst, toolResult('tu_gw_bash'));
  assert.equal(inst._quiescence.pendingTools.size, 0, 'the span is discharged');
  assert.equal(inst._interruptFired, false, 'but a block is still streaming — one block of lag');

  inject(inst, openTypeless(2));
  inject(inst, textDelta(2, 'the next block'));
  assert.equal(inst._interruptFired, true, 'fires at the next boundary');
  await waitInterrupts(1);
});

// ── THE ARM-TIME SNAPSHOT ─────────────────────────────────────────────────
//
// INVARIANT: arming after at least one block has ALREADY been retired must still
// require a boundary crossing AFTER the arm. Every other test in this file arms
// while `boundarySeq` is still 0, where snapshotting the real value and
// snapshotting a constant 0 are indistinguishable — so this is the only case
// here that reads `_interruptArmSeq` as a value rather than as a zero. With the
// snapshot stuck at 0 the already-elapsed crossings look like post-arm ones and
// the abort fires immediately, mid-block, discarding the block being streamed.
test('arm-time snapshot: crossings BEFORE the arm do not count toward it', async () => {
  const inst = await setupInstance();
  const evs = collect(inst);
  inst.prompt('gw-text');
  await waitFor(() => evs.some(e => e.kind === 'text_delta'));

  // Retire a block BEFORE arming, so the counter is non-zero at arm time — the
  // one condition no other test in this file creates.
  inject(inst, openTypeless(1));
  inject(inst, textDelta(1, 'block two'));
  const atArm = inst._quiescence.boundarySeq;
  assert.ok(atArm > 0, 'a block has already been retired in this turn');
  assert.equal(inst._quiescence.pendingTools.size, 0, 'no tool is holding anything');

  await inst.interrupt();
  // BEHAVIOUR first: with the snapshot stuck at 0 the pre-arm crossing looks
  // post-arm and this fires synchronously inside interrupt(), cutting the block
  // that is streaming right now.
  assert.equal(inst._interruptFired, false,
    'a crossing that happened BEFORE the arm must not discharge it');
  assert.equal(await interruptCount(), 0, 'nothing reached the CLI mid-block');
  assert.equal(inst._interruptArmSeq, atArm, 'and the arm snapshotted the CURRENT count, not 0');

  // Only a crossing AFTER the arm does.
  inject(inst, openTypeless(2));
  inject(inst, textDelta(2, 'block three'));
  assert.equal(inst._interruptFired, true, 'fired on the post-arm crossing');
  await waitInterrupts(1);
});

// ── RESIDUALS, PINNED (R1, R2, D) ─────────────────────────────────────────
//
// The predicate is still forgeable and these say exactly how. In R1/R2 the turn
// ends by itself, so `turn_end` still reaches idle — which is what the automatic
// callers need; they are cosmetic for the drain and the overage stop, and a mild
// annoyance for a human cutting a long monologue short. Class D never drains its
// span at all and routes to the deadline backstop
// (tests/resume-restart-drain-backstop.test.mjs).

test('R1: an arm in the FINAL block of the turn never fires the soft tier', async () => {
  const { inst } = await armedInUnclosedBlock();
  inject(inst, blockStop(0));       // swallowed
  inject(inst, turnEnd());          // no next block key ever arrives
  assert.equal(inst.status, 'idle');
  assert.equal(inst._interruptFired, false, 'nothing was ever sent');
  assert.equal(inst._interruptArmed, false, 'the arm is cleared at the turn boundary');
  assert.equal(await interruptCount(), 0);
});

test('R2: a turn framed as ONE block never fires the soft tier', async () => {
  const { inst } = await armedInUnclosedBlock();
  // More deltas of the SAME block — the whole turn is this one block.
  inject(inst, textDelta(0, ' and more'));
  inject(inst, textDelta(0, ' and more still'));
  assert.equal(inst._interruptFired, false, 'the same key retires nothing');
  inject(inst, turnEnd());
  assert.equal(inst._interruptFired, false);
  assert.equal(await interruptCount(), 0);
});

test('D: a tool_result whose id was renamed by a proxy never discharges the span', async () => {
  const { inst } = await armedWithToolInFlight();
  inject(inst, toolResult('call_renamed_by_the_gateway'));
  assert.equal(inst._quiescence.pendingTools.has('tu_gw_bash'), true, 'the original id still pends');
  inject(inst, openTypeless(1));
  inject(inst, textDelta(1, 'later text'));
  assert.equal(inst._interruptFired, false, 'no block key can discharge a tool span');
  assert.equal(await interruptCount(), 0);
});

// ── THE WELL-FORMED HALF, ON THIS BACKEND ─────────────────────────────────
//
// The same instance, same backend, a properly typed block: behaviour is exactly
// today's — the close discharges the arm and nothing waits for a next key.
test('a well-formed block on the same backend still fires at its own close', async () => {
  const inst = await setupInstance();
  const evs = collect(inst);
  inst.prompt('gw-tool'); // a TYPED (tool_use) block start
  await waitFor(() => evs.some(e => e.kind === 'tool_use_start'));
  await inst.interrupt();
  assert.equal(inst._interruptFired, false);
  inject(inst, blockStop(0));
  assert.equal(inst._interruptFired, false, 'dispatched ⇒ the span holds');
  inject(inst, toolResult('tu_gw_bash'));
  assert.equal(inst._interruptFired, true, 'fired at its own boundary, no next key needed');
  await waitInterrupts(1);
});
