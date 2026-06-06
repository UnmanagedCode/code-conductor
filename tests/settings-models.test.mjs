import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bootServer, api } from './helpers.mjs';
import {
  MODEL_FAMILIES, DEFAULT_VERSIONS, isKnownFamily, isKnownVersion, defaultVersion,
} from '../src/modelVersions.js';
import {
  getModelVersion, setModelVersion, getTranscribeModel, setTranscribeModel,
  getAutoStopOnOverage, setAutoStopOnOverage,
  getConductorCompactWindow, setConductorCompactWindow,
  getSonnetContextWindow, setSonnetContextWindow,
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

// ── Catalog ────────────────────────────────────────────────────────────
test('modelVersions catalog: families, defaults, and validators', () => {
  assert.deepEqual(MODEL_FAMILIES.map(f => f.family), ['opus', 'sonnet', 'haiku']);
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
  const { baseUrl, close } = await bootServer();
  try {
    const r = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.families.map(f => f.family), ['opus', 'sonnet', 'haiku']);
    // Unset → catalog defaults.
    assert.equal(r.body.active.sonnet, 'claude-sonnet-4-6');
    assert.equal(r.body.active.opus, 'claude-opus-4-8');
    assert.equal(r.body.active.haiku, 'claude-haiku-4-5');
  } finally { await close(); }
});

test('POST /api/settings/models switches a family version and persists', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const r = await api(baseUrl, 'POST', '/api/settings/models', { family: 'sonnet', version: 'claude-sonnet-4-5' });
    assert.equal(r.status, 200);
    assert.equal(r.body.active.sonnet, 'claude-sonnet-4-5');
    assert.equal(r.body.active.opus, 'claude-opus-4-8'); // untouched
    const g = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(g.body.active.sonnet, 'claude-sonnet-4-5');
  } finally { await close(); }
});

test('POST /api/settings/models rejects unknown family + version', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const badFamily = await api(baseUrl, 'POST', '/api/settings/models', { family: 'gpt', version: 'claude-opus-4-8' });
    assert.equal(badFamily.status, 400);
    const badVersion = await api(baseUrl, 'POST', '/api/settings/models', { family: 'opus', version: 'nope' });
    assert.equal(badVersion.status, 400);
    // Cross-family version is also rejected.
    const crossFamily = await api(baseUrl, 'POST', '/api/settings/models', { family: 'sonnet', version: 'claude-opus-4-8' });
    assert.equal(crossFamily.status, 400);
  } finally { await close(); }
});

// ── autoStopOnOverage ───────────────────────────────────────────────────
test('appSettings: getAutoStopOnOverage defaults false, setAutoStopOnOverage round-trips', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      assert.equal(getAutoStopOnOverage(), false);
      await setAutoStopOnOverage(true);
      assert.equal(getAutoStopOnOverage(), true);
      await setAutoStopOnOverage(false);
      assert.equal(getAutoStopOnOverage(), false);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: autoStopOnOverage coerces to boolean', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await setAutoStopOnOverage(1);
      assert.equal(getAutoStopOnOverage(), true);
      await setAutoStopOnOverage(0);
      assert.equal(getAutoStopOnOverage(), false);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('appSettings: autoStopOnOverage does not clobber model versions', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await setModelVersion('sonnet', 'claude-sonnet-4-5');
      await setAutoStopOnOverage(true);
      assert.equal(getModelVersion('sonnet'), 'claude-sonnet-4-5');
      assert.equal(getAutoStopOnOverage(), true);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('GET /api/settings/models includes autoStopOnOverage defaulting false', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const r = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(r.status, 200);
    assert.equal(r.body.autoStopOnOverage, false);
  } finally { await close(); }
});

test('POST /api/settings/models/prefs toggles autoStopOnOverage and persists', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const on = await api(baseUrl, 'POST', '/api/settings/models/prefs', { autoStopOnOverage: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.autoStopOnOverage, true);
    // Verify GET reflects the persisted state.
    const g = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(g.body.autoStopOnOverage, true);
    // Toggle back off.
    const off = await api(baseUrl, 'POST', '/api/settings/models/prefs', { autoStopOnOverage: false });
    assert.equal(off.body.autoStopOnOverage, false);
  } finally { await close(); }
});

