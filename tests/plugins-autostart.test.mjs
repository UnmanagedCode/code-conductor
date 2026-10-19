import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createPluginHost } from '../src/plugins/registry.ts';
import { pidAlive } from '../src/plugins/ports.ts';
import { orchStoreRoot } from '../src/projects.ts';
import { makePluginRoot } from './plugin-helpers.mjs';

// Per-plugin auto-start: a persisted flag on the registry record that
// setAutoStart() writes and only autoStartAll() — the boot pass — acts on.
// Each "host B" below stands in for a fresh cc process booting over the store
// host A left behind.

const registryFile = () => path.join(orchStoreRoot(), 'plugins', 'registry.json');
const readRegistry = async () => JSON.parse(await fs.readFile(registryFile(), 'utf8'));
const rowOf = async (host, id) => (await host.list()).find(r => r.id === id);

const CRASHER = { id: 'crasher', name: 'Crasher', version: '1', pluginApi: 1, backend: { start: 'node crash.mjs' } };
const CONVENTIONS_ONLY = {
  id: 'convonly', name: 'Conventions only', version: '1', pluginApi: 1,
  conventions: [{ slug: 'vis', name: 'Visual check', description: 'verify UX', file: 'conventions/sample.md', scope: 'project' }],
};

async function rejectsWithStatus(promise, statusCode) {
  try { await promise; }
  catch (e) { assert.equal(e.statusCode, statusCode, `expected ${statusCode}, got ${e.statusCode}: ${e.message}`); return e; }
  assert.fail(`expected rejection with statusCode ${statusCode}`);
}

test('the flag is off on a freshly enabled record, and a set flag persists to a new host', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    await env.addPluginProject('aplug');
    await host.enable('fake-plugin');
    assert.equal((await readRegistry()).plugins['fake-plugin'].autoStart, false);
    assert.equal((await rowOf(host, 'fake-plugin')).autoStart, false);

    const row = await host.setAutoStart('fake-plugin', true);
    assert.equal(row.autoStart, true);
    assert.equal((await readRegistry()).plugins['fake-plugin'].autoStart, true);
    assert.equal((await rowOf(createPluginHost(), 'fake-plugin')).autoStart, true,
      'a new host reads the flag back from registry.json');
  } finally {
    await host.stopAll();
    await env.restore();
  }
});

test('disable keeps the flag and re-enable restores it', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    await env.addPluginProject('aplug');
    await host.enable('fake-plugin');
    await host.setAutoStart('fake-plugin', true);
    await host.disable('fake-plugin');
    assert.equal((await readRegistry()).plugins['fake-plugin'].autoStart, true, 'disable keeps the flag');
    await host.enable('fake-plugin');
    assert.equal((await readRegistry()).plugins['fake-plugin'].autoStart, true, 're-enable does not reset the flag');
    assert.equal((await rowOf(host, 'fake-plugin')).autoStart, true);
  } finally {
    await host.stopAll();
    await env.restore();
  }
});

test('setAutoStart refuses a non-boolean (400), an unknown id (404), a plugin not enabled (409) and a backendless plugin (400), writing nothing', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    await env.addPluginProject('aplug');
    await env.addPluginProject('convonly', { manifest: CONVENTIONS_ONLY });
    await env.addPluginProject('other', { manifest: { ...CRASHER, id: 'other' } });
    await host.enable('fake-plugin');
    await host.enable('convonly');
    await host.enable('other');
    await host.disable('other');
    const before = await fs.readFile(registryFile(), 'utf8');

    const e1 = await rejectsWithStatus(host.setAutoStart('fake-plugin', 'yes'), 400);
    assert.match(e1.message, /'autoStart' must be a boolean/);
    await rejectsWithStatus(host.setAutoStart('ghost', true), 404);
    await rejectsWithStatus(host.setAutoStart('other', true), 409);
    const e4 = await rejectsWithStatus(host.setAutoStart('convonly', true), 400);
    assert.match(e4.message, /has no backend to start/);

    assert.equal(await fs.readFile(registryFile(), 'utf8'), before, 'no refusal writes registry.json');
  } finally {
    await host.stopAll();
    await env.restore();
  }
});

test('setting the flag starts nothing now', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    await env.addPluginProject('aplug');
    await host.enable('fake-plugin');
    const row = await host.setAutoStart('fake-plugin', true);
    assert.equal(row.state, 'stopped');
    assert.equal(host.runtimeInfo('fake-plugin').port, null);
  } finally {
    await host.stopAll();
    await env.restore();
  }
});

