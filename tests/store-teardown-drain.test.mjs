// Teardown must not leak session-store writes into the next test's store.
// Every store write resolves its file from `PROJECTS_ROOT` when its serialized
// body RUNS, and bootServer().close() retargets that env and deletes the home —
// so a write still queued when close() returns lands in whatever store is
// current next. These tests pin the three pieces that close that window:
// settleSessionWrites (src/sessionStore.ts), InstanceManager.shutdown()
// awaiting each temp instance's exit archive (src/instances.ts), and the drain
// call inside bootServer().close() (tests/helpers.mjs).
//
// Every parked promise is released in `finally`: the drain waits for it, so a
// failure before the release would otherwise hang to the file hang-guard.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { bootServer, freshProjectsRoot, api, waitFor, instForSession, settle, rmrf } from './helpers.mjs';
import {
  setSegmentTemp, markConducted, isTemp, isArchived, trackLineageWrite, settleSessionWrites,
} from '../src/sessionStore.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-renew.json');

let nextRpcId = 1;
async function callTool(baseUrl, name, args) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return JSON.parse(body.result.content[0].text);
}

// Save the store env vars; the returned function restores them exactly — an
// originally unset var is deleted, not set to the string "undefined".
function saveStoreEnv() {
  const saved = { PROJECTS_ROOT: process.env.PROJECTS_ROOT, CLAUDE_PROJECTS_ROOT: process.env.CLAUDE_PROJECTS_ROOT };
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v; else delete process.env[k];
    }
  };
}

// A fresh store root per test, drained and removed afterwards.
async function withFreshRoot(fn) {
  const restoreEnv = saveStoreEnv();
  const root = await freshProjectsRoot();
  try { await fn(); } finally {
    await settleSessionWrites();
    restoreEnv();
    await rmrf(root.home);
  }
}

// INVARIANT: settleSessionWrites waits for every write parked on the read
// barrier (`inFlightWrites`), AND for the serialized write that parked write
// enqueues once it is released — the drain re-checks after a hop rather than
// returning on one snapshot.
test('settleSessionWrites waits for a write parked on the read barrier, then for the write it enqueues', async () => {
  let release = () => {};
  await withFreshRoot(async () => {
    try {
      trackLineageWrite(new Promise((r) => { release = r; }));
      let landed = false;
      const write = setSegmentTemp(randomUUID(), true).then(() => { landed = true; });
      let drained = false;
      const drain = settleSessionWrites().then(() => { drained = true; });
      await settle();
      assert.equal(drained, false, 'the drain waits while a write is parked on the barrier');
      release();
      await drain;
      assert.equal(landed, true, 'the drain resolved only after the released write landed');
      await write;
    } finally {
      release();
    }
  });
});

// INVARIANT: settleSessionWrites waits for the serialize chain's tail
// (`writeChain`): a locked mutateSessions takes several sequential fs ops, so
// one event-loop hop is never enough for it to land.
test('settleSessionWrites waits for a serialized write in flight', async () => {
  await withFreshRoot(async () => {
    let landed = false;
    const write = markConducted(randomUUID()).then(() => { landed = true; });
    await settleSessionWrites();
    assert.equal(landed, true, 'the drain resolved only after the serialized write landed');
    await write;
  });
});

// INVARIANT: InstanceManager.shutdown() resolves only after every temp
// instance's exit archive (`_archiveTempSession` → retireSegment) has landed.
// The archive is fired from _handleExit and its retireSegment is called only
// after an fs.rm, so neither the serialize chain nor the read barrier sees it
// when kill() resolves — shutdown() has to await it itself.
// INVARIANT (also): once an exit archive has settled, the manager's
// `_exitArchives` no longer holds it — the set is only what is in flight, so a
// long-running orchestrator does not keep one settled promise per temp worker.
test('shutdown resolves only after a temp worker\'s exit archive has landed', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await callTool(srv.baseUrl, 'spawn_instance', { project: 'p', mode: 'bypassPermissions' });
    await waitFor(() => instForSession(srv.instances, spawn.sessionId)?.status === 'idle');
    const backing = instForSession(srv.instances, spawn.sessionId).backingSessionId;
    await waitFor(() => isTemp(backing));

    await srv.instances.shutdown();
    // Read BEFORE close(): close() drains the store, which would mask a
    // shutdown() that returned early.
    assert.equal(await isArchived(backing), true, 'the exit archive retired the segment before shutdown() resolved');
    assert.equal(await isTemp(backing), false, 'and cleared its temp flag');
    assert.equal(srv.instances._exitArchives.size, 0, 'a settled exit archive leaves the manager\'s set');
  } finally {
    await srv.close();
  }
});

