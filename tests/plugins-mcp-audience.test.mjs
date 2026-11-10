// Per-tool `audience` for plugin MCP tools: a manifest through the real
// validator, the real bridge over a recording child, the real router over
// stub sessions. Every path a tool can be reached by is asserted per caller.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { validateManifest } from '../src/plugins/manifest.ts';
import { createMcpBridge } from '../src/plugins/mcpBridge.ts';
import { buildMcpRouter } from '../src/mcp/server.ts';
import { mkdtemp } from './tmpRegistry.mjs';

const OUT = { type: 'object', properties: { ok: { type: 'number' } }, required: ['ok'], additionalProperties: false };
const tool = (name, extra = {}) => ({ name, description: `tool ${name}`, inputSchema: { type: 'object' }, ...extra });
const RAW = {
  id: 'aud', name: 'Audience', version: '1.0.0', pluginApi: 1, backend: { start: 'x' },
  mcp: {
    endpoint: '/m',
    tools: [
      tool('dflt', { outputSchema: OUT }),
      tool('allx', { outputSchema: OUT, audience: 'all' }),
      tool('cond', { outputSchema: OUT, audience: 'conductor' }),
      tool('work', { outputSchema: OUT, audience: 'worker' }),
      tool('condtext', { audience: 'conductor' }),
    ],
  },
};

let child, server, base, cwd;
const seen = [];

