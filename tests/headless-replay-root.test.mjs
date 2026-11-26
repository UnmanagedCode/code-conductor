// watchReplayRoot (src/headless/replayRoot.ts) on a fake manager: a replay that
// can launch answers the resumed root's tool asks with the headless policy —
// only the chosen session's live instance, a fresh answerer per instance (a
// re-resume), never a worker's — until detached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { watchReplayRoot } from '../src/headless/replayRoot.ts';
import { HEADLESS_QUESTION_ANSWER } from '../src/headless/fragment.ts';

const SID = 'root-sid';
function fakeInstance(id, sessionId) {
  const sent = [];
  return { id, sessionId, mode: 'code', sent, promptOrQueueSteer: async (text) => { sent.push(text); }, setMode: async () => {} };
}
function fakeManager() {
  const m = new EventEmitter();
  m.live = new Map();
  m.liveForSession = (sid) => m.live.get(sid) ?? null;
  return m;
}
const question = (inst, liveAsks) => ({ id: inst.id, sessionId: inst.sessionId, awaitingUser: 'question', awaitingUserSource: 'tool', liveAsks });
const settle = () => new Promise((r) => setImmediate(r));

// Invariant: the chosen session's live instance gets HEADLESS_QUESTION_ANSWER
// for its tool question, once per ask.
test('the resumed root\'s tool question gets the headless answer', async () => {
  const m = fakeManager();
  const root = fakeInstance('i1', SID);
  m.live.set(SID, root);
  watchReplayRoot({ instances: m, sessionId: SID, log: () => {} });
  m.emit('status', question(root, 1));
  m.emit('status', question(root, 1));
  await settle();
  assert.deepEqual(root.sent, [HEADLESS_QUESTION_ANSWER]);
});

// Invariant: a re-resume is a new instance of the session and gets its own
// answerer, so its first ask (liveAsks counting from 1 again) is answered.
test('a second instance of the session is answered with a fresh counter', async () => {
  const m = fakeManager();
  const first = fakeInstance('i1', SID);
  m.live.set(SID, first);
  watchReplayRoot({ instances: m, sessionId: SID, log: () => {} });
  m.emit('status', question(first, 1));
  await settle();
  const second = fakeInstance('i2', SID);
  m.live.set(SID, second);
  m.emit('status', question(second, 1));
  await settle();
  assert.deepEqual(first.sent, [HEADLESS_QUESTION_ANSWER]);
  assert.deepEqual(second.sent, [HEADLESS_QUESTION_ANSWER]);
});

// Invariant: an ask from another session (a worker), or a summary whose
// instance is not the session's live one, is never answered.
test('a worker\'s ask and a stale instance\'s summary are ignored', async () => {
  const m = fakeManager();
  const root = fakeInstance('i1', SID);
  const worker = fakeInstance('w1', 'worker-sid');
  const stale = fakeInstance('old', SID);
  m.live.set(SID, root);
  m.live.set('worker-sid', worker);
  watchReplayRoot({ instances: m, sessionId: SID, log: () => {} });
  m.emit('status', question(worker, 1));
  m.emit('status', question(stale, 1));
  await settle();
  assert.deepEqual(worker.sent, []);
  assert.deepEqual(stale.sent, []);
  assert.deepEqual(root.sent, []);
});

// Invariant: a failed answer is logged with the headless prefix.
test('a failed answer is logged', async () => {
  const m = fakeManager();
  const root = { ...fakeInstance('i1', SID), promptOrQueueSteer: async () => { throw new Error('closed'); } };
  m.live.set(SID, root);
  const lines = [];
  watchReplayRoot({ instances: m, sessionId: SID, log: (l) => lines.push(l) });
  m.emit('status', question(root, 1));
  await settle(); await settle();
  assert.deepEqual(lines, ['headless: answering the root conductor failed: closed']);
});

// Invariant: detach removes the listener; no ask is answered after it.
test('detach stops it', async () => {
  const m = fakeManager();
  const root = fakeInstance('i1', SID);
  m.live.set(SID, root);
  const w = watchReplayRoot({ instances: m, sessionId: SID, log: () => {} });
  w.detach();
  assert.equal(m.listenerCount('status'), 0);
  m.emit('status', question(root, 1));
  await settle();
  assert.deepEqual(root.sent, []);
});
