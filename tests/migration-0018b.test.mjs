// Migration 0018b: seed the backend registry, re-key concrete tier/role bindings
// from {kind,model} to {backend,model}, rename customBackends → customModels with
// a backend + a now-required contextWindow, inline the global sonnetContextWindow
// onto the bindings that can carry one, and reshape the session-backends sidecar to
// {sid:{backend,model}} while CARRYING the tagged model across.
//
// Letter-suffixed and ordered BETWEEN 0018 and 0019 (numeric order = execution
// order). The ordering is load-bearing: 0019 deletes `models.sonnetContextWindow`
// unconditionally, and on a pre-0017 store its backfill guard can't match the
// still-STRING tier bindings — so running 0019 first destroys a user's explicit 200k
// pin. `the chain THROUGH 0019 preserves a pre-0017 200k Sonnet pin` below is the
// regression test for exactly that; it FAILS if this migration is moved back after
// 0019.
//
// That test deliberately replays the chain PREFIX rather than the whole chain:
// 0026 later drops the `window` key that proves the pin was inlined, so a
// full-chain end-state assertion would pass even with 0018b and 0019 reordered —
// the test would silently stop testing its own subject.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as m0018b from '../migrations/0018b-backend-registry.mjs';
import { runMigrations, ALL } from '../migrations/index.mjs';

// Replay the real registered chain up to and including `lastName`, in order.
async function runChainThrough(lastName, { root }) {
  const end = ALL.findIndex(m => m.name === lastName);
  assert.ok(end >= 0, `no migration named ${lastName} is registered`);
  for (const m of ALL.slice(0, end + 1)) await m.run({ root, log: () => {} });
}

async function mkTmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'cc-mig18b-')); }
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

  const res = await m0018b.run({ root });
  assert.equal(res.applied, true);
  assert.deepEqual(res.summary, { settings: true, rekeyed: 7, customModels: 3, windowsInlined: 0, sidecar: null });

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
  assert.deepEqual(await m0018b.run({ root }), { applied: false });

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

  const res = await m0018b.run({ root });
  assert.equal(res.applied, true);
  assert.deepEqual(res.summary, { settings: false, rekeyed: 0, customModels: 0, windowsInlined: 0, sidecar: 4 });

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
  assert.deepEqual(await m0018b.run({ root }), { applied: false });

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
  const res = await m0018b.run({ root });
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
  assert.deepEqual(await m0018b.run({ root }), { applied: false });
  assert.equal(await exists(sidecarFile(root)), false);
  await fs.rm(root, { recursive: true, force: true });
});

// 0018b SUPERSEDES 0017 (which is unregistered — its probe keyed on the `kind` key
// this migration removes, so it would re-run destructively every boot). These cover
// the pre-0017 shapes 0018b absorbed.
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

  const res = await m0018b.run({ root });
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

  assert.deepEqual(await m0018b.run({ root }), { applied: false });
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
  const res = await m0018b.run({ root });
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
  assert.deepEqual(await m0018b.run({ root }), { applied: false });
  await fs.rm(root, { recursive: true, force: true });
});

test('a pre-0017 sidecar with no non-claude sessions is unlinked', async () => {
  const root = await mkTmp();
  await writeJson(sidecarFile(root), { backends: { 'sid-c': { kind: 'claude' } } });
  const res = await m0018b.run({ root });
  assert.equal(res.applied, true);
  assert.equal(await exists(sidecarFile(root)), false);
  await fs.rm(root, { recursive: true, force: true });
});

test('an EMPTY root is a completely silent no-op (the full-chain log stays clean)', async () => {
  const root = await mkTmp();
  assert.deepEqual(await m0018b.run({ root }), { applied: false });
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
  // 0026 backfills the sidecar's capacity from the custom-model row 0018b created.
  assert.deepEqual((await readJson(sidecarFile(root))).sessions,
    { 'sid-1': { backend: 'ollama', model: 'gemma4:cloud', contextWindowTokens: 200000 } });

  // Re-running the whole chain changes nothing further.
  const logs = [];
  await runMigrations({ root, log: (m) => logs.push(m) });
  assert.deepEqual(logs, []);

  await fs.rm(root, { recursive: true, force: true });
});

