// The node suite never builds web/dist: every link of that chain is pinned here.
// tests/run.mjs sets CC_SKIP_WEB_BUILD=1 for its children → server.ts's entry
// block calls start(entryStartOptions(process.env)), which maps it to
// buildWeb:false → start({buildWeb:false}) never invokes the build. Observed through an injected build function, so an up-to-date
// web/dist stamp (which makes the real build a no-op) cannot hide a regression.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { entryStartOptions, start } from '../server.ts';
import { settleSessionWrites } from '../src/sessionStore.ts';
import { ensureSafeStoreEnv } from './safeStoreRoot.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { rmrf } from './rmrf.mjs';

const SAFE = ensureSafeStoreEnv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Read from the source, not this process's env: a CC_SKIP_WEB_BUILD exported in
// the developer's shell would otherwise mask its removal from the runner.
test('tests/run.mjs sets CC_SKIP_WEB_BUILD=1 before it starts any test file', async () => {
  const src = await fs.readFile(path.join(ROOT, 'tests', 'run.mjs'), 'utf8');
  const set = src.search(/^process\.env\.CC_SKIP_WEB_BUILD = '1';$/m);
  const run = src.search(/^const stream = run\(/m);
  assert.ok(run !== -1, 'premise: the run() call is found');
  assert.ok(set !== -1, "tests/run.mjs sets process.env.CC_SKIP_WEB_BUILD = '1'");
  assert.ok(set < run, 'and does so before run() forks the test files');
  assert.equal(process.env.CC_SKIP_WEB_BUILD, '1', 'so this file, one of them, inherits it');
});

test('entryStartOptions: PORT/HOST with their defaults; only CC_SKIP_WEB_BUILD=1 turns the boot build off', () => {
  assert.deepEqual(entryStartOptions({}), { port: 8787, host: '127.0.0.1', buildWeb: true });
  assert.deepEqual(entryStartOptions({ PORT: '9123', HOST: '0.0.0.0', CC_SKIP_WEB_BUILD: '1' }), { port: 9123, host: '0.0.0.0', buildWeb: false });
  for (const v of ['', '0', 'true', 'yes', ' 1']) {
    assert.equal(entryStartOptions({ CC_SKIP_WEB_BUILD: v }).buildWeb, true, JSON.stringify(v));
  }
});

test('server.ts\'s entry block starts the server with exactly start(entryStartOptions(process.env))', async () => {
  const src = await fs.readFile(path.join(ROOT, 'server.ts'), 'utf8');
  const entry = /^if \(process\.argv\[1\] && import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href\) \{\n([\s\S]*?)^\}$/m.exec(src);
  assert.ok(entry, 'premise: the entry block is found');
  assert.deepEqual(entry[1].match(/\bstart\([^)]*\)?\)?/g), ['start(entryStartOptions(process.env))']);
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
