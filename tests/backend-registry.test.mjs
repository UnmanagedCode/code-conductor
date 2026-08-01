// The data-driven backend REGISTRY: managed vs user rows, template substitution,
// env injection, custom models (backend + required contextWindow), tier/role
// bindings on the {backend, model} shape (validation gates + no-silent-revert),
// the Claude-only familyOf (canonicalize no-op for non-Claude ids), the
// {backend,model}-shaped session sidecar, and the Settings routes.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  addCustomModel, getCustomModels, removeCustomModel, isKnownBackendModel,
  getTierBackend, setTierBackend, contextWindowForModel, backendForModel,
  getRoleBinding, setRoleBinding, resolveRoleBackend, setPluginRolesProvider,
  getBackends, getBackend, isKnownBackend, getSubstitutionBackends,
  addBackend, updateBackend, removeBackend,
} from '../src/appSettings.js';
import {
  familyOf, canonicalizeModel, isKnownClaudeModel, MANAGED_BACKENDS,
  MANAGED_BACKEND_IDS, CLAUDE_BACKEND_ID, DEFAULT_TIER_BACKEND, DEFAULT_ROLE_BINDING,
} from '../src/modelVersions.js';
import { resolveBackendLaunch, backendEnv } from '../src/claudeLauncher.js';
import {
  hasSessionBackend, getSessionBackend, markSessionBackend, unmarkSessionBackend, loadAll,
} from '../src/sessionBackends.js';

const CLAUDE_BIN = { command: '/usr/bin/claude', prefixArgs: [] };

// ── modelVersions: Claude-only familyOf + no-regression ─────────────────────
test('familyOf is Claude-only; non-Claude ids return null (canonicalize no-op)', () => {
  assert.equal(familyOf('claude-opus-4-8'), 'opus');
  assert.equal(familyOf('gemma4:cloud'), null);
  assert.equal(canonicalizeModel('gemma4:cloud'), 'gemma4:cloud');   // id passes through
  assert.equal(canonicalizeModel('claude-sonnet-5'), 'claude-sonnet-5[1m]');
  assert.equal(isKnownClaudeModel('claude-opus-4-8'), true);
  assert.equal(isKnownClaudeModel('gemma4:cloud'), false);
  assert.deepEqual(MANAGED_BACKEND_IDS.slice().sort(), ['claude', 'ollama']);
  assert.equal(DEFAULT_TIER_BACKEND.powerful.backend, CLAUDE_BACKEND_ID);
  assert.equal(typeof DEFAULT_TIER_BACKEND.powerful.model, 'string');
  // The identity row has no template; the ollama row carries the substitution.
  assert.equal(MANAGED_BACKENDS.find(b => b.id === 'claude').template, '');
  assert.equal(MANAGED_BACKENDS.find(b => b.id === 'ollama').template,
    'ollama launch claude --model {model} --yes --');
});

