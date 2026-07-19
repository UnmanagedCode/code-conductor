// Ollama-backed spawn: the uniform `{BACKEND_CMD} {CLAUDE_ARGS}` builder
// (`ollama launch claude --model <tag> --yes --` + the SAME claude args, so
// `--model <tag>` appears twice — confirmed harmless), no OLLAMA_HOST, the
// sid→model sidecar written at spawn + the tagged model recovered on resume
// (over the CLI's bare jsonl report), the setModel live-switch gate,
// tier→{kind,model} MCP resolution, and the null-model guards (fresh + resume).

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf, fakeOllamaReachable, fakeOllamaUnreachable } from './helpers.mjs';
import { addCustomBackend, setTierBackend } from '../src/appSettings.js';
import { isOllamaSession, getOllamaSession, markOllamaSession } from '../src/sessionBackends.js';
import { claudeProjectsRoot, encodeCwd } from '../src/projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, home, projectsRoot, restoreFetch;

// Spawns/respawns preflight ollama reachability; simulate a live daemon for the
// happy-path suites (the preflight-failure suite below restores real fetch).
before(async () => {
  restoreFetch = fakeOllamaReachable();
  ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); restoreFetch(); });
beforeEach(async () => { ({ home, projectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

// Spawn an ollama-backed instance directly (model + backendKind), capturing the
// launch argv/env the (fake) CLI received.
async function spawnOllama({ model = 'gemma4:cloud' } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ollama-spawn-'));
  const argvDump = path.join(tmp, 'argv.txt');
  const envDump = path.join(tmp, 'env.txt');
  process.env.FAKE_CLAUDE_ARGV_DUMP = argvDump;
  process.env.FAKE_CLAUDE_ENV_DUMP = envDump;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', model, backendKind: 'ollama' });
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

describe('ollama-backed spawn command/args', () => {
  test('`ollama launch claude --model <tag> --yes --` + uniform forwarded --model', async () => {
    const { inst, argv, env, summary } = await spawnOllama({ model: 'gemma4:cloud' });

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

    assert.equal(summary.backendKind, 'ollama');
    assert.equal(summary.model, 'gemma4:cloud'); // model holds the tag for both kinds
    assert.equal(summary.ollamaModel, undefined); // field collapsed away
  });

  test('the ollama backend marker + tagged model is written to the sidecar at spawn', async () => {
    const { summary } = await spawnOllama({ model: 'gemma4:cloud' });
    assert.equal(await isOllamaSession(summary.sessionId), true);
    assert.deepEqual(await getOllamaSession(summary.sessionId), { ollama: true, model: 'gemma4:cloud' });
  });
});

describe('tier → {kind,model} resolution (MCP spawn)', () => {
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

  test('an Ollama-bound tier resolves the MCP spawn to an ollama worker', async () => {
    await addCustomBackend({ label: 'Local', model: 'gemma4:cloud' });
    await setTierBackend('powerful', { kind: 'ollama', model: 'gemma4:cloud' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawned = await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'powerful' });
    await waitFor(() => instances.idsForSession(spawned.sessionId).length > 0);
    const inst = instances.get(instances.idsForSession(spawned.sessionId)[0]);
    assert.equal(inst.backendKind, 'ollama');
    assert.equal(inst.model, 'gemma4:cloud');
  });

  test('a Claude-bound tier resolves to a bare-claude worker', async () => {
    await setTierBackend('fast', { kind: 'claude', model: 'claude-haiku-4-5' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawned = await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'fast' });
    await waitFor(() => instances.idsForSession(spawned.sessionId).length > 0);
    const inst = instances.get(instances.idsForSession(spawned.sessionId)[0]);
    assert.equal(inst.backendKind, 'claude');
    assert.equal(inst.model, 'claude-haiku-4-5');
  });
});

describe('setModel live-switch gate', () => {
  test('blocks changing model on an Ollama-backed session', async () => {
    const { inst } = await spawnOllama();
    await assert.rejects(() => inst.setModel('claude-opus-4-8', 'claude'), /Ollama-backed/);
  });

  test('blocks switching a Claude session TO an Ollama backend', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', model: 'claude-opus-4-8' });
    const inst = instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle');
    await assert.rejects(() => inst.setModel('gemma4:cloud', 'ollama'), /Ollama-backed/);
  });
});

describe('null-model guards', () => {
  test('a fresh ollama spawn with no model is refused', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', backendKind: 'ollama' });
    assert.equal(r.status >= 400, true);
    assert.match(JSON.stringify(r.body), /no resolvable model|OLLAMA_MODEL_MISSING/);
  });

  test('resuming an ollama session whose jsonl has no model is refused (not `--model undefined`)', async () => {
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
    await markOllamaSession(sid); // sidecar says this session is ollama-backed
    await assert.rejects(
      () => instances.create({ project: 'p', resume: sid }),
      /no resolvable model|OLLAMA_MODEL_MISSING/,
    );
  });
});

// ── Reachability preflight at spawn/respawn (Ollama down) ────────────────────
// Installs fakeOllamaUnreachable so localhost:11434 fails deterministically
// (regardless of any daemon on the host), overriding the file-level reachable
// shim for this suite's duration.
describe('ollama reachability preflight (daemon down)', () => {
  let dctx, dbase, dinst, dhome, restoreUnreach;
  before(async () => { restoreUnreach = fakeOllamaUnreachable(); dctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl: dbase, instances: dinst } = dctx); });
  after(async () => { await dctx.close(); restoreUnreach(); });
  beforeEach(async () => { ({ home: dhome } = await freshProjectsRoot()); });
  afterEach(async () => { await dinst.shutdown(); await rmrf(dhome); });

  test('HTTP spawn fails with 503 + reachability message, spawns nothing', async () => {
    await api(dbase, 'POST', '/api/projects', { name: 'p' });
    const before = dinst.list().length;
    const r = await api(dbase, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', model: 'glm-5.2:cloud', backendKind: 'ollama' });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.match(JSON.stringify(r.body), /not reachable|OLLAMA_PREFLIGHT_FAILED/);
    assert.equal(dinst.list().length, before, 'no instance created on preflight failure');
  });

  test('MCP spawn_instance surfaces the reachability prose as an isError result', async () => {
    await api(dbase, 'POST', '/api/projects', { name: 'p' });
    const res = await fetch(dbase + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'spawn_instance', arguments: { project: 'p', mode: 'bypassPermissions', model: 'glm-5.2:cloud' } } }),
    });
    const body = await res.json();
    assert.equal(body.result.isError, true, JSON.stringify(body));
    // content[0] is prose for the LLM — it must contain the actionable reason.
    assert.match(body.result.content[0].text, /Ollama not reachable at/);
  });

  test('respawn of an ollama-backed session fails preflight without wiping history', async () => {
    // Bring an ollama instance up WITH a reachable daemon, then let the daemon
    // "go down" and respawn it — the respawn must reject.
    const restore = fakeOllamaReachable();
    await api(dbase, 'POST', '/api/projects', { name: 'p' });
    const r = await api(dbase, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', model: 'glm-5.2:cloud', backendKind: 'ollama' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.id;
    await waitFor(() => dinst.get(id)?.status === 'idle');
    await dinst.get(id).kill({ graceMs: 10 });
    await waitFor(() => !dinst.get(id)?.proc);
    restore(); // daemon down again
    await assert.rejects(() => dinst.respawn(id), /not reachable|OLLAMA_PREFLIGHT_FAILED/);
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
  let cctx, cbase, cinst, chome, launcher, restore, events;
  before(async () => {
    restore = fakeOllamaReachable(); // preflight passes; we test the post-launch crash
    launcher = new ControllableLauncher();
    cctx = await bootServer({ scenarioPath: SCENARIO, claudeLauncher: launcher });
    ({ baseUrl: cbase, instances: cinst } = cctx);
  });
  after(async () => { await cctx.close(); restore(); });
  beforeEach(async () => { ({ home: chome } = await freshProjectsRoot()); events = []; cinst.on('event', ({ ev }) => events.push(ev)); });
  afterEach(async () => { cinst.removeAllListeners('event'); await cinst.shutdown(); await rmrf(chome); });

  const hasLaunchFailed = () => events.find(e => e.kind === 'system' && e.subtype === 'launch_failed');

  async function spawnAndWaitIdle(model, backendKind) {
    await api(cbase, 'POST', '/api/projects', { name: 'p' });
    const r = await api(cbase, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', model, backendKind });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.id;
    await waitFor(() => cinst.get(id)?.status === 'idle');
    return id;
  }

  test('an ollama subprocess that crashes emits launch_failed with captured stderr', async () => {
    const id = await spawnAndWaitIdle('glm-5.2:cloud', 'ollama');
    launcher.last.crash('Error: cloud model requires auth (401)');
    await waitFor(() => cinst.get(id)?.status === 'crashed');
    const ev = hasLaunchFailed();
    assert.ok(ev, 'launch_failed emitted for ollama crash');
    assert.equal(ev.data.code, 1);
    assert.match(ev.data.stderr, /cloud model requires auth \(401\)/);
  });

  test('a claude subprocess crash emits exit but NOT launch_failed', async () => {
    const id = await spawnAndWaitIdle('claude-opus-4-8', 'claude');
    launcher.last.crash('some claude stderr');
    await waitFor(() => cinst.get(id)?.status === 'crashed');
    assert.ok(events.find(e => e.kind === 'system' && e.subtype === 'exit'), 'exit still emitted');
    assert.equal(hasLaunchFailed(), undefined, 'no launch_failed for claude backend');
  });

  test('a commanded kill of an ollama session does NOT emit launch_failed', async () => {
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
      await markOllamaSession(sid, 'deepseek-v4-flash:cloud');

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
