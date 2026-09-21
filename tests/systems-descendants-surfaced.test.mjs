// THE FALLBACK THE USER CAN SEE (D10).
//
// `processGroupSignal` is an OPTIONAL capability. When a provider does not have
// it, cc's signal reaches the direct child only, so a command killed on timeout
// can leave its grandchildren running — the orphaned-`npm ci` failure
// src/groupedCommand.ts's header records. P3 produces the flag, transports it
// and pins it at the protocol layer, but deliberately surfaced it nowhere.
//
// A degraded path the user cannot see is not a fallback: the caller's next move
// depends on knowing the tree it just timed out may still hold a lock, a port
// or the CPU, and nothing else will ever tell them. So the flag reaches every
// place a user or a conductor reads a killed command's result — the bash tools'
// metadata and the post-worktree hook's report.
//
// The assertion is on the FLAG, never on a race against real process death.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { bindRemoteSystem, seedRepo } from './remoteSystem.mjs';
import { adoptProject, projectStoreDir } from '../src/projects.ts';
import { createWorktree } from '../src/worktrees.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';

let nextRpcId = 1;
async function callTool(baseUrl, name, args) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await res.json()).result;
}

// A command that outlives its own timeout (300 ms below), so cc has to kill it
// — but only just, so that on the fallback path, where a grandchild really is
// left behind, it exits by itself well inside the test run rather than being
// swept as an orphan at the end. The assertion is on the FLAG, never on a race
// against process death, so the margin costs nothing.
const SLEEPER = 'sleep 2';

