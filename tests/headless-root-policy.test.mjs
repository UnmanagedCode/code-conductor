// The root's no-person policy (src/headless/rootPolicy.ts), on a fake root:
// rootAskAnswerer answers each tool ask once (a question with
// HEADLESS_QUESTION_ANSWER, a plan by leaving plan mode then the approve
// prompt), ignores non-tool asks, and names its failures through onError;
// forceInterrupt never waits past its bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rootAskAnswerer, forceInterrupt, INTERRUPT_WAIT_MS } from '../src/headless/rootPolicy.ts';
import { HEADLESS_QUESTION_ANSWER } from '../src/headless/fragment.ts';
import { buildApprovePrompt } from '../shared/planApproval.ts';

function fakeRoot(over = {}) {
  const calls = [];
  const root = {
    id: 'root', mode: 'code',
    promptOrQueueSteer: async (text, atts, opts) => { calls.push(['prompt', text, opts]); },
    setMode: async (m) => { calls.push(['mode', m]); root.mode = m; },
    interrupt: async (opts) => { calls.push(['interrupt', opts]); },
    ...over,
  };
  return { root, calls };
}
const settle = () => new Promise((r) => setImmediate(r));
const ask = (awaitingUser, liveAsks, awaitingUserSource = 'tool') => ({ id: 'root', awaitingUser, awaitingUserSource, liveAsks });

// Invariant: a tool question is answered with HEADLESS_QUESTION_ANSWER, authored
// human, exactly once per ask — a repeated summary with the same liveAsks count
// sends nothing, a higher count sends again.
test('a tool question is answered once per ask', async () => {
  const { root, calls } = fakeRoot();
  const answer = rootAskAnswerer(root, () => assert.fail('no error expected'));
  answer(ask('question', 1));
  answer(ask('question', 1));
  await settle();
  assert.deepEqual(calls, [['prompt', HEADLESS_QUESTION_ANSWER, { author: 'human' }]]);
  answer(ask('question', 2));
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1], HEADLESS_QUESTION_ANSWER);
});

// Invariant: a plan on a root in plan mode is approved as the UI's Approve does:
// setMode('bypassPermissions') first, then the approve prompt; out of plan mode
// no mode switch is made.
test('a tool plan in plan mode leaves plan mode, then sends the approve prompt', async () => {
  const { root, calls } = fakeRoot({ mode: 'plan' });
  rootAskAnswerer(root, () => assert.fail('no error expected'))(ask('plan', 1));
  await settle(); await settle();
  assert.deepEqual(calls, [['mode', 'bypassPermissions'], ['prompt', buildApprovePrompt(undefined), { author: 'human' }]]);
  const other = fakeRoot({ mode: 'code' });
  rootAskAnswerer(other.root, () => assert.fail('no error expected'))(ask('plan', 1));
  await settle(); await settle();
  assert.deepEqual(other.calls, [['prompt', buildApprovePrompt(undefined), { author: 'human' }]]);
});

// Invariant: an ask that is not a tool ask (awaitingUserSource other than
// 'tool') is never answered, and does not consume the count.
test('a non-tool ask is ignored', async () => {
  const { root, calls } = fakeRoot();
  const answer = rootAskAnswerer(root, () => {});
  answer(ask('question', 1, 'text'));
  answer(ask('question', 1, null));
  await settle();
  assert.deepEqual(calls, []);
  answer(ask('question', 1));
  await settle();
  assert.equal(calls.length, 1, 'the tool ask at the same count is still answered');
});

// Invariant: a failed answer send and a failed plan-mode switch reach onError
// with their exact messages; a failed switch sends no approve prompt.
test('failures go to onError with their exact text', async () => {
  const errors = [];
  const sendFails = fakeRoot({ promptOrQueueSteer: async () => { throw new Error('socket gone'); } });
  rootAskAnswerer(sendFails.root, (m) => errors.push(m))(ask('question', 1));
  await settle(); await settle();
  assert.deepEqual(errors, ['answering the root conductor failed: socket gone']);
  errors.length = 0;
  const modeFails = fakeRoot({ mode: 'plan', setMode: async () => { throw new Error('no mode'); } });
  rootAskAnswerer(modeFails.root, (m) => errors.push(m))(ask('plan', 1));
  await settle(); await settle();
  assert.deepEqual(errors, ["approving the root conductor's plan failed: no mode"]);
  assert.deepEqual(modeFails.calls, []);
});

// Invariant: forceInterrupt asks for a forced interrupt and resolves at the
// injected bound when the interrupt never settles; a rejecting interrupt
// resolves it too (it never rejects).
test('forceInterrupt resolves at its bound, and never rejects', async () => {
  const { root, calls } = fakeRoot({ interrupt: (opts) => { calls.push(['interrupt', opts]); return new Promise(() => {}); } });
  const t0 = Date.now();
  await forceInterrupt(root, 30);
  assert.ok(Date.now() - t0 < INTERRUPT_WAIT_MS, 'bounded by the injected wait, not the default');
  assert.deepEqual(calls, [['interrupt', { force: true }]]);
  const rejecting = fakeRoot({ interrupt: async () => { throw new Error('dead'); } });
  await forceInterrupt(rejecting.root, 60_000);
});
