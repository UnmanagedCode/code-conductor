import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createPluginHost } from '../src/plugins/registry.js';
import { pidAlive } from '../src/plugins/ports.js';
import { readProjectMeta, writeProjectMeta, listWorkspaces } from '../src/projects.js';
import { makePluginRoot, readFixtureManifest, waitFor } from './plugin-helpers.mjs';

async function rejectsWithStatus(promise, statusCode) {
  try { await promise; }
  catch (e) { assert.equal(e.statusCode, statusCode, `expected ${statusCode}, got ${e.statusCode}: ${e.message}`); return e; }
  assert.fail(`expected rejection with statusCode ${statusCode}`);
}

test('discovery: ok / conflict / invalid / incompatible states', async () => {
  const env = await makePluginRoot();
  try {
    const fixture = await readFixtureManifest();
    await env.addPluginProject('aplug');
    await env.addPluginProject('bdup', { manifest: fixture }); // duplicate id — aplug wins alphabetically
    await env.addPluginProject('cinvalid', { manifest: { id: 'cinvalid', pluginApi: 1 } });
    await env.addPluginProject('dincompat', { manifest: { id: 'dincompat', name: 'D', version: '1', pluginApi: 99 } });
    await env.addProject('eplain');

    const host = createPluginHost();
    const rows = await host.list();
    const byProject = Object.fromEntries(rows.map(r => [r.project, r]));
    assert.equal(byProject.aplug.state, 'discovered');
    assert.equal(byProject.aplug.id, 'fake-plugin');
    assert.equal(byProject.aplug.hasFrontend, true);
    assert.equal(byProject.bdup.state, 'conflict');
    assert.match(byProject.bdup.errors[0], /duplicate id 'fake-plugin'/);
    assert.equal(byProject.cinvalid.state, 'invalid');
    assert.equal(byProject.dincompat.state, 'incompatible');
    assert.equal(byProject.eplain, undefined);

    await rejectsWithStatus(host.enable('nope'), 404);
    await rejectsWithStatus(host.enable('dincompat'), 409);
  } finally {
    await env.restore();
  }
});

test('enable persists, auto-assigns CC-Dev only when unassigned; disable persists', async () => {
  const env = await makePluginRoot();
  try {
    await env.addPluginProject('aplug');
    const host = createPluginHost();
    const row = await host.enable('fake-plugin');
    assert.equal(row.state, 'stopped');
    assert.equal(row.enabled, true);
    assert.deepEqual(row.activeVersion, { type: 'main' });
    assert.equal((await readProjectMeta('aplug')).workspace, 'CC-Dev');
    assert.ok((await listWorkspaces()).includes('CC-Dev'));

    // A second host instance sees the persisted state (registry.json).
    const host2 = createPluginHost();
    const rows = await host2.list();
    assert.equal(rows.find(r => r.id === 'fake-plugin').enabled, true);

    await host.disable('fake-plugin');
    assert.equal((await host.list()).find(r => r.id === 'fake-plugin').state, 'disabled');

    // Pre-assigned workspace is never overwritten.
    await writeProjectMeta('aplug', { workspace: 'Mine' });
    await host.enable('fake-plugin');
    assert.equal((await readProjectMeta('aplug')).workspace, 'Mine');
  } finally {
    await env.restore();
  }
});

test('lazy ensureStarted → ready; repeat is a no-op; stop kills the child', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    await env.addPluginProject('aplug');
    await rejectsWithStatus(host.ensureStarted('fake-plugin'), 404); // not enabled yet
    await host.enable('fake-plugin');

    await host.ensureStarted('fake-plugin');
    const info = host.runtimeInfo('fake-plugin');
    assert.equal(info.status, 'ready');
    const health = await (await fetch(`http://127.0.0.1:${info.port}/health`)).json();
    assert.equal(health.ok, true);

    await host.ensureStarted('fake-plugin'); // already ready — same child
    assert.equal(host.runtimeInfo('fake-plugin').port, info.port);

    const row = await host.status('fake-plugin');
    assert.equal(row.state, 'ready');
    assert.ok(row.pid);
    assert.equal(row.gitHead, null); // tmp project copy is not a git repo

    const pid = row.pid;
    await host.stop('fake-plugin');
    await waitFor(() => !pidAlive(pid));
    assert.equal((await host.status('fake-plugin')).state, 'stopped');
  } finally {
    await host.stopAll();
    await env.restore();
  }
});

test('start guards: not enabled 409, unknown 404, manifest id mismatch 400', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    const dir = await env.addPluginProject('aplug');
    await rejectsWithStatus(host.start('fake-plugin'), 409);
    await rejectsWithStatus(host.start('ghost'), 404);

    await host.enable('fake-plugin');
    // The active checkout stops being this plugin → start must refuse and
    // keep state.
    const fixture = await readFixtureManifest();
    await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify({ ...fixture, id: 'other-id' }));
    const e = await rejectsWithStatus(host.start('fake-plugin'), 400);
    assert.match(e.message, /does not match plugin 'fake-plugin'/);
    assert.equal((await host.list()).find(r => r.id === 'fake-plugin').state, 'stopped');
  } finally {
    await host.stopAll();
    await env.restore();
  }
});

