// Plugin-provided run_code members (`cc.<ns>.<name>(args)`): a router over a
// stub plugin host and stub sessions, the child process and the plugin module
// files real.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import express from 'express';
import { buildMcpRouter } from '../src/mcp/server.ts';
import { mkdtemp } from './tmpRegistry.mjs';

let server, base, cwd, plug;
const lookups = [];
// id → what the stub host answers for runCodeModule(id)
const modules = new Map();
// id → the declared members runCodeMembers() lists
const catalog = new Map();
const sessions = {};

const PING_OUT = { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false };
const memberDecl = (name, over = {}) => ({
  name, description: `Does ${name}. More detail.`, inputSchema: { type: 'object', properties: {} }, ...over,
});

async function writeModule(name, source, { files = {} } = {}) {
  const dir = path.join(plug, name);
  await fs.mkdir(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  }
  const file = path.join(dir, 'index.mjs');
  await fs.writeFile(file, source);
  return file;
}
// `members`: declared member names (or full declarations); the host's lookup and catalog both carry them.
const serve = async (id, source, { members = ['m'], hasBackend = false, ...opts } = {}) => {
  const decls = members.map(m => typeof m === 'string' ? memberDecl(m) : m);
  catalog.set(id, decls);
  modules.set(id, {
    kind: 'ok', path: await writeModule(id, source, opts), hasBackend,
    members: decls.map(({ name, inputSchema }) => ({ name, inputSchema })),
  });
};

before(async () => {
  cwd = await mkdtemp('cc-rc-mod-');
  plug = await mkdtemp('cc-rc-plug-');
  Object.assign(sessions, {
    local1: { mode: 'bypassPermissions', cwd, project: 'projA', transcriptPlace: { system: 'local' } },
    local2: { mode: 'bypassPermissions', cwd, project: null, transcriptPlace: { system: 'local' } },
    plan1: { mode: 'plan', cwd, project: 'projA', transcriptPlace: { system: 'local' } },
    remote1: { mode: 'bypassPermissions', cwd, project: 'projA', transcriptPlace: { system: 'box' } },
  });
  const tool = (name, inputSchema, outputSchema, description = 'Ping.') => ({
    name, description, inputSchema, audience: 'all', outputSchema, handler: async () => ({ pong: true }),
  });
  const SHARED_IN = { type: 'object', properties: { q: { type: 'string', description: 'the query' }, n: { type: 'integer' } }, required: ['q'] };
  const SHARED_OUT = { type: 'object', properties: { hits: { type: 'array', items: { type: 'string' } } }, required: ['hits'] };
  const router = buildMcpRouter({
    instances: {
      liveCallerForPublicId: (id) => (id in sessions ? id : null),
      liveForSession: (id) => sessions[id] ?? null,
    },
    pluginHost: {
      init: async () => {},
      toolsFor: () => [
        tool('modplug__ping', { type: 'object' }, PING_OUT),
        tool('twina__find', SHARED_IN, SHARED_OUT, 'Find things. Longer text.'),
      ],
      runCodeModule: async (id) => { lookups.push(id); return modules.get(id) ?? { kind: 'unknown', reason: `no plugin '${id}' provides run_code members` }; },
      runCodeMembers: () => [...catalog].map(([id, members]) => ({ id, members })),
    },
    playbookGate: { check: async ({ args }) => ({ args }) },
  });
  const app = express();
  app.use('/mcp', router);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  // The shared-schema member: same input/output schemas as the twina__find tool.
  await serve('twinb', 'export default () => ({ find: async () => ({ hits: [] }) });', {
    members: [{ name: 'find', description: 'Find things. Longer text.', inputSchema: SHARED_IN, outputSchema: SHARED_OUT }],
  });
  await serve('modplug', 'export default () => ({ grab: async () => 1 });', { members: ['grab'] });
});
after(async () => { await new Promise(resolve => server.close(resolve)); });

