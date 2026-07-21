// Backend-agnostic tiers: the {kind, model} data model (custom Ollama models,
// tier bindings, validation gates + no-silent-revert), the Claude-only familyOf
// (canonicalize no-op for tags), the Set-shaped ollama-session sidecar, the
// localhost-only Ollama preflight, and the Settings routes (providers +
// {kind,model} binding + custom add/remove).

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  addCustomBackend, getCustomBackends, removeCustomBackend, isKnownOllamaModel,
  getTierBackend, setTierBackend, getOllamaContextWindow,
  getRoleBinding, setRoleBinding, resolveRoleBackend,
} from '../src/appSettings.js';
import { familyOf, canonicalizeModel, isKnownClaudeModel, PROVIDERS, DEFAULT_TIER_BACKEND, DEFAULT_ROLE_BINDING } from '../src/modelVersions.js';
import { isOllamaSession, getOllamaSession, markOllamaSession, unmarkOllamaSession, loadAll } from '../src/sessionBackends.js';
import { checkOllamaReachable, checkModelAvailable, OLLAMA_BASE } from '../src/ollamaBackend.js';

// ── modelVersions: Claude-only familyOf + no-regression ─────────────────────
test('familyOf is Claude-only; ollama tags return null (canonicalize no-op)', () => {
  assert.equal(familyOf('claude-opus-4-8'), 'opus');
  assert.equal(familyOf('gemma4:cloud'), null);
  assert.equal(canonicalizeModel('gemma4:cloud'), 'gemma4:cloud');   // tag passes through
  assert.equal(canonicalizeModel('claude-sonnet-5'), 'claude-sonnet-5[1m]');
  assert.equal(isKnownClaudeModel('claude-opus-4-8'), true);
  assert.equal(isKnownClaudeModel('gemma4:cloud'), false);
  assert.equal(PROVIDERS.map(p => p.kind).sort().join(','), 'claude,ollama');
  assert.equal(DEFAULT_TIER_BACKEND.powerful.kind, 'claude');
  assert.equal(typeof DEFAULT_TIER_BACKEND.powerful.model, 'string');
});

// ── ollamaBackend preflight (localhost only) ────────────────────────────────
test('ollama preflight targets localhost and fails cleanly when down', async () => {
  assert.equal(OLLAMA_BASE, 'http://localhost:11434');
  // checkOllamaReachable/checkModelAvailable take no host arg now.
  assert.equal(checkOllamaReachable.length, 0);
  assert.equal(checkModelAvailable.length, 1);
});

