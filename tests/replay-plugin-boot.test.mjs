// A `--view` replay's boot (start({replay: true}), server.ts) skips the plugin
// host's init() + autoStartAll(), so an enabled auto-start plugin is not spawned
// at boot; an explicit start (a plugin view the user opens) still spawns it.
// Control: the same boot without `replay` spawns it. The evidence is the
// platform handed through start({platform}) to the plugin supervisor, whose
// spawnChild is the only boot-path caller of spawnOptions('daemon'): a counting
// wrapper records each such call. In-process start() on a throwaway root; the
// plugin backend is detached, so close() stops it by the registry and then by
// the recorded pgid.

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

async function bootWithPlugin(opts) {
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
  };
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const booted = await start({ port: 0, host: '127.0.0.1', buildWeb: false, syncDeps: false, headless: true, platform, ...opts });
  const base = `http://127.0.0.1:${booted.port}`;
  const row = async () => (await (await fetch(`${base}/api/plugins`)).json()).rows.find((r) => r.id === 'fake-plugin');
  return {
    base, row, daemonSpawns,
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

// Invariant (control): without `replay` the boot spawns the enabled plugin's backend.
test('a headless boot spawns an enabled auto-start plugin', async () => {
  const s = await bootWithPlugin({});
  try {
    const row = await waitFor(async () => { const r = await s.row(); return r?.state === 'ready' ? r : null; }, { timeout: 20_000, interval: 100, label: 'the plugin ready' });
    assert.ok(row.pid);
    assert.ok(s.daemonSpawns() >= 1, 'a daemon spawn was requested');
  } finally { await s.close(); }
});

// Invariant: a replay's boot requests no daemon spawn (listing the plugins runs
// the host's lazy init, which the control's autostart chains onto), and an
// explicit start requests one and brings the backend up.
test('a replay boot spawns no auto-start plugin; an explicit start still spawns it', async () => {
  const s = await bootWithPlugin({ replay: true, viewOnly: true });
  try {
    const before = await s.row();
    assert.ok(before, 'the plugin is discovered');
    assert.equal(before.autoStart, true);
    assert.equal(s.daemonSpawns(), 0, 'no daemon spawn at boot');
    assert.equal(before.pid ?? null, null, 'no backend process');
    const res = await fetch(`${s.base}/api/plugins/fake-plugin/start`, { method: 'POST' });
    assert.equal(res.status, 200, await res.text());
    const row = await waitFor(async () => { const r = await s.row(); return r?.state === 'ready' ? r : null; }, { timeout: 20_000, interval: 100, label: 'the plugin ready' });
    assert.ok(row.pid);
    assert.ok(s.daemonSpawns() >= 1, 'the explicit start requested a daemon spawn');
  } finally { await s.close(); }
});
