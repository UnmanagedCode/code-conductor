// What a `--replay`'s plugin handling shows end to end: the control (start()
// without `launchless`) autostarts an enabled auto-start plugin, as does a
// replay under `--ui interact` (not launchless), and in a launchless replay
// (`--ui view`) an explicit POST /api/plugins/:id/start still starts it
// lazily. The boot-time skip itself (`if (!launchless)` around the host's init()+autoStartAll()
// chain in startHolding) is NOT proved here — it is pinned structurally in
// tests/web-build-wiring.test.mjs. No behavioural test can see it: the chain
// settles before start() returns (init is already settled by the boot's
// convention regeneration), and an explicit start joins a boot start still in
// flight, so a spawn count after an explicit start is 1 with or without the skip.
// The evidence of a spawn is the platform handed through start({platform}) to
// the plugin supervisor, whose spawnChild is the only boot-path caller of
// spawnOptions('daemon'). In-process start() on a throwaway root; the plugin
// backend is detached, so close() stops it by the registry and then by the
// recorded pgid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { start } from '../server.ts';
import { hostPlatform } from '../src/platform/index.ts';
import { settleSessionWrites } from '../src/sessionStore.ts';
import { ensureSafeStoreEnv } from './safeStoreRoot.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { rmrf } from './rmrf.mjs';
import { waitFor } from './poll.mjs';
import { FAKE_PLUGIN_DIR } from './plugin-helpers.mjs';

const SAFE = ensureSafeStoreEnv();

// The host platform, counting the spawnOptions roles asked of it.
function countingPlatform() {
  const roles = [];
  const platform = Object.create(hostPlatform, {
    spawnOptions: { value: (role) => { roles.push(role); return hostPlatform.spawnOptions(role); } },
  });
  return { platform, daemonSpawns: () => roles.filter((r) => r === 'daemon').length };
}

async function bootWithPlugin({ env: extraEnv = {}, ...opts } = {}) {
  const { platform, daemonSpawns } = countingPlatform();
  const home = await mkdtemp('cc-replay-plug-');
  const root = path.join(home, 'project');
  await fs.mkdir(path.join(home, '.claude', 'projects'), { recursive: true });
  await fs.cp(FAKE_PLUGIN_DIR, path.join(root, 'autoplug'), { recursive: true });
  const pluginsDir = path.join(root, '.code-conductor', 'plugins');
  await fs.mkdir(pluginsDir, { recursive: true });
  await fs.writeFile(path.join(pluginsDir, 'registry.json'), JSON.stringify({
    plugins: { 'fake-plugin': { project: 'autoplug', enabled: true, activeVersion: { type: 'main' }, autoStart: true } },
  }));
  const env = {
    HOME: home, PROJECTS_ROOT: root,
    CLAUDE_PROJECTS_ROOT: path.join(home, '.claude', 'projects'),
    CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
    CLAUDE_BIN: `${process.execPath} -e 0`,
    ANTHROPIC_API_KEY: 'replay-plugin-boot-fake-key',
    ...extraEnv,
  };
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const booted = await start({ port: 0, host: '127.0.0.1', buildWeb: false, syncDeps: false, headless: true, platform, ...opts });
  const base = `http://127.0.0.1:${booted.port}`;
  const row = async () => (await (await fetch(`${base}/api/plugins`)).json()).rows.find((r) => r.id === 'fake-plugin');
  return {
    base, row, daemonSpawns, instances: booted.instances,
    async close() {
      const { server, instances, wss, pluginHost } = booted;
      if (instances) await instances.shutdown();
      const runtime = await fs.readFile(path.join(pluginsDir, 'runtime.json'), 'utf8').then(JSON.parse, () => ({}));
      if (pluginHost) await pluginHost.stopAll();
      for (const rec of Object.values(runtime)) { try { process.kill(-rec.pgid, 'SIGKILL'); } catch { /* gone */ } }
      wss.close();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await settleSessionWrites();
      booted.rootLock.releaseSync();
      for (const [k, v] of Object.entries(prev)) {
        if (v !== undefined) process.env[k] = v;
        else if (k === 'PROJECTS_ROOT') process.env[k] = SAFE.projectsRoot;
        else if (k === 'CLAUDE_PROJECTS_ROOT') process.env[k] = SAFE.claudeProjectsRoot;
        else delete process.env[k];
      }
      await rmrf(home);
    },
  };
}

