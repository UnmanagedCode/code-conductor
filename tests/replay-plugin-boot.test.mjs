// A `--view` replay's boot (start({replay: true}), server.ts) skips the plugin
// host's init() + autoStartAll(), so an enabled auto-start plugin is not running
// after it; an explicit start (a plugin view the user opens) still starts it.
// Control: the same boot without `replay` autostarts it. The absence window is
// anchored to the control's measured boot→ready latency: no production seam
// reaches the supervisor from start() (createServer builds the plugin host with
// no supervisor injection), so the replay arm waits several multiples of it.
// In-process start() on a throwaway root; the plugin backend is detached, so close() stops it by the
// registry and then by the recorded pgid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { start } from '../server.ts';
import { settleSessionWrites } from '../src/sessionStore.ts';
import { ensureSafeStoreEnv } from './safeStoreRoot.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { rmrf } from './rmrf.mjs';
import { waitFor } from './poll.mjs';
import { FAKE_PLUGIN_DIR } from './plugin-helpers.mjs';

const SAFE = ensureSafeStoreEnv();

async function bootWithPlugin(opts) {
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
  const booted = await start({ port: 0, host: '127.0.0.1', buildWeb: false, syncDeps: false, headless: true, ...opts });
  const base = `http://127.0.0.1:${booted.port}`;
  const row = async () => (await (await fetch(`${base}/api/plugins`)).json()).rows.find((r) => r.id === 'fake-plugin');
  return {
    base, row,
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

// Invariant (control): without `replay` the boot autostarts the enabled plugin.
let controlLatencyMs = null;
const WINDOW_MULTIPLE = 5;

test('a headless boot autostarts an enabled auto-start plugin', async () => {
  const t0 = Date.now();
  const s = await bootWithPlugin({});
  try {
    const row = await waitFor(async () => { const r = await s.row(); return r?.state === 'ready' ? r : null; }, { timeout: 20_000, interval: 100, label: 'the plugin ready' });
    assert.ok(row.pid);
    controlLatencyMs = Date.now() - t0;
  } finally { await s.close(); }
});

// Invariant: a replay's boot leaves the plugin unstarted (listing it runs the
// host's lazy init, which the control's autostart chains onto), and an explicit
// start still brings it up.
test('a replay boot leaves an auto-start plugin stopped; an explicit start still starts it', async () => {
  const s = await bootWithPlugin({ replay: true, viewOnly: true });
  try {
    const before = await s.row();
    assert.ok(before, 'the plugin is discovered');
    assert.equal(before.autoStart, true);
    assert.notEqual(before.state, 'ready');
    assert.equal(before.pid ?? null, null, 'no backend process');
    assert.ok(controlLatencyMs !== null, 'premise: the control measured its boot→ready latency');
    await new Promise((r) => setTimeout(r, WINDOW_MULTIPLE * controlLatencyMs));
    assert.equal((await s.row()).pid ?? null, null, `still none ${WINDOW_MULTIPLE}x the control's boot→ready latency later`);
    const res = await fetch(`${s.base}/api/plugins/fake-plugin/start`, { method: 'POST' });
    assert.equal(res.status, 200, await res.text());
    const row = await waitFor(async () => { const r = await s.row(); return r?.state === 'ready' ? r : null; }, { timeout: 20_000, interval: 100, label: 'the plugin ready' });
    assert.ok(row.pid);
  } finally { await s.close(); }
});
