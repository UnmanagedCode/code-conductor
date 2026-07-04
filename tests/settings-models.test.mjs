import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  MODEL_FAMILIES, DEFAULT_VERSIONS, isKnownFamily, isKnownVersion, defaultVersion,
} from '../src/modelVersions.js';
import {
  getModelVersion, setModelVersion, getTranscribeModel, setTranscribeModel,
  getOnOverageAction, setOnOverageAction,
  getOverageThreshold, setOverageThreshold,
  getConductorCompactWindow, setConductorCompactWindow,
  getSonnetContextWindow, setSonnetContextWindow,
  getEnabledFamilies, setFamilyEnabled,
  getDefaultSpawnFamily, setDefaultSpawnFamily,
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

// ── Catalog ────────────────────────────────────────────────────────────
test('modelVersions catalog: families, defaults, and validators', () => {
  assert.deepEqual(MODEL_FAMILIES.map(f => f.family), ['fable', 'opus', 'sonnet', 'haiku']);
  // Every family default is itself a known version of that family.
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

// ── appSettings ─────────────────────────────────────────────────────────
test('appSettings: getModelVersion null when unset, setModelVersion round-trips', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      assert.equal(getModelVersion('opus'), null);
      await setModelVersion('opus', 'claude-opus-4-7');
      assert.equal(getModelVersion('opus'), 'claude-opus-4-7');
      // Other families remain unset (independent keys).
      assert.equal(getModelVersion('sonnet'), null);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: models namespace does not clobber transcribe', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await setTranscribeModel('base.en-q5_1');
      await setModelVersion('sonnet', 'claude-sonnet-4-5');
      assert.equal(getTranscribeModel(), 'base.en-q5_1');
      assert.equal(getModelVersion('sonnet'), 'claude-sonnet-4-5');
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── REST endpoints ──────────────────────────────────────────────────────
test('GET /api/settings/models returns catalog + active defaults', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    const r = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.families.map(f => f.family), ['fable', 'opus', 'sonnet', 'haiku']);
    // Unset → catalog defaults.
    assert.equal(r.body.active.fable, 'claude-fable-5');
    assert.equal(r.body.active.sonnet, 'claude-sonnet-5');
    assert.equal(r.body.active.opus, 'claude-opus-4-8');
    assert.equal(r.body.active.haiku, 'claude-haiku-4-5');
  }
});

test('POST /api/settings/models switches a family version and persists', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    const r = await api(baseUrl, 'POST', '/api/settings/models', { family: 'sonnet', version: 'claude-sonnet-4-5' });
    assert.equal(r.status, 200);
    assert.equal(r.body.active.sonnet, 'claude-sonnet-4-5');
    assert.equal(r.body.active.opus, 'claude-opus-4-8'); // untouched
    const g = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(g.body.active.sonnet, 'claude-sonnet-4-5');
  }
});

test('POST /api/settings/models rejects unknown family + version', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    const badFamily = await api(baseUrl, 'POST', '/api/settings/models', { family: 'gpt', version: 'claude-opus-4-8' });
    assert.equal(badFamily.status, 400);
    const badVersion = await api(baseUrl, 'POST', '/api/settings/models', { family: 'opus', version: 'nope' });
    assert.equal(badVersion.status, 400);
    // Cross-family version is also rejected.
    const crossFamily = await api(baseUrl, 'POST', '/api/settings/models', { family: 'sonnet', version: 'claude-opus-4-8' });
    assert.equal(crossFamily.status, 400);
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
      await setModelVersion('sonnet', 'claude-sonnet-4-5');
      await setOnOverageAction('stop-resume');
      assert.equal(getModelVersion('sonnet'), 'claude-sonnet-4-5');
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
      await setModelVersion('sonnet', 'claude-sonnet-4-5');
      await setOnOverageAction('stop');
      await setConductorCompactWindow({ enabled: true, value: 400 });
      assert.equal(getModelVersion('sonnet'), 'claude-sonnet-4-5');
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
      await setModelVersion('sonnet', 'claude-sonnet-4-5');
      await setOnOverageAction('stop');
      await setSonnetContextWindow('200k');
      assert.equal(getModelVersion('sonnet'), 'claude-sonnet-4-5');
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

// ── enabledFamilies ─────────────────────────────────────────────────────
test('appSettings: getEnabledFamilies defaults all-true when unset', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      const ef = getEnabledFamilies();
      assert.equal(ef.fable, true);
      assert.equal(ef.opus, true);
      assert.equal(ef.sonnet, true);
      assert.equal(ef.haiku, true);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: setFamilyEnabled round-trips', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      const result = await setFamilyEnabled('fable', false);
      assert.equal(result.enabledFamilies.fable, false);
      assert.equal(getEnabledFamilies().fable, false);
      await setFamilyEnabled('fable', true);
      assert.equal(getEnabledFamilies().fable, true);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: setFamilyEnabled prevents disabling the last enabled family', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await setFamilyEnabled('fable', false);
      await setFamilyEnabled('sonnet', false);
      await setFamilyEnabled('haiku', false);
      // Only opus remains — disabling it must throw.
      await assert.rejects(
        () => setFamilyEnabled('opus', false),
        /cannot disable the last enabled family/i,
      );
      assert.equal(getEnabledFamilies().opus, true);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: setFamilyEnabled auto-reassigns default when disabling the default family', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await setDefaultSpawnFamily('fable');
      assert.equal(getDefaultSpawnFamily(), 'fable');
      const result = await setFamilyEnabled('fable', false);
      // Default must no longer be fable.
      assert.notEqual(result.defaultSpawnFamily, 'fable');
      assert.notEqual(getDefaultSpawnFamily(), 'fable');
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('GET /api/settings/models includes enabledFamilies defaulting all-true', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    const r = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.enabledFamilies, { fable: true, opus: true, sonnet: true, haiku: true });
  }
});

