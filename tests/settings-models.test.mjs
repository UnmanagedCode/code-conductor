import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  MODEL_FAMILIES, DEFAULT_VERSIONS, PROVIDERS, isKnownFamily, isKnownVersion, defaultVersion,
  isKnownClaudeModel, CAPABILITY_TIERS, DEFAULT_TIER_BACKEND, isKnownTier,
} from '../src/modelVersions.js';
import {
  getTranscribeModel, setTranscribeModel,
  getOnOverageAction, setOnOverageAction,
  getOverageThreshold, setOverageThreshold,
  getConductorCompactWindow, setConductorCompactWindow,
  getSonnetContextWindow, setSonnetContextWindow,
  getEnabledTiers, setTierEnabled,
  getDefaultSpawnTier, setDefaultSpawnTier,
  getTierBackend, setTierBackend,
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

test('appSettings: setConductorCompactWindow clamps to [20, 1000]', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root, CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined }, async () => {
      assert.equal((await setConductorCompactWindow({ enabled: true, value: 5 })).value, 20);
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
    const r = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(r.status, 200);
    assert.ok('conductorCompactWindow' in r.body, 'conductorCompactWindow must be present');
    assert.equal(r.body.conductorCompactWindow.enabled, false);
    assert.equal(typeof r.body.conductorCompactWindow.value, 'number');
  }
});

test('POST /api/settings/models/prefs saves conductorCompactWindow without clobbering onOverage', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
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
  }
});

// ── sonnetContextWindow ─────────────────────────────────────────────────
test('appSettings: getSonnetContextWindow defaults to "1m" when unset', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      assert.equal(getSonnetContextWindow(), '1m');
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: setSonnetContextWindow round-trips "200k" and "1m"', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      assert.equal(await setSonnetContextWindow('200k'), '200k');
      assert.equal(getSonnetContextWindow(), '200k');
      assert.equal(await setSonnetContextWindow('1m'), '1m');
      assert.equal(getSonnetContextWindow(), '1m');
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: setSonnetContextWindow coerces unknown values to "1m"', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      assert.equal(await setSonnetContextWindow('garbage'), '1m');
      assert.equal(getSonnetContextWindow(), '1m');
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: setSonnetContextWindow does not clobber other model settings', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await setTierBackend('balanced', { kind: 'claude', model: 'claude-sonnet-4-5' });
      await setOnOverageAction('stop');
      await setSonnetContextWindow('200k');
      assert.deepEqual(getTierBackend('balanced'), { kind: 'claude', model: 'claude-sonnet-4-5' });
      assert.equal(getOnOverageAction(), 'stop');
      assert.equal(getSonnetContextWindow(), '200k');
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('GET /api/settings/models includes sonnetContextWindow defaulting "1m"', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    const r = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(r.status, 200);
    assert.equal(r.body.sonnetContextWindow, '1m');
  }
});

test('POST /api/settings/models/prefs sets sonnetContextWindow to "200k" and persists', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    const r = await api(baseUrl, 'POST', '/api/settings/models/prefs', { sonnetContextWindow: '200k' });
    assert.equal(r.status, 200);
    assert.equal(r.body.sonnetContextWindow, '200k');
    // Verify GET reflects the persisted value.
    const g = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(g.body.sonnetContextWindow, '200k');
    // Toggle back to 1m.
    const r2 = await api(baseUrl, 'POST', '/api/settings/models/prefs', { sonnetContextWindow: '1m' });
    assert.equal(r2.body.sonnetContextWindow, '1m');
  }
});

test('POST /api/settings/models/prefs sonnetContextWindow does not clobber onOverage', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    await api(baseUrl, 'POST', '/api/settings/models/prefs', { onOverage: 'stop' });
    const r = await api(baseUrl, 'POST', '/api/settings/models/prefs', { sonnetContextWindow: '200k' });
    assert.equal(r.status, 200);
    assert.equal(r.body.sonnetContextWindow, '200k');
    assert.equal(r.body.onOverage, 'stop', 'onOverage must not be clobbered');
  }
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
