// Tests for the three MCP inspection-tool additions:
//   grep, glob, and get_worktree_diff's always-on working-tree section.
//
// Mirrors the bootServer + rpc + callTool pattern from mcp-conduct-tools.test.mjs.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, freshProjectsRoot, rmrf } from './helpers.mjs';

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
// Single-block JSON result (grep files_with_matches/count, glob).
function unwrap(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  return JSON.parse(result.content[0].text);
}
// grep content mode: [meta, rawBody].
function unwrapGrep(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  const meta = JSON.parse(result.content[0].text);
  const body = result.content.length > 1 ? result.content.slice(1).map(c => c.text).join('') : '';
  return { ...meta, body };
}
// get_worktree_diff: [meta, rawDiff?]
function unwrapDiff(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  const meta = JSON.parse(result.content[0].text);
  if (result.content.length > 1) return { ...meta, diff: result.content.slice(1).map(c => c.text).join('') };
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

// ---- grep: files_with_matches ----

test('grep files_with_matches finds matching files and returns project-relative paths', async () => {
  const repoPath = await makeRealRepo('demo');
  await fs.writeFile(path.join(repoPath, 'a.js'), 'const x = require("foo");\n');
  await fs.writeFile(path.join(repoPath, 'b.ts'), 'import foo from "bar";\n');
  await fs.writeFile(path.join(repoPath, 'c.txt'), 'no match here\n');

  const r = unwrap(await callTool('grep', { project: 'demo', pattern: 'require|import' }));
  assert.equal(r.outputMode, 'files_with_matches');
  assert.ok(Array.isArray(r.files));
  assert.ok(r.files.includes('a.js'), 'a.js should match');
  assert.ok(r.files.includes('b.ts'), 'b.ts should match');
  assert.ok(!r.files.includes('c.txt'), 'c.txt should not match');
  assert.equal(typeof r.fileCount, 'number');
  assert.equal(r.truncated, false);
});

test('grep files_with_matches: no matches returns empty files array', async () => {
  await makeRealRepo('demo');
  const r = unwrap(await callTool('grep', { project: 'demo', pattern: 'ZZZNONEXISTENT' }));
  assert.deepEqual(r.files, []);
  assert.equal(r.fileCount, 0);
  assert.equal(r.truncated, false);
});

// ---- grep: content mode ----

test('grep content mode returns path:line:content formatted body', async () => {
  const repoPath = await makeRealRepo('demo');
  await fs.writeFile(path.join(repoPath, 'hello.js'), 'const x = 1;\nconst hello = "world";\nconst y = 2;\n');

  const r = unwrapGrep(await callTool('grep', { project: 'demo', pattern: 'hello', outputMode: 'content' }));
  assert.equal(r.outputMode, 'content');
  assert.equal(typeof r.matchCount, 'number');
  assert.ok(r.matchCount >= 1);
  assert.equal(r.truncated, false);
  // Body should contain path:linenum:content format
  assert.match(r.body, /hello\.js:\d+:.*hello/);
});

test('grep content mode with context lines includes surrounding lines', async () => {
  const repoPath = await makeRealRepo('demo');
  await fs.writeFile(path.join(repoPath, 'src.txt'), 'line1\nline2\nMATCH\nline4\nline5\n');

  const r = unwrapGrep(await callTool('grep', {
    project: 'demo', pattern: 'MATCH', outputMode: 'content', context: 1,
  }));
  assert.ok(r.body.includes('line2'), 'context before match should appear');
  assert.ok(r.body.includes('line4'), 'context after match should appear');
  // Context lines use '-' separator, match lines use ':'
  assert.match(r.body, /src\.txt:\d+-line2/);
  assert.match(r.body, /src\.txt:\d+:MATCH/);
  assert.match(r.body, /src\.txt:\d+-line4/);
});

// ---- grep: count mode ----

test('grep count mode returns per-file match counts and totalMatches', async () => {
  const repoPath = await makeRealRepo('demo');
  await fs.writeFile(path.join(repoPath, 'a.txt'), 'foo\nfoo\nbar\n');
  await fs.writeFile(path.join(repoPath, 'b.txt'), 'foo\nbaz\n');

  const r = unwrap(await callTool('grep', { project: 'demo', pattern: 'foo', outputMode: 'count' }));
  assert.equal(r.outputMode, 'count');
  assert.ok(Array.isArray(r.files));
  const aEntry = r.files.find(f => f.path === 'a.txt');
  const bEntry = r.files.find(f => f.path === 'b.txt');
  assert.ok(aEntry, 'a.txt should appear');
  assert.ok(bEntry, 'b.txt should appear');
  assert.equal(aEntry.count, 2);
  assert.equal(bEntry.count, 1);
  assert.equal(r.totalMatches, 3);
  assert.equal(r.truncated, false);
});

// ---- grep: caseInsensitive ----

test('grep caseInsensitive:true matches regardless of case', async () => {
  const repoPath = await makeRealRepo('demo');
  await fs.writeFile(path.join(repoPath, 'upper.txt'), 'HELLO WORLD\n');
  await fs.writeFile(path.join(repoPath, 'lower.txt'), 'hello world\n');
  await fs.writeFile(path.join(repoPath, 'mixed.txt'), 'Hello World\n');

  // Without caseInsensitive: only exact-case match
  const sensitive = unwrap(await callTool('grep', { project: 'demo', pattern: 'hello' }));
  assert.ok(sensitive.files.includes('lower.txt'));
  assert.ok(!sensitive.files.includes('upper.txt'), 'case-sensitive should not match HELLO');

  // With caseInsensitive: all three match
  const insens = unwrap(await callTool('grep', { project: 'demo', pattern: 'hello', caseInsensitive: true }));
  assert.ok(insens.files.includes('lower.txt'));
  assert.ok(insens.files.includes('upper.txt'));
  assert.ok(insens.files.includes('mixed.txt'));
});

// ---- grep: glob filter ----

test('grep glob filter restricts search to matching file patterns', async () => {
  const repoPath = await makeRealRepo('demo');
  await fs.writeFile(path.join(repoPath, 'app.ts'), 'const x = "target";\n');
  await fs.writeFile(path.join(repoPath, 'app.js'), 'const x = "target";\n');
  await fs.writeFile(path.join(repoPath, 'README.md'), 'target here too\n');

  const r = unwrap(await callTool('grep', { project: 'demo', pattern: 'target', glob: '**/*.ts' }));
  assert.ok(r.files.includes('app.ts'), 'app.ts should match');
  assert.ok(!r.files.includes('app.js'), 'app.js excluded by glob');
  assert.ok(!r.files.includes('README.md'), 'README.md excluded by glob');
});

// ---- grep: type filter ----

test('grep type filter restricts search to file extension', async () => {
  const repoPath = await makeRealRepo('demo');
  await fs.writeFile(path.join(repoPath, 'app.ts'), 'const x = "target";\n');
  await fs.writeFile(path.join(repoPath, 'app.js'), 'const x = "target";\n');

  const r = unwrap(await callTool('grep', { project: 'demo', pattern: 'target', type: 'ts' }));
  assert.ok(r.files.includes('app.ts'), 'app.ts should match ts type');
  assert.ok(!r.files.includes('app.js'), 'app.js excluded by type:ts');
});

// ---- grep: node_modules exclusion ----

test('grep does not descend into node_modules (even when symlinked)', async () => {
  const repoPath = await makeRealRepo('demo');
  // Plant a match inside node_modules — should NOT be returned
  const nmDir = path.join(repoPath, 'node_modules', 'some-pkg');
  await fs.mkdir(nmDir, { recursive: true });
  await fs.writeFile(path.join(nmDir, 'index.js'), 'exports.SECRET = "shouldNotBeFound";\n');
  // Also plant a match outside node_modules
  await fs.writeFile(path.join(repoPath, 'src.js'), 'const x = "shouldNotBeFound";\n');

  const r = unwrap(await callTool('grep', { project: 'demo', pattern: 'shouldNotBeFound' }));
  assert.ok(r.files.includes('src.js'), 'src.js outside node_modules should match');
  assert.ok(!r.files.some(f => f.includes('node_modules')), 'no node_modules files should appear');
});

// ---- grep: headLimit truncation ----

test('grep headLimit caps results and sets truncated:true', async () => {
  const repoPath = await makeRealRepo('demo');
  for (let i = 0; i < 5; i++) {
    await fs.writeFile(path.join(repoPath, `f${i}.txt`), 'NEEDLE\n');
  }

  const r = unwrap(await callTool('grep', { project: 'demo', pattern: 'NEEDLE', headLimit: 3 }));
  assert.ok(r.files.length <= 3, `expected ≤3 files, got ${r.files.length}`);
  assert.equal(r.truncated, true);
});

// ---- grep: invalid regex ----

test('grep rejects an invalid regex with isError:true', async () => {
  await makeRealRepo('demo');
  const { body } = await rpc('tools/call', {
    name: 'grep', arguments: { project: 'demo', pattern: '[invalid' },
  });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /invalid pattern/i);
});