// ── resolveBackendLaunch: THE substitution point ────────────────────────────
describe('resolveBackendLaunch (template-driven launch resolution)', () => {
  test('a blank template runs the resolved claude binary unchanged', () => {
    const claudeBin = { command: '/usr/bin/claude', prefixArgs: ['--extra'] };
    const r = resolveBackendLaunch({ id: 'claude', template: '' }, 'claude-opus-4-7', claudeBin);
    assert.equal(r.command, '/usr/bin/claude');
    assert.deepEqual(r.prefixArgs, ['--extra']);
    // An absent template behaves identically (defensive: a hand-edited store).
    const r2 = resolveBackendLaunch({ id: 'claude' }, 'claude-opus-4-7', claudeBin);
    assert.equal(r2.command, '/usr/bin/claude');
    assert.deepEqual(r2.prefixArgs, ['--extra']);
  });

  test('a template becomes command + prefixArgs with {model} substituted', () => {
    const r = resolveBackendLaunch(
      { id: 'ollama', template: 'ollama launch claude --model {model} --yes --' },
      'deepseek-v4-flash:cloud', CLAUDE_BIN,
    );
    assert.equal(r.command, 'ollama');
    assert.deepEqual(r.prefixArgs, ['launch', 'claude', '--model', 'deepseek-v4-flash:cloud', '--yes', '--']);
  });

  test('{model} substitutes INSIDE a token, so --model={model} works too', () => {
    const r = resolveBackendLaunch(
      { id: 'p', template: 'wrap --model={model} --' }, 'glm-5.2:cloud', CLAUDE_BIN,
    );
    assert.equal(r.command, 'wrap');
    assert.deepEqual(r.prefixArgs, ['--model=glm-5.2:cloud', '--']);
  });

  // A template need not interpolate `{model}` — a pass-through wrapper forwards the
  // claude args (including `--model`) untouched. It still REQUIRES a model, though:
  // see the next test.
  test('a template with NO {model} tokenizes normally', () => {
    const r = resolveBackendLaunch({ id: 'p', template: 'wrap exec claude --' }, 'mine:v1', CLAUDE_BIN);
    assert.equal(r.command, 'wrap');
    assert.deepEqual(r.prefixArgs, ['exec', 'claude', '--']);
  });

  // UNCONDITIONAL on the template shape, mirroring _doCreate's create-time guard.
  // The model isn't only a template placeholder: it rides in the forwarded claude
  // args and drives the context-window env, so a model-less substitution launch is
  // never legal — including for a template that omits `{model}`.
  test('a substitution launch refuses without a model, whatever the template shape', () => {
    assert.throws(
      () => resolveBackendLaunch({ id: 'ollama', template: 'ollama launch claude --model {model} --' }, null, CLAUDE_BIN),
      /requires a model/,
    );
    assert.throws(
      () => resolveBackendLaunch({ id: 'p', template: 'wrap exec claude --' }, null, CLAUDE_BIN),
      /requires a model/,
    );
    // The identity backend is exempt — a bare `claude` with no model is the
    // account-default spawn.
    assert.doesNotThrow(() => resolveBackendLaunch({ id: 'claude', template: '' }, null, CLAUDE_BIN));
  });

  test('the backend\'s env rides along on every resolution', () => {
    const backend = { id: 'p', template: 'wrap --', env: [{ key: 'OLLAMA_HOST', value: 'http://x:1' }, { key: 'A', value: '' }] };
    assert.deepEqual(resolveBackendLaunch(backend, 'm', CLAUDE_BIN).env, { OLLAMA_HOST: 'http://x:1', A: '' });
    // Also on the identity path, and {} when there is no env at all.
    assert.deepEqual(resolveBackendLaunch({ id: 'claude', template: '' }, 'm', CLAUDE_BIN).env, {});
    assert.deepEqual(backendEnv(undefined), {});
    assert.deepEqual(backendEnv({ env: [{ key: '', value: 'x' }] }), {}); // blank key dropped
  });

  // {model} substitutes into env VALUES (never keys) at the single substitution
  // point, so a custom backend can put `{model}` in an env var and have it filled
  // at spawn. Keys are never templated. Only applies when a model is resolved.
  test('{model} substitutes into env VALUES (not keys) for substitution backends', () => {
    const backend = {
      id: 'p', template: 'wrap --',
      env: [
        { key: 'SOME_MODEL_ID', value: '{model}' },
        { key: 'KEEP', value: 'x-{model}-y' },
        { key: 'NO_SUBST', value: 'plain' },
        { key: '{model}', value: 'no' }, // key is NOT templated
      ],
    };
    assert.deepEqual(resolveBackendLaunch(backend, 'glm-5.2:cloud', CLAUDE_BIN).env, {
      '{model}': 'no',
      SOME_MODEL_ID: 'glm-5.2:cloud',
      KEEP: 'x-glm-5.2:cloud-y',
      NO_SUBST: 'plain',
    });
    // backendEnv takes the optional model directly; no model ⇒ no substitution.
    assert.deepEqual(backendEnv(backend, 'glm-5.2:cloud'), {
      '{model}': 'no',
      SOME_MODEL_ID: 'glm-5.2:cloud',
      KEEP: 'x-glm-5.2:cloud-y',
      NO_SUBST: 'plain',
    });
    assert.deepEqual(backendEnv(backend), {
      '{model}': 'no',
      SOME_MODEL_ID: '{model}',
      KEEP: 'x-{model}-y',
      NO_SUBST: 'plain',
    });
  });

  // The identity path (blank template) resolves with NO model — env rides along
  // unsubstituted. The only blank-template backend is the managed `claude` row
  // (empty env), so this is defensive; it pins the no-model no-substitution rule.
  test('a blank template leaves env unsubstituted when no model is given', () => {
    const backend = { id: 'x', template: '', env: [{ key: 'M', value: '{model}' }] };
    assert.deepEqual(resolveBackendLaunch(backend, null, CLAUDE_BIN).env, { M: '{model}' });
    // With a model, the blank-template path still substitutes (single point).
    assert.deepEqual(resolveBackendLaunch(backend, 'glm-5.2:cloud', CLAUDE_BIN).env, { M: 'glm-5.2:cloud' });
  });
});