async function runAs(sid, code) {
  const res = await fetch(`${base}/mcp/${sid}/tools/run_code`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  });
  return res.json();
}
const run = (code) => runAs('local1', code);
const value = (body) => { assert.equal(body.error, undefined, JSON.stringify(body)); return JSON.parse(body.result); };
const read = (f) => fs.readFile(f, 'utf8').catch(() => '');
const refusals = [];

// PINS: laziness — a program that only calls the plugin's tool triggers no lookup and no module evaluation.
test('lazy: a program calling only the plugin\'s tool never looks up or evaluates the module', async () => {
  const marker = path.join(plug, 'lazy-ran');
  await serve('modplug', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'x'); export default () => ({ grab: async () => 1 });`, { members: ['grab'] });
  lookups.length = 0;
  assert.deepEqual(value(await run('return await cc.modplug.ping({})')), { pong: true });
  assert.deepEqual(lookups, []);
  await assert.rejects(fs.access(marker), 'the module body never ran');
});

// PINS: factory ctx has exactly pluginId/baseUrl/caller/cc (baseUrl proxy form or null), `this` is the factory's object, cc works.
test('the factory gets pluginId, baseUrl (proxy form or null), caller and a working cc; the member runs with this = the factory\'s object', async () => {
  await serve('ctxplug', `export default (ctx) => ({
    tag: 'obj',
    async m() {
      return { pluginId: ctx.pluginId, baseUrl: ctx.baseUrl, caller: ctx.caller, keys: Object.keys(ctx).sort(),
        viaCc: await ctx.cc.modplug.ping({}), self: this.tag };
    },
  });`, { hasBackend: true });
  await serve('nobackend', 'export default (ctx) => ({ m: async () => ctx.baseUrl });');
  const v = value(await run('return await cc.ctxplug.m({})'));
  assert.equal(v.pluginId, 'ctxplug');
  assert.equal(v.baseUrl, `${base}/plugins/ctxplug`);
  assert.deepEqual(v.caller, { sessionId: 'local1', project: 'projA' });
  assert.deepEqual(v.viaCc, { pong: true });
  assert.deepEqual(v.keys, ['baseUrl', 'caller', 'cc', 'pluginId']);
  assert.equal(v.self, 'obj');
  assert.equal(value(await run('return await cc.nobackend.m({})')), null, 'no backend → baseUrl null');
  assert.deepEqual(value(await runAs('local2', 'return (await cc.ctxplug.m({})).caller')), { sessionId: 'local2', project: null });
});

// PINS: lookup and factory run once per run per namespace even across two members, and again in a fresh run.
test('once per run per namespace: two members share one lookup and one factory call; each run starts fresh', async () => {
  const counter = path.join(plug, 'once-count');
  await serve('once', `import fs from 'node:fs';
    export default () => { fs.appendFileSync(${JSON.stringify(counter)}, 'x'); return { a: async () => 1, b: async () => 2 }; };`, { members: ['a', 'b'] });
  lookups.length = 0;
  assert.deepEqual(value(await run('return await Promise.all([cc.once.a({}), cc.once.b({}), cc.once.a({})])')), [1, 2, 1]);
  assert.equal(await read(counter), 'x');
  assert.deepEqual(lookups, ['once']);
  await run('await cc.once.a({})');
  assert.equal(await read(counter), 'xx', 'a new run loads the module again');
});

// PINS: on one namespace a member and a tool each reach their own implementation; cc.call of the wire name equals the dotted member.
test('a member and a tool on one namespace each reach their own; cc.call(<id>__m) equals cc.ns.m()', async () => {
  const v = value(await run(`return [await cc.modplug.ping({}), await cc.modplug.grab({}), await cc.call('modplug__grab', {}), await cc.call('modplug__ping', {})]`));
  assert.deepEqual(v, [{ pong: true }, 1, 1, { pong: true }]);
});

// PINS: args are validated against the member's inputSchema BEFORE the module evaluates (ARGS_INVALID 400); good args pass.
test('args are checked against inputSchema before the module loads: ARGS_INVALID 400, module body never evaluated', async () => {
  const marker = path.join(plug, 'args-eval');
  await serve('argsplug', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'x'); export default () => ({ m: async (a) => a });`, {
    members: [memberDecl('m', { inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } })],
  });
  const v = value(await run(`
    const out = [];
    for (const args of [{}, { name: 5 }, { name: 'a', extra: 1 }]) {
      try { await cc.argsplug.m(args); out.push('ok'); } catch (e) { out.push([e.code, e.status]); }
    }
    return out;`));
  assert.deepEqual(v, [['ARGS_INVALID', 400], ['ARGS_INVALID', 400], ['ARGS_INVALID', 400]]);
  await assert.rejects(fs.access(marker), 'nothing evaluated');
  assert.deepEqual(value(await run("return await cc.argsplug.m({ name: 'a' })")), { name: 'a' });
});

