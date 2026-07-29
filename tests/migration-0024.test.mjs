// Migration 0024: seed the backend registry, re-key concrete tier/role bindings
// from {kind,model} to {backend,model}, rename customBackends → customModels with
// a backend + a now-required contextWindow, and reshape the session-backends
// sidecar to {sid:{backend,model}} while CARRYING the tagged model across.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as m0024 from '../migrations/0024-backend-registry.mjs';
import { runMigrations } from '../migrations/index.mjs';

async function mkTmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'cc-mig24-')); }
function settingsFile(root) { return path.join(root, '.code-conductor', 'settings.json'); }
function sidecarFile(root) { return path.join(root, '.code-conductor', 'session-backends.json'); }
async function writeJson(file, obj) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(obj, null, 2)); }
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function exists(p) { try { await fs.stat(p); return true; } catch { return false; } }

test('settings: seeds the registry, re-keys every concrete binding, renames customBackends', async () => {
  const root = await mkTmp();
  await writeJson(settingsFile(root), {
    // An unrelated namespace must survive untouched.
    transcribe: { model: 'ggml-small.en-q5_1.bin' },
    models: {
      onOverage: 'stop',
      tierBackend: {
        fast:     { kind: 'ollama', model: 'gemma4:cloud' },                    // → backend:'ollama'
        balanced: { kind: 'claude', model: 'claude-sonnet-4-6', window: '200k' }, // → backend:'claude', window kept
        powerful: { kind: 'claude', model: 'claude-opus-4-8' },                  // → backend:'claude'
        frontier: { kind: 'claude', model: 'claude-fable-5' },                   // → backend:'claude'
      },
      roleBackend: {
        conductor:        { kind: 'tier', tier: 'powerful' },                    // tier ref → UNTOUCHED
        reviewer:         { kind: 'claude', model: 'claude-sonnet-4-5', window: '1m' },
        MyRole:           { kind: 'ollama', model: 'glm-5.2:cloud' },
        // A PLUGIN-role override lives in the same flat map — it must be re-keyed
        // too (nothing about the loop is aware of the '<plugin>/<slug>' shape).
        'myplug/scribe':  { kind: 'claude', model: 'claude-haiku-4-5' },
        'myplug/tiered':  { kind: 'tier', tier: 'fast' },                        // tier ref → UNTOUCHED
      },
      customRoles: ['MyRole'],
      customBackends: [
        { label: 'Local Big', model: 'localbig:cloud', contextWindow: 128000 }, // declared → kept
        { label: 'Qwen', model: 'qwen3.5:cloud' },                             // curated tag → catalog value
        { label: 'Mystery', model: 'mystery:v1' },                             // unknown → 200000 fallback
      ],
    },
  });

  const res = await m0024.run({ root });
  assert.equal(res.applied, true);
  assert.deepEqual(res.summary, { settings: true, rekeyed: 7, customModels: 3, sidecar: null });

  const s = (await readJson(settingsFile(root))).models;

  // `models.backends` is seeded EMPTY — the managed rows are code-authoritative, so
  // persisting them would be dead data the reader ignores. Its presence is the
  // idempotency probe.
  assert.deepEqual(s.backends, []);

  // Concrete bindings re-keyed, same values; `window` preserved.
  assert.deepEqual(s.tierBackend, {
    fast:     { backend: 'ollama', model: 'gemma4:cloud' },
    balanced: { backend: 'claude', model: 'claude-sonnet-4-6', window: '200k' },
    powerful: { backend: 'claude', model: 'claude-opus-4-8' },
    frontier: { backend: 'claude', model: 'claude-fable-5' },
  });
  assert.deepEqual(s.roleBackend, {
    conductor:       { kind: 'tier', tier: 'powerful' },        // untouched
    reviewer:        { backend: 'claude', model: 'claude-sonnet-4-5', window: '1m' },
    MyRole:          { backend: 'ollama', model: 'glm-5.2:cloud' },
    'myplug/scribe': { backend: 'claude', model: 'claude-haiku-4-5' },
    'myplug/tiered': { kind: 'tier', tier: 'fast' },            // untouched
  });
  // No stray `kind` left on a re-keyed binding.
  for (const b of [...Object.values(s.tierBackend), ...Object.values(s.roleBackend)]) {
    if (b.kind === 'tier') continue;
    assert.equal('kind' in b, false, `re-keyed binding must drop 'kind': ${JSON.stringify(b)}`);
  }

  // customBackends → customModels, all bound to `ollama`, all with a window.
  assert.deepEqual(s.customModels, [
    { label: 'Local Big', model: 'localbig:cloud', backend: 'ollama', contextWindow: 128000 },
    { label: 'Qwen',      model: 'qwen3.5:cloud',  backend: 'ollama', contextWindow: 256000 },
    { label: 'Mystery',   model: 'mystery:v1',     backend: 'ollama', contextWindow: 200000 },
  ]);
  assert.equal('customBackends' in s, false, 'the old key is deleted, not aliased');

  // Untouched neighbours.
  assert.equal(s.onOverage, 'stop');
  assert.deepEqual(s.customRoles, ['MyRole']);
  assert.deepEqual((await readJson(settingsFile(root))).transcribe, { model: 'ggml-small.en-q5_1.bin' });

  // Idempotent: `models.backends` present ⇒ second run is a no-op.
  assert.deepEqual(await m0024.run({ root }), { applied: false });

  await fs.rm(root, { recursive: true, force: true });
});

