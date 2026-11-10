// cc.<ns>.import(name?) inside run_code: a router over a stub plugin host and stub
// sessions, the child process and the plugin module files real.

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
const sessions = {};

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
const serve = async (id, source, opts = {}) => {
  modules.set(id, { kind: 'ok', path: await writeModule(id, source, opts), hasBackend: opts.hasBackend ?? false });
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
  const router = buildMcpRouter({
    instances: {
      liveCallerForPublicId: (id) => (id in sessions ? id : null),
      liveForSession: (id) => sessions[id] ?? null,
    },
    pluginHost: {
      init: async () => {},
      toolsFor: () => [{
        name: 'modplug__ping', description: 'Ping.', inputSchema: { type: 'object' }, audience: 'all',
        outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },
        handler: async () => ({ pong: true }),
      }],
      runCodeModule: async (id) => { lookups.push(id); return modules.get(id) ?? { kind: 'unknown' }; },
    },
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
const value = (body) => { assert.equal(body.error, undefined, JSON.stringify(body)); return JSON.parse(body.result); };

test('lazy: a module no program imports is never looked up or evaluated', async () => {
  const marker = path.join(plug, 'lazy-ran');
  await serve('lazy', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'x'); export default () => ({});`);
  lookups.length = 0;
  assert.equal(value(await run('return 1')), 1);
  assert.deepEqual(lookups, []);
  await assert.rejects(fs.access(marker), 'the module body never ran');
});

test('the factory gets pluginId, baseUrl (proxy form or null), caller and a working cc; its value is what import resolves to', async () => {
  await serve('ctxplug', `export default async (ctx) => ({
    pluginId: ctx.pluginId, baseUrl: ctx.baseUrl, caller: ctx.caller,
    viaCc: await ctx.cc.modplug.ping({}), keys: Object.keys(ctx).sort(),
  });`, { hasBackend: true });
  await serve('nobackend', 'export default (ctx) => ctx.baseUrl;');
  const v = value(await run("return await cc.ctxplug.import()"));
  assert.equal(v.pluginId, 'ctxplug');
  assert.equal(v.baseUrl, `${base}/plugins/ctxplug`);
  assert.deepEqual(v.caller, { sessionId: 'local1', project: 'projA' });
  assert.deepEqual(v.viaCc, { pong: true });
  assert.deepEqual(v.keys, ['baseUrl', 'caller', 'cc', 'module', 'pluginId']);
  assert.equal(value(await run("return await cc.nobackend.import()")), null, 'no backend → baseUrl null');
  assert.deepEqual(value(await runAs('local2', "return (await cc.ctxplug.import()).caller")), { sessionId: 'local2', project: null });
});

test('once per run: two imports give the same object and run the factory once; each run starts fresh', async () => {
  const counter = path.join(plug, 'once-count');
  await serve('once', `import fs from 'node:fs';
    export default () => { fs.appendFileSync(${JSON.stringify(counter)}, 'x'); return { n: 1 }; };`);
  const v = value(await run(`
    const [a, b] = await Promise.all([cc.once.import(), cc.once.import()]);
    const c = await cc.once.import();
    return [a === b, b === c];`));
  assert.deepEqual(v, [true, true]);
  assert.equal(await fs.readFile(counter, 'utf8'), 'x');
  await run("await cc.once.import()");
  assert.equal(await fs.readFile(counter, 'utf8'), 'xx', 'a new run loads the module again');
});

test('a plugin the host does not know is MODULE_UNKNOWN (404)', async () => {
  const v = value(await run("try { await cc.ghost.import(); } catch (e) { return [e.name, e.code, e.status]; }"));
  assert.deepEqual(v, ['ConductorError', 'MODULE_UNKNOWN', 404]);
});

test('MODULE_UNAVAILABLE (409) passes the host\'s reason through', async () => {
  modules.set('off', { kind: 'unavailable', reason: "plugin 'off' is disabled" });
  const v = value(await run("try { await cc.off.import(); } catch (e) { return [e.code, e.status, e.reason]; }"));
  assert.deepEqual(v, ['MODULE_UNAVAILABLE', 409, "plugin 'off' is disabled"]);
});

test('MODULE_LOAD_FAILED (500) for a syntax error, a top-level throw, a non-function default and a rejecting factory', async () => {
  await serve('syn', 'export default (( ;');
  await serve('top', "throw new RangeError('boom at top');");
  await serve('nofn', 'export default 42;');
  await serve('rej', "export default async () => { throw new TypeError('factory said no'); };");
  const v = value(await run(`
    const out = {};
    for (const id of ['syn', 'top', 'nofn', 'rej']) {
      try { await cc[id].import(); out[id] = 'resolved'; }
      catch (e) { out[id] = [e.code, e.status, e.reason, e.cause instanceof Error]; }
    }
    return out;`));
  for (const id of ['syn', 'top', 'nofn', 'rej']) {
    assert.equal(v[id][0], 'MODULE_LOAD_FAILED', id);
    assert.equal(v[id][1], 500, id);
    assert.ok(v[id][2].startsWith(`${id}: `), v[id][2]);
    assert.equal(v[id][3], true, `${id}: cause is the original error`);
  }
  assert.match(v.syn[2], /^syn: SyntaxError: /);
  assert.equal(v.top[2], 'top: RangeError: boom at top');
  assert.match(v.nofn[2], /default export is not a function/);
  assert.equal(v.rej[2], 'rej: TypeError: factory said no');
});

test('a failed load stays failed for the run (the same rejection on a repeat import)', async () => {
  const counter = path.join(plug, 'fail-count');
  await serve('failonce', `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(counter)}, 'x'); throw new Error('once');`);
  const v = value(await run(`
    const r = [];
    for (let i = 0; i < 2; i++) { try { await cc.failonce.import(); } catch (e) { r.push(e.code); } }
    return r;`));
  assert.deepEqual(v, ['MODULE_LOAD_FAILED', 'MODULE_LOAD_FAILED']);
  assert.equal(await fs.readFile(counter, 'utf8'), 'x');
});

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

test('dependency resolution: the module\'s bare import resolves from its plugin checkout, not cc\'s install', async () => {
  // `express` is in cc's own tree too; the plugin's copy must win.
  await serve('deps', "import marker from 'express'; export default () => marker;", {
    files: {
      'node_modules/express/package.json': JSON.stringify({ name: 'express', main: 'index.js' }),
      'node_modules/express/index.js': "module.exports = 'plugin-copy';",
    },
  });
  assert.equal(value(await run("return await cc.deps.import()")), 'plugin-copy');
});

test('plan mode: a module loads and can open a TCP connection, while a file write is denied', async () => {
  const listener = await new Promise(resolve => { const s = net.createServer(sock => sock.end('hi')).listen(0, '127.0.0.1', () => resolve(s)); });
  const target = path.join(plug, 'plan-write');
  try {
    await serve('planmod', `import net from 'node:net'; import fs from 'node:fs';
      export default async () => {
        const net_ok = await new Promise((resolve, reject) => {
          const c = net.connect(${listener.address().port}, '127.0.0.1');
          c.on('data', d => { c.destroy(); resolve(String(d)); }); c.on('error', reject);
        });
        let write;
        try { fs.writeFileSync(${JSON.stringify(target)}, 'x'); write = 'wrote'; } catch (e) { write = e.code; }
        return { net_ok, write };
      };`);
    assert.deepEqual(value(await runAs('plan1', "return await cc.planmod.import()")), { net_ok: 'hi', write: 'ERR_ACCESS_DENIED' });
    await assert.rejects(fs.access(target));
  } finally { await new Promise(resolve => listener.close(resolve)); }
});

test('a remote caller is refused SCRIPT_UNAVAILABLE_REMOTE before anything runs; the host is never asked', async () => {
  lookups.length = 0;
  const body = await runAs('remote1', "return await cc.ctxplug.import()");
  assert.equal(body.code, 'SCRIPT_UNAVAILABLE_REMOTE');
  assert.deepEqual(lookups, []);
});

test('a program\'s own dynamic import resolves bare specifiers from cc\'s install, not the session cwd', async () => {
  // cwd is a bare temp dir with no node_modules, yet `express` loads.
  assert.equal(value(await run("return typeof (await import('express')).default")), 'function');
});

const NAMED = `import fs from 'node:fs';
fs.appendFileSync(process.env.RCM_EVAL_LOG, 'e');
export default async (ctx) => {
  fs.appendFileSync(process.env.RCM_FACTORY_LOG, String(ctx.module) + ',');
  if (ctx.module === 'nope') throw Object.assign(new Error('no module nope'), { code: 'MODULE_UNKNOWN' });
  if (ctx.module === 'bad') throw new Error('bad factory');
  return { module: ctx.module };
};`;

async function serveNamed(id) {
  const evalLog = path.join(plug, `${id}-eval`);
  const factoryLog = path.join(plug, `${id}-factory`);
  process.env.RCM_EVAL_LOG = evalLog;
  process.env.RCM_FACTORY_LOG = factoryLog;
  await serve(id, NAMED);
  return { evalLog, factoryLog };
}
const read = (f) => fs.readFile(f, 'utf8').catch(() => '');

test('ctx.module is null for import() and the name for import(name); each is its own memoized factory call', async () => {
  const { factoryLog } = await serveNamed('named');
  const v = value(await run(`
    const a = await cc.named.import();
    const b = await cc.named.import('shot');
    const b2 = await cc.named.import('shot');
    return [a.module, b.module, b === b2];`));
  assert.deepEqual(v, [null, 'shot', true]);
  assert.equal(await read(factoryLog), 'null,shot,', 'one factory call per (plugin, name)');
});

test('the entry file is evaluated once per run however many names are imported', async () => {
  const { evalLog } = await serveNamed('oneeval');
  value(await run("await cc.oneeval.import(); await cc.oneeval.import('a'); await cc.oneeval.import('b'); return 1"));
  assert.equal(await read(evalLog), 'e');
});

test('computed access cc[ns].import() and cc[\'dash-id\'].import() both reach the module (underscore and dash spellings)', async () => {
  await serve('dash-plug', 'export default (ctx) => ctx.pluginId;');
  const v = value(await run(`
    const ns = 'dash_plug';
    return [await cc[ns].import(), await cc['dash-plug'].import(), await cc.dash_plug.import()];`));
  assert.deepEqual(v, ['dash-plug', 'dash-plug', 'dash-plug']);
});

test('a factory error with code MODULE_UNKNOWN passes through as MODULE_UNKNOWN 404 with its message as reason', async () => {
  await serveNamed('routing');
  const v = value(await run("try { await cc.routing.import('nope'); } catch (e) { return [e.name, e.code, e.status, e.reason]; }"));
  assert.deepEqual(v, ['ConductorError', 'MODULE_UNKNOWN', 404, 'no module nope']);
});

test('a failing name is memoized only for itself: other names of the same plugin still load', async () => {
  const { factoryLog } = await serveNamed('isolate');
  const v = value(await run(`
    const out = [];
    for (const n of ['bad', 'good', 'bad', 'nope', 'good']) {
      try { out.push((await cc.isolate.import(n)).module); } catch (e) { out.push(e.code); }
    }
    return out;`));
  assert.deepEqual(v, ['MODULE_LOAD_FAILED', 'good', 'MODULE_LOAD_FAILED', 'MODULE_UNKNOWN', 'good']);
  assert.equal(await read(factoryLog), 'bad,good,nope,', 'a failed name is not retried, a good one is not re-run');
});

test('a failure evaluating the entry file fails every name, and the file ran once', async () => {
  const marker = path.join(plug, 'evalfail-count');
  await serve('evalfail', `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(marker)}, 'x'); throw new Error('entry broke'); export default () => 1;`);
  const v = value(await run(`
    const out = [];
    for (const n of [undefined, 'a', 'b']) { try { await cc.evalfail.import(n); } catch (e) { out.push([e.code, e.reason]); } }
    return out;`));
  assert.deepEqual(v, [1, 2, 3].map(() => ['MODULE_LOAD_FAILED', 'evalfail: Error: entry broke']));
  assert.equal(await read(marker), 'x');
});

test('import(name) refuses a non-string or empty name with ARGS_INVALID before any lookup', async () => {
  lookups.length = 0;
  const v = value(await run(`
    const out = [];
    for (const n of ['', 5, null, {}, false]) { try { await cc.ctxplug.import(n); out.push('resolved'); } catch (e) { out.push([e.code, e.status]); } }
    return out;`));
  assert.deepEqual(v, [['ARGS_INVALID', 400], ['ARGS_INVALID', 400], ['ARGS_INVALID', 400], ['ARGS_INVALID', 400], ['ARGS_INVALID', 400]]);
  assert.deepEqual(lookups, []);
});

test('top-level cc.import is gone: a program calling it is refused TOOL_UNKNOWN and nothing runs', async () => {
  lookups.length = 0;
  const body = await run("return await cc.import('ctxplug')");
  assert.equal(body.code, 'TOOL_UNKNOWN');
  assert.deepEqual(lookups, []);
});
