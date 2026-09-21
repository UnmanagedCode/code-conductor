// Tests for MCP inspection-tool additions:
//   project_bash and project_diff's always-on working-tree section.
//
// Mirrors the bootServer + rpc + callTool pattern from mcp-conduct-tools.test.mjs.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, freshProjectsRoot, rmrf, registerLocalProject} from './helpers.mjs';
import { _resetForTest as resetShellEnvCache } from '../src/claudeShellEnv.ts';

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
  await registerLocalProject(name, repoPath);
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
// Same, with a slug — so the worktree can also be addressed by its bare name.
async function makeWorktreeNamed(project, name) {
  const result = await callTool('create_worktree', { project, name });
  return JSON.parse(result.content[0].text);
}

// ---- project_bash ----
//
// project_bash's own claudeShellEnv.ts spawn is a separate codepath from the
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
    fs.writeFileSync(m[1], 'export CLAUDE_CODE_EXECPATH=/fake/claude\\nexport CLAUDE_CODE_SHELL_KIND=bash\\nrg() { echo "RG-SHIM-CALLED $*"; }\\n');
  }
  process.exit(0);
});
`;

// Simulates a zsh-hosted capture: the canned bundle is tagged
// CLAUDE_CODE_SHELL_KIND=zsh and, ahead of the rg shim, embeds a genuine
// zsh-only construct (an oh-my-zsh-style `(#b)` extended-glob backreference)
// that is valid zsh but a hard *syntax* error under bash — verified: sourcing
// this with plain bash aborts with "syntax error near '(#'" before ever
// reaching the rg() definition, reproducing the real-world bug exactly.
// project_bash must spawn zsh (not bash) to source it, or rg never fires.
const FAKE_CLAUDE_SHELL_ENV_SCRIPT_ZSH = `
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
    fs.writeFileSync(m[1], [
      'export CLAUDE_CODE_EXECPATH=/fake/claude',
      'export CLAUDE_CODE_SHELL_KIND=zsh',
      '_ohmyzsh_internal_helper() {',
      '  local MATCH MBEGIN MEND',
      '  [[ "foo" = (#b)(f)(oo) ]] && echo "matched $match[1]"',
      '}',
      'rg() { echo "RG-SHIM-CALLED $*"; }',
      '',
    ].join('\\n'));
  }
  process.exit(0);
});
`;

function hasZsh() {
  // spawnSync does NOT throw on a missing binary — on ENOENT it returns a
  // result object with `.error` set and `.status === null`. Inspect the result
  // instead of relying on a throw, or the guard reports zsh present everywhere.
  const res = spawnSync('zsh', ['--version'], { stdio: 'ignore' });
  return !res.error && res.status === 0;
}

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
    const wtPath = wt.worktreePath;
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
    // The IN-BAND marker, not just the flag: a caller reading the text has to be
    // able to see where the body was cut. Its twin on system_bash is in
    // tests/systems-remote-refusals.test.mjs, so a regression in the one shared
    // payload helper fails on both bash tools.
    assert.ok(r.output.endsWith('… [truncated at the output cap]'),
      `the capped body must carry the marker; ends with ${JSON.stringify(r.output.slice(-60))}`);
  });

  test('project_bash rejects an empty command', async () => {
    await makeRealRepo('demo');
    const { body } = await rpc('tools/call', {
      name: 'project_bash', arguments: { project: 'demo', command: '' },
    });
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /non-empty/i);
  });

  test('project_bash accepts a description without changing what runs or what comes back', async () => {
    await makeRealRepo('demo');
    const withDesc = unwrapBash(await callTool('project_bash', {
      project: 'demo', command: 'echo still-sync', description: 'echo a marker',
    }));
    const withoutDesc = unwrapBash(await callTool('project_bash', {
      project: 'demo', command: 'echo still-sync',
    }));
    assert.match(withDesc.output, /still-sync/);
    assert.equal(withDesc.exitCode, 0);
    assert.equal(withDesc.exitCode, withoutDesc.exitCode);
    assert.equal(withDesc.cwd, withoutDesc.cwd);
    assert.equal(withDesc.output, withoutDesc.output);
    assert.equal('description' in withDesc, false, 'description is not echoed back in the metadata');
  });

  test('project_bash rejects a non-string description', async () => {
    await makeRealRepo('demo');
    const { body } = await rpc('tools/call', {
      name: 'project_bash', arguments: { project: 'demo', command: 'echo hi', description: 42 },
    });
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /argument 'description' must be string/);
  });

  // The canonical-echo invariant (docs/protocol.md -> Input params): a response
  // reports the full `<project>_worktree_<slug>` name, never the spelling the
  // caller addressed the worktree with. project_bash builds THREE separate
  // metadata objects — normal close, spawn-`error`, and the synchronous
  // spawn-throw catch — so each is pinned on its own below. Homed here rather
  // than in mcp.test.mjs because these need the fake-CLAUDE_BIN shell-env
  // fixture above; without it the bundle generation shells out to a live
  // `claude -p`, which is both slow and red on a proxy-auth host.
  test('project_bash echoes the canonical worktree name on the normal-exit path', async () => {
    await makeRealRepo('demo');
    const wt = await makeWorktreeNamed('demo', 'echoalias');
    assert.equal(wt.worktree, 'echoalias');

    const ok = unwrapBash(await callTool('project_bash', {
      project: 'demo', worktree: 'echoalias', command: 'echo hi',
    }));
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.worktree, 'echoalias');

    // A non-zero exit takes the same close handler, and the full spelling is
    // unchanged — this is a canonicalization, not a rename.
    const failed = unwrapBash(await callTool('project_bash', {
      project: 'demo', worktree: 'echoalias', command: 'exit 3',
    }));
    assert.equal(failed.exitCode, 3);
    assert.equal(failed.worktree, 'echoalias');
  });

  // The async `error` event: reached by removing the checkout while its git
  // registration + store record survive, so getWorktree still resolves but the
  // cwd ENOENTs on spawn.
  test('project_bash echoes the canonical worktree name on the spawn-error path', async () => {
    await makeRealRepo('demo');
    const wt = await makeWorktreeNamed('demo', 'erroralias');
    await fs.rm(wt.worktreePath, { recursive: true, force: true });

    const errored = unwrapBash(await callTool('project_bash', {
      project: 'demo', worktree: 'erroralias', command: 'echo hi',
    }));
    assert.equal(errored.error, true, 'the spawn-error path is the one exercised');
    assert.equal(errored.worktree, 'erroralias');
  });

  // The SYNCHRONOUS spawn-throw catch. `wrapped` interpolates the raw caller
  // `command` into spawnArgs, and Node rejects a NUL byte in a spawn argument
  // with a synchronous ERR_INVALID_ARG_VALUE — unlike a missing binary or a bad
  // cwd, which surface asynchronously via the `error` event above. So this is
  // the one input that reaches the catch, and the echo there is observable.
  test('project_bash echoes the canonical worktree name on the synchronous spawn-throw path', async () => {
    await makeRealRepo('demo');
    const wt = await makeWorktreeNamed('demo', 'nulalias');
    assert.equal(wt.worktree, 'nulalias');

    const thrown = unwrapBash(await callTool('project_bash', {
      project: 'demo', worktree: 'nulalias', command: 'echo a\u0000b',
    }));
    assert.equal(thrown.error, true, 'the synchronous spawn-throw path is the one exercised');
    assert.equal(thrown.exitCode, null);
    assert.equal(thrown.worktree, 'nulalias');
  });
});

