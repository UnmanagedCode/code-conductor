// Ollama-backed spawn wiring: a tier bound to a custom backend spawns through
// `ollama launch claude --model <tag> --yes -- <normal claude args>` (asserted
// via the recorded launch argv + env), with the tag riding ONLY on the ollama
// --model slot (never a duplicate claude --model), OLLAMA_HOST threaded for a
// custom host, the durable session-backends sidecar written at spawn, and the
// setModel live-switch gate blocking any Ollama-involved backend-kind change.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { addCustomBackend, setTierBackend } from '../src/appSettings.js';
import { getBackend as getSessionBackend } from '../src/sessionBackends.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, home;

before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

// Spawn an ollama-backed instance (tier bound to a custom backend) and capture
// the launch argv/env the (fake) CLI received.
async function spawnOllama({ label = 'Local', model = 'gemma4:cloud', host = '' } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ollama-spawn-'));
  const argvDump = path.join(tmp, 'argv.txt');
  const envDump = path.join(tmp, 'env.txt');
  process.env.FAKE_CLAUDE_ARGV_DUMP = argvDump;
  process.env.FAKE_CLAUDE_ENV_DUMP = envDump;
  try {
    const rec = await addCustomBackend({ label, model, host });
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    // POST with the custom-backend id as `model` — mirrors what the client's
    // resolveSpawnModel(tier) sends for an ollama-bound tier.
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', model: rec.id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.id;
    await waitFor(() => instances.get(id)?.status === 'idle');
    await waitFor(async () => { try { await fs.stat(argvDump); return true; } catch { return false; } });
    const argv = (await fs.readFile(argvDump, 'utf8')).split('\n').filter(Boolean);
    const envLines = (await fs.readFile(envDump, 'utf8')).split('\n').filter(Boolean);
    const env = Object.fromEntries(envLines.map(l => { const i = l.indexOf('='); return i < 0 ? [l, ''] : [l.slice(0, i), l.slice(i + 1)]; }));
    return { rec, id, inst: instances.get(id), argv, env, summary: r.body };
  } finally {
    delete process.env.FAKE_CLAUDE_ARGV_DUMP;
    delete process.env.FAKE_CLAUDE_ENV_DUMP;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

describe('ollama-backed spawn command/args', () => {
  test('launches via `ollama launch claude --model <tag> --yes --` with no duplicate --model', async () => {
    const { inst, argv, summary } = await spawnOllama({ model: 'gemma4:cloud' });

    // _spawnArgv records the real launch argv, command first.
    assert.equal(inst._spawnArgv[0], 'ollama');

    // The received argv (everything after `command`) begins with the launch
    // prefix, in order, then the normal claude args.
    assert.deepEqual(argv.slice(0, 6), ['launch', 'claude', '--model', 'gemma4:cloud', '--yes', '--']);
    assert.equal(argv[6], '-p');

    // The tag rides ONLY on the ollama --model slot: exactly one --model and
    // one occurrence of the tag; the normal claude arg set carries neither.
    assert.equal(argv.filter(a => a === '--model').length, 1);
    assert.equal(argv.filter(a => a === 'gemma4:cloud').length, 1);
    assert.ok(argv.includes('--session-id')); // real claude flags still forwarded
    assert.ok(argv.includes('--output-format=stream-json'));

    // Summary reflects the backend kind; no Claude model id.
    assert.equal(summary.backendKind, 'ollama');
    assert.equal(summary.ollamaModel, 'gemma4:cloud');
    assert.equal(summary.model, null);
  });

  test('OLLAMA_HOST is set in the spawn env only when a custom host is given', async () => {
    const withHost = await spawnOllama({ label: 'Remote', model: 'gemma4:cloud', host: 'box:11434' });
    assert.equal(withHost.env.OLLAMA_HOST, 'box:11434');
    await instances.shutdown();

    const noHost = await spawnOllama({ label: 'LocalDefault', model: 'gemma4:cloud', host: '' });
    // No custom host → we don't inject OLLAMA_HOST (ollama uses its own default).
    assert.equal(noHost.env.OLLAMA_HOST, undefined);
  });

  test('the backend binding is written to the durable sidecar at spawn', async () => {
    const { summary } = await spawnOllama({ model: 'gemma4:cloud', host: 'box:1' });
    const rec = await getSessionBackend(summary.sessionId);
    assert.deepEqual(rec, { kind: 'ollama', model: 'gemma4:cloud', host: 'box:1' });
  });
});

describe('tier → custom-backend resolution (MCP spawn)', () => {
  let rpcId = 1;
  async function callTool(name, args) {
    const res = await fetch(baseUrl + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await res.json();
    return JSON.parse(body.result.content[0].text); // metadata block
  }

  test('a tier bound to a custom backend resolves the MCP spawn to an Ollama worker', async () => {
    const rec = await addCustomBackend({ label: 'Local', model: 'gemma4:cloud' });
    await setTierBackend('powerful', rec.id);
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawned = await callTool('spawn_instance', { project: 'p', mode: 'bypassPermissions', model: 'powerful' });
    await waitFor(() => instances.idsForSession(spawned.sessionId).length > 0);
    const inst = instances.get(instances.idsForSession(spawned.sessionId)[0]);
    assert.equal(inst.backendKind, 'ollama');
    assert.equal(inst.ollamaModel, 'gemma4:cloud');
    assert.equal(inst.model, null);
  });
});

describe('setModel live-switch gate', () => {
  test('blocks changing model on an Ollama-backed session', async () => {
    const { inst } = await spawnOllama({ model: 'gemma4:cloud' });
    await assert.rejects(() => inst.setModel('claude-opus-4-8'), /Ollama-backed/);
  });

  test('blocks switching a Claude session TO an Ollama backend', async () => {
    const rec = await addCustomBackend({ label: 'Local', model: 'gemma4:cloud' });
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions', model: 'claude-opus-4-8' });
    const inst = instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle');
    await assert.rejects(() => inst.setModel(rec.id), /Ollama-backed/);
  });
});