// PINS: the member's own throws/rejections pass through unchanged (code, message, name), not re-wrapped as a load failure.
test('a member\'s own error passes through unchanged', async () => {
  await serve('thrower', `export default () => ({
    m: async () => { throw Object.assign(new RangeError('mine'), { code: 'MY_CODE', status: 418 }); },
    n: async () => { throw new TypeError('plain'); },
  });`, { members: ['m', 'n'] });
  const v = value(await run(`
    const out = [];
    for (const f of [() => cc.thrower.m({}), () => cc.thrower.n({})]) { try { await f(); } catch (e) { out.push([e.name, e.code ?? null, e.message]); } }
    return out;`));
  assert.deepEqual(v, [['RangeError', 'MY_CODE', 'mine'], ['TypeError', null, 'plain']]);
});

// PINS: the host's `unknown` → TOOL_UNKNOWN 404 naming the wire name plus the host reason; a declared name the lookup no longer lists too; `unavailable` → TOOL_UNAVAILABLE 409 with the reason.
test('TOOL_UNKNOWN (404) and TOOL_UNAVAILABLE (409) carry the host reasons', async () => {
  catalog.set('ghost', [memberDecl('m')]);
  modules.set('ghost', { kind: 'unknown', reason: "plugin 'ghost' is disabled" });
  catalog.set('shrunk', [memberDecl('m')]);
  modules.set('shrunk', { kind: 'ok', path: await writeModule('shrunk', 'export default () => ({ m: async () => 1 });'), hasBackend: false, members: [] });
  catalog.set('off', [memberDecl('m')]);
  modules.set('off', { kind: 'unavailable', reason: "plugin 'off' lives on another system" });
  const v = value(await run(`
    const out = {};
    for (const id of ['ghost', 'shrunk', 'off']) { try { await cc[id].m({}); } catch (e) { out[id] = [e.code, e.status, e.reason]; } }
    return out;`));
  assert.deepEqual(v.ghost, ['TOOL_UNKNOWN', 404, "unknown tool: ghost__m — plugin 'ghost' is disabled"]);
  assert.equal(v.shrunk[0], 'TOOL_UNKNOWN');
  assert.equal(v.shrunk[1], 404);
  assert.match(v.shrunk[2], /^unknown tool: shrunk__m/);
  assert.deepEqual(v.off, ['TOOL_UNAVAILABLE', 409, "plugin 'off' lives on another system"]);
  refusals.push(...Object.values(v).map(x => x[2]));
});

