import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPluginHost } from '../src/plugins/registry.ts';
import { pidAlive } from '../src/plugins/ports.ts';
import { orchStoreRoot } from '../src/projects.ts';
import { makePluginRoot } from './plugin-helpers.mjs';

// Characterization pin for the ON-DISK envelopes of the two persisted files
// the plugin host owns:
//
//   <orchStoreRoot()>/plugins/registry.json  {plugins: {<id>: {project, enabled, activeVersion}}}
//   <orchStoreRoot()>/plugins/runtime.json   {<id>: {pid, pgid, port, startedAt, gitHead}}
//
// Existing coverage only round-trips this state through the same code that
// wrote it (a second host sees the first host's enable), so a change to the
// envelope — a renamed key, a dropped nesting level, a reset record — would
// stay invisible. These assertions read the raw JSON instead.
//
// Every expected shape is HAND-TYPED. A shape derived from the file it is
// checking would pin nothing.

const registryFile = () => path.join(orchStoreRoot(), 'plugins', 'registry.json');
const runtimeFile = () => path.join(orchStoreRoot(), 'plugins', 'runtime.json');

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

test('registry.json envelope: enable + setActiveVersion, then disable retains project and pin', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    await env.addPluginProject('aplug');
    await host.enable('fake-plugin');
    await host.setActiveVersion('fake-plugin', { type: 'main' });

    assert.deepEqual(await readJson(registryFile()), {
      plugins: {
        'fake-plugin': { project: 'aplug', enabled: true, activeVersion: { type: 'main' } },
      },
    }, 'the registry.json envelope is {plugins:{<id>:{project, enabled, activeVersion}}}');

    // disable is a flag flip, not a record reset — losing `activeVersion` here
    // would silently unpin a worktree-pinned plugin on the next enable.
    await host.disable('fake-plugin');
    assert.deepEqual(await readJson(registryFile()), {
      plugins: {
        'fake-plugin': { project: 'aplug', enabled: false, activeVersion: { type: 'main' } },
      },
    });
  } finally {
    await host.stopAll();
    await env.restore();
  }
});

test('runtime.json record shape after a start', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    await env.addPluginProject('aplug');
    await host.enable('fake-plugin');
    await host.ensureStarted('fake-plugin');

    const runtime = await readJson(runtimeFile());
    assert.deepEqual(Object.keys(runtime), ['fake-plugin']);
    assert.deepEqual(Object.keys(runtime['fake-plugin']).sort(),
      ['gitHead', 'pgid', 'pid', 'port', 'startedAt'],
      'describeRow, runtimeInfo and mcpBridge.portFor all read these keys by name');
    const rec = runtime['fake-plugin'];
    assert.equal(typeof rec.pid, 'number');
    assert.equal(typeof rec.pgid, 'number');
    assert.equal(typeof rec.port, 'number');
    assert.equal(typeof rec.startedAt, 'string');
    assert.equal(rec.gitHead, null, 'the tmp project copy is not a git repo');
  } finally {
    await host.stopAll();
    await env.restore();
  }
});

// Adopt-don't-drain has two halves. The in-memory half (the row goes back to
// 'stopped') is covered elsewhere; the PERSISTENCE half — writing the pruned
// record set back out — is not, so an adopt pass that forgot to save would
// leave a resurrectable dead record on disk and still pass today.
//
// The dead record is HAND-WRITTEN rather than produced by killing a child this
// process started: a host that spawned the child also owns the supervisor exit
// handler, which clears runtime.json on its own and would mask a broken adopt.
// A record left behind by a previous conductor process (which is exactly what
// adopt exists for) has no such handler.
test('adopt clears an orphaned dead record FROM DISK', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    await env.addPluginProject('aplug');
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    assert.ok(dead && !pidAlive(dead), 'the fabricated pid is genuinely dead');

    await fs.mkdir(path.dirname(registryFile()), { recursive: true });
    await fs.writeFile(registryFile(), JSON.stringify({
      plugins: { 'fake-plugin': { project: 'aplug', enabled: true, activeVersion: { type: 'main' } } },
    }));
    await fs.writeFile(runtimeFile(), JSON.stringify({
      'fake-plugin': { pid: dead, pgid: dead, port: 1, startedAt: new Date().toISOString(), gitHead: null },
    }));

    assert.equal((await host.list()).find(r => r.id === 'fake-plugin').state, 'stopped');
    assert.deepEqual(await readJson(runtimeFile()), {},
      'the stale record is written out as cleared, not just dropped in memory');
  } finally {
    await host.stopAll();
    await env.restore();
  }
});

test('adopt leaves a LIVE record on disk untouched', async () => {
  const env = await makePluginRoot();
  const host1 = createPluginHost();
  try {
    await env.addPluginProject('aplug');
    await host1.enable('fake-plugin');
    await host1.ensureStarted('fake-plugin');
    const { pid } = await host1.status('fake-plugin');

    const before = await readJson(runtimeFile());
    const host2 = createPluginHost();
    assert.equal((await host2.list()).find(r => r.id === 'fake-plugin').state, 'ready');
    assert.deepEqual(await readJson(runtimeFile()), before,
      'adopting a live child must not rewrite or clear its record');
    assert.ok(pidAlive(pid), 'the adopted child is still running');
  } finally {
    await host1.stopAll();
    await env.restore();
  }
});