describe('descendantsMaySurvive reaches the surfaces a caller reads', () => {
  let ctx, baseUrl, home, remote;
  before(async () => { ctx = await bootServer(); ({ baseUrl } = ctx); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); ctx.projectsRoot = process.env.PROJECTS_ROOT; });
  afterEach(async () => { await ctx.instances.shutdown(); disposeSystemHandles(); await rmrf(home); });

  async function bindAndAdopt(flags) {
    remote = await bindRemoteSystem({ flags });
    const tree = await seedRepo(path.join(remote.root, 'app'));
    assert.equal((await adoptProject('app', tree, { system: remote.id })).ok, true);
    return tree;
  }

  // PINS: on a provider WITHOUT processGroupSignal, a timed-out project_bash
  // reports descendantsMaySurvive in its metadata block.
  test('project_bash reports it when the provider cannot signal a process group', async () => {
    await bindAndAdopt(['--no-process-group-signal']);
    const r = await callTool(baseUrl, 'project_bash', { project: 'app', command: SLEEPER, timeout: 300 });
    const meta = JSON.parse(r.content[0].text);
    assert.equal(meta.timedOut, true, JSON.stringify(meta));
    assert.equal(meta.exitCode, null);
    assert.equal(meta.descendantsMaySurvive, true,
      'the caller is told the tree it killed may still be running');
  });

  // PINS: the flag is ABSENT — not `false` — when the provider CAN signal the
  // group, so the normal answer costs nothing and its presence always means
  // something happened.
  test('project_bash omits it when the provider can signal the group', async () => {
    await bindAndAdopt([]);
    const r = await callTool(baseUrl, 'project_bash', { project: 'app', command: SLEEPER, timeout: 300 });
    const meta = JSON.parse(r.content[0].text);
    assert.equal(meta.timedOut, true, JSON.stringify(meta));
    assert.equal('descendantsMaySurvive' in meta, false);
  });

  // PINS: it is a TIMEOUT-only fact — a command that exits on its own was never
  // signalled, so nothing may have survived it.
  test('a command that finishes normally never carries the flag', async () => {
    await bindAndAdopt(['--no-process-group-signal']);
    const r = await callTool(baseUrl, 'project_bash', { project: 'app', command: 'echo done' });
    const meta = JSON.parse(r.content[0].text);
    assert.equal('descendantsMaySurvive' in meta, false);
    assert.equal(meta.exitCode, 0);
  });

  // PINS: system_bash reports the flag too — the metadata is computed once for
  // both bash tools, so the pair below plus the project_bash pair above is what
  // makes a regression in that shared half fail on both sides.
  test('system_bash reports it when the provider cannot signal a process group', async () => {
    remote = await bindRemoteSystem({ flags: ['--no-process-group-signal'] });
    const r = await callTool(baseUrl, 'system_bash', {
      system: remote.id, command: SLEEPER, cwd: remote.root, timeout: 300,
    });
    const meta = JSON.parse(r.content[0].text);
    assert.equal(meta.timedOut, true, JSON.stringify(meta));
    assert.equal(meta.exitCode, null);
    assert.equal(meta.descendantsMaySurvive, true,
      'the caller is told the tree it killed may still be running');
  });

  // PINS: and omits it — not `false` — when the provider CAN signal the group,
  // so its presence in a system_bash result always means something happened.
  test('system_bash omits it when the provider can signal the group', async () => {
    remote = await bindRemoteSystem({ flags: [] });
    const r = await callTool(baseUrl, 'system_bash', {
      system: remote.id, command: SLEEPER, cwd: remote.root, timeout: 300,
    });
    const meta = JSON.parse(r.content[0].text);
    assert.equal(meta.timedOut, true, JSON.stringify(meta));
    assert.equal('descendantsMaySurvive' in meta, false);
  });

  // PINS: the post-worktree hook's report carries it too. The hook is the other
  // place cc kills a user-authored command on a timeout, and it is the exact
  // case groupedCommand.ts's header documents (`npm ci` in a fresh worktree).
  test('postWorktreeCreate reports it on a hook that times out', async () => {
    const tree = await bindAndAdopt(['--no-process-group-signal']);
    // The in-tree hook location, read from the system like any project file.
    await fs.mkdir(path.join(tree, '.code-conductor'), { recursive: true });
    await fs.writeFile(path.join(tree, '.code-conductor', 'post-worktree-create.sh'),
      '#!/bin/bash\necho starting\nsleep 2\n');
    const prev = process.env.ORCH_POST_WORKTREE_TIMEOUT_MS;
    process.env.ORCH_POST_WORKTREE_TIMEOUT_MS = '300';
    try {
      const wt = await createWorktree('app', { name: 'feature' });
      const hook = wt.postWorktreeCreate;
      assert.equal(hook.ran, true, JSON.stringify(hook));
      assert.equal(hook.timedOut, true, JSON.stringify(hook));
      assert.equal(hook.descendantsMaySurvive, true,
        'a timed-out hook that may have left an install running says so');
    } finally {
      if (prev === undefined) delete process.env.ORCH_POST_WORKTREE_TIMEOUT_MS;
      else process.env.ORCH_POST_WORKTREE_TIMEOUT_MS = prev;
    }
  });

  // PINS: the hook's report omits it when the group could be signalled — same
  // absent-is-the-normal-answer rule as project_bash.
  test('postWorktreeCreate omits it when the group could be signalled', async () => {
    const tree = await bindAndAdopt([]);
    await fs.mkdir(path.join(tree, '.code-conductor'), { recursive: true });
    await fs.writeFile(path.join(tree, '.code-conductor', 'post-worktree-create.sh'),
      '#!/bin/bash\nsleep 2\n');
    const prev = process.env.ORCH_POST_WORKTREE_TIMEOUT_MS;
    process.env.ORCH_POST_WORKTREE_TIMEOUT_MS = '300';
    try {
      const wt = await createWorktree('app', { name: 'feature' });
      assert.equal(wt.postWorktreeCreate.timedOut, true);
      assert.equal('descendantsMaySurvive' in wt.postWorktreeCreate, false);
    } finally {
      if (prev === undefined) delete process.env.ORCH_POST_WORKTREE_TIMEOUT_MS;
      else process.env.ORCH_POST_WORKTREE_TIMEOUT_MS = prev;
    }
  });
});
