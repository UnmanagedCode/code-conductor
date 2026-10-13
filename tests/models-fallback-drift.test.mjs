// Drift test for shared/models.ts's PRE-FETCH FALLBACKS.
//
// models.ts keeps first-paint copies of catalog data it cannot have yet: the
// boot fetch of /api/settings/models has not resolved on the first render, so
// the tier pickers, backend labels and effort label would be blank without
// them. Every one of those copies mirrors a value owned by
// src/modelVersions.ts or src/effortLevels.ts, and a mirror that silently
// drifts shows the user a stale default until the fetch lands — or, for
// familyOf, groups the Settings picker wrongly for good.
//
// This file asserts each mirror still equals the server value it mirrors.
// It observes them through models.ts's exported getters BEFORE
// loadModelVersions() runs — which it must never call on that instance, as that
// hits fetch. node:test gives each file its own process, so the module's
// mutable state is pristine here. The last test checks the other side of the
// fetch on a separate instance.
//
// The mirrors: DEFAULT_VERSIONS + DEFAULT_VERSION_LABELS, DEFAULT_TIER_BACKEND,
// DEFAULT_TIER_LABELS (+ the tier list and its order), the `backends`
// first-paint registry, CLAUDE_BACKEND, defaultEffort, EFFORT_LEVELS, familyOf.
// There is no role-binding mirror: a role is never resolved client-side (the
// spawn dialog's Conduct button and the WS `model` frame both send a bare
// name and the server resolves the binding), so models.ts keeps no
// DEFAULT_ROLE_BINDING fallback to drift.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

import {
  MODEL_FAMILIES,
  DEFAULT_VERSIONS,
  DEFAULT_TIER_BACKEND,
  CAPABILITY_TIERS,
  MANAGED_BACKENDS,
  CLAUDE_BACKEND_ID,
  familyOf as serverFamilyOf,
} from '../src/modelVersions.ts';
import { DEFAULT_EFFORT, EFFORT_LEVELS } from '../src/effortLevels.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_URL = pathToFileURL(path.resolve(__dirname, '..', 'shared', 'models.ts')).href;
const client = await import(MODELS_URL);

test('mirror: each family default id resolves to that version\'s catalog label', async () => {
  for (const f of MODEL_FAMILIES) {
    const version = f.versions.find(v => v.id === f.default);
    assert.ok(version, `${f.family}'s default ${f.default} must be one of its versions`);
    assert.equal(client.getVersionLabel(f.default), version.label,
      `${f.family}: client fallback label for ${f.default}`);
    // Both halves of the mirror in one check: an id the client's
    // DEFAULT_VERSIONS no longer names falls through getVersionLabel to the
    // raw id, so a changed family default fails here too.
    assert.notEqual(client.getVersionLabel(f.default), f.default,
      `${f.family}: ${f.default} must have a friendly fallback label, not the raw id`);
    assert.equal(DEFAULT_VERSIONS[f.family], f.default);
  }
});

test('mirror: tier list, order and labels match CAPABILITY_TIERS', async () => {
  assert.deepEqual(client.getTierList(), CAPABILITY_TIERS.map(t => t.tier),
    'tier order is user-visible (picker order) — not just the set');
  for (const t of CAPABILITY_TIERS) {
    assert.equal(client.getTierLabel(t.tier), t.label, `label for tier ${t.tier}`);
  }
});

test('mirror: default tier→{backend,model} bindings match DEFAULT_TIER_BACKEND', async () => {
  for (const t of CAPABILITY_TIERS) {
    assert.deepEqual(client.getActiveTierBackend(t.tier), DEFAULT_TIER_BACKEND[t.tier],
      `default binding for tier ${t.tier}`);
  }
});

test('mirror: backend first-paint labels match MANAGED_BACKENDS', async () => {
  for (const b of MANAGED_BACKENDS) {
    assert.equal(client.getBackendLabel(b.id), b.label, `first-paint label for backend ${b.id}`);
  }
});

test('mirror: CLAUDE_BACKEND equals the server identity backend id', async () => {
  assert.equal(client.CLAUDE_BACKEND, CLAUDE_BACKEND_ID);
});