test('sidecar: map-of-string → map-of-object, CARRYING the tagged model (key-sorted)', async () => {
  const root = await mkTmp();
  await writeJson(sidecarFile(root), {
    sessions: {
      'sid-b': 'deepseek-v4-flash:cloud',
      'sid-a': 'qwen2.5-coder:32b',
      'sid-c': null,          // legacy model-unknown entry stays unknown
      'sid-d': '',            // blank is model-unknown too
    },
  });

  const res = await m0024.run({ root });
  assert.equal(res.applied, true);
  assert.deepEqual(res.summary, { settings: false, rekeyed: 0, customModels: 0, sidecar: 4 });

  const sc = await readJson(sidecarFile(root));
  assert.deepEqual(sc, {
    sessions: {
      'sid-a': { backend: 'ollama', model: 'qwen2.5-coder:32b' },
      'sid-b': { backend: 'ollama', model: 'deepseek-v4-flash:cloud' },
      'sid-c': { backend: 'ollama', model: null },
      'sid-d': { backend: 'ollama', model: null },
    },
  });
  // Deterministic key order (mirrors sessionBackends' own writer).
  assert.deepEqual(Object.keys(sc.sessions), ['sid-a', 'sid-b', 'sid-c', 'sid-d']);

  // Idempotent: every value is already an object.
  assert.deepEqual(await m0024.run({ root }), { applied: false });

  await fs.rm(root, { recursive: true, force: true });
});

