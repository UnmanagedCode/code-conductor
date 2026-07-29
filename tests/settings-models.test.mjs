import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { orchStoreRoot } from '../src/projects.js';
import {
  MODEL_FAMILIES, DEFAULT_VERSIONS, PROVIDERS, isKnownFamily, isKnownVersion, defaultVersion,
  isKnownClaudeModel, CAPABILITY_TIERS, DEFAULT_TIER_BACKEND, isKnownTier,
} from '../src/modelVersions.js';
import { OLLAMA_CLOUD_MODELS, OLLAMA_CLOUD_TIER_DEFAULTS, isKnownOllamaCloudModel } from '../src/ollamaCloudModels.js';
import {
  getTranscribeModel, setTranscribeModel,
  getOnOverageAction, setOnOverageAction,
  getOverageThreshold, setOverageThreshold,
  getConductorCompactWindow, setConductorCompactWindow,
  getEnabledTiers, setTierEnabled,
  getDefaultSpawnTier, setDefaultSpawnTier,
  getTierBackend, setTierBackend, getRoleBinding, setRoleBinding, isKnownOllamaModel,
  getAllRoles, isResolvableRole, resolveRoleBackend,
  getCustomRoles, addCustomRole, removeCustomRole,
  addCustomBackend, removeCustomBackend, setPluginRolesProvider,
} from '../src/appSettings.js';

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-models-test-'));
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

