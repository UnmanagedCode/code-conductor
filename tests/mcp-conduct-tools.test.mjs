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
  return JSON.parse(result.content[0].text);
}
// get_worktree_diff: diff mode → [meta, rawDiff]; summary/clean → single JSON.
// Reattach the diff body onto the metadata for drop-in assertions.
function unwrapDiff(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  const meta = JSON.parse(result.content[0].text);
  if (result.content.length > 1) {
    return { ...meta, diff: result.content.slice(1).map(c => c.text).join('') };
  }
  return meta;
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
    const sid = inst.sessionId;

    const res = unwrap(await callTool(ctx.baseUrl, 'approve_plan', { sessionId: sid }));
    assert.equal(res.sessionId, sid);
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
    const sid = ctx.instances.get(id).sessionId;

    const res = unwrap(await callTool(ctx.baseUrl, 'approve_plan', {
      sessionId: sid,
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
    const sid = inst.sessionId;

    const res = unwrap(await callTool(ctx.baseUrl, 'reject_plan', {
      sessionId: sid, feedback: 'simpler please',
    }));
    assert.equal(res.sessionId, sid);
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
    const sid = inst.sessionId;
    assert.equal(inst.autoApprovePlan, false);

    const on = unwrap(await callTool(ctx.baseUrl, 'set_auto_approve_plan', {
      sessionId: sid, enabled: true,
    }));
    assert.equal(on.sessionId, sid);
    assert.equal(on.autoApprovePlan, true);
    assert.equal(inst.autoApprovePlan, true);

    const off = unwrap(await callTool(ctx.baseUrl, 'set_auto_approve_plan', {
      sessionId: sid, enabled: false,
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
    const wtPath = path.join(ctx.projectsRoot, wt.worktree);
    await fs.writeFile(path.join(wtPath, 'new.txt'), 'fresh content\n');
    await git(wtPath, 'add', '.');
    await git(wtPath, 'commit', '-q', '-m', 'add new.txt');

    const diffRes = unwrapDiff(await callTool(ctx.baseUrl, 'get_worktree_diff', {
      project: 'demo', worktree: wt.worktree,
    }));
    assert.equal(diffRes.baseRef, 'main');
    assert.match(diffRes.head, /^[0-9a-f]{40}$/, 'head is the resolved HEAD sha');
    assert.equal(diffRes.truncated, false);
    assert.equal(diffRes.offset, 0);
    assert.equal(diffRes.nextOffset, null);
    assert.ok(diffRes.totalLines > 0);
    assert.ok(diffRes.totalBytes > 0);
    assert.equal(diffRes.sizeBytes, undefined, 'sizeBytes alias removed');
    assert.match(diffRes.diff, /new\.txt/);
    assert.match(diffRes.diff, /\+fresh content/);
  } finally { await ctx.close(); }
});

test('get_worktree_diff returns an empty diff for a clean worktree', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const wt = unwrap(await callTool(ctx.baseUrl, 'create_worktree', { project: 'demo' }));
    const diffRes = unwrapDiff(await callTool(ctx.baseUrl, 'get_worktree_diff', {
      project: 'demo', worktree: wt.worktree,
    }));
    assert.equal(diffRes.diff, '');
    assert.equal(diffRes.truncated, false);
    assert.equal(diffRes.nextOffset, null);
    assert.equal(diffRes.totalLines, 0);
    assert.equal(diffRes.totalBytes, 0);
  } finally { await ctx.close(); }
});

test('get_worktree_diff rejects unknown worktree', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const { body } = await rpc(ctx.baseUrl, 'tools/call', {
      name: 'get_worktree_diff',
      arguments: { project: 'demo', worktree: 'does-not-exist' },
    });
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /not found/i);
  } finally { await ctx.close(); }
});

