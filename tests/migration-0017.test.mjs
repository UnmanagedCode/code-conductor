// Migration 0017: collapse tierBackend (family key | ollama:<slug>) + the
// {id,label,model,host} customBackends + per-family active versions into the
// {kind,model} shape; and reshape the session-backends sidecar (map → set).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as m0017 from '../migrations/0017-collapse-tier-backend-to-kind-model.mjs';

async function mkTmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'cc-mig17-')); }
function settingsFile(root) { return path.join(root, '.code-conductor', 'settings.json'); }
function sidecarFile(root) { return path.join(root, '.code-conductor', 'session-backends.json'); }
async function writeJson(file, obj) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(obj, null, 2)); }
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }

test('reshapes tierBackend, customBackends, drops active-version keys; idempotent', async () => {
  const root = await mkTmp();
  await writeJson(settingsFile(root), {
    models: {
      // family key, family key with a customized active version, ollama:<slug>, unset
      tierBackend: { fast: 'haiku', powerful: 'opus', frontier: 'ollama:local-gpt' },
      opus: 'claude-opus-4-7',          // per-family active version (customized)
      sonnet: 'claude-sonnet-4-6',
      customBackends: [{ id: 'ollama:local-gpt', label: 'Local GPT', model: 'gemma4:cloud', host: '10.0.0.5:11434' }],
      sonnetContextWindow: '200k',
      enabledTiers: { fast: true, balanced: true, powerful: true, frontier: true },
      defaultTier: 'balanced',
    },
  });

  const res = await m0017.run({ root, log: () => {} });
  assert.equal(res.applied, true);

  const s = (await readJson(settingsFile(root))).models;
  // family key → its default version; customized family → its active version;
  // ollama:<slug> → the tag; unset tier → tier default (balanced=sonnet default).
  assert.deepEqual(s.tierBackend.fast, { kind: 'claude', model: 'claude-haiku-4-5' });
  assert.deepEqual(s.tierBackend.powerful, { kind: 'claude', model: 'claude-opus-4-7' });
  assert.deepEqual(s.tierBackend.frontier, { kind: 'ollama', model: 'gemma4:cloud' });
  // Unset tier (balanced→sonnet) materializes the CUSTOMIZED active version.
  assert.deepEqual(s.tierBackend.balanced, { kind: 'claude', model: 'claude-sonnet-4-6' });
  // customBackends: id + host dropped.
  assert.deepEqual(s.customBackends, [{ label: 'Local GPT', model: 'gemma4:cloud' }]);
  // dead per-family active-version keys removed; window pref kept.
  assert.equal(s.opus, undefined);
  assert.equal(s.sonnet, undefined);
  assert.equal(s.sonnetContextWindow, '200k');
  assert.equal(s.defaultTier, 'balanced');

  // Idempotent — second run is a no-op.
  const res2 = await m0017.run({ root, log: () => {} });
  assert.equal(res2.applied, false);

  await fs.rm(root, { recursive: true, force: true });
});

test('a dead ollama:<slug> binding (no matching custom backend) falls back to claude', async () => {
  const root = await mkTmp();
  await writeJson(settingsFile(root), {
    models: { tierBackend: { balanced: 'ollama:gone' }, customBackends: [] },
  });
  await m0017.run({ root, log: () => {} });
  const s = (await readJson(settingsFile(root))).models;
  assert.deepEqual(s.tierBackend.balanced, { kind: 'claude', model: 'claude-sonnet-5' });
  await fs.rm(root, { recursive: true, force: true });
});

test('reshapes the session-backends sidecar map → set (ollama sids only)', async () => {
  const root = await mkTmp();
  await writeJson(sidecarFile(root), {
    backends: {
      'sid-ollama': { kind: 'ollama', model: 'gemma4:cloud', host: '' },
      'sid-claude': { kind: 'claude' },
    },
  });
  const res = await m0017.run({ root, log: () => {} });
  assert.equal(res.applied, true);
  const sc = await readJson(sidecarFile(root));
  assert.deepEqual(sc, { sessions: ['sid-ollama'] });
  await fs.rm(root, { recursive: true, force: true });
});

test('no settings + no sidecar → no-op', async () => {
  const root = await mkTmp();
  const res = await m0017.run({ root, log: () => {} });
  assert.equal(res.applied, false);
  await fs.rm(root, { recursive: true, force: true });
});
