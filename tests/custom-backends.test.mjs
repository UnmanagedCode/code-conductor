// Custom (Ollama-backed) capability-tier backends: the data model
// (models.customBackends CRUD), the relaxed validation gates (tier getter must
// NOT silently revert a custom binding; setter + Settings route accept custom
// ids), the familyOf 'ollama' sentinel (and its no-regression on
// canonicalizeModel), the map-shaped session-backends sidecar, and the
// ollamaBackend preflight URL/availability helpers + the add/remove routes.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  addCustomBackend, getCustomBackends, getCustomBackend, removeCustomBackend,
  isKnownCustomBackend, isKnownBackend, getTierBackend, setTierBackend,
} from '../src/appSettings.js';
import { familyOf, canonicalizeModel, isOllamaBackendId, OLLAMA_ID_PREFIX } from '../src/modelVersions.js';
import { getBackend, setBackend, deleteBackend, loadAll } from '../src/sessionBackends.js';
import { ollamaBaseUrl, checkOllamaReachable, checkModelAvailable, DEFAULT_OLLAMA_HOST } from '../src/ollamaBackend.js';

// ── familyOf sentinel + no-regression ──────────────────────────────────────
test('familyOf returns the ollama sentinel for custom ids, null otherwise', () => {
  assert.equal(familyOf('ollama:local-gpt'), 'ollama');
  assert.equal(familyOf('claude-opus-4-8'), 'opus');
  assert.equal(familyOf('gemma4:cloud'), null); // a bare ollama tag is NOT a backend id
  assert.equal(isOllamaBackendId('ollama:x'), true);
  assert.equal(isOllamaBackendId('claude-opus-4-8'), false);
});

test('canonicalizeModel is unaffected by the ollama sentinel', () => {
  assert.equal(canonicalizeModel('ollama:local-gpt'), 'ollama:local-gpt');
  assert.equal(canonicalizeModel('claude-sonnet-5'), 'claude-sonnet-5[1m]');
  assert.equal(canonicalizeModel('claude-opus-4-8'), 'claude-opus-4-8');
});

// ── ollamaBackend preflight helpers (no live server needed) ─────────────────
test('ollamaBaseUrl normalizes host forms', () => {
  assert.equal(ollamaBaseUrl(''), `http://${DEFAULT_OLLAMA_HOST}`);
  assert.equal(ollamaBaseUrl('box:1234'), 'http://box:1234');
  assert.equal(ollamaBaseUrl('https://box:1234/'), 'https://box:1234');
});

test('checkOllamaReachable fails cleanly against an unreachable host', async () => {
  const r = await checkOllamaReachable('127.0.0.1:1'); // port 1 not listening
  assert.equal(r.ok, false);
  assert.match(r.error, /not reachable/);
  const m = await checkModelAvailable('127.0.0.1:1', 'whatever');
  assert.equal(m.ok, false);
});