before(async () => {
  const validated = validateManifest(RAW);
  assert.equal(validated.errors, undefined, JSON.stringify(validated.errors));

  child = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push(body.tool);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body.format === 'json' ? { structured: { ok: 1 } } : { text: 'ok' }));
    });
  });
  await new Promise(resolve => child.listen(0, '127.0.0.1', resolve));

  cwd = await mkdtemp('cc-aud-');
  const live = (project, conducted) => ({ project, conducted, mode: 'bypassPermissions', cwd, transcriptPlace: { system: 'local' } });
  const sessions = {
    cond1: live('.conduct', false),
    lead1: live('.conduct', true),
    work1: live('proj', true),
    hand1: live('proj', false),
  };
  const bridge = createMcpBridge({
    instances: { anyForSession: id => sessions[id] },
    listMcpPlugins: () => [{ id: 'aud', manifest: validated.manifest }],
    ensureStarted: async () => {},
    portFor: () => child.address().port,
    reportUpstreamFailure: () => {},
  });
  const router = buildMcpRouter({
    instances: {
      liveCallerForPublicId: id => (id in sessions ? id : null),
      liveForSession: id => sessions[id] ?? null,
      anyForSession: id => sessions[id],
    },
    pluginHost: { init: async () => {}, toolsFor: () => bridge.toolsFor() },
    playbookGate: { check: async ({ args }) => ({ args }) },
  });
  const app = express();
  app.use('/mcp', router);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}/mcp`;
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => child.close(resolve));
});

const at = sid => (sid ? `${base}/${sid}` : base);
let rpcId = 0;
async function rpc(sid, format, method, params) {
  const res = await fetch(`${at(sid)}?format=${format}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return res.json();
}
const listed = async (sid, format) => (await rpc(sid, format, 'tools/list', {})).result.tools.map(t => t.name);
const restListed = async sid => (await (await fetch(`${at(sid)}/tools`)).json()).map(t => t.name);
async function rest(sid, name, args = {}) {
  const res = await fetch(`${at(sid)}/tools/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.json() };
}
const callRpc = (sid, format, name) => rpc(sid, format, 'tools/call', { name, arguments: {} });
const runCode = async (sid, code) => (await rest(sid, 'run_code', { code })).body;

const CALLERS = ['cond1', 'lead1', 'work1', 'hand1', undefined];
const label = sid => sid ?? 'anonymous';

// Pins: an omitted audience and `all` offer the tool to every caller kind, on every listing and call path.
test('omitted audience and "all" are offered to, and callable by, every caller', async t => {
  for (const sid of CALLERS) {
    await t.test(label(sid), async () => {
      for (const name of ['aud__dflt', 'aud__allx']) {
        assert.ok((await listed(sid, 'text')).includes(name));
        assert.ok((await listed(sid, 'json')).includes(name));
        assert.ok((await restListed(sid)).includes(name));
        const before = seen.length;
        assert.equal((await rest(sid, name)).status, 200);
        assert.equal(seen.length, before + 1);
      }
    });
  }
});

// Both directions: pins hide + refuse on every channel for the callers an audience excludes, and offer for those it admits.
for (const [tool, admitted] of [['aud__cond', ['cond1', 'lead1']], ['aud__work', ['work1', 'hand1']]]) {
  const side = tool === 'aud__cond' ? 'conductor' : 'worker';
  test(`${side}-only: offered to ${admitted.join('+')}; hidden and refused for the other managed sessions`, async t => {
    for (const sid of ['cond1', 'lead1', 'work1', 'hand1']) {
      if (admitted.includes(sid)) {
        await t.test(`${sid} sees and calls it`, async () => {
          assert.ok((await listed(sid, 'text')).includes(tool));
          assert.ok((await listed(sid, 'json')).includes(tool));
          assert.ok((await restListed(sid)).includes(tool));
          const before = seen.length;
          assert.equal((await rest(sid, tool)).status, 200);
          assert.equal((await callRpc(sid, 'json', tool)).result.isError, undefined);
          assert.equal(seen.length, before + 2);
        });
        continue;
      }
      await t.test(`${sid} does not see it and is refused`, async () => {
        assert.ok(!(await listed(sid, 'text')).includes(tool));
        assert.ok(!(await listed(sid, 'json')).includes(tool));
        assert.ok(!(await restListed(sid)).includes(tool));
        const before = seen.length;
        const j = await callRpc(sid, 'json', tool);
        assert.equal(j.error.code, -32602);
        assert.equal(j.error.data.code, 'TOOL_UNAVAILABLE_TO_CALLER');
        const x = await callRpc(sid, 'text', tool);
        assert.equal(x.result.isError, true);
        assert.match(x.result.content[0].text, new RegExp(`${side}-only`));
        const r = await rest(sid, tool);
        assert.equal(r.status, 403);
        assert.equal(r.body.code, 'TOOL_UNAVAILABLE_TO_CALLER');
        assert.equal(seen.length, before, 'the child was never contacted');
      });
    }
  });
}

// Pins: an anonymous caller is unrestricted — audience steers managed sessions only.
test('an anonymous caller lists and calls both conductor-only and worker-only tools', async () => {
  for (const name of ['aud__cond', 'aud__work']) {
    assert.ok((await listed(undefined, 'json')).includes(name));
    assert.ok((await restListed(undefined)).includes(name));
    assert.equal((await rest(undefined, name)).status, 200);
  }
});

// Pins: the audience refusal wins over the text-only-in-json refusal, in both formats.
test('audience beats format for a text-only conductor tool', async () => {
  const w = await callRpc('work1', 'json', 'aud__condtext');
  assert.equal(w.error.data.code, 'TOOL_UNAVAILABLE_TO_CALLER');
  assert.equal((await callRpc('work1', 'text', 'aud__condtext')).result.isError, true);
  assert.equal((await callRpc('cond1', 'json', 'aud__condtext')).error.data.code, 'TOOL_UNAVAILABLE_IN_FORMAT');
});

// Pins: run_code's listing, pre-check and runtime all honour the caller's audience, and cc.call reports the 403.
test('run_code as a worker: describe_tools omits barred tools; a literal call refuses before anything runs; a computed call gets the 403', async t => {
  await t.test('describe_tools', async () => {
    const body = await runCode('work1', "return await cc.describe_tools({ namespace: 'aud' })");
    const names = JSON.parse(body.result).map(e => e.name).sort();
    assert.deepEqual(names, ['aud__allx', 'aud__dflt', 'aud__work']);
  });
  await t.test('literal barred call refuses the program', async () => {
    const before = seen.length;
    const body = await runCode('work1', 'return await cc.aud.cond({})');
    assert.equal(body.code, 'TOOL_UNAVAILABLE_TO_CALLER');
    assert.deepEqual(body.unavailable, ['cc.aud.cond']);
    assert.equal(seen.length, before, 'nothing ran');
  });
  await t.test('an unknown tool is still TOOL_UNKNOWN', async () => {
    assert.equal((await runCode('work1', 'return await cc.aud.nope({})')).code, 'TOOL_UNKNOWN');
  });
  await t.test('computed call', async () => {
    const body = await runCode('work1', "try { await cc.call('aud__cond', {}) } catch (e) { return { code: e.code, status: e.status } }");
    assert.deepEqual(JSON.parse(body.result), { code: 'TOOL_UNAVAILABLE_TO_CALLER', status: 403 });
  });
  await t.test('a conductor calls it', async () => {
    const body = await runCode('cond1', 'return await cc.aud.cond({})');
    assert.equal(body.error, undefined, JSON.stringify(body));
    assert.deepEqual(JSON.parse(body.result), { ok: 1 });
  });
});