// The REST endpoint tests below share ONE server (booted once here) instead of
// booting per test. Each test still gets a fresh PROJECTS_ROOT via beforeEach —
// the appSettings cache keys by settingsPath(), so a new root means every test
// reads pristine catalog defaults regardless of run order, and a mutating test
// can't leak settings into the next. The unit tests (mkTmp()+withEnv()) are
// self-isolating; these hooks only add a harmless extra temp dir for them.
let ctx, baseUrl, instances, home;
before(async () => { ctx = await bootServer(); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

// ── Catalog (backend catalog — unchanged, still Claude family-keyed) ────
test('modelVersions catalog: backends, defaults, and validators', () => {
  assert.deepEqual(MODEL_FAMILIES.map(f => f.family), ['fable', 'opus', 'sonnet', 'haiku']);
  // Every backend default is itself a known version of that backend.
  for (const f of MODEL_FAMILIES) {
    assert.equal(DEFAULT_VERSIONS[f.family], f.default);
    assert.ok(isKnownVersion(f.family, f.default), `${f.family} default in catalog`);
    assert.equal(defaultVersion(f.family), f.default);
  }
  assert.ok(isKnownFamily('opus'));
  assert.ok(!isKnownFamily('gpt'));
  assert.ok(isKnownVersion('sonnet', 'claude-sonnet-4-6'));
  assert.ok(!isKnownVersion('sonnet', 'totally-made-up'));
  // Cross-family id must be rejected (opus id under sonnet).
  assert.ok(!isKnownVersion('sonnet', 'claude-opus-4-8'));
  assert.equal(defaultVersion('nope'), null);
});

// ── Catalog (capability-tier layer) ─────────────────────────────────────
test('modelVersions catalog: tiers, providers + default {kind,model} bindings', () => {
  assert.deepEqual(CAPABILITY_TIERS.map(t => t.tier), ['fast', 'balanced', 'powerful', 'frontier']);
  assert.deepEqual(PROVIDERS.map(p => p.kind), ['claude', 'ollama']);
  // Every default tier binding is claude + a known Claude version.
  for (const t of CAPABILITY_TIERS) {
    const b = DEFAULT_TIER_BACKEND[t.tier];
    assert.equal(b.kind, 'claude');
    assert.ok(isKnownClaudeModel(b.model), `${t.tier}'s default model must be known`);
  }
  assert.ok(isKnownTier('fast'));
  assert.ok(!isKnownTier('sonnet'), 'a legacy family name is not a tier');
  assert.ok(!isKnownTier('medium'), 'the effort vocabulary must not collide with tiers');
});

// ── Ollama cloud preset catalog ─────────────────────────────────────────
test('ollamaCloudModels: 7-model catalog, tags verbatim, tier defaults, no global-default change', () => {
  assert.equal(OLLAMA_CLOUD_MODELS.length, 7);
  const tags = OLLAMA_CLOUD_MODELS.map(m => m.model);
  assert.ok(tags.includes('deepseek-v4-flash:cloud'));
  assert.ok(tags.includes('qwen3.5:cloud'));
  assert.ok(tags.includes('glm-5.2:cloud'));
  assert.ok(tags.includes('mistral-large-3:675b-cloud'), 'Mistral stays size-pinned, not normalized to :cloud');
  assert.ok(!tags.includes('gpt-oss:120b-cloud'), 'gpt-oss models were dropped from the catalog');
  assert.deepEqual(OLLAMA_CLOUD_TIER_DEFAULTS, {
    fast: 'deepseek-v4-flash:cloud',
    balanced: 'qwen3.5:cloud',
    powerful: 'glm-5.2:cloud',
  });
  assert.ok(isKnownOllamaCloudModel('glm-5.2:cloud'));
  assert.ok(!isKnownOllamaCloudModel('totally-made-up:cloud'));

  // Every curated model carries a positive native context window (raw tokens).
  for (const m of OLLAMA_CLOUD_MODELS) {
    assert.ok(Number.isFinite(m.contextWindow) && m.contextWindow > 0, `${m.model} has a contextWindow`);
  }
  assert.equal(OLLAMA_CLOUD_MODELS.find(m => m.model === 'minimax-m3:cloud').contextWindow, 1_000_000);
  assert.equal(OLLAMA_CLOUD_MODELS.find(m => m.model === 'qwen3.5:cloud').contextWindow, 256_000);

  // Decided: the catalog does NOT change the true out-of-the-box default —
  // every tier's DEFAULT_TIER_BACKEND stays Claude (unmodified assertion).
  for (const t of CAPABILITY_TIERS) {
    assert.equal(DEFAULT_TIER_BACKEND[t.tier].kind, 'claude');
  }
});

test('appSettings: isKnownOllamaModel accepts a catalog preset with no prior addCustomBackend, and tiers can bind straight to one', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      assert.ok(isKnownOllamaModel('qwen3.5:cloud'));
      await setTierBackend('fast', { kind: 'ollama', model: 'deepseek-v4-flash:cloud' });
      assert.deepEqual(getTierBackend('fast'), { kind: 'ollama', model: 'deepseek-v4-flash:cloud' });
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── appSettings ─────────────────────────────────────────────────────────
test('appSettings: models namespace does not clobber transcribe', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await setTranscribeModel('base.en-q5_1');
      await setTierBackend('balanced', { kind: 'claude', model: 'claude-sonnet-4-5' });
      assert.equal(getTranscribeModel(), 'base.en-q5_1');
      assert.deepEqual(getTierBackend('balanced'), { kind: 'claude', model: 'claude-sonnet-4-5' });
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── REST endpoints ──────────────────────────────────────────────────────
test('GET /api/settings/models returns providers, catalog, and {kind,model} tier bindings', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    const r = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.providers.map(p => p.kind), ['claude', 'ollama']);
    assert.deepEqual(r.body.backends.map(f => f.family), ['fable', 'opus', 'sonnet', 'haiku']);
    assert.equal(r.body.activeVersions, undefined); // removed
    assert.deepEqual(r.body.customBackends, []);
    assert.equal(r.body.ollamaCloudModels.length, 7);
    assert.ok(r.body.ollamaCloudModels.some(m => m.model === 'glm-5.2:cloud'));
    // Each curated model ships its native context window (raw tokens).
    const ctxByTag = Object.fromEntries(r.body.ollamaCloudModels.map(m => [m.model, m.contextWindow]));
    assert.deepEqual(ctxByTag, {
      'deepseek-v4-flash:cloud': 1_000_000,
      'deepseek-v4-pro:cloud':   1_000_000,
      'glm-5.2:cloud':           1_000_000,
      'minimax-m3:cloud':        1_000_000,
      'qwen3.5:cloud':             256_000,
      'kimi-k2.7-code:cloud':      256_000,
      'mistral-large-3:675b-cloud': 256_000,
    });
    assert.deepEqual(r.body.ollamaCloudTierDefaults, {
      fast: 'deepseek-v4-flash:cloud', balanced: 'qwen3.5:cloud', powerful: 'glm-5.2:cloud',
    });
    assert.deepEqual(r.body.tiers.map(t => t.tier), ['fast', 'balanced', 'powerful', 'frontier']);
    // Unset → default {kind,model} bindings (each family's default version).
    assert.deepEqual(r.body.tierBackend.powerful, { kind: 'claude', model: 'claude-opus-4-8' });
    assert.deepEqual(r.body.tierBackend.balanced, { kind: 'claude', model: 'claude-sonnet-5' });
  }
});

// ── onOverage (action on overage) ───────────────────────────────────────
test('appSettings: getOnOverageAction defaults "none", setOnOverageAction round-trips all three', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      assert.equal(getOnOverageAction(), 'none');
      assert.equal(await setOnOverageAction('stop'), 'stop');
      assert.equal(getOnOverageAction(), 'stop');
      assert.equal(await setOnOverageAction('stop-resume'), 'stop-resume');
      assert.equal(getOnOverageAction(), 'stop-resume');
      assert.equal(await setOnOverageAction('none'), 'none');
      assert.equal(getOnOverageAction(), 'none');
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: setOnOverageAction coerces unknown values to "none"', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      assert.equal(await setOnOverageAction('garbage'), 'none');
      assert.equal(getOnOverageAction(), 'none');
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: onOverage does not clobber model versions', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await setTierBackend('balanced', { kind: 'claude', model: 'claude-sonnet-4-5' });
      await setOnOverageAction('stop-resume');
      assert.deepEqual(getTierBackend('balanced'), { kind: 'claude', model: 'claude-sonnet-4-5' });
      assert.equal(getOnOverageAction(), 'stop-resume');
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('GET /api/settings/models includes onOverage defaulting "none"', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    const r = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(r.status, 200);
    assert.equal(r.body.onOverage, 'none');
  }
});

