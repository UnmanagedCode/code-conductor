// Migration 0026: retire the Sonnet window selector and repair
// substitution-backend model ids truncated by the old canonicalization.
//
// The failure mode these tests exist to prevent is a migration that rewrites a
// model id which was always correct. `models.customModels[].model` is the
// registry key: if `gpt-5.6-sol[1m]` is normalized, every session bound to it
// loses its context env vars and its ctx denominator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as m0026 from '../migrations/0026-drop-sonnet-window-state.mjs';

const mkTmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'cc-mig26-'));
const store = (root) => path.join(root, '.code-conductor');
const settingsFile = (root) => path.join(store(root), 'settings.json');
const sidecarFile = (root) => path.join(store(root), 'session-backends.json');
const manifestFile = (root) => path.join(store(root), 'pending-resume.json');

async function writeJson(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj, null, 2) + '\n');
}
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

// Two custom models on `codex` (one tagged), plus two on `amb` that collapse to
// the same bare id — the ambiguity case.
const CUSTOM_MODELS = [
  { label: 'Sol', model: 'gpt-5.6-sol[1m]', backend: 'codex', contextWindow: 1_000_000 },
  { label: 'A', model: 'foo[1m]', backend: 'amb', contextWindow: 1_000_000 },
  { label: 'B', model: 'foo[200k]', backend: 'amb', contextWindow: 200_000 },
];