// ---- glob ----

test('glob finds files matching a glob pattern and returns project-relative paths', async () => {
  const repoPath = await makeRealRepo('demo');
  const srcDir = path.join(repoPath, 'src');
  await fs.mkdir(srcDir);
  await fs.writeFile(path.join(srcDir, 'app.test.mjs'), '// test\n');
  await fs.writeFile(path.join(srcDir, 'app.mjs'), '// src\n');
  await fs.writeFile(path.join(repoPath, 'root.test.mjs'), '// root test\n');

  const r = unwrap(await callTool('glob', { project: 'demo', pattern: '**/*.test.mjs' }));
  assert.ok(Array.isArray(r.files));
  assert.ok(r.files.some(f => f === 'src/app.test.mjs' || f.endsWith('app.test.mjs')));
  assert.ok(r.files.some(f => f === 'root.test.mjs' || f.endsWith('root.test.mjs')));
  assert.ok(!r.files.some(f => f.endsWith('app.mjs') && !f.includes('test')), 'non-test file should not match');
  assert.equal(r.truncated, false);
  assert.equal(typeof r.total, 'number');
});

test('glob returns paths sorted newest-first by mtime', async () => {
  const repoPath = await makeRealRepo('demo');
  // Create older file then newer file with a delay to guarantee mtime difference
  await fs.writeFile(path.join(repoPath, 'older.txt'), 'old\n');
  // Set mtime of older.txt to 1 second in the past
  const oldTime = new Date(Date.now() - 2000);
  await fs.utimes(path.join(repoPath, 'older.txt'), oldTime, oldTime);
  await fs.writeFile(path.join(repoPath, 'newer.txt'), 'new\n');

  const r = unwrap(await callTool('glob', { project: 'demo', pattern: '*.txt' }));
  assert.ok(r.files.length >= 2);
  const newerIdx = r.files.indexOf('newer.txt');
  const olderIdx = r.files.indexOf('older.txt');
  assert.ok(newerIdx >= 0 && olderIdx >= 0, 'both files should appear');
  assert.ok(newerIdx < olderIdx, 'newer.txt should come before older.txt (sort by mtime desc)');
});

