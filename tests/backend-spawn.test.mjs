// Spawn on a SUBSTITUTION backend: the uniform `{TEMPLATE} {CLAUDE_ARGS}` builder
// (the backend's template + the SAME claude args, so `--model <id>` appears twice
// — confirmed harmless), the backend's env injection, the sid→{backend,model}
// sidecar written at spawn + the tagged model recovered on resume (over the CLI's
// bare jsonl report), the setModel live-switch gate, tier/role→{backend,model} MCP
// resolution, the launch_failed crash signal, and the null-model guards.
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
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { addCustomModel, setTierBackend, setRoleBinding, addCustomRole, addBackend,
  setPluginRolesProvider, getTierBackend, getDefaultSpawnTier } from '../src/appSettings.js';
import { hasSessionBackend, getSessionBackend, markSessionBackend } from '../src/sessionBackends.js';
import { claudeProjectsRoot, encodeCwd } from '../src/projects.js';

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

  test('the backend id + tagged model is written to the sidecar at spawn', async () => {
    const { summary } = await spawnOnBackend({ model: 'gemma4:cloud' });
    assert.equal(await hasSessionBackend(summary.sessionId), true);
    assert.deepEqual(await getSessionBackend(summary.sessionId), { backend: 'ollama', model: 'gemma4:cloud' });
  });

  // The generalization under test: a USER-DEFINED row drives the launch from its
  // own template, gets its own env injected, and records its own id in the sidecar.
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
    assert.deepEqual(await getSessionBackend(summary.sessionId), { backend: 'my-proxy', model: 'mine:v2' });
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
    // Bind reviewer directly to a curated cloud model on the ollama row,
    // exercising resolveRoleBackend's non-tier branch.
    await setRoleBinding('reviewer', { backend: 'ollama', model: 'deepseek-v4-flash:cloud' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawned = await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'reviewer' });
    await waitFor(() => instances.idsForSession(spawned.sessionId).length > 0);
    const inst = instances.get(instances.idsForSession(spawned.sessionId)[0]);
    assert.equal(inst.backend, 'ollama');
    assert.equal(inst.model, 'deepseek-v4-flash:cloud');
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

  // Plugin-owned roles are injected via the same provider server.js wires to
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
    await markSessionBackend(sid, 'ollama'); // sidecar says which backend, model unknown
    await assert.rejects(
      () => instances.create({ project: 'p', resume: sid }),
      /no resolvable model|BACKEND_MODEL_MISSING/,
    );
  });
});

// ── launch_failed crash signal ───────────────────────────────────────────────
// A controllable launcher whose child stays alive until the test triggers a
// spontaneous crash() (nonzero exit + stderr) or Instance.kill() (signalled
// exit). Mirrors FakeChildProcess's drain-then-exit so stderr is fully read by
// the parent readline before 'exit' fires.
class ControllableLauncher {
  constructor() { this.children = []; }
  launch() {
    const child = new EventEmitter();
    child.pid = null;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child._exited = false;
    const finish = (code, signal) => {
      if (child._exited) return; child._exited = true;
      let pending = 2;
      const done = () => { if (--pending === 0) setImmediate(() => child.emit('exit', code, signal)); };
      child.stdout.once('end', done);
      child.stderr.once('end', done);
      child.stdout.end();
      child.stderr.end();
    };
    child.crash = (msg) => { child.stderr.write(msg + '\n'); finish(1, null); };
    child.kill = () => { finish(null, 'SIGTERM'); return true; };
    this.children.push(child);
    return child;
  }
  get last() { return this.children[this.children.length - 1]; }
}

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
      await markSessionBackend(sid, 'ollama', 'deepseek-v4-flash:cloud');

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
