// approve_plan / reject_plan / answer_question into a worker whose model cannot
// take a mid-turn injection (card 2026-0183 Part C).
//
// Each handler used to call inst.prompt() unconditionally, so on such a model its
// text was written into the running turn and silently swallowed. They now route
// through Instance.promptOrQueueSteer: arm the SOFT block-edge stop, deliver the
// same text as a fresh turn carrying POST_STOP_STEER_NOTE, and report
// `deferred:true`. Proven by reading the fake CLI's stdin capture
// (FAKE_CLAUDE_TRANSCRIPT) — the only view of what actually reached the CLI —
// with boundary events driven synthetically via inst._handleStdoutLine(), so
// nothing depends on subprocess timing. Harness copied from
// tests/deferred-steer.test.mjs.
//
// ONE TEST PER HANDLER, deliberately: a shared parameterised body over a handler
// table still passes for the other two when a reviewer reverts exactly one of
// them to prompt(), so that mutant would survive.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { MID_TURN_NOTE, POST_STOP_STEER_NOTE } from '../src/instances.ts';
import { approvePlan, rejectPlan, answerQuestion } from '../src/mcp/handlers.ts';
import { buildApprovePrompt, buildRejectPrompt } from '../src/planApproval.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-deferred-steer-sites.json');
// The curated preset that declares midTurnSteering:false.
const FLAGGED_MODEL = 'deepseek-v4-flash:0731-cloud';
const ANSWER_TEXT = 'Answer to "Pick a fruit": Apple';

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
const textsOf = (line) => line.message.content.filter(b => b.type === 'text').map(b => b.text);

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

// Mid-turn with a text block left open — nothing can fire at a block edge yet.
async function busyMidTextBlock(opts) {
  const inst = await setupWorker(opts);
  const evs = collect(inst);
  inst.prompt('open text');
  await waitFor(() => evs.some(e => e.kind === 'text_delta'));
  assert.equal(inst.status, 'turn');
  return inst;
}

// Mid-turn AND holding a pending AskUserQuestion: the fixture emits the question
// plus its deny tool_result, then opens a fresh text block and stops. This is the
// state answer_question's own comment describes — the deny ends the turn only if
// the CLI has nothing queued behind it.
async function busyWithPendingQuestion(opts) {
  const inst = await setupWorker(opts);
  const evs = collect(inst);
  inst.prompt('question then open');
  await waitFor(() => evs.some(e => e.kind === 'user_question'));
  await waitFor(() => evs.some(e => e.kind === 'text_delta'));
  assert.equal(inst.status, 'turn', 'the question did NOT end the turn');
  return inst;
}

// Every deferred assertion in one place, so each per-handler test states only
// which handler and which text. The negative ("not on stdin yet") is always
// paired with the positive delivery it implies — a mutant that drops the message
// outright satisfies the negative alone.
async function assertDeferredThenDelivered(inst, text, label) {
  // The stdin negative FIRST: it is the invariant that actually matters, and
  // ordering it ahead of the flags is what makes the revert-the-fix proof land on
  // it rather than on a weaker symptom.
  let lines = await stdinLines();
  // Compared against the PARSED text blocks, not the raw JSON: a handler text
  // containing a quote (answer_question's does) is escaped on the wire, so a
  // substring test against the raw line would pass vacuously.
  assert.ok(!userLinesIn(lines).some(l => textsOf(l).some(t => t.includes(text))),
    `${label}: the text was NOT injected into the running turn`);
  assert.equal(userLinesIn(lines).length, 1, `${label}: only the original prompt reached the CLI`);
  assert.equal(interruptsIn(lines).length, 0, `${label}: no interrupt yet`);
  assert.equal(inst.steerPending, true, `${label}: parked, not sent`);
  assert.equal(inst._interruptFired, false, `${label}: mid-block ⇒ the stop has not fired`);

  inject(inst, blockStop(0));
  assert.equal(inst._interruptFired, true, `${label}: the stop fired at the boundary`);
  inject(inst, turnEnd());
  await waitFor(async () => userLinesIn(await stdinLines()).length === 2);

  lines = await stdinLines();
  assert.equal(interruptsIn(lines).length, 1, `${label}: exactly one interrupt control_request`);
  const users = userLinesIn(lines);
  assert.deepEqual(textsOf(users[1]), [POST_STOP_STEER_NOTE, text],
    `${label}: the note rides as its OWN leading block, then the verbatim text`);
  assert.equal(inst.steerPending, false, `${label}: the queue drained`);
}

// ── C-T1/2/3 (REGRESSION): one per handler ─────────────────────────────────
// Invariant: called against a flagged mid-turn worker, the handler writes nothing
// at call time, arms exactly one block-edge stop, reports `deferred:true`, and
// delivers its own text as a fresh turn whose blocks are exactly
// [POST_STOP_STEER_NOTE, <that handler's text>].

test('C-T1 approve_plan: flagged + mid-turn defers to a post-stop turn', async () => {
  const inst = await busyMidTextBlock();
  const text = buildApprovePrompt(undefined);
  const res = await approvePlan({ sessionId: inst.sessionId, subscribe: false }, { instances });
  await assertDeferredThenDelivered(inst, text, 'approve_plan');
  assert.equal(res.deferred, true, 'approve_plan reports the deferral');
  assert.equal(res.sentText, text, 'sentText is still exactly what will be sent');
});

