// Tests for the four new MCP tools added for Conduct mode:
//   approve_plan, reject_plan, set_auto_approve_plan, get_worktree_diff.
//
// Mirrors the bootServer + rpc + unwrap pattern from tests/mcp.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');
const SCENARIO_PLAN = path.join(__dirname, 'fixtures', 'scenario-plan.json');

let nextRpcId = 1;
async function rpc(baseUrl, method, params) {
  const id = nextRpcId++;
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (res.status === 202) return { status: 202, body: null };
  const body = await res.json();
  return { status: res.status, body };
}
async function callTool(baseUrl, name, args) {
  const { body } = await rpc(baseUrl, 'tools/call', { name, arguments: args });
  assert.ok(body, 'rpc returned a response');
  assert.ok(body.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}
function unwrap(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  const text = result.content.map(c => c.text).join('');
  return JSON.parse(text);
}
function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
  });
}
async function makeRealRepo(projectsRoot, name) {
  const repoPath = path.join(projectsRoot, name);
  await fs.mkdir(repoPath, { recursive: true });
  await git(repoPath, 'init', '-q', '-b', 'main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'test');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# test\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-q', '-m', 'initial');
  return repoPath;
}

async function seedPlanFile() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-plan-'));
  const planDir = path.join(tmpDir, '.claude', 'plans');
  await fs.mkdir(planDir, { recursive: true });
  const planFile = path.join(planDir, 'plan.md');
  await fs.writeFile(planFile, '# Plan\n- step 1\n');
  process.env.FAKE_PLAN_FILE = planFile;
  return tmpDir;
}

test('tools/list includes the four new Conduct tools', async () => {
  const { baseUrl, close } = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    const { body } = await rpc(baseUrl, 'tools/list');
    const names = body.result.tools.map(t => t.name);
    for (const n of ['approve_plan', 'reject_plan', 'set_auto_approve_plan', 'get_worktree_diff']) {
      assert.ok(names.includes(n), `tools/list missing ${n}`);
      const t = body.result.tools.find(x => x.name === n);
      assert.equal(t.inputSchema.type, 'object', `${n} inputSchema is an object`);
      assert.ok(typeof t.description === 'string' && t.description.length > 20);
    }
  } finally { await close(); }
});

test('approve_plan flips mode to bypassPermissions and sends the canonical approval prompt', async () => {
  const tmpDir = await seedPlanFile();
  const ctx = await bootServer({ scenarioPath: SCENARIO_PLAN });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'plan' });
    const id = r.body.id;
    const inst = ctx.instances.get(id);
    await waitFor(() => inst.status === 'idle');

    const res = unwrap(await callTool(ctx.baseUrl, 'approve_plan', { instanceId: id }));
    assert.equal(res.ok, true);
    assert.equal(res.mode, 'bypassPermissions');
    assert.equal(
      res.sentText,
      'I approve the plan. Please proceed with the implementation.',
    );
    assert.equal(inst.mode, 'bypassPermissions');
    // The approval prompt should land as a user_echo in the ring.
    await waitFor(() => inst.ring.toArray().some(
      ev => ev.kind === 'user_echo' && /I approve the plan/.test(ev.text ?? ''),
    ));
  } finally {
    delete process.env.FAKE_PLAN_FILE;
    await ctx.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('approve_plan with feedback interpolates the additional notes', async () => {
  const tmpDir = await seedPlanFile();
  const ctx = await bootServer({ scenarioPath: SCENARIO_PLAN });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'plan' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const res = unwrap(await callTool(ctx.baseUrl, 'approve_plan', {
      instanceId: id,
      feedback: 'use TypeScript',
    }));
    assert.match(res.sentText, /I approve the plan\. Additional notes: use TypeScript/);
    assert.match(res.sentText, /Please proceed with the implementation/);
  } finally {
    delete process.env.FAKE_PLAN_FILE;
    await ctx.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('reject_plan keeps the worker in plan mode', async () => {
  const tmpDir = await seedPlanFile();
  const ctx = await bootServer({ scenarioPath: SCENARIO_PLAN });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'plan' });
    const id = r.body.id;
    const inst = ctx.instances.get(id);
    await waitFor(() => inst.status === 'idle');

    const res = unwrap(await callTool(ctx.baseUrl, 'reject_plan', {
      instanceId: id, feedback: 'simpler please',
    }));
    assert.equal(res.ok, true);
    assert.equal(res.mode, 'plan', 'mode stays plan after reject');
    assert.match(res.sentText, /revise the plan/i);
    assert.match(res.sentText, /simpler please/);
    assert.equal(inst.mode, 'plan');
  } finally {
    delete process.env.FAKE_PLAN_FILE;
    await ctx.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('set_auto_approve_plan flips the per-instance flag', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'plan' });
    const id = r.body.id;
    const inst = ctx.instances.get(id);
    await waitFor(() => inst.status === 'idle');
    assert.equal(inst.autoApprovePlan, false);

    const on = unwrap(await callTool(ctx.baseUrl, 'set_auto_approve_plan', {
      instanceId: id, enabled: true,
    }));
    assert.equal(on.ok, true);
    assert.equal(on.autoApprovePlan, true);
    assert.equal(inst.autoApprovePlan, true);

    const off = unwrap(await callTool(ctx.baseUrl, 'set_auto_approve_plan', {
      instanceId: id, enabled: false,
    }));
    assert.equal(off.autoApprovePlan, false);
    assert.equal(inst.autoApprovePlan, false);
  } finally { await ctx.close(); }
});

