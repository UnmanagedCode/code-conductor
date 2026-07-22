// Context-window policy: Opus always 1M (bare), Haiku always 200k (bare),
// all pinned via canonicalizeModel() in src/modelVersions.js. Sonnet is
// per-version: Sonnet 4.x is user-selectable (1M via CLI `[1m]` suffix or
// 200k bare); Sonnet 5 is pinned to `[1m]` regardless of the preference (no
// 200k build). The orchestrator never injects CLAUDE_CODE_DISABLE_1M_CONTEXT
// — that env flag must never appear.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf, fakeOllamaReachable } from './helpers.mjs';
import { canonicalizeModel, familyOf } from '../src/modelVersions.js';
import { addCustomBackend } from '../src/appSettings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

// One server shared across the file; each test gets a fresh PROJECTS_ROOT and
// the spawned instance is cleared between tests. See helpers → freshProjectsRoot.
let ctx, baseUrl, instances, home, restoreFetch;

before(async () => {
  // Ollama spawns preflight reachability; simulate a live daemon (no CI daemon).
  restoreFetch = fakeOllamaReachable();
  ctx = await bootServer({ scenarioPath: SCENARIO });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); restoreFetch(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

async function spawnAndDump(model, { backendKind, project = 'p' } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxwin-'));
  const argvDump = path.join(tmp, 'argv.txt');
  const envDump = path.join(tmp, 'env.txt');
  process.env.FAKE_CLAUDE_ARGV_DUMP = argvDump;
  process.env.FAKE_CLAUDE_ENV_DUMP = envDump;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: project });
    const r = await api(baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions', model, backendKind });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    // fake-claude writes its argv/env dumps synchronously at process start
    // (fake-claude.mjs:42-53), before reading any stdin — so no prompt is
    // needed, just wait for the dump file to land.
    await waitFor(async () => { try { await fs.stat(argvDump); return true; } catch { return false; } });
    const argv = (await fs.readFile(argvDump, 'utf8')).split('\n').filter(Boolean);
    const envLines = (await fs.readFile(envDump, 'utf8')).split('\n').filter(Boolean);
    const env = Object.fromEntries(envLines.map(l => {
      const eq = l.indexOf('=');
      return eq < 0 ? [l, ''] : [l.slice(0, eq), l.slice(eq + 1)];
    }));
    return { argv, env, id };
  } finally {
    delete process.env.FAKE_CLAUDE_ARGV_DUMP;
    delete process.env.FAKE_CLAUDE_ENV_DUMP;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

function modelFromArgv(argv) {
  const i = argv.indexOf('--model');
  return i < 0 ? null : argv[i + 1];
}

test('familyOf infers the family by prefix, bare or suffixed', () => {
  assert.equal(familyOf('claude-fable-5'), 'fable');
  assert.equal(familyOf('claude-opus-4-8'), 'opus');
  assert.equal(familyOf('claude-opus-4-8[200k]'), 'opus');
  assert.equal(familyOf('claude-sonnet-4-6'), 'sonnet');
  assert.equal(familyOf('claude-haiku-4-5'), 'haiku');
  assert.equal(familyOf('gpt-4'), null);
  assert.equal(familyOf(null), null);
});

test('canonicalizeModel pins each family to its window — default (1m)', () => {
  // Fable 5 → bare (1M via CLI default, no suffix needed — same as Opus).
  assert.equal(canonicalizeModel('claude-fable-5'), 'claude-fable-5');
  // Sonnet → 1M via [1m]; idempotent.
  assert.equal(canonicalizeModel('claude-sonnet-4-6'), 'claude-sonnet-4-6[1m]');
  assert.equal(canonicalizeModel('claude-sonnet-4-6[1m]'), 'claude-sonnet-4-6[1m]');
  assert.equal(canonicalizeModel('claude-sonnet-4-5'), 'claude-sonnet-4-5[1m]');
  // Opus → 1M (bare); a stale [200k] is dropped.
  assert.equal(canonicalizeModel('claude-opus-4-8'), 'claude-opus-4-8');
  assert.equal(canonicalizeModel('claude-opus-4-8[200k]'), 'claude-opus-4-8');
  assert.equal(canonicalizeModel('claude-opus-4-8[1m]'), 'claude-opus-4-8');
  // Haiku → 200k (bare).
  assert.equal(canonicalizeModel('claude-haiku-4-5'), 'claude-haiku-4-5');
  // Unknown / empty pass through.
  assert.equal(canonicalizeModel('some-other-model'), 'some-other-model');
  assert.equal(canonicalizeModel(''), '');
  assert.equal(canonicalizeModel(null), null);
});

test('canonicalizeModel: Sonnet 5 is pinned to [1m] regardless of the sonnetWindow preference', () => {
  assert.equal(canonicalizeModel('claude-sonnet-5'), 'claude-sonnet-5[1m]');
  assert.equal(canonicalizeModel('claude-sonnet-5', { sonnetWindow: '200k' }), 'claude-sonnet-5[1m]');
  assert.equal(canonicalizeModel('claude-sonnet-5[1m]', { sonnetWindow: '200k' }), 'claude-sonnet-5[1m]');
});

test('canonicalizeModel with { sonnetWindow: "200k" } returns bare Sonnet id', () => {
  // Sonnet → bare (200k) when preference is '200k'.
  assert.equal(canonicalizeModel('claude-sonnet-4-6', { sonnetWindow: '200k' }), 'claude-sonnet-4-6');
  assert.equal(canonicalizeModel('claude-sonnet-4-6[1m]', { sonnetWindow: '200k' }), 'claude-sonnet-4-6');
  assert.equal(canonicalizeModel('claude-sonnet-4-5', { sonnetWindow: '200k' }), 'claude-sonnet-4-5');
  // Opus and Haiku are unaffected by the option.
  assert.equal(canonicalizeModel('claude-opus-4-8', { sonnetWindow: '200k' }), 'claude-opus-4-8');
  assert.equal(canonicalizeModel('claude-haiku-4-5', { sonnetWindow: '200k' }), 'claude-haiku-4-5');
  // Explicit '1m' still gives the suffix.
  assert.equal(canonicalizeModel('claude-sonnet-4-6', { sonnetWindow: '1m' }), 'claude-sonnet-4-6[1m]');
});

test('Opus spawns bare (1M) with no disable flag', async () => {
  const { argv, env, id } = await spawnAndDump('claude-opus-4-8');
  assert.equal(modelFromArgv(argv), 'claude-opus-4-8');
  assert.ok(!('CLAUDE_CODE_DISABLE_1M_CONTEXT' in env),
    'the disable flag must never be set — Opus runs at its 1M default');
  assert.equal(instances.get(id).model, 'claude-opus-4-8');
});

test('Sonnet is canonicalised to the CLI-native [1m] suffix (1M), no disable flag', async () => {
  const { argv, env, id } = await spawnAndDump('claude-sonnet-4-6');
  assert.equal(modelFromArgv(argv), 'claude-sonnet-4-6[1m]',
    'Sonnet needs the [1m] suffix to get a 1M window');
  assert.ok(!('CLAUDE_CODE_DISABLE_1M_CONTEXT' in env));
  assert.equal(instances.get(id).model, 'claude-sonnet-4-6[1m]');
});

test('Haiku spawns bare (200k), no disable flag', async () => {
  const { argv, env, id } = await spawnAndDump('claude-haiku-4-5');
  assert.equal(modelFromArgv(argv), 'claude-haiku-4-5');
  assert.ok(!('CLAUDE_CODE_DISABLE_1M_CONTEXT' in env));
  assert.equal(instances.get(id).model, 'claude-haiku-4-5');
});

test('a stale [200k] suffix is normalised away — Opus no longer downgrades to 200k', async () => {
  const { argv, env, id } = await spawnAndDump('claude-opus-4-8[200k]');
  assert.equal(modelFromArgv(argv), 'claude-opus-4-8',
    'the [200k] suffix is dropped; Opus runs at 1M');
  assert.ok(!('CLAUDE_CODE_DISABLE_1M_CONTEXT' in env),
    'we no longer inject the disable flag');
  assert.equal(instances.get(id).model, 'claude-opus-4-8');
});

test('Sonnet spawns bare (200k) when the spawn carries sonnetWindow:"200k" — and the live model does not false-flip to [1m]', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxwin-'));
  const argvDump = path.join(tmp, 'argv.txt');
  process.env.FAKE_CLAUDE_ARGV_DUMP = argvDump;
  try {
    // The window rides on the spawn request (resolved from the binding), not a
    // global — pass it directly here.
    await api(baseUrl, 'POST', '/api/projects', { name: 'p2' });
    const r = await api(baseUrl, 'POST', '/api/instances', {
      project: 'p2', mode: 'bypassPermissions', model: 'claude-sonnet-4-6', sonnetWindow: '200k',
    });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    await waitFor(async () => { try { await fs.stat(argvDump); return true; } catch { return false; } });
    const argv = (await fs.readFile(argvDump, 'utf8')).split('\n').filter(Boolean);
    assert.equal(modelFromArgv(argv), 'claude-sonnet-4-6',
      'Sonnet must spawn bare (no [1m]) when the spawn window is 200k');
    // The session records its window, and its model stays BARE: _trackModel
    // canonicalizes the CLI's bare init report against this.sonnetWindow ('200k'),
    // so it must NOT append [1m] and flip the tracked model.
    assert.equal(instances.get(id).sonnetWindow, '200k');
    assert.equal(instances.get(id).model, 'claude-sonnet-4-6');
  } finally {
    delete process.env.FAKE_CLAUDE_ARGV_DUMP;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test('two Sonnet 4.x spawns carry independent windows (200k vs 1M) — one does not affect the other', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxwin-'));
  const argvDump = path.join(tmp, 'argv.txt');
  process.env.FAKE_CLAUDE_ARGV_DUMP = argvDump;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'pind' });
    const a = await api(baseUrl, 'POST', '/api/instances', {
      project: 'pind', mode: 'bypassPermissions', model: 'claude-sonnet-4-6', sonnetWindow: '200k',
    });
    const b = await api(baseUrl, 'POST', '/api/instances', {
      project: 'pind', mode: 'bypassPermissions', model: 'claude-sonnet-4-5', sonnetWindow: '1m',
    });
    await waitFor(() => instances.get(a.body.id).status === 'idle');
    await waitFor(() => instances.get(b.body.id).status === 'idle');
    assert.equal(instances.get(a.body.id).model, 'claude-sonnet-4-6', '200k spawn stays bare');
    assert.equal(instances.get(a.body.id).sonnetWindow, '200k');
    assert.equal(instances.get(b.body.id).model, 'claude-sonnet-4-5[1m]', '1M spawn keeps [1m]');
    assert.equal(instances.get(b.body.id).sonnetWindow, '1m');
  } finally {
    delete process.env.FAKE_CLAUDE_ARGV_DUMP;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test('Ollama-backed spawn sets CLAUDE_CODE_AUTO_COMPACT_WINDOW to the curated model window (raw tokens, no ×1000)', async () => {
  const { env, id } = await spawnAndDump('deepseek-v4-flash:cloud', { backendKind: 'ollama', project: 'ollama-a' });
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1000000',
    'a 1M curated model sets the raw token count directly');
  assert.equal(instances.get(id).backendKind, 'ollama');
});

test('Ollama-backed spawn honours a smaller curated window (256k)', async () => {
  const { env } = await spawnAndDump('qwen3.5:cloud', { backendKind: 'ollama', project: 'ollama-b' });
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '256000');
});

test('Ollama-backed spawn uses a custom model\'s declared contextWindow', async () => {
  await addCustomBackend({ label: 'Local Big', model: 'localbig:cloud', contextWindow: 300_000 });
  const { env } = await spawnAndDump('localbig:cloud', { backendKind: 'ollama', project: 'ollama-c' });
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '300000');
});