test('POST /api/settings/models/prefs ignores unknown keys gracefully', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const r = await api(baseUrl, 'POST', '/api/settings/models/prefs', { randomField: 'foo' });
    assert.equal(r.status, 200);
    assert.equal(r.body.autoStopOnOverage, false);
  } finally { await close(); }
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

test('appSettings: setConductorCompactWindow does not clobber autoStopOnOverage or model versions', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root, CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined }, async () => {
      await setModelVersion('sonnet', 'claude-sonnet-4-5');
      await setAutoStopOnOverage(true);
      await setConductorCompactWindow({ enabled: true, value: 400 });
      assert.equal(getModelVersion('sonnet'), 'claude-sonnet-4-5');
      assert.equal(getAutoStopOnOverage(), true);
      assert.equal(getConductorCompactWindow().value, 400);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('GET /api/settings/models includes conductorCompactWindow defaulting {enabled:false}', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const r = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(r.status, 200);
    assert.ok('conductorCompactWindow' in r.body, 'conductorCompactWindow must be present');
    assert.equal(r.body.conductorCompactWindow.enabled, false);
    assert.equal(typeof r.body.conductorCompactWindow.value, 'number');
  } finally { await close(); }
});

test('POST /api/settings/models/prefs saves conductorCompactWindow without clobbering autoStopOnOverage', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    // Enable auto-stop first.
    await api(baseUrl, 'POST', '/api/settings/models/prefs', { autoStopOnOverage: true });
    // Now set compact window.
    const r = await api(baseUrl, 'POST', '/api/settings/models/prefs', {
      conductorCompactWindow: { enabled: true, value: 400 },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.conductorCompactWindow.enabled, true);
    assert.equal(r.body.conductorCompactWindow.value, 400);
    assert.equal(r.body.autoStopOnOverage, true, 'autoStopOnOverage must not be clobbered');
    // Verify persistence via GET.
    const g = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(g.body.conductorCompactWindow.enabled, true);
    assert.equal(g.body.conductorCompactWindow.value, 400);
  } finally { await close(); }
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
      await setAutoStopOnOverage(true);
      await setSonnetContextWindow('200k');
      assert.equal(getModelVersion('sonnet'), 'claude-sonnet-4-5');
      assert.equal(getAutoStopOnOverage(), true);
      assert.equal(getSonnetContextWindow(), '200k');
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('GET /api/settings/models includes sonnetContextWindow defaulting "1m"', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const r = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(r.status, 200);
    assert.equal(r.body.sonnetContextWindow, '1m');
  } finally { await close(); }
});

test('POST /api/settings/models/prefs sets sonnetContextWindow to "200k" and persists', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const r = await api(baseUrl, 'POST', '/api/settings/models/prefs', { sonnetContextWindow: '200k' });
    assert.equal(r.status, 200);
    assert.equal(r.body.sonnetContextWindow, '200k');
    // Verify GET reflects the persisted value.
    const g = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(g.body.sonnetContextWindow, '200k');
    // Toggle back to 1m.
    const r2 = await api(baseUrl, 'POST', '/api/settings/models/prefs', { sonnetContextWindow: '1m' });
    assert.equal(r2.body.sonnetContextWindow, '1m');
  } finally { await close(); }
});

test('POST /api/settings/models/prefs sonnetContextWindow does not clobber autoStopOnOverage', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    await api(baseUrl, 'POST', '/api/settings/models/prefs', { autoStopOnOverage: true });
    const r = await api(baseUrl, 'POST', '/api/settings/models/prefs', { sonnetContextWindow: '200k' });
    assert.equal(r.status, 200);
    assert.equal(r.body.sonnetContextWindow, '200k');
    assert.equal(r.body.autoStopOnOverage, true, 'autoStopOnOverage must not be clobbered');
  } finally { await close(); }
});
