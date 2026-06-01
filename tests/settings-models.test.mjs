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