test('boot: an enabled plugin with the flag on and no running backend is started', async () => {
  const env = await makePluginRoot();
  const hostB = createPluginHost();
  try {
    await env.addPluginProject('aplug');
    const hostA = createPluginHost();
    await hostA.enable('fake-plugin');
    await hostA.setAutoStart('fake-plugin', true);

    const out = await hostB.autoStartAll();
    assert.deepEqual(out, { started: ['fake-plugin'], failed: [] });
    const row = await rowOf(hostB, 'fake-plugin');
    assert.equal(row.state, 'ready');
    assert.ok(pidAlive(row.pid), 'the started backend is a live process');
  } finally {
    await hostB.stopAll();
    await env.restore();
  }
});

test('boot: a backend adopted from the previous process is left running, not restarted', async () => {
  const env = await makePluginRoot();
  const hostA = createPluginHost();
  try {
    await env.addPluginProject('aplug');
    await hostA.enable('fake-plugin');
    await hostA.setAutoStart('fake-plugin', true);
    const running = await hostA.start('fake-plugin');

    const hostB = createPluginHost();
    const out = await hostB.autoStartAll();
    assert.deepEqual(out, { started: [], failed: [] });
    const row = await rowOf(hostB, 'fake-plugin');
    assert.equal(row.state, 'ready');
    assert.equal(row.pid, running.pid, 'same process');
    assert.equal(row.startedAt, running.startedAt, 'not restarted');
  } finally {
    await hostA.stopAll();
    await env.restore();
  }
});

test('boot: an enabled plugin with the flag off is left stopped', async () => {
  const env = await makePluginRoot();
  const hostB = createPluginHost();
  try {
    await env.addPluginProject('aplug');
    await createPluginHost().enable('fake-plugin');

    assert.deepEqual(await hostB.autoStartAll(), { started: [], failed: [] });
    assert.equal((await rowOf(hostB, 'fake-plugin')).state, 'stopped');
    assert.equal(hostB.runtimeInfo('fake-plugin').port, null);
  } finally {
    await hostB.stopAll();
    await env.restore();
  }
});

test('boot: a disabled plugin whose flag is on never starts', async () => {
  const env = await makePluginRoot();
  const hostB = createPluginHost();
  try {
    await env.addPluginProject('aplug');
    const hostA = createPluginHost();
    await hostA.enable('fake-plugin');
    await hostA.setAutoStart('fake-plugin', true);
    await hostA.disable('fake-plugin');

    assert.deepEqual(await hostB.autoStartAll(), { started: [], failed: [] });
    assert.equal((await rowOf(hostB, 'fake-plugin')).state, 'disabled');
    assert.equal(hostB.runtimeInfo('fake-plugin').port, null);
  } finally {
    await hostB.stopAll();
    await env.restore();
  }
});

test('boot: one failing auto-start blocks no other, does not reject, and lands on its row as crashed with one log line', async () => {
  const env = await makePluginRoot();
  const hostB = createPluginHost();
  const warnings = [];
  const realWarn = console.warn;
  try {
    await env.addPluginProject('aplug');
    await env.addPluginProject('crasher', { manifest: CRASHER });
    const hostA = createPluginHost();
    for (const id of ['fake-plugin', 'crasher']) {
      await hostA.enable(id);
      await hostA.setAutoStart(id, true);
    }

    console.warn = (...args) => { warnings.push(args.join(' ')); };
    const out = await hostB.autoStartAll();
    console.warn = realWarn;

    assert.deepEqual(out.started, ['fake-plugin']);
    assert.deepEqual(out.failed.map(f => f.id), ['crasher']);
    assert.equal((await rowOf(hostB, 'fake-plugin')).state, 'ready');
    const crashed = await rowOf(hostB, 'crasher');
    assert.equal(crashed.state, 'crashed');
    assert.match(crashed.crashTail, /boom/);
    assert.deepEqual(warnings.filter(w => w.includes('auto-start')).length, 1);
    assert.match(warnings.find(w => w.includes('auto-start')), /^plugins: auto-start of 'crasher' failed: /);
  } finally {
    console.warn = realWarn;
    await hostB.stopAll();
    await env.restore();
  }
});
