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
import path from 'node:path';
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

test('the real start() writes both clients before it resolves, overwriting a stale one', async () => {
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
    const stale = path.join(projects.mcpClientDir(), MCP_CLIENT_FILES.python);
    await fs.mkdir(path.dirname(stale), { recursive: true });
    await fs.writeFile(stale, '# stale\n');
    booted = await start({ port: 0, host: '127.0.0.1', buildWeb: false });
    await assertWritten();
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
