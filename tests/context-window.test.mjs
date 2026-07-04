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
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { canonicalizeModel, familyOf } from '../src/modelVersions.js';
import { setSonnetContextWindow } from '../src/appSettings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

// One server shared across the file; each test gets a fresh PROJECTS_ROOT and
// the spawned instance is cleared between tests. See helpers → freshProjectsRoot.
let ctx, baseUrl, instances, home;

before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

async function spawnAndDump(model) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxwin-'));
  const argvDump = path.join(tmp, 'argv.txt');
  const envDump = path.join(tmp, 'env.txt');
  process.env.FAKE_CLAUDE_ARGV_DUMP = argvDump;
  process.env.FAKE_CLAUDE_ENV_DUMP = envDump;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', model });
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

test('Sonnet spawns bare (200k) when sonnetContextWindow preference is "200k"', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxwin-'));
  const argvDump = path.join(tmp, 'argv.txt');
  process.env.FAKE_CLAUDE_ARGV_DUMP = argvDump;
  try {
    // Set the preference before spawning. appSettings reads PROJECTS_ROOT
    // live, and beforeEach already pointed it at this test's fresh root.
    await setSonnetContextWindow('200k');
    await api(baseUrl, 'POST', '/api/projects', { name: 'p2' });
    const r = await api(baseUrl, 'POST', '/api/instances', {
      project: 'p2', mode: 'bypassPermissions', model: 'claude-sonnet-4-6',
    });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');
    await waitFor(async () => { try { await fs.stat(argvDump); return true; } catch { return false; } });
    const argv = (await fs.readFile(argvDump, 'utf8')).split('\n').filter(Boolean);
    assert.equal(modelFromArgv(argv), 'claude-sonnet-4-6',
      'Sonnet must spawn bare (no [1m]) when preference is 200k');
    assert.equal(instances.get(id).model, 'claude-sonnet-4-6');
  } finally {
    delete process.env.FAKE_CLAUDE_ARGV_DUMP;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test('Sonnet 5 always spawns [1m] even when sonnetContextWindow preference is "200k"', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxwin-'));
  const argvDump = path.join(tmp, 'argv.txt');
  process.env.FAKE_CLAUDE_ARGV_DUMP = argvDump;
  try {
    await setSonnetContextWindow('200k');
    await api(baseUrl, 'POST', '/api/projects', { name: 'p3' });
    const r = await api(baseUrl, 'POST', '/api/instances', {
      project: 'p3', mode: 'bypassPermissions', model: 'claude-sonnet-5',
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
