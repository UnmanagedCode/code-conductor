// Pure derivations behind the needs-you strip and the waiting-on-you ring
// (public/needsYou.js). No DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const N = await import(pathToFileURL(path.join(PUB, 'needsYou.js')).href);
const { deriveConductors } = await import(pathToFileURL(path.join(PUB, 'conductors.js')).href);

const cond = (sid, o = {}) => ({
  id: `inst-${sid}`, project: '.conduct', sessionId: sid, status: 'idle', createdAt: 1000, ...o,
});
const handInst = (sid, o = {}) => ({
  id: `inst-${sid}`, project: 'p', sessionId: sid, status: 'idle', conducted: false, ownerSessionId: null, createdAt: 1000, ...o,
});
const workerInst = (sid, owner, o = {}) => ({
  id: `inst-${sid}`, project: 'p', sessionId: sid, status: 'idle', conducted: true, ownerSessionId: owner, createdAt: 1000, ...o,
});

function strip(instances, conductRows = []) {
  const conductors = deriveConductors({ conductRows, instances });
  return N.deriveStrip({ conductors: conductors.live, instances });
}
const sids = (entries) => entries.map(e => e.sessionId);
const groupOf = (g, sid) => ['waiting', 'running', 'finished'].filter(k => g[k].some(e => e.sessionId === sid));

test('awaitingUser wins over every run state: a conductor re-invoked by a callback, or on a worker, is listed once, under waiting', () => {
  const g = strip([
    cond('T', { status: 'turn', awaitingUser: 'question', awaitingUserSource: 'text' }),
    cond('W', { status: 'idle', awaitingWake: true, awaitingUser: 'plan', awaitingUserSource: 'tool' }),
    cond('I', { status: 'idle', awaitingUser: 'question', awaitingUserSource: 'tool' }),
  ]);
  assert.deepEqual(groupOf(g, 'T'), ['waiting']);
  assert.deepEqual(groupOf(g, 'W'), ['waiting']);
  assert.deepEqual(groupOf(g, 'I'), ['waiting']);
});

test('idle without a pending wake is finished; idle on a worker, turn, spawning and displayStatus running over idle are running', () => {
  const g = strip([
    cond('F', { status: 'idle' }),
    cond('W', { status: 'idle', awaitingWake: true }),
    cond('T', { status: 'turn' }),
    cond('S', { status: 'spawning' }),
    cond('D', { status: 'idle', displayStatus: 'running' }),
  ]);
  assert.deepEqual(groupOf(g, 'F'), ['finished']);
  for (const sid of ['W', 'T', 'S', 'D']) assert.deepEqual(groupOf(g, sid), ['running'], sid);
});

test('stripGroupOf reads the dot status it is given and nothing else', () => {
  assert.equal(N.stripGroupOf({ live: true, status: 'running', awaitingWake: false, awaitingUser: null }), 'running');
  assert.equal(N.stripGroupOf({ live: true, status: 'idle', awaitingWake: false, awaitingUser: null }), 'finished');
  assert.equal(N.stripGroupOf({ live: false, status: 'idle', awaitingWake: false, awaitingUser: 'question' }), null);
});

test('exited and crashed sessions are never listed, even with awaitingUser set', () => {
  const g = strip([
    cond('X', { status: 'exited', awaitingUser: 'question', awaitingUserSource: 'tool' }),
    cond('C', { status: 'crashed', awaitingUser: 'plan', awaitingUserSource: 'tool' }),
    handInst('hx', { status: 'exited', awaitingUser: 'question', awaitingUserSource: 'text' }),
    handInst('hc', { status: 'crashed' }),
  ]);
  assert.ok(N.isStripEmpty(g));
});

test('a disk-only conductor is never listed, even when its disk row reports awaitingUser', () => {
  const g = strip([], [{ sessionId: 'D', title: 'disk', awaitingUser: 'question', awaitingUserSource: 'tool', lastActivity: 5 }]);
  assert.ok(N.isStripEmpty(g));
});

test('hand-spawned sessions appear in waiting and finished but never in running', () => {
  const g = strip([
    handInst('hw', { awaitingUser: 'question', awaitingUserSource: 'text' }),
    handInst('hf'),
    handInst('ht', { status: 'turn' }),
    handInst('hs', { status: 'spawning' }),
    handInst('hd', { status: 'idle', displayStatus: 'running' }),
  ]);
  assert.deepEqual(sids(g.waiting), ['hw']);
  assert.deepEqual(sids(g.finished), ['hf']);
  assert.deepEqual(sids(g.running), []);
});

test('conducted workers never appear in any status, even with awaitingUser forced on', () => {
  const g = strip([
    cond('A', { status: 'turn' }),
    workerInst('w1', 'A'),
    workerInst('w2', 'A', { status: 'turn' }),
    workerInst('w3', 'A', { awaitingUser: 'question', awaitingUserSource: 'tool' }),
    workerInst('w4', null, { awaitingUser: 'plan', awaitingUserSource: 'tool' }),
  ]);
  const all = [...g.waiting, ...g.running, ...g.finished];
  assert.deepEqual(sids(all), ['A']);
});

test('a .conduct temp instance counts as a conductor; a hand-spawned session that owns workers is still hand-spawned', () => {
  const g = strip([
    cond('T', { temp: true, status: 'turn' }),
    handInst('h', { status: 'turn' }),
    workerInst('w', 'h'),
    handInst('h2'),
  ]);
  assert.deepEqual(sids(g.running), ['T'], 'the temp conductor is running; the hand-spawned owner is not');
  assert.equal(g.running[0].conductor, true);
  assert.deepEqual(sids(g.finished), ['h2']);
  assert.equal(g.finished[0].conductor, false);
});

