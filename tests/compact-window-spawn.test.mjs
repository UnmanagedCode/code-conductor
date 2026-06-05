// Verifies that CLAUDE_CODE_AUTO_COMPACT_WINDOW is injected into the child
// process env ONLY when spawning the .conduct orchestrator session (project
// === '.conduct') with the feature enabled. MCP-spawned worker agents
// (this.conducted === true) and ordinary non-.conduct sessions must NOT
// receive the env var, even when the feature is enabled.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';
import { setConductorCompactWindow } from '../src/appSettings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');

async function spawnAndGetEnv({ ctx, project, conductedWorker = false }) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwspawn-'));
  const envDump = path.join(tmp, 'env.txt');
  process.env.FAKE_CLAUDE_ENV_DUMP = envDump;
  try {
    const spawnBody = { project, mode: 'bypassPermissions', model: 'claude-haiku-4-5', temp: true };
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