test('C-T2 reject_plan: flagged + mid-turn defers to a post-stop turn', async () => {
  const inst = await busyMidTextBlock();
  const text = buildRejectPrompt('tighten the migration step');
  const res = await rejectPlan(
    { sessionId: inst.sessionId, feedback: 'tighten the migration step', subscribe: false },
    { instances });
  await assertDeferredThenDelivered(inst, text, 'reject_plan');
  assert.equal(res.deferred, true, 'reject_plan reports the deferral');
  assert.equal(res.sentText, text);
});

test('C-T3 answer_question: flagged + mid-turn defers to a post-stop turn', async () => {
  const inst = await busyWithPendingQuestion();
  const res = await answerQuestion(
    { sessionId: inst.sessionId, answers: [{ option: 'Apple' }], subscribe: false },
    { instances });
  await assertDeferredThenDelivered(inst, ANSWER_TEXT, 'answer_question');
  assert.equal(res.deferred, true, 'answer_question reports the deferral');
  assert.equal(res.sentText, ANSWER_TEXT);
});

// ── C-T4 (PIN) ─────────────────────────────────────────────────────────────
// Invariant: on an UNFLAGGED mid-turn worker all three handlers are byte-identical
// to before this card — one live `user` line whose blocks are exactly
// [MID_TURN_NOTE, text], zero control_request, and the worker still in 'turn'.

test('C-T4 unflagged + mid-turn is byte-identical for all three handlers', async () => {
  const cases = [
    ['approve_plan', busyMidTextBlock, buildApprovePrompt(undefined),
      (inst) => approvePlan({ sessionId: inst.sessionId, subscribe: false }, { instances })],
    ['reject_plan', busyMidTextBlock, buildRejectPrompt('revise'),
      (inst) => rejectPlan({ sessionId: inst.sessionId, feedback: 'revise', subscribe: false }, { instances })],
    ['answer_question', busyWithPendingQuestion, ANSWER_TEXT,
      (inst) => answerQuestion({ sessionId: inst.sessionId, answers: [{ option: 'Apple' }], subscribe: false }, { instances })],
  ];
  for (const [label, setup, text, call] of cases) {
    const inst = await setup({ flagged: false });
    const before = userLinesIn(await stdinLines()).length;
    const res = await call(inst);
    assert.equal(res.deferred, undefined, `${label}: no deferred field on a live send`);
    await waitFor(async () => userLinesIn(await stdinLines()).length === before + 1);
    const lines = await stdinLines();
    assert.equal(interruptsIn(lines).length, 0, `${label}: a live injection arms NO stop`);
    const users = userLinesIn(lines);
    assert.deepEqual(textsOf(users[users.length - 1]), [MID_TURN_NOTE, text],
      `${label}: the ordinary mid-turn annotation, unchanged`);
    assert.equal(inst.status, 'turn', `${label}: the turn was not stopped`);
    assert.equal(inst.steerPending, false, `${label}: nothing was parked`);
  }
});

// ── C-T5 (PIN) ─────────────────────────────────────────────────────────────
// Invariant: the one-shot idle subscription these handlers arm survives the
// STOP's own turn_end (IdleSubscriptionHub._onTurnEnd defers while steerPending)
// and is consumed only by the steered turn's turn_end.

test('C-T5 the armed idle subscription survives the stop and fires on the steered turn', async () => {
  const caller = await setupWorker({ flagged: false });
  const target = await busyMidTextBlock();

  const res = await approvePlan(
    { sessionId: target.sessionId, subscribe: true }, { instances, callerId: caller.sessionId });
  assert.equal(res.deferred, true);
  assert.equal(res.subscribed, true, 'the handler armed the one-shot');
  assert.equal(instances._idleHub.hasSubscriber(target.id), true);

  // The stop's own turn_end must NOT consume it — the worker was cut off to
  // deliver the message, it did not finish.
  inject(target, blockStop(0));
  inject(target, turnEnd());
  assert.equal(instances._idleHub.hasSubscriber(target.id), true,
    'the stop\'s turn_end deferred rather than consuming the one-shot');

  // The steered turn's turn_end is the one that spends it. That turn is real —
  // the fixture answers a POST_STOP_STEER_NOTE-carrying prompt with a complete
  // turn — so nothing here is injected synthetically.
  await waitFor(() => target.steerPending === false);
  await waitFor(() => instances._idleHub.hasSubscriber(target.id) === false);
});

// ── C-T6 (PIN) ─────────────────────────────────────────────────────────────
// Invariant: a flagged worker that is IDLE gets an ordinary prompt — no stop, no
// deferred field, and NO POST_STOP_STEER_NOTE (the status half of
// needsPostStopSteer is load-bearing, not just the flag).

test('C-T6 flagged but IDLE takes the ordinary prompt path', async () => {
  const inst = await setupWorker({ flagged: true });
  assert.equal(inst.status, 'idle');
  const text = buildApprovePrompt(undefined);

  const res = await approvePlan({ sessionId: inst.sessionId, subscribe: false }, { instances });
  assert.equal(res.deferred, undefined, 'an idle send is not deferred');
  assert.equal(inst.steerPending, false, 'nothing was parked');

  await waitFor(async () => userLinesIn(await stdinLines()).length === 1);
  const lines = await stdinLines();
  assert.equal(interruptsIn(lines).length, 0, 'an idle send arms no stop');
  assert.deepEqual(textsOf(userLinesIn(lines)[0]), [text],
    'a single verbatim block — neither MID_TURN_NOTE nor POST_STOP_STEER_NOTE');
});