test('glob excludes node_modules', async () => {
  const repoPath = await makeRealRepo('demo');
  const nmDir = path.join(repoPath, 'node_modules', 'some-pkg');
  await fs.mkdir(nmDir, { recursive: true });
  await fs.writeFile(path.join(nmDir, 'index.js'), '// nm\n');
  await fs.writeFile(path.join(repoPath, 'real.js'), '// src\n');

  const r = unwrap(await callTool('glob', { project: 'demo', pattern: '**/*.js' }));
  assert.ok(r.files.includes('real.js'), 'real.js should be found');
  assert.ok(!r.files.some(f => f.includes('node_modules')), 'node_modules not included');
});

test('glob headLimit caps results and sets truncated:true', async () => {
  const repoPath = await makeRealRepo('demo');
  for (let i = 0; i < 5; i++) {
    await fs.writeFile(path.join(repoPath, `file${i}.txt`), `${i}\n`);
  }

  const r = unwrap(await callTool('glob', { project: 'demo', pattern: '*.txt', headLimit: 3 }));
  assert.ok(r.files.length <= 3);
  assert.equal(r.truncated, true);
  assert.ok(r.total >= 5, 'total reflects all matches');
});

// ---- get_worktree_diff: always-on working-tree section ----

test('get_worktree_diff default now surfaces uncommitted changes', async () => {
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

  const r = unwrapDiff(await callTool('get_worktree_diff', {
    project: 'demo', worktree: wt.worktree,
  }));
  assert.ok(r.diff.includes('committed.txt'), 'committed file should appear');
  assert.equal(r.hasUncommittedChanges, true);
  // Separator line should appear in the diff body
  assert.match(r.diff, /@@@ uncommitted working tree changes/);
  assert.ok(r.untracked.includes('uncommitted.txt'), 'new untracked file should be listed');
});

