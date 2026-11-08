// Settings → Models → MCP auto-background: Instance.spawn owns
// CLAUDE_AUTO_BACKGROUND_TASKS and CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS on every
// session launch. It strips both (host and backend-pair values alike), then
// sets them only for a worker launch while spawn.autoBackground is on. The
// conductor never carries them, and the argv never changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, seedSessionJsonl } from './helpers.mjs';
import { setAutoBackground, AUTO_BACKGROUND_DEFAULT_MS } from '../src/appSettings.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');
const FLAG = 'CLAUDE_AUTO_BACKGROUND_TASKS';
const MS = 'CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS';

// Run fn with both ambient host values pinned, so a developer's exported vars
// cannot make an assertion vacuous.
async function withHostValues(values, fn) {
  const saved = { [FLAG]: process.env[FLAG], [MS]: process.env[MS] };
  const put = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  put(FLAG, values[FLAG]); put(MS, values[MS]);
  try { return await fn(); }
  finally { put(FLAG, saved[FLAG]); put(MS, saved[MS]); }
}

async function spawnIdle(ctx, body = {}) {
  const r = await api(ctx.baseUrl, 'POST', '/api/instances',
    { project: 'p', mode: 'bypassPermissions', model: 'claude-haiku-4-5', temp: true, ...body });
  assert.equal(r.status, 201, `spawn failed: ${JSON.stringify(r.body)}`);
  const inst = ctx.instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle' && inst._spawnArgv);
  return inst;
}

// Mask the per-launch ids (session id, the instance id inside the hook url, and
// the public session id inside the MCP url).
const maskIds = (inst) => inst._spawnArgv.map((a, i, argv) =>
  (argv[i - 1] === '--session-id' ? '<sid>' : a.replaceAll(inst.id, '<id>').replaceAll(inst.sessionId, '<sid>')));

async function boot(opts) {
  const ctx = await bootServer({ scenarioPath: SCENARIO, ...opts });
  const r = await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return ctx;
}

test('off: neither auto-background var is in a worker launch env', async () => {
  const ctx = await boot();
  try {
    await withHostValues({}, async () => {
      const inst = await spawnIdle(ctx);
      assert.equal(FLAG in inst._spawnEnv, false);
      assert.equal(MS in inst._spawnEnv, false);
    });
  } finally { await ctx.close(); }
});

test('on: a worker launch adds exactly the flag and the threshold in ms; the argv is unchanged', async () => {
  const ctx = await boot();
  try {
    await withHostValues({}, async () => {
      const off = await spawnIdle(ctx);
      await setAutoBackground({ enabled: true });
      const on = await spawnIdle(ctx);
      const added = Object.keys(on._spawnEnv).filter((k) => !(k in off._spawnEnv)).sort();
      const removed = Object.keys(off._spawnEnv).filter((k) => !(k in on._spawnEnv));
      assert.deepEqual(added, [FLAG, MS].sort());
      assert.deepEqual(removed, []);
      assert.equal(on._spawnEnv[FLAG], '1');
      assert.equal(on._spawnEnv[MS], String(AUTO_BACKGROUND_DEFAULT_MS));
      assert.equal(on._spawnEnv[MS], '120000');
      assert.deepEqual(maskIds(on), maskIds(off));
    });
  } finally { await ctx.close(); }
});

test('the threshold is read per launch: a resume after a threshold change carries the new value', async () => {
  const ctx = await boot();
  try {
    await withHostValues({}, async () => {
      await setAutoBackground({ enabled: true });
      const first = await spawnIdle(ctx, { temp: false });
      assert.equal(first._spawnEnv[MS], '120000', 'premise: launched at the default threshold');
      const sid = first.sessionId;
      await seedSessionJsonl(first.transcriptPlace, first.backingSessionId);
      await first.kill({ graceMs: 50 });
      await waitFor(() => !first.proc && (first.status === 'exited' || first.status === 'crashed'));

      await setAutoBackground({ thresholdMs: 30_000 });
      const resumed = await ctx.instances.create({ project: 'p', resume: sid, mode: 'bypassPermissions' });
      await waitFor(() => resumed.status === 'idle' && resumed._spawnArgv);
      assert.equal(resumed._spawnArgv.includes('--resume'), true);
      assert.equal(resumed._spawnEnv[FLAG], '1');
      assert.equal(resumed._spawnEnv[MS], '30000');
    });
  } finally { await ctx.close(); }
});

test('off strips host-exported values of both vars from a worker launch', async () => {
  const ctx = await boot();
  try {
    await withHostValues({ [FLAG]: '1', [MS]: '5000' }, async () => {
      const inst = await spawnIdle(ctx);
      assert.equal(FLAG in inst._spawnEnv, false);
      assert.equal(MS in inst._spawnEnv, false);
    });
  } finally { await ctx.close(); }
});

test('on overrides host-exported values with cc\'s', async () => {
  const ctx = await boot();
  try {
    await withHostValues({ [FLAG]: '0', [MS]: '5000' }, async () => {
      await setAutoBackground({ enabled: true, thresholdMs: 40_000 });
      const inst = await spawnIdle(ctx);
      assert.equal(inst._spawnEnv[FLAG], '1');
      assert.equal(inst._spawnEnv[MS], '40000');
    });
  } finally { await ctx.close(); }
});

test('the .conduct conductor launch carries neither var, even when on and host-exported', async () => {
  const ctx = await boot({ scenarioPath: SCENARIO_WS });
  try {
    await withHostValues({ [FLAG]: '1', [MS]: '5000' }, async () => {
      await setAutoBackground({ enabled: true });
      await api(ctx.baseUrl, 'POST', '/api/projects/.conduct/ensure');
      const inst = await spawnIdle(ctx, { project: '.conduct' });
      assert.equal(FLAG in inst._spawnEnv, false);
      assert.equal(MS in inst._spawnEnv, false);
    });
  } finally { await ctx.close(); }
});