test('sidecar: a partially-migrated store is completed without losing already-shaped records', async () => {
  const root = await mkTmp();
  await writeJson(sidecarFile(root), {
    sessions: {
      'sid-new': { backend: 'my-proxy', model: 'mine:v1' }, // already shaped — preserved verbatim
      'sid-old': 'glm-5.2:cloud',                            // still a string — converted
    },
  });
  const res = await m0024.run({ root });
  assert.equal(res.applied, true);
  assert.deepEqual((await readJson(sidecarFile(root))).sessions, {
    'sid-new': { backend: 'my-proxy', model: 'mine:v1' },
    'sid-old': { backend: 'ollama', model: 'glm-5.2:cloud' },
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('settings with no models namespace, and an absent sidecar, are both no-ops', async () => {
  const root = await mkTmp();
  await writeJson(settingsFile(root), { transcribe: { model: 'x' } });
  assert.deepEqual(await m0024.run({ root }), { applied: false });
  assert.equal(await exists(sidecarFile(root)), false);
  await fs.rm(root, { recursive: true, force: true });
});

// 0024 SUPERSEDES 0017 (which is unregistered — its probe keyed on the `kind` key
// this migration removes, so it would re-run destructively every boot). These cover
// the pre-0017 shapes 0024 absorbed.
test('absorbs pre-0017 settings shapes: string tierBackend, id/host customBackends, per-family keys', async () => {
  const root = await mkTmp();
  await writeJson(settingsFile(root), {
    models: {
      // Per-family active-version keys (dead after 0017) — the source for a
      // family-key tier binding, then deleted.
      opus: 'claude-opus-4-7',
      sonnet: 'claude-sonnet-4-5',
      tierBackend: {
        fast: 'ollama:local-gpt', // → the custom backend's tag, by its full 'ollama:<slug>' id
        balanced: 'sonnet',      // → that family's ACTIVE version, not the default
        powerful: 'opus',        // → active version
        frontier: 'nonsense',    // → the tier's own default family (fable)
      },
      customBackends: [
        { id: 'ollama:local-gpt', label: 'Local', model: 'gemma4:cloud', host: '10.0.0.5:11434' },
      ],
    },
  });

  const res = await m0024.run({ root });
  assert.equal(res.applied, true);
  const s = (await readJson(settingsFile(root))).models;

  assert.deepEqual(s.tierBackend, {
    fast:     { backend: 'ollama', model: 'gemma4:cloud' },
    balanced: { backend: 'claude', model: 'claude-sonnet-4-5' },
    powerful: { backend: 'claude', model: 'claude-opus-4-7' },
    frontier: { backend: 'claude', model: 'claude-fable-5' },
  });
  // id + host dropped; backend + window added.
  assert.deepEqual(s.customModels, [
    { label: 'Local', model: 'gemma4:cloud', backend: 'ollama', contextWindow: 200000 },
  ]);
  // Dead per-family keys deleted.
  for (const f of ['fable', 'opus', 'sonnet', 'haiku']) assert.equal(f in s, false, `models.${f} deleted`);

  assert.deepEqual(await m0024.run({ root }), { applied: false });
  await fs.rm(root, { recursive: true, force: true });
});

test('absorbs the pre-0017 sidecar form {backends:{sid:{kind}}}, keeping only non-claude sessions', async () => {
  const root = await mkTmp();
  await writeJson(sidecarFile(root), {
    backends: {
      'sid-b': { kind: 'ollama' },
      'sid-a': { kind: 'ollama' },
      'sid-c': { kind: 'claude' },   // claude sessions store nothing
    },
  });
  const res = await m0024.run({ root });
  assert.equal(res.applied, true);
  const sc = await readJson(sidecarFile(root));
  // That form never carried the model, so it lands model-unknown — resume falls
  // back to the jsonl and the next mark self-heals it.
  assert.deepEqual(sc, {
    sessions: {
      'sid-a': { backend: 'ollama', model: null },
      'sid-b': { backend: 'ollama', model: null },
    },
  });
  assert.deepEqual(Object.keys(sc.sessions), ['sid-a', 'sid-b']);
  assert.deepEqual(await m0024.run({ root }), { applied: false });
  await fs.rm(root, { recursive: true, force: true });
});

test('a pre-0017 sidecar with no non-claude sessions is unlinked', async () => {
  const root = await mkTmp();
  await writeJson(sidecarFile(root), { backends: { 'sid-c': { kind: 'claude' } } });
  const res = await m0024.run({ root });
  assert.equal(res.applied, true);
  assert.equal(await exists(sidecarFile(root)), false);
  await fs.rm(root, { recursive: true, force: true });
});

test('an EMPTY root is a completely silent no-op (the full-chain log stays clean)', async () => {
  const root = await mkTmp();
  assert.deepEqual(await m0024.run({ root }), { applied: false });
  // …and via the real runner, so a regression here would also break
  // tests/migrations.test.mjs's "no candidates → no log output" contract.
  const logs = [];
  await runMigrations({ root, log: (m) => logs.push(m) });
  assert.deepEqual(logs, []);
  await fs.rm(root, { recursive: true, force: true });
});

test('the full migration chain leaves a legacy store on the current shape', async () => {
  const root = await mkTmp();
  await writeJson(settingsFile(root), {
    models: {
      tierBackend: { fast: { kind: 'ollama', model: 'gemma4:cloud' } },
      customBackends: [{ label: 'Local', model: 'gemma4:cloud' }],
    },
  });
  await writeJson(sidecarFile(root), { sessions: { 'sid-1': 'gemma4:cloud' } });

  await runMigrations({ root, log: () => {} });

  const s = (await readJson(settingsFile(root))).models;
  assert.deepEqual(s.tierBackend.fast, { backend: 'ollama', model: 'gemma4:cloud' });
  assert.equal(s.customModels[0].backend, 'ollama');
  assert.ok(Number.isFinite(s.customModels[0].contextWindow));
  assert.deepEqual((await readJson(sidecarFile(root))).sessions,
    { 'sid-1': { backend: 'ollama', model: 'gemma4:cloud' } });

  // Re-running the whole chain changes nothing further.
  const logs = [];
  await runMigrations({ root, log: (m) => logs.push(m) });
  assert.deepEqual(logs, []);

  await fs.rm(root, { recursive: true, force: true });
});

test('the full chain migrates a PRE-0017 store, and re-running it changes nothing', async () => {
  const root = await mkTmp();
  await writeJson(settingsFile(root), {
    models: {
      opus: 'claude-opus-4-7',
      tierBackend: { fast: 'ollama:local-gpt', powerful: 'opus' },
      customBackends: [{ id: 'ollama:local-gpt', label: 'Local', model: 'gemma4:cloud', host: '10.0.0.5:11434' }],
    },
  });
  await writeJson(sidecarFile(root), { backends: { 'sid-1': { kind: 'ollama' } } });

  await runMigrations({ root, log: () => {} });
  const s = (await readJson(settingsFile(root))).models;
  assert.deepEqual(s.tierBackend.fast, { backend: 'ollama', model: 'gemma4:cloud' });
  assert.deepEqual(s.tierBackend.powerful, { backend: 'claude', model: 'claude-opus-4-7' });
  assert.deepEqual(s.customModels, [{ label: 'Local', model: 'gemma4:cloud', backend: 'ollama', contextWindow: 200000 }]);
  assert.deepEqual((await readJson(sidecarFile(root))).sessions, { 'sid-1': { backend: 'ollama', model: null } });

  // THE regression this guards: 0017 unregistered means a second boot must not
  // reset the bindings it re-keyed. Silent + unchanged.
  const before = await readJson(settingsFile(root));
  const logs = [];
  await runMigrations({ root, log: (m) => logs.push(m) });
  assert.deepEqual(logs, []);
  assert.deepEqual(await readJson(settingsFile(root)), before);

  await fs.rm(root, { recursive: true, force: true });
});