test('POST /api/settings/models/prefs sets onOverage and persists', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    const on = await api(baseUrl, 'POST', '/api/settings/models/prefs', { onOverage: 'stop-resume' });
    assert.equal(on.status, 200);
    assert.equal(on.body.onOverage, 'stop-resume');
    // Verify GET reflects the persisted state.
    const g = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(g.body.onOverage, 'stop-resume');
    // Back to off.
    const off = await api(baseUrl, 'POST', '/api/settings/models/prefs', { onOverage: 'none' });
    assert.equal(off.body.onOverage, 'none');
  }
});

test('POST /api/settings/models/prefs ignores unknown keys gracefully', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    const r = await api(baseUrl, 'POST', '/api/settings/models/prefs', { randomField: 'foo' });
    assert.equal(r.status, 200);
    assert.equal(r.body.onOverage, 'none');
  }
});

// ── conductorCompactWindow ──────────────────────────────────────────────
test('appSettings: getConductorCompactWindow defaults {enabled:false,value:200} when unset', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root, CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined }, async () => {
      const cw = getConductorCompactWindow();
      assert.equal(cw.enabled, false);
      assert.equal(cw.value, 200);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: setConductorCompactWindow round-trips enabled+value', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root, CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined }, async () => {
      const result = await setConductorCompactWindow({ enabled: true, value: 350 });
      assert.equal(result.enabled, true);
      assert.equal(result.value, 350);
      const cw = getConductorCompactWindow();
      assert.equal(cw.enabled, true);
      assert.equal(cw.value, 350);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: setConductorCompactWindow snaps to nearest 10k step', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root, CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined }, async () => {
      // 344 → 340 (rounds down, Math.round(34.4)=34)
      assert.equal((await setConductorCompactWindow({ enabled: true, value: 344 })).value, 340);
      // 346 → 350 (rounds up, Math.round(34.6)=35)
      assert.equal((await setConductorCompactWindow({ enabled: true, value: 346 })).value, 350);
      // 355 → 360 (rounds up, Math.round(35.5)=36 in JS)
      assert.equal((await setConductorCompactWindow({ enabled: true, value: 355 })).value, 360);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: setConductorCompactWindow clamps to [100, 1000]', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root, CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined }, async () => {
      assert.equal((await setConductorCompactWindow({ enabled: true, value: 5 })).value, 100);
      // The Claude Code CLI floors CLAUDE_CODE_AUTO_COMPACT_WINDOW at 100k tokens,
      // so a sub-100k value would silently behave as 100k anyway — clamp it explicitly
      // instead of letting the CLI's floor mask the user's chosen value.
      assert.equal((await setConductorCompactWindow({ enabled: true, value: 50 })).value, 100);
      assert.equal((await setConductorCompactWindow({ enabled: true, value: 9999 })).value, 1000);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: CLAUDE_CODE_AUTO_COMPACT_WINDOW env seeds {enabled:true, value:500}', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }, async () => {
      const cw = getConductorCompactWindow();
      assert.equal(cw.enabled, true);
      assert.equal(cw.value, 500);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: settings.json value wins over env seed', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }, async () => {
      await setConductorCompactWindow({ enabled: true, value: 300 });
      const cw = getConductorCompactWindow();
      assert.equal(cw.value, 300);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: setConductorCompactWindow does not clobber onOverage or model versions', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root, CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined }, async () => {
      await setTierBackend('balanced', { kind: 'claude', model: 'claude-sonnet-4-5' });
      await setOnOverageAction('stop');
      await setConductorCompactWindow({ enabled: true, value: 400 });
      assert.deepEqual(getTierBackend('balanced'), { kind: 'claude', model: 'claude-sonnet-4-5' });
      assert.equal(getOnOverageAction(), 'stop');
      assert.equal(getConductorCompactWindow().value, 400);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── overageThreshold ────────────────────────────────────────────────────
test('appSettings: getOverageThreshold defaults {enabled:false,value:85} when unset', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      const t = getOverageThreshold();
      assert.equal(t.enabled, false);
      assert.equal(t.value, 85);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: setOverageThreshold clamps to [10,99] and rounds to integer', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      assert.equal((await setOverageThreshold({ enabled: true, value: 5 })).value, 10);   // clamp low (floor 10)
      assert.equal((await setOverageThreshold({ enabled: true, value: 100 })).value, 99); // clamp high
      assert.equal((await setOverageThreshold({ enabled: true, value: 25 })).value, 25);  // low target now settable
      assert.equal((await setOverageThreshold({ enabled: true, value: 83 })).value, 83);  // no step snap — exact
      assert.equal((await setOverageThreshold({ enabled: true, value: 72.4 })).value, 72); // rounds to integer
      const t = getOverageThreshold();
      assert.equal(t.enabled, true);
      assert.equal(t.value, 72);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: setOverageThreshold does not clobber onOverage or compact window', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root, CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined }, async () => {
      await setOnOverageAction('stop');
      await setConductorCompactWindow({ enabled: true, value: 400 });
      await setOverageThreshold({ enabled: true, value: 90 });
      assert.equal(getOnOverageAction(), 'stop');
      assert.equal(getConductorCompactWindow().value, 400);
      assert.equal(getOverageThreshold().value, 90);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('GET /api/settings/models includes overageThreshold defaulting {enabled:false}', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    const r = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(r.status, 200);
    assert.ok('overageThreshold' in r.body, 'overageThreshold must be present');
    assert.equal(r.body.overageThreshold.enabled, false);
    assert.equal(typeof r.body.overageThreshold.value, 'number');
  }
});

