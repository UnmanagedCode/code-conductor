// The gate's manager-event writers: `retire` / `resume` for every conducted (or
// tracked) session, edge-triggered, and `wake` for a wake delivered to a
// conductor. Driven through a stub manager whose `on` captures the listeners,
// so each case fires exactly the events it names.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createPlaybookGate } from '../src/mcp/playbookGate.ts';
import { createPlaybookLedger, readEvents } from '../src/playbookLedger.ts';
import { CONDUCT_PROJECT_NAME } from '../src/conduct.ts';
import { mkdtemp } from './tmpRegistry.mjs';

process.env.PROJECTS_ROOT = await mkdtemp('cc-pblife-root-');

async function rig(seed = []) {
  const dir = await mkdtemp('cc-pblife-');
  const file = path.join(dir, 'playbook-ledger.jsonl');
  if (seed.length) {
    await fs.writeFile(file, seed.map((e, i) =>
      JSON.stringify({ seq: i + 1, ts: '2026-09-06T00:00:00Z', ...e })).join('\n') + '\n');
  }
  const listeners = new Map();
  const instances = {
    on(event, cb) { listeners.set(event, [...(listeners.get(event) ?? []), cb]); },
    emit() {},
    liveForSession() { return null; },
    anyForSession() { return null; },
    isSessionLive() { return false; },
  };
  const gate = createPlaybookGate({ instances, ledger: createPlaybookLedger({ file: () => file }) });
  const fire = (event, arg) => { for (const cb of listeners.get(event) ?? []) cb(arg); };
  const rows = async () => (await readEvents(file)).map(({ ts, ...e }) => e);
  // The gate's writes are asynchronous and serialized. A case that expects `n`
  // new rows polls until they have landed; a case expecting none (`n` = 0) can
  // only give a late write a short window to appear.
  const drain = async (n = 0) => {
    await gate.readProjection();
    const deadline = Date.now() + 5000;
    while (n > 0 && (await rows()).length < n && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
    await new Promise(r => setTimeout(r, 20));
  };
  const kinds = async () => (await rows()).map(e => e.kind);
  return { dir, gate, fire, drain, rows, kinds };
}

const status = (sessionId, st, extra = {}) =>
  ({ sessionId, status: st, project: 'demo', conducted: false, ...extra });

test('an exit of an untracked CONDUCTED session writes one retire', async () => {
  const r = await rig();
  r.fire('status', status('w1', 'exited', { conducted: true }));
  await r.drain(1);
  assert.deepEqual(await r.rows(), [{ seq: 1, kind: 'retire', sessionId: 'w1', reason: 'subprocess exited' }]);
});

test('an exit of an untracked, non-conducted session writes nothing', async () => {
  const r = await rig();
  r.fire('status', status('w1', 'exited'));
  await r.drain();
  assert.deepEqual(await r.kinds(), []);
});

test('a tracked AND conducted session that exits gets exactly one retire', async () => {
  const r = await rig([{ kind: 'spawn', sessionId: 'w1', playbook: 'solo', stage: 'plan' }]);
  r.fire('status', status('w1', 'exited', { conducted: true }));
  await r.drain(2);
  assert.deepEqual(await r.kinds(), ['spawn', 'retire']);
});

test('exited then crashed, or exited twice, is one retire', async () => {
  const r = await rig();
  r.fire('status', status('w1', 'exited', { conducted: true }));
  r.fire('status', status('w1', 'crashed', { conducted: true }));
  r.fire('status', status('w1', 'exited', { conducted: true }));
  await r.drain(1);
  assert.deepEqual(await r.kinds(), ['retire']);
});

test('dead -> alive -> dead writes two retires', async () => {
  const r = await rig();
  r.fire('status', status('w1', 'exited', { conducted: true }));
  r.fire('status', status('w1', 'idle', { conducted: true }));
  r.fire('status', status('w1', 'crashed', { conducted: true }));
  await r.drain(2);
  assert.deepEqual(await r.kinds(), ['retire', 'retire']);
});

test('session_relaunched for a never-seen conducted session writes one resume', async () => {
  const r = await rig();
  r.fire('session_relaunched', { sessionId: 'w1', conducted: true });
  await r.drain(1);
  assert.deepEqual(await r.rows(), [{ seq: 1, kind: 'resume', sessionId: 'w1' }]);
});

test('session_relaunched for a tracked, non-conducted session writes one resume', async () => {
  const r = await rig([{ kind: 'spawn', sessionId: 'w1', playbook: 'solo', stage: 'plan' }]);
  r.fire('session_relaunched', { sessionId: 'w1', conducted: false });
  await r.drain(2);
  assert.deepEqual(await r.kinds(), ['spawn', 'resume']);
});

test('session_relaunched for a session that is neither conducted nor tracked writes nothing', async () => {
  const r = await rig();
  r.fire('session_relaunched', { sessionId: 'w1', conducted: false });
  await r.drain();
  assert.deepEqual(await r.kinds(), []);
});

test('session_relaunched while the session is already alive writes nothing', async () => {
  const r = await rig();
  r.fire('status', status('w1', 'idle', { conducted: true }));
  r.fire('session_relaunched', { sessionId: 'w1', conducted: true });
  await r.drain();
  assert.deepEqual(await r.kinds(), []);
});

test('an exit followed by a relaunch writes retire then resume, in seq order', async () => {
  const r = await rig();
  r.fire('status', status('w1', 'exited', { conducted: true }));
  r.fire('session_relaunched', { sessionId: 'w1', conducted: true });
  await r.drain(2);
  assert.deepEqual((await r.rows()).map(e => [e.seq, e.kind]), [[1, 'retire'], [2, 'resume']]);
});

test('a wake delivered to a conductor writes one wake row with ids only and no heartbeat key', async () => {
  const r = await rig();
  r.fire('wake_delivered', {
    callerSessionId: 'c1', callerProject: CONDUCT_PROJECT_NAME, targetSessionId: 'w1', heartbeat: false,
  });
  await r.drain(1);
  const rows = await r.rows();
  assert.deepEqual(rows, [{ seq: 1, kind: 'wake', sessionId: 'w1', conductorSessionId: 'c1' }]);
  assert.equal(Object.hasOwn(rows[0], 'heartbeat'), false);
});

test('a heartbeat wake carries heartbeat:true', async () => {
  const r = await rig();
  r.fire('wake_delivered', {
    callerSessionId: 'c1', callerProject: CONDUCT_PROJECT_NAME, targetSessionId: 'w1', heartbeat: true,
  });
  await r.drain(1);
  assert.deepEqual(await r.rows(), [{ seq: 1, kind: 'wake', sessionId: 'w1', conductorSessionId: 'c1', heartbeat: true }]);
});

test('a wake delivered to a non-conductor writes nothing', async () => {
  const r = await rig();
  r.fire('wake_delivered', { callerSessionId: 'c1', callerProject: 'demo', targetSessionId: 'w1', heartbeat: false });
  await r.drain();
  assert.deepEqual(await r.kinds(), []);
});