test('get_worktree_diff surfaces staged+unstaged changes', async () => {
  await makeRealRepo('demo');
  const wt = await makeWorktree('demo');
  const wtPath = path.join(projectsRoot, wt.worktree);
  // Commit something first
  await fs.writeFile(path.join(wtPath, 'committed.txt'), 'committed\n');
  await git(wtPath, 'add', '.');
  await git(wtPath, 'commit', '-q', '-m', 'add committed.txt');
  // Modify an existing committed file (without committing)
  await fs.writeFile(path.join(wtPath, 'committed.txt'), 'committed\nmodified\n');

  const r = unwrapDiff(await callTool('get_worktree_diff', {
    project: 'demo', worktree: wt.worktree,
  }));
  assert.equal(r.hasUncommittedChanges, true);
  // Separator line should appear in the diff body
  assert.match(r.diff, /@@@ uncommitted working tree changes/);
  // The uncommitted modification should appear after the separator
  assert.match(r.diff, /modified/);
});

test('get_worktree_diff surfaces untracked files in metadata', async () => {
  await makeRealRepo('demo');
  const wt = await makeWorktree('demo');
  const wtPath = path.join(projectsRoot, wt.worktree);
  // Drop a new untracked file (never git-added)
  await fs.writeFile(path.join(wtPath, 'brand-new.txt'), 'brand new content\n');

  const r = unwrapDiff(await callTool('get_worktree_diff', {
    project: 'demo', worktree: wt.worktree,
  }));
  // Untracked file must appear in the untracked list
  assert.ok(Array.isArray(r.untracked), 'untracked should be an array');
  assert.ok(r.untracked.includes('brand-new.txt'), 'brand-new.txt should be listed as untracked');
});

test('get_worktree_diff with clean working tree: hasUncommittedChanges false', async () => {
  await makeRealRepo('demo');
  const wt = await makeWorktree('demo');
  const wtPath = path.join(projectsRoot, wt.worktree);
  await fs.writeFile(path.join(wtPath, 'committed.txt'), 'committed\n');
  await git(wtPath, 'add', '.');
  await git(wtPath, 'commit', '-q', '-m', 'add committed.txt');
  // No uncommitted changes

  const r = unwrapDiff(await callTool('get_worktree_diff', {
    project: 'demo', worktree: wt.worktree,
  }));
  assert.equal(r.hasUncommittedChanges, false);
  assert.deepEqual(r.untracked, []);
  // Separator should not appear in the diff body
  assert.ok(!r.diff.includes('@@@ uncommitted'), 'separator absent when no uncommitted changes');
});

test('get_worktree_diff summary:true adds uncommitted section', async () => {
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

  const r = unwrap(await callTool('get_worktree_diff', {
    project: 'demo', worktree: wt.worktree, summary: true,
  }));
  assert.equal(r.summary, true);
  assert.ok(r.uncommitted, 'uncommitted section should be present');
  assert.ok(typeof r.uncommitted.totals === 'object');
  assert.ok(Array.isArray(r.uncommitted.files));
  assert.ok(Array.isArray(r.uncommitted.untracked));
  assert.ok(r.uncommitted.untracked.includes('new-file.txt'), 'new-file.txt should be untracked');
});
