// The node suite never builds web/dist: every link of that chain is pinned here.
// tests/run.mjs sets CC_SKIP_WEB_BUILD=1 for its children → server.ts's entry
// block maps it through buildWebFromEnv → start({buildWeb:false}) never invokes
// the build. Observed through an injected build function, so an up-to-date
// web/dist stamp (which makes the real build a no-op) cannot hide a regression.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { buildWebFromEnv, start } from '../server.ts';
import { settleSessionWrites } from '../src/sessionStore.ts';
import { ensureSafeStoreEnv } from './safeStoreRoot.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { rmrf } from './rmrf.mjs';

const SAFE = ensureSafeStoreEnv();

test('tests/run.mjs runs every test file with CC_SKIP_WEB_BUILD=1', () => {
  assert.equal(process.env.CC_SKIP_WEB_BUILD, '1');
});

test('buildWebFromEnv: only CC_SKIP_WEB_BUILD=1 turns the boot build off', () => {
  assert.equal(buildWebFromEnv({ CC_SKIP_WEB_BUILD: '1' }), false);
  for (const v of [undefined, '', '0', 'true', 'yes', ' 1']) {
    assert.equal(buildWebFromEnv(v === undefined ? {} : { CC_SKIP_WEB_BUILD: v }), true, JSON.stringify(v));
  }
});

// A real in-process start() on port 0 against a throwaway store, with the web
// build replaced by a counter. CLAUDE_BIN is a node that exits at once, so the
// boot readiness probe spawns nothing that outlives the test.
async function startWith(buildWeb) {
  const home = await mkdtemp('cc-webwire-');
  const env = {
    PROJECTS_ROOT: path.join(home, 'projects'),
    CLAUDE_PROJECTS_ROOT: path.join(home, 'claude', 'projects'),
    CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
    CLAUDE_BIN: `${process.execPath} -e 0`,
    ANTHROPIC_API_KEY: 'web-build-wiring-fake-key',
  };
  await fs.mkdir(env.PROJECTS_ROOT, { recursive: true });
  await fs.mkdir(env.CLAUDE_PROJECTS_ROOT, { recursive: true });
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  let calls = 0;
  const booted = await start({ port: 0, host: '127.0.0.1', buildWeb, webBuild: async () => { calls++; } });
  return {
    calls: () => calls,
    async close() {
      const { server, instances, wss, pluginHost } = booted;
      if (instances) await instances.shutdown();
      if (pluginHost) await pluginHost.stopAll();
      wss.close();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await settleSessionWrites();
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

test('start({buildWeb:false}) never invokes the web build; buildWeb:true invokes it once', async (t) => {
  await t.test('buildWeb: false', async () => {
    const s = await startWith(false);
    try { assert.equal(s.calls(), 0); } finally { await s.close(); }
  });
  await t.test('buildWeb: true (control)', async () => {
    const s = await startWith(true);
    try { assert.equal(s.calls(), 1); } finally { await s.close(); }
  });
});
