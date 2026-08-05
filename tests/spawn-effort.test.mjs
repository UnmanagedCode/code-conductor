// Per-tier / per-role DEFAULT EFFORT — the precedence chain in
// `resolveSpawnEffort` (src/appSettings.ts) and its two spawn surfaces.
//
// The chain, which every case below pins one step of:
//   explicit `effort`  →  the spawned-on role  →  the spawned-on tier  →  'high'
//
// Effort and the capability tiers stay distinct vocabularies: a tier says WHICH
// model, an effort says HOW HARD — so these tests always set a tier's effort to
// something other than the global default, or the assertion would pass either way.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf, instForSession } from './helpers.mjs';
import {
  setTierEffort, getTierEffort, setRoleEffort, getRoleEffort,
  inheritedRoleEffort, resolveRoleEffort, resolveSpawnEffort,
  setRoleBinding, addCustomRole, setDefaultSpawnTier, setPluginRolesProvider,
} from '../src/appSettings.ts';
import { DEFAULT_EFFORT, INHERIT_EFFORT, EFFORT_LEVELS } from '../src/effortLevels.ts';
import { DEFAULT_VERSIONS } from '../src/modelVersions.ts';
import { encodeCwd, orchStoreRoot } from '../src/projects.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, home;

before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
// Fresh PROJECTS_ROOT per test: the appSettings cache keys on settingsPath(), so
// every test starts from pristine catalog defaults regardless of run order.
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

let nextRpcId = 1;
async function callTool(name, args) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return JSON.parse(body.result.content[0].text);
}