// PINS: PLUGIN_LOAD_FAILED (500) for each load failure shape, reason `<id>: <name>: <message>`, cause set.
test('PLUGIN_LOAD_FAILED (500) for a syntax error, top-level throw, non-function default, rejecting factory, non-object result (a function included) and a missing member function', async () => {
  await serve('syn', 'export default (( ;');
  await serve('top', "throw new RangeError('boom at top');");
  await serve('nofn', 'export default 42;');
  await serve('rej', "export default async () => { throw new TypeError('factory said no'); };");
  await serve('nul', 'export default () => null;');
  await serve('nomember', 'export default () => ({ other: () => 1 });');
  await serve('fnres', 'export default () => { const f = () => 1; f.m = async () => 1; return f; };');
  const ids = ['syn', 'top', 'nofn', 'rej', 'nul', 'nomember', 'fnres'];
  const v = value(await run(`
    const out = {};
    for (const id of ${JSON.stringify(ids)}) {
      try { await cc[id].m({}); out[id] = 'resolved'; }
      catch (e) { out[id] = [e.code, e.status, e.reason, e.cause instanceof Error]; }
    }
    return out;`));
  for (const id of ids) {
    assert.equal(v[id][0], 'PLUGIN_LOAD_FAILED', id);
    assert.equal(v[id][1], 500, id);
    assert.ok(v[id][2].startsWith(`${id}: `), v[id][2]);
    assert.equal(v[id][3], true, `${id}: cause is an Error`);
    refusals.push(v[id][2]);
  }
  assert.match(v.syn[2], /^syn: SyntaxError: /);
  assert.equal(v.top[2], 'top: RangeError: boom at top');
  assert.match(v.nofn[2], /default export is not a function/);
  assert.equal(v.rej[2], 'rej: TypeError: factory said no');
});

// PINS: a load failure is memoized per namespace — it fails every member of the namespace for the run and the file is evaluated once.
test('a load failure fails every member of the namespace for the run; the file ran once', async () => {
  const counter = path.join(plug, 'fail-count');
  await serve('failonce', `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(counter)}, 'x'); throw new Error('once');`, { members: ['a', 'b'] });
  const v = value(await run(`
    const r = [];
    for (const f of [() => cc.failonce.a({}), () => cc.failonce.b({}), () => cc.failonce.a({})]) { try { await f(); } catch (e) { r.push(e.code); } }
    return r;`));
  assert.deepEqual(v, ['PLUGIN_LOAD_FAILED', 'PLUGIN_LOAD_FAILED', 'PLUGIN_LOAD_FAILED']);
  assert.equal(await read(counter), 'x');
});

// PINS: the lookup route is token-gated per session (RUN_TOKEN_INVALID 403) and the host is not consulted on refusal.
test('GET run-modules refuses a call with no token, and another session\'s token, as RUN_TOKEN_INVALID (403)', async () => {
  const bare = await fetch(`${base}/mcp/local1/run-modules/ctxplug`);
  assert.equal(bare.status, 403);
  assert.equal((await bare.json()).code, 'RUN_TOKEN_INVALID');
  lookups.length = 0;
  const v = value(await runAs('local1', `
    const url = process.env.CC_RUN_URL.replace('/local1', '/local2') + '/run-modules/ctxplug';
    const res = await fetch(url, { headers: { 'x-cc-run-token': process.env.CC_RUN_TOKEN } });
    return [res.status, (await res.json()).code];`));
  assert.deepEqual(v, [403, 'RUN_TOKEN_INVALID']);
  assert.deepEqual(lookups, [], 'the host was not consulted');
});

// PINS: the lookup body carries the module path, baseUrl, caller and the members (name + inputSchema).
test('the lookup answers {id, path, baseUrl, caller, members}', async () => {
  const v = value(await run(`
    const res = await fetch(process.env.CC_RUN_URL + '/run-modules/ctxplug', { headers: { 'x-cc-run-token': process.env.CC_RUN_TOKEN } });
    const b = await res.json();
    return [res.status, Object.keys(b).sort(), b.members];`));
  assert.equal(v[0], 200);
  assert.deepEqual(v[1], ['baseUrl', 'caller', 'id', 'members', 'path']);
  assert.deepEqual(v[2], [{ name: 'm', inputSchema: { type: 'object', properties: {} } }]);
});