test('crash backoff: 503 inside the window; 3 crashes in window → failed; enable recovers', async () => {
  const env = await makePluginRoot();
  try {
    const fixture = await readFixtureManifest();
    const crasherManifest = { id: 'crasher', name: 'Crasher', version: '1', pluginApi: 1, backend: { start: 'node crash.mjs' } };
    await env.addPluginProject('crasher', { manifest: crasherManifest });
    await env.addPluginProject('aplug', { manifest: fixture });

    // Long backoff unit: prove the 503-with-retryAfter window.
    const hostA = createPluginHost({ _backoffUnitMs: 60_000 });
    await hostA.enable('crasher');
    const e1 = await rejectsWithStatus(hostA.ensureStarted('crasher'), 502);
    assert.match(e1.tail, /boom/);
    const e2 = await rejectsWithStatus(hostA.ensureStarted('crasher'), 503);
    assert.ok(e2.retryAfter > 0);
    assert.match(e2.tail, /boom/);

    // Tiny backoff unit: let crashes accumulate to failed.
    const hostB = createPluginHost({ _backoffUnitMs: 1 });
    await rejectsWithStatus(hostB.ensureStarted('crasher'), 502); // crash 1
    await new Promise(r => setTimeout(r, 30));
    await rejectsWithStatus(hostB.ensureStarted('crasher'), 502); // crash 2
    await new Promise(r => setTimeout(r, 30));
    await rejectsWithStatus(hostB.ensureStarted('crasher'), 502); // crash 3 → failed
    const eF = await rejectsWithStatus(hostB.ensureStarted('crasher'), 503);
    assert.match(eF.message, /failed/);
    assert.equal((await hostB.list()).find(r => r.id === 'crasher').state, 'failed');

    // Manual start is the other recovery path: clears crash history, tries
    // again (and re-crashes back to plain crashed, not failed).
    await rejectsWithStatus(hostB.start('crasher'), 502);
    assert.equal((await hostB.list()).find(r => r.id === 'crasher').state, 'crashed');

    // Re-enable resets to stopped.
    await hostB.enable('crasher');
    assert.equal((await hostB.list()).find(r => r.id === 'crasher').state, 'stopped');
  } finally {
    await env.restore();
  }
});

test('adopt-don\'t-drain: live child adopted by a fresh host; dead record cleared', async () => {
  const env = await makePluginRoot();
  const host1 = createPluginHost();
  try {
    await env.addPluginProject('aplug');
    await host1.enable('fake-plugin');
    await host1.ensureStarted('fake-plugin');
    const { port } = host1.runtimeInfo('fake-plugin');
    const { pid } = (await host1.status('fake-plugin'));

    // A brand-new host (fresh conductor process) adopts the running child.
    const host2 = createPluginHost();
    const row = (await host2.list()).find(r => r.id === 'fake-plugin');
    assert.equal(row.state, 'ready');
    assert.equal(row.port, port);

    // Stop through the adopting host (only needs the recorded pgid).
    await host2.stop('fake-plugin');
    await waitFor(() => !pidAlive(pid));

    // Dead-pid record: start again, kill behind the registry's back, and a
    // third host must clear the record instead of adopting.
    await host2.start('fake-plugin');
    const rec2 = await host2.status('fake-plugin');
    process.kill(-rec2.pid, 'SIGKILL');
    await waitFor(() => !pidAlive(rec2.pid));
    const host3 = createPluginHost();
    const row3 = (await host3.list()).find(r => r.id === 'fake-plugin');
    assert.equal(row3.state, 'stopped');
    assert.equal(row3.port, null);
  } finally {
    await host1.stopAll();
    await env.restore();
  }
});

test('status() live-probe flips a silently-dead child to crashed', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    await env.addPluginProject('aplug');
    await host.enable('fake-plugin');
    await host.ensureStarted('fake-plugin');
    const { pid } = await host.status('fake-plugin');
    process.kill(-pid, 'SIGKILL');
    await waitFor(() => !pidAlive(pid));
    const row = await host.status('fake-plugin');
    assert.equal(row.state, 'crashed');
    // Lazy restart on next demand brings it back.
    await new Promise(r => setTimeout(r, 2100)); // past the first backoff (2s)
    await host.ensureStarted('fake-plugin');
    assert.equal(host.runtimeInfo('fake-plugin').status, 'ready');
  } finally {
    await host.stopAll();
    await env.restore();
  }
});

test('registry entry whose project vanished still lists as invalid', async () => {
  const env = await makePluginRoot();
  try {
    const dir = await env.addPluginProject('aplug');
    const host = createPluginHost();
    await host.enable('fake-plugin');
    await fs.rm(path.join(dir, 'conductor.plugin.json'));
    const rows = await host.rescan();
    const row = rows.find(r => r.id === 'fake-plugin');
    assert.equal(row.state, 'invalid');
    assert.match(row.errors[0], /no longer present/);
  } finally {
    await env.restore();
  }
});
