// Per-tool `audience` for the core MCP tools: the real registry through the real
// router over stub sessions (no plugin host). A worker — any non-`.conduct`
// session, conducted or hand-spawned — is offered only the `all` tools; every
// listing and call channel is asserted per caller kind.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { buildMcpRouter } from '../src/mcp/server.ts';
import { buildTools } from '../src/mcp/tools.ts';
import { TOOL_AUDIENCES } from '../src/mcp/toolAudience.ts';
import { hostPlatform } from '../src/platform/index.ts';
import { mkdtemp } from './tmpRegistry.mjs';

// The reviewed conductor-only set: a tool that spawns, drives, lands or retires a
// session, or mutates the project/workspace registry. A flip must be deliberate.
const CONDUCTOR_ONLY = [
  'spawn_instance', 'send_prompt', 'set_mode', 'approve_plan', 'reject_plan', 'answer_question',
  'set_idle_timeout', 'prune_session', 'interrupt_turn', 'kill_instance',
  'create_worktree', 'delete_worktree', 'sync_worktree', 'merge_worktree',
  'create_workspace', 'delete_workspace', 'rename_workspace', 'set_project_workspace',
  'set_project_remote', 'create_project', 'adopt_project',
].sort();

let server, base;
const gateSaw = [];

before(async () => {
  const cwd = await mkdtemp('cc-core-aud-');
  const live = (project, conducted) => ({ project, conducted, mode: 'bypassPermissions', cwd, transcriptPlace: { system: 'local' } });
  const sessions = {
    cond1: live('.conduct', false),
    lead1: live('.conduct', true),
    work1: live('proj', true),
    hand1: live('proj', false),
  };
  const router = buildMcpRouter({
    instances: {
      liveCallerForPublicId: id => (id in sessions ? id : null),
      liveForSession: id => sessions[id] ?? null,
      anyForSession: id => sessions[id],
    },
    pluginHost: null,
    playbookGate: { check: async ({ toolName, args }) => { gateSaw.push(toolName); return { args }; } },
    capabilities: hostPlatform.capabilities,
  });
  const app = express();
  app.use('/mcp', router);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}/mcp`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });

const at = sid => (sid ? `${base}/${sid}` : base);
let rpcId = 0;
async function rpc(sid, format, method, params) {
  const res = await fetch(`${at(sid)}?format=${format}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return res.json();
}
const listedFull = async (sid, format) => (await rpc(sid, format, 'tools/list', {})).result.tools;
const listed = async (sid, format) => (await listedFull(sid, format)).map(t => t.name);
const restListed = async sid => (await (await fetch(`${at(sid)}/tools`)).json()).map(t => t.name);
async function rest(sid, name, args = {}) {
  const res = await fetch(`${at(sid)}/tools/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.json() };
}
const callRpc = (sid, format, name) => rpc(sid, format, 'tools/call', { name, arguments: {} });
const runCode = async (sid, code) => (await rest(sid, 'run_code', { code })).body;

const served = format => buildTools(format).filter(t => !t.requires || hostPlatform.capabilities[t.requires]);
const conductorOnly = format => served(format).filter(t => t.audience === 'conductor').map(t => t.name).sort();
const allTools = format => served(format).filter(t => t.audience === 'all').map(t => t.name);

// Pins: no core tool lacks a valid audience, in either format (a runtime backstop to the typecheck, against `as` casts).
test('declaration is total: every core tool carries an audience in TOOL_AUDIENCES', () => {
  for (const format of ['text', 'json']) {
    for (const t of buildTools(format)) {
      assert.ok(TOOL_AUDIENCES.includes(t.audience), `${format}: ${t.name} has audience ${String(t.audience)}`);
    }
  }
});

// Pins: the classification is a contract — a silent flip of any tool's audience fails here.
test('the conductor-only set is exactly the reviewed set, and no core tool is worker-only', () => {
  const all = buildTools('text');
  assert.deepEqual(all.filter(t => t.audience === 'conductor').map(t => t.name).sort(), CONDUCTOR_ONLY);
  assert.deepEqual(all.filter(t => t.audience === 'worker'), []);
});

// Pins: a worker's tools/list (both formats) and the REST listing hold no conductor tool and every `all` tool.
test('worker listing: no conductor tool on any listing channel, every `all` tool present', async t => {
  for (const sid of ['work1', 'hand1']) {
    await t.test(sid, async () => {
      for (const format of ['text', 'json']) {
        const names = await listed(sid, format);
        for (const n of conductorOnly(format)) assert.ok(!names.includes(n), `${format} tools/list offers ${n}`);
        for (const n of allTools(format)) assert.ok(names.includes(n), `${format} tools/list lacks ${n}`);
      }
      const rn = await restListed(sid);
      for (const n of conductorOnly('json')) assert.ok(!rn.includes(n), `REST listing offers ${n}`);
      for (const n of allTools('json')) assert.ok(rn.includes(n), `REST listing lacks ${n}`);
    });
  }
});

// Pins: a worker's call to every conductor tool is refused on every channel, before the gate and the handler.
test('worker call: every conductor tool is refused TOOL_UNAVAILABLE_TO_CALLER before the gate', async t => {
  for (const sid of ['work1', 'hand1']) {
    await t.test(sid, async () => {
      const before = gateSaw.length;
      for (const name of conductorOnly('json')) {
        const j = await callRpc(sid, 'json', name);
        assert.equal(j.error?.code, -32602, `${name}: json-rpc`);
        assert.equal(j.error.data.code, 'TOOL_UNAVAILABLE_TO_CALLER', name);
        const x = await callRpc(sid, 'text', name);
        assert.equal(x.result.isError, true, `${name}: text`);
        assert.match(x.result.content[0].text, /conductor-only/, name);
        const r = await rest(sid, name);
        assert.equal(r.status, 403, `${name}: REST`);
        assert.equal(r.body.code, 'TOOL_UNAVAILABLE_TO_CALLER', name);
      }
      assert.equal(gateSaw.length, before, 'the playbook gate was never reached');
    });
  }
});

// Pins: the positive control — the gate stub does see an `all` tool a worker calls, so "gate saw nothing" above is observable.
test('a worker reaches the gate for an `all` tool', async () => {
  const before = gateSaw.length;
  assert.equal((await rest('work1', 'list_workspaces')).status, 200);
  assert.deepEqual(gateSaw.slice(before), ['list_workspaces']);
});

// Pins: run_code is closed statically (literal call), at runtime (computed call) and in its own listing.
test('run_code as a worker: nothing barred is described, literal call refuses, computed call gets the 403', async t => {
  await t.test('describe_tools lists no conductor tool', async () => {
    const body = await runCode('work1', 'return await cc.describe_tools({})');
    const names = JSON.parse(body.result).map(e => e.name);
    for (const n of CONDUCTOR_ONLY) assert.ok(!names.includes(n), `describe_tools lists ${n}`);
    assert.ok(names.includes('list_workspaces'));
  });
  await t.test('the run_code description names no conductor tool in its core methods', async () => {
    const rc = (await listedFull('work1', 'text')).find(x => x.name === 'run_code');
    const methods = rc.description.split('Core methods (cc.<name>): ')[1].replace(/\.$/, '').split(', ');
    assert.ok(!methods.includes('spawn_instance'));
    assert.ok(methods.includes('list_workspaces'));
  });
  await t.test('a literal cc.spawn_instance refuses the whole program', async () => {
    const before = gateSaw.length;
    const body = await runCode('work1', 'return await cc.spawn_instance({})');
    assert.equal(body.code, 'TOOL_UNAVAILABLE_TO_CALLER');
    assert.deepEqual(body.unavailable, ['cc.spawn_instance']);
    assert.deepEqual(gateSaw.slice(before), ['run_code'], 'only run_code itself reached the gate; the program ran nothing');
  });
  await t.test('a computed cc.call gets the 403', async () => {
    const body = await runCode('work1', "try { await cc.call('kill_instance', {}) } catch (e) { return { code: e.code, status: e.status } }");
    assert.deepEqual(JSON.parse(body.result), { code: 'TOOL_UNAVAILABLE_TO_CALLER', status: 403 });
  });
});

// Pins: conductors (top-level and section leads) and anonymous callers keep the full set, offered and callable.
test('conductors and anonymous callers are offered every tool and are never refused for audience', async t => {
  const everything = (await listed(undefined, 'text')).slice().sort();
  assert.deepEqual(everything, served('text').map(x => x.name).sort());
  for (const sid of ['cond1', 'lead1', undefined]) {
    await t.test(sid ?? 'anonymous', async () => {
      for (const format of ['text', 'json']) assert.deepEqual((await listed(sid, format)).slice().sort(), served(format).map(x => x.name).sort());
      assert.deepEqual((await restListed(sid)).slice().sort(), served('json').map(x => x.name).sort());
      for (const name of conductorOnly('json')) {
        const r = await rest(sid, name);
        assert.notEqual(r.status, 403, `${name} refused for ${sid ?? 'anonymous'}`);
        assert.notEqual(r.body.code, 'TOOL_UNAVAILABLE_TO_CALLER', name);
      }
    });
  }
});