// PINS: a bare import in the module resolves from the plugin checkout, not cc's install.
test('dependency resolution: the module\'s bare import resolves from its plugin checkout, not cc\'s install', async () => {
  await serve('deps', "import marker from 'express'; export default () => ({ m: async () => marker });", {
    files: {
      'node_modules/express/package.json': JSON.stringify({ name: 'express', main: 'index.js' }),
      'node_modules/express/index.js': "module.exports = 'plugin-copy';",
    },
  });
  assert.equal(value(await run('return await cc.deps.m({})')), 'plugin-copy');
});

// PINS: in a plan-mode session the module loads and may use TCP while file writes are denied.
test('plan mode: a member runs and can open a TCP connection, while a file write is denied', async () => {
  const listener = await new Promise(resolve => { const s = net.createServer(sock => sock.end('hi')).listen(0, '127.0.0.1', () => resolve(s)); });
  const target = path.join(plug, 'plan-write');
  try {
    await serve('planmod', `import net from 'node:net'; import fs from 'node:fs';
      export default () => ({ m: async () => {
        const net_ok = await new Promise((resolve, reject) => {
          const c = net.connect(${listener.address().port}, '127.0.0.1');
          c.on('data', d => { c.destroy(); resolve(String(d)); }); c.on('error', reject);
        });
        let write;
        try { fs.writeFileSync(${JSON.stringify(target)}, 'x'); write = 'wrote'; } catch (e) { write = e.code; }
        return { net_ok, write };
      } });`);
    assert.deepEqual(value(await runAs('plan1', 'return await cc.planmod.m({})')), { net_ok: 'hi', write: 'ERR_ACCESS_DENIED' });
    await assert.rejects(fs.access(target));
  } finally { await new Promise(resolve => listener.close(resolve)); }
});

// PINS: a remote caller is refused before anything runs and the host is never asked.
test('a remote caller is refused SCRIPT_UNAVAILABLE_REMOTE before anything runs; the host is never asked', async () => {
  lookups.length = 0;
  const body = await runAs('remote1', 'return await cc.ctxplug.m({})');
  assert.equal(body.code, 'SCRIPT_UNAVAILABLE_REMOTE');
  assert.deepEqual(lookups, []);
});

// PINS: a program's own dynamic import resolves from cc's install, not the session cwd.
test('a program\'s own dynamic import resolves bare specifiers from cc\'s install, not the session cwd', async () => {
  assert.equal(value(await run("return typeof (await import('express')).default")), 'function');
});

// PINS: computed access (underscore and dash spellings) reaches the member.
test('computed access cc[ns].m() and cc[\'dash-id\'].m() both reach the member', async () => {
  await serve('dash-plug', 'export default (ctx) => ({ m: async () => ctx.pluginId });');
  const v = value(await run(`
    const ns = 'dash_plug';
    return [await cc[ns].m({}), await cc['dash-plug'].m({}), await cc.dash_plug.m({}), await cc.call('dash-plug__m', {})];`));
  assert.deepEqual(v, Array(4).fill('dash-plug'));
});

// PINS: `import` is an ordinary name — refused by the pre-check (nothing runs) unless a plugin declares it, and then callable with {name}.
test('cc.<ns>.import(): TOOL_UNKNOWN from the pre-check unless declared; a declared import member takes {name}', async () => {
  lookups.length = 0;
  const body = await run('return await cc.ctxplug.import({})');
  assert.equal(body.code, 'TOOL_UNKNOWN');
  assert.deepEqual(lookups, []);
  await serve('importer', 'export default () => ({ import: async ({ name }) => `got ${name}` });', {
    members: [memberDecl('import', { inputSchema: { type: 'object', properties: { name: { type: 'string' } } } })],
  });
  assert.equal(value(await run("return await cc.importer.import({ name: 'x' })")), 'got x');
});

// PINS: top-level cc.import stays an unknown core tool.
test('top-level cc.import is refused TOOL_UNKNOWN and nothing runs', async () => {
  lookups.length = 0;
  const body = await run("return await cc.import('ctxplug')");
  assert.equal(body.code, 'TOOL_UNKNOWN');
  assert.deepEqual(lookups, []);
});