test('the chain THROUGH 0019 preserves a pre-0017 200k Sonnet pin (0018b must run BEFORE 0019)', async () => {
  const root = await mkTmp();
  await writeJson(settingsFile(root), {
    models: {
      opus: 'claude-opus-4-7',
      // Per-family active version + the GLOBAL window preference, the shape an
      // install created between sonnetContextWindow shipping and 0017 carries.
      sonnet: 'claude-sonnet-4-6',
      sonnetContextWindow: '200k',
      // Family-key STRINGS — 0019's backfill guard cannot match these, and 0019
      // deletes the global unconditionally, so ordering 0018b after it destroys the
      // pin. `balanced` is the selectable Sonnet that must keep its 200k.
      tierBackend: { fast: 'ollama:local-gpt', balanced: 'sonnet', powerful: 'opus' },
      customBackends: [{ id: 'ollama:local-gpt', label: 'Local', model: 'gemma4:cloud', host: '10.0.0.5:11434' }],
    },
  });
  await writeJson(sidecarFile(root), { backends: { 'sid-1': { kind: 'ollama' } } });

  // Stop at 0019 — the last point at which the inlined pin is still observable.
  // 0026 drops `window` from every claude binding, so running the whole chain
  // here would yield {backend, model} whether or not 0018b ran first, and this
  // test would pass while proving nothing.
  await runChainThrough('0019-inline-sonnet-window-into-bindings', { root });
  const s = (await readJson(settingsFile(root))).models;
  // THE assertion: the user's explicit 200k survived onto the materialized binding.
  assert.deepEqual(s.tierBackend.balanced,
    { backend: 'claude', model: 'claude-sonnet-4-6', window: '200k' },
    'a pre-0017 200k Sonnet pin must be inlined, not silently widened to 1M');
  assert.equal('sonnetContextWindow' in s, false, 'the global is consumed and dropped');
  assert.deepEqual(s.tierBackend.fast, { backend: 'ollama', model: 'gemma4:cloud' });
  assert.deepEqual(s.tierBackend.powerful, { backend: 'claude', model: 'claude-opus-4-7' });
  assert.deepEqual(s.customModels, [{ label: 'Local', model: 'gemma4:cloud', backend: 'ollama', contextWindow: 200000 }]);
  assert.deepEqual((await readJson(sidecarFile(root))).sessions, { 'sid-1': { backend: 'ollama', model: null } });

  // Finishing the chain retires the window selector: the pin's binding collapses
  // to {backend, model} and Sonnet 4.x runs at its single native window.
  await runMigrations({ root, log: () => {} });
  const after = (await readJson(settingsFile(root))).models;
  assert.deepEqual(after.tierBackend.balanced, { backend: 'claude', model: 'claude-sonnet-4-6' });

  // THE regression this guards: 0017 unregistered means a second boot must not
  // reset the bindings it re-keyed. Silent + unchanged.
  const before = await readJson(settingsFile(root));
  const logs = [];
  await runMigrations({ root, log: (m) => logs.push(m) });
  assert.deepEqual(logs, []);
  assert.deepEqual(await readJson(settingsFile(root)), before);

  await fs.rm(root, { recursive: true, force: true });
});

// The shape 0019 was originally written for: bindings already collapsed to
// {kind,model} but the global still present. 0018b now absorbs that job, so BOTH
// paths are pinned and 0019 is left permanently inert.
test('the chain THROUGH 0019 inlines a POST-0017 global onto tier AND role bindings', async () => {
  const root = await mkTmp();
  await writeJson(settingsFile(root), {
    models: {
      sonnetContextWindow: '200k',
      tierBackend: {
        balanced: { kind: 'claude', model: 'claude-sonnet-4-6' },  // selectable → inlined
        fast:     { kind: 'claude', model: 'claude-sonnet-5' },    // fixed 1M → skipped
        powerful: { kind: 'claude', model: 'claude-opus-4-8' },    // non-Sonnet → skipped
      },
      roleBackend: {
        reviewer:  { kind: 'claude', model: 'claude-sonnet-4-5' }, // selectable → inlined
        conductor: { kind: 'tier', tier: 'powerful' },             // tier ref → untouched
      },
    },
  });

  // Prefix again — 0026 would erase the very `window` keys under test here.
  await runChainThrough('0019-inline-sonnet-window-into-bindings', { root });
  const s = (await readJson(settingsFile(root))).models;
  assert.deepEqual(s.tierBackend.balanced, { backend: 'claude', model: 'claude-sonnet-4-6', window: '200k' });
  assert.deepEqual(s.tierBackend.fast, { backend: 'claude', model: 'claude-sonnet-5' });
  assert.deepEqual(s.tierBackend.powerful, { backend: 'claude', model: 'claude-opus-4-8' });
  assert.deepEqual(s.roleBackend.reviewer, { backend: 'claude', model: 'claude-sonnet-4-5', window: '200k' });
  assert.deepEqual(s.roleBackend.conductor, { kind: 'tier', tier: 'powerful' });
  assert.equal('sonnetContextWindow' in s, false);

  // …and the finished chain drops every one of those windows.
  await runMigrations({ root, log: () => {} });
  const after = (await readJson(settingsFile(root))).models;
  assert.deepEqual(after.tierBackend.balanced, { backend: 'claude', model: 'claude-sonnet-4-6' });
  assert.deepEqual(after.roleBackend.reviewer, { backend: 'claude', model: 'claude-sonnet-4-5' });
  assert.deepEqual(after.roleBackend.conductor, { kind: 'tier', tier: 'powerful' });

  // 0019 is now permanently inert — a second chain run is silent and unchanged.
  const before = await readJson(settingsFile(root));
  const logs = [];
  await runMigrations({ root, log: (m) => logs.push(m) });
  assert.deepEqual(logs, []);
  assert.deepEqual(await readJson(settingsFile(root)), before);

  await fs.rm(root, { recursive: true, force: true });
});

// A store already past 0019 carries its window ON the binding and no global. The
// inlining step must not touch it (and must not invent a window for it).
test('an ALREADY-POST-0019 store keeps its per-binding window untouched', async () => {
  const root = await mkTmp();
  await writeJson(settingsFile(root), {
    models: { tierBackend: { balanced: { kind: 'claude', model: 'claude-sonnet-4-6', window: '1m' } } },
  });
  const res = await m0018b.run({ root });
  assert.equal(res.applied, true);
  assert.equal(res.summary.windowsInlined, 0, 'nothing to inline — the global is long gone');
  const s = (await readJson(settingsFile(root))).models;
  assert.deepEqual(s.tierBackend.balanced, { backend: 'claude', model: 'claude-sonnet-4-6', window: '1m' });
  await fs.rm(root, { recursive: true, force: true });
});
