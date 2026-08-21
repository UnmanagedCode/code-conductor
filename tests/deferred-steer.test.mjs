// send_prompt into a worker whose model cannot take a mid-turn injection.
//
// The message is NOT written into the running turn: the SOFT (block-edge) stop
// is armed instead, and the text goes out as a fresh turn carrying
// POST_STOP_STEER_NOTE once the boundary lands. Proven by reading the fake CLI's
// stdin capture (FAKE_CLAUDE_TRANSCRIPT) — the only view of what actually
// reached the CLI — with boundary events driven synthetically via
// inst._handleStdoutLine(), so nothing depends on subprocess timing. Harness
// copied from tests/deferred-interrupt.test.mjs.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { MID_TURN_NOTE, POST_STOP_STEER_NOTE } from '../src/instances.ts';
import { isMidTurnNoteContent, consolidateUserContent } from '../src/parser.ts';
import { sendPrompt } from '../src/mcp/handlers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-deferred-interrupt.json');
// The curated preset that declares midTurnSteering:false.
const FLAGGED_MODEL = 'deepseek-v4-flash:0731-cloud';

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
  } catch { return []; }
}
const interruptsIn = (lines) => lines.filter(
  l => l.type === 'control_request' && l.request?.subtype === 'interrupt');
const userLinesIn = (lines) => lines.filter(l => l.type === 'user' && l.message?.role === 'user');
const blocksOf = (line) => line.message.content;
const textsOf = (line) => blocksOf(line).filter(b => b.type === 'text').map(b => b.text);