test('POST /api/settings/models/prefs saves overageThreshold (clamp) without clobbering onOverage', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    await api(baseUrl, 'POST', '/api/settings/models/prefs', { onOverage: 'stop' });
    const r = await api(baseUrl, 'POST', '/api/settings/models/prefs', {
      overageThreshold: { enabled: true, value: 25 },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.overageThreshold.enabled, true);
    assert.equal(r.body.overageThreshold.value, 25, 'low target persists unsnapped');
    assert.equal(r.body.onOverage, 'stop', 'onOverage must not be clobbered');
    const g = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(g.body.overageThreshold.enabled, true);
    assert.equal(g.body.overageThreshold.value, 25);
  }
});

test('GET /api/settings/models includes conductorCompactWindow defaulting {enabled:false}', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    await withEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined }, async () => {
      const r = await api(baseUrl, 'GET', '/api/settings/models');
      assert.equal(r.status, 200);
      assert.ok('conductorCompactWindow' in r.body, 'conductorCompactWindow must be present');
      assert.equal(r.body.conductorCompactWindow.enabled, false);
      assert.equal(typeof r.body.conductorCompactWindow.value, 'number');
    });
  }
});

test('POST /api/settings/models/prefs saves conductorCompactWindow without clobbering onOverage', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    await withEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined }, async () => {
      // Set the overage action first.
      await api(baseUrl, 'POST', '/api/settings/models/prefs', { onOverage: 'stop' });
      // Now set compact window.
      const r = await api(baseUrl, 'POST', '/api/settings/models/prefs', {
        conductorCompactWindow: { enabled: true, value: 400 },
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.conductorCompactWindow.enabled, true);
      assert.equal(r.body.conductorCompactWindow.value, 400);
      assert.equal(r.body.onOverage, 'stop', 'onOverage must not be clobbered');
      // Verify persistence via GET.
      const g = await api(baseUrl, 'GET', '/api/settings/models');
      assert.equal(g.body.conductorCompactWindow.enabled, true);
      assert.equal(g.body.conductorCompactWindow.value, 400);
    });
  }
});

// ── per-binding Sonnet window (no global) ────────────────────────────────
test('GET /api/settings/models no longer exposes a global sonnetContextWindow', async () => {
  const r = await api(baseUrl, 'GET', '/api/settings/models');
  assert.equal(r.status, 200);
  assert.ok(!('sonnetContextWindow' in r.body), 'the global key is gone');
});

test('appSettings: a Sonnet 4.x tier binding persists its own window', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await setTierBackend('balanced', { kind: 'claude', model: 'claude-sonnet-4-6', window: '200k' });
      assert.deepEqual(getTierBackend('balanced'), { kind: 'claude', model: 'claude-sonnet-4-6', window: '200k' });
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: window is NOT persisted for non-selectable bindings (Opus, Sonnet 5)', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      // Sonnet 5 is fixed-1M — the window is meaningless, so it is dropped.
      await setTierBackend('balanced', { kind: 'claude', model: 'claude-sonnet-5', window: '200k' });
      assert.deepEqual(getTierBackend('balanced'), { kind: 'claude', model: 'claude-sonnet-5' });
      // Opus never varies its window.
      await setTierBackend('powerful', { kind: 'claude', model: 'claude-opus-4-8', window: '200k' });
      assert.deepEqual(getTierBackend('powerful'), { kind: 'claude', model: 'claude-opus-4-8' });
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: two Sonnet 4.x bindings carry independent windows', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await setTierBackend('balanced', { kind: 'claude', model: 'claude-sonnet-4-6', window: '200k' });
      await setRoleBinding('reviewer', { kind: 'claude', model: 'claude-sonnet-4-5', window: '1m' });
      // Setting the role binding did NOT touch the tier binding's window.
      assert.equal(getTierBackend('balanced').window, '200k');
      assert.equal(getRoleBinding('reviewer').window, '1m');
      // …and flipping the tier binding to 1m leaves the role binding at 1m.
      await setTierBackend('balanced', { kind: 'claude', model: 'claude-sonnet-4-6', window: '1m' });
      assert.equal(getTierBackend('balanced').window, '1m');
      assert.equal(getRoleBinding('reviewer').window, '1m');
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('POST /api/settings/models/prefs persists a Sonnet 4.x tier window on the binding', async () => {
  const r = await api(baseUrl, 'POST', '/api/settings/models/prefs', {
    tierBackend: { tier: 'balanced', backend: { kind: 'claude', model: 'claude-sonnet-4-6', window: '200k' } },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tierBackend.balanced, { kind: 'claude', model: 'claude-sonnet-4-6', window: '200k' });
  const g = await api(baseUrl, 'GET', '/api/settings/models');
  assert.deepEqual(g.body.tierBackend.balanced, { kind: 'claude', model: 'claude-sonnet-4-6', window: '200k' });
});

// ── enabledTiers ─────────────────────────────────────────────────────────
test('appSettings: getEnabledTiers defaults all-true when unset', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      const et = getEnabledTiers();
      assert.equal(et.fast, true);
      assert.equal(et.balanced, true);
      assert.equal(et.powerful, true);
      assert.equal(et.frontier, true);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: setTierEnabled round-trips', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      const result = await setTierEnabled('frontier', false);
      assert.equal(result.enabledTiers.frontier, false);
      assert.equal(getEnabledTiers().frontier, false);
      await setTierEnabled('frontier', true);
      assert.equal(getEnabledTiers().frontier, true);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: setTierEnabled prevents disabling the last enabled tier', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await setTierEnabled('frontier', false);
      await setTierEnabled('balanced', false);
      await setTierEnabled('fast', false);
      // Only powerful remains — disabling it must throw.
      await assert.rejects(
        () => setTierEnabled('powerful', false),
        /cannot disable the last enabled tier/i,
      );
      assert.equal(getEnabledTiers().powerful, true);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: setTierEnabled auto-reassigns default when disabling the default tier', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await setDefaultSpawnTier('frontier');
      assert.equal(getDefaultSpawnTier(), 'frontier');
      const result = await setTierEnabled('frontier', false);
      // Default must no longer be frontier.
      assert.notEqual(result.defaultSpawnTier, 'frontier');
      assert.notEqual(getDefaultSpawnTier(), 'frontier');
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('GET /api/settings/models includes enabledTiers defaulting all-true', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    const r = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.enabledTiers, { fast: true, balanced: true, powerful: true, frontier: true });
  }
});