test('POST /api/settings/models/prefs with familyEnabled toggles a family and persists', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    const off = await api(baseUrl, 'POST', '/api/settings/models/prefs', { familyEnabled: { family: 'fable', enabled: false } });
    assert.equal(off.status, 200);
    assert.equal(off.body.enabledFamilies.fable, false);
    const g = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(g.body.enabledFamilies.fable, false);
    const on = await api(baseUrl, 'POST', '/api/settings/models/prefs', { familyEnabled: { family: 'fable', enabled: true } });
    assert.equal(on.body.enabledFamilies.fable, true);
  }
});

test('POST /api/settings/models/prefs rejects disabling the last enabled family', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    await api(baseUrl, 'POST', '/api/settings/models/prefs', { familyEnabled: { family: 'fable', enabled: false } });
    await api(baseUrl, 'POST', '/api/settings/models/prefs', { familyEnabled: { family: 'sonnet', enabled: false } });
    await api(baseUrl, 'POST', '/api/settings/models/prefs', { familyEnabled: { family: 'haiku', enabled: false } });
    // Only opus remains — disabling it must return 4xx.
    const r = await api(baseUrl, 'POST', '/api/settings/models/prefs', { familyEnabled: { family: 'opus', enabled: false } });
    assert.ok(r.status >= 400, `expected 4xx but got ${r.status}`);
  }
});

test('POST /api/settings/models/prefs rejects unknown or missing family in familyEnabled', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    // Unknown family name must be rejected with 400.
    const bad = await api(baseUrl, 'POST', '/api/settings/models/prefs', { familyEnabled: { family: 'gpt', enabled: false } });
    assert.equal(bad.status, 400);
    // Missing family field must be rejected with 400.
    const noFamily = await api(baseUrl, 'POST', '/api/settings/models/prefs', { familyEnabled: { enabled: false } });
    assert.equal(noFamily.status, 400);
    // Non-object payload must be rejected with 400.
    const nonObj = await api(baseUrl, 'POST', '/api/settings/models/prefs', { familyEnabled: 'fable' });
    assert.equal(nonObj.status, 400);
    // Valid family is still accepted (smoke-check route remains functional).
    const ok = await api(baseUrl, 'POST', '/api/settings/models/prefs', { familyEnabled: { family: 'fable', enabled: false } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.enabledFamilies.fable, false);
  }
});

// ── defaultSpawnFamily ──────────────────────────────────────────────────
test('appSettings: getDefaultSpawnFamily defaults "opus" when unset', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      assert.equal(getDefaultSpawnFamily(), 'opus');
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: setDefaultSpawnFamily round-trips valid families', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      assert.equal(await setDefaultSpawnFamily('fable'), 'fable');
      assert.equal(getDefaultSpawnFamily(), 'fable');
      assert.equal(await setDefaultSpawnFamily('haiku'), 'haiku');
      assert.equal(getDefaultSpawnFamily(), 'haiku');
      // Invalid value falls back to opus.
      assert.equal(await setDefaultSpawnFamily('gpt'), 'opus');
      assert.equal(getDefaultSpawnFamily(), 'opus');
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('GET /api/settings/models includes defaultSpawnFamily defaulting "opus"', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    const r = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(r.status, 200);
    assert.equal(r.body.defaultSpawnFamily, 'opus');
  }
});

test('POST /api/settings/models/prefs sets defaultSpawnFamily and persists', async () => {
  {  // shared server (before/after) + fresh PROJECTS_ROOT per test (beforeEach)
    const r = await api(baseUrl, 'POST', '/api/settings/models/prefs', { defaultSpawnFamily: 'fable' });
    assert.equal(r.status, 200);
    assert.equal(r.body.defaultSpawnFamily, 'fable');
    const g = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(g.body.defaultSpawnFamily, 'fable');
    // Reset.
    const r2 = await api(baseUrl, 'POST', '/api/settings/models/prefs', { defaultSpawnFamily: 'opus' });
    assert.equal(r2.body.defaultSpawnFamily, 'opus');
  }
});