// Boot an instance and bind it to a model with the capability flag — through the
// REAL resolver, so this also pins the Instance field ↔ registry wiring.
async function setupWorker({ flagged = true } = {}) {
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
  assert.equal(r.status, 201);
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  if (flagged) {
    inst.backend = 'ollama';
    inst.model = FLAGGED_MODEL;
    inst._refreshModelCapabilities();
    assert.equal(inst.acceptsMidTurnSteering, false, 'the flagged preset resolved');
  } else {
    assert.equal(inst.acceptsMidTurnSteering, true, 'a claude-backed worker is steerable');
  }
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
const turnEnd = () => ({
  type: 'result', subtype: 'success', stop_reason: 'end_turn',
  duration_ms: 5, total_cost_usd: 0.0001, is_error: false,
});

// Drive a turn that leaves a text block open mid-stream (nothing can fire yet).
async function busyMidTextBlock(opts) {
  const inst = await setupWorker(opts);
  const evs = collect(inst);
  inst.prompt('open text');
  await waitFor(() => evs.some(e => e.kind === 'text_delta'));
  assert.equal(inst.status, 'turn');
  return { inst, evs };
}

const send = (inst, text, extra = {}) =>
  sendPrompt({ sessionId: inst.sessionId, text, subscribe: false, ...extra }, { instances });

// ── the send_prompt fallback ────────────────────────────────────────────────

test('flagged + busy: nothing is written at call time; one stop at the block edge, then one steer', async () => {
  const { inst } = await busyMidTextBlock();
  await send(inst, 'STEER ME');

  assert.equal(inst.steerPending, true, 'parked, not sent');
  assert.equal(inst._interruptFired, false, 'mid-block ⇒ the stop has not fired');
  let lines = await stdinLines();
  assert.equal(interruptsIn(lines).length, 0);
  assert.equal(userLinesIn(lines).length, 1, 'only the original prompt has reached the CLI');
  assert.ok(!JSON.stringify(lines).includes('STEER ME'), 'the steer text was NOT injected mid-turn');

  // Block edge → the armed stop fires; the CLI's turn_end then flushes the steer.
  inject(inst, blockStop(0));
  assert.equal(inst._interruptFired, true, 'the stop fired at the boundary');
  inject(inst, turnEnd());
  await waitFor(async () => (await stdinLines()).filter(l => l.type === 'user').length === 2);

  lines = await stdinLines();
  assert.equal(interruptsIn(lines).length, 1, 'exactly one interrupt control_request');
  const users = userLinesIn(lines);
  assert.equal(users.length, 2, 'the original prompt, then the steer — nothing else');
  assert.deepEqual(textsOf(users[1]), [POST_STOP_STEER_NOTE, 'STEER ME'],
    'the note rides as its OWN leading block, then the verbatim text');
  assert.equal(inst.steerPending, false);
});

test('unflagged + busy is byte-identical to today: a live injection, no stop', async () => {
  const { inst } = await busyMidTextBlock({ flagged: false });
  await send(inst, 'STEER ME');

  await waitFor(async () => (await stdinLines()).filter(l => l.type === 'user').length === 2);
  const lines = await stdinLines();
  assert.equal(interruptsIn(lines).length, 0, 'no interrupt is ever armed for a steerable model');
  const users = userLinesIn(lines);
  assert.equal(users.length, 2);
  assert.deepEqual(textsOf(users[1]), [MID_TURN_NOTE, 'STEER ME'], 'the ordinary mid-turn note');
  assert.equal(inst.steerPending, false, 'nothing was ever queued');
  assert.equal(inst.status, 'turn', 'the same turn is still running');
});

test('flagged + IDLE: an ordinary prompt, no stop and no post-stop note', async () => {
  const inst = await setupWorker();
  await send(inst, 'PLAIN');
  await waitFor(async () => (await stdinLines()).filter(l => l.type === 'user').length === 1);
  const lines = await stdinLines();
  assert.equal(interruptsIn(lines).length, 0, 'interrupt() no-ops off-turn — nothing to stop');
  assert.deepEqual(textsOf(userLinesIn(lines)[0]), ['PLAIN'], 'no note at all on an idle send');
});

test('coalescing: three steers before the edge → ONE stop, ONE message, original order', async () => {
  const { inst } = await busyMidTextBlock();
  await send(inst, 'one');
  await send(inst, 'two');
  await send(inst, 'three');

  inject(inst, blockStop(0));
  inject(inst, turnEnd());
  await waitFor(async () => (await stdinLines()).filter(l => l.type === 'user').length === 2);

  const lines = await stdinLines();
  assert.equal(interruptsIn(lines).length, 1, 'interrupt() is idempotent while armed');
  const users = userLinesIn(lines);
  assert.equal(users.length, 2, 'one joined delivery, not three');
  assert.deepEqual(textsOf(users[1]), [POST_STOP_STEER_NOTE, 'one\n\ntwo\n\nthree']);
});

test('the turn ends on its own before the boundary: no stop is ever sent, the steer lands once', async () => {
  const { inst } = await busyMidTextBlock();
  await send(inst, 'RACER');
  assert.equal(inst.steerPending, true);

  // Natural end while armed: _setStatus clears the arm BEFORE turn_end is
  // emitted, so nothing reaches the CLI — and the same trigger delivers.
  inject(inst, turnEnd());
  await waitFor(async () => (await stdinLines()).filter(l => l.type === 'user').length === 2);

  const lines = await stdinLines();
  assert.equal(interruptsIn(lines).length, 0, 'no control_request ever left the orchestrator');
  const users = userLinesIn(lines);
  assert.equal(users.length, 2, 'delivered exactly once');
  assert.deepEqual(textsOf(users[1]), [POST_STOP_STEER_NOTE, 'RACER']);
});

test('the process dies with a steer queued: the promise rejects, it is annotated, nothing stays pending', async () => {
  const { inst, evs } = await busyMidTextBlock();
  // Raced against a short deadline: "the waiter is never settled at all" is the
  // exact failure this pins, and it must show up as a fast assertion rather than
  // a hung test.
  const settled = Promise.race([
    inst.queueSteerAfterStop('LOST').then(() => new Error('resolved instead of rejecting'), e => e),
    new Promise(r => setTimeout(() => r('never settled'), 500)),
  ]);
  assert.equal(inst.steerPending, true);

  inst._setStatus('exited');
  const rejected = await settled;

  assert.ok(rejected instanceof Error, `the caller is told, not left hanging (got: ${rejected})`);
  assert.match(rejected.message, /exited/);
  assert.equal(inst.steerPending, false, 'a dead instance must not stay steerPending');
  assert.ok(evs.some(e => e.kind === 'system' && e.subtype === 'stderr'
    && /deferred steer delivery failed/.test(e.data?.line ?? '')), 'annotated into the transcript');
  assert.ok(evs.some(e => e.kind === 'system' && e.subtype === 'steer_settled'),
    'the hub is told no turn_end is coming');
});

// Capture unhandled rejections for the duration of one test. Installing a
// listener also suppresses the default crash, so the assertion is on the
// captured list rather than on the runner surviving.
function captureUnhandled() {
  const seen = [];
  const onUnhandled = (err) => seen.push(err);
  process.on('unhandledRejection', onUnhandled);
  cleanupListeners.push(() => process.off('unhandledRejection', onUnhandled));
  return seen;
}
// Unhandled rejections are reported a tick after the microtask queue drains.
const settleUnhandled = () => new Promise(r => setTimeout(r, 60));

test('a steer whose delivery FAILS is annotated, rejects its caller, and settles the queue', async () => {
  const { inst, evs } = await busyMidTextBlock();
  const unhandled = captureUnhandled();
  const call = inst.queueSteerAfterStop('DOOMED');
  await waitFor(() => inst.steerPending, { timeout: 2_000 });
  inst._mutating = true;
  inject(inst, turnEnd());                       // natural end → flush → prompt() refuses

  await assert.rejects(() => call, /being rewritten/);
  assert.equal(inst.steerPending, false, 'the queue was drained by the failed flush');
  assert.ok(evs.some(e => e.kind === 'system' && e.subtype === 'stderr'
    && /deferred steer delivery failed/.test(e.data?.line ?? '')), 'annotated into the transcript');
  assert.ok(evs.some(e => e.kind === 'system' && e.subtype === 'steer_settled'));
  await settleUnhandled();
  assert.deepEqual(unhandled.map(e => e.message), []);
  inst._mutating = false;
});

// ── the replay invariant the note must not break ────────────────────────────
//
// POST_STOP_STEER_NOTE rides as its own content block and is dropped on replay
// by isMidTurnNoteContent. If it stopped matching, the note would render as a
// real user bubble AND shift the user-message index every rewind/fork
// truncation counts by (docs/architecture.md → prefix-safety invariant).

test('POST_STOP_STEER_NOTE carries all three isMidTurnNoteContent signals', () => {
  assert.notEqual(POST_STOP_STEER_NOTE, MID_TURN_NOTE, 'it says more than the plain note');
  assert.ok(POST_STOP_STEER_NOTE.includes(
    'Your turn was STOPPED at a block boundary'), 'it says the turn was cut off');
  assert.ok(POST_STOP_STEER_NOTE.startsWith('<system-reminder>'));
  assert.ok(POST_STOP_STEER_NOTE.includes('mid-turn'));
  assert.ok(POST_STOP_STEER_NOTE.trimEnd().endsWith('</system-reminder>'));
  assert.equal(isMidTurnNoteContent(POST_STOP_STEER_NOTE), true);
});

test('on replay the post-stop note is dropped: no user bubble of its own, no index shift', () => {
  const content = [{ type: 'text', text: POST_STOP_STEER_NOTE }, { type: 'text', text: 'STEER ME' }];
  const evs = consolidateUserContent(content);
  const echoes = evs.filter(e => e.kind === 'user_echo');
  assert.equal(echoes.length, 1, 'exactly ONE user bubble — the note is not a second one');
  assert.equal(echoes[0].text, 'STEER ME', 'and it is the sender\'s text, unprefixed');
});