// ── registry + custom models + bindings + sidecar (fresh store) ─────────────
describe('backend registry data model', () => {
  let home;
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => { await rmrf(home); });

  test('a fresh store already has both managed rows, code-authoritative', () => {
    const rows = getBackends();
    assert.deepEqual(rows.map(b => b.id), ['claude', 'ollama']);
    assert.ok(rows.every(b => b.managed === true));
    assert.equal(getBackend('ollama').template, 'ollama launch claude --model {model} --yes --');
    assert.equal(getBackend('claude').template, '');
    assert.equal(getBackend('ghost'), null);
    assert.equal(isKnownBackend('ollama'), true);
    assert.equal(isKnownBackend('ghost'), false);
    // The identity row never serves custom models, so it isn't offered for them.
    assert.deepEqual(getSubstitutionBackends().map(b => b.id), ['ollama']);
  });

  test('addBackend: validates the id, then the row shows up in the registry', async () => {
    const rec = await addBackend({ id: 'my-proxy', label: 'My Proxy', template: 'proxy run claude --model {model} --' });
    assert.deepEqual(rec, { id: 'my-proxy', label: 'My Proxy', template: 'proxy run claude --model {model} --', env: [], managed: false });
    assert.deepEqual(getBackends().map(b => b.id), ['claude', 'ollama', 'my-proxy']);
    assert.deepEqual(getSubstitutionBackends().map(b => b.id), ['ollama', 'my-proxy']);

    await assert.rejects(() => addBackend({ id: 'Bad Id', label: 'x' }), /id must match/);
    await assert.rejects(() => addBackend({ id: '9lives', label: 'x' }), /id must match/);
    await assert.rejects(() => addBackend({ id: 'a'.repeat(41), label: 'x' }), /id must match/);
    await assert.rejects(() => addBackend({ id: 'ok', label: '' }), /label is required/);
    await assert.rejects(() => addBackend({ id: 'my-proxy', label: 'Dup' }), /already exists/);
    // A managed id can't be shadowed.
    await assert.rejects(() => addBackend({ id: 'ollama', label: 'Mine' }), /already exists/);
    await assert.rejects(() => addBackend({ id: 'claude', label: 'Mine' }), /already exists/);
  });

  // A user row with no template would run the Claude CLI itself while being
  // treated as a separate provider everywhere: unmonitored usage-window domain (no
  // overage protection), no `cost_usd` (⇒ `—` in #costs while real money burns),
  // and a forced CLAUDE_CODE_MAX_CONTEXT_TOKENS on a genuine Claude session. The
  // managed `claude` row already provides identity behaviour, so it's refused.
  test('addBackend/updateBackend REFUSE a blank template on a USER row', async () => {
    await assert.rejects(() => addBackend({ id: 'plain', label: 'Plain' }), /template is required/);
    await assert.rejects(() => addBackend({ id: 'plain', label: 'Plain', template: '   ' }), /template is required/);
    assert.equal(isKnownBackend('plain'), false, 'nothing persisted');

    await addBackend({ id: 'real', label: 'Real', template: 'realctl claude --model {model} --' });
    await assert.rejects(() => updateBackend('real', { template: '' }), /template is required/);
    assert.equal(getBackend('real').template, 'realctl claude --model {model} --', 'unchanged');
  });

  test('the MANAGED claude row keeps its blank template — identity comes from code', async () => {
    assert.equal(getBackend('claude').template, '');
    assert.equal(resolveBackendLaunch(getBackend('claude'), 'm', CLAUDE_BIN).command, CLAUDE_BIN.command);
    // Env is read-only on a managed row (code-authoritative, empty) — editing it is
    // rejected, and the row never falls through to the user-row template requirement.
    await assert.rejects(() => updateBackend('claude', { env: [{ key: 'ANTHROPIC_LOG', value: 'debug' }] }), /built in/);
    assert.equal(getBackend('claude').template, '');
    assert.deepEqual(getBackend('claude').env, []);
  });

  test('env pairs persist and reject a malformed key', async () => {
    await addBackend({ id: 'p', label: 'P', template: 'p --', env: [{ key: 'FOO', value: 'bar' }] });
    assert.deepEqual(getBackend('p').env, [{ key: 'FOO', value: 'bar' }]);
    await assert.rejects(() => addBackend({ id: 'q', label: 'Q', template: 'q {model}', env: [{ key: 'not-a-key', value: 'x' }] }), /env key/);
    await assert.rejects(() => addBackend({ id: 'q', label: 'Q', template: 'q {model}', env: [{ key: '1BAD', value: 'x' }] }), /env key/);
  });

  test('managed rows: label/template/env immutable, never removable', async () => {
    await assert.rejects(() => updateBackend('ollama', { label: 'Mine' }), /built in/);
    await assert.rejects(() => updateBackend('ollama', { template: 'evil {model}' }), /built in/);
    await assert.rejects(() => updateBackend('ollama', { env: [{ key: 'OLLAMA_HOST', value: 'http://box:11434' }] }), /built in/);
    await assert.rejects(() => updateBackend('claude', { env: [{ key: 'X', value: '1' }] }), /built in/);
    await assert.rejects(() => removeBackend('ollama'), /cannot be removed/);
    await assert.rejects(() => removeBackend('claude'), /cannot be removed/);

    // Managed env is code-authoritative (empty) — never read from the store.
    assert.deepEqual(getBackend('ollama').env, []);
    assert.deepEqual(getBackend('claude').env, []);
    // A no-op PATCH (no fields) returns the read-only row unchanged.
    const noop = await updateBackend('ollama', {});
    assert.equal(noop && noop.id, 'ollama');
    // And the registry still lists both managed rows exactly once.
    assert.deepEqual(getBackends().map(b => b.id), ['claude', 'ollama']);
  });

  // Managed env is code-authoritative: a stored {id, env} override for a managed
  // row is dead data — getBackends() ignores it (env comes from MANAGED_BACKENDS,
  // i.e. empty). Migration 0024 strips such entries; this pins the read side.
  test('managed env is code-authoritative — stored managed env overrides are ignored', async () => {
    const settingsFile = path.join(process.env.PROJECTS_ROOT, '.code-conductor', 'settings.json');
    await fs.mkdir(path.dirname(settingsFile), { recursive: true });
    await fs.writeFile(settingsFile, JSON.stringify({
      models: {
        backends: [
          { id: 'ollama', env: [{ key: 'OLLAMA_HOST', value: 'http://seeded:11434' }] },
          { id: 'claude', env: [{ key: 'X', value: '1' }] },
          { id: 'my-proxy', label: 'My Proxy', template: 'proxy {model} --', env: [] },
        ],
      },
    }, null, 2) + '\n');

    // Managed rows: env is empty from code, NOT the seeded store override.
    assert.deepEqual(getBackend('ollama').env, []);
    assert.deepEqual(getBackend('claude').env, []);
    assert.equal(resolveBackendLaunch(getBackend('ollama'), 'glm-5.2:cloud', CLAUDE_BIN).env.OLLAMA_HOST, undefined);
    // A user row alongside is still read from the store.
    assert.equal(isKnownBackend('my-proxy'), true);
    assert.equal(getBackend('my-proxy').template, 'proxy {model} --');
  });

  test('updateBackend edits a user row; 404-equivalent null for an unknown id', async () => {
    await addBackend({ id: 'p', label: 'P', template: 'p {model} --' });
    const rec = await updateBackend('p', { label: 'P2', template: 'p2 {model} --', env: [{ key: 'K', value: 'v' }] });
    assert.deepEqual(rec, { id: 'p', label: 'P2', template: 'p2 {model} --', env: [{ key: 'K', value: 'v' }], managed: false });
    assert.equal(await updateBackend('ghost', { label: 'x' }), null);
  });

  test('removeBackend REFUSES (409) while custom models still reference it — never cascades', async () => {
    await addBackend({ id: 'p', label: 'P', template: 'p --model {model} --' });
    await addCustomModel({ label: 'One', model: 'one:v1', backend: 'p', contextWindow: 100_000 });
    await addCustomModel({ label: 'Two', model: 'two:v1', backend: 'p', contextWindow: 100_000 });

    await assert.rejects(
      () => removeBackend('p'),
      (e) => {
        assert.equal(e.statusCode, 409);
        assert.match(e.message, /one:v1/);
        assert.match(e.message, /two:v1/);
        return true;
      },
    );
    // Nothing was deleted: the backend AND both models are still there.
    assert.ok(isKnownBackend('p'));
    assert.equal(getCustomModels().length, 2);

    // Remove the models first, then the backend goes.
    assert.equal(await removeCustomModel('one:v1'), true);
    await assert.rejects(() => removeBackend('p'), /two:v1/); // still one left
    assert.equal(await removeCustomModel('two:v1'), true);
    assert.equal(await removeBackend('p'), true);
    assert.equal(isKnownBackend('p'), false);
    assert.equal(await removeBackend('p'), false); // already gone
  });

  test('a tier bound to a removed backend\'s model reverts through the dead-binding path', async () => {
    await addBackend({ id: 'p', label: 'P', template: 'p --model {model} --' });
    await addCustomModel({ label: 'One', model: 'one:v1', backend: 'p', contextWindow: 100_000 });
    await setTierBackend('fast', { backend: 'p', model: 'one:v1' });
    assert.deepEqual(getTierBackend('fast'), { backend: 'p', model: 'one:v1' });

    // Legitimate order: drop the model, then the backend. The tier reverts.
    await removeCustomModel('one:v1');
    assert.deepEqual(getTierBackend('fast'), DEFAULT_TIER_BACKEND.fast);
    assert.equal(await removeBackend('p'), true);
    assert.deepEqual(getTierBackend('fast'), DEFAULT_TIER_BACKEND.fast);
  });

  test('custom models: add / list / remove keyed by model id, scoped to a backend', async () => {
    assert.deepEqual(getCustomModels(), []);
    const rec = await addCustomModel({ label: 'Local GPT', model: 'gemma4:cloud', backend: 'ollama', contextWindow: 128_000 });
    assert.deepEqual(rec, { label: 'Local GPT', model: 'gemma4:cloud', backend: 'ollama', contextWindow: 128_000 });
    assert.equal(getCustomModels().length, 1);
    assert.equal(isKnownBackendModel('ollama', 'gemma4:cloud'), true);
    assert.equal(isKnownBackendModel('ollama', 'nope:tag'), false);
    // Backend-SCOPED: the same id on a different backend isn't bindable there.
    assert.equal(isKnownBackendModel('claude', 'gemma4:cloud'), false);
    await addBackend({ id: 'p', label: 'P', template: 'p --' });
    assert.equal(isKnownBackendModel('p', 'gemma4:cloud'), false);
    // Re-adding the same model id updates the row (the id is the identity).
    await addCustomModel({ label: 'Renamed', model: 'gemma4:cloud', backend: 'ollama', contextWindow: 64_000 });
    assert.equal(getCustomModels().length, 1);
    assert.equal(getCustomModels()[0].label, 'Renamed');
    assert.equal(await removeCustomModel('gemma4:cloud'), true);
    assert.equal(await removeCustomModel('gemma4:cloud'), false);
  });

  test('addCustomModel: label/model/backend required, backend must be a substitution row', async () => {
    await assert.rejects(() => addCustomModel({ label: '', model: 'x', backend: 'ollama', contextWindow: 1 }), /required/);
    await assert.rejects(() => addCustomModel({ label: 'L', model: '', backend: 'ollama', contextWindow: 1 }), /required/);
    await assert.rejects(() => addCustomModel({ label: 'L', model: 'x', contextWindow: 1 }), /required/);
    // The identity backend is never a custom-model host.
    await assert.rejects(() => addCustomModel({ label: 'L', model: 'x', backend: 'claude', contextWindow: 1 }), /not a known custom-model backend/);
    await assert.rejects(() => addCustomModel({ label: 'L', model: 'x', backend: 'ghost', contextWindow: 1 }), /not a known custom-model backend/);
  });

  test('custom models: contextWindow is REQUIRED and must be positive (stored rounded)', async () => {
    await assert.rejects(() => addCustomModel({ label: 'B', model: 'b:cloud', backend: 'ollama' }), /contextWindow is required/);
    await assert.rejects(() => addCustomModel({ label: 'Z', model: 'z:cloud', backend: 'ollama', contextWindow: 0 }), /contextWindow is required/);
    await assert.rejects(() => addCustomModel({ label: 'N', model: 'n:cloud', backend: 'ollama', contextWindow: -5 }), /contextWindow is required/);
    await assert.rejects(() => addCustomModel({ label: 'X', model: 'x:cloud', backend: 'ollama', contextWindow: 'abc' }), /contextWindow is required/);
    assert.deepEqual(getCustomModels(), []);

    const big = await addCustomModel({ label: 'Big', model: 'big:cloud', backend: 'ollama', contextWindow: 512000.7 });
    assert.equal(big.contextWindow, 512001);
    assert.equal(getCustomModels().find(m => m.model === 'big:cloud').contextWindow, 512001);
  });

  test('contextWindowForModel: custom row wins over curated preset; unknown → null', async () => {
    // Curated preset resolves with no prior add (scoped to the `ollama` row).
    assert.equal(contextWindowForModel('deepseek-v4-flash:cloud'), 1_000_000);
    assert.equal(contextWindowForModel('qwen3.5:cloud'), 256_000);
    await addCustomModel({ label: 'Local', model: 'local:cloud', backend: 'ollama', contextWindow: 128_000 });
    assert.equal(contextWindowForModel('local:cloud'), 128_000);
    // A custom override of a preset id takes precedence over the catalog value.
    await addCustomModel({ label: 'Override', model: 'qwen3.5:cloud', backend: 'ollama', contextWindow: 300_000 });
    assert.equal(contextWindowForModel('qwen3.5:cloud'), 300_000);
    // Unknown → null (this is the "leave both env vars unset" spawn path).
    assert.equal(contextWindowForModel('ghost:tag'), null);
    assert.equal(contextWindowForModel(''), null);
  });

  test('backendForModel resolves a bare model id to the backend serving it', async () => {
    // Curated presets belong to the built-in ollama row.
    assert.equal(backendForModel('deepseek-v4-flash:cloud'), 'ollama');
    await addBackend({ id: 'p', label: 'P', template: 'p --model {model} --' });
    await addCustomModel({ label: 'Mine', model: 'mine:v1', backend: 'p', contextWindow: 100_000 });
    assert.equal(backendForModel('mine:v1'), 'p');
    assert.equal(backendForModel('ghost:v9'), null);
    assert.equal(backendForModel(''), null);
  });

  test('tier binding: {backend,model}, no silent revert, dead binding falls back', async () => {
    await setTierBackend('powerful', { backend: 'claude', model: 'claude-opus-4-7' });
    assert.deepEqual(getTierBackend('powerful'), { backend: 'claude', model: 'claude-opus-4-7' });

    // A binding to a known custom model — verbatim (the no-silent-revert case).
    await addCustomModel({ label: 'Local', model: 'gemma4:cloud', backend: 'ollama', contextWindow: 128_000 });
    await setTierBackend('fast', { backend: 'ollama', model: 'gemma4:cloud' });
    assert.deepEqual(getTierBackend('fast'), { backend: 'ollama', model: 'gemma4:cloud' });

    // Removing the model makes the binding dead → falls back to the tier default.
    await removeCustomModel('gemma4:cloud');
    assert.deepEqual(getTierBackend('fast'), DEFAULT_TIER_BACKEND.fast);
  });

  test('setTierBackend rejects invalid bindings', async () => {
    await assert.rejects(() => setTierBackend('fast', { backend: 'claude', model: 'not-a-version' }), /known backend/);
    await assert.rejects(() => setTierBackend('fast', { backend: 'ollama', model: 'unadded:tag' }), /known backend/);
    await assert.rejects(() => setTierBackend('fast', { backend: 'ghost', model: 'x' }), /known backend/);
    await assert.rejects(() => setTierBackend('bogus', { backend: 'claude', model: 'claude-opus-4-8' }), /known backend/);
  });

  test('role binding: default is a tier binding; tier vs concrete, no silent revert', async () => {
    assert.deepEqual(getRoleBinding('conductor'), DEFAULT_ROLE_BINDING.conductor);
    assert.equal(DEFAULT_ROLE_BINDING.conductor.kind, 'tier');

    // A tier REFERENCE still uses `kind:'tier'` — it names no backend.
    await setRoleBinding('conductor', { kind: 'tier', tier: 'fast' });
    assert.deepEqual(getRoleBinding('conductor'), { kind: 'tier', tier: 'fast' });

    await setRoleBinding('reviewer', { backend: 'claude', model: 'claude-opus-4-7' });
    assert.deepEqual(getRoleBinding('reviewer'), { backend: 'claude', model: 'claude-opus-4-7' });

    await addCustomModel({ label: 'Local', model: 'gemma4:cloud', backend: 'ollama', contextWindow: 128_000 });
    await setRoleBinding('reviewer', { backend: 'ollama', model: 'gemma4:cloud' });
    assert.deepEqual(getRoleBinding('reviewer'), { backend: 'ollama', model: 'gemma4:cloud' });
    await removeCustomModel('gemma4:cloud');
    assert.deepEqual(getRoleBinding('reviewer'), DEFAULT_ROLE_BINDING.reviewer);
  });

  test('resolveRoleBackend: tier binding follows the tier (incl. dead-custom revert)', async () => {
    await setRoleBinding('reviewer', { backend: 'claude', model: 'claude-opus-4-7' });
    assert.deepEqual(resolveRoleBackend('reviewer'), { backend: 'claude', model: 'claude-opus-4-7' });

    await setTierBackend('powerful', { backend: 'claude', model: 'claude-opus-4-7' });
    await setRoleBinding('conductor', { kind: 'tier', tier: 'powerful' });
    assert.deepEqual(resolveRoleBackend('conductor'), { backend: 'claude', model: 'claude-opus-4-7' });

    // role → tier → dead binding: the tier layer reverts, and the role resolver
    // reflects that (delegation intact).
    await addCustomModel({ label: 'Local', model: 'gemma4:cloud', backend: 'ollama', contextWindow: 128_000 });
    await setTierBackend('powerful', { backend: 'ollama', model: 'gemma4:cloud' });
    assert.deepEqual(resolveRoleBackend('conductor'), { backend: 'ollama', model: 'gemma4:cloud' });
    await removeCustomModel('gemma4:cloud');
    assert.deepEqual(resolveRoleBackend('conductor'), DEFAULT_TIER_BACKEND.powerful);
  });

  test('setRoleBinding rejects invalid bindings', async () => {
    await assert.rejects(() => setRoleBinding('conductor', { kind: 'tier', tier: 'bogus' }), /known/);
    await assert.rejects(() => setRoleBinding('conductor', { backend: 'claude', model: 'not-a-version' }), /known/);
    await assert.rejects(() => setRoleBinding('conductor', { backend: 'ollama', model: 'bogus-not-a-tag' }), /known/);
    await assert.rejects(() => setRoleBinding('conductor', { kind: 'tier' }), /known/); // missing tier
    await assert.rejects(() => setRoleBinding('conductor', null), /known/);
    await assert.rejects(() => setRoleBinding('conductor', undefined), /known/);
    await assert.rejects(() => setRoleBinding('bogus', { kind: 'tier', tier: 'fast' }), /known/);
  });

  test('session sidecar is a Map sid→{backend,model}: mark / get / upsert / unmark / cleanup', async () => {
    assert.equal(await hasSessionBackend('sid-1'), false);
    assert.equal(await getSessionBackend('sid-1'), null);

    await markSessionBackend('sid-1', 'ollama', 'gemma4:cloud');
    assert.equal(await hasSessionBackend('sid-1'), true);
    assert.deepEqual(await getSessionBackend('sid-1'), { backend: 'ollama', model: 'gemma4:cloud' });

    await markSessionBackend('sid-1', 'ollama', 'gemma4:cloud'); // idempotent
    assert.equal((await loadAll()).size, 1);

    // Re-mark with a different model upserts (the self-heal path).
    await markSessionBackend('sid-1', 'ollama', 'deepseek-v4-flash:cloud');
    assert.deepEqual(await getSessionBackend('sid-1'), { backend: 'ollama', model: 'deepseek-v4-flash:cloud' });

    // A mark with no model stores null (backend known, model unknown).
    await markSessionBackend('sid-2', 'ollama');
    assert.deepEqual(await getSessionBackend('sid-2'), { backend: 'ollama', model: null });
    // …and re-marking it WITH a model self-heals the legacy entry.
    await markSessionBackend('sid-2', 'ollama', 'qwen3.5:cloud');
    assert.deepEqual(await getSessionBackend('sid-2'), { backend: 'ollama', model: 'qwen3.5:cloud' });

    // A user-defined backend id round-trips just the same.
    await markSessionBackend('sid-3', 'my-proxy', 'mine:v1');
    assert.deepEqual(await getSessionBackend('sid-3'), { backend: 'my-proxy', model: 'mine:v1' });

    // A mark with no backend is refused (absence must mean "plain claude").
    assert.equal(await markSessionBackend('sid-4', null, 'x'), false);
    assert.equal(await hasSessionBackend('sid-4'), false);

    assert.equal(await unmarkSessionBackend('sid-1'), true);
    assert.equal(await unmarkSessionBackend('sid-2'), true);
    assert.equal(await unmarkSessionBackend('sid-3'), true);
    assert.equal(await hasSessionBackend('sid-1'), false);
    assert.equal((await loadAll()).size, 0);
  });
});

