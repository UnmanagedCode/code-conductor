// Plugin namespaces and describe_tools inside run_code: a router over stub
// plugin tools and stub sessions (no worker needed), the child process real.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { buildMcpRouter } from '../src/mcp/server.ts';
import { mkdtemp } from './tmpRegistry.mjs';

const CARDS_OUT = { type: 'object', properties: { cards: { type: 'array', items: { type: 'string' } } }, required: ['cards'], additionalProperties: false };

let server, base, cwd;
let pluginTools;
const calls = [];

before(async () => {
  cwd = await mkdtemp('cc-rc-ns-');
  const plug = (name, description, extra = {}) => ({
    name, description, inputSchema: { type: 'object' }, audience: 'all',
    handler: async (args) => { calls.push([name, args]); return { cards: ['a'] }; },
    ...extra,
  });
  pluginTools = [
    plug('code-kanban__list_cards', 'List the cards on a board. Filters by lane.', {
      inputSchema: { type: 'object', properties: { lane: { type: 'string', description: 'Lane name.' } } },
      outputSchema: CARDS_OUT,
    }),
    plug('code-kanban__board_text', 'The board rendered as text.'),
    plug('code-arc__list_games', 'List the games.', { outputSchema: CARDS_OUT }),
    plug('call__ping', 'A plugin whose id is a reserved method name.', { outputSchema: CARDS_OUT }),
    plug('import__ping', 'A plugin whose id is the import method name.', { outputSchema: CARDS_OUT }),
  ];
  const sessions = {
    local1: { mode: 'bypassPermissions', cwd, transcriptPlace: { system: 'local' } },
    remote1: { mode: 'bypassPermissions', cwd, transcriptPlace: { system: 'box' } },
    broken1: { mode: 'bypassPermissions', cwd: path.join(cwd, 'no-such-dir'), transcriptPlace: { system: 'local' } },
  };
  const router = buildMcpRouter({
    instances: {
      liveCallerForPublicId: (id) => (id in sessions ? id : null),
      liveForSession: (id) => sessions[id] ?? null,
    },
    pluginHost: { init: async () => {}, toolsFor: () => pluginTools },
    playbookGate: { check: async ({ args }) => ({ args }) },
  });
  const app = express();
  app.use('/mcp', router);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });

async function runAs(sid, code) {
  const res = await fetch(`${base}/mcp/${sid}/tools/run_code`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  });
  return res.json();
}
const run = (code) => runAs('local1', code);
const describe = async (args) => JSON.parse((await run(`return await cc.describe_tools(${JSON.stringify(args)})`)).result);

test('every spelling of a plugin tool calls it: cc.ns.tool, cc["id"].tool, cc.call', async () => {
  calls.length = 0;
  const body = await run(`
    const a = await cc.code_kanban.list_cards({ lane: 'x' });
    const b = await cc['code-kanban'].list_cards({});
    const c = await cc.call('code-kanban__list_cards', {});
    return [a, b, c];
  `);
  assert.equal(body.error, undefined, JSON.stringify(body));
  assert.deepEqual(JSON.parse(body.result), [{ cards: ['a'] }, { cards: ['a'] }, { cards: ['a'] }]);
  assert.deepEqual(calls, [['code-kanban__list_cards', { lane: 'x' }], ['code-kanban__list_cards', {}], ['code-kanban__list_cards', {}]]);
});

test('a plugin whose id is a reserved method name is reached through cc.call', async () => {
  const body = await run("return await cc.call('call__ping', {})");
  assert.deepEqual(JSON.parse(body.result), { cards: ['a'] });
  const entries = await describe({ namespace: 'call' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].method, "cc.call('call__ping', args)");
});

test('a plugin whose id is `import` is reached through cc.call, and describe_tools renders it so', async () => {
  const body = await run("return await cc.call('import__ping', {})");
  assert.deepEqual(JSON.parse(body.result), { cards: ['a'] });
  const entries = await describe({ namespace: 'import' });
  assert.equal(entries[0].method, "cc.call('import__ping', args)");
});

test('a text-only plugin tool is listed but throws TOOL_UNAVAILABLE_IN_FORMAT (404) when called', async () => {
  const body = await run("try { await cc.code_kanban.board_text({}); } catch (e) { return [e.code, e.status]; }");
  assert.deepEqual(JSON.parse(body.result), ['TOOL_UNAVAILABLE_IN_FORMAT', 404]);
});

test('an unknown tool in a known namespace refuses the program and suggests the namespace\'s tools', async () => {
  calls.length = 0;
  const body = await run('await cc.code_kanban.list_cards({}); await cc.code_kanban.nope();');
  assert.equal(body.code, 'TOOL_UNKNOWN');
  assert.equal(body.unknown[0].path, 'cc.code_kanban.nope');
  assert.ok(body.unknown[0].suggestions.length <= 3);
  const near = await run('await cc.code_kanban.list_card({});');
  assert.deepEqual(near.unknown[0].suggestions, ['cc.code_kanban.list_cards']);
  assert.deepEqual(calls, [], 'nothing ran');
});

test('an unknown namespace refuses the program', async () => {
  const body = await run('await cc.code_kanbn.list_cards({});');
  assert.equal(body.code, 'TOOL_UNKNOWN');
  assert.deepEqual(body.unknown[0].suggestions, ['cc.code_kanban']);
});