test('get_worktree_diff paginates a large diff losslessly by line index', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const wt = unwrap(await callTool(ctx.baseUrl, 'create_worktree', { project: 'demo' }));
    const wtPath = path.join(ctx.projectsRoot, wt.worktree);
    // ~300 KB across many files, all lines well under the cap so pages split
    // on whole-line boundaries.
    const fileCount = 60;
    const oneLine = 'y'.repeat(80) + '\n';
    for (let i = 0; i < fileCount; i++) {
      await fs.writeFile(path.join(wtPath, `f${i}.txt`), oneLine.repeat(60));
    }
    await git(wtPath, 'add', '.');
    await git(wtPath, 'commit', '-q', '-m', 'many files');

    const seenFiles = new Set();
    let offset = 0;
    let pages = 0;
    let firstTotalLines = null;
    let firstTotalBytes = null;
    let truncatedSeen = false;
    while (true) {
      const page = unwrapDiff(await callTool(ctx.baseUrl, 'get_worktree_diff', {
        project: 'demo', worktree: wt.worktree, offset,
      }));
      pages++;
      if (firstTotalLines === null) { firstTotalLines = page.totalLines; firstTotalBytes = page.totalBytes; }
      // totals stay stable across pages.
      assert.equal(page.totalLines, firstTotalLines);
      assert.equal(page.totalBytes, firstTotalBytes);
      assert.equal(page.offset, offset);
      // each page is within the byte ceiling (whole lines, plus tiny header prefix).
      assert.ok(Buffer.byteLength(page.diff, 'utf8') <= 200 * 1024 + 4096);
      for (const m of page.diff.matchAll(/^diff --git a\/(.+) b\/.+$/gm)) seenFiles.add(m[1]);
      if (page.truncated) {
        truncatedSeen = true;
        assert.ok(Array.isArray(page.includedFiles) && page.includedFiles.length > 0);
        assert.ok(Array.isArray(page.omittedFiles));
        assert.ok(typeof page.nextOffset === 'number' && page.nextOffset > offset);
        offset = page.nextOffset;
      } else {
        assert.equal(page.nextOffset, null);
        break;
      }
    }
    assert.ok(truncatedSeen, 'diff should have required more than one page');
    assert.ok(pages > 1, 'should take multiple pages to drain');
    // every file shows up across the drained pages.
    for (let i = 0; i < fileCount; i++) assert.ok(seenFiles.has(`f${i}.txt`), `f${i}.txt missing from drained pages`);
  } finally { await ctx.close(); }
});