// ── HTTP routes ─────────────────────────────────────────────────────────────
describe('models + backends settings routes', () => {
  let ctx, baseUrl, home;
  before(async () => { ctx = await bootServer(); baseUrl = ctx.baseUrl; });
  after(async () => { await ctx.close(); });
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => { await ctx.instances.shutdown(); await rmrf(home); });

  test('GET ships the registry, claudeFamilies, {backend,model} tierBackend, customModels', async () => {
    await addCustomModel({ label: 'Local', model: 'gemma4:cloud', backend: 'ollama', contextWindow: 128_000 });
    const r = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.backends.map(b => b.id), ['claude', 'ollama']);
    assert.ok(r.body.claudeFamilies.some(f => f.family === 'sonnet'));
    assert.equal(r.body.tierBackend.powerful.backend, 'claude');
    assert.deepEqual(r.body.customModels, [{ label: 'Local', model: 'gemma4:cloud', backend: 'ollama', contextWindow: 128_000 }]);
    // Renamed away — the old key names must be gone, not aliased.
    assert.equal(r.body.providers, undefined);
    assert.equal(r.body.customBackends, undefined);
    assert.equal(r.body.activeVersions, undefined);
  });

  test('backend CRUD routes: add, patch, and the 409/400/404 delete contract', async () => {
    const add = await api(baseUrl, 'POST', '/api/settings/models/backends',
      { id: 'my-proxy', label: 'My Proxy', template: 'proxy run claude --model {model} --', env: [{ key: 'TOKEN', value: 't' }] });
    assert.equal(add.status, 201, JSON.stringify(add.body));
    assert.deepEqual(add.body.added, { id: 'my-proxy', label: 'My Proxy', template: 'proxy run claude --model {model} --', env: [{ key: 'TOKEN', value: 't' }], managed: false });
    assert.deepEqual(add.body.backends.map(b => b.id), ['claude', 'ollama', 'my-proxy']);

    const dup = await api(baseUrl, 'POST', '/api/settings/models/backends', { id: 'my-proxy', label: 'X', template: 'x {model}' });
    assert.equal(dup.status, 409);
    const badId = await api(baseUrl, 'POST', '/api/settings/models/backends', { id: 'Nope!', label: 'X', template: 'x {model}' });
    assert.equal(badId.status, 400);
    const noTemplate = await api(baseUrl, 'POST', '/api/settings/models/backends', { id: 'plain', label: 'Plain' });
    assert.equal(noTemplate.status, 400);
    assert.match(noTemplate.body.error, /template is required/);

    const patch = await api(baseUrl, 'PATCH', '/api/settings/models/backends/my-proxy', { label: 'Renamed' });
    assert.equal(patch.status, 200);
    assert.equal(patch.body.updated.label, 'Renamed');
    // A managed row rejects label/template AND env edits (read-only); a no-op
    // PATCH (no fields) returns 200 with the unchanged row.
    const patchManaged = await api(baseUrl, 'PATCH', '/api/settings/models/backends/ollama', { template: 'evil {model}' });
    assert.equal(patchManaged.status, 400);
    const patchEnv = await api(baseUrl, 'PATCH', '/api/settings/models/backends/ollama', { env: [{ key: 'OLLAMA_HOST', value: 'http://box:11434' }] });
    assert.equal(patchEnv.status, 400);
    assert.match(patchEnv.body.error, /built in/);
    const patchNoop = await api(baseUrl, 'PATCH', '/api/settings/models/backends/ollama', {});
    assert.equal(patchNoop.status, 200);
    assert.deepEqual(patchNoop.body.updated.env, []);
    const patchGhost = await api(baseUrl, 'PATCH', '/api/settings/models/backends/ghost', { label: 'x' });
    assert.equal(patchGhost.status, 404);

    // 409 while a custom model still references it, naming the model.
    await addCustomModel({ label: 'Mine', model: 'mine:v1', backend: 'my-proxy', contextWindow: 100_000 });
    const refused = await api(baseUrl, 'DELETE', '/api/settings/models/backends/my-proxy');
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /mine:v1/);
    assert.ok(isKnownBackend('my-proxy'), 'nothing deleted on refusal');
    assert.equal(getCustomModels().length, 1, 'the model row survives the refusal');

    // 400 for a managed row, 404 for an unknown id, 200 once unreferenced.
    const managed = await api(baseUrl, 'DELETE', '/api/settings/models/backends/claude');
    assert.equal(managed.status, 400);
    const ghost = await api(baseUrl, 'DELETE', '/api/settings/models/backends/ghost');
    assert.equal(ghost.status, 404);
    await api(baseUrl, 'DELETE', `/api/settings/models/custom/${encodeURIComponent('mine:v1')}`);
    const gone = await api(baseUrl, 'DELETE', '/api/settings/models/backends/my-proxy');
    assert.equal(gone.status, 200);
    assert.deepEqual(gone.body.backends.map(b => b.id), ['claude', 'ollama']);
  });

  test('prefs route binds a tier to {backend,model} and rejects invalid', async () => {
    await addCustomModel({ label: 'Local', model: 'gemma4:cloud', backend: 'ollama', contextWindow: 128_000 });
    const ok = await api(baseUrl, 'POST', '/api/settings/models/prefs', { tierBackend: { tier: 'balanced', backend: { backend: 'ollama', model: 'gemma4:cloud' } } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.tierBackend.balanced, { backend: 'ollama', model: 'gemma4:cloud' });
    const bad = await api(baseUrl, 'POST', '/api/settings/models/prefs', { tierBackend: { tier: 'balanced', backend: { backend: 'ollama', model: 'ghost:tag' } } });
    assert.equal(bad.status, 400);
  });

  test('GET ships roles + roleBackend; prefs binds a role and rejects invalid', async () => {
    const g = await api(baseUrl, 'GET', '/api/settings/models');
    assert.equal(g.status, 200);
    assert.ok(g.body.roles.some(r => r.role === 'conductor'));
    assert.equal(g.body.roleBackend.conductor.kind, 'tier'); // default tier binding

    const ok = await api(baseUrl, 'POST', '/api/settings/models/prefs', { roleBackend: { role: 'conductor', backend: { backend: 'claude', model: 'claude-opus-4-7' } } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.roleBackend.conductor, { backend: 'claude', model: 'claude-opus-4-7' });

    const okTier = await api(baseUrl, 'POST', '/api/settings/models/prefs', { roleBackend: { role: 'reviewer', backend: { kind: 'tier', tier: 'fast' } } });
    assert.equal(okTier.status, 200);
    assert.deepEqual(okTier.body.roleBackend.reviewer, { kind: 'tier', tier: 'fast' });

    const badRole = await api(baseUrl, 'POST', '/api/settings/models/prefs', { roleBackend: { role: 'ghost', backend: { kind: 'tier', tier: 'fast' } } });
    assert.equal(badRole.status, 400);
    const badTier = await api(baseUrl, 'POST', '/api/settings/models/prefs', { roleBackend: { role: 'conductor', backend: { kind: 'tier', tier: 'ghost' } } });
    assert.equal(badTier.status, 400);
    const badModel = await api(baseUrl, 'POST', '/api/settings/models/prefs', { roleBackend: { role: 'conductor', backend: { backend: 'claude' } } });
    assert.equal(badModel.status, 400);
    const nullBackend = await api(baseUrl, 'POST', '/api/settings/models/prefs', { roleBackend: { role: 'conductor', backend: null } });
    assert.equal(nullBackend.status, 400);
  });

  test('the removed POST /settings/models version route is gone (404)', async () => {
    const r = await api(baseUrl, 'POST', '/api/settings/models', { backend: 'opus', version: 'claude-opus-4-8' });
    assert.equal(r.status, 404);
  });

  test('plugin role: /prefs stores an override (beats manifest); GET reflects the effective binding', async () => {
    setPluginRolesProvider(() => [{ role: 'p/cap', label: 'Cap', binding: { kind: 'tier', tier: 'fast' }, plugin: 'p' }]);
    try {
      const g0 = await api(baseUrl, 'GET', '/api/settings/models');
      const r0 = g0.body.roles.find(r => r.role === 'p/cap');
      assert.ok(r0 && r0.plugin === 'p', 'plugin role present in list');
      assert.deepEqual(g0.body.roleBackend['p/cap'], { kind: 'tier', tier: 'fast' }); // manifest

      const ok = await api(baseUrl, 'POST', '/api/settings/models/prefs', { roleBackend: { role: 'p/cap', backend: { kind: 'tier', tier: 'powerful' } } });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.deepEqual(ok.body.roleBackend['p/cap'], { kind: 'tier', tier: 'powerful' });
      assert.deepEqual(resolveRoleBackend('p/cap'), getTierBackend('powerful')); // override beats manifest

      // A non-Claude override round-trips too: other backends are user-local so a
      // MANIFEST may not name one, but a user override may.
      const custom = await api(baseUrl, 'POST', '/api/settings/models/prefs', { roleBackend: { role: 'p/cap', backend: { backend: 'ollama', model: 'deepseek-v4-flash:cloud' } } });
      assert.equal(custom.status, 200, JSON.stringify(custom.body));
      assert.deepEqual(custom.body.roleBackend['p/cap'], { backend: 'ollama', model: 'deepseek-v4-flash:cloud' });
      assert.deepEqual(resolveRoleBackend('p/cap'), { backend: 'ollama', model: 'deepseek-v4-flash:cloud' });

      // Reverting is done by re-selecting the manifest tier in the picker.
      const revert = await api(baseUrl, 'POST', '/api/settings/models/prefs', { roleBackend: { role: 'p/cap', backend: { kind: 'tier', tier: 'fast' } } });
      assert.equal(revert.status, 200);
      assert.deepEqual(revert.body.roleBackend['p/cap'], { kind: 'tier', tier: 'fast' });
      assert.deepEqual(resolveRoleBackend('p/cap'), getTierBackend('fast'));
    } finally {
      setPluginRolesProvider(null);
    }
  });

  test('POST /settings/models/custom requires backend + positive contextWindow (no preflight)', async () => {
    const noBackend = await api(baseUrl, 'POST', '/api/settings/models/custom', { label: 'B', model: 'b:cloud', contextWindow: 1000 });
    assert.equal(noBackend.status, 400);
    assert.match(noBackend.body.error, /required/);

    const noCtx = await api(baseUrl, 'POST', '/api/settings/models/custom', { label: 'B', model: 'b:cloud', backend: 'ollama' });
    assert.equal(noCtx.status, 400);
    assert.match(noCtx.body.error, /contextWindow/);
    const zero = await api(baseUrl, 'POST', '/api/settings/models/custom', { label: 'Z', model: 'z:cloud', backend: 'ollama', contextWindow: 0 });
    assert.equal(zero.status, 400);
    const nan = await api(baseUrl, 'POST', '/api/settings/models/custom', { label: 'X', model: 'x:cloud', backend: 'ollama', contextWindow: 'huge' });
    assert.equal(nan.status, 400);
    assert.equal(getCustomModels().length, 0);

    // No reachability preflight any more: a model on an unreachable backend adds
    // fine and only fails at spawn.
    const ok = await api(baseUrl, 'POST', '/api/settings/models/custom', { label: 'Fine', model: 'fine:cloud', backend: 'ollama', contextWindow: 256_000 });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.added, { label: 'Fine', model: 'fine:cloud', backend: 'ollama', contextWindow: 256_000 });
  });

  test('DELETE /settings/models/custom/:model removes by model id (404 when absent)', async () => {
    await addCustomModel({ label: 'Local', model: 'gemma4:cloud', backend: 'ollama', contextWindow: 128_000 });
    const del = await api(baseUrl, 'DELETE', `/api/settings/models/custom/${encodeURIComponent('gemma4:cloud')}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.customModels.length, 0);
    const del2 = await api(baseUrl, 'DELETE', `/api/settings/models/custom/${encodeURIComponent('ghost:tag')}`);
    assert.equal(del2.status, 404);
  });
});
