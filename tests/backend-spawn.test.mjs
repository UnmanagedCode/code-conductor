// Spawn on a SUBSTITUTION backend: the uniform `{TEMPLATE} {CLAUDE_ARGS}` builder
// (the backend's template + the SAME claude args, so `--model <id>` appears twice
// — confirmed harmless), the backend's env injection, the session record's
// {backend,model} written at spawn + the tagged model recovered on resume (over the CLI's
// bare jsonl report), the setModel live-switch gate, tier/role→{backend,model} MCP
// resolution, the launch_failed crash signal, the null-model guards, and the bare
// MCP resume restoring the recorded backend (the one surface that alone dropped it).
//
// Every case runs on the built-in `ollama` row AND — where the generalization is
// what's under test — on a USER-DEFINED backend, since a rule keyed on the id
// 'ollama' rather than "not the identity backend" would pass the former and fail
// the latter.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf, settledSessionBackend, settle } from './helpers.mjs';
import { addCustomModel, setTierBackend, setRoleBinding, addCustomRole, addBackend,
  setPluginRolesProvider, getTierBackend, getDefaultSpawnTier, setDefaultSpawnTier, setTierEffort,
  removeBackend, removeCustomModel, isKnownBackend } from '../src/appSettings.ts';
import { getSessionBackend, setSessionBackend, sessionsFile } from '../src/sessionStore.ts';
import { claudeProjectsRoot, encodeCwd } from '../src/projects.ts';
import { OLLAMA_CLOUD_MODELS } from '../src/ollamaCloudModels.ts';
import { ControllableLauncher } from './controllableLauncher.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, home, projectsRoot;

before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

// Spawn on a substitution backend directly (model + backend), capturing the
// launch argv/env the (fake) CLI received.
async function spawnOnBackend({ model = 'gemma4:cloud', backend = 'ollama' } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'backend-spawn-'));
  const argvDump = path.join(tmp, 'argv.txt');
  const envDump = path.join(tmp, 'env.txt');
  process.env.FAKE_CLAUDE_ARGV_DUMP = argvDump;
  process.env.FAKE_CLAUDE_ENV_DUMP = envDump;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', model, backend });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.id;
    await waitFor(() => instances.get(id)?.status === 'idle');
    await waitFor(async () => { try { await fs.stat(argvDump); return true; } catch { return false; } });
    const argv = (await fs.readFile(argvDump, 'utf8')).split('\n').filter(Boolean);
    const envLines = (await fs.readFile(envDump, 'utf8')).split('\n').filter(Boolean);
    const env = Object.fromEntries(envLines.map(l => { const i = l.indexOf('='); return i < 0 ? [l, ''] : [l.slice(0, i), l.slice(i + 1)]; }));
    return { id, inst: instances.get(id), argv, env, summary: r.body };
  } finally {
    delete process.env.FAKE_CLAUDE_ARGV_DUMP;
    delete process.env.FAKE_CLAUDE_ENV_DUMP;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

describe('substitution-backend spawn command/args', () => {
  test('the template becomes the launch prefix + uniform forwarded --model', async () => {
    const { inst, argv, env, summary } = await spawnOnBackend({ model: 'gemma4:cloud' });

    assert.equal(inst._spawnArgv[0], 'ollama');
    assert.deepEqual(argv.slice(0, 6), ['launch', 'claude', '--model', 'gemma4:cloud', '--yes', '--']);
    assert.equal(argv[6], '-p');

    // --model appears TWICE (launch slot + forwarded claude arg), both the tag.
    const modelIdxs = argv.map((a, i) => a === '--model' ? i : -1).filter(i => i >= 0);
    assert.equal(modelIdxs.length, 2);
    for (const i of modelIdxs) assert.equal(argv[i + 1], 'gemma4:cloud');

    assert.ok(argv.includes('--session-id'));
    assert.ok(argv.includes('--output-format=stream-json'));
    assert.equal(env.OLLAMA_HOST, undefined); // no host plumbing

    assert.equal(summary.backend, 'ollama');
    assert.equal(summary.model, 'gemma4:cloud'); // model holds the id for every backend
    assert.equal(summary.backendKind, undefined); // renamed away, not aliased
  });

  test('the backend id + tagged model is written to the session record at spawn', async () => {
    const { inst } = await spawnOnBackend({ model: 'gemma4:cloud' });
    const rec = await settledSessionBackend(inst.sessionId);
    const doc = JSON.parse(await fs.readFile(sessionsFile(), 'utf8'));
    assert.deepEqual(doc.sessions[inst.sessionId]?.backend, rec, 'the backend sits on the public-id record');
    // `gemma4:cloud` is neither a curated preset nor a custom-model row here, so
    // its capacity is genuinely unknown — recorded as null, never a 200k guess.
    assert.deepEqual(rec, { backend: 'ollama', model: 'gemma4:cloud', contextWindowTokens: null });
  });

  // The generalization under test: a USER-DEFINED row drives the launch from its
  // own template, gets its own env injected, and records its own id on the session.
  test('a user-defined backend launches from its template, injects its env, and marks its own id', async () => {
    await addBackend({
      id: 'my-proxy', label: 'My Proxy',
      template: 'proxyctl exec claude --model {model} --',
      env: [{ key: 'PROXY_TOKEN', value: 'sekret' }],
    });
    await addCustomModel({ label: 'Mine', model: 'mine:v2', backend: 'my-proxy', contextWindow: 300_000 });

    const { inst, argv, env, summary } = await spawnOnBackend({ model: 'mine:v2', backend: 'my-proxy' });
    assert.equal(inst._spawnArgv[0], 'proxyctl');
    assert.deepEqual(argv.slice(0, 5), ['exec', 'claude', '--model', 'mine:v2', '--']);
    assert.equal(summary.backend, 'my-proxy');
    // The row's env pair reaches the child…
    assert.equal(env.PROXY_TOKEN, 'sekret');
    // …and the cc-MANAGED context vars apply here too (never only to `ollama`).
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '300000');
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '300000');
    assert.equal(summary.contextWindowTokens, 300_000);
    assert.deepEqual(await settledSessionBackend(inst.sessionId),
      { backend: 'my-proxy', model: 'mine:v2', contextWindowTokens: 300_000 });
  });

  // The `--model undefined` regression this whole guard family exists to prevent:
  // nothing previously asserted a FRESH spawn's argv, only the resume path. A
  // substitution spawn must always carry a real model in BOTH slots and never the
  // string "undefined".
  test('a fresh substitution spawn never emits `--model undefined` in either slot', async () => {
    const { argv } = await spawnOnBackend({ model: 'gemma4:cloud' });
    const modelIdxs = argv.map((a, i) => a === '--model' ? i : -1).filter(i => i >= 0);
    assert.equal(modelIdxs.length, 2, 'template slot + forwarded claude arg');
    for (const i of modelIdxs) assert.equal(argv[i + 1], 'gemma4:cloud');
    assert.ok(!argv.includes('undefined'), `no literal "undefined" in argv: ${argv.join(' ')}`);
    assert.ok(!argv.some(a => a.includes('{model}')), 'the placeholder is always substituted');
  });

  // There is NO legal model-less spawn on any backend, identity included: a bare
  // `claude` would run on whatever the ACCOUNT resolves as its default, which is
  // not cc's to choose. A fresh REST spawn naming neither model nor backend
  // resolves the Settings default tier's binding, so `--model` is always present
  // and carries that tier's model — never absent, never `undefined`.
  test('a fresh claude spawn with no model emits --model from the default spawn tier', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'backend-spawn-nomodel-'));
    const argvDump = path.join(tmp, 'argv.txt');
    process.env.FAKE_CLAUDE_ARGV_DUMP = argvDump;
    try {
      // Rebind the default tier to a model distinguishable from every other
      // tier's default, so a passing assertion can't be a coincidence.
      await setDefaultSpawnTier('fast');
      await setTierBackend('fast', { backend: 'claude', model: 'claude-haiku-4-5' });
      await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
      const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      await waitFor(() => instances.get(r.body.id)?.status === 'idle');
      await waitFor(async () => { try { await fs.stat(argvDump); return true; } catch { return false; } });
      const argv = (await fs.readFile(argvDump, 'utf8')).split('\n').filter(Boolean);
      const i = argv.indexOf('--model');
      assert.ok(i >= 0, `--model must be present: ${argv.join(' ')}`);
      assert.equal(argv[i + 1], 'claude-haiku-4-5');
      assert.equal(r.body.model, 'claude-haiku-4-5');
      assert.equal(r.body.backend, 'claude');
      assert.ok(!argv.includes('undefined'));
    } finally {
      delete process.env.FAKE_CLAUDE_ARGV_DUMP;
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });

  // `model: ""` is the same request as omitting it — _doCreate trims it to null,
  // so a gate testing `== null` would let it through to a bare `claude` on the
  // ACCOUNT default. The rule admits no exceptions, so the REST gate tests the
  // TRIMMED value, matching resolveSpawnModel's falsy check on the MCP side.
  test('a fresh claude spawn with an EMPTY-STRING model still emits --model from the default tier', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'backend-spawn-emptymodel-'));
    const argvDump = path.join(tmp, 'argv.txt');
    process.env.FAKE_CLAUDE_ARGV_DUMP = argvDump;
    try {
      await setDefaultSpawnTier('fast');
      await setTierBackend('fast', { backend: 'claude', model: 'claude-haiku-4-5' });
      await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
      for (const model of ['', '   ']) {
        const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', model });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        await waitFor(() => instances.get(r.body.id)?.status === 'idle');
        await waitFor(async () => { try { await fs.stat(argvDump); return true; } catch { return false; } });
        const argv = (await fs.readFile(argvDump, 'utf8')).split('\n').filter(Boolean);
        const i = argv.indexOf('--model');
        assert.ok(i >= 0, `model:${JSON.stringify(model)} must still emit --model: ${argv.join(' ')}`);
        assert.equal(argv[i + 1], 'claude-haiku-4-5');
        assert.equal(r.body.model, 'claude-haiku-4-5');
      }
    } finally {
      delete process.env.FAKE_CLAUDE_ARGV_DUMP;
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });

  // Naming `backend:'claude'` with no model used to be the ONE fresh-spawn shape that
  // reached the CLI's account default: the no-backend gate deliberately leaves a caller
  // who named a backend alone, and _doCreate's BACKEND_MODEL_MISSING guard is
  // `backend !== claude`, so there was nothing to refuse. The row now supplies the model.
  test('a fresh spawn naming backend:claude with no model fills the model from the row', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'backend-spawn-claudeonly-'));
    const argvDump = path.join(tmp, 'argv.txt');
    process.env.FAKE_CLAUDE_ARGV_DUMP = argvDump;
    try {
      await setDefaultSpawnTier('fast');
      await setTierBackend('fast', { backend: 'claude', model: 'claude-haiku-4-5' });
      await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
      const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', backend: 'claude' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      await waitFor(() => instances.get(r.body.id)?.status === 'idle');
      await waitFor(async () => { try { await fs.stat(argvDump); return true; } catch { return false; } });
      const argv = (await fs.readFile(argvDump, 'utf8')).split('\n').filter(Boolean);
      const i = argv.indexOf('--model');
      assert.ok(i >= 0, `--model must be present: ${argv.join(' ')}`);
      assert.equal(argv[i + 1], 'claude-haiku-4-5');
      assert.equal(r.body.model, 'claude-haiku-4-5');
      assert.equal(r.body.backend, 'claude');
    } finally {
      delete process.env.FAKE_CLAUDE_ARGV_DUMP;
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });

  // The row is picked by the SAME precedence the no-backend gate uses, so a named
  // tier decides here too — not the default tier.
  test('backend:claude with no model resolves the NAMED tier, not the default tier', async () => {
    await setDefaultSpawnTier('powerful');
    await setTierBackend('powerful', { backend: 'claude', model: 'claude-opus-4-8' });
    await setTierBackend('fast', { backend: 'claude', model: 'claude-haiku-4-5' });
    await setTierEffort('powerful', 'max');
    await setTierEffort('fast', 'low');
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(baseUrl, 'POST', '/api/instances', {
      project: 'p', mode: 'bypassPermissions', backend: 'claude', tier: 'fast',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.model, 'claude-haiku-4-5', "the named tier's binding supplies the model");
    assert.equal(r.body.effort, 'low', '…and the SAME row supplies the effort');
  });

  // Mismatch: the row this spawn resolves to is on a substitution backend, so there is
  // no claude model to fill. Refused with the code every other backend already gives
  // for a model-less spawn, rather than launching bare on the account default.
  test('backend:claude with no model refuses BACKEND_MODEL_MISSING when the row is on another backend', async () => {
    await addCustomModel({ label: 'G', model: 'gemma4:cloud', backend: 'ollama', contextWindow: 200_000 });
    await setDefaultSpawnTier('fast');
    await setTierBackend('fast', { backend: 'ollama', model: 'gemma4:cloud' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', backend: 'claude' });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    // Provenance: this must be the ROUTE's refusal, naming the row's backend, not
    // _doCreate's (`session on backend '…' has no resolvable model`) — whose guard is
    // `backend !== claude` and so cannot fire here at all. A test satisfied by that
    // other message would be vacuous.
    assert.match(r.body.error, /the row this spawn resolves to is bound to backend 'ollama'/);
    assert.equal(instances.list().length, 0, 'refused before any instance was created');
  });

  // Regression guards for the two cases option (a) deliberately did NOT touch.
  test('a substitution backend named with no model still refuses BACKEND_MODEL_MISSING', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', backend: 'ollama' });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    // _doCreate's wording, not the route's — proof the fall-through is intact and the
    // route did not start filling models for a backend that refuses today.
    assert.match(r.body.error, /session on backend 'ollama' has no resolvable model/);
  });

  test('an unregistered backend named with no model still refuses BACKEND_GONE', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', backend: 'ghost' });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.match(r.body.error, /unknown backend 'ghost'/);
  });

  test('a cc-managed context var beats a same-named backend env pair', async () => {
    await addBackend({
      id: 'shadow', label: 'Shadow', template: 'shadowctl claude --model {model} --',
      env: [{ key: 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', value: '999' }],
    });
    await addCustomModel({ label: 'S', model: 's:v1', backend: 'shadow', contextWindow: 128_000 });
    const { env } = await spawnOnBackend({ model: 's:v1', backend: 'shadow' });
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '128000', 'cc-managed value wins over the user env pair');
  });

  test('cc\'s CC_PROJECTS_ROOT beats a same-named backend env pair', async () => {
    await addBackend({
      id: 'shadow-root', label: 'Shadow root', template: 'shadowctl claude --model {model} --',
      env: [{ key: 'CC_PROJECTS_ROOT', value: '/backend/planted' }],
    });
    await addCustomModel({ label: 'SR', model: 'sr:v1', backend: 'shadow-root', contextWindow: 128_000 });
    const { env } = await spawnOnBackend({ model: 'sr:v1', backend: 'shadow-root' });
    assert.equal(env.CC_PROJECTS_ROOT, projectsRoot, 'cc-managed value wins over the user env pair');
  });
});

