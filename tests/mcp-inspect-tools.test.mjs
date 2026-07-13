// Tests for MCP inspection-tool additions:
//   project_bash and project_diff's always-on working-tree section.
//
// Mirrors the bootServer + rpc + callTool pattern from mcp-conduct-tools.test.mjs.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, freshProjectsRoot, rmrf } from './helpers.mjs';
import { _resetForTest as resetShellEnvCache } from '../src/claudeShellEnv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');

let ctx, baseUrl, instances, home, projectsRoot;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO_WS }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

let nextRpcId = 1;
async function rpc(method, params) {
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
async function callTool(name, args) {
  const { body } = await rpc('tools/call', { name, arguments: args });
  assert.ok(body, 'rpc returned a response');
  assert.ok(body.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}
// Single-block JSON result (project_diff summary mode).
function unwrap(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  return JSON.parse(result.content[0].text);
}
// project_diff: [meta, rawDiff?]
function unwrapDiff(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  const meta = JSON.parse(result.content[0].text);
  if (result.content.length > 1) return { ...meta, diff: result.content.slice(1).map(c => c.text).join('') };
  return meta;
}
// project_bash is multi-block: content[0] is JSON metadata, content[1] is
// the raw stdout+stderr body. Merge the body back onto the metadata as `output`.
function unwrapBash(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  const meta = JSON.parse(result.content[0].text);
  return { ...meta, output: result.content.slice(1).map(c => c.text).join('') };
}
function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
  });
}
async function makeRealRepo(name) {
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
// Create a worktree via the API and return its metadata.
async function makeWorktree(project) {
  const result = await callTool('create_worktree', { project });
  return JSON.parse(result.content[0].text);
}

// ---- project_bash ----
//
// project_bash's own claudeShellEnv.js spawn is a separate codepath from the
// instance-launching CLAUDE_BIN handled by bootServer's in-process launcher,
// so it needs its own fake `claude` binary: one that answers --version and,
// for a -p invocation, writes a canned bundle (defining a trivial `rg` shell
// function so sourcing can be proven deterministically) to the path our
// directive tells it to write to.
const FAKE_CLAUDE_SHELL_ENV_SCRIPT = `
const fs = require('fs');
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('9.9.9 (Claude Code)\\n');
  process.exit(0);
}
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const m = input.match(/> '([^']*)'/);
  if (m) {
    fs.writeFileSync(m[1], 'export CLAUDE_CODE_EXECPATH=/fake/claude\\nrg() { echo "RG-SHIM-CALLED $*"; }\\n');
  }
  process.exit(0);
});
`;

describe('project_bash', () => {
  let fakeBinPath, prevClaudeBin;

  before(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-fake-claude-shellenv-'));
    fakeBinPath = path.join(dir, 'fake-claude.js');
    await fs.writeFile(fakeBinPath, FAKE_CLAUDE_SHELL_ENV_SCRIPT, 'utf8');
  });
  beforeEach(() => {
    prevClaudeBin = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = `${process.execPath} ${fakeBinPath}`;
  });
  afterEach(() => {
    if (prevClaudeBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = prevClaudeBin;
    resetShellEnvCache();
  });

  test('project_bash runs a plain command and returns combined output', async () => {
    await makeRealRepo('demo');
    const r = unwrapBash(await callTool('project_bash', { project: 'demo', command: 'echo hello' }));
    assert.match(r.output, /hello/);
    assert.equal(r.exitCode, 0);
    assert.ok(!r.truncated);
    assert.ok(!r.timedOut);
  });

  test('project_bash runs inside a worktree cwd', async () => {
    await makeRealRepo('demo');
    const wt = await makeWorktree('demo');
    const wtPath = path.join(projectsRoot, wt.worktree);
    await fs.writeFile(path.join(wtPath, 'only-in-worktree.txt'), 'x\n');

    const r = unwrapBash(await callTool('project_bash', { project: 'demo', worktree: wt.worktree, command: 'ls' }));
    assert.equal(r.cwd, wtPath);
    assert.match(r.output, /only-in-worktree\.txt/);
  });

  test('project_bash sources the shell-env bundle (rg shim fires)', async () => {
    await makeRealRepo('demo');
    const r = unwrapBash(await callTool('project_bash', { project: 'demo', command: 'rg foo' }));
    assert.match(r.output, /RG-SHIM-CALLED foo/);
    assert.equal(r.exitCode, 0);
  });

  test('project_bash non-zero exit is a normal result, not isError', async () => {
    await makeRealRepo('demo');
    const result = await callTool('project_bash', { project: 'demo', command: 'exit 3' });
    assert.ok(!result.isError);
    const r = unwrapBash(result);
    assert.equal(r.exitCode, 3);
  });

  test('project_bash timeout kills a long-running command', async () => {
    await makeRealRepo('demo');
    const startedAt = Date.now();
    const r = unwrapBash(await callTool('project_bash', { project: 'demo', command: 'sleep 5', timeout: 200 }));
    const elapsed = Date.now() - startedAt;
    assert.equal(r.exitCode, null);
    assert.equal(r.timedOut, true);
    assert.ok(elapsed < 4000, `expected a quick timeout kill, took ${elapsed}ms`);
  });

  test('project_bash caps retained output but lets the command finish (drain, not kill)', async () => {
    await makeRealRepo('demo');
    const r = unwrapBash(await callTool('project_bash', {
      project: 'demo', command: 'yes x | head -c 500000; echo DONE_MARKER_$?',
    }));
    assert.equal(r.truncated, true);
    assert.equal(r.exitCode, 0, 'command should run to completion, not be killed, on output cap');
    assert.ok(r.output.length < 500000, 'retained output should be capped well below the full 500000 bytes');
  });

  test('project_bash rejects an empty command', async () => {
    await makeRealRepo('demo');
    const { body } = await rpc('tools/call', {
      name: 'project_bash', arguments: { project: 'demo', command: '' },
    });
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /non-empty/i);
  });

  test('project_bash description is an accepted no-op', async () => {
    await makeRealRepo('demo');
    const r = unwrapBash(await callTool('project_bash', {
      project: 'demo', command: 'echo still-sync', description: 'echo a marker',
    }));
    assert.match(r.output, /still-sync/);
    assert.equal(r.exitCode, 0);
  });
});