test('POST /api/settings/models/prefs with tierEnabled toggles a tier and persists', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    const off = await api(baseUrl, 'POST', '/api/settings/models/prefs', { tierEnabled: { tier: 'frontier', enabled: false } });
    assert.equal(off.status, 200);
    assert.equal(off.body.enabledTiers.frontier, false);
    const g = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(g.body.enabledTiers.frontier, false);
    const on = await api(baseUrl, 'POST', '/api/settings/models/prefs', { tierEnabled: { tier: 'frontier', enabled: true } });
    assert.equal(on.body.enabledTiers.frontier, true);
  }
});

test('POST /api/settings/models/prefs rejects disabling the last enabled tier', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    await api(baseUrl, 'POST', '/api/settings/models/prefs', { tierEnabled: { tier: 'frontier', enabled: false } });
    await api(baseUrl, 'POST', '/api/settings/models/prefs', { tierEnabled: { tier: 'balanced', enabled: false } });
    await api(baseUrl, 'POST', '/api/settings/models/prefs', { tierEnabled: { tier: 'fast', enabled: false } });
    // Only powerful remains — disabling it must return 4xx.
    const r = await api(baseUrl, 'POST', '/api/settings/models/prefs', { tierEnabled: { tier: 'powerful', enabled: false } });
    assert.ok(r.status >= 400, `expected 4xx but got ${r.status}`);
  }
});

test('POST /api/settings/models/prefs rejects unknown or missing tier in tierEnabled', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    // Unknown tier name must be rejected with 400.
    const bad = await api(baseUrl, 'POST', '/api/settings/models/prefs', { tierEnabled: { tier: 'sonnet', enabled: false } });
    assert.equal(bad.status, 400);
    // Missing tier field must be rejected with 400.
    const noTier = await api(baseUrl, 'POST', '/api/settings/models/prefs', { tierEnabled: { enabled: false } });
    assert.equal(noTier.status, 400);
    // Non-object payload must be rejected with 400.
    const nonObj = await api(baseUrl, 'POST', '/api/settings/models/prefs', { tierEnabled: 'frontier' });
    assert.equal(nonObj.status, 400);
    // Valid tier is still accepted (smoke-check route remains functional).
    const ok = await api(baseUrl, 'POST', '/api/settings/models/prefs', { tierEnabled: { tier: 'frontier', enabled: false } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.enabledTiers.frontier, false);
  }
});

// ── defaultSpawnTier ─────────────────────────────────────────────────────
test('appSettings: getDefaultSpawnTier defaults "powerful" when unset', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      assert.equal(getDefaultSpawnTier(), 'powerful');
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: setDefaultSpawnTier round-trips valid tiers', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      assert.equal(await setDefaultSpawnTier('frontier'), 'frontier');
      assert.equal(getDefaultSpawnTier(), 'frontier');
      assert.equal(await setDefaultSpawnTier('fast'), 'fast');
      assert.equal(getDefaultSpawnTier(), 'fast');
      // Invalid value falls back to powerful.
      assert.equal(await setDefaultSpawnTier('gpt'), 'powerful');
      assert.equal(getDefaultSpawnTier(), 'powerful');
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('GET /api/settings/models includes defaultSpawnTier defaulting "powerful"', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    const r = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(r.status, 200);
    assert.equal(r.body.defaultSpawnTier, 'powerful');
  }
});

