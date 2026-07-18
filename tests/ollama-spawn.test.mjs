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
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { addCustomBackend, setTierBackend } from '../src/appSettings.js';
import { isOllamaSession, getOllamaSession, markOllamaSession } from '../src/sessionBackends.js';
import { claudeProjectsRoot, encodeCwd } from '../src/projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, home, projectsRoot;

before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
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