// The backend write in Instance.spawn() is fire-and-forget, so the 201 + idle can
// beat it by a handful of filesystem ops. Forced deterministically here by
// holding the store's own advisory lock across the spawn: storeLock.ts reclaims a
// held lock ONLY when the owner PID is dead, so while this test's live PID owns
// it, withLock inside setSessionBackend cannot enter and the write CANNOT have
// landed. That is a hard mutual-exclusion barrier, not a delay — no sleeps, no
// wall-clock thresholds, and the guarantee does not weaken under host load.
// Driven through a RESUME with an explicit backend + model: a fresh spawn awaits
// mintPublicId under the same lock before spawn(), so holding it would stall the
// launch itself rather than just the backend write.
describe('a session-backend write that lands after the spawn response', () => {
  test('is waited for, not sampled', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const cwd = path.join(projectsRoot, 'p');
    const sid = 'abababab-0000-0000-0000-000000000000';
    const dir = path.join(claudeProjectsRoot(), encodeCwd(cwd));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${sid}.jsonl`),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, sessionId: sid }) + '\n');
    const lockPath = sessionsFile() + '.lock';
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'held-by-test' }));
    let released = false;
    try {
      const inst = await instances.create({
        project: 'p', resume: sid, mode: 'bypassPermissions', backend: 'ollama', model: 'gemma4:cloud',
      });
      await waitFor(() => inst.status === 'idle');
      assert.equal(inst.sessionId, sid, 'premise: an unrotated session resumes under its own id');
      // THE FORCING ASSERTION. With the lock held the write cannot have landed, so
      // an un-waited read must miss. If this ever passes, the forcing silently
      // stopped working (store path/filename moved, or the write stopped being
      // lock-guarded) and everything below it would prove nothing.
      assert.equal(await getSessionBackend(sid), null,
        'forcing engaged: the session-backend write is blocked on the held lock');
      await fs.unlink(lockPath); released = true;
      // NEGATIVE CONTROL — to re-verify this test still bites, change
      // `settledSessionBackend(sid)` below to `getSessionBackend(sid)` and re-run
      // this file alone: it should fail with `AssertionError: null !== { … }` on
      // the overwhelming majority of runs. This is NOT fully deterministic like
      // the forcing assertion above: once the lock is unlinked, the pending
      // `setSessionBackend` write is still racing its own retry backoff timer
      // (storeLock.ts) against this immediate read, with nothing synchronizing
      // the two — on rare adverse scheduling the retry could win and the swap
      // would pass. A pass on this recipe means "re-run it", not "this test no
      // longer detects the bug" — the committed assertion below waits
      // deterministically and is unaffected either way.
      assert.deepEqual(await settledSessionBackend(sid),
        { backend: 'ollama', model: 'gemma4:cloud', contextWindowTokens: null });
    } finally {
      if (!released) await fs.unlink(lockPath).catch(() => {});
    }
  });
});

describe('tier → {backend,model} resolution (MCP spawn)', () => {
  let rpcId = 1;
  async function callTool(name, args) {
    const res = await fetch(baseUrl + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await res.json();
    return JSON.parse(body.result.content[0].text);
  }

  test('an ollama-bound tier resolves the MCP spawn to an ollama worker', async () => {
    await addCustomModel({ label: 'Local', model: 'gemma4:cloud', backend: 'ollama', contextWindow: 128_000 });
    await setTierBackend('powerful', { backend: 'ollama', model: 'gemma4:cloud' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawned = await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'powerful' });
    await waitFor(() => instances.idsForSession(spawned.sessionId).length > 0);
    const inst = instances.get(instances.idsForSession(spawned.sessionId)[0]);
    assert.equal(inst.backend, 'ollama');
    assert.equal(inst.model, 'gemma4:cloud');
  });

  test('a Claude-bound tier resolves to a bare-claude worker', async () => {
    await setTierBackend('fast', { backend: 'claude', model: 'claude-haiku-4-5' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawned = await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'fast' });
    await waitFor(() => instances.idsForSession(spawned.sessionId).length > 0);
    const inst = instances.get(instances.idsForSession(spawned.sessionId)[0]);
    assert.equal(inst.backend, 'claude');
    assert.equal(inst.model, 'claude-haiku-4-5');
  });
});

describe('role → {backend,model} resolution (MCP spawn)', () => {
  let rpcId = 1;
  async function callTool(name, args) {
    const res = await fetch(baseUrl + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await res.json();
    return JSON.parse(body.result.content[0].text);
  }

  test('a tier-bound role follows the tier (ollama)', async () => {
    await addCustomModel({ label: 'Local', model: 'gemma4:cloud', backend: 'ollama', contextWindow: 128_000 });
    await setTierBackend('powerful', { backend: 'ollama', model: 'gemma4:cloud' });
    await setRoleBinding('conductor', { kind: 'tier', tier: 'powerful' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawned = await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'conductor' });
    await waitFor(() => instances.idsForSession(spawned.sessionId).length > 0);
    const inst = instances.get(instances.idsForSession(spawned.sessionId)[0]);
    assert.equal(inst.backend, 'ollama');
    assert.equal(inst.model, 'gemma4:cloud');
  });

  // `planner` exists because relay's `plan` stage pins spawn_instance's `model`
  // to it. A role named in a pin but absent from ROLES resolves through no branch
  // of the ladder and refuses BAD_MODEL — the failure the pin-resolution test in
  // playbook-schema.test.mjs records as having shipped once.
  test('the planner role resolves — by default via its tier, and via an explicit binding', async () => {
    await addCustomModel({ label: 'Local', model: 'gemma4:cloud', backend: 'ollama', contextWindow: 128_000 });
    await setTierBackend('powerful', { backend: 'ollama', model: 'gemma4:cloud' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });

    // Untouched: DEFAULT_ROLE_BINDING.planner follows the powerful tier.
    let spawned = await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'planner' });
    await waitFor(() => instances.idsForSession(spawned.sessionId).length > 0);
    let inst = instances.get(instances.idsForSession(spawned.sessionId)[0]);
    assert.equal(inst.backend, 'ollama');
    assert.equal(inst.model, 'gemma4:cloud');

    await setRoleBinding('planner', { backend: 'claude', model: 'claude-haiku-4-5' });
    spawned = await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'planner' });
    await waitFor(() => instances.idsForSession(spawned.sessionId).length > 0);
    inst = instances.get(instances.idsForSession(spawned.sessionId)[0]);
    assert.equal(inst.backend, 'claude');
    assert.equal(inst.model, 'claude-haiku-4-5', 'a user rebinding of the role wins');
  });

  test('a custom Claude-bound role resolves to that claude model', async () => {
    await setRoleBinding('reviewer', { backend: 'claude', model: 'claude-haiku-4-5' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawned = await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'reviewer' });
    await waitFor(() => instances.idsForSession(spawned.sessionId).length > 0);
    const inst = instances.get(instances.idsForSession(spawned.sessionId)[0]);
    assert.equal(inst.backend, 'claude');
    assert.equal(inst.model, 'claude-haiku-4-5');
  });

  test('a role bound straight to a non-Claude model resolves to it (non-tier branch)', async () => {
    // Bind reviewer directly to a controlled model on the ollama row, exercising
    // resolveRoleBackend's non-tier branch without depending on a curated preset.
    const roleModel = 'cc-test-role-model:cloud';
    await addCustomModel({ label: 'Role target (test)', model: roleModel, backend: 'ollama', contextWindow: 256_000 });
    await setRoleBinding('reviewer', { backend: 'ollama', model: roleModel });
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawned = await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'reviewer' });
    await waitFor(() => instances.idsForSession(spawned.sessionId).length > 0);
    const inst = instances.get(instances.idsForSession(spawned.sessionId)[0]);
    assert.equal(inst.backend, 'ollama');
    assert.equal(inst.model, roleModel);
  });

  test('a user custom role resolves to its bound claude model', async () => {
    await addCustomRole({ role: 'tester', binding: { backend: 'claude', model: 'claude-haiku-4-5' } });
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawned = await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'tester' });
    await waitFor(() => instances.idsForSession(spawned.sessionId).length > 0);
    const inst = instances.get(instances.idsForSession(spawned.sessionId)[0]);
    assert.equal(inst.backend, 'claude');
    assert.equal(inst.model, 'claude-haiku-4-5');
  });

  test('a role name resolves case-insensitively at spawn', async () => {
    // Stored case-preserved as 'MyRole'; spawn requests it as 'MYROLE'.
    await addCustomRole({ role: 'MyRole', binding: { backend: 'claude', model: 'claude-haiku-4-5' } });
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawned = await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'MYROLE' });
    await waitFor(() => instances.idsForSession(spawned.sessionId).length > 0);
    const inst = instances.get(instances.idsForSession(spawned.sessionId)[0]);
    assert.equal(inst.backend, 'claude');
    assert.equal(inst.model, 'claude-haiku-4-5');
  });

  test('an unknown role/model is refused (BAD_MODEL), spawns nothing', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const res = await fetch(baseUrl + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/call', params: { name: 'spawn_instance', arguments: { project: 'p', mode: 'bypassPermissions', model: 'ghost-role' } } }),
    });
    const body = await res.json();
    assert.equal(body.result.isError, true, JSON.stringify(body));
    assert.match(body.result.content[0].text, /unknown model/);
  });

  // Plugin-owned roles are injected via the same provider server.ts wires to
  // pluginHost.roles(); overriding it here exercises the resolution path an
  // enabled plugin would drive, without standing up a real plugin.
  test('a plugin-owned role resolves to its manifest claude binding', async () => {
    setPluginRolesProvider(() => [{ role: 'myplug/scribe', label: 'Scribe', binding: { backend: 'claude', model: 'claude-haiku-4-5' }, plugin: 'myplug' }]);
    try {
      await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
      const spawned = await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'myplug/scribe' });
      await waitFor(() => instances.idsForSession(spawned.sessionId).length > 0);
      const inst = instances.get(instances.idsForSession(spawned.sessionId)[0]);
      assert.equal(inst.backend, 'claude');
      assert.equal(inst.model, 'claude-haiku-4-5');
    } finally { setPluginRolesProvider(null); }
  });

  test('a disabled plugin\'s role is not resolvable and is refused at spawn (BAD_MODEL)', async () => {
    // Provider returns [] — the plugin is disabled/removed, so its namespaced
    // role name resolves to nothing and spawn must refuse it.
    setPluginRolesProvider(() => []);
    try {
      await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
      const res = await fetch(baseUrl + '/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1001, method: 'tools/call', params: { name: 'spawn_instance', arguments: { project: 'p', mode: 'bypassPermissions', model: 'myplug/scribe' } } }),
      });
      const body = await res.json();
      assert.equal(body.result.isError, true, JSON.stringify(body));
      assert.match(body.result.content[0].text, /unknown model/);
    } finally { setPluginRolesProvider(null); }
  });

  test('a plugin claude binding whose model left the catalog falls back to the default spawn tier', async () => {
    setPluginRolesProvider(() => [{ role: 'myplug/legacy', label: 'Legacy', binding: { backend: 'claude', model: 'claude-retired-9' }, plugin: 'myplug' }]);
    try {
      await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
      const expected = getTierBackend(getDefaultSpawnTier()); // {backend,model} the fallback must land on
      const spawned = await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'myplug/legacy' });
      await waitFor(() => instances.idsForSession(spawned.sessionId).length > 0);
      const inst = instances.get(instances.idsForSession(spawned.sessionId)[0]);
      assert.equal(inst.backend, expected.backend);
      assert.equal(inst.model, expected.model, 'dead plugin model must not pass through — fall back to the default spawn tier');
    } finally { setPluginRolesProvider(null); }
  });

  test('a user override of a plugin role wins at spawn; re-selecting the manifest model reverts', async () => {
    setPluginRolesProvider(() => [{ role: 'myplug/scribe', label: 'Scribe', binding: { backend: 'claude', model: 'claude-haiku-4-5' }, plugin: 'myplug' }]);
    try {
      await setRoleBinding('myplug/scribe', { backend: 'claude', model: 'claude-opus-4-8' }); // override
      await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
      const spawned = await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'myplug/scribe' });
      await waitFor(() => instances.idsForSession(spawned.sessionId).length > 0);
      const inst = instances.get(instances.idsForSession(spawned.sessionId)[0]);
      assert.equal(inst.backend, 'claude');
      assert.equal(inst.model, 'claude-opus-4-8', 'override beats the manifest haiku binding');
      // Revert by re-selecting the manifest model in the same picker (no reset).
      await setRoleBinding('myplug/scribe', { backend: 'claude', model: 'claude-haiku-4-5' });
      const spawned2 = await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'myplug/scribe' });
      await waitFor(() => instances.idsForSession(spawned2.sessionId).length > 0);
      const inst2 = instances.get(instances.idsForSession(spawned2.sessionId)[0]);
      assert.equal(inst2.model, 'claude-haiku-4-5', 're-selecting the manifest model reverts');
    } finally { setPluginRolesProvider(null); }
  });

  test('a stored override is ignored while the plugin is disabled (spawn refuses BAD_MODEL)', async () => {
    // Enable the plugin, store an override, then disable: the role is no longer
    // resolvable, so the override must NOT rescue it — spawn refuses. (The
    // override key is retained in the per-test settings store; no cleanup needed.)
    setPluginRolesProvider(() => [{ role: 'myplug/scribe', label: 'Scribe', binding: { backend: 'claude', model: 'claude-haiku-4-5' }, plugin: 'myplug' }]);
    await setRoleBinding('myplug/scribe', { backend: 'claude', model: 'claude-opus-4-8' });
    setPluginRolesProvider(() => []); // disable
    try {
      await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
      const res = await fetch(baseUrl + '/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1002, method: 'tools/call', params: { name: 'spawn_instance', arguments: { project: 'p', mode: 'bypassPermissions', model: 'myplug/scribe' } } }),
      });
      const body = await res.json();
      assert.equal(body.result.isError, true, JSON.stringify(body));
      assert.match(body.result.content[0].text, /unknown model/);
    } finally {
      setPluginRolesProvider(null);
    }
  });
});

// Card 2026-0486 — the shape the WEB UI actually sends: `POST /api/instances`
// with `tier`/`role` and NO `model`/`backend` key at all (the client no longer
// resolves either). A spawn like this must land on whatever the row is bound
// to RIGHT NOW, not a binding cached from an earlier page load — so a stale
// client (another tab, another device, a Settings edit made elsewhere) can't
// pin an old model.
describe('a UI-shaped spawn (row named, no model) lands on the CURRENT binding', () => {
  test('a tier spawn follows a rebind made after the row was last read', async () => {
    // Bound away from `fast`'s OWN default (claude-haiku-4-5): a resolver that
    // fell back to DEFAULT_TIER_BACKEND instead of reading the stored binding
    // would still pass the haiku case, so this has to differ from the tier's
    // default to actually discriminate.
    await setTierBackend('fast', { backend: 'claude', model: 'claude-opus-4-8' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    let r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', tier: 'fast' });
    assert.equal(r.status, 201);
    assert.equal(instances.get(r.body.id).model, 'claude-opus-4-8');

    await setTierBackend('fast', { backend: 'claude', model: 'claude-sonnet-5' });
    r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', tier: 'fast' });
    assert.equal(r.status, 201);
    assert.equal(instances.get(r.body.id).model, 'claude-sonnet-5', 'the SECOND spawn sees the rebind, not a cached pair');
  });

  test('a role spawn follows a rebind made after the row was last read', async () => {
    await setRoleBinding('conductor', { kind: 'tier', tier: 'fast' });
    await setTierBackend('fast', { backend: 'claude', model: 'claude-haiku-4-5' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    let r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', role: 'conductor' });
    assert.equal(r.status, 201);
    assert.equal(instances.get(r.body.id).model, 'claude-haiku-4-5');

    // Rebind to a wholly concrete binding this time (not a tier reference), so
    // the second half of resolveRoleBackend's branch is exercised too.
    await setRoleBinding('conductor', { backend: 'claude', model: 'claude-opus-4-8' });
    r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', role: 'conductor' });
    assert.equal(r.status, 201);
    assert.equal(instances.get(r.body.id).model, 'claude-opus-4-8', 'the concrete rebind wins, not the old tier-ref binding');
  });

  test('naming neither model nor backend for a role bound to a substitution backend spawns there', async () => {
    await addCustomModel({ label: 'G', model: 'gemma4:cloud', backend: 'ollama', contextWindow: 200_000 });
    await setRoleBinding('reviewer', { backend: 'ollama', model: 'gemma4:cloud' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', role: 'reviewer' });
    assert.equal(r.status, 201);
    const inst = instances.get(r.body.id);
    assert.equal(inst.backend, 'ollama');
    assert.equal(inst.model, 'gemma4:cloud');
  });

  test('naming `backend:"claude"` alongside a role bound to a substitution backend is refused — the UI must never send this', async () => {
    await addCustomModel({ label: 'G', model: 'gemma4:cloud', backend: 'ollama', contextWindow: 200_000 });
    await setRoleBinding('reviewer', { backend: 'ollama', model: 'gemma4:cloud' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const before = (await api(baseUrl, 'GET', '/api/instances')).body.length;
    const r = await api(baseUrl, 'POST', '/api/instances',
      { project: 'p', mode: 'bypassPermissions', role: 'reviewer', backend: 'claude' });
    assert.equal(r.status, 422);
    assert.match(r.body.error, /the row this spawn resolves to is bound to backend 'ollama'/);
    const after = (await api(baseUrl, 'GET', '/api/instances')).body.length;
    assert.equal(after, before, 'the refused request must spawn nothing');
  });

  // Pins `takeSpawnRow`'s precedence — `role` checked before `tier`
  // (src/routes.ts) — against two rows bound to visibly different models, so
  // a swap in that order would fail this rather than pass it by coincidence.
  test('naming both a resolvable role and a tier resolves the ROLE\'s row', async () => {
    await setRoleBinding('reviewer', { backend: 'claude', model: 'claude-opus-4-8' });
    await setTierBackend('fast', { backend: 'claude', model: 'claude-haiku-4-5' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(baseUrl, 'POST', '/api/instances',
      { project: 'p', mode: 'bypassPermissions', role: 'reviewer', tier: 'fast' });
    assert.equal(r.status, 201);
    assert.equal(instances.get(r.body.id).model, 'claude-opus-4-8', 'the role\'s row wins, not the tier\'s');
  });
});

describe('setModel live-switch gate', () => {
  test('blocks changing model on a session running on a substitution backend', async () => {
    const { inst } = await spawnOnBackend();
    await assert.rejects(() => inst.setModel('claude-opus-4-8', 'claude'), /non-Claude backend/);
  });

  test('blocks switching a Claude session TO a substitution backend', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', model: 'claude-opus-4-8' });
    const inst = instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle');
    await assert.rejects(() => inst.setModel('gemma4:cloud', 'ollama'), /non-Claude backend/);
    // …and to a USER-DEFINED one, not just the built-in ollama row.
    await addBackend({ id: 'p2', label: 'P2', template: 'p2 claude --model {model} --' });
    await assert.rejects(() => inst.setModel('mine:v1', 'p2'), /non-Claude backend/);
  });
});

describe('null-model guards', () => {
  test('a fresh substitution-backend spawn with no model is refused', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', backend: 'ollama' });
    assert.equal(r.status >= 400, true);
    assert.match(JSON.stringify(r.body), /no resolvable model|BACKEND_MODEL_MISSING/);
  });

  // The null-model guard is UNCONDITIONAL on template shape: a pass-through wrapper
  // (no `{model}`) still needs a model, because the model rides in the forwarded
  // claude args and drives the context-window env.
  test('a backend whose template omits {model} is STILL refused with no model', async () => {
    await addBackend({ id: 'fixedwrap', label: 'Fixed Wrap', template: 'launch claude --' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const cwd = path.join(projectsRoot, 'p');
    const sid = 'eeeeeeee-0000-0000-0000-000000000000';
    const dir = path.join(claudeProjectsRoot(), encodeCwd(cwd));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${sid}.jsonl`),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, sessionId: sid }) + '\n');
    await setSessionBackend(sid, 'fixedwrap');

    await assert.rejects(
      () => instances.create({ project: 'p', resume: sid }),
      (e) => {
        assert.equal(e.code, 'BACKEND_MODEL_MISSING');
        return true;
      },
    );
  });

  test('resuming a substitution-backend session whose jsonl has no model is refused (not `--model undefined`)', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const cwd = path.join(projectsRoot, 'p');
    const sid = 'aaaaaaaa-0000-0000-0000-000000000000';
    // A resumable jsonl (has a user line) but NO assistant model line, so
    // readLastSessionModel returns null. Marked with no tag (legacy-null entry)
    // so there's no store fallback either.
    const dir = path.join(claudeProjectsRoot(), encodeCwd(cwd));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${sid}.jsonl`),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, sessionId: sid }) + '\n');
    await setSessionBackend(sid, 'ollama'); // the record says which backend, model unknown
    await assert.rejects(
      () => instances.create({ project: 'p', resume: sid }),
      /no resolvable model|BACKEND_MODEL_MISSING/,
    );
  });
});

// A backend can be removed while a session that ran on it still exists. The
// session record still names it, so resume must refuse clearly rather than fall back to
// `claude` while keeping the foreign model id — which spawns a real
// `claude --model <foreign-id>` that fails deep inside the CLI.
describe('resume onto a since-removed backend', () => {
  test('refuses with BACKEND_GONE instead of spawning claude with a foreign model id', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const cwd = path.join(projectsRoot, 'p');
    const sid = 'cccccccc-0000-0000-0000-000000000000';
    const dir = path.join(claudeProjectsRoot(), encodeCwd(cwd));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${sid}.jsonl`),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, sessionId: sid }) + '\n');
    // The session record names a backend that was never registered (equivalently: removed).
    await setSessionBackend(sid, 'gone-proxy', 'mine:v1');

    await assert.rejects(
      () => instances.create({ project: 'p', resume: sid }),
      (e) => {
        assert.equal(e.statusCode, 422);
        assert.equal(e.code, 'BACKEND_GONE');
        assert.match(e.message, /gone-proxy/);
        return true;
      },
    );
  });

  test('re-adding the backend makes the same resume work again', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const cwd = path.join(projectsRoot, 'p');
    const sid = 'dddddddd-0000-0000-0000-000000000000';
    const dir = path.join(claudeProjectsRoot(), encodeCwd(cwd));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${sid}.jsonl`),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, sessionId: sid }) + '\n');
    await setSessionBackend(sid, 'back-again', 'mine:v1');

    await addBackend({ id: 'back-again', label: 'Back Again', template: 'backagain claude --model {model} --' });
    const inst = await instances.create({ project: 'p', resume: sid });
    await waitFor(() => inst.status === 'idle');
    assert.equal(inst.backend, 'back-again');
    assert.equal(inst.model, 'mine:v1', "the recorded tagged model is still preferred");
  });
});

// An unknown/removed backend must never reach a real `claude` launch. Three
// independent doors, each closed and tested separately — the bug kept reappearing
// because each earlier fix shut only one.
describe('an unknown or removed backend never falls through to real claude', () => {
  // DOOR 1: an EXPLICIT backend id that isn't in the registry. Reachable from
  // POST /api/instances and from resumeRestart's graceful-restart replay, which
  // carries the recorded backend id forward.
  test('door 1: an explicit unknown backend is refused, not silently downgraded to claude', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    await assert.rejects(
      () => instances.create({ project: 'p', mode: 'bypassPermissions', backend: 'vanished', model: 'foreign:v1' }),
      (e) => {
        assert.equal(e.statusCode, 422);
        assert.equal(e.code, 'BACKEND_GONE');
        assert.match(e.message, /vanished/);
        return true;
      },
    );
    // …and over REST, the surface a client actually hits.
    const r = await api(baseUrl, 'POST', '/api/instances',
      { project: 'p', mode: 'bypassPermissions', backend: 'vanished', model: 'foreign:v1' });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.match(JSON.stringify(r.body), /BACKEND_GONE|unknown backend/);
  });

  // The same door as replayed by the graceful-restart manifest: restoreFromResumeManifest
  // passes the persisted `backend` straight into create(), so a backend removed
  // across the restart must surface there too rather than spawn bare claude.
  test('door 1 (restart replay): a manifest entry naming a removed backend is refused', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    // Exactly the create() call resumeRestart.ts:293 makes for a carried-over session.
    await assert.rejects(
      () => instances.create({
        project: 'p', resume: 'ffffffff-0000-0000-0000-000000000000',
        mode: 'bypassPermissions', model: 'foreign:v1', backend: 'vanished',
      }),
      (e) => { assert.equal(e.code, 'BACKEND_GONE'); return true; },
    );
  });

  // DOOR 2: the backstop. If a row ever does vanish under a live instance,
  // getBackend() returns null at spawn time and resolveBackendLaunch(null, …) would
  // read `backend?.template` as blank and take the IDENTITY branch — launching the
  // real claude with this session's foreign model. Door 3 makes that unreachable
  // through the API, so this is exercised white-box, by putting the instance in
  // exactly the state a removal would have left it in.
  test('door 2: spawn refuses a null backend record instead of taking the identity branch', async () => {
    await addBackend({ id: 'doomed', label: 'Doomed', template: 'doomedctl claude --model {model} --' });
    await addCustomModel({ label: 'D', model: 'doomed:v1', backend: 'doomed', contextWindow: 128_000 });
    const { id, inst } = await spawnOnBackend({ model: 'doomed:v1', backend: 'doomed' });
    assert.equal(inst.backend, 'doomed');

    await inst.kill({ graceMs: 5 });
    await waitFor(() => !instances.get(id).proc);
    inst.backend = 'vanished'; // the post-removal state, without going through removal

    await assert.rejects(
      () => instances.respawn(id),
      (e) => {
        assert.equal(e.code, 'BACKEND_GONE');
        assert.match(e.message, /vanished/);
        return true;
      },
    );
    assert.equal(instances.get(id).status, 'crashed', 'the failure is visible, not silently billed');
  });

  // DOOR 3: removeBackend itself refuses while a live instance is on that backend,
  // naming the sessions — consistent with the bound-custom-models refusal.
  test('door 3: removeBackend refuses (409) while a live instance is on that backend', async () => {
    await addBackend({ id: 'inuse', label: 'In Use', template: 'inusectl claude --model {model} --' });
    await addCustomModel({ label: 'U', model: 'inuse:v1', backend: 'inuse', contextWindow: 128_000 });
    const { inst } = await spawnOnBackend({ model: 'inuse:v1', backend: 'inuse' });

    // The bound custom model is refused first…
    await assert.rejects(() => removeBackend('inuse'), /custom models bound to it/);
    await removeCustomModel('inuse', 'inuse:v1');
    // …then the LIVE session is, naming it.
    await assert.rejects(
      () => removeBackend('inuse'),
      (e) => {
        assert.equal(e.statusCode, 409);
        assert.match(e.message, /open session/);
        // The remedy must NOT be "kill them" — the kill button leaves a non-temp
        // instance tracked, so the 409 just repeats (asserted below).
        assert.match(e.message, /archive or delete/);
        assert.doesNotMatch(e.message, /kill (it|them) first/);
        assert.match(e.message, new RegExp(inst.sessionId));
        return true;
      },
    );
    assert.ok(isKnownBackend('inuse'), 'nothing deleted on refusal');

    // A killed-but-tracked instance is STILL respawnable, so it still blocks;
    // only forgetting it (remove) clears the way.
    await inst.kill({ graceMs: 5 });
    await assert.rejects(() => removeBackend('inuse'), /open session/);
    await instances.remove(inst.id);
    assert.equal(await removeBackend('inuse'), true);
  });
});

// ── launch_failed crash signal ───────────────────────────────────────────────
// The launcher is shared — see tests/controllableLauncher.mjs.

describe('launch_failed crash signal', () => {
  let cctx, cbase, cinst, chome, launcher, events;
  before(async () => {
    launcher = new ControllableLauncher();
    cctx = await bootServer({ scenarioPath: SCENARIO, claudeLauncher: launcher });
    ({ baseUrl: cbase, instances: cinst } = cctx);
  });
  after(async () => { await cctx.close(); });
  beforeEach(async () => { ({ home: chome } = await freshProjectsRoot()); events = []; cinst.on('event', ({ ev }) => events.push(ev)); });
  afterEach(async () => { cinst.removeAllListeners('event'); await cinst.shutdown(); await rmrf(chome); });

  const hasLaunchFailed = () => events.find(e => e.kind === 'system' && e.subtype === 'launch_failed');

  async function spawnAndWaitIdle(model, backend) {
    await api(cbase, 'POST', '/api/projects', { name: 'p' });
    const r = await api(cbase, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', model, backend });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.id;
    await waitFor(() => cinst.get(id)?.status === 'idle');
    return id;
  }

  test('a substitution-backend subprocess that crashes emits launch_failed with captured stderr', async () => {
    const id = await spawnAndWaitIdle('glm-5.2:cloud', 'ollama');
    launcher.last.crash('Error: cloud model requires auth (401)');
    await waitFor(() => cinst.get(id)?.status === 'crashed');
    const ev = hasLaunchFailed();
    assert.ok(ev, 'launch_failed emitted for a substitution-backend crash');
    assert.equal(ev.data.code, 1);
    assert.match(ev.data.stderr, /cloud model requires auth \(401\)/);
  });

  // Generalization check: the signal is keyed on "not the identity backend", so a
  // user-defined row gets it too.
  test('a USER-DEFINED backend crash also emits launch_failed', async () => {
    await addBackend({ id: 'crashy', label: 'Crashy', template: 'crashy claude --model {model} --' });
    await addCustomModel({ label: 'C', model: 'c:v1', backend: 'crashy', contextWindow: 100_000 });
    const id = await spawnAndWaitIdle('c:v1', 'crashy');
    launcher.last.crash('crashyctl: not found');
    await waitFor(() => cinst.get(id)?.status === 'crashed');
    const ev = hasLaunchFailed();
    assert.ok(ev, 'launch_failed emitted for a user-defined backend crash');
    assert.match(ev.data.stderr, /crashyctl: not found/);
  });

  test('a claude subprocess crash emits exit but NOT launch_failed', async () => {
    const id = await spawnAndWaitIdle('claude-opus-4-8', 'claude');
    launcher.last.crash('some claude stderr');
    await waitFor(() => cinst.get(id)?.status === 'crashed');
    assert.ok(events.find(e => e.kind === 'system' && e.subtype === 'exit'), 'exit still emitted');
    assert.equal(hasLaunchFailed(), undefined, 'no launch_failed for claude backend');
  });

  // T10 (card 2026-0286 §2) — the case docs/protocol.md names FIRST ("wrapper binary
  // missing") and which emitted NOTHING terminal before the terminal latch: the
  // wrapper never started, so there was no 'exit' to key launch_failed on.
  test('a substitution-backend spawn that NEVER STARTED also emits launch_failed', async () => {
    await addBackend({ id: 'ghosty', label: 'Ghosty', template: 'ghostyctl claude --model {model} --' });
    await addCustomModel({ label: 'G', model: 'g:v1', backend: 'ghosty', contextWindow: 100_000 });
    await api(cbase, 'POST', '/api/projects', { name: 'p' });
    launcher.failNext = 'spawn ghostyctl ENOENT';
    const r = await api(cbase, 'POST', '/api/instances',
      { project: 'p', mode: 'bypassPermissions', model: 'g:v1', backend: 'ghosty' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const inst = cinst.get(r.body.id);
    await waitFor(() => inst.proc === null);
    assert.equal(inst.status, 'crashed');
    const ev = hasLaunchFailed();
    assert.ok(ev, 'launch_failed emitted for a spawn that never started');
    assert.equal(ev.data.code, -2);
    assert.equal(ev.data.signal, null);
    assert.equal(ev.data.stderr, null, 'no process ever ran, so there is no stderr');
    const se = events.find(e => e.kind === 'system' && e.subtype === 'spawn_error');
    assert.match(se.data.message, /ghostyctl ENOENT/, 'the reason rides on spawn_error');
  });

  test('a commanded kill of a substitution-backend session does NOT emit launch_failed', async () => {
    const id = await spawnAndWaitIdle('glm-5.2:cloud', 'ollama');
    await cinst.get(id).kill({ graceMs: 5 }); // sets _killing → signalled exit is guarded
    await waitFor(() => !cinst.get(id)?.proc);
    assert.equal(hasLaunchFailed(), undefined, 'kill is not a launch failure');
  });
});

describe('resume recovers the tagged model from the backend store', () => {
  // The primary bug: the inner CLI records `message.model` BARE in the jsonl
  // (`deepseek-v4-flash`), so a fresh-Instance resume that reads the jsonl would
  // relaunch the unpullable tagless name. The store carries the full tag; resume
  // must prefer it. (This path — a fresh `create({resume})` with no explicit
  // model — is distinct from the live `respawn` covered in model-resume.test.mjs.)
  test('a fresh resume launches with the store\'s `:cloud` tag, not the bare jsonl model', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ollama-resume-'));
    const argvDump = path.join(tmp, 'argv.txt');
    process.env.FAKE_CLAUDE_ARGV_DUMP = argvDump;
    try {
      await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
      const cwd = path.join(projectsRoot, 'p');
      const sid = 'bbbbbbbb-0000-0000-0000-000000000000';
      // Resumable jsonl whose assistant line reports the BARE model (what the
      // Ollama-wrapped CLI actually persists — tag already dropped).
      const dir = path.join(claudeProjectsRoot(), encodeCwd(cwd));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${sid}.jsonl`),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, sessionId: sid }) + '\n' +
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'deepseek-v4-flash', content: [] }, sessionId: sid }) + '\n');
      // Store holds the FULL tag (written at the original spawn).
      await setSessionBackend(sid, 'ollama', 'deepseek-v4-flash:cloud');

      const inst = await instances.create({ project: 'p', resume: sid }); // no explicit model
      await waitFor(() => inst.status === 'idle');
      assert.equal(inst.model, 'deepseek-v4-flash:cloud', 'recovered the tagged model, not the bare jsonl value');

      await waitFor(async () => { try { await fs.stat(argvDump); return true; } catch { return false; } });
      const argv = (await fs.readFile(argvDump, 'utf8')).split('\n').filter(Boolean);
      assert.deepEqual(argv.slice(0, 6), ['launch', 'claude', '--model', 'deepseek-v4-flash:cloud', '--yes', '--'],
        'resume relaunches ollama with the still-tagged model');
    } finally {
      delete process.env.FAKE_CLAUDE_ARGV_DUMP;
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ── MCP resume restores the recorded backend ────────────────────────────────
// REST leaves `backend` null on a resume, so _doCreateResolved's recorded-backend
// recovery runs there — every describe above pins it through instances.create().
// The MCP surface alone did NOT: resolveSpawnModel initialised `backend` to
// 'claude' unconditionally, so a bare spawn_instance({resume}) forwarded
// backend:'claude' as if the caller had named it, explicitBackend was truthy,
// the whole recorded-backend block was skipped, and the session came back on the real
// Anthropic CLI keeping its foreign --model. These tests drive BOTH spawns
// through the real /mcp transport — nothing here may go through
// instances.create(), which is the surface that already worked.
describe('MCP resume restores the recorded backend', () => {
  let rpcId = 1;
  async function callTool(name, args) {
    const res = await fetch(baseUrl + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await res.json();
    assert.ok(body.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
    return body.result;
  }
  const meta = (result) => JSON.parse(result.content[0].text);
  // The decoy model written into the seeded jsonl — deliberately different
  // from the recorded `stealth/ox-alpha` so the record-over-jsonl precedence
  // pins can discriminate. The fixture guard in spawnThenResume asserts both
  // halves of that "deliberately".
  const DECOY_JSONL_MODEL = 'claude-opus-4-8';
  // The LIVE instance for a session — idsForSession also matches the killed
  // predecessor, which stays tracked, so [0] is not necessarily the live one.
  const liveForSession = (sid) =>
    instances.idsForSession(sid).map(id => instances.get(id)).find(i => i?.proc) ?? null;

  // Shared fixture: spawn on a USER-DEFINED row through the MCP tool (not the
  // managed `ollama` — per this file's stated policy, a rule keyed on that id
  // rather than on "not the identity backend" would pass the managed row and
  // fail this one), kill the worker, then resume it through the same tool
  // (`resumeArgs` overrides the otherwise-bare resume arguments). Returns both
  // tool summaries. The context window (321_000) matches NO Claude model, so no
  // assertion below can pass by coincidence through a claude resolution of the
  // id (which returns null); every expected value is a literal seeded into the
  // registry, never re-derived from the code's own resolvers.
  async function spawnThenResume({ argvDump, resumeArgs } = {}) {
    const prevDump = process.env.FAKE_CLAUDE_ARGV_DUMP;
    try {
      await addBackend({
        id: 'openrouter-test', label: 'OpenRouter Test',
        template: 'orproxy claude --model {model} --',
      });
      await addCustomModel({ label: 'OX', model: 'stealth/ox-alpha', backend: 'openrouter-test', contextWindow: 321_000 });
      await api(baseUrl, 'POST', '/api/projects', { name: 'p' });

      const first = meta(await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'stealth/ox-alpha' }));
      const sid = first.sessionId; // the PUBLIC id — the conductor's only handle
      await waitFor(() => liveForSession(sid)?.status === 'idle');
      // The transcript is named by the BACKING id (the CLI-minted one), not the
      // public handle; resolve it off the tracked instance. The backend record
      // is keyed by the public handle.
      const inst0 = instances.get(instances.idsForSession(sid)[0]);
      const backing = inst0.backingSessionId;
      const rec = await settledSessionBackend(sid); // spawn()'s write is fire-and-forget

      // The fake engine writes no transcript, so seed the resumable jsonl by
      // hand (hasResumableConversation gates the resume at _doCreateResolved);
      // the file is named by the backing id, like every real transcript. Its
      // assistant line reports a DIFFERENT model than the record carries, so
      // the resume assertions below also pin record-over-jsonl precedence —
      // they fail if that ordering is ever inverted.
      const cwd = path.join(projectsRoot, 'p');
      const dir = path.join(claudeProjectsRoot(), encodeCwd(cwd));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${backing}.jsonl`),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, sessionId: backing }) + '\n' +
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: DECOY_JSONL_MODEL, content: [] }, sessionId: backing }) + '\n');

      // FIXTURE GUARD: the record-over-jsonl precedence pins below are only
      // discriminating while the two recovery sources DISAGREE — if this seed
      // ever decays into agreement with the record, dropping the record's
      // model recovery would turn those assertions green. Fail loudly here
      // instead of proving nothing.
      const seededLines = (await fs.readFile(path.join(dir, `${backing}.jsonl`), 'utf8'))
        .trim().split('\n').map(l => JSON.parse(l));
      const seededModel = seededLines.find(l => l.type === 'assistant')?.message?.model;
      assert.equal(seededModel, DECOY_JSONL_MODEL, 'the decoy assistant line landed in the seeded jsonl');
      assert.notEqual(seededModel, rec?.model,
        'fixture decayed: the seeded jsonl agrees with the recorded model, so the record-over-jsonl assertions below are vacuous');

      // REQUIRED before resuming: create() REFUSES a resume whose session is
      // still attached to a running instance (409, src/instances.ts create()),
      // so without the kill-and-wait the tool call errors and these tests die
      // as a JSON.parse crash on the error prose instead of through their
      // assertions. Coalescing is NOT what blocks it here — that path covers
      // only a not-yet-spawned in-flight create. Wait until nothing is
      // attached, not just for kill() to return.
      await inst0.kill({ graceMs: 5 });
      await waitFor(() => !liveForSession(sid));

      if (argvDump) process.env.FAKE_CLAUDE_ARGV_DUMP = argvDump;
      // Resume by the PUBLIC handle — the exact call the card reported. Bare
      // unless the caller overrides: no model, no backend, everything recovered
      // from the session record.
      const resumed = meta(await callTool('spawn_instance', { project: 'p', resume: sid, ...resumeArgs }));
      await waitFor(() => liveForSession(sid)?.status === 'idle');
      return { first, sid, resumed };
    } finally {
      if (prevDump === undefined) delete process.env.FAKE_CLAUDE_ARGV_DUMP;
      else process.env.FAKE_CLAUDE_ARGV_DUMP = prevDump;
    }
  }

  test('a bare MCP resume comes back on the recorded backend, not claude', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-resume-backend-'));
    try {
      const argvDump = path.join(tmp, 'argv-resume.txt');
      const { first, sid, resumed } = await spawnThenResume({ argvDump });

      // The first spawn's own returned view — literally the surface the card
      // reported against.
      assert.equal(first.backend, 'openrouter-test');
      assert.equal(first.model, 'stealth/ox-alpha');
      assert.equal(first.contextWindowTokens, 321_000);

      // The bare resume recovers all three from the session record.
      assert.equal(resumed.sessionId, sid);
      assert.equal(resumed.backend, 'openrouter-test', 'the recorded backend, not claude');
      assert.equal(resumed.model, 'stealth/ox-alpha',
        "the recorded exact model, not the jsonl's claude-opus-4-8 report");
      assert.equal(resumed.contextWindowTokens, 321_000);

      // The real launch, not just the summary field: the resumed worker actually
      // went to the substitution backend's template (its prefix after token 0),
      // rather than a cosmetically-correct field over a real `claude` launch.
      await waitFor(async () => { try { await fs.stat(argvDump); return true; } catch { return false; } });
      const argv = (await fs.readFile(argvDump, 'utf8')).split('\n').filter(Boolean);
      assert.deepEqual(argv.slice(0, 4), ['claude', '--model', 'stealth/ox-alpha', '--']);
    } finally {
      delete process.env.FAKE_CLAUDE_ARGV_DUMP;
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('list_sessions renders a resumed worker on its recorded backend', async () => {
    const { resumed } = await spawnThenResume();
    // Precondition, not the render under test: the resume itself restored the row.
    assert.equal(resumed.backend, 'openrouter-test');
    const rendered = (await callTool('list_sessions', { project: 'p' })).content[0].text;
    assert.ok(rendered.includes('model openrouter-test/stealth/ox-alpha'),
      `expected the live row to render the recorded backend/model:\n${rendered}`);
    // The exact string the card reported must never come back.
    assert.ok(!rendered.includes('model claude/stealth/ox-alpha'),
      `resumed worker rendered as claude/<foreign-model>:\n${rendered}`);
  });

  // The other half of the recovery contract, pinned nowhere else in the suite:
  // an EXPLICITLY named model on a resume wins over the session's backend
  // record — both axes, because naming a model id served by exactly one other
  // backend names that backend through resolveSpawnModel, with no `backend`
  // argument passed. The chosen model therefore belongs to a DIFFERENT
  // backend than the recorded one, so losing the override is observable in which
  // launch template fires — not just in the summary field.
  test('an MCP resume with an explicitly named model beats the recorded pair', async () => {
    // gemma4:cloud → ollama: resuming with it names backend 'ollama' while the
    // record still says openrouter-test/stealth/ox-alpha.
    await addCustomModel({ label: 'G', model: 'gemma4:cloud', backend: 'ollama', contextWindow: 111_000 });
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-resume-explicit-'));
    try {
      const argvDump = path.join(tmp, 'argv-explicit.txt');
      const { resumed } = await spawnThenResume({ argvDump, resumeArgs: { model: 'gemma4:cloud' } });

      assert.equal(resumed.model, 'gemma4:cloud');
      assert.equal(resumed.backend, 'ollama',
        'the explicitly resolved backend wins — the session record must not overwrite it');

      // The override reaches the real launch: ollama's template prefix (after
      // token 0), not openrouter-test's.
      await waitFor(async () => { try { await fs.stat(argvDump); return true; } catch { return false; } });
      const argv = (await fs.readFile(argvDump, 'utf8')).split('\n').filter(Boolean);
      assert.deepEqual(argv.slice(0, 6), ['launch', 'claude', '--model', 'gemma4:cloud', '--yes', '--']);
    } finally {
      delete process.env.FAKE_CLAUDE_ARGV_DUMP;
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });

  // The recorded-backend BACKEND_GONE door (_doCreateResolved, claimed by docs/models.md
  // "Missing backends are refused") was dead code from MCP before the fix: the
  // asserted 'claude' bypassed it and such a resume launched real
  // `claude --model <foreign-id>` — billed. Mirrors the REST-side test in
  // "resume onto a since-removed backend".
  test('an MCP resume of a session on a removed backend refuses BACKEND_GONE', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const cwd = path.join(projectsRoot, 'p');
    const sid = 'dededede-0000-0000-0000-000000000000';
    const dir = path.join(claudeProjectsRoot(), encodeCwd(cwd));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${sid}.jsonl`),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, sessionId: sid }) + '\n');
    // A genuinely resumable session whose record names a never-registered
    // (equivalently: removed) backend.
    await setSessionBackend(sid, 'gone-proxy', 'mine:v1');

    const result = await callTool('spawn_instance', { project: 'p', resume: sid }); // no model, no backend
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.match(result.content[0].text, /gone-proxy/, 'the prose names the dead backend');
    const structured = JSON.parse(result.content[1].text);
    assert.equal(structured.code, 'BACKEND_GONE');
    assert.equal(structured.statusCode, 422);
    // It REFUSED instead of launching: flush anything queued behind the error,
    // then confirm no instance exists for the session.
    await settle();
    assert.equal(instances.idsForSession(sid).length, 0);
  });
});

