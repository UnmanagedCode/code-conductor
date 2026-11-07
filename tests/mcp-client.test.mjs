// The generated /mcp clients against a live server: boot writes them from the
// registry it serves (the test helper and the real start() alike, a stale file
// overwritten), and a script importing each from $CONDUCTOR_MCP_CLIENT_DIR gets
// a success back as its result, a tool refusal and a protocol fault raised as
// ConductorError, and an ok:true measurement that reads like a failure returned
// rather than raised.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { start } from '../server.ts';
import * as projects from '../src/projects.ts';
import * as tools from '../src/mcp/tools.ts';
import { hostPlatform } from '../src/platform/index.ts';
import { renderPythonClient } from '../src/mcp/client/python.ts';
import { renderNodeClient } from '../src/mcp/client/node.ts';
import { MCP_CLIENT_FILES } from '../src/mcp/client/files.ts';
import { settleSessionWrites } from '../src/sessionStore.ts';
import { bootServer, api, registerLocalProject } from './helpers.mjs';
import { git } from './remoteSystem.mjs';
import { ensureSafeStoreEnv } from './safeStoreRoot.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { rmrf } from './rmrf.mjs';

const SAFE = ensureSafeStoreEnv();
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'mcp-client');

function run(cmd, args, env) {
  return new Promise(resolve => {
    execFile(cmd, args, { env: { ...process.env, ...env }, timeout: 30000 }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

async function python311() {
  const r = await run('python3', ['-c', 'import sys;print(sys.version_info>=(3,11))']);
  return !r.err && r.stdout.trim() === 'True';
}

// Each file under mcpClientDir() holds exactly the render of the registry the
// host serves, and no temp file is left beside them.
async function assertWritten() {
  const caps = tools.capableTools('json', hostPlatform.capabilities);
  const dir = projects.mcpClientDir();
  assert.equal(await fs.readFile(path.join(dir, MCP_CLIENT_FILES.python), 'utf8'), renderPythonClient(caps));
  assert.equal(await fs.readFile(path.join(dir, MCP_CLIENT_FILES.node), 'utf8'), renderNodeClient(caps));
  assert.deepEqual((await fs.readdir(dir)).sort(), Object.values(MCP_CLIENT_FILES).sort());
}

test('bootServer writes both clients into the store, from the registry it serves', async () => {
  const srv = await bootServer({});
  try {
    assert.equal(projects.mcpClientDir(), path.join(srv.projectsRoot, projects.ORCH_STORE_DIRNAME, projects.MCP_CLIENT_DIRNAME));
    await assertWritten();
  } finally { await srv.close(); }
});

// The real start() on a throwaway store and HOME: `plant` runs with the env in
// place, before boot; the booted server is always torn down.
async function withRealStart(plant, check) {
  const home = await mkdtemp('cc-mcp-client-boot-');
  const env = {
    HOME: home,
    PROJECTS_ROOT: path.join(home, 'projects'),
    CLAUDE_PROJECTS_ROOT: path.join(home, 'claude', 'projects'),
    CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
    CLAUDE_BIN: `${process.execPath} -e 0`,
    ANTHROPIC_API_KEY: 'mcp-client-fake-key',
  };
  const prev = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  let booted;
  try {
    await fs.mkdir(env.CLAUDE_PROJECTS_ROOT, { recursive: true });
    await plant();
    await check(async (opts) => { booted = await start({ host: '127.0.0.1', buildWeb: false, ...opts }); return booted; });
  } finally {
    if (booted) {
      const { server, instances, wss, pluginHost } = booted;
      if (instances) await instances.shutdown();
      if (pluginHost) await pluginHost.stopAll();
      wss.close();
      server.closeAllConnections?.();
      await new Promise(r => server.close(r));
      await settleSessionWrites();
      booted.rootLock.releaseSync();
    }
    for (const [k, v] of Object.entries(prev)) {
      if (v !== undefined) process.env[k] = v;
      else if (k === 'PROJECTS_ROOT') process.env[k] = SAFE.projectsRoot;
      else if (k === 'CLAUDE_PROJECTS_ROOT') process.env[k] = SAFE.claudeProjectsRoot;
      else delete process.env[k];
    }
    await rmrf(home);
  }
}

test('the real start() writes both clients before it resolves, overwriting a stale one', async () => {
  const stale = () => path.join(projects.mcpClientDir(), MCP_CLIENT_FILES.python);
  await withRealStart(async () => {
    await fs.mkdir(path.dirname(stale()), { recursive: true });
    await fs.writeFile(stale(), '# stale\n');
  }, async (boot) => {
    await boot({ port: 0 });
    await assertWritten();
  });
});

// A port nothing is bound to right now.
async function freePort() {
  const srv = net.createServer();
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise(r => srv.close(r));
  return port;
}

test('a client write that fails fails the real start(), which never listens', async () => {
  // The client directory's path is taken by a regular file, so its mkdir fails.
  await withRealStart(async () => {
    await fs.mkdir(path.dirname(projects.mcpClientDir()), { recursive: true });
    await fs.writeFile(projects.mcpClientDir(), 'not a directory\n');
  }, async (boot) => {
    const port = await freePort();
    await assert.rejects(boot({ port }), e => ['EEXIST', 'ENOTDIR'].includes(e.code) && String(e.path ?? e.message).includes(projects.MCP_CLIENT_DIRNAME));
    const refused = await new Promise(resolve => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(false); });
      sock.once('error', e => resolve(e.code === 'ECONNREFUSED'));
    });
    assert.ok(refused, `nothing listens on ${port} after the failed boot`);
  });
});

// A registered project with a worktree that is behind its base and dirty, so
// sync_worktree answers ok:true, action:'commit-required'.
async function laggingWorktree(srv, name) {
  const dir = path.join(srv.projectsRoot, name);
  await registerLocalProject(name, dir);
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'test');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(dir, 'README.md'), '# demo\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-q', '-m', 'initial');
  const wt = await api(srv.baseUrl, 'POST', '/mcp/tools/create_worktree', { project: name, name: 'lagging' });
  assert.equal(wt.status, 200, JSON.stringify(wt.body));
  await fs.writeFile(path.join(dir, 'later.txt'), 'later\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-q', '-m', 'later on main');
  await fs.writeFile(path.join(wt.body.worktreePath, 'wip.txt'), 'wip\n');
  return wt.body.worktree;
}

