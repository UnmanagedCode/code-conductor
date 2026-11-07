// The event log's lifecycle half (src/mcp/sessionRecorder.ts): the manager's
// session stream becomes `session`, `turn`, `wake` and `config` rows. Driven
// through a stub manager whose `on` captures the listeners, so each case fires
// exactly the events it names, into a real gate writing a temp file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createPlaybookGate } from '../src/mcp/playbookGate.ts';
import { readEventLog } from '../src/eventLog.ts';
import { CONDUCT_PROJECT_NAME } from '../src/conduct.ts';
import { mkdtemp } from './tmpRegistry.mjs';
import { OPEN_LEASE } from './playbook-fixtures.mjs';

process.env.PROJECTS_ROOT = await mkdtemp('cc-evrec-root-');

async function rig(seed = []) {
  const dir = await mkdtemp('cc-evrec-');
  const file = path.join(dir, 'events.jsonl');
  if (seed.length) {
    await fs.writeFile(file, seed.map(r => JSON.stringify({ v: 1, ts: '2026-11-01T00:00:00Z', ...r })).join('\n') + '\n');
  }
  const listeners = new Map();
  const instances = {
    on(event, cb) { listeners.set(event, [...(listeners.get(event) ?? []), cb]); },
    emit() {},
    liveForSession() { return null; },
    isSessionLive() { return false; },
  };
  const gate = createPlaybookGate({ instances, lease: OPEN_LEASE, file: () => file });
  const fire = (event, arg) => { for (const cb of listeners.get(event) ?? []) cb(arg); };
  // Rows past the seed, envelope v/ts dropped.
  const rows = async () => (await readEventLog(file)).slice(seed.length).map(({ v, ts, ...r }) => r);
  // Writes are async and serialized: poll until `n` rows landed, then give a
  // late extra write a short window to show up.
  const drain = async (n = 0) => {
    await gate.readProjection();
    const deadline = Date.now() + 5000;
    while ((await rows()).length < n && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
    await new Promise(r => setTimeout(r, 20));
  };
  return { gate, fire, rows, drain };
}

const SYS = { type: 'system' };
const HUMAN = { type: 'human' };
const plain = { conducted: false, project: 'demo' };
const worker = { conducted: true, project: 'demo' };
const conductor = { conducted: false, project: CONDUCT_PROJECT_NAME };
const launched = (sessionId, scope, extra = {}) => ({ sessionId, ...scope, event: 'start', actor: SYS, playbookEnforcement: 'warn', ...extra });

test('a fresh, unconducted, untracked session writes a session start — every session is recorded', async () => {
  const r = await rig();
  r.fire('session_launched', launched('s1', plain, { actor: HUMAN }));
  await r.drain(1);
  assert.deepEqual(await r.rows(), [{ kind: 'session', actor: HUMAN, subject: 's1', event: 'start' }]);
});

test('a resume carries its cause, each cause verbatim; a plain resume has none; a fork is a start with cause fork', async () => {
  const r = await rig();
  const causes = ['respawn', 'restore', 'prune', 'rewind', 'model-switch'];
  for (const cause of causes) r.fire('session_launched', launched(`s-${cause}`, worker, { event: 'resume', cause }));
  r.fire('session_launched', launched('s-plain', worker, { event: 'resume' }));
  r.fire('session_launched', launched('s-fork', plain, { event: 'start', cause: 'fork' }));
  await r.drain(causes.length + 2);
  assert.deepEqual((await r.rows()).map(x => [x.subject, x.event, x.cause]), [
    ...causes.map(c => [`s-${c}`, 'resume', c]),
    ['s-plain', 'resume', undefined],
    ['s-fork', 'start', 'fork'],
  ]);
});

test('an exit writes one session exit with the status as cause and the event\'s actor', async () => {
  const r = await rig();
  r.fire('session_exited', { sessionId: 's1', ...plain, status: 'crashed', actor: { type: 'conductor', sessionId: 'c1' } });
  await r.drain(1);
  assert.deepEqual(await r.rows(), [
    { kind: 'session', actor: { type: 'conductor', sessionId: 'c1' }, subject: 's1', event: 'exit', cause: 'crashed' },
  ]);
});

test('a death mid-turn writes a turn end directly BEFORE the exit, adjacent; a death between turns writes only the exit', async () => {
  const r = await rig();
  r.fire('turn_started', { sessionId: 'w1', ...worker, actor: HUMAN });
  r.fire('turn_started', { sessionId: 'other', ...worker, actor: SYS });
  r.fire('session_exited', { sessionId: 'w1', ...worker, status: 'exited', actor: SYS });
  r.fire('turn_ended', { sessionId: 'other', ...worker, stopReason: 'end_turn' });
  r.fire('session_exited', { sessionId: 'other', ...worker, status: 'exited', actor: SYS });
  await r.drain(6);
  assert.deepEqual((await r.rows()).map(x => [x.subject, x.kind, x.event]), [
    ['w1', 'turn', 'start'],
    ['other', 'turn', 'start'],
    ['w1', 'turn', 'end'],
    ['w1', 'session', 'exit'],
    ['other', 'turn', 'end'],
    ['other', 'session', 'exit'],
  ]);
  const synthesized = (await r.rows())[2];
  assert.equal('stopReason' in synthesized, false, 'a synthesized end names no stop reason');
  assert.deepEqual(synthesized.actor, SYS);
});

test('turn rows are written for a conductor and a conducted worker, never for a plain session; the start carries the event\'s actor', async () => {
  const r = await rig();
  r.fire('turn_started', { sessionId: 'plain', ...plain, actor: HUMAN });
  r.fire('turn_ended', { sessionId: 'plain', ...plain, stopReason: 'end_turn' });
  r.fire('turn_started', { sessionId: 'cond', ...conductor, actor: HUMAN });
  r.fire('turn_ended', { sessionId: 'cond', ...conductor, stopReason: 'end_turn' });
  r.fire('turn_started', { sessionId: 'wk', ...worker, actor: { type: 'conductor', sessionId: 'cond' } });
  r.fire('turn_ended', { sessionId: 'wk', ...worker });
  await r.drain(4);
  assert.deepEqual(await r.rows(), [
    { kind: 'turn', actor: HUMAN, subject: 'cond', event: 'start' },
    { kind: 'turn', actor: SYS, subject: 'cond', event: 'end', stopReason: 'end_turn' },
    { kind: 'turn', actor: { type: 'conductor', sessionId: 'cond' }, subject: 'wk', event: 'start' },
    { kind: 'turn', actor: SYS, subject: 'wk', event: 'end' },
  ]);
});

test('a plain session that dies mid-turn writes no turn end (its turn was never recorded)', async () => {
  const r = await rig();
  r.fire('turn_started', { sessionId: 'p', ...plain, actor: HUMAN });
  r.fire('session_exited', { sessionId: 'p', ...plain, status: 'exited', actor: SYS });
  await r.drain(1);
  assert.deepEqual((await r.rows()).map(x => x.kind), ['session']);
});

test('a wake is recorded only when it reached a conductor: subject = the worker, recipient = the conductor, heartbeat only when true', async () => {
  const r = await rig();
  r.fire('wake_delivered', { callerSessionId: 'c1', callerProject: CONDUCT_PROJECT_NAME, targetSessionId: 'w1', heartbeat: false });
  r.fire('wake_delivered', { callerSessionId: 'c1', callerProject: CONDUCT_PROJECT_NAME, targetSessionId: 'w2', heartbeat: true });
  r.fire('wake_delivered', { callerSessionId: 'p1', callerProject: 'demo', targetSessionId: 'w3', heartbeat: false });
  await r.drain(2);
  assert.deepEqual(await r.rows(), [
    { kind: 'wake', actor: SYS, subject: 'w1', recipient: 'c1' },
    { kind: 'wake', actor: SYS, subject: 'w2', recipient: 'c1', heartbeat: true },
  ]);
});

test('a conductor\'s launch writes its enforcement BIRTH right after the start, only while the log holds no level for it', async () => {
  const r = await rig();
  r.fire('session_launched', launched('c1', conductor, { playbookEnforcement: 'enforce' }));
  r.fire('session_launched', launched('c1', conductor, { event: 'resume', cause: 'restore', playbookEnforcement: 'enforce' }));
  r.fire('session_launched', launched('w1', worker));
  await r.drain(4);
  assert.deepEqual(await r.rows(), [
    { kind: 'session', actor: SYS, subject: 'c1', event: 'start' },
    { kind: 'config', actor: SYS, subject: 'c1', key: 'enforcement', to: 'enforce' },
    { kind: 'session', actor: SYS, subject: 'c1', event: 'resume', cause: 'restore' },
    { kind: 'session', actor: SYS, subject: 'w1', event: 'start' },
  ]);
});

test('after a restart (the level folded from the file), a conductor\'s re-launch writes no second birth', async () => {
  const r = await rig([{ kind: 'config', actor: SYS, subject: 'c1', key: 'enforcement', to: 'warn' }]);
  r.fire('session_launched', launched('c1', conductor, { event: 'resume', cause: 'restore' }));
  await r.drain(1);
  assert.deepEqual((await r.rows()).map(x => x.kind), ['session']);
});

test('an enforcement change carries `from` (the logged level) and the actor; an unchanged level and a non-conductor write nothing', async () => {
  const r = await rig();
  r.fire('enforcement_changed', { sessionId: 'c1', project: CONDUCT_PROJECT_NAME, to: 'warn', actor: HUMAN });
  r.fire('enforcement_changed', { sessionId: 'c1', project: CONDUCT_PROJECT_NAME, to: 'warn', actor: HUMAN });
  r.fire('enforcement_changed', { sessionId: 'c1', project: CONDUCT_PROJECT_NAME, to: 'enforce', actor: HUMAN });
  r.fire('enforcement_changed', { sessionId: 'p1', project: 'demo', to: 'enforce', actor: HUMAN });
  await r.drain(2);
  assert.deepEqual(await r.rows(), [
    { kind: 'config', actor: HUMAN, subject: 'c1', key: 'enforcement', to: 'warn' },
    { kind: 'config', actor: HUMAN, subject: 'c1', key: 'enforcement', from: 'warn', to: 'enforce' },
  ]);
});

// ── event_log_blocked: who gets the bubble ──────────────────────────────────
//
// A refused write's bubble lands on the live conductor the FIRST dropped row
// names — its actor's sessionId, else its subject — and nowhere when neither is
// a live conductor. Driven through a lease that always refuses.
async function blockedRig(live) {
  const dir = await mkdtemp('cc-evrec-blocked-');
  const listeners = new Map();
  const bubbles = [];
  const inst = (sid, project) => ({ sessionId: sid, project, _emitUi: (ev) => bubbles.push({ on: sid, ev }) });
  const instances = {
    on(event, cb) { listeners.set(event, [...(listeners.get(event) ?? []), cb]); },
    emit() {},
    liveForSession(sid) { return live[sid] ? inst(sid, live[sid]) : null; },
    isSessionLive() { return false; },
  };
  const gate = createPlaybookGate({ instances, lease: { check: () => 'a newer server holds the projects root (generation 2)' }, file: () => path.join(dir, 'events.jsonl') });
  const fire = (event, arg) => { for (const cb of listeners.get(event) ?? []) cb(arg); };
  const settle = async () => { await gate.readProjection(); await new Promise(r => setTimeout(r, 20)); };
  return { fire, settle, bubbles };
}

function quiet(t) {
  const orig = { error: console.error, warn: console.warn };
  console.error = console.warn = () => {};
  t.after(() => Object.assign(console, orig));
}

test('blocked: the bubble lands on the live conductor named by the row\'s actor, once per episode', async (t) => {
  quiet(t);
  const r = await blockedRig({ c1: CONDUCT_PROJECT_NAME, c2: CONDUCT_PROJECT_NAME });
  r.fire('session_launched', launched('c2', conductor, { actor: { type: 'conductor', sessionId: 'c1' } }));
  r.fire('session_launched', launched('c2', conductor, { event: 'resume', actor: { type: 'conductor', sessionId: 'c1' } }));
  await r.settle();
  assert.deepEqual(r.bubbles.map(b => [b.on, b.ev.subtype, b.ev.data.reason]),
    [['c1', 'event_log_blocked', 'a newer server holds the projects root (generation 2)']],
    'the actor wins over a conductor subject, and a second drop in the episode adds no bubble');
});

test('blocked: with no live conductor actor, the bubble lands on a live conductor subject', async (t) => {
  quiet(t);
  const r = await blockedRig({ c2: CONDUCT_PROJECT_NAME });
  r.fire('session_launched', launched('c2', conductor, { actor: { type: 'conductor', sessionId: 'c-gone' } }));
  await r.settle();
  assert.deepEqual(r.bubbles.map(b => b.on), ['c2']);
});

test('blocked: no bubble anywhere when neither the actor nor the subject is a live conductor', async (t) => {
  quiet(t);
  const r = await blockedRig({ w1: 'demo' }); // live, but not a conductor
  r.fire('session_launched', launched('w1', worker, { actor: { type: 'conductor', sessionId: 'c-gone' } }));
  r.fire('session_exited', { sessionId: 'w1', ...worker, status: 'exited', actor: SYS });
  await r.settle();
  assert.deepEqual(r.bubbles, []);
});
