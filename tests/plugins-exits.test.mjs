import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPluginHost } from '../src/plugins/registry.ts';
import { pidAlive } from '../src/plugins/ports.ts';
import { orchStoreRoot } from '../src/projects.ts';
import { hasMarker } from './procTree.mjs';
import { makePluginRoot, waitFor } from './plugin-helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OLD_CC = path.join(here, 'fixtures', 'plugin-host-parent.mjs');

function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 5000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

const rowOf = async (host) => (await host.list()).find(r => r.id === 'fake-plugin');

// Teardown registered by the caller BEFORE any await: kills only a backend
// group proven to be this run's (CC_TEST_RUN_ID in its environ).
function reaper(t) {
  const held = { pids: new Set() };
  t.after(() => {
    for (const pid of held.pids) {
      if (hasMarker(pid, process.env.CC_TEST_RUN_ID)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
    }
  });
  return held;
}

// A previous cc process starts the (already enabled) backend and dies, leaving it running.
async function startInOldCc(held) {
  const old = spawn(process.execPath, [OLD_CC], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  old.stdout.on('data', (d) => { out += d; });
  await new Promise((res) => old.once('exit', res));
  const info = JSON.parse(out.trim().split('\n').pop());
  held.pids.add(info.pid);
  return info;
}

const killGroup = async (pid) => { process.kill(-pid, 'SIGKILL'); await waitFor(() => !pidAlive(pid)); };

// A spawned child's exit record carries the exact status, and survives both a
// cc restart and the next start overwriting runtime.json.
test('a spawned child\'s exit is recorded durably, across a host restart and a later start', async (t) => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  t.after(async () => { await host.stopAll(); await env.restore(); });
  await env.addPluginProject('aplug');
  await host.enable('fake-plugin');
  await host.start('fake-plugin');
  const { port } = host.runtimeInfo('fake-plugin');
  await get(port, '/exit?code=3');
  const rec = await waitFor(async () => (await rowOf(host)).exits?.[0]);
  assert.equal(rec.how, 'exit');
  assert.equal(rec.code, 3);
  assert.equal(rec.signal, null);
  assert.equal(rec.stopRequested, false);

  const host2 = createPluginHost(); // a restarted cc
  t.after(() => host2.stopAll());
  assert.deepEqual((await rowOf(host2)).exits[0], rec, 'a fresh host lists the same record');

  await host2.start('fake-plugin'); // overwrites runtime.json
  const after = (await rowOf(host2)).exits;
  assert.deepEqual(after[0], rec, 'the new start did not displace it');
});

// An adopted backend's death is recorded on the next status probe, with its log tail.
test('an adopted backend killed behind the host\'s back is recorded as gone on status()', async (t) => {
  const held = reaper(t);
  const env = await makePluginRoot();
  const host1 = createPluginHost();
  t.after(() => env.restore());
  await env.addPluginProject('aplug');
  await host1.enable('fake-plugin');
  const { pid } = await startInOldCc(held);

  const host2 = createPluginHost();
  const before = (await rowOf(host2));
  assert.equal(before.state, 'ready', 'adopted');
  await killGroup(pid);
  const row = await host2.status('fake-plugin');
  assert.equal(row.state, 'crashed');
  const rec = row.exits[0];
  assert.equal(rec.how, 'gone');
  assert.equal(rec.code, null);
  assert.equal(rec.signal, null);
  assert.equal(rec.pid, pid);
  assert.ok(rec.lastAliveAt, 'adoption saw it alive');
  assert.ok(rec.lastAliveAt <= rec.at);
  assert.match(row.crashTail, /fake-plugin listening/, 'the crash tail is the backend\'s own log');

  const host3 = createPluginHost();
  assert.deepEqual((await rowOf(host3)).exits[0], rec, 'the record is on disk');
});

// The next proxied request / MCP call records an adopted backend's death and tightens the bound.
test('ensureStarted on an adopted backend records its death and refuses with 503 crashed', async (t) => {
  const held = reaper(t);
  const env = await makePluginRoot();
  const host1 = createPluginHost();
  t.after(() => env.restore());
  await env.addPluginProject('aplug');
  await host1.enable('fake-plugin');
  const { pid } = await startInOldCc(held);

  const host2 = createPluginHost();
  assert.equal((await rowOf(host2)).state, 'ready');
  const touched = new Date().toISOString();
  await host2.ensureStarted('fake-plugin'); // alive: a touch
  await killGroup(pid);
  await assert.rejects(host2.ensureStarted('fake-plugin'), (e) => e.statusCode === 503 && e.status === 'crashed');
  const rec = (await rowOf(host2)).exits[0];
  assert.equal(rec.how, 'gone');
  assert.ok(rec.lastAliveAt >= touched, 'the touch tightened lastAliveAt past adoption');
});

// A death while no cc watched is recorded, not silently pruned.
test('a backend that died while no cc was running is recorded as gone at boot', async (t) => {
  const held = reaper(t);
  const env = await makePluginRoot();
  const host1 = createPluginHost();
  t.after(() => env.restore());
  await env.addPluginProject('aplug');
  await host1.enable('fake-plugin');
  const { pid } = await startInOldCc(held);
  await killGroup(pid);

  const host3 = createPluginHost();
  const row = await rowOf(host3);
  assert.equal(row.state, 'stopped');
  assert.equal(row.exits[0].how, 'gone');
  assert.equal(row.exits[0].pid, pid);
  assert.equal(row.exits[0].lastAliveAt, null);
});

// cc-initiated exits are distinguishable from crashes.
test('Stop is recorded with stopRequested, for a spawned and for an adopted backend', async (t) => {
  const held = reaper(t);
  const env = await makePluginRoot();
  const host = createPluginHost();
  t.after(async () => { await host.stopAll(); await env.restore(); });
  await env.addPluginProject('aplug');
  await host.enable('fake-plugin');
  await host.start('fake-plugin');
  const spawnedPid = (await host.status('fake-plugin')).pid;
  await host.stop('fake-plugin');
  const spawned = await waitFor(async () => (await rowOf(host)).exits?.[0]);
  assert.equal(spawned.how, 'exit');
  assert.equal(spawned.stopRequested, true);
  assert.equal(spawned.pid, spawnedPid);

  const { pid } = await startInOldCc(held);
  const host2 = createPluginHost();
  assert.equal((await rowOf(host2)).state, 'ready');
  await host2.stop('fake-plugin');
  await waitFor(() => !pidAlive(pid));
  const adopted = (await rowOf(host2)).exits[0];
  assert.equal(adopted.how, 'stopped');
  assert.equal(adopted.stopRequested, true);
  assert.equal(adopted.pid, pid);
});

// Passive touches bound a running backend's log, throttled on the hot path.
test('status() trims an over-cap log; ensureStarted\'s check is throttled', async (t) => {
  const env = await makePluginRoot();
  const sizeOf = async () => (await fs.stat(path.join(orchStoreRoot(), 'plugins', 'logs', 'fake-plugin', 'backend.log'))).size;
  const host = createPluginHost({ _logMaxBytes: 4096, _logKeepBytes: 1024, _logCheckMinMs: 0 });
  t.after(async () => { await host.stopAll(); await env.restore(); });
  await env.addPluginProject('aplug');
  await host.enable('fake-plugin');
  await host.start('fake-plugin');
  const { port } = host.runtimeInfo('fake-plugin');
  await get(port, '/say?n=500');
  assert.ok(await sizeOf() > 4096, 'the log grew past the cap');
  await host.status('fake-plugin');
  await waitFor(async () => (await sizeOf()) <= 1024 + 200);
  const log = await fs.readFile(path.join(orchStoreRoot(), 'plugins', 'logs', 'fake-plugin', 'backend.log'), 'utf8');
  assert.ok(log.includes('say-err-499'), 'the newest output survived the trim');

  // Default throttle: a second ensureStarted inside the window leaves a grown log alone.
  const host2 = createPluginHost({ _logMaxBytes: 4096, _logKeepBytes: 1024 });
  t.after(() => host2.stopAll());
  await rowOf(host2); // adopts
  await host2.ensureStarted('fake-plugin'); // first check: in-window start, runs
  await get(port, '/say?n=500');
  const grown = await sizeOf();
  assert.ok(grown > 4096);
  await host2.ensureStarted('fake-plugin'); // inside the 60 s window: no check
  await new Promise(r => setTimeout(r, 100));
  assert.equal(await sizeOf(), grown, 'throttled: not trimmed again');
});