const describe = async (args) => value(await run(`return await cc.describe_tools(${JSON.stringify(args)})`));

// PINS: describe_tools lists a member with exactly a tool entry's key set, the wire name, no marker; members come after tools.
test('describe_tools: a member entry has exactly a tool entry\'s keys, name = <id>__<m>, listed after the tools', async () => {
  const all = await describe({ names: ['modplug__ping', 'modplug__grab', 'twina__find', 'twinb__find'], detail: 'full' });
  const tool = all.find(e => e.name === 'twina__find');
  const member = all.find(e => e.name === 'twinb__find');
  assert.deepEqual(Object.keys(member).sort(), Object.keys(tool).sort());
  assert.equal(member.method, 'cc.twinb.find');
  assert.equal(member.namespace, 'twinb');
  assert.equal(member.scriptable, true);
  assert.equal(member.description, 'Find things. Longer text.');
  assert.ok(all.findIndex(e => e.name === 'twinb__find') > all.findIndex(e => e.name === 'modplug__ping'), 'members after the composed tools');
  const summary = (await describe({ namespace: 'twinb' }))[0];
  assert.equal(summary.description, 'Find things.');
});

// PINS: a member's full signature equals what a tool with the same input/output schemas renders (same code path), typed Promise<…>.
test('describe_tools: a member\'s signature equals a tool\'s with the same schemas, and returns Promise<named type>', async () => {
  const norm = (s) => s.replaceAll(/Twin[ab]/g, 'T');
  const [tool] = await describe({ namespace: 'twina', detail: 'full' });
  const [member] = await describe({ namespace: 'twinb', detail: 'full' });
  assert.equal(norm(member.signature), norm(tool.signature));
  assert.match(member.signature, /Promise</);
  assert.match(member.signature, /q: string/);
  assert.doesNotMatch(member.signature, /@returns/);
});

// PINS: without an outputSchema a member renders as a schema-less tool does.
test('describe_tools: a member without outputSchema gets the schema-less signature', async () => {
  const [m] = await describe({ namespace: 'modplug', names: ['modplug__grab'], detail: 'full' });
  assert.match(m.signature, /Promise<unknown>/);
});

// PINS: members are not MCP tools — absent from tools/list and the REST listing; a direct call is TOOL_UNKNOWN with the run_code-only reason (REST and JSON-RPC).
test('members are absent from tools/list and the REST listing; a call from outside a program is TOOL_UNKNOWN with the run_code-only reason', async () => {
  const list = await (await fetch(`${base}/mcp/local1/tools`)).json();
  assert.ok(list.some(t => t.name === 'modplug__ping'));
  assert.ok(!list.some(t => t.name === 'modplug__grab'));
  const rpc = async (method, params) => (await fetch(`${base}/mcp/local1`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })).json();
  assert.ok(!(await rpc('tools/list', {})).result.tools.some(t => t.name === 'modplug__grab'));
  const reason = "'modplug__grab' is callable only from inside a run_code program, as cc.modplug.grab(args)";
  const res = await fetch(`${base}/mcp/local1/tools/modplug__grab`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { ok: false, code: 'TOOL_UNKNOWN', reason });
  assert.ok(JSON.stringify(await rpc('tools/call', { name: 'modplug__grab', arguments: {} })).includes(reason));
  refusals.push(reason);
});

// PINS: no agent-visible text names the mechanism — describe_tools output and every refusal reason above are free of it.
// (Runs last: it reads the refusals the tests above collected.)
test('guard: no agent-visible output or refusal reason mentions the mechanism by name', async () => {
  const everything = JSON.stringify([await describe({ detail: 'summary' }), await describe({ namespace: 'twinb', detail: 'full' }), await describe({ namespace: 'modplug', detail: 'full' })]);
  const word = new RegExp(['mix', 'in'].join(''), 'i');
  assert.doesNotMatch(everything, word);
  assert.ok(refusals.length > 0);
  for (const r of refusals) assert.doesNotMatch(r, word, r);
  const pre = await run('return await cc.ctxplug.import({})');
  assert.doesNotMatch(JSON.stringify(pre), word);
});

