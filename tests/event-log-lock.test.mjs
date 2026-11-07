// The event log's writer lease IS the projects-root lock (src/rootLock.ts →
// writerCheck): a server writes only while it alone holds the root with no
// handover offered. Driven with a real acquireRootLock on a temp store, so the
// restart-overlap invariant is pinned against the real record, not a stub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  acquireRootLock, RootLockHeldError, ROOT_LOCK_DIRNAME, ROOT_LOCK_HANDOVER_ENV,
} from '../src/rootLock.ts';
import { hostPlatform } from '../src/platform/index.ts';
import { createPlaybookGate } from '../src/mcp/playbookGate.ts';
import { readEventLog } from '../src/eventLog.ts';
import { mkdtemp } from './tmpRegistry.mjs';
import { bootServer, waitFor } from './helpers.mjs';

const QUIET = { warn() {} };
const storeOf = (root) => path.join(root, '.code-conductor');

async function acquire(t, root, opts = {}) {
  const lock = await acquireRootLock({ storeDir: storeOf(root), platform: hostPlatform, log: QUIET, ...opts });
  t.after(() => lock.releaseSync());
  return lock;
}

// Silence the blocked-episode lines a refused write logs (asserted elsewhere).
function hush(t) {
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = () => {};
  t.after(() => Object.assign(console, orig));
}

function stubManager() {
  const listeners = new Map();
  return {
    on(event, cb) { listeners.set(event, [...(listeners.get(event) ?? []), cb]); },
    emit() {},
    liveForSession() { return null; },
    isSessionLive() { return false; },
    fire(event, arg) { for (const cb of listeners.get(event) ?? []) cb(arg); },
  };
}

const launched = (sessionId) => ({ sessionId, conducted: true, project: 'demo', event: 'start', actor: { type: 'system' }, playbookEnforcement: 'warn' });

test('writerCheck() is null while held, and names why once a handover is offered, the lock released, a newer generation published or the record lost', async (t) => {
  const root = await mkdtemp('cc-evlock-');
  const lock = await acquire(t, root);
  assert.equal(lock.writerCheck(), null);

  assert.equal(lock.offerHandover('T-next'), true);
  assert.match(lock.writerCheck(), /handed over/);

  // A replacement presenting the offer takes the next generation over us.
  const next = await acquire(t, root, { env: { [ROOT_LOCK_HANDOVER_ENV]: 'T-next' } });
  assert.match(lock.writerCheck(), /newer server holds the projects root \(generation 2\)/);
  assert.equal(next.writerCheck(), null, 'the replacement is the writer');

  next.releaseSync();
  assert.match(next.writerCheck(), /released/);

  const root2 = await mkdtemp('cc-evlock-');
  const lone = await acquire(t, root2);
  fs.rmSync(path.join(storeOf(root2), ROOT_LOCK_DIRNAME, `${lone.gen}.json`));
  assert.match(lone.writerCheck(), /gone or no longer ours/);
});

test('restart overlap: a gate leased on the lock writes rows before the handover offer and NONE after it', async (t) => {
  hush(t);
  const root = await mkdtemp('cc-evlock-');
  const lock = await acquire(t, root);
  const file = path.join(storeOf(root), 'events.jsonl');
  const instances = stubManager();
  const gate = createPlaybookGate({ instances, lease: { check: () => lock.writerCheck() }, file: () => file });

  instances.fire('session_launched', launched('w-before'));
  await gate.readProjection();
  await new Promise(r => setTimeout(r, 20));
  const before = await readEventLog(file);
  assert.ok(before.some(r => r.subject === 'w-before'), 'premise: the holder writes');

  assert.equal(lock.offerHandover('T-replacement'), true);
  // What the old server observes after offering — exits of workers it tore down.
  instances.fire('session_exited', { sessionId: 'w-before', conducted: true, project: 'demo', status: 'exited', actor: { type: 'system' } });
  instances.fire('session_launched', launched('w-after'));
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(await readEventLog(file), before, 'no row lands after the offer');
});

test('a second acquireRootLock on a held store is refused, so a second server never constructs a writer', async (t) => {
  const root = await mkdtemp('cc-evlock-');
  await acquire(t, root);
  await assert.rejects(acquireRootLock({ storeDir: storeOf(root), platform: hostPlatform, log: QUIET }), RootLockHeldError);
});

test('createServer wires the lease: a server holding the root lock writes, and stops at the handover offer; one without the lock writes nothing, loudly', async (t) => {
  const lockRoot = await mkdtemp('cc-evlock-');
  const lock = await acquire(t, lockRoot);
  const held = await bootServer({ relaunch: { flags: { buildWeb: false, syncDeps: false }, rootLock: lock } });
  const file = path.join(held.projectsRoot, '.code-conductor', 'events.jsonl');
  try {
    held.instances.emit('session_launched', launched('w-held'));
    await waitFor(async () => (await readEventLog(file)).some(r => r.subject === 'w-held'));
    hush(t);
    lock.offerHandover('T-replacement');
    held.instances.emit('session_launched', launched('w-offered'));
    await new Promise(r => setTimeout(r, 50));
    assert.equal((await readEventLog(file)).some(r => r.subject === 'w-offered'), false);
  } finally { await held.close(); }

  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  const bare = await bootServer({});
  try {
    bare.instances.emit('session_launched', launched('w-bare'));
    await waitFor(() => errors.some(e => /holds no projects-root lock/.test(e)));
    assert.equal(fs.existsSync(path.join(bare.projectsRoot, '.code-conductor', 'events.jsonl')), false);
  } finally {
    console.error = origError;
    await bare.close();
  }
});