describe('project_bash with a zsh-flavored bundle', { skip: !hasZsh() && 'zsh not available on this host' }, () => {
  let fakeBinPath, prevClaudeBin;

  before(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-fake-claude-shellenv-zsh-'));
    fakeBinPath = path.join(dir, 'fake-claude.js');
    await fs.writeFile(fakeBinPath, FAKE_CLAUDE_SHELL_ENV_SCRIPT_ZSH, 'utf8');
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

  // Regression test for the real bug: today's hardcoded `spawn('bash', ...)`
  // would choke on the `(#b)` zsh-only syntax before ever reaching the rg()
  // definition, so this fails against the pre-fix code and passes once
  // bashProject() dispatches to zsh for a zsh-tagged bundle.
  test('project_bash spawns zsh to source a zsh-flavored bundle (rg shim fires despite bash-hostile syntax)', async () => {
    await makeRealRepo('demo-zsh');
    const r = unwrapBash(await callTool('project_bash', { project: 'demo-zsh', command: 'rg foo' }));
    assert.match(r.output, /RG-SHIM-CALLED foo/);
    assert.equal(r.exitCode, 0);
  });
});

// ---- project_diff: always-on working-tree section ----

test('project_diff default now surfaces uncommitted changes', async () => {
  await makeRealRepo('demo');
  const wt = await makeWorktree('demo');
  const wtPath = wt.worktreePath;
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
  const wtPath = wt.worktreePath;
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
  const wtPath = wt.worktreePath;
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
  const wtPath = wt.worktreePath;
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
  const wtPath = wt.worktreePath;
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

// system_bash addresses a REGISTERED SYSTEM directly, with no project in play.
// The three refusals below all fire BEFORE the system is resolved, so none of
// them needs a live provider — which is the whole reason they are homed here
// rather than in the systems suites.
describe('system_bash refuses before it resolves a system', () => {
  // PINS: system:'local' is refused by its own code rather than silently
  // running on cc's own machine. Asserting the exact code (not merely that a
  // code is present) is what distinguishes it from codeForStatus(400)'s generic
  // BAD_REQUEST — i.e. it pins that the handler raises a NAMED refusal.
  test('system_bash refuses system:"local" by name', async () => {
    const result = await callTool('system_bash', { system: 'local', command: 'echo hi' });
    assert.equal(result.isError, true, JSON.stringify(result));
    const structured = JSON.parse(result.content[1].text);
    assert.equal(structured.code, 'SYSTEM_IS_LOCAL', JSON.stringify(structured));
    assert.equal(structured.statusCode, 400);
    assert.match(result.content[0].text, /local/);
  });

  // PINS THE ORDERING, not merely the refusal: `refbox` is NOT registered in
  // this suite, so a cwd check placed after systemById would answer
  // SYSTEM_NOT_REGISTERED here. Asserting CWD_NOT_ABSOLUTE is therefore the
  // proof that the argument is rejected before a provider process is launched.
  // A later reorder fails this test rather than passing silently.
  test('system_bash refuses a relative cwd before resolving the system', async () => {
    const result = await callTool('system_bash', { system: 'refbox', command: 'pwd', cwd: 'sub/dir' });
    assert.equal(result.isError, true, JSON.stringify(result));
    const structured = JSON.parse(result.content[1].text);
    assert.equal(structured.code, 'CWD_NOT_ABSOLUTE', JSON.stringify(structured));
    assert.equal(structured.statusCode, 400);
    assert.match(result.content[0].text, /sub\/dir/);
  });

  // PINS: systemById's refusal family reaches the caller UNFLATTENED — its own
  // code and status, not a 500 or a reshaped message. bashSystem must not catch
  // it: it has no structured refusal vocabulary of its own to convert it into.
  test('system_bash surfaces SYSTEM_NOT_REGISTERED with its own code and status', async () => {
    const result = await callTool('system_bash', { system: 'nope', command: 'echo hi' });
    assert.equal(result.isError, true, JSON.stringify(result));
    const structured = JSON.parse(result.content[1].text);
    assert.equal(structured.code, 'SYSTEM_NOT_REGISTERED', JSON.stringify(structured));
    assert.equal(structured.statusCode, 501);
    assert.match(result.content[0].text, /nope/);
  });

  // PINS: system_bash declares its OWN argument set — `system` is required and
  // `project` is not a parameter — so it cannot have inherited project_bash's
  // schema by copy-paste.
  test('system_bash requires `system` and rejects a project argument', async () => {
    const missing = await callTool('system_bash', { command: 'echo hi' });
    assert.equal(missing.isError, true, JSON.stringify(missing));
    assert.match(missing.content[0].text, /missing required argument: system/);

    const extra = await callTool('system_bash', { system: 'x', command: 'y', project: 'demo' });
    assert.equal(extra.isError, true, JSON.stringify(extra));
    assert.match(extra.content[0].text, /unexpected argument 'project'/);
  });
});