// PINS: a memoized lookup failure is rebuilt per call — each member's refusal names its own wire name.
test('a memoized lookup failure names the member being called, not the first one', async () => {
  catalog.set('ghost2', [memberDecl('a'), memberDecl('b')]);
  modules.set('ghost2', { kind: 'unknown', reason: "plugin 'ghost2' is disabled" });
  const v = value(await run(`
    const out = [];
    for (const f of [() => cc.ghost2.a({}), () => cc.ghost2.b({}), () => cc.call('ghost2__b', {})]) { try { await f(); } catch (e) { out.push(e.reason); } }
    return out;`));
  assert.deepEqual(v, [
    "unknown tool: ghost2__a — plugin 'ghost2' is disabled",
    "unknown tool: ghost2__b — plugin 'ghost2' is disabled",
    "unknown tool: ghost2__b — plugin 'ghost2' is disabled",
  ]);
});

// PINS: the run_code-only refusal spells the call as describe_tools does — a reserved plugin id (`call`) is reached through cc.call.
test('the run_code-only refusal uses the describe_tools spelling for a reserved plugin id', async () => {
  catalog.set('call', [memberDecl('m')]);
  try {
    const res = await fetch(`${base}/mcp/local1/tools/call__m`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const body = await res.json();
    assert.equal(body.code, 'TOOL_UNKNOWN');
    assert.equal(body.reason, "'call__m' is callable only from inside a run_code program, as cc.call('call__m', args)");
    const entry = (await describe({ names: ['call__m'] }))[0];
    assert.equal(entry.method, "cc.call('call__m', args)");
  } finally { catalog.delete('call'); }
});

// PINS: a class-instance factory result exposes its prototype methods as members, invoked with this = the instance;
// a declared name the class lacks is PLUGIN_LOAD_FAILED; a prototype method nobody declared stays unreachable.
test('a class instance\'s prototype methods are members (this = the instance); a missing method still fails', async () => {
  await serve('klass', `class Base { async fromBase() { return 'base:' + this.k; } }
    class Api extends Base { constructor(cc) { super(); this.cc = cc; this.k = 'K'; }
      async hello() { return this.k; }
      async secret() { return 'undeclared'; } }
    export default (ctx) => new Api(ctx.cc);`, { members: ['hello', 'fromBase', 'missing'] });
  const v = value(await run(`
    const out = {};
    for (const m of ['hello', 'fromBase', 'missing']) {
      try { out[m] = ['ok', await cc.klass[m]({})]; } catch (e) { out[m] = [e.code, e.reason]; }
    }
    return out;`));
  assert.deepEqual(v.hello, ['ok', 'K']);
  assert.deepEqual(v.fromBase, ['ok', 'base:K'], 'inherited from a user base class, this intact');
  assert.equal(v.missing[0], 'PLUGIN_LOAD_FAILED');
  assert.match(v.missing[1], /^klass: TypeError: .*'missing'/);
  const body = await run('return await cc.klass.secret({})');
  assert.equal(body.code, 'TOOL_UNKNOWN', 'undeclared: refused by the pre-check');
});

// PINS: a null-prototype factory object lacking the declared name fails as PLUGIN_LOAD_FAILED (no chain to walk); one with it resolves.
test('a null-prototype factory object resolves only what it owns', async () => {
  await serve('nullproto', `export default () => Object.assign(Object.create(null), { here: async () => 'h' });`, { members: ['here', 'gone'] });
  const v = value(await run(`
    const out = [];
    for (const m of ['here', 'gone']) { try { out.push(await cc.nullproto[m]({})); } catch (e) { out.push(e.code); } }
    return out;`));
  assert.deepEqual(v, ['h', 'PLUGIN_LOAD_FAILED']);
});