test('mirror: the first-paint default effort equals DEFAULT_EFFORT', async () => {
  // An unbound tier falls through to models.ts's `defaultEffort` seed, which
  // is what the spawn dialog's "Default (…)" label renders pre-fetch.
  for (const t of CAPABILITY_TIERS) {
    assert.equal(client.getActiveTierEffort(t.tier), DEFAULT_EFFORT, `default effort for tier ${t.tier}`);
  }
});

test('mirror: the first-paint effort level list equals EFFORT_LEVELS, in order', async () => {
  // The ⋮ menu's Change-effort picker renders this array verbatim, so a stale
  // mirror offers the user the wrong levels — or the right ones in the wrong
  // order (the list is ordered low → high) — until the boot fetch lands.
  assert.deepEqual(client.getEffortLevels(), [...EFFORT_LEVELS]);
});

test('mirror: client familyOf agrees with the server for every catalog id', async () => {
  for (const f of MODEL_FAMILIES) {
    for (const v of f.versions) {
      const ids = v.launchTag ? [v.id, v.id + v.launchTag] : [v.id];
      for (const id of ids) {
        assert.equal(client.familyOf(id), f.family, `client familyOf(${id})`);
        assert.equal(client.familyOf(id), serverFamilyOf(id), `client/server agree on ${id}`);
      }
    }
  }
});

test('mirror: client familyOf returns null for non-Claude and non-string ids', async () => {
  for (const id of ['gpt-5.6-sol', 'llama3:8b', '', null, undefined, 42, {}]) {
    assert.equal(client.familyOf(id), null, `familyOf(${JSON.stringify(id)})`);
  }
});

// ── after the fetch ──────────────────────────────────────────────────────
// The one test here that calls loadModelVersions(): it imports its own
// instance of models.ts (a distinct URL), so the pristine one above is never
// fetched into.

const TIERS = ['fast', 'balanced', 'powerful', 'frontier'];

// Mirrors GET /api/settings/models for the fields models.ts caches.
function modelsPayload(tierEffort) {
  return {
    backends: [{ id: 'claude', label: 'Claude', managed: true }],
    claudeFamilies: [{
      family: 'opus', label: 'Opus', default: 'claude-opus-4-8',
      versions: [{ id: 'claude-opus-4-8', label: 'Opus 4.8' }],
    }],
    tiers: TIERS.map(t => ({ tier: t, label: t })),
    tierBackend: Object.fromEntries(TIERS.map(t => [t, { backend: 'claude', model: 'claude-opus-4-8' }])),
    tierEffort,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    roles: [{ role: 'conductor', label: 'Conductor', builtin: true }],
    roleBackend: { conductor: { kind: 'tier', tier: 'powerful' } },
    roleEffort: { conductor: { effort: 'inherit', inheritsTo: 'high' } },
    enabledTiers: Object.fromEntries(TIERS.map(t => [t, true])),
    defaultSpawnTier: 'powerful',
    customModels: [], ollamaCloudModels: [], ollamaCloudTierDefaults: {},
  };
}

test('models.ts: pre-fetch reads the DEFAULT_EFFORT seed, then adopts the payload\'s defaultEffort', async () => {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  const models = await import(
    pathToFileURL(path.resolve(__dirname, '..', 'shared', 'models.ts')).href + '?prefetch=1');

  // Before any fetch: the seed mirrors src/effortLevels.ts DEFAULT_EFFORT, so a
  // first paint can't advertise a level the server would never resolve.
  for (const t of TIERS) assert.equal(models.getActiveTierEffort(t), 'high');

  // After the fetch: a tier the payload omits falls back to the SHIPPED default,
  // not to the stale seed.
  globalThis.fetch = () => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({ ...modelsPayload({ balanced: 'max' }), defaultEffort: 'medium' }),
  });
  await models.loadModelVersions();
  assert.equal(models.getActiveTierEffort('balanced'), 'max', 'a shipped level wins');
  assert.equal(models.getActiveTierEffort('frontier'), 'medium', 'an absent one uses defaultEffort');
});