test('get_worktree_diff re-emits file/hunk headers on a mid-file page', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const wt = unwrap(await callTool(ctx.baseUrl, 'create_worktree', { project: 'demo' }));
    const wtPath = path.join(ctx.projectsRoot, wt.worktree);
    // One big file with many lines, forcing a page boundary inside it.
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i} ` + 'z'.repeat(50)).join('\n') + '\n';
    await fs.writeFile(path.join(wtPath, 'big.txt'), big);
    await git(wtPath, 'add', '.');
    await git(wtPath, 'commit', '-q', '-m', 'one big file');

    const page1 = unwrapDiff(await callTool(ctx.baseUrl, 'get_worktree_diff', {
      project: 'demo', worktree: wt.worktree,
    }));
    assert.equal(page1.truncated, true);
    assert.ok(page1.nextOffset > 0);
    const page2 = unwrapDiff(await callTool(ctx.baseUrl, 'get_worktree_diff', {
      project: 'demo', worktree: wt.worktree, offset: page1.nextOffset,
    }));
    // page2 begins mid-file → re-emitted header context makes it standalone.
    assert.match(page2.diff, /^diff --git a\/big\.txt b\/big\.txt/);
    assert.match(page2.diff, /@@ /);
  } finally { await ctx.close(); }
});

test('get_worktree_diff makes progress even when a single line exceeds the cap', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const wt = unwrap(await callTool(ctx.baseUrl, 'create_worktree', { project: 'demo' }));
    const wtPath = path.join(ctx.projectsRoot, wt.worktree);
    // Single 300 KB line (no newlines) — the added content line alone is > cap.
    await fs.writeFile(path.join(wtPath, 'huge.txt'), 'x'.repeat(300 * 1024));
    await git(wtPath, 'add', '.');
    await git(wtPath, 'commit', '-q', '-m', 'huge single line');

    let offset = 0;
    let guard = 0;
    let sawHugeLine = false;
    while (guard++ < 20) {
      const page = unwrapDiff(await callTool(ctx.baseUrl, 'get_worktree_diff', {
        project: 'demo', worktree: wt.worktree, offset,
      }));
      if (/\+x{200000,}/.test(page.diff)) sawHugeLine = true;
      if (!page.truncated) break;
      assert.ok(page.nextOffset > offset, 'offset must advance even past an oversized line');
      offset = page.nextOffset;
    }
    assert.ok(sawHugeLine, 'the oversized line is still emitted on its own page');
  } finally { await ctx.close(); }
});

test('get_worktree_diff summary returns a per-file stat (add + modify)', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const wt = unwrap(await callTool(ctx.baseUrl, 'create_worktree', { project: 'demo' }));
    const wtPath = path.join(ctx.projectsRoot, wt.worktree);
    await fs.writeFile(path.join(wtPath, 'README.md'), '# test\nmore\n'); // modify
    await fs.writeFile(path.join(wtPath, 'new.txt'), 'a\nb\nc\n');         // add
    await git(wtPath, 'add', '.');
    await git(wtPath, 'commit', '-q', '-m', 'add + modify');

    const res = unwrapDiff(await callTool(ctx.baseUrl, 'get_worktree_diff', {
      project: 'demo', worktree: wt.worktree, summary: true,
    }));
    assert.equal(res.summary, true);
    assert.equal(res.diff, undefined); // no diff blob in summary mode
    assert.equal(res.totals.files, 2);
    const byPath = Object.fromEntries(res.files.map(f => [f.path, f]));
    assert.equal(byPath['README.md'].status, 'M');
    assert.equal(byPath['new.txt'].status, 'A');
    assert.equal(byPath['new.txt'].additions, 3);
    assert.equal(byPath['new.txt'].binary, false);
    assert.equal(res.totals.additions, res.files.reduce((s, f) => s + f.additions, 0));
  } finally { await ctx.close(); }
});

test('get_worktree_diff summary flags deletes, renames and binary files', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');

    // Rename test: pure rename so git reports R.
    const wtR = unwrap(await callTool(ctx.baseUrl, 'create_worktree', { project: 'demo' }));
    const wtRPath = path.join(ctx.projectsRoot, wtR.worktree);
    await git(wtRPath, 'mv', 'README.md', 'DOC.md');
    await git(wtRPath, 'commit', '-q', '-m', 'rename');
    const resR = unwrapDiff(await callTool(ctx.baseUrl, 'get_worktree_diff', {
      project: 'demo', worktree: wtR.worktree, summary: true,
    }));
    const rename = resR.files.find(f => f.path === 'DOC.md');
    assert.ok(rename, 'renamed file present');
    assert.equal(rename.status, 'R');
    assert.equal(rename.oldPath, 'README.md');

    // Delete test.
    const wtD = unwrap(await callTool(ctx.baseUrl, 'create_worktree', { project: 'demo' }));
    const wtDPath = path.join(ctx.projectsRoot, wtD.worktree);
    await git(wtDPath, 'rm', '-q', 'README.md');
    await git(wtDPath, 'commit', '-q', '-m', 'delete');
    const resD = unwrapDiff(await callTool(ctx.baseUrl, 'get_worktree_diff', {
      project: 'demo', worktree: wtD.worktree, summary: true,
    }));
    assert.equal(resD.files.find(f => f.path === 'README.md').status, 'D');

    // Binary test.
    const wtB = unwrap(await callTool(ctx.baseUrl, 'create_worktree', { project: 'demo' }));
    const wtBPath = path.join(ctx.projectsRoot, wtB.worktree);
    const bin = Buffer.from([0, 1, 2, 0, 255, 254, 0, 10, 0, 200]);
    await fs.writeFile(path.join(wtBPath, 'blob.bin'), bin);
    await git(wtBPath, 'add', '.');
    await git(wtBPath, 'commit', '-q', '-m', 'binary');
    const resB = unwrapDiff(await callTool(ctx.baseUrl, 'get_worktree_diff', {
      project: 'demo', worktree: wtB.worktree, summary: true,
    }));
    const blob = resB.files.find(f => f.path === 'blob.bin');
    assert.equal(blob.binary, true);
    assert.equal(blob.additions, 0);
    assert.equal(blob.deletions, 0);
  } finally { await ctx.close(); }
});

test('get_worktree_diff summary is empty for a clean worktree', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const wt = unwrap(await callTool(ctx.baseUrl, 'create_worktree', { project: 'demo' }));
    const res = unwrapDiff(await callTool(ctx.baseUrl, 'get_worktree_diff', {
      project: 'demo', worktree: wt.worktree, summary: true,
    }));
    assert.deepEqual(res.files, []);
    assert.equal(res.totals.files, 0);
    assert.equal(res.totals.additions, 0);
    assert.equal(res.totals.deletions, 0);
  } finally { await ctx.close(); }
});

test('get_worktree_diff scopes the diff to the given paths', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  try {
    await makeRealRepo(ctx.projectsRoot, 'demo');
    const wt = unwrap(await callTool(ctx.baseUrl, 'create_worktree', { project: 'demo' }));
    const wtPath = path.join(ctx.projectsRoot, wt.worktree);
    await fs.writeFile(path.join(wtPath, 'a.txt'), 'aaa\n');
    await fs.writeFile(path.join(wtPath, 'b.txt'), 'bbb\n');
    await git(wtPath, 'add', '.');
    await git(wtPath, 'commit', '-q', '-m', 'two files');

    const scoped = unwrapDiff(await callTool(ctx.baseUrl, 'get_worktree_diff', {
      project: 'demo', worktree: wt.worktree, paths: ['a.txt'],
    }));
    assert.match(scoped.diff, /a\.txt/);
    assert.ok(!/b\.txt/.test(scoped.diff), 'b.txt should be excluded by path scoping');

    const scopedSummary = unwrapDiff(await callTool(ctx.baseUrl, 'get_worktree_diff', {
      project: 'demo', worktree: wt.worktree, summary: true, paths: ['a.txt'],
    }));
    assert.equal(scopedSummary.totals.files, 1);
    assert.equal(scopedSummary.files[0].path, 'a.txt');
  } finally { await ctx.close(); }
});