test('POST /api/settings/models/prefs sets defaultSpawnTier and persists', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    const r = await api(baseUrl, 'POST', '/api/settings/models/prefs', { defaultSpawnTier: 'frontier' });
    assert.equal(r.status, 200);
    assert.equal(r.body.defaultSpawnTier, 'frontier');
    const g = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(g.body.defaultSpawnTier, 'frontier');
    // Reset.
    const r2 = await api(baseUrl, 'POST', '/api/settings/models/prefs', { defaultSpawnTier: 'powerful' });
    assert.equal(r2.body.defaultSpawnTier, 'powerful');
  }
});

// ── tierBackend (tier→{kind,model} binding) ─────────────────────────────
test('appSettings: getTierBackend defaults to DEFAULT_TIER_BACKEND when unset', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      assert.deepEqual(getTierBackend('fast'), DEFAULT_TIER_BACKEND.fast);
      assert.deepEqual(getTierBackend('powerful'), { kind: 'claude', model: 'claude-opus-4-8' });
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: setTierBackend round-trips and rebinding one tier leaves others untouched', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await setTierBackend('powerful', { kind: 'claude', model: 'claude-fable-5' });
      assert.deepEqual(getTierBackend('powerful'), { kind: 'claude', model: 'claude-fable-5' });
      // Other tiers keep their default binding.
      assert.deepEqual(getTierBackend('fast'), DEFAULT_TIER_BACKEND.fast);
      assert.deepEqual(getTierBackend('balanced'), DEFAULT_TIER_BACKEND.balanced);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: setTierBackend rejects unknown tier or backend', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await assert.rejects(() => setTierBackend('medium', { kind: 'claude', model: 'claude-opus-4-8' }));
      await assert.rejects(() => setTierBackend('fast', { kind: 'claude', model: 'not-a-version' }));
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('POST /api/settings/models/prefs with tierBackend rebinds a tier and persists', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    const r = await api(baseUrl, 'POST', '/api/settings/models/prefs', { tierBackend: { tier: 'powerful', backend: { kind: 'claude', model: 'claude-fable-5' } } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.tierBackend.powerful, { kind: 'claude', model: 'claude-fable-5' });
    const g = await api(baseUrl, 'GET', '/api/settings/models');
    assert.deepEqual(g.body.tierBackend.powerful, { kind: 'claude', model: 'claude-fable-5' });
  }
});

test('POST /api/settings/models/prefs rejects unknown tier or backend in tierBackend', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    const badTier = await api(baseUrl, 'POST', '/api/settings/models/prefs', { tierBackend: { tier: 'medium', backend: { kind: 'claude', model: 'claude-opus-4-8' } } });
    assert.equal(badTier.status, 400);
    const badBackend = await api(baseUrl, 'POST', '/api/settings/models/prefs', { tierBackend: { tier: 'fast', backend: { kind: 'claude', model: 'nope' } } });
    assert.equal(badBackend.status, 400);
  }
});

