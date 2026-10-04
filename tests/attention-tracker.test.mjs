// The attention tracker (public/attention.js): which successive /api/instances
// lists make a top-level session ENTER the needs-you strip's Waiting or
// Finished group. Pure; one invariant per test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { createAttentionTracker } = await import(pathToFileURL(path.resolve(__dirname, '..', 'public', 'attention.js')).href);

const hand = (sid, o = {}) => ({
  id: `i-${sid}`, project: 'p', sessionId: sid, status: 'idle', conducted: false, ownerSessionId: null,
  createdAt: 1000, liveAsks: 0, liveTurnEnds: 0, lastTurnError: false, awaitingUser: null, awaitingUserSource: null, ...o,
});
const cond = (sid, o = {}) => hand(sid, { project: '.conduct', ...o });
const worker = (sid, owner, o = {}) => hand(sid, { conducted: true, ownerSessionId: owner, ...o });
const kinds = (ts) => ts.map(t => `${t.kind}:${t.sessionId}`);

// A tracker that has already seen `first`, so its baselines are set.
function seen(first) {
  const t = createAttentionTracker();
  assert.deepEqual(t.observe(first), [], 'premise: first sight emits nothing');
  return t;
}

test('first sight never notifies, even for sessions already Waiting or Finished with live counters', () => {
  const t = createAttentionTracker();
  const out = t.observe([
    hand('W', { awaitingUser: 'question', awaitingUserSource: 'tool', liveAsks: 3, liveTurnEnds: 3 }),
    hand('F', { liveTurnEnds: 2 }),
    cond('C', { liveTurnEnds: 1 }),
  ]);
  assert.deepEqual(out, []);
});

test('running → finished after a counted turn end emits exactly one finished; re-observing emits nothing', () => {
  const t = seen([hand('A', { status: 'turn' })]);
  const done = [hand('A', { status: 'idle', liveTurnEnds: 1 })];
  assert.deepEqual(kinds(t.observe(done)), ['finished:A']);
  assert.deepEqual(t.observe(done), []);
});

test('finished carries the entry and the latest turn\'s error flag', () => {
  const t = seen([hand('A', { status: 'turn' })]);
  const [tr] = t.observe([hand('A', { liveTurnEnds: 1, lastTurnError: true })]);
  assert.equal(tr.isError, true);
  assert.equal(tr.instanceId, 'i-A');
  assert.equal(tr.entry.projectName, 'p');
});

test('a turn end while subagents run emits nothing; the settle into idle emits one finished', () => {
  const t = seen([hand('A', { status: 'turn' })]);
  assert.deepEqual(t.observe([hand('A', { status: 'idle', displayStatus: 'running', liveTurnEnds: 1 })]), []);
  assert.deepEqual(kinds(t.observe([hand('A', { status: 'idle', displayStatus: 'idle', liveTurnEnds: 1 })])), ['finished:A']);
});

test('a conductor with an armed wake emits nothing until the wake clears, then one finished', () => {
  const t = seen([cond('C', { status: 'turn' })]);
  assert.deepEqual(t.observe([cond('C', { awaitingWake: true, liveTurnEnds: 1 })]), []);
  assert.deepEqual(kinds(t.observe([cond('C', { awaitingWake: false, liveTurnEnds: 1 })])), ['finished:C']);
});

test('a conducted worker never notifies, whatever its counters do', () => {
  const t = seen([worker('W', 'C', { status: 'turn' }), cond('C', { status: 'turn' })]);
  const out = t.observe([
    worker('W', 'C', { liveTurnEnds: 2, liveAsks: 1, awaitingUser: 'question', awaitingUserSource: 'tool' }),
    cond('C', { status: 'turn' }),
  ]);
  assert.deepEqual(out, []);
});

test('a hand-spawned session notifies, temp and worktree ones included, and a running one is tracked', () => {
  const t = seen([
    hand('T', { status: 'turn', temp: true }),
    hand('G', { status: 'turn', worktree: { worktreeName: 'wt' } }),
  ]);
  const out = t.observe([
    hand('T', { temp: true, liveTurnEnds: 1 }),
    hand('G', { worktree: { worktreeName: 'wt' }, liveTurnEnds: 1 }),
  ]);
  assert.deepEqual(kinds(out).sort(), ['finished:G', 'finished:T']);
  assert.equal(out.find(x => x.sessionId === 'G').entry.worktreeName, 'wt');
});

test('a live ask emits waiting carrying its kind and source', () => {
  const t = seen([hand('Q', { status: 'turn' }), hand('P', { status: 'turn' })]);
  const out = t.observe([
    hand('Q', { liveAsks: 1, liveTurnEnds: 1, awaitingUser: 'question', awaitingUserSource: 'text' }),
    hand('P', { liveAsks: 1, liveTurnEnds: 1, awaitingUser: 'plan', awaitingUserSource: 'tool' }),
  ]);
  assert.deepEqual(out.map(x => [x.kind, x.sessionId, x.ask, x.source]),
    [['waiting', 'Q', 'question', 'text'], ['waiting', 'P', 'plan', 'tool']]);
});