// ── The resolution point ────────────────────────────────────────────────
describe('resolveSpawnEffort precedence', () => {
  test('an explicit effort beats the tier default', async () => {
    await setTierEffort('fast', 'low');
    // Pins step 1 over step 2: drop the explicit branch and this returns 'low'.
    assert.equal(resolveSpawnEffort({ effort: 'max', tier: 'fast' }), 'max');
  });

  test("the tier's stored default beats the global fallback", async () => {
    await setTierEffort('fast', 'low');
    // Pins step 3: returning DEFAULT_EFFORT here would give 'high'.
    assert.equal(resolveSpawnEffort({ tier: 'fast' }), 'low');
    assert.equal(getTierEffort('fast'), 'low');
  });

  test('a tier with nothing stored resolves to the global default', () => {
    // Pins BOTH the step-4 fallback and that no tier carries a per-tier code
    // default: any {fast:'low', frontier:'max', …} default table fails here.
    for (const tier of ['fast', 'balanced', 'powerful', 'frontier']) {
      assert.equal(resolveSpawnEffort({ tier }), DEFAULT_EFFORT);
      assert.equal(getTierEffort(tier), DEFAULT_EFFORT);
    }
    assert.equal(DEFAULT_EFFORT, 'high', 'the pre-feature hardcoded effort');
  });

  test("a role's default 'inherit' follows the tier it is bound to", async () => {
    await setRoleBinding('conductor', { kind: 'tier', tier: 'frontier' });
    await setTierEffort('frontier', 'max');
    assert.equal(getRoleEffort('conductor'), INHERIT_EFFORT, 'inherit is the role default');
    // Pins the delegation: no inheritance and this is 'high'.
    assert.equal(inheritedRoleEffort('conductor'), 'max');
    assert.equal(resolveRoleEffort('conductor'), 'max');
    assert.equal(resolveSpawnEffort({ role: 'conductor' }), 'max');
  });

  test("an explicit role effort beats its bound tier's effort", async () => {
    await setRoleBinding('conductor', { kind: 'tier', tier: 'frontier' });
    await setTierEffort('frontier', 'max');
    await setRoleEffort('conductor', 'low');
    // Pins the explicit-level branch: always delegating to the tier gives 'max'.
    assert.equal(resolveSpawnEffort({ role: 'conductor' }), 'low');
    // …and the tier itself is untouched, so a tier-spawn still gets 'max'.
    assert.equal(resolveSpawnEffort({ tier: 'frontier' }), 'max');
  });

  test("a role bound to a concrete backend+model inherits the GLOBAL default, not the default spawn tier's", async () => {
    await setDefaultSpawnTier('powerful');
    await setTierEffort('powerful', 'low');
    await setRoleBinding('conductor', { backend: 'claude', model: DEFAULT_VERSIONS.opus });
    // There is no tier to follow. Pins that the fallback is DEFAULT_EFFORT:
    // a getTierEffort(getDefaultSpawnTier()) fallback would give 'low'.
    assert.equal(inheritedRoleEffort('conductor'), DEFAULT_EFFORT);
    assert.equal(resolveSpawnEffort({ role: 'conductor' }), DEFAULT_EFFORT);
  });

  test('an invalid explicit effort throws 400 and never decays to a default', async () => {
    await setTierEffort('fast', 'low');
    assert.throws(() => resolveSpawnEffort({ effort: 'bogus', tier: 'fast' }), (e) => {
      assert.equal(e.statusCode, 400);
      assert.match(e.message, /invalid effort/);
      return true;
    });
    // Same guarantee over REST — the value must never reach `--effort`.
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', effort: 'bogus', tier: 'fast' });
    assert.equal(r.status, 400);
  });

  test('role wins over tier when a caller passes both', async () => {
    await setRoleEffort('conductor', 'max');
    await setTierEffort('fast', 'low');
    // Documents the fixed order (step 2 before step 3).
    assert.equal(resolveSpawnEffort({ role: 'conductor', tier: 'fast' }), 'max');
  });

  test('a role name resolves case-insensitively', async () => {
    await setRoleEffort('conductor', 'max');
    // Mirrors getRoleBinding/isResolvableRole: dropping canonicalization gives 'high'.
    assert.equal(resolveSpawnEffort({ role: 'CONDUCTOR' }), 'max');
    assert.equal(resolveSpawnEffort({ role: 'Conductor' }), 'max');
    assert.equal(getRoleEffort('CoNdUcToR'), 'max');
  });

  test('a custom role inherits through its own tier binding', async () => {
    await addCustomRole({ role: 'Tester' });               // starts on `powerful`
    await setTierEffort('powerful', 'xhigh');
    assert.equal(resolveSpawnEffort({ role: 'Tester' }), 'xhigh');
    await setRoleEffort('tester', 'low');                  // case-insensitive rebind
    assert.equal(resolveSpawnEffort({ role: 'Tester' }), 'low');
  });

  test('an unknown tier/role name falls through instead of refusing', async () => {
    // Deliberate: unlike a missing backend there's no billing hazard, only a level.
    // The default spawn tier is deliberately tuned OFF the global default: an
    // unknown role that skipped the isResolvableRole guard would resolve through
    // defaultRoleBinding → the default spawn tier → 'low', so 'high' here is only
    // reachable by falling all the way through the chain.
    await setDefaultSpawnTier('fast');
    await setTierEffort('fast', 'low');
    assert.equal(resolveSpawnEffort({ role: 'nope' }), DEFAULT_EFFORT);
    assert.equal(resolveSpawnEffort({ tier: 'nope' }), DEFAULT_EFFORT);
    // A name that IS resolvable still goes through the role branch, so the guard
    // isn't just dead weight.
    await setRoleEffort('conductor', 'max');
    assert.equal(resolveSpawnEffort({ role: 'conductor' }), 'max');
  });

  test("a plugin role's effort inherits through its MANIFEST binding", async () => {
    // A plugin role is live-derived and has no DEFAULT_ROLE_BINDING entry, so the
    // inherited level can only come from the EFFECTIVE binding (manifest or user
    // override). Tuned so the manifest tier and the default spawn tier differ:
    // reading the stored binding instead would fall back to powerful → 'low'.
    setPluginRolesProvider(() => [
      { role: 'p/scribe', label: 'Scribe', binding: { kind: 'tier', tier: 'fast' }, plugin: 'p' },
    ]);
    try {
      await setDefaultSpawnTier('powerful');
      await setTierEffort('powerful', 'low');
      await setTierEffort('fast', 'max');
      assert.equal(getRoleEffort('p/scribe'), INHERIT_EFFORT, 'plugin roles start on inherit too');
      assert.equal(inheritedRoleEffort('p/scribe'), 'max', 'follows the MANIFEST-bound tier');
      assert.equal(resolveSpawnEffort({ role: 'p/scribe' }), 'max');

      // A user override of a plugin role's effort persists under its namespaced id
      // and beats the manifest-inherited level (parity with a binding override).
      await setRoleEffort('P/Scribe', 'medium');   // case-insensitive, same key
      assert.equal(getRoleEffort('p/scribe'), 'medium');
      assert.equal(resolveSpawnEffort({ role: 'p/scribe' }), 'medium');
      assert.equal(inheritedRoleEffort('p/scribe'), 'max', 'what it would revert to is unchanged');
    } finally {
      setPluginRolesProvider(null);
    }
  });

  test("a plugin role bound by manifest to a concrete model inherits the global default", async () => {
    setPluginRolesProvider(() => [
      { role: 'p/fixed', label: 'Fixed', binding: { backend: 'claude', model: DEFAULT_VERSIONS.haiku }, plugin: 'p' },
    ]);
    try {
      await setDefaultSpawnTier('powerful');
      await setTierEffort('powerful', 'low');
      assert.equal(resolveSpawnEffort({ role: 'p/fixed' }), DEFAULT_EFFORT, 'no tier to follow');
    } finally {
      setPluginRolesProvider(null);
    }
  });

  test("an INVALID stored level reverts on read and never reaches --effort", async () => {
    // Hand-edited settings.json (the setters would refuse these). Written before any
    // appSettings read in this test so the cache seeds from it. Mirrors the
    // dead-binding revert the bindings already guarantee (see getTierBackend).
    const file = path.join(orchStoreRoot(), 'settings.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({
      models: {
        tierEffort: { fast: 'ultra', frontier: 'max' },
        roleEffort: { conductor: 'ultra' },
        roleBackend: { conductor: { kind: 'tier', tier: 'frontier' } },
      },
    }));

    // Tier: reverts to the global default, NOT passed through.
    assert.equal(getTierEffort('fast'), DEFAULT_EFFORT);
    assert.equal(resolveSpawnEffort({ tier: 'fast' }), DEFAULT_EFFORT);
    // Role: reverts to 'inherit', so it follows its (valid) frontier binding.
    assert.equal(getRoleEffort('conductor'), INHERIT_EFFORT);
    assert.equal(resolveSpawnEffort({ role: 'conductor' }), 'max');
    // A valid neighbour in the same map is untouched — the revert is per key.
    assert.equal(getTierEffort('frontier'), 'max');
  });

  test("an empty-string effort is INVALID, not 'omitted'", async () => {
    await setTierEffort('fast', 'low');
    // Pre-feature this was a 400; an explicit-but-unusable value must never decay
    // into a default (it isn't in EFFORT_LEVELS).
    assert.throws(() => resolveSpawnEffort({ effort: '', tier: 'fast' }), (e) => {
      assert.equal(e.statusCode, 400);
      return true;
    });
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', effort: '', tier: 'fast' });
    assert.equal(r.status, 400, 'POST /api/instances {effort:""} stays a 400');
    // Absent-ness proper still falls through to the tier default.
    assert.equal(resolveSpawnEffort({ effort: undefined, tier: 'fast' }), 'low');
    assert.equal(resolveSpawnEffort({ effort: null, tier: 'fast' }), 'low');
  });

  test("'inherit' is a role-only sentinel — a tier refuses it", async () => {
    await assert.rejects(() => setTierEffort('fast', INHERIT_EFFORT), (e) => {
      assert.equal(e.statusCode, 400);
      return true;
    });
    await assert.rejects(() => setTierEffort('fast', 'bogus'), (e) => (e.statusCode === 400));
    await assert.rejects(() => setTierEffort('nope', 'low'), (e) => (e.statusCode === 400));
    await assert.rejects(() => setRoleEffort('nope', 'low'), (e) => (e.statusCode === 400));
    await assert.rejects(() => setRoleEffort('conductor', 'bogus'), (e) => (e.statusCode === 400));
    assert.equal(getTierEffort('fast'), DEFAULT_EFFORT, 'the refused write persisted nothing');
  });
});

