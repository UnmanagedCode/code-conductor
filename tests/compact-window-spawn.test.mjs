// Verifies that CLAUDE_CODE_AUTO_COMPACT_WINDOW is injected into the child
// process env ONLY when spawning the .conduct orchestrator session (project
// === '.conduct') with the feature enabled. MCP-spawned worker agents
// (this.conducted === true) and ordinary non-.conduct sessions must NOT
// receive the env var, even when the feature is enabled. Also covers the
// reachable case where the conductor role itself is Ollama-backed, so both
// the ollama native-window block and this knob block fire on one spawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, fakeOllamaReachable } from './helpers.mjs';
import { setConductorCompactWindow } from '../src/appSettings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');

async function spawnAndGetEnv({ ctx, project, conductedWorker = false, model = 'claude-haiku-4-5', backendKind }) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwspawn-'));
  const envDump = path.join(tmp, 'env.txt');
  process.env.FAKE_CLAUDE_ENV_DUMP = envDump;
  try {
    const spawnBody = { project, mode: 'bypassPermissions', model, temp: true };
    if (backendKind) spawnBody.backendKind = backendKind;
    if (conductedWorker) spawnBody.conducted = true;
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', spawnBody);
    assert.equal(r.status, 201, `spawn failed: ${JSON.stringify(r.body)}`);
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id)?.status === 'idle');
    await ctx.instances.get(id).prompt('hi');
    await waitFor(async () => { try { await fs.stat(envDump); return true; } catch { return false; } });
    const envLines = (await fs.readFile(envDump, 'utf8')).split('\n').filter(Boolean);
    return Object.fromEntries(envLines.map(l => {
      const eq = l.indexOf('=');
      return eq < 0 ? [l, ''] : [l.slice(0, eq), l.slice(eq + 1)];
    }));
  } finally {
    delete process.env.FAKE_CLAUDE_ENV_DUMP;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) {
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return await fn(); }
  finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('.conduct orchestrator spawn receives CLAUDE_CODE_AUTO_COMPACT_WINDOW when enabled', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    // Enable the feature (value 400k).
    await withEnv({ PROJECTS_ROOT: ctx.projectsRoot, CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined }, async () => {
      await setConductorCompactWindow({ enabled: true, value: 400 });
    });
    // Ensure the .conduct project exists.
    await api(ctx.baseUrl, 'POST', '/api/projects/.conduct/ensure');
    const env = await spawnAndGetEnv({ ctx, project: '.conduct' });
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '400000',
      'Conduct orchestrator session must receive CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000');
  } finally { await ctx.close(); }
});

test('ordinary project spawn does NOT receive CLAUDE_CODE_AUTO_COMPACT_WINDOW even when enabled', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await withEnv({ PROJECTS_ROOT: ctx.projectsRoot, CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined }, async () => {
      await setConductorCompactWindow({ enabled: true, value: 400 });
    });
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'myproject' });
    const env = await spawnAndGetEnv({ ctx, project: 'myproject' });
    assert.ok(!('CLAUDE_CODE_AUTO_COMPACT_WINDOW' in env),
      'non-.conduct session must not receive CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  } finally { await ctx.close(); }
});

test('MCP-spawned worker (conducted:true) does NOT receive CLAUDE_CODE_AUTO_COMPACT_WINDOW', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await withEnv({ PROJECTS_ROOT: ctx.projectsRoot, CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined }, async () => {
      await setConductorCompactWindow({ enabled: true, value: 400 });
    });
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'myproject' });
    const env = await spawnAndGetEnv({ ctx, project: 'myproject', conductedWorker: true });
    assert.ok(!('CLAUDE_CODE_AUTO_COMPACT_WINDOW' in env),
      'MCP-spawned worker (this.conducted===true) must not receive CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  } finally { await ctx.close(); }
});

test('.conduct spawn does NOT receive CLAUDE_CODE_AUTO_COMPACT_WINDOW when feature disabled', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await withEnv({ PROJECTS_ROOT: ctx.projectsRoot, CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined }, async () => {
      await setConductorCompactWindow({ enabled: false, value: 400 });
    });
    await api(ctx.baseUrl, 'POST', '/api/projects/.conduct/ensure');
    const env = await spawnAndGetEnv({ ctx, project: '.conduct' });
    assert.ok(!('CLAUDE_CODE_AUTO_COMPACT_WINDOW' in env),
      'disabled feature must not inject CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  } finally { await ctx.close(); }
});

// The conductor role can be bound to an Ollama backend (roleBackend in
// settings), so a .conduct session with backendKind:'ollama' is reachable —
// both the ollama native-window block AND the .conduct knob block fire on the
// same spawn. The ollama block runs first (sets MAX_CONTEXT_TOKENS to the
// native window, and AUTO_COMPACT_WINDOW to the same value), then the .conduct
// block runs second and unconditionally overwrites AUTO_COMPACT_WINDOW with
// the knob value. These tests pin that ordering: if a future edit reordered
// the two blocks, the knob would get silently clobbered back to the native
// window and nothing else would catch it.
test('ollama-backed .conduct spawn: knob overrides AUTO_COMPACT_WINDOW, native window still wins MAX_CONTEXT_TOKENS (knob above native)', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  const restoreFetch = fakeOllamaReachable();
  try {
    await withEnv({ PROJECTS_ROOT: ctx.projectsRoot, CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined }, async () => {
      await setConductorCompactWindow({ enabled: true, value: 400 }); // 400k knob
    });
    await api(ctx.baseUrl, 'POST', '/api/projects/.conduct/ensure');
    const env = await spawnAndGetEnv({ ctx, project: '.conduct', model: 'qwen3.5:cloud', backendKind: 'ollama' });
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '400000',
      'the .conduct block must run after the ollama block and win — not the native 256k');
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '256000',
      'MAX_CONTEXT_TOKENS is only ever set by the ollama block, to the native window');
  } finally { await ctx.close(); restoreFetch(); }
});

test('ollama-backed .conduct spawn: knob below native window still wins the effective min', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  const restoreFetch = fakeOllamaReachable();
  try {
    await withEnv({ PROJECTS_ROOT: ctx.projectsRoot, CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined }, async () => {
      await setConductorCompactWindow({ enabled: true, value: 200 }); // 200k knob, below the 256k native window
    });
    await api(ctx.baseUrl, 'POST', '/api/projects/.conduct/ensure');
    const env = await spawnAndGetEnv({ ctx, project: '.conduct', model: 'qwen3.5:cloud', backendKind: 'ollama' });
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '200000');
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '256000');
  } finally { await ctx.close(); restoreFetch(); }
});