// Invariant (control): without `launchless` the boot spawns the enabled plugin's backend.
test('a headless boot spawns an enabled auto-start plugin', async () => {
  const s = await bootWithPlugin({});
  try {
    const row = await waitFor(async () => { const r = await s.row(); return r?.state === 'ready' ? r : null; }, { timeout: 20_000, interval: 100, label: 'the plugin ready' });
    assert.ok(row.pid);
    assert.ok(s.daemonSpawns() >= 1, 'a daemon spawn was requested');
  } finally { await s.close(); }
});

// Invariant: a replay that can launch (`--ui interact`, launchless false) gets
// the boot's plugin autostart back.
test('a replay under --ui interact autostarts an enabled auto-start plugin', async () => {
  const s = await bootWithPlugin({ uiMode: 'interact', launchless: false });
  try {
    const row = await waitFor(async () => { const r = await s.row(); return r?.state === 'ready' ? r : null; }, { timeout: 20_000, interval: 100, label: 'the plugin ready' });
    assert.ok(row.pid);
    assert.ok(s.daemonSpawns() >= 1, 'a daemon spawn was requested');
  } finally { await s.close(); }
});

// Invariant: in a launchless replay an explicit start requests a daemon spawn
// and brings the backend up (the lazy start a plugin view relies on).
test('in a launchless replay, an explicit plugin start still spawns the backend', async () => {
  const s = await bootWithPlugin({ launchless: true, uiMode: 'view' });
  try {
    const before = await s.row();
    assert.ok(before, 'the plugin is discovered');
    assert.equal(before.autoStart, true);
    const res = await fetch(`${s.base}/api/plugins/fake-plugin/start`, { method: 'POST' });
    assert.equal(res.status, 200, await res.text());
    const row = await waitFor(async () => { const r = await s.row(); return r?.state === 'ready' ? r : null; }, { timeout: 20_000, interval: 100, label: 'the plugin ready' });
    assert.ok(row.pid);
    assert.ok(s.daemonSpawns() >= 1, 'the explicit start requested a daemon spawn');
  } finally { await s.close(); }
});

// Counts the usage monitor's poll cycles from here on: its interval callback
// calls `this._tick()` on every tick, so the count is the polls that ran.
function countPolls(instances) {
  const counter = { n: 0 };
  instances._usageMonitor._tick = async () => { counter.n++; };
  return counter;
}
const FAST_POLL = { ORCH_USAGE_POLL_MS: '10' };

// Invariant (control): a replay that can launch starts the usage monitor, so
// with a 10ms cadence its poll runs.
test('a replay that can launch polls usage', async () => {
  const s = await bootWithPlugin({ uiMode: 'interact', launchless: false, env: FAST_POLL });
  try {
    const polls = countPolls(s.instances);
    await waitFor(() => polls.n > 0, { timeout: 5_000, interval: 10, label: 'a usage poll' });
  } finally { await s.close(); }
});

// Invariant: a launchless replay starts no usage monitor — no poll runs over
// many cadences, where the control above polls within the first few.
test('a launchless replay never polls usage', async () => {
  const s = await bootWithPlugin({ launchless: true, uiMode: 'view', env: FAST_POLL });
  try {
    const polls = countPolls(s.instances);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(polls.n, 0);
    assert.equal(s.instances._usageMonitor.timer, null, 'no poll timer was armed');
  } finally { await s.close(); }
});