test('describe_tools full: a typed tool carries its signature with the declared result type', async () => {
  const [typed, untyped] = await describe({ namespace: 'code_kanban', detail: 'full' }).then(es => [
    es.find(e => e.name === 'code-kanban__list_cards'), es.find(e => e.name === 'code-kanban__board_text'),
  ]);
  assert.equal(typed.method, 'cc.code_kanban.list_cards');
  assert.equal(typed.namespace, 'code_kanban');
  assert.equal(typed.scriptable, true);
  assert.match(typed.signature, /declare function list_cards\(args\?: CodeKanbanListCardsArgs\): Promise<CodeKanbanListCardsResult>;/);
  assert.match(typed.signature, /cards: string\[\];/);
  assert.match(typed.description, /Filters by lane\./);
  assert.equal(untyped.scriptable, false);
  assert.match(untyped.signature, /Promise<unknown>/);
});

test('describe_tools names carries no description or signature; summary carries the first sentence', async () => {
  const names = await describe({ namespace: 'code-kanban', detail: 'names' });
  assert.deepEqual(names.map(e => Object.keys(e).sort()), names.map(() => ['method', 'name', 'namespace', 'scriptable']));
  const summary = await describe({ names: ['code-kanban__list_cards', 'cc.code_arc.list_games'] });
  assert.deepEqual(summary.map(e => [e.method, e.description]), [
    ['cc.code_kanban.list_cards', 'List the cards on a board.'],
    ['cc.code_arc.list_games', 'List the games.'],
  ]);
});

test('describe_tools: namespace accepts either spelling; query needs every word; core tools have a null namespace', async () => {
  assert.equal((await describe({ namespace: 'code-arc' })).length, 1);
  assert.equal((await describe({ namespace: 'code_arc' })).length, 1);
  assert.deepEqual((await describe({ query: 'LIST board' })).map(e => e.name), ['code-kanban__list_cards']);
  assert.deepEqual(await describe({ query: 'zzzz-no-match' }), []);
  const core = (await describe({ names: ['list_projects'] }))[0];
  assert.deepEqual([core.method, core.namespace, core.scriptable], ['cc.list_projects', null, true]);
});

test('describe_tools lists neither itself nor run_code', async () => {
  const all = await describe({ detail: 'names' });
  assert.ok(all.length > 10);
  assert.ok(!all.some(e => e.name === 'describe_tools' || e.name === 'run_code'));
});

test('describe_tools reads the live registry: a tool added between two calls appears in the second', async () => {
  const before = await describe({ namespace: 'late', detail: 'names' });
  assert.deepEqual(before, []);
  pluginTools.push({ name: 'late__added', description: 'Added later.', inputSchema: { type: 'object' }, outputSchema: CARDS_OUT, audience: 'all', handler: async () => ({ cards: [] }) });
  try {
    assert.deepEqual((await describe({ namespace: 'late', detail: 'names' })).map(e => e.method), ['cc.late.added']);
    const body = await run('return await cc.late.added({})');
    assert.deepEqual(JSON.parse(body.result), { cards: [] });
  } finally { pluginTools.pop(); }
});

test('describe_tools is run-scoped: absent from tools/list in both formats and the REST listing; a call without a token is TOOL_UNKNOWN', async () => {
  for (const format of ['json', 'text']) {
    const res = await fetch(`${base}/mcp/local1?format=${format}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.ok(!(await res.json()).result.tools.some(t => t.name === 'describe_tools'), format);
  }
  const listing = await (await fetch(`${base}/mcp/local1/tools`)).json();
  assert.ok(!listing.some(t => t.name === 'describe_tools'));
  const res = await fetch(`${base}/mcp/local1/tools/describe_tools`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'TOOL_UNKNOWN');
});

test('a run token belongs to its session: another session\'s call with it is refused 403', async () => {
  const body = await run('return [process.env.CC_RUN_URL, process.env.CC_RUN_TOKEN]');
  // The run is over, so any token is spent; the cross-session check is on a live one.
  const live = await run(`
    const res = await fetch(process.env.CC_RUN_URL.replace('/local1', '/remote1') + '/tools/list_projects', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-cc-run-token': process.env.CC_RUN_TOKEN }, body: '{}' });
    return [res.status, (await res.json()).code];
  `);
  assert.equal(body.error, undefined);
  assert.deepEqual(JSON.parse(live.result), [403, 'RUN_TOKEN_INVALID']);
});

test('a session on another system is refused SCRIPT_UNAVAILABLE_REMOTE and nothing runs', async () => {
  const marker = path.join(cwd, 'ran.txt');
  const body = await runAs('remote1', `(await import('node:fs')).writeFileSync(${JSON.stringify(marker)}, 'x'); return 1`);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'SCRIPT_UNAVAILABLE_REMOTE');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('a launch that fails reports SpawnError with the message and a null exit code', async () => {
  const body = await runAs('broken1', 'return 1');
  assert.equal(body.error.name, 'SpawnError');
  assert.match(body.error.message, /ENOENT/);
  assert.equal(body.exitCode, null);
  assert.equal(body.result, null);
});