test('Ollama-backed spawn with an unknown window leaves CLAUDE_CODE_AUTO_COMPACT_WINDOW unset', async () => {
  await addCustomBackend({ label: 'Local NoWin', model: 'localnowin:cloud' }); // no contextWindow
  const hadAmbient = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW' in process.env;
  const savedAmbient = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '999999'; // poison: prove the strip, not ambient luck
  try {
    const { env } = await spawnAndDump('localnowin:cloud', { backendKind: 'ollama', project: 'ollama-d' });
    assert.ok(!('CLAUDE_CODE_AUTO_COMPACT_WINDOW' in env),
      'no declared window → the CLI uses its own default, we set nothing (even with an ambient value present)');
  } finally {
    if (hadAmbient) process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = savedAmbient;
    else delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  }
});

test('a Claude-backed spawn never sets CLAUDE_CODE_AUTO_COMPACT_WINDOW', async () => {
  const hadAmbient = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW' in process.env;
  const savedAmbient = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '999999'; // poison: prove the strip, not ambient luck
  try {
    const { env } = await spawnAndDump('claude-opus-4-8', { project: 'claude-x' });
    assert.ok(!('CLAUDE_CODE_AUTO_COMPACT_WINDOW' in env));
  } finally {
    if (hadAmbient) process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = savedAmbient;
    else delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  }
});

test('Sonnet 5 always spawns [1m] even when the spawn carries sonnetWindow:"200k"', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxwin-'));
  const argvDump = path.join(tmp, 'argv.txt');
  process.env.FAKE_CLAUDE_ARGV_DUMP = argvDump;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p3' });
    const r = await api(baseUrl, 'POST', '/api/instances', {
      project: 'p3', mode: 'bypassPermissions', model: 'claude-sonnet-5', sonnetWindow: '200k',
    });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    await waitFor(async () => { try { await fs.stat(argvDump); return true; } catch { return false; } });
    const argv = (await fs.readFile(argvDump, 'utf8')).split('\n').filter(Boolean);
    assert.equal(modelFromArgv(argv), 'claude-sonnet-5[1m]',
      'Sonnet 5 must spawn with [1m] regardless of the stored preference');
    assert.equal(instances.get(id).model, 'claude-sonnet-5[1m]');
  } finally {
    delete process.env.FAKE_CLAUDE_ARGV_DUMP;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});