function assertOutcomes(out, workspace) {
  assert.deepEqual(out.success, { returned: { added: true, name: workspace } }, 'a success is returned as the result itself');
  assert.deepEqual(out.refusal, { raised: { code: 'PLAYBOOK_UNKNOWN', status: 200, bodyOk: false } }, "a tool's own refusal raises, at HTTP 200");
  assert.deepEqual(out.unknownTool, { raised: { code: 'TOOL_UNKNOWN', status: 404, bodyOk: false } }, 'a protocol fault raises with its HTTP status');
  assert.deepEqual(out.badArgs, { raised: { code: 'ARGS_INVALID', status: 400, bodyOk: false } });
  assert.equal(out.measured.returned?.ok, true, `an ok:true measurement is returned, not raised: ${JSON.stringify(out.measured)}`);
  assert.equal(out.measured.returned.action, 'commit-required');
  // An omitted optional argument is not sent: list_sessions() succeeds. A
  // None/null one is sent as null: list_sessions's string `project` refuses it.
  assert.ok(Array.isArray(out.listed.returned?.groups), `an all-optional call sends no sentinel: ${JSON.stringify(out.listed)}`);
  assert.deepEqual(out.nullSent, { raised: { code: 'ARGS_INVALID', status: 400, bodyOk: false } }, 'a None/null argument is transmitted as null');
  assert.deepEqual(out.assigned, { returned: { project: 'scripted', workspace } });
  assert.deepEqual(out.cleared, { returned: { project: 'scripted', workspace: null } }, 'workspace=None is transmitted and clears');
  assert.equal(out.readBack, null, 'the project reads back with no workspace');
}

test('a script imports each client from CONDUCTOR_MCP_CLIENT_DIR and gets results, refusals and faults per the raise rule', async (t) => {
  const srv = await bootServer({});
  try {
    const worktree = await laggingWorktree(srv, 'scripted');
    const env = { CONDUCTOR_MCP_URL: `${srv.baseUrl}/mcp`, CONDUCTOR_MCP_CLIENT_DIR: projects.mcpClientDir() };

    const js = await run(process.execPath, [path.join(FIXTURES, 'sample.mjs'), 'node-ws', 'scripted', worktree], env);
    assert.equal(js.err, null, js.stderr);
    assertOutcomes(JSON.parse(js.stdout), 'node-ws');

    if (!(await python311())) { t.diagnostic('python3 >= 3.11 not installed — the Python client was not run'); return; }
    const py = await run('python3', ['-I', '-B', path.join(FIXTURES, 'sample.py'), 'python-ws', 'scripted', worktree], env);
    assert.equal(py.err, null, py.stderr);
    const out = JSON.parse(py.stdout);
    assertOutcomes(out, 'python-ws');
    assert.deepEqual(out.requiredKeys, ['added', 'name']);
  } finally { await srv.close(); }
});

