// The core skill code-conductor:scripting (claude-plugin/skills/scripting/
// SKILL.md) teaches agents to script cc through the generated /mcp client.
// Its two samples are run, unchanged, against a live server on a fresh store:
// the Node sample under this node, the Python one under `python3 -I -B`, with
// CONDUCTOR_MCP_URL pointing at the server and CONDUCTOR_MCP_CLIENT_DIR at the
// generated clients. Each must report every fixture project's dirty state, and
// a project_status refusal as a digest line rather than a crash. The Python run
// is skipped with a log when no python3 is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { bootServer, api, registerLocalProject } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import * as projects from '../src/projects.ts';

const SKILL = path.join(import.meta.dirname, '..', 'claude-plugin', 'skills', 'scripting', 'SKILL.md');

function run(cmd, args, env) {
  return new Promise(resolve => {
    execFile(cmd, args, { env: { ...process.env, ...env }, timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ err, stdout, stderr });
    });
  });
}
const python3 = (code, env) => run('python3', ['-I', '-B', '-c', code], env);

function samples() {
  const out = { js: [], python: [] };
  for (const m of readFileSync(SKILL, 'utf8').matchAll(/```(js|python)\n([\s\S]*?)\n```/g)) out[m[1]].push(m[2]);
  return out;
}

// createProject commits its scaffold, so a fresh project is a clean repo.
async function gitProject(srv, name) {
  const created = await api(srv.baseUrl, 'POST', '/api/projects', { name });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.gitSkipped, undefined);
  return path.join(srv.projectsRoot, name);
}

test('the scripting skill samples report each project\'s dirty state', async (t) => {
  const s = samples();
  assert.equal(s.js.length, 1, 'SKILL.md must carry exactly one js sample');
  assert.equal(s.python.length, 1, 'SKILL.md must carry exactly one python sample');

  const srv = await bootServer({});
  const plainDir = await mkdtemp('cc-skill-plain-');
  try {
    await gitProject(srv, 'clean');
    const dirty = await gitProject(srv, 'dirty');
    await fs.writeFile(path.join(dirty, 'extra.txt'), 'x\n');
    await registerLocalProject('plain', plainDir);
    // A record on a system the registry does not know: project_status refuses.
    await projects.registerProject('gone', { kind: 'remote', system: 'no-such-system', remoteId: null, path: '/srv/gone' });

    const env = { CONDUCTOR_MCP_URL: `${srv.baseUrl}/mcp`, CONDUCTOR_MCP_CLIENT_DIR: projects.mcpClientDir() };
    const names = new Set(['clean', 'dirty', 'gone', 'plain']);
    const want = ['clean: clean', 'dirty: 1 dirty', 'gone: refused SYSTEM_NOT_REGISTERED', 'plain: not a git repo'];
    const digest = out => out.split('\n').filter(l => names.has(l.split(':')[0]));

    const js = await run(process.execPath, ['--input-type=module', '-e', s.js[0]], env);
    assert.equal(js.err, null, js.stderr);
    assert.deepEqual(digest(js.stdout), want);

    const py = await python3(s.python[0], env);
    if (py.err?.code === 'ENOENT') {
      t.diagnostic('python3 not installed — the Python sample was not run');
    } else {
      assert.equal(py.err, null, py.stderr);
      assert.deepEqual(digest(py.stdout), want);
    }
  } finally {
    await srv.close();
  }
});