// ── appSettings custom-backend CRUD + gates + sidecar (fresh store per test) ─
describe('custom-backend data model', () => {
  let home;
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => { await rmrf(home); });

  test('add / list / get / remove custom backends with prefixed ids', async () => {
    assert.deepEqual(getCustomBackends(), []);
    const rec = await addCustomBackend({ label: 'Local GPT', model: 'gemma4:cloud', host: '' });
    assert.ok(rec.id.startsWith(OLLAMA_ID_PREFIX));
    assert.equal(rec.model, 'gemma4:cloud');
    assert.equal(getCustomBackends().length, 1);
    assert.equal(getCustomBackend(rec.id).label, 'Local GPT');
    assert.equal(isKnownCustomBackend(rec.id), true);
    assert.equal(isKnownBackend(rec.id), true);
    assert.equal(isKnownBackend('opus'), true);
    assert.equal(isKnownBackend('nope'), false);

    const rec2 = await addCustomBackend({ label: 'Local GPT', model: 'other:tag' }); // same label
    assert.notEqual(rec2.id, rec.id); // id collision → suffixed

    assert.equal(await removeCustomBackend(rec.id), true);
    assert.equal(isKnownCustomBackend(rec.id), false);
    assert.equal(await removeCustomBackend('ollama:ghost'), false);
  });

  test('addCustomBackend rejects missing label/model', async () => {
    await assert.rejects(() => addCustomBackend({ label: '', model: 'x' }), /required/);
    await assert.rejects(() => addCustomBackend({ label: 'L', model: '' }), /required/);
  });

  test('tier getter does NOT silently revert a custom binding, and reverts a deleted one', async () => {
    const rec = await addCustomBackend({ label: 'Local', model: 'gemma4:cloud' });
    await setTierBackend('powerful', rec.id);
    assert.equal(getTierBackend('powerful'), rec.id); // the critical no-silent-revert assertion
    await removeCustomBackend(rec.id);
    assert.equal(getTierBackend('powerful'), 'opus'); // dead binding → default family
  });

  test('setTierBackend accepts a custom id and rejects an unknown one', async () => {
    const rec = await addCustomBackend({ label: 'Local', model: 'gemma4:cloud' });
    await assert.doesNotReject(() => setTierBackend('fast', rec.id));
    await assert.rejects(() => setTierBackend('fast', 'ollama:ghost'), /unknown/);
    await assert.rejects(() => setTierBackend('bogus-tier', rec.id), /unknown/);
  });

  test('session-backends sidecar: set / get / delete / empty-cleanup', async () => {
    assert.equal(await getBackend('sid-1'), null);
    await setBackend('sid-1', { kind: 'ollama', model: 'gemma4:cloud', host: 'box:1' });
    assert.deepEqual(await getBackend('sid-1'), { kind: 'ollama', model: 'gemma4:cloud', host: 'box:1' });
    await setBackend('sid-2', { kind: 'claude', model: 'x' }); // non-ollama dropped
    assert.equal(await getBackend('sid-2'), null);
    await setBackend('sid-3', { kind: 'ollama', model: '' }); // missing tag dropped
    assert.equal(await getBackend('sid-3'), null);
    assert.equal(await deleteBackend('sid-1'), true);
    assert.equal(await getBackend('sid-1'), null);
    assert.equal((await loadAll()).size, 0);
  });
});

// ── HTTP routes ─────────────────────────────────────────────────────────────
describe('custom-backend settings routes', () => {
  let ctx, baseUrl, home;
  before(async () => { ctx = await bootServer(); baseUrl = ctx.baseUrl; });
  after(async () => { await ctx.close(); });
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => { await ctx.instances.shutdown(); await rmrf(home); });

  test('GET /settings/models ships customBackends', async () => {
    await addCustomBackend({ label: 'Local', model: 'gemma4:cloud' });
    const r = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.customBackends));
    assert.equal(r.body.customBackends.length, 1);
  });

  test('prefs route binds a tier to a custom id and rejects an unknown backend', async () => {
    const rec = await addCustomBackend({ label: 'Local', model: 'gemma4:cloud' });
    const ok = await api(baseUrl, 'POST', '/api/settings/models/prefs', { tierBackend: { tier: 'balanced', backend: rec.id } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.tierBackend.balanced, rec.id);
    const bad = await api(baseUrl, 'POST', '/api/settings/models/prefs', { tierBackend: { tier: 'balanced', backend: 'ollama:ghost' } });
    assert.equal(bad.status, 400);
  });

  test('POST /settings/models/custom fails preflight against an unreachable host', async () => {
    const r = await api(baseUrl, 'POST', '/api/settings/models/custom', { label: 'Bad', model: 'x:y', host: '127.0.0.1:1' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not reachable/);
    assert.equal(getCustomBackends().length, 0); // nothing persisted
  });

  test('DELETE /settings/models/custom/:id removes a backend (404 when absent)', async () => {
    const rec = await addCustomBackend({ label: 'Local', model: 'gemma4:cloud' });
    const del = await api(baseUrl, 'DELETE', `/api/settings/models/custom/${encodeURIComponent(rec.id)}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.customBackends.length, 0);
    const del2 = await api(baseUrl, 'DELETE', '/api/settings/models/custom/ollama:ghost');
    assert.equal(del2.status, 404);
  });
});
