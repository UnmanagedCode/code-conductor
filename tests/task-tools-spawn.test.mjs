// Settings → Models → Task tools: when spawn.taskTools is on, Instance.spawn
// sets CLAUDE_CODE_ENABLE_TODO_TOOLS=1 on the CLI's env for every launch (fresh,
// resume, conductor). Off sets and strips nothing, and the argv never changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, seedSessionJsonl } from './helpers.mjs';
import { setTaskToolsEnabled } from '../src/appSettings.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');
const VAR = 'CLAUDE_CODE_ENABLE_TODO_TOOLS';

// Run fn with the ambient host value pinned, so a developer's exported var
// cannot make an assertion vacuous.
async function withHostValue(value, fn) {
  const saved = process.env[VAR];
  if (value === undefined) delete process.env[VAR]; else process.env[VAR] = value;
  try { return await fn(); }
  finally { if (saved === undefined) delete process.env[VAR]; else process.env[VAR] = saved; }
}

async function spawnIdle(ctx, body = {}) {
  const r = await api(ctx.baseUrl, 'POST', '/api/instances',
    { project: 'p', mode: 'bypassPermissions', model: 'claude-haiku-4-5', temp: true, ...body });
  assert.equal(r.status, 201, `spawn failed: ${JSON.stringify(r.body)}`);
  const inst = ctx.instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle' && inst._spawnArgv);
  return inst;
}

// Mask the per-launch ids (session id, and the instance id inside the hook/MCP urls).
const maskIds = (inst) => inst._spawnArgv.map((a, i, argv) =>
  (argv[i - 1] === '--session-id' ? '<sid>' : a.replaceAll(inst.id, '<id>')));

async function boot(opts) {
  const ctx = await bootServer({ scenarioPath: SCENARIO, ...opts });
  const r = await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return ctx;
}

test('off: the launch env has no task-tools var and the argv names no tool flag', async () => {
  const ctx = await boot();
  try {
    await withHostValue(undefined, async () => {
      const inst = await spawnIdle(ctx);
      assert.equal(VAR in inst._spawnEnv, false);
      for (const flag of ['--tools', '--allowedTools', '--allowed-tools']) {
        assert.equal(inst._spawnArgv.includes(flag), false, flag);
      }
    });
  } finally { await ctx.close(); }
});

test('on: only the env var is added; the argv is unchanged', async () => {
  const ctx = await boot();
  try {
    await withHostValue(undefined, async () => {
      const off = await spawnIdle(ctx);
      await setTaskToolsEnabled(true);
      const on = await spawnIdle(ctx);
      assert.equal(on._spawnEnv[VAR], '1');
      const added = Object.keys(on._spawnEnv).filter((k) => !(k in off._spawnEnv));
      const removed = Object.keys(off._spawnEnv).filter((k) => !(k in on._spawnEnv));
      assert.deepEqual(added, [VAR]);
      assert.deepEqual(removed, []);
      assert.deepEqual(maskIds(on), maskIds(off));
    });
  } finally { await ctx.close(); }
});

test('a resume after the setting flips carries the var, with no restart', async () => {
  const ctx = await boot();
  try {
    await withHostValue(undefined, async () => {
      const first = await spawnIdle(ctx, { temp: false });
      assert.equal(VAR in first._spawnEnv, false, 'premise: launched with the setting off');
      const sid = first.sessionId;
      await seedSessionJsonl(first.transcriptPlace, first.backingSessionId);
      await first.kill({ graceMs: 50 });
      await waitFor(() => !first.proc && (first.status === 'exited' || first.status === 'crashed'));

      await setTaskToolsEnabled(true);
      const resumed = await ctx.instances.create({ project: 'p', resume: sid, mode: 'bypassPermissions' });
      await waitFor(() => resumed.status === 'idle' && resumed._spawnArgv);
      assert.equal(resumed._spawnArgv.includes('--resume'), true);
      assert.equal(resumed._spawnEnv[VAR], '1');
    });
  } finally { await ctx.close(); }
});

test('the .conduct orchestrator launch carries the var when on', async () => {
  const ctx = await boot({ scenarioPath: SCENARIO_WS });
  try {
    await withHostValue(undefined, async () => {
      await setTaskToolsEnabled(true);
      await api(ctx.baseUrl, 'POST', '/api/projects/.conduct/ensure');
      const inst = await spawnIdle(ctx, { project: '.conduct' });
      assert.equal(inst._spawnEnv[VAR], '1');
    });
  } finally { await ctx.close(); }
});

test('off passes a host-exported value through untouched; on overrides it with 1', async () => {
  const ctx = await boot();
  try {
    await withHostValue('0', async () => {
      const off = await spawnIdle(ctx);
      assert.equal(off._spawnEnv[VAR], '0');
      await setTaskToolsEnabled(true);
      const on = await spawnIdle(ctx);
      assert.equal(on._spawnEnv[VAR], '1');
    });
  } finally { await ctx.close(); }
});