describe('a model id on several backends (MCP spawn)', () => {
  let rpcId = 1;
  async function callTool(name, args) {
    const res = await fetch(baseUrl + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await res.json();
    assert.ok(body.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
    return body.result;
  }
  const meta = (result) => JSON.parse(result.content[0].text);
  // A thrown refusal's structured half (isError results carry it second).
  const thrown = (result) => {
    assert.equal(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[1].text);
  };
  const liveForSession = (sid) =>
    instances.idsForSession(sid).map(id => instances.get(id)).find(i => i?.proc) ?? null;

  // `mine:v1` on the built-in ollama row AND a user-defined row `p`, with
  // different windows so which row a spawn resolved is visible in its summary.
  async function seedDuplicate() {
    await addBackend({ id: 'p', label: 'P', template: 'pproxy claude --model {model} --' });
    await addBackend({ id: 'other', label: 'Other', template: 'other claude --model {model} --' });
    await addCustomModel({ label: 'Mine (p)', model: 'mine:v1', backend: 'p', contextWindow: 222_000 });
    await addCustomModel({ label: 'Mine (ollama)', model: 'mine:v1', backend: 'ollama', contextWindow: 111_000 });
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  }

  async function spawnAndDump(args) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'multi-backend-'));
    const argvDump = path.join(tmp, 'argv.txt');
    process.env.FAKE_CLAUDE_ARGV_DUMP = argvDump;
    try {
      const view = meta(await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', ...args }));
      await waitFor(() => liveForSession(view.sessionId)?.status === 'idle');
      await waitFor(async () => { try { await fs.stat(argvDump); return true; } catch { return false; } });
      const argv = (await fs.readFile(argvDump, 'utf8')).split('\n').filter(Boolean);
      return { view, inst: liveForSession(view.sessionId), argv };
    } finally {
      delete process.env.FAKE_CLAUDE_ARGV_DUMP;
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  test('a bare id on two backends is refused MODEL_AMBIGUOUS, naming both, spawning nothing', async () => {
    await seedDuplicate();
    const before = instances.list().length;
    const r = meta(await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'mine:v1' }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'MODEL_AMBIGUOUS');
    assert.equal(r.model, 'mine:v1');
    assert.deepEqual(r.backends, ['ollama', 'p']);
    assert.match(r.reason, /backend:"<id>"/);
    assert.match(r.reason, /\bollama\b/);
    assert.match(r.reason, /\bp\b/);
    await settle();
    assert.equal(instances.list().length, before, 'no instance was created');
  });

  test('backend picks the row: each pick launches that backend\'s template', async () => {
    await seedDuplicate();
    const onP = await spawnAndDump({ model: 'mine:v1', backend: 'p' });
    assert.equal(onP.inst.backend, 'p');
    assert.equal(onP.view.contextWindowTokens, 222_000);
    assert.deepEqual(onP.argv.slice(0, 4), ['claude', '--model', 'mine:v1', '--']);
    const onOllama = await spawnAndDump({ model: 'mine:v1', backend: 'ollama' });
    assert.equal(onOllama.inst.backend, 'ollama');
    assert.equal(onOllama.view.contextWindowTokens, 111_000);
    assert.deepEqual(onOllama.argv.slice(0, 6), ['launch', 'claude', '--model', 'mine:v1', '--yes', '--']);
  });

  test('a backend that does not serve the id, or one beside a tier, is BAD_MODEL', async () => {
    await seedDuplicate();
    const before = instances.list().length;
    const wrong = thrown(await callTool('spawn_instance', { project: 'p', model: 'mine:v1', backend: 'other' }));
    assert.equal(wrong.code, 'BAD_MODEL');
    assert.match(wrong.error, /not configured on backend 'other'/);
    assert.match(wrong.error, /ollama, p/, 'the refusal lists the backends that do serve it');
    const withTier = thrown(await callTool('spawn_instance', { project: 'p', model: 'powerful', backend: 'p' }));
    assert.equal(withTier.code, 'BAD_MODEL');
    const noModel = thrown(await callTool('spawn_instance', { project: 'p', backend: 'p' }));
    assert.equal(noModel.code, 'BAD_MODEL');
    await settle();
    assert.equal(instances.list().length, before, 'no instance was created');
  });

  test('a curated preset id also added on another backend is MODEL_AMBIGUOUS', async () => {
    await seedDuplicate();
    const preset = OLLAMA_CLOUD_MODELS[0];
    await addCustomModel({ label: 'Preset on p', model: preset.model, backend: 'p', contextWindow: 99_000 });
    const before = instances.list().length;
    const r = meta(await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: preset.model }));
    assert.equal(r.code, 'MODEL_AMBIGUOUS', JSON.stringify(r));
    assert.deepEqual(r.backends, ['ollama', 'p']);
    await settle();
    assert.equal(instances.list().length, before, 'no instance was created');
  });

  test('backend:"claude" with an explicit Claude model id passes through and spawns on claude', async () => {
    await seedDuplicate();
    const { view, inst, argv } = await spawnAndDump({ model: 'claude-haiku-4-5', backend: 'claude' });
    assert.notEqual(view.ok, false, JSON.stringify(view));
    assert.equal(inst.backend, 'claude');
    assert.equal(inst.model, 'claude-haiku-4-5');
    const i = argv.indexOf('--model');
    assert.equal(argv[i + 1], 'claude-haiku-4-5', `argv: ${argv.join(' ')}`);
  });

  test('a caller-passed backend on a resume with no model is still BAD_MODEL', async () => {
    await seedDuplicate();
    const { view, inst } = await spawnAndDump({ model: 'mine:v1', backend: 'p' });
    await inst.kill({ graceMs: 5 });
    await waitFor(() => !liveForSession(view.sessionId));
    const r = thrown(await callTool('spawn_instance', { project: 'p', resume: view.sessionId, backend: 'p' }));
    assert.equal(r.code, 'BAD_MODEL');
    await settle();
    assert.equal(liveForSession(view.sessionId), null, 'nothing was resumed');
  });

  test('an id on one backend, and a tier bound to a duplicated pair, spawn with no refusal', async () => {
    await seedDuplicate();
    await addCustomModel({ label: 'Solo', model: 'solo:v1', backend: 'p', contextWindow: 99_000 });
    const solo = await spawnAndDump({ model: 'solo:v1' });
    assert.equal(solo.inst.backend, 'p');
    assert.deepEqual(solo.argv.slice(0, 4), ['claude', '--model', 'solo:v1', '--']);
    await setTierBackend('powerful', { backend: 'p', model: 'mine:v1' });
    const tier = await spawnAndDump({ model: 'powerful' });
    assert.equal(tier.inst.backend, 'p');
    assert.equal(tier.inst.model, 'mine:v1');
  });

  test('a bare resume of a session on a duplicated pair lands on its recorded backend', async () => {
    await seedDuplicate();
    const { view, inst } = await spawnAndDump({ model: 'mine:v1', backend: 'p' });
    const sid = view.sessionId;
    await settledSessionBackend(sid);
    // The fake engine writes no transcript; seed the resumable jsonl (named by
    // the backing id) so the resume passes hasResumableConversation.
    const dir = path.join(claudeProjectsRoot(), encodeCwd(path.join(projectsRoot, 'p')));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${inst.backingSessionId}.jsonl`),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, sessionId: inst.backingSessionId }) + '\n');
    await inst.kill({ graceMs: 5 });
    await waitFor(() => !liveForSession(sid));

    const resumed = meta(await callTool('spawn_instance', { project: 'p', resume: sid }));
    assert.notEqual(resumed.ok, false, JSON.stringify(resumed));
    assert.equal(resumed.backend, 'p');
    assert.equal(resumed.model, 'mine:v1');
    assert.equal(resumed.contextWindowTokens, 222_000);
  });
});