// A fake /mcp server: `/tools/plain` answers a non-JSON 200, `/tools/array` a
// non-object JSON 500, anything else `{}`. Every request body is captured.
async function fakeServer() {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      requests.push({ url: req.url, body });
      if (req.url.endsWith('/tools/plain')) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('not json at all'); return; }
      if (req.url.endsWith('/tools/array')) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('[1,2]'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/mcp`, requests, close: () => new Promise(r => srv.close(r)) };
}

// The raise rule's non-JSON and non-object arms: a body that is not JSON
// raises (even at 200) with code null and the raw text as body; a JSON body
// that is not an object raises on its status with code null.

const EXPECTED_FAULTS = {
  plain: { code: null, reason: 'response is not JSON', status: 200, body: 'not json at all' },
  array: { code: null, reason: 'HTTP 500', status: 500, body: [1, 2] },
};

test('a non-JSON or non-object body raises ConductorError with code null, in both clients', async (t) => {
  const fake = await fakeServer();
  try {
    const { ConductorClient, ConductorError } = await import(pathToFileURL(path.join(FIXTURES, 'expected', 'conductor_client.mjs')).href);
    const client = new ConductorClient(fake.url);
    for (const [name, want] of Object.entries(EXPECTED_FAULTS)) {
      await assert.rejects(client.call(name, {}), e => {
        assert.ok(e instanceof ConductorError, String(e));
        assert.deepEqual({ code: e.code, reason: e.reason, status: e.status, body: e.body }, want, name);
        return true;
      });
    }

    if (!(await python311())) { t.diagnostic('python3 >= 3.11 not installed — the Python client was not run'); return; }
    const script = [
      'import json, sys',
      'sys.path.insert(0, sys.argv[1])',
      'from conductor_client import ConductorClient, ConductorError',
      'c = ConductorClient(sys.argv[2]); out = {}',
      'for name in ("plain", "array"):',
      '    try:',
      '        c.call(name, {}); out[name] = "returned"',
      '    except ConductorError as e:',
      '        out[name] = {"code": e.code, "reason": e.reason, "status": e.status, "body": e.body}',
      'print(json.dumps(out))',
    ].join('\n');
    const py = await run('python3', ['-I', '-B', '-c', script, path.join(FIXTURES, 'expected'), fake.url]);
    assert.equal(py.err, null, py.stderr);
    assert.deepEqual(JSON.parse(py.stdout), EXPECTED_FAULTS);
  } finally { await fake.close(); }
});

// The Python client's own spellings and transport, measured on the wire: a
// keyword parameter `from_` is sent as the wire key `from`, and an inherited
// http_proxy does not route a call (the opener has an empty ProxyHandler).
test('the Python client sends from_ as `from`, and ignores an inherited http_proxy', async (t) => {
  if (!(await python311())) { t.diagnostic('python3 >= 3.11 not installed — the Python client was not run'); return; }
  const fake = await fakeServer();
  try {
    const dead = 'http://127.0.0.1:9';
    const env = { ...process.env, http_proxy: dead, HTTP_PROXY: dead };
    for (const k of ['no_proxy', 'NO_PROXY']) delete env[k];
    const script = [
      'import json, sys, urllib.request',
      'sys.path.insert(0, sys.argv[1])',
      'from conductor_client import ConductorClient',
      'out = {"result": ConductorClient(sys.argv[2]).make_thing(name="x", from_="there")}',
      // Positive control: a default opener honours the dead proxy and fails.
      'try:',
      '    urllib.request.urlopen(sys.argv[2] + "/tools/control", data=b"{}", timeout=5); out["control"] = "reached"',
      'except OSError as e:',
      '    out["control"] = "failed"',
      'print(json.dumps(out))',
    ].join('\n');
    const py = await new Promise(resolve => {
      execFile('python3', ['-I', '-B', '-c', script, path.join(FIXTURES, 'expected'), fake.url], { env, timeout: 30000 },
        (err, stdout, stderr) => resolve({ err, stdout, stderr }));
    });
    assert.equal(py.err, null, py.stderr);
    const out = JSON.parse(py.stdout);
    assert.equal(out.control, 'failed', 'precondition: the planted proxy routes a default urllib opener');
    assert.deepEqual(out.result, {}, 'the client call reached the fake server despite the proxy');
    const calls = fake.requests.filter(r => r.url === '/mcp/tools/make_thing');
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0].body), { name: 'x', from: 'there' }, 'from_ goes on the wire as `from`');
  } finally { await fake.close(); }
});