test('get_worktree_diff returns the unified diff of <base>...HEAD', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const wt = unwrap(await callTool(ctx.baseUrl, 'create_worktree', { project: 'demo' }));
    const wtPath = path.join(ctx.projectsRoot, wt.worktreeName);
    await fs.writeFile(path.join(wtPath, 'new.txt'), 'fresh content\n');
    await git(wtPath, 'add', '.');
    await git(wtPath, 'commit', '-q', '-m', 'add new.txt');

    const diffRes = unwrap(await callTool(ctx.baseUrl, 'get_worktree_diff', {
      project: 'demo', worktreeName: wt.worktreeName,
    }));
    assert.equal(diffRes.baseRef, 'main');
    assert.equal(diffRes.truncated, false);
    assert.match(diffRes.diff, /new\.txt/);
    assert.match(diffRes.diff, /\+fresh content/);
    assert.ok(diffRes.sizeBytes > 0);
  } finally { await ctx.close(); }
});

test('get_worktree_diff rejects unknown worktree', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const { body } = await rpc(ctx.baseUrl, 'tools/call', {
      name: 'get_worktree_diff',
      arguments: { project: 'demo', worktreeName: 'does-not-exist' },
    });
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /not found/i);
  } finally { await ctx.close(); }
});

test('get_worktree_diff truncates output past the cap', async () => {
  // Build a worktree with a large added file so the diff exceeds 200 KB.
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const wt = unwrap(await callTool(ctx.baseUrl, 'create_worktree', { project: 'demo' }));
    const wtPath = path.join(ctx.projectsRoot, wt.worktreeName);
    // 300 KB of added text.
    const blob = 'x'.repeat(300 * 1024);
    await fs.writeFile(path.join(wtPath, 'big.txt'), blob);
    await git(wtPath, 'add', '.');
    await git(wtPath, 'commit', '-q', '-m', 'big add');

    const diffRes = unwrap(await callTool(ctx.baseUrl, 'get_worktree_diff', {
      project: 'demo', worktreeName: wt.worktreeName,
    }));
    assert.equal(diffRes.truncated, true);
    assert.ok(diffRes.sizeBytes >= 300 * 1024);
    assert.ok(diffRes.diff.length <= 200 * 1024 + 10);
  } finally { await ctx.close(); }
});
