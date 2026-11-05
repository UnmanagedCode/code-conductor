// Nudge-chain turn origin on Instance (src/instances.ts `_turnNudgeChain`): the
// idle-renewal nudge turn, and the `/clear` + reseed of a renewal it caused,
// bump no attention counter while awaitingUser state is still tracked; every
// other turn counts, however it interleaves with a chain. A bare Instance with
// a stub proc, driven through prompt()/clearContext() and _handleStdoutLine.
// The unread (turn-mark) half is pinned end to end in idle-renew-nudge.test.mjs,
// where the session has a store record. Also the per-instance overage fact the
// nudge's overage skip reads (`overageReportedNow`), derived from live
// rate_limit_events.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Instance } from '../src/instances.ts';
import { buildIdleRenewNudge } from '../shared/idleRenewNudge.ts';
import { buildRenewSeed } from '../shared/renewSeed.ts';

function makeInstance() {
  const inst = new Instance({
    id: 'i-nudge', project: '.conduct', cwd: '/nonexistent-cwd',
    mode: 'bypassPermissions', effort: 'high', thinking: 'adaptive', model: null,
  });
  inst.proc = {
    stdin: { writable: true, write() {} },
    stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {},
  };
  inst.status = 'idle';
  return inst;
}

const line = (obj) => JSON.stringify(obj);
let msgN = 0;
const msgStart = () => line({
  type: 'stream_event',
  event: { type: 'message_start', message: { id: `m${++msgN}`, role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 0 } } },
});
const textBlock = (text) => [
  line({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }),
  line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } }),
  line({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
];
const result = ({ isError = false } = {}) => line({
  type: 'result', subtype: isError ? 'error_during_execution' : 'success', stop_reason: 'end_turn',
  duration_ms: 1, total_cost_usd: 0, is_error: isError,
});
const feed = (inst, ...lines) => { for (const l of lines.flat()) inst._handleStdoutLine(l); };
const endTurn = (inst, text = 'ok.', opts) => feed(inst, msgStart(), textBlock(text), result(opts));

const nudge = (inst) => inst.prompt(buildIdleRenewNudge(55), [], { internal: true, annotateIfMidTurn: false, idleNudge: true });
const seed = (inst) => inst.prompt(buildRenewSeed({ summary: '## User context\nre-ask the open question', stateBlock: 'state' }), [], { internal: true });
const counters = (inst) => {
  const s = inst.summary();
  return { liveTurnEnds: s.liveTurnEnds, lastTurnError: s.lastTurnError, liveAsks: s.liveAsks };
};
const QUIET = { liveTurnEnds: 0, lastTurnError: false, liveAsks: 0 };
const reAsk = (inst) => inst._emitUi({ kind: 'user_question', toolUseId: 'tu-reask', parentToolUseId: null });

// The whole nudge-driven renewal: nudge turn (arms the renewal), `/clear`,
// reseed (which re-asks). `onEnd` runs after each of the three turn ends.
async function nudgeRenewChain(inst, onEnd = () => {}) {
  inst.beginRenewal(); // what renew_session's arm() does mid-turn
  await nudge(inst);
  endTurn(inst);
  onEnd('nudge');
  inst.clearContext();
  feed(inst, result());
  onEnd('/clear');
  await seed(inst);
  reAsk(inst);
  endTurn(inst, 'Which option?');
  onEnd('reseed');
  inst.endRenewal();
}

// INVARIANT: a nudge turn's end moves no attention counter, but does move lastResponseAt.
test('a nudge turn end leaves liveTurnEnds and lastTurnError untouched; lastResponseAt moves', async () => {
  const inst = makeInstance();
  await nudge(inst);
  endTurn(inst, 'nothing to renew.', { isError: true });
  assert.deepEqual(counters(inst), QUIET);
  assert.equal(inst.lastTurnEndWasNudgeChain, true);
  assert.notEqual(inst.summary().lastResponseAt, null);
});

// INVARIANT: a real message steered into a nudge turn makes that turn count.
test('a user prompt steered into a nudge turn makes it count', async () => {
  const inst = makeInstance();
  await nudge(inst);
  await inst.prompt('actually, run the tests');
  endTurn(inst);
  assert.equal(inst.summary().liveTurnEnds, 1);
  assert.equal(inst.lastTurnEndWasNudgeChain, false);
});

// INVARIANT: a CLI-initiated turn (message_start from idle) after a chain counts.
test('a CLI-initiated turn right after a nudge counts', async () => {
  const inst = makeInstance();
  await nudge(inst);
  endTurn(inst);
  endTurn(inst); // message_start flips idle → turn: a ScheduleWakeup / task re-invocation
  assert.equal(inst.summary().liveTurnEnds, 1);
  assert.equal(inst.lastTurnEndWasNudgeChain, false);
});

// INVARIANT: a real prompt between a nudge-driven `/clear` and its reseed breaks
// the latch, so the reseed counts.
test('a real prompt before the reseed breaks the chain', async () => {
  const inst = makeInstance();
  inst.beginRenewal();
  await nudge(inst);
  endTurn(inst);
  inst.clearContext();
  feed(inst, result());
  assert.deepEqual(counters(inst), QUIET, 'premise: nudge and /clear were silent');
  await inst.prompt('are you there?');
  endTurn(inst);
  await seed(inst);
  endTurn(inst);
  inst.endRenewal();
  assert.equal(inst.summary().liveTurnEnds, 2, 'both the real turn and the reseed count');
});

// INVARIANT: a renewal armed from a REAL turn is not a chain: its `/clear` and reseed count.
test('a self-renewal from a real turn is not a chain', async () => {
  const inst = makeInstance();
  await inst.prompt('wrap up and renew');
  inst.beginRenewal();
  endTurn(inst);
  inst.clearContext();
  feed(inst, result());
  await seed(inst);
  endTurn(inst);
  inst.endRenewal();
  assert.equal(inst.summary().liveTurnEnds, 3);
});

// INVARIANT: every turn of a nudge-driven renewal (nudge, /clear, reseed with a
// re-ask) is silent, and endRenewal() releases the latch so the next reseed is real.
test('a nudge-driven renewal chain is silent end to end; endRenewal resets the latch', async () => {
  const inst = makeInstance();
  const seen = [];
  await nudgeRenewChain(inst, (stage) => seen.push([stage, inst.lastTurnEndWasNudgeChain, counters(inst)]));
  assert.deepEqual(seen, [
    ['nudge', true, QUIET], ['/clear', true, QUIET], ['reseed', true, QUIET],
  ]);
  await seed(inst);
  endTurn(inst);
  assert.equal(inst.summary().liveTurnEnds, 1, 'a reseed after endRenewal is real');
});

// INVARIANT (the pinned requirement): a conductor waiting on a tool ask still
// presents as waiting after a nudge-driven renewal and re-ask, with liveAsks
// unmoved; a real answer then clears it.
test('an open tool ask survives a nudge-driven renewal and re-ask; a real answer clears it', async () => {
  const inst = makeInstance();
  inst._setAwaitingUser({ kind: 'question', source: 'tool' });
  inst.liveAsks = 1;
  await nudgeRenewChain(inst);
  const s = inst.summary();
  assert.deepEqual([s.awaitingUser, s.awaitingUserSource, s.liveAsks], ['question', 'tool', 1]);
  await inst.prompt('Option A');
  assert.equal(inst.summary().awaitingUser, null);
});

// INVARIANT: a chain turn ending in a text ask still sets awaitingUser (state is
// never suppressed) but bumps no liveAsks; the same ask on a real turn does.
test('a chain turn that ends asking sets awaitingUser without bumping liveAsks', async () => {
  const chain = makeInstance();
  await nudge(chain);
  endTurn(chain, 'Should I renew now?');
  assert.deepEqual([chain.summary().awaitingUser, chain.summary().liveAsks], ['question', 0]);

  const real = makeInstance();
  await real.prompt('status?');
  endTurn(real, 'Should I renew now?');
  assert.deepEqual([real.summary().awaitingUser, real.summary().liveAsks], ['question', 1]);
});

// ── the overage fact (`overageReportedNow`) ─────────────────────────────────

const rateLimit = (info) => line({ type: 'system', subtype: 'rate_limit_event', uuid: `rl-${++msgN}`, rate_limit_info: info });
const overageInfo = (resetsAt) => ({ status: 'rejected', rateLimitType: 'five_hour', overageStatus: 'allowed', isUsingOverage: true, resetsAt });

// INVARIANT: an overage rate_limit_event holds the fact until its reset, a
// non-overage event clears it, and one naming no reset holds it indefinitely.
test('overageReportedNow follows the live rate_limit_events', () => {
  const inst = makeInstance();
  const resetSecs = 1_900_000_000;
  const resetMs = resetSecs * 1000;
  assert.equal(inst.overageReportedNow(resetMs - 1), false, 'premise: no event, no overage');

  feed(inst, rateLimit(overageInfo(resetSecs)));
  assert.equal(inst.overageReportedNow(resetMs - 1), true, 'before the reset');
  assert.equal(inst.overageReportedNow(resetMs), false, 'at the reset');
  assert.equal(inst.overageReportedNow(resetMs + 60_000), false, 'after the reset');

  feed(inst, rateLimit({ status: 'allowed', rateLimitType: 'five_hour', isUsingOverage: false, resetsAt: resetSecs }));
  assert.equal(inst.overageReportedNow(resetMs - 1), false, 'a non-overage event clears it');

  feed(inst, rateLimit(overageInfo(undefined)));
  assert.equal(inst.overageReportedNow(Number.MAX_SAFE_INTEGER), true, 'no reset named: holds indefinitely');
});