// ── End-to-end through the spawn surfaces ───────────────────────────────
// Each of these pins that the tier/role NAME actually travels from the caller to
// resolveSpawnEffort — a surface that drops it falls back to 'high' and fails.
describe('the resolved effort reaches the spawn', () => {
  // Spawns and returns {inst, argv} — argv is what the (fake) CLI received, so
  // `--effort <level>` is asserted on the real launch args, not just on state.
  async function spawnAndCapture(body) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'spawn-effort-'));
    const argvDump = path.join(tmp, 'argv.txt');
    process.env.FAKE_CLAUDE_ARGV_DUMP = argvDump;
    try {
      const r = await api(baseUrl, 'POST', '/api/instances', body);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const inst = instances.get(r.body.id);
      await waitFor(() => instances.get(r.body.id)?.status === 'idle');
      await waitFor(async () => { try { await fs.stat(argvDump); return true; } catch { return false; } });
      const argv = (await fs.readFile(argvDump, 'utf8')).split('\n').filter(Boolean);
      return { inst, argv };
    } finally {
      delete process.env.FAKE_CLAUDE_ARGV_DUMP;
      await rmrf(tmp);
    }
  }
  const effortArg = (argv) => argv[argv.indexOf('--effort') + 1];

  test("POST /api/instances forwards `tier` → the tier's default effort reaches --effort", async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    await setTierEffort('fast', 'low');
    // The spawn dialog's shape: a resolved model + the tier it came from, no effort.
    const { inst, argv } = await spawnAndCapture({
      project: 'p', mode: 'bypassPermissions', tier: 'fast', model: DEFAULT_VERSIONS.haiku,
    });
    assert.equal(inst.effort, 'low', 'route dropped `tier` if this is high');
    assert.equal(effortArg(argv), 'low');
  });

  test('POST /api/instances honours an explicit effort over the tier default', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    await setTierEffort('fast', 'low');
    const { inst, argv } = await spawnAndCapture({
      project: 'p', mode: 'bypassPermissions', tier: 'fast', effort: 'max',
    });
    assert.equal(inst.effort, 'max');
    assert.equal(effortArg(argv), 'max');
  });

  test("POST /api/instances forwards `role` → the Conduct button's path", async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    await setRoleBinding('conductor', { kind: 'tier', tier: 'frontier' });
    await setTierEffort('frontier', 'max');
    const { inst, argv } = await spawnAndCapture({
      project: 'p', mode: 'bypassPermissions', role: 'conductor', model: DEFAULT_VERSIONS.fable,
    });
    assert.equal(inst.effort, 'max', 'route dropped `role` if this is high');
    assert.equal(effortArg(argv), 'max');
  });

  test("a spawn naming NO tier/role keeps the global default", async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    // Every tier tuned away from the default — a spawn with no tier must ignore them.
    for (const tier of ['fast', 'balanced', 'powerful', 'frontier']) await setTierEffort(tier, 'low');
    const { inst, argv } = await spawnAndCapture({ project: 'p', mode: 'bypassPermissions' });
    assert.equal(inst.effort, DEFAULT_EFFORT);
    assert.equal(effortArg(argv), DEFAULT_EFFORT);
  });

  test("MCP spawn_instance({model:'<tier>'}) applies that tier's default effort", async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    await setTierEffort('fast', 'low');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'spawn-effort-mcp-'));
    const argvDump = path.join(tmp, 'argv.txt');
    process.env.FAKE_CLAUDE_ARGV_DUMP = argvDump;
    try {
      const w = await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'fast' });
      const inst = instForSession(instances, w.sessionId);
      assert.equal(inst.effort, 'low', 'handler dropped the tier name if this is high');
      // Assert the LAUNCH args too, not just tracked state — the MCP surface has
      // its own resolution step, so it gets its own argv proof.
      await waitFor(() => instForSession(instances, w.sessionId)?.status === 'idle');
      await waitFor(async () => { try { await fs.stat(argvDump); return true; } catch { return false; } });
      const argv = (await fs.readFile(argvDump, 'utf8')).split('\n').filter(Boolean);
      assert.equal(argv[argv.indexOf('--effort') + 1], 'low');
    } finally {
      delete process.env.FAKE_CLAUDE_ARGV_DUMP;
      await rmrf(tmp);
    }
  });

  test('MCP spawn_instance honours an explicit effort over the tier default', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    await setTierEffort('fast', 'low');
    const w = await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'fast', effort: 'xhigh' });
    assert.equal(instForSession(instances, w.sessionId).effort, 'xhigh');
  });

  test("MCP spawn_instance({model:'<role>'}) resolves the ROLE's effort, not a tier's", async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    await setRoleBinding('reviewer', { kind: 'tier', tier: 'frontier' });
    await setTierEffort('frontier', 'max');
    await setRoleEffort('reviewer', 'medium');   // an explicit role level…
    const w = await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'reviewer' });
    // …so passing the name as a TIER (frontier → 'max') or dropping it ('high')
    // both fail here: only the role path yields 'medium'.
    assert.equal(instForSession(instances, w.sessionId).effort, 'medium');
  });

  test('MCP spawn_instance with a family alias / raw model id keeps the global default', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    for (const tier of ['fast', 'balanced', 'powerful', 'frontier']) await setTierEffort(tier, 'low');
    const w = await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'opus' });
    assert.equal(instForSession(instances, w.sessionId).effort, DEFAULT_EFFORT,
      'a family alias resolves no tier/role, so no row lends it an effort');
  });

  test('a RESUME keeps the global default (no tier/role to inherit from)', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    for (const tier of ['fast', 'balanced', 'powerful', 'frontier']) await setTierEffort(tier, 'low');
    // Spawn on a tier (effort 'low'), note the session, kill it, then resume it the
    // way the sidebar does: project + resume only.
    const first = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', tier: 'fast' });
    const id = first.body.id;
    await waitFor(() => instances.get(id)?.sessionId && instances.get(id)?.status === 'idle');
    const sid = instances.get(id).sessionId;
    assert.equal(instances.get(id).effort, 'low');

    // The fake CLI doesn't write the jsonl, so seed the one line
    // hasResumableConversation looks for (mirrors tests/model-resume.test.mjs).
    const sessionDir = path.join(process.env.CLAUDE_PROJECTS_ROOT, encodeCwd(path.join(process.env.PROJECTS_ROOT, 'p')));
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.appendFile(path.join(sessionDir, `${sid}.jsonl`),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');

    await api(baseUrl, 'DELETE', `/api/instances/${id}`);

    const again = await api(baseUrl, 'POST', '/api/instances', { project: 'p', resume: sid });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    await waitFor(() => instances.get(again.body.id)?.status === 'idle');
    assert.equal(instances.get(again.body.id).effort, DEFAULT_EFFORT,
      'a resume must not silently acquire a tier default it never named');
  });
});

// ── The vocabulary stays its own ────────────────────────────────────────
test('effort levels and tier names are disjoint vocabularies', () => {
  const tiers = ['fast', 'balanced', 'powerful', 'frontier'];
  for (const level of EFFORT_LEVELS) {
    assert.ok(!tiers.includes(level), `effort level '${level}' collides with a tier name`);
  }
  assert.ok(!EFFORT_LEVELS.includes(INHERIT_EFFORT), 'inherit is a sentinel, not a level');
  assert.ok(EFFORT_LEVELS.includes(DEFAULT_EFFORT));
});