test('claude bindings lose `window` and any stray launch tag; customModels stay byte-exact', async () => {
  const root = await mkTmp();
  try {
    await writeJson(settingsFile(root), {
      models: {
        customModels: CUSTOM_MODELS,
        tierBackend: {
          balanced: { backend: 'claude', model: 'claude-sonnet-4-6', window: '200k' },
          // A NON-claude binding pointing at the tagged registry key.
          powerful: { backend: 'codex', model: 'gpt-5.6-sol[1m]' },
        },
        roleBackend: {
          conductor: { kind: 'tier', tier: 'powerful' },
          reviewer: { backend: 'claude', model: 'claude-sonnet-4-5[1m]', window: '1m' },
        },
      },
    });

    const res = await m0026.run({ root, log: () => {} });
    assert.equal(res.applied, true);

    const m = (await readJson(settingsFile(root))).models;
    assert.deepEqual(m.tierBackend.balanced, { backend: 'claude', model: 'claude-sonnet-4-6' });
    assert.deepEqual(m.roleBackend.reviewer, { backend: 'claude', model: 'claude-sonnet-4-5' });
    // A tier-reference role binding has no backend/model and must be skipped.
    assert.deepEqual(m.roleBackend.conductor, { kind: 'tier', tier: 'powerful' });

    // THE thing that must not move: the registry key, and the binding using it.
    assert.deepEqual(m.customModels, CUSTOM_MODELS);
    assert.deepEqual(m.tierBackend.powerful, { backend: 'codex', model: 'gpt-5.6-sol[1m]' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a truncated substitution id is repaired when exactly one custom model matches', async () => {
  const root = await mkTmp();
  try {
    await writeJson(settingsFile(root), { models: { customModels: CUSTOM_MODELS } });
    await writeJson(sidecarFile(root), {
      sessions: { 's-trunc': { backend: 'codex', model: 'gpt-5.6-sol' } },
    });

    const res = await m0026.run({ root, log: () => {} });
    assert.equal(res.applied, true);
    assert.equal(res.summary.repaired, 1);

    assert.deepEqual((await readJson(sidecarFile(root))).sessions['s-trunc'], {
      backend: 'codex', model: 'gpt-5.6-sol[1m]', contextWindowTokens: 1_000_000,
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an AMBIGUOUS truncated id is left byte-exact and counted, never guessed', async () => {
  const root = await mkTmp();
  try {
    await writeJson(settingsFile(root), { models: { customModels: CUSTOM_MODELS } });
    // `foo` de-tags to both `foo[1m]` and `foo[200k]` on backend `amb`. Picking
    // either would silently repoint the session at the wrong model — and at the
    // wrong context window (1M vs 200k).
    await writeJson(sidecarFile(root), { sessions: { 's-amb': { backend: 'amb', model: 'foo' } } });

    const res = await m0026.run({ root, log: () => {} });
    assert.equal(res.applied, false, 'nothing was safely repairable, so nothing was written');
    assert.deepEqual((await readJson(sidecarFile(root))).sessions['s-amb'],
      { backend: 'amb', model: 'foo' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an ambiguous record is reported in the summary when other work IS applied', async () => {
  const root = await mkTmp();
  try {
    await writeJson(settingsFile(root), { models: { customModels: CUSTOM_MODELS } });
    await writeJson(sidecarFile(root), {
      sessions: {
        's-amb': { backend: 'amb', model: 'foo' },          // ambiguous
        's-trunc': { backend: 'codex', model: 'gpt-5.6-sol' }, // repairable
      },
    });
    const res = await m0026.run({ root, log: () => {} });
    assert.equal(res.applied, true);
    assert.equal(res.summary.repaired, 1);
    assert.equal(res.summary.ambiguous, 1);
    // The ambiguous one still did not move.
    const sessions = (await readJson(sidecarFile(root))).sessions;
    assert.deepEqual(sessions['s-amb'], { backend: 'amb', model: 'foo' });
    assert.equal(sessions['s-trunc'].model, 'gpt-5.6-sol[1m]');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an UNMATCHED substitution id is left alone and not counted', async () => {
  const root = await mkTmp();
  try {
    await writeJson(settingsFile(root), { models: { customModels: CUSTOM_MODELS } });
    await writeJson(sidecarFile(root), {
      sessions: { 's-none': { backend: 'codex', model: 'who-knows' } },
    });
    const res = await m0026.run({ root, log: () => {} });
    assert.equal(res.applied, false);
    assert.deepEqual((await readJson(sidecarFile(root))).sessions['s-none'],
      { backend: 'codex', model: 'who-knows' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('pending-resume.json loses sonnetWindow and gets the same conservative repair', async () => {
  const root = await mkTmp();
  try {
    await writeJson(settingsFile(root), { models: { customModels: CUSTOM_MODELS } });
    // Matters for SELF-UPDATE: an old process can write this shape moments
    // before new code boots, and migrations run before the manifest is replayed.
    await writeJson(manifestFile(root), {
      writtenAt: 1,
      instances: [
        { sessionId: 'r1', backend: 'codex', model: 'gpt-5.6-sol', sonnetWindow: '1m' },
        { sessionId: 'r2', backend: 'claude', model: 'claude-sonnet-4-6', sonnetWindow: '200k' },
        { sessionId: 'r3', backend: 'amb', model: 'foo', sonnetWindow: '1m' },
      ],
    });

    const res = await m0026.run({ root, log: () => {} });
    assert.equal(res.applied, true);

    const [r1, r2, r3] = (await readJson(manifestFile(root))).instances;
    assert.deepEqual(r1, {
      sessionId: 'r1', backend: 'codex', model: 'gpt-5.6-sol[1m]', contextWindowTokens: 1_000_000,
    });
    // The claude entry keeps its bare id — canonicalize re-applies the tag at spawn.
    assert.deepEqual(r2, { sessionId: 'r2', backend: 'claude', model: 'claude-sonnet-4-6' });
    // Ambiguous: sonnetWindow still goes, but the model is untouched.
    assert.deepEqual(r3, { sessionId: 'r3', backend: 'amb', model: 'foo' });
    for (const e of [r1, r2, r3]) assert.ok(!('sonnetWindow' in e));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('idempotent: a second run reports applied:false and changes no byte', async () => {
  const root = await mkTmp();
  try {
    await writeJson(settingsFile(root), {
      models: {
        customModels: CUSTOM_MODELS,
        tierBackend: { balanced: { backend: 'claude', model: 'claude-sonnet-4-6', window: '200k' } },
      },
    });
    await writeJson(sidecarFile(root), {
      sessions: {
        's-trunc': { backend: 'codex', model: 'gpt-5.6-sol' },
        's-amb': { backend: 'amb', model: 'foo' },
      },
    });
    await writeJson(manifestFile(root), {
      writtenAt: 1, instances: [{ sessionId: 'r1', backend: 'codex', model: 'gpt-5.6-sol', sonnetWindow: '1m' }],
    });

    assert.equal((await m0026.run({ root, log: () => {} })).applied, true);
    const snapshot = await Promise.all(
      [settingsFile, sidecarFile, manifestFile].map(f => fs.readFile(f(root), 'utf8')));

    // Ambiguity is PERMANENT — the colliding rows are never resolved — so a
    // second run must not keep reporting work, or the migration would claim to
    // have applied on every single boot forever.
    const second = await m0026.run({ root, log: () => {} });
    assert.equal(second.applied, false);

    const after = await Promise.all(
      [settingsFile, sidecarFile, manifestFile].map(f => fs.readFile(f(root), 'utf8')));
    assert.deepEqual(after, snapshot);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an empty / absent store is a silent no-op', async () => {
  const root = await mkTmp();
  try {
    assert.deepEqual(await m0026.run({ root, log: () => {} }), { applied: false });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