test('within a group: conductors in the given order first, then hand-spawned sessions newest first', () => {
  const instances = [
    handInst('hOld', { createdAt: 100 }),
    cond('cOld', { createdAt: 200 }),
    handInst('hNew', { createdAt: 50, lastResponseAt: 9000 }),
    cond('cNew', { createdAt: 5000 }),
  ];
  const conductors = deriveConductors({ instances });
  const g = N.deriveStrip({ conductors: conductors.live, instances });
  assert.deepEqual(sids(g.finished), ['cNew', 'cOld', 'hNew', 'hOld']);
  const flipped = N.deriveStrip({ conductors: [...conductors.live].reverse(), instances });
  assert.deepEqual(sids(flipped.finished), ['cOld', 'cNew', 'hNew', 'hOld'], 'conductor order is the given order');
});

test('entries carry the conductor label (title, then first prompt, then sid prefix) and their instanceId', () => {
  const g = strip([
    cond('aaaaaaaaaaaa', { title: 'Alpha' }),
    cond('bbbbbbbbbbbb', { firstPrompt: 'fix   the\nthing' }),
    cond('cccccccccccc'),
    handInst('hhhhhhhhhhhh', { firstPrompt: 'hand prompt' }),
  ]);
  const by = new Map(g.finished.map(e => [e.sessionId, e]));
  assert.equal(by.get('aaaaaaaaaaaa').label, 'Alpha');
  assert.equal(by.get('bbbbbbbbbbbb').label, 'fix the thing');
  assert.equal(by.get('cccccccccccc').label, 'cccccccc…');
  assert.equal(by.get('hhhhhhhhhhhh').label, 'hand prompt');
  assert.equal(by.get('aaaaaaaaaaaa').instanceId, 'inst-aaaaaaaaaaaa');
});

test('askLabel names the three asks distinctly: tool question, tool plan, text ask', () => {
  assert.equal(N.askLabel('question', 'tool'), 'question');
  assert.equal(N.askLabel('plan', 'tool'), 'plan approval');
  assert.equal(N.askLabel('question', 'text'), 'asked in text');
});

test('runLabel: on a worker, idle, running for turn and running, else the raw status', () => {
  assert.equal(N.runLabel('idle', true), 'on a worker');
  assert.equal(N.runLabel('idle', false), 'idle');
  assert.equal(N.runLabel('turn', false), 'running');
  assert.equal(N.runLabel('running', false), 'running');
  assert.equal(N.runLabel('spawning', false), 'spawning');
});

test('entry reasons: ask · run when waiting, working / on a worker when running, turn ended when finished', () => {
  const e = (o) => ({ status: 'idle', awaitingWake: false, awaitingUser: null, awaitingUserSource: null, ...o });
  assert.equal(N.entryReason(e({ awaitingUser: 'plan', awaitingUserSource: 'tool' }), 'waiting'), 'plan approval · idle');
  assert.equal(N.entryReason(e({ status: 'turn', awaitingUser: 'question', awaitingUserSource: 'text' }), 'waiting'), 'asked in text · running');
  assert.equal(N.entryReason(e({ awaitingWake: true, awaitingUser: 'question', awaitingUserSource: 'tool' }), 'waiting'), 'question · on a worker');
  assert.equal(N.entryReason(e({ status: 'turn' }), 'running'), 'working');
  assert.equal(N.entryReason(e({ awaitingWake: true }), 'running'), 'on a worker');
  assert.equal(N.entryReason(e({}), 'finished'), 'turn ended');
  assert.equal(N.needsYouTitle(e({ awaitingUser: 'plan', awaitingUserSource: 'tool' })), 'waiting on you (plan approval) · idle');
  assert.equal(N.needsYouTitle(e({ status: 'turn', awaitingUser: 'question', awaitingUserSource: 'text' })), 'waiting on you (asked in text) · running');
});

test('no playbook assumption: rows differing only in playbook and stage group and label identically', () => {
  const variants = [
    { playbook: null, stage: null },
    { playbook: 'anything', stage: 'whatever' },
    { playbook: 'plugin-x/weird', stage: 'write-it-up ✎' },
    { playbook: '', stage: 'x' },
  ];
  const shape = (v) => {
    const g = strip([
      cond('A', { title: 'A', status: 'turn', ...v }),
      cond('B', { title: 'B', awaitingUser: 'plan', awaitingUserSource: 'tool', ...v }),
      handInst('h', { title: 'h', ...v }),
      workerInst('w', 'A', { ...v }),
    ]);
    const pick = (es) => es.map(e => [e.sessionId, e.label]);
    return { waiting: pick(g.waiting), running: pick(g.running), finished: pick(g.finished) };
  };
  const base = shape(variants[0]);
  for (const v of variants.slice(1)) assert.deepEqual(shape(v), base, JSON.stringify(v));
});

test('isStripEmpty holds for no instances, and for only conducted workers plus running hand-spawned sessions', () => {
  assert.ok(N.isStripEmpty(strip([])));
  assert.ok(N.isStripEmpty(strip([
    workerInst('w1', 'X'), workerInst('w2', 'X', { status: 'turn' }),
    handInst('h1', { status: 'turn' }), handInst('h2', { status: 'idle', awaitingWake: true }),
  ])));
  assert.equal(N.isStripEmpty(strip([handInst('h')])), false);
});