// INVARIANT: shutdown() also waits for the exit archive of a temp instance
// that has ALREADY LEFT byId — killed by kill_instance (remove()) before
// shutdown. Its archive is still pending, and nothing store-side tracks it:
// the retireSegment is issued only after an fs.rm and an await on the
// instance's lineage chain. The test holds that chain itself (assigned
// directly, so the read barrier never sees it and reads stay unblocked), which
// keeps the archive pending for as long as the test needs.
// INVARIANT (also): the archive is in `_exitArchives` while it is pending and
// gone from it once settled, for a removed instance as for a live one.
test('shutdown waits for the exit archive of a temp worker already removed by kill_instance', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO });
  let release = () => {};
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await callTool(srv.baseUrl, 'spawn_instance', { project: 'p', mode: 'bypassPermissions' });
    await waitFor(() => instForSession(srv.instances, spawn.sessionId)?.status === 'idle');
    const inst = instForSession(srv.instances, spawn.sessionId);
    const backing = inst.backingSessionId;
    await waitFor(() => isTemp(backing));
    inst._lineageWrite = new Promise((r) => { release = r; });

    await callTool(srv.baseUrl, 'kill_instance', { sessionId: spawn.sessionId });
    assert.equal(srv.instances.byId.has(inst.id), false, 'precondition: kill_instance removed the worker from byId');
    let shutDown = false;
    const shutdown = srv.instances.shutdown().then(() => { shutDown = true; });
    await settle();
    assert.equal(shutDown, false, 'shutdown() waits while a removed worker\'s exit archive is pending');
    assert.equal(srv.instances._exitArchives.size, 1, 'precondition: the pending archive is tracked');

    release();
    await shutdown;
    assert.equal(await isArchived(backing), true, 'the archive retired the segment before shutdown() resolved');
    assert.equal(await isTemp(backing), false, 'and cleared its temp flag');
    assert.equal(srv.instances._exitArchives.size, 0, 'a settled exit archive leaves the manager\'s set');
  } finally {
    release();
    await srv.close();
  }
});

// INVARIANT: bootServer().close() drains the session store before it retargets
// PROJECTS_ROOT, so a write the server issued lands in the server's own home —
// never in the root close() restores.
//
// The parked write is released from the server's 'close' event plus one
// setImmediate because that is the LAST point before close() retargets
// PROJECTS_ROOT: a close() that does not drain has retargeted by then, so the
// write lands in the restored root, deterministically. Releasing earlier (or a
// fixed number of turns after starting close()) races close()'s own fs work and
// reads green without the drain. If close() is ever reordered so the server is
// no longer closed immediately before the env restore, revisit this hook.
test('close() does not retarget the store while a store write is pending', async () => {
  const restoreEnv = saveStoreEnv();
  // The root close() restores to: this test's own, so it can be inspected.
  const next = await freshProjectsRoot();
  const srv = await bootServer();
  let release = () => {};
  try {
    const id = randomUUID();
    trackLineageWrite(new Promise((r) => { release = r; }));
    let landed = false;
    const write = setSegmentTemp(id, true).then(() => { landed = true; });
    srv.server.once('close', () => setImmediate(release));

    await srv.close();
    assert.equal(landed, true, 'close() resolved only after the pending write landed');
    await write;
    assert.equal(process.env.PROJECTS_ROOT, next.projectsRoot, 'precondition: close() restored the prior root');
    assert.equal(await isTemp(id), false, 'the write did not land in the root close() restored');
  } finally {
    release();
    restoreEnv();
    await rmrf(next.home);
  }
});