// checkModelAvailable's cloud-leniency only kicks in once Ollama itself is
// reachable (its /api/tags call has to succeed first) — there's no live
// Ollama in CI, so this stubs global fetch to simulate a reachable daemon
// whose /api/tags does NOT list the tag, to isolate the leniency branch.
test('checkModelAvailable treats bare :cloud AND size-pinned *-cloud tags as leniently available', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: [{ name: 'llama3' }] }) });
  try {
    const bareCloud = await checkModelAvailable('deepseek-v4-flash:cloud');
    assert.deepEqual(bareCloud, { ok: true, available: true, models: ['llama3'] });

    const sizePinnedCloud = await checkModelAvailable('mistral-large-3:675b-cloud');
    assert.deepEqual(sizePinnedCloud, { ok: true, available: true, models: ['llama3'] });

    // A genuinely local, non-cloud tag absent from /api/tags is NOT leniently available.
    const localMissing = await checkModelAvailable('llama3:not-pulled');
    assert.equal(localMissing.available, false);

    // A tag that merely contains "cloud" mid-string (not as the last `:`-segment
    // suffix) must not be misclassified as hosted.
    const substringOnly = await checkModelAvailable('cloudy-local-model:latest');
    assert.equal(substringOnly.available, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── appSettings custom models + tier bindings + sidecar (fresh store) ───────
describe('backend-agnostic data model', () => {
  let home;
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => { await rmrf(home); });

  test('custom models: add / list / remove keyed by tag, no id/host', async () => {
    assert.deepEqual(getCustomBackends(), []);
    const rec = await addCustomBackend({ label: 'Local GPT', model: 'gemma4:cloud' });
    assert.deepEqual(rec, { label: 'Local GPT', model: 'gemma4:cloud' });
    assert.equal(getCustomBackends().length, 1);
    assert.equal(isKnownOllamaModel('gemma4:cloud'), true);
    assert.equal(isKnownOllamaModel('nope:tag'), false);
    // Re-adding the same tag updates the label (tag is the identity).
    await addCustomBackend({ label: 'Renamed', model: 'gemma4:cloud' });
    assert.equal(getCustomBackends().length, 1);
    assert.equal(getCustomBackends()[0].label, 'Renamed');
    assert.equal(await removeCustomBackend('gemma4:cloud'), true);
    assert.equal(await removeCustomBackend('gemma4:cloud'), false);
  });

  test('addCustomBackend rejects missing label/model', async () => {
    await assert.rejects(() => addCustomBackend({ label: '', model: 'x' }), /required/);
    await assert.rejects(() => addCustomBackend({ label: 'L', model: '' }), /required/);
  });

  test('custom models: optional contextWindow persists (rounded) or is omitted when blank/invalid', async () => {
    // Blank → entry is exactly {label, model}, no contextWindow key.
    const bare = await addCustomBackend({ label: 'Bare', model: 'bare:cloud' });
    assert.deepEqual(bare, { label: 'Bare', model: 'bare:cloud' });
    assert.equal('contextWindow' in getCustomBackends().find(b => b.model === 'bare:cloud'), false);

    // Valid positive → stored, rounded to an integer.
    const big = await addCustomBackend({ label: 'Big', model: 'big:cloud', contextWindow: 512000.7 });
    assert.deepEqual(big, { label: 'Big', model: 'big:cloud', contextWindow: 512001 });
    assert.equal(getCustomBackends().find(b => b.model === 'big:cloud').contextWindow, 512001);

    // Invalid/non-positive → omitted (defensive; the route also 400s these).
    const zero = await addCustomBackend({ label: 'Zero', model: 'zero:cloud', contextWindow: 0 });
    assert.equal('contextWindow' in zero, false);
    const nan = await addCustomBackend({ label: 'Nan', model: 'nan:cloud', contextWindow: 'abc' });
    assert.equal('contextWindow' in nan, false);
  });

  test('getOllamaContextWindow: custom entry wins over curated preset; unknown → null', async () => {
    // Curated preset resolves with no prior add.
    assert.equal(getOllamaContextWindow('deepseek-v4-flash:cloud'), 1_000_000);
    assert.equal(getOllamaContextWindow('qwen3.5:cloud'), 256_000);
    // A custom entry with its own window wins even when it shadows nothing.
    await addCustomBackend({ label: 'Local', model: 'local:cloud', contextWindow: 128_000 });
    assert.equal(getOllamaContextWindow('local:cloud'), 128_000);
    // A custom override of a preset tag takes precedence over the catalog value.
    await addCustomBackend({ label: 'Override', model: 'qwen3.5:cloud', contextWindow: 300_000 });
    assert.equal(getOllamaContextWindow('qwen3.5:cloud'), 300_000);
    // Custom with no window and unknown tag → null.
    await addCustomBackend({ label: 'NoWin', model: 'nowin:cloud' });
    assert.equal(getOllamaContextWindow('nowin:cloud'), null);
    assert.equal(getOllamaContextWindow('ghost:tag'), null);
    assert.equal(getOllamaContextWindow(''), null);
  });

  test('tier binding: {kind,model}, no silent revert, dead binding falls back', async () => {
    // Claude binding to a concrete version — returned verbatim.
    await setTierBackend('powerful', { kind: 'claude', model: 'claude-opus-4-7' });
    assert.deepEqual(getTierBackend('powerful'), { kind: 'claude', model: 'claude-opus-4-7' });

    // Ollama binding to a known tag — verbatim (the no-silent-revert case).
    await addCustomBackend({ label: 'Local', model: 'gemma4:cloud' });
    await setTierBackend('fast', { kind: 'ollama', model: 'gemma4:cloud' });
    assert.deepEqual(getTierBackend('fast'), { kind: 'ollama', model: 'gemma4:cloud' });

    // Removing the tag makes the binding dead → falls back to the tier default.
    await removeCustomBackend('gemma4:cloud');
    assert.deepEqual(getTierBackend('fast'), DEFAULT_TIER_BACKEND.fast);
  });

  test('setTierBackend rejects invalid bindings', async () => {
    await assert.rejects(() => setTierBackend('fast', { kind: 'claude', model: 'not-a-version' }), /known backend/);
    await assert.rejects(() => setTierBackend('fast', { kind: 'ollama', model: 'unadded:tag' }), /known backend/);
    await assert.rejects(() => setTierBackend('bogus', { kind: 'claude', model: 'claude-opus-4-8' }), /known backend/);
  });

  test('role binding: default is a tier binding; tier vs custom, no silent revert', async () => {
    // Out of the box, conductor binds to the powerful tier.
    assert.deepEqual(getRoleBinding('conductor'), DEFAULT_ROLE_BINDING.conductor);
    assert.equal(DEFAULT_ROLE_BINDING.conductor.kind, 'tier');

    // Tier binding reads back verbatim.
    await setRoleBinding('conductor', { kind: 'tier', tier: 'fast' });
    assert.deepEqual(getRoleBinding('conductor'), { kind: 'tier', tier: 'fast' });

    // Custom claude binding reads back verbatim.
    await setRoleBinding('reviewer', { kind: 'claude', model: 'claude-opus-4-7' });
    assert.deepEqual(getRoleBinding('reviewer'), { kind: 'claude', model: 'claude-opus-4-7' });

    // Custom ollama binding reads back verbatim; removing the tag reverts to default.
    await addCustomBackend({ label: 'Local', model: 'gemma4:cloud' });
    await setRoleBinding('reviewer', { kind: 'ollama', model: 'gemma4:cloud' });
    assert.deepEqual(getRoleBinding('reviewer'), { kind: 'ollama', model: 'gemma4:cloud' });
    await removeCustomBackend('gemma4:cloud');
    assert.deepEqual(getRoleBinding('reviewer'), DEFAULT_ROLE_BINDING.reviewer);
  });

  test('resolveRoleBackend: tier binding follows the tier (incl. dead-custom revert)', async () => {
    // A custom claude role binding resolves to itself.
    await setRoleBinding('reviewer', { kind: 'claude', model: 'claude-opus-4-7' });
    assert.deepEqual(resolveRoleBackend('reviewer'), { kind: 'claude', model: 'claude-opus-4-7' });

    // A tier binding follows whatever the tier currently points at.
    await setTierBackend('powerful', { kind: 'claude', model: 'claude-opus-4-7' });
    await setRoleBinding('conductor', { kind: 'tier', tier: 'powerful' });
    assert.deepEqual(resolveRoleBackend('conductor'), { kind: 'claude', model: 'claude-opus-4-7' });

    // role → tier → dead custom binding: the tier layer reverts, and the role
    // resolver reflects that (delegation intact).
    await addCustomBackend({ label: 'Local', model: 'gemma4:cloud' });
    await setTierBackend('powerful', { kind: 'ollama', model: 'gemma4:cloud' });
    assert.deepEqual(resolveRoleBackend('conductor'), { kind: 'ollama', model: 'gemma4:cloud' });
    await removeCustomBackend('gemma4:cloud');
    assert.deepEqual(resolveRoleBackend('conductor'), DEFAULT_TIER_BACKEND.powerful);
  });

  test('setRoleBinding rejects invalid bindings', async () => {
    await assert.rejects(() => setRoleBinding('conductor', { kind: 'tier', tier: 'bogus' }), /known/);
    await assert.rejects(() => setRoleBinding('conductor', { kind: 'claude', model: 'not-a-version' }), /known/);
    await assert.rejects(() => setRoleBinding('conductor', { kind: 'ollama', model: 'bogus-not-a-tag' }), /known/);
    await assert.rejects(() => setRoleBinding('conductor', { kind: 'tier' }), /known/); // missing tier
    await assert.rejects(() => setRoleBinding('conductor', null), /known/);
    await assert.rejects(() => setRoleBinding('conductor', undefined), /known/);
    await assert.rejects(() => setRoleBinding('bogus', { kind: 'tier', tier: 'fast' }), /known/);
  });

  test('ollama-session sidecar is a Map sid→model: mark / get / upsert / unmark / empty-cleanup', async () => {
    assert.equal(await isOllamaSession('sid-1'), false);
    assert.deepEqual(await getOllamaSession('sid-1'), { ollama: false, model: null });

    await markOllamaSession('sid-1', 'gemma4:cloud');
    assert.equal(await isOllamaSession('sid-1'), true);
    assert.deepEqual(await getOllamaSession('sid-1'), { ollama: true, model: 'gemma4:cloud' });

    await markOllamaSession('sid-1', 'gemma4:cloud'); // idempotent
    assert.equal((await loadAll()).size, 1);

    // Re-mark with a different tag upserts (self-heal path).
    await markOllamaSession('sid-1', 'deepseek-v4-flash:cloud');
    assert.deepEqual(await getOllamaSession('sid-1'), { ollama: true, model: 'deepseek-v4-flash:cloud' });

    // A mark with no model stores null (ollama-backed, tag-unknown).
    await markOllamaSession('sid-2');
    assert.deepEqual(await getOllamaSession('sid-2'), { ollama: true, model: null });

    assert.equal(await unmarkOllamaSession('sid-1'), true);
    assert.equal(await unmarkOllamaSession('sid-2'), true);
    assert.equal(await isOllamaSession('sid-1'), false);
    assert.equal((await loadAll()).size, 0);
  });
});

// ── HTTP routes ─────────────────────────────────────────────────────────────
describe('models settings routes', () => {
  let ctx, baseUrl, home;
  before(async () => { ctx = await bootServer(); baseUrl = ctx.baseUrl; });
  after(async () => { await ctx.close(); });
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => { await ctx.instances.shutdown(); await rmrf(home); });

  test('GET ships providers, {kind,model} tierBackend, and customBackends', async () => {
    await addCustomBackend({ label: 'Local', model: 'gemma4:cloud' });
    const r = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(r.status, 200);
    assert.equal(r.body.providers.length, 2);
    assert.equal(r.body.tierBackend.powerful.kind, 'claude');
    assert.deepEqual(r.body.customBackends, [{ label: 'Local', model: 'gemma4:cloud' }]);
    assert.equal(r.body.activeVersions, undefined); // removed
  });

  test('prefs route binds a tier to {kind,model} and rejects invalid', async () => {
    await addCustomBackend({ label: 'Local', model: 'gemma4:cloud' });
    const ok = await api(baseUrl, 'POST', '/api/settings/models/prefs', { tierBackend: { tier: 'balanced', backend: { kind: 'ollama', model: 'gemma4:cloud' } } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.tierBackend.balanced, { kind: 'ollama', model: 'gemma4:cloud' });
    const bad = await api(baseUrl, 'POST', '/api/settings/models/prefs', { tierBackend: { tier: 'balanced', backend: { kind: 'ollama', model: 'ghost:tag' } } });
    assert.equal(bad.status, 400);
  });

  test('GET ships roles + roleBackend; prefs binds a role and rejects invalid', async () => {
    const g = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(g.status, 200);
    assert.ok(g.body.roles.some(r => r.role === 'conductor'));
    assert.equal(g.body.roleBackend.conductor.kind, 'tier'); // default tier binding

    // Bind conductor to a custom Claude backend.
    const ok = await api(baseUrl, 'POST', '/api/settings/models/prefs', { roleBackend: { role: 'conductor', backend: { kind: 'claude', model: 'claude-opus-4-7' } } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.roleBackend.conductor, { kind: 'claude', model: 'claude-opus-4-7' });

    // Bind reviewer to a tier.
    const okTier = await api(baseUrl, 'POST', '/api/settings/models/prefs', { roleBackend: { role: 'reviewer', backend: { kind: 'tier', tier: 'fast' } } });
    assert.equal(okTier.status, 200);
    assert.deepEqual(okTier.body.roleBackend.reviewer, { kind: 'tier', tier: 'fast' });

    // Unknown role → 400; bad tier binding → 400.
    const badRole = await api(baseUrl, 'POST', '/api/settings/models/prefs', { roleBackend: { role: 'ghost', backend: { kind: 'tier', tier: 'fast' } } });
    assert.equal(badRole.status, 400);
    const badTier = await api(baseUrl, 'POST', '/api/settings/models/prefs', { roleBackend: { role: 'conductor', backend: { kind: 'tier', tier: 'ghost' } } });
    assert.equal(badTier.status, 400);
    // Malformed custom backend → 400 (missing model, and a null backend).
    const badModel = await api(baseUrl, 'POST', '/api/settings/models/prefs', { roleBackend: { role: 'conductor', backend: { kind: 'claude' } } });
    assert.equal(badModel.status, 400);
    const nullBackend = await api(baseUrl, 'POST', '/api/settings/models/prefs', { roleBackend: { role: 'conductor', backend: null } });
    assert.equal(nullBackend.status, 400);
  });

  test('the removed POST /settings/models version route is gone (404)', async () => {
    const r = await api(baseUrl, 'POST', '/api/settings/models', { backend: 'opus', version: 'claude-opus-4-8' });
    assert.equal(r.status, 404);
  });

  test('POST /settings/models/custom (no host) fails preflight when Ollama is down', async () => {
    // No Ollama in CI → preflight fails deterministically; nothing persisted.
    const r = await api(baseUrl, 'POST', '/api/settings/models/custom', { label: 'Bad', model: 'x:y' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not reachable|not found/);
    assert.equal(getCustomBackends().length, 0);
  });

  test('POST /settings/models/custom rejects a non-positive contextWindow before preflight', async () => {
    // contextWindow validation runs before the Ollama preflight, so this 400s
    // deterministically with no live daemon.
    const zero = await api(baseUrl, 'POST', '/api/settings/models/custom', { label: 'Z', model: 'z:cloud', contextWindow: 0 });
    assert.equal(zero.status, 400);
    assert.match(zero.body.error, /contextWindow/);
    const neg = await api(baseUrl, 'POST', '/api/settings/models/custom', { label: 'N', model: 'n:cloud', contextWindow: -5 });
    assert.equal(neg.status, 400);
    const nan = await api(baseUrl, 'POST', '/api/settings/models/custom', { label: 'X', model: 'x:cloud', contextWindow: 'huge' });
    assert.equal(nan.status, 400);
    assert.equal(getCustomBackends().length, 0);
  });

  test('DELETE /settings/models/custom/:tag removes by tag (404 when absent)', async () => {
    await addCustomBackend({ label: 'Local', model: 'gemma4:cloud' });
    const del = await api(baseUrl, 'DELETE', `/api/settings/models/custom/${encodeURIComponent('gemma4:cloud')}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.customBackends.length, 0);
    const del2 = await api(baseUrl, 'DELETE', `/api/settings/models/custom/${encodeURIComponent('ghost:tag')}`);
    assert.equal(del2.status, 404);
  });
});