// ---- project_diff: always-on working-tree section ----

test('project_diff default now surfaces uncommitted changes', async () => {
  await makeRealRepo('demo');
  const wt = await makeWorktree('demo');
  const wtPath = path.join(projectsRoot, wt.worktree);
  // Commit something
  await fs.writeFile(path.join(wtPath, 'committed.txt'), 'committed\n');
  await git(wtPath, 'add', '.');
  await git(wtPath, 'commit', '-q', '-m', 'add committed.txt');
  // Leave an uncommitted edit to the tracked file, plus a new untracked file
  await fs.writeFile(path.join(wtPath, 'committed.txt'), 'committed\ndirty\n');
  await fs.writeFile(path.join(wtPath, 'uncommitted.txt'), 'brand new\n');

  const r = unwrapDiff(await callTool('project_diff', {
    project: 'demo', worktree: wt.worktree,
  }));
  assert.ok(r.diff.includes('committed.txt'), 'committed file should appear');
  assert.equal(r.hasUncommittedChanges, true);
  // Separator line should appear in the diff body
  assert.match(r.diff, /@@@ uncommitted working tree changes/);
  assert.ok(r.untracked.includes('uncommitted.txt'), 'new untracked file should be listed');
});

test('project_diff surfaces staged+unstaged changes', async () => {
  await makeRealRepo('demo');
  const wt = await makeWorktree('demo');
  const wtPath = path.join(projectsRoot, wt.worktree);
  // Commit something first
  await fs.writeFile(path.join(wtPath, 'committed.txt'), 'committed\n');
  await git(wtPath, 'add', '.');
  await git(wtPath, 'commit', '-q', '-m', 'add committed.txt');
  // Modify an existing committed file (without committing)
  await fs.writeFile(path.join(wtPath, 'committed.txt'), 'committed\nmodified\n');

  const r = unwrapDiff(await callTool('project_diff', {
    project: 'demo', worktree: wt.worktree,
  }));
  assert.equal(r.hasUncommittedChanges, true);
  // Separator line should appear in the diff body
  assert.match(r.diff, /@@@ uncommitted working tree changes/);
  // The uncommitted modification should appear after the separator
  assert.match(r.diff, /modified/);
});

test('project_diff surfaces untracked files in metadata', async () => {
  await makeRealRepo('demo');
  const wt = await makeWorktree('demo');
  const wtPath = path.join(projectsRoot, wt.worktree);
  // Drop a new untracked file (never git-added)
  await fs.writeFile(path.join(wtPath, 'brand-new.txt'), 'brand new content\n');

  const r = unwrapDiff(await callTool('project_diff', {
    project: 'demo', worktree: wt.worktree,
  }));
  // Untracked file must appear in the untracked list
  assert.ok(Array.isArray(r.untracked), 'untracked should be an array');
  assert.ok(r.untracked.includes('brand-new.txt'), 'brand-new.txt should be listed as untracked');
});

test('project_diff with clean working tree: hasUncommittedChanges false', async () => {
  await makeRealRepo('demo');
  const wt = await makeWorktree('demo');
  const wtPath = path.join(projectsRoot, wt.worktree);
  await fs.writeFile(path.join(wtPath, 'committed.txt'), 'committed\n');
  await git(wtPath, 'add', '.');
  await git(wtPath, 'commit', '-q', '-m', 'add committed.txt');
  // No uncommitted changes

  const r = unwrapDiff(await callTool('project_diff', {
    project: 'demo', worktree: wt.worktree,
  }));
  assert.equal(r.hasUncommittedChanges, false);
  assert.deepEqual(r.untracked, []);
  // Separator should not appear in the diff body
  assert.ok(!r.diff.includes('@@@ uncommitted'), 'separator absent when no uncommitted changes');
});

test('project_diff summary:true adds uncommitted section', async () => {
  await makeRealRepo('demo');
  const wt = await makeWorktree('demo');
  const wtPath = path.join(projectsRoot, wt.worktree);
  await fs.writeFile(path.join(wtPath, 'committed.txt'), 'committed\n');
  await git(wtPath, 'add', '.');
  await git(wtPath, 'commit', '-q', '-m', 'add committed.txt');
  // Uncommitted edit
  await fs.writeFile(path.join(wtPath, 'committed.txt'), 'committed\nextra\n');
  // Untracked
  await fs.writeFile(path.join(wtPath, 'new-file.txt'), 'new\n');

  const r = unwrap(await callTool('project_diff', {
    project: 'demo', worktree: wt.worktree, summary: true,
  }));
  assert.equal(r.summary, true);
  assert.ok(r.uncommitted, 'uncommitted section should be present');
  assert.ok(typeof r.uncommitted.totals === 'object');
  assert.ok(Array.isArray(r.uncommitted.files));
  assert.ok(Array.isArray(r.uncommitted.untracked));
  assert.ok(r.uncommitted.untracked.includes('new-file.txt'), 'new-file.txt should be untracked');
});