test('a conductor on a worker that asks emits waiting', () => {
  const t = seen([cond('C', { status: 'idle', awaitingWake: true })]);
  const out = t.observe([cond('C', { awaitingWake: true, liveAsks: 1, awaitingUser: 'plan', awaitingUserSource: 'tool' })]);
  assert.deepEqual(kinds(out), ['waiting:C']);
});

test('an ask changing kind while still waiting does not notify again', () => {
  const t = seen([hand('A', { status: 'turn' })]);
  t.observe([hand('A', { liveAsks: 1, liveTurnEnds: 1, awaitingUser: 'question', awaitingUserSource: 'tool' })]);
  assert.deepEqual(t.observe([hand('A', { liveAsks: 1, liveTurnEnds: 1, awaitingUser: 'plan', awaitingUserSource: 'tool' })]), []);
});

test('the turn that asked is never announced again as finished; the next turn end is', () => {
  const t = seen([hand('A', { status: 'turn' })]);
  assert.deepEqual(kinds(t.observe([hand('A', { liveAsks: 1, liveTurnEnds: 1, awaitingUser: 'question', awaitingUserSource: 'tool' })])), ['waiting:A']);
  assert.deepEqual(t.observe([hand('A', { liveAsks: 1, liveTurnEnds: 1 })]), [], 'ask cleared, no new turn end');
  assert.deepEqual(kinds(t.observe([hand('A', { liveAsks: 1, liveTurnEnds: 2 })])), ['finished:A']);
});

test('a hydrated ask (awaitingUser set, liveAsks unchanged) emits nothing', () => {
  const t = seen([hand('A', { status: 'idle' })]);
  assert.deepEqual(t.observe([hand('A', { awaitingUser: 'question', awaitingUserSource: 'tool' })]), []);
});

test('an ask that came and went between refreshes is absorbed, not announced later', () => {
  const t = seen([hand('A', { status: 'turn' })]);
  assert.deepEqual(t.observe([hand('A', { status: 'turn', liveAsks: 1 })]), [], 'running, no ask showing');
  assert.deepEqual(t.observe([hand('A', { status: 'turn', liveAsks: 1, awaitingUser: 'question', awaitingUserSource: 'tool' })]), []);
});

test('an errored turn end emits finished with isError', () => {
  const t = seen([hand('A', { status: 'turn' })]);
  assert.equal(t.observe([hand('A', { liveTurnEnds: 1, lastTurnError: true })])[0].isError, true);
});

test('the same sessionId under a new instanceId is a first sight and emits nothing', () => {
  const t = seen([hand('A', { id: 'old', status: 'turn' })]);
  assert.deepEqual(t.observe([hand('A', { id: 'new', liveTurnEnds: 5 })]), []);
});

test('an instance that leaves the pool and returns under the same id is re-baselined', () => {
  const t = seen([hand('A', { status: 'turn' })]);
  assert.deepEqual(t.observe([]), []);
  assert.deepEqual(t.observe([hand('A', { liveTurnEnds: 4 })]), [], 'back with a higher counter: first sight');
});

test('a counter below its baseline re-baselines silently, and later transitions still fire', () => {
  const t = seen([hand('A', { status: 'turn', liveTurnEnds: 5, liveAsks: 5 })]);
  assert.deepEqual(t.observe([hand('A', { liveTurnEnds: 1, liveAsks: 0 })]), [], 'fresh Instance behind the same id');
  assert.deepEqual(kinds(t.observe([hand('A', { liveTurnEnds: 2, liveAsks: 0 })])), ['finished:A']);
});

test('a lower ask counter alone also re-baselines', () => {
  const t = seen([hand('A', { status: 'turn', liveTurnEnds: 0, liveAsks: 3 })]);
  assert.deepEqual(t.observe([hand('A', { liveTurnEnds: 1, liveAsks: 0 })]), []);
});

// Invariant: with the server holding awaitingWake across the consume → wake-turn
// gap, a conductor's hand-back cycle yields exactly one finished, at the end.
test('a conductor wake cycle (armed → worker done, wake pending → wake turn → end) fires one finished, at the end', () => {
  const t = seen([cond('C', { status: 'turn' })]);
  assert.deepEqual(t.observe([cond('C', { awaitingWake: true, liveTurnEnds: 1 })]), [], 'turn ended with a wake armed');
  assert.deepEqual(t.observe([cond('C', { awaitingWake: true, liveTurnEnds: 1 })]), [], 'worker done, wake still pending');
  assert.deepEqual(t.observe([cond('C', { status: 'turn', awaitingWake: false, liveTurnEnds: 1 })]), [], 'wake turn started');
  assert.deepEqual(kinds(t.observe([cond('C', { status: 'idle', awaitingWake: false, liveTurnEnds: 2 })])), ['finished:C']);
});