// ── custom roles (appSettings) ──────────────────────────────────────────
test('appSettings: addCustomRole is name-only, defaults to powerful, and is seen by getAllRoles/isResolvableRole/resolveRoleBackend', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      // No binding given → defaults to the powerful tier.
      assert.deepEqual(await addCustomRole({ role: 'tester' }), { role: 'tester' });
      assert.deepEqual(getCustomRoles(), ['tester']); // name-only string list
      assert.deepEqual(getRoleBinding('tester'), { kind: 'tier', tier: 'powerful' });
      assert.ok(isResolvableRole('tester'));
      assert.deepEqual(resolveRoleBackend('tester'), getTierBackend('powerful'));
      const all = getAllRoles();
      assert.ok(all.some(r => r.role === 'conductor' && r.builtin === true && r.label));
      // Custom entries are name-only — no label field.
      const custom = all.find(r => r.role === 'tester');
      assert.ok(custom && !custom.builtin && !custom.plugin && custom.label === undefined);
      // An explicit binding is honored when provided.
      await addCustomRole({ role: 'claudey', binding: { kind: 'claude', model: 'claude-haiku-4-5' } });
      assert.deepEqual(getRoleBinding('claudey'), { kind: 'claude', model: 'claude-haiku-4-5' });
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: addCustomRole rejects reserved names, bad names, and bad bindings (case-insensitive collisions)', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await assert.rejects(() => addCustomRole({ role: 'fast' }), /collides/);       // capability tier
      await assert.rejects(() => addCustomRole({ role: 'Fast' }), /collides/);       // tier, different case
      await assert.rejects(() => addCustomRole({ role: 'Reviewer' }), /collides/);   // built-in role, different case
      await assert.rejects(() => addCustomRole({ role: 'OPUS' }), /collides/);        // family alias, different case
      await assert.rejects(() => addCustomRole({ role: 'Bad Name' }), /must match/);  // space
      await assert.rejects(() => addCustomRole({ role: 'plug/in' }), /must match/);   // '/' reserved
      await assert.rejects(() => addCustomRole({ role: 'x', binding: { kind: 'claude', model: 'nope' } }), /binding/);
      await addCustomRole({ role: 'Tester' });                                       // mixed case preserved
      assert.deepEqual(getCustomRoles(), ['Tester']);
      await assert.rejects(() => addCustomRole({ role: 'tester' }), /already exists/); // case-insensitive dupe
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: role NAME matching is case-insensitive for resolve + rebind', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await addCustomRole({ role: 'MyRole' }); // stored case-preserved
      assert.ok(isResolvableRole('myrole'));
      assert.ok(isResolvableRole('MYROLE'));
      // Resolve by a different case → same binding as the stored name.
      assert.deepEqual(resolveRoleBackend('myrole'), getTierBackend('powerful'));
      // Rebind by a different case updates the SAME key (no duplicate).
      await setRoleBinding('myrole', { kind: 'tier', tier: 'fast' });
      assert.deepEqual(getCustomRoles(), ['MyRole']);
      assert.deepEqual(getRoleBinding('MyRole'), { kind: 'tier', tier: 'fast' });
      // Built-in role rebind is also case-insensitive.
      await setRoleBinding('Reviewer', { kind: 'tier', tier: 'fast' });
      assert.deepEqual(getRoleBinding('reviewer'), { kind: 'tier', tier: 'fast' });
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: setRoleBinding rebinds a custom role; removeCustomRole cleans the binding (case-insensitive)', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await addCustomRole({ role: 'tester', binding: { kind: 'claude', model: 'claude-opus-4-8' } });
      await setRoleBinding('tester', { kind: 'tier', tier: 'balanced' });
      assert.deepEqual(getRoleBinding('tester'), { kind: 'tier', tier: 'balanced' });
      // Remove by a different case drops the role AND its binding; idempotent.
      assert.equal(await removeCustomRole('TESTER'), true);
      assert.equal(getCustomRoles().length, 0);
      assert.ok(!isResolvableRole('tester'));
      assert.equal(await removeCustomRole('tester'), false);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: a custom role whose Ollama backend is removed falls back to the default spawn tier', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await addCustomBackend({ label: 'Local', model: 'local:tag' });
      await addCustomRole({ role: 'tester', binding: { kind: 'ollama', model: 'local:tag' } });
      assert.deepEqual(getRoleBinding('tester'), { kind: 'ollama', model: 'local:tag' });
      await removeCustomBackend('local:tag'); // binding now dead
      assert.deepEqual(getRoleBinding('tester'), { kind: 'tier', tier: getDefaultSpawnTier() });
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: plugin roles resolve via the injected provider (case-insensitive) and are user-rebindable', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      setPluginRolesProvider(() => [{ role: 'p/cap', label: 'Cap', binding: { kind: 'tier', tier: 'fast' }, plugin: 'p' }]);
      try {
        assert.ok(isResolvableRole('P/CAP'));
        assert.deepEqual(resolveRoleBackend('P/Cap'), getTierBackend('fast')); // manifest default
        assert.ok(getAllRoles().some(r => r.role === 'p/cap' && r.plugin === 'p'));
        // A plugin role is user-rebindable: the override is persisted under the
        // namespaced id and BEATS the manifest binding at resolve time.
        await setRoleBinding('p/cap', { kind: 'tier', tier: 'powerful' });
        assert.deepEqual(getRoleBinding('p/cap'), { kind: 'tier', tier: 'powerful' });
        assert.deepEqual(resolveRoleBackend('P/Cap'), getTierBackend('powerful')); // override wins
        // A custom backend override (Claude version) round-trips and wins too.
        await setRoleBinding('p/cap', { kind: 'claude', model: 'claude-opus-4-8' });
        assert.deepEqual(resolveRoleBackend('p/cap'), { kind: 'claude', model: 'claude-opus-4-8' });
        // Reverting is done by re-selecting the manifest's tier in the same
        // picker (no dedicated reset) — rebinding to the manifest tier restores
        // the manifest behavior.
        await setRoleBinding('p/cap', { kind: 'tier', tier: 'fast' });
        assert.deepEqual(resolveRoleBackend('p/cap'), getTierBackend('fast'));
        // A custom name can never equal a plugin role name: plugin roles are
        // '<id>/<slug>' and the custom-name format rule forbids '/', so this is
        // rejected by the name-format rule (not a plugin-collision guard).
        await assert.rejects(() => addCustomRole({ role: 'p/cap' }), /must match/);
      } finally {
        setPluginRolesProvider(null); // restore default (no plugin host in this file)
      }
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: a plugin-role override is ignored while the plugin is disabled and retained on re-enable', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      setPluginRolesProvider(() => [{ role: 'p/cap', label: 'Cap', binding: { kind: 'tier', tier: 'fast' }, plugin: 'p' }]);
      try {
        await setRoleBinding('p/cap', { kind: 'tier', tier: 'powerful' }); // store an override
        assert.deepEqual(resolveRoleBackend('p/cap'), getTierBackend('powerful'));
        // Disable the plugin: the role is no longer resolvable, and resolve does
        // NOT leak the stale override (falls back to the default spawn tier, the
        // existing unknown-role behavior — the spawn ladder gates on isResolvableRole).
        setPluginRolesProvider(() => []);
        assert.equal(isResolvableRole('p/cap'), false);
        assert.deepEqual(resolveRoleBackend('p/cap'), getTierBackend(getDefaultSpawnTier()));
        // The override key is retained in settings.json (no purge)…
        assert.deepEqual(getRoleBinding('p/cap'), { kind: 'tier', tier: 'powerful' });
        // …and re-applies when the plugin comes back.
        setPluginRolesProvider(() => [{ role: 'p/cap', label: 'Cap', binding: { kind: 'tier', tier: 'fast' }, plugin: 'p' }]);
        assert.deepEqual(resolveRoleBackend('p/cap'), getTierBackend('powerful'));
      } finally {
        setPluginRolesProvider(null);
      }
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: a plugin-role override beats a dead manifest binding (drift)', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      // Manifest binds to a since-retired Claude model; a valid tier override
      // rescues the role instead of falling back to the default spawn tier.
      setPluginRolesProvider(() => [{ role: 'p/legacy', label: 'Legacy', binding: { kind: 'claude', model: 'claude-retired-9' }, plugin: 'p' }]);
      try {
        assert.deepEqual(resolveRoleBackend('p/legacy'), getTierBackend(getDefaultSpawnTier())); // manifest dead → default tier
        await setRoleBinding('p/legacy', { kind: 'tier', tier: 'fast' }); // user override to a live tier
        assert.deepEqual(resolveRoleBackend('p/legacy'), getTierBackend('fast')); // override wins over the dead manifest
      } finally {
        setPluginRolesProvider(null);
      }
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: a dead plugin-role override falls back to the manifest binding (plugin enabled)', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      // Manifest valid (haiku), override dead (retired claude) → manifest wins.
      // The override is planted directly in settings.json (simulating drift: a
      // model that was live when stored but later retired) because setRoleBinding
      // validates at store-time and correctly rejects a dead binding.
      setPluginRolesProvider(() => [{ role: 'p/scribe', label: 'S', binding: { kind: 'claude', model: 'claude-haiku-4-5' }, plugin: 'p' }]);
      try {
        const settingsFile = path.join(orchStoreRoot(), 'settings.json');
        await fs.mkdir(path.dirname(settingsFile), { recursive: true });
        await fs.writeFile(settingsFile, JSON.stringify({
          models: { roleBackend: { 'p/scribe': { kind: 'claude', model: 'claude-retired-9' } } },
        }));
        assert.deepEqual(resolveRoleBackend('p/scribe'), { kind: 'claude', model: 'claude-haiku-4-5' }); // falls back to manifest
      } finally {
        setPluginRolesProvider(null);
      }
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── custom roles (REST) ─────────────────────────────────────────────────
test('roles CRUD: POST creates name-only (defaults powerful), prefs rebinds, DELETE removes; GET merges', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    const c = await api(baseUrl, 'POST', '/api/settings/models/roles', { role: 'tester' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.deepEqual(c.body.added, { role: 'tester' });
    const row = c.body.roles.find(r => r.role === 'tester');
    assert.ok(row && !row.builtin && !row.plugin && row.label === undefined); // name-only
    assert.deepEqual(c.body.roleBackend.tester, { kind: 'tier', tier: 'powerful' }); // default binding
    // Duplicate (case-insensitive) → 409; reserved name → 400.
    assert.equal((await api(baseUrl, 'POST', '/api/settings/models/roles', { role: 'Tester' })).status, 409);
    assert.equal((await api(baseUrl, 'POST', '/api/settings/models/roles', { role: 'fast' })).status, 400);
    // Rebind a custom role via the shared prefs path (built-in parity).
    const rb = await api(baseUrl, 'POST', '/api/settings/models/prefs', { roleBackend: { role: 'tester', backend: { kind: 'claude', model: 'claude-opus-4-8' } } });
    assert.equal(rb.status, 200);
    assert.deepEqual(rb.body.roleBackend.tester, { kind: 'claude', model: 'claude-opus-4-8' });
    // No PATCH endpoint anymore (label was dropped).
    assert.equal((await api(baseUrl, 'PATCH', '/api/settings/models/roles/tester', { label: 'QA' })).status, 404);
    // Delete a custom role; deleting a built-in → 400; unknown → 404.
    const d = await api(baseUrl, 'DELETE', '/api/settings/models/roles/tester');
    assert.equal(d.status, 200);
    assert.ok(!d.body.roles.some(r => r.role === 'tester'));
    assert.equal((await api(baseUrl, 'DELETE', '/api/settings/models/roles/reviewer')).status, 400);
    // A case-variant of a built-in is still "known" → 400, not a 404 miss.
    assert.equal((await api(baseUrl, 'DELETE', '/api/settings/models/roles/Reviewer')).status, 400);
    assert.equal((await api(baseUrl, 'DELETE', '/api/settings/models/roles/ghost')).status, 404);
  }
});

test('GET /api/settings/models roles list carries built-in flags', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    const r = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(r.status, 200);
    const conductor = r.body.roles.find(x => x.role === 'conductor');
    assert.equal(conductor.builtin, true);
    assert.deepEqual(r.body.roleBackend.conductor, { kind: 'tier', tier: 'powerful' });
  }
});
