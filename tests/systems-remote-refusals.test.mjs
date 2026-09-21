// WHAT A REMOTE PROJECT REFUSES, AND WHY EACH REFUSAL IS NAMED.
//
// Two families, both of which have to be refusals rather than silent
// degradations:
//
//   * FAILURE STATES (R9) — a system cc cannot reach. The listing keeps the row
//     and says why (pinned in systems-listing-degrade.test.mjs); every
//     addressed-by-name path refuses instead, and each place that already had a
//     structured refusal vocabulary gets its own code rather than throwing
//     through a caller that was promised a value.
//
//   * BUCKET 3 — features that stay local-only by design. Each returns a NAMED
//     code, so a caller can tell "cc will not do this here" from "this broke",
//     and the affordance is hidden rather than offered and then failing.
//
// The plugin cases are the seventh site, beyond the six that earlier phases
// marked: `readManifest(p.path)` was a bare LOCAL `fs.readFile` against a path
// string that, for a remote project, names a directory on another machine. That
// does not no-op — it reads THIS machine's file at that path and succeeds. Each
// plugin test below plants a decoy at the local spelling of the remote path, so
// it fails if the wrong-machine read comes back.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import { bindRemoteSystem, seedRepo, git, referenceLaunch } from './remoteSystem.mjs';
import { adoptProject, listProjects, orchStoreRoot, projectsRoot, projectStoreDir } from '../src/projects.ts';
import { createWorktree, mergeWorktreeIntoParent } from '../src/worktrees.ts';
import { addSystem, updateSystem } from '../src/appSettings.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';

let nextRpcId = 1;
async function callTool(baseUrl, name, args) {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  return body.result;
}

// The provider that is unreachable while a gate FILE exists — the only way to
// register a system successfully (addSystem probes the launch command) and then
// have it stop answering without changing anything cc can see.
const GATED = path.join(import.meta.dirname, 'fixtures', 'gatedProvider.mjs');

async function exists(p) {
  try { await fs.lstat(p); return true; } catch { return false; }
}

describe('a remote project refuses what it cannot do, by name', () => {
  let ctx, baseUrl, instances, home, remote;
  before(async () => { ctx = await bootServer(); ({ baseUrl, instances } = ctx); });
  after(async () => { await ctx.close(); });
  beforeEach(async () => {
    ({ home } = await freshProjectsRoot());
    ctx.projectsRoot = process.env.PROJECTS_ROOT;
    remote = await bindRemoteSystem();
  });
  afterEach(async () => {
    await ctx.instances.shutdown();
    disposeSystemHandles();
    await rmrf(home);
  });

  async function adoptRemote(name = 'app') {
    const tree = await seedRepo(path.join(remote.root, name));
    const r = await adoptProject(name, tree, { system: remote.id });
    assert.equal(r.ok, true, JSON.stringify(r));
    return tree;
  }

  // ── Failure state: at session start ──────────────────────────────────

  // PINS CRITERION 8: a worker on a remote project runs at the project's REAL
  // PATH ON ITS SYSTEM, and the store holds no session root at all. A cc-owned
  // session root under the store is the second spelling of the project's tree —
  // the thing this whole change exists to remove.
  test('spawning a worker on a remote project runs it at the path on the system', async () => {
    await adoptRemote();
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const inst = instances.get(r.body.id);
    assert.equal(inst.cwd, path.join(remote.root, 'app'), "the CLI's cwd is the tree on the system");
    // The store's session-root geometry is GONE, not merely unused: a directory
    // here would mean something still composes one.
    assert.equal(await exists(path.join(orchStoreRoot(), 'systems', remote.id, 'sessions')), false,
      'a session root was composed under the store');
    assert.equal(await exists(path.join(projectsRoot(), 'app')), false,
      'and no local directory was conjured under the projects root');
  });

  // PINS: the same on the MCP surface a conductor drives, and that the session
  // really is redirected — an instance with no redirect would answer every file
  // tool from cc's own disk.
  test('spawn_instance runs a remote project redirected', async () => {
    await adoptRemote();
    const r = await callTool(baseUrl, 'spawn_instance', { project: 'app' });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    const inst = [...instances.byId.values()][0];
    assert.ok(inst._redirect, 'the session carries a redirection policy');
    assert.equal(inst._redirect.systemPath, path.join(remote.root, 'app'));
  });

  // PINS: A REDIRECTED SESSION'S BOUNDARY IS ITS CWD, NOT THE PROJECT ROOT.
  //
  // `systemPath` names two disjoint things and both are strings, so conflating
  // them typechecks and fails at runtime: on the project RECORD it is where the
  // project is, and on a `RedirectPlacement` it is the SESSION's cwd — the
  // project path OR the worktree path, whichever the session runs in. A rename
  // that folded the second into the first would repoint the union's remote tier
  // and the tool-redirect boundary at the project root for every worktree
  // session, and serve that as correct.
  test('a WORKTREE session on a remote project is redirected at the worktree, not the project', async () => {
    const tree = await adoptRemote();
    const { createWorktree } = await import('../src/worktrees.ts');
    const wt = await createWorktree('app', { name: 'feature' });
    assert.notEqual(wt.worktreePath, tree, 'premise: the two paths differ');

    const r = await callTool(baseUrl, 'spawn_instance', { project: 'app', worktree: wt.worktreeName });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    const inst = [...instances.byId.values()][0];
    assert.ok(inst._redirect, 'the session carries a redirection policy');
    assert.equal(inst._redirect.systemPath, wt.worktreePath);
    assert.notEqual(inst._redirect.systemPath, tree);
  });

  // PINS: a `Bash(...)` permission rule the redirected forwarder would silently
  // void REFUSES the spawn, naming the rule and its file. Measured against the
  // real CLI: such a rule IS enforced under bypassPermissions, and rules match
  // the post-hook input — so after the rewrite it would apply to nothing.
  test('a Bash pattern rule the redirection would void refuses the spawn', async () => {
    const tree = await adoptRemote();
    await fs.mkdir(path.join(tree, '.claude'), { recursive: true });
    await fs.writeFile(path.join(tree, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }));

    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app' });
    assert.equal(r.status, 501, JSON.stringify(r.body));
    assert.match(r.body.error, /BASH_RULES_NOT_ENFORCEABLE/);
    assert.match(r.body.error, /Bash\(rm:\*\)/);
    assert.equal(instances.list().length, 0, 'nothing was spawned');
  });

  // PINS: a LOCAL project is unaffected by the guard — the refusal is about the
  // placement, not about spawning.
  test('spawning on a local project still works', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'localone' });
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'localone' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(instances.list().length, 1);
  });

  // ── Failure state: mid-session ───────────────────────────────────────

  // PINS: a system that stops answering mid-session refuses every addressed
  // project tool with a message naming the system — never an empty result that
  // reads as "the directory is empty" or "the file is not there".
  test('a system that goes away mid-session refuses each project tool by name', async () => {
    await adoptRemote();
    await createWorktree('app', { name: 'feature' });
    // It worked a moment ago.
    assert.equal((await callTool(baseUrl, 'project_status', { project: 'app' })).isError, undefined);
    // Now the system has no way to be reached.
    disposeSystemHandles();
    await updateSystem(remote.id, { launch: null });

    for (const [tool, args] of [
      ['project_status', { project: 'app' }],
      ['project_read', { project: 'app', relativePath: 'README.md' }],
      ['project_diff', { project: 'app', worktree: 'feature' }],
      ['project_bash', { project: 'app', command: 'echo hi' }],
    ]) {
      const r = await callTool(baseUrl, tool, args);
      assert.equal(r.isError, true, `${tool} must refuse: ${JSON.stringify(r)}`);
      assert.match(r.content[0].text, new RegExp(remote.id), `${tool} names the system`);
    }
  });

  // ── Failure state: unreachable AT ENTRY, on the merge path ───────────
  //
  // These two pin the ENTRY guard only: the system is already gone before the
  // call, so the refusal comes from resolution rather than from a step that
  // died mid-flight. The mid-OPERATION cases — including the merge that may
  // have completed on the far side — are in
  // tests/systems-mid-operation-death.test.mjs, which needs a provider that
  // dies while working rather than one that was never there.

  // PINS: an unreachable system reaches mergeWorktreeIntoParent as a STRUCTURED
  // refusal carrying its own code, not as a throw. Every other blocker there is
  // a returned {ok:false, code}, and callers render the code — one that threw
  // instead would surface as a 500 with no code to render.
  test('a merge on a system unreachable AT ENTRY returns SYSTEM_UNREACHABLE, not a throw', async () => {
    const tree = await adoptRemote();
    await createWorktree('app', { name: 'feature' });
    await fs.writeFile(path.join(tree, '..', 'x'), 'x').catch(() => {});
    disposeSystemHandles();
    await updateSystem(remote.id, { launch: null });

    const r = await mergeWorktreeIntoParent('app', 'feature');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SYSTEM_UNREACHABLE');
    assert.match(r.reason, new RegExp(remote.id));
  });

  // PINS: the merge refusal survives the MCP surface as a rendered refusal
  // rather than a tool error, which is what lets a conductor act on it.
  test('merge_worktree renders the at-entry SYSTEM_UNREACHABLE refusal', async () => {
    await adoptRemote();
    await createWorktree('app', { name: 'feature' });
    disposeSystemHandles();
    await updateSystem(remote.id, { launch: null });
    const r = await callTool(baseUrl, 'merge_worktree', { project: 'app', worktree: 'feature' });
    const text = r.content.map(c => c.text).join('\n');
    assert.match(text, /SYSTEM_UNREACHABLE/, text);
  });

  // ── Bucket 3: the store-sourced post-worktree hook ───────────────────

  // PINS: a hook script that lives in cc's OWN STORE is not run on a remote
  // system. The argv would be a path that exists only on cc's machine — best
  // case an exit-127 wearing the shape of a broken hook, worst case a file that
  // happens to exist at that spelling on the system runs INSTEAD. The marker is
  // what proves it: the reference provider IS this machine, so a hook that
  // still ran would find the script and leave the marker behind.
  test('a store-sourced post-worktree hook refuses on a remote project', async () => {
    await adoptRemote();
    const marker = path.join(home, 'store-hook-ran');
    await fs.mkdir(projectStoreDir('app'), { recursive: true });
    await fs.writeFile(path.join(projectStoreDir('app'), 'post-worktree-create.sh'),
      `#!/bin/bash\ntouch ${JSON.stringify(marker)}\n`);

    const wt = await createWorktree('app', { name: 'feature' });
    const hook = wt.postWorktreeCreate;
    assert.equal(hook.ran, false, JSON.stringify(hook));
    assert.equal(hook.source, 'store', 'the report names which hook was found');
    assert.equal(hook.skipped, 'STORE_HOOK_LOCAL_ONLY',
      'and why it did not run — a hook that silently does nothing is the defect restated');
    assert.equal(await exists(marker), false, 'the script really did not execute anywhere');
  });

  // PINS: an IN-TREE hook still runs on a remote project — it is already on the
  // system, so nothing about it is local-only. Without this the refusal above
  // could be implemented by disabling the hook wholesale.
  test('an in-tree post-worktree hook still runs on a remote project', async () => {
    const tree = await adoptRemote();
    await fs.mkdir(path.join(tree, '.code-conductor'), { recursive: true });
    await fs.writeFile(path.join(tree, '.code-conductor', 'post-worktree-create.sh'),
      '#!/bin/bash\necho in-tree-hook-ran\n');

    const wt = await createWorktree('app', { name: 'feature' });
    const hook = wt.postWorktreeCreate;
    assert.equal(hook.ran, true, JSON.stringify(hook));
    assert.equal(hook.source, 'in-tree');
    assert.equal(hook.exitCode, 0);
    assert.match(hook.output, /in-tree-hook-ran/);
  });

  // PINS: a store-sourced hook on a LOCAL project is untouched — the refusal is
  // about the placement, not about the store as a hook source.
  test('a store-sourced hook still runs on a local project', async () => {
    await api(baseUrl, 'POST', '/api/projects', { name: 'localone' });
    const dir = path.join(projectsRoot(), 'localone');
    await git(dir, 'config', 'user.email', 'test@example.com');
    await git(dir, 'config', 'user.name', 'Test');
    await fs.writeFile(path.join(dir, 'f.txt'), 'x\n');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'initial');
    await fs.mkdir(projectStoreDir('localone'), { recursive: true });
    await fs.writeFile(path.join(projectStoreDir('localone'), 'post-worktree-create.sh'),
      '#!/bin/bash\necho store-hook-ran\n');

    const wt = await createWorktree('localone', { name: 'feature' });
    assert.equal(wt.postWorktreeCreate.ran, true, JSON.stringify(wt.postWorktreeCreate));
    assert.equal(wt.postWorktreeCreate.source, 'store');
    assert.match(wt.postWorktreeCreate.output, /store-hook-ran/);
  });

  // ── Bucket 3: plugins (the SEVENTH site) ─────────────────────────────

  // PINS THE WRONG-MACHINE READ: plugin discovery reads the manifest through the
  // project's System. The decoy is a manifest planted at cc's OWN spelling of
  // the remote path — if discovery still used a bare local `fs.readFile`, it
  // would find the decoy and register a plugin that does not exist on the
  // system.
  test('plugin discovery reads the manifest on the system, never the local path', async () => {
    // A remote project whose systemPath is a path that ALSO exists locally, with
    // different content. Only a read on the wrong machine can see the decoy.
    const collidingPath = path.join(home, 'collide');
    await fs.mkdir(collidingPath, { recursive: true });
    await fs.writeFile(path.join(collidingPath, 'conductor.plugin.json'), JSON.stringify({
      id: 'decoy', name: 'Decoy', version: '1.0.0', pluginApi: 1,
      backend: { start: 'echo should-never-run' },
    }));
    // The project is registered at that path ON THE SYSTEM — where the reference
    // provider (this machine) will find the very same file, so a plain
    // "did it find a manifest" test could not tell the two apart. The
    // discriminator is the NEXT test's refusal; this one pins that the read goes
    // through the seam at all, by making the system unreachable and asserting
    // discovery does not fall back to the local file.
    await fs.mkdir(projectStoreDir('collide'), { recursive: true });
    await fs.writeFile(path.join(projectStoreDir('collide'), 'project.json'),
      JSON.stringify({ system: 'ghostbox', systemPath: collidingPath }));

    const r = await api(baseUrl, 'GET', '/api/plugins');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rows = r.body.rows;
    assert.equal(rows.some(p => p.id === 'decoy'), false,
      'a project on an unreachable system contributes no plugin read from cc\'s own disk');
  });

  // PINS: a plugin whose project is on a system is DISCOVERED (its manifest is
  // really there) but its backend is refused with its own code, and the row says
  // so — rather than starting a process on cc's machine in a directory that
  // belongs to another one.
  test('a plugin backend on a remote project refuses PLUGIN_BACKEND_LOCAL_ONLY', async () => {
    const tree = await adoptRemote('pluginproj');
    await fs.writeFile(path.join(tree, 'conductor.plugin.json'), JSON.stringify({
      id: 'remoteplug', name: 'Remote Plug', version: '1.0.0', pluginApi: 1,
      backend: { start: 'echo should-never-run' },
    }));

    // The manifest was written after the project was adopted, and discovery is
    // memoized per projects root — rescan is the same gesture the Plugins page
    // offers for exactly this.
    await api(baseUrl, 'POST', '/api/plugins/rescan');
    const listed = await api(baseUrl, 'GET', '/api/plugins');
    const rows = listed.body.rows;
    const row = rows.find(p => p.id === 'remoteplug');
    assert.ok(row, `the plugin is discovered: ${JSON.stringify(rows)}`);
    assert.equal(row.system, remote.id, 'the row names the system its project is on');
    assert.deepEqual(row.localOnly, ['PLUGIN_BACKEND_LOCAL_ONLY'],
      'and carries the code, so the UI can hide the start control instead of offering it');

    await api(baseUrl, 'POST', '/api/plugins/remoteplug/enable');
    const started = await api(baseUrl, 'POST', '/api/plugins/remoteplug/start');
    assert.equal(started.status, 501, JSON.stringify(started.body));
    assert.match(started.body.error, /PLUGIN_BACKEND_LOCAL_ONLY/);
    assert.match(started.body.error, new RegExp(remote.id));
  });

  // PINS: the repo-tracked `claudePlugin` contribution is NOT loaded for a
  // remote project. A `--plugin-dir` root must be an absolute LOCAL directory,
  // and handing the CLI a path on another machine would either fail or, worse,
  // load whatever sits at that path here.
  test('a repo-tracked claudePlugin dir on a remote project is not contributed', async () => {
    const tree = await adoptRemote('pluginproj');
    // A real, loadable plugin dir, so the only reason it is not contributed is
    // the placement — not a missing `.claude-plugin/plugin.json`.
    await fs.mkdir(path.join(tree, 'cc-plugin', '.claude-plugin'), { recursive: true });
    await fs.writeFile(path.join(tree, 'cc-plugin', '.claude-plugin', 'plugin.json'), '{"name":"x"}');
    await fs.writeFile(path.join(tree, 'conductor.plugin.json'), JSON.stringify({
      id: 'remoteplug', name: 'Remote Plug', version: '1.0.0', pluginApi: 1,
      claudePlugin: 'cc-plugin',
    }));
    await api(baseUrl, 'POST', '/api/plugins/rescan');
    await api(baseUrl, 'POST', '/api/plugins/remoteplug/enable');

    const listed = await api(baseUrl, 'GET', '/api/plugins');
    const rows = listed.body.rows;
    const row = rows.find(p => p.id === 'remoteplug');
    assert.ok(row);
    assert.deepEqual(row.localOnly, ['PLUGIN_DIR_LOCAL_ONLY'],
      'the row says the contribution is not loaded, and why');

    const dirs = await ctx.pluginHost.claudePluginDirs();
    assert.deepEqual(dirs, [], 'no --plugin-dir root points at another machine');
  });

  // ── A system addressed DIRECTLY: system_bash, no project in play ─────
  //
  // Everything above reaches a system THROUGH a project placed on it. These
  // reach the same system with nothing placed on it at all, which is the whole
  // reason the tool exists — a box has to be inspectable before cc commits a
  // project to it.

  // PINS: a command runs on a registered system with no project registered
  // anywhere. The empty project listing and the empty instance registry are the
  // load-bearing half: without them this would only show "no project NAMED",
  // which a project_bash with a default could also produce.
  test('system_bash runs a command on a system with no project in play', async () => {
    const result = await callTool(baseUrl, 'system_bash', {
      system: remote.id, command: 'echo hi', cwd: remote.root,
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const meta = JSON.parse(result.content[0].text);
    assert.equal(meta.system, remote.id);
    assert.equal(meta.remoteId, null);
    assert.equal(meta.cwd, remote.root);
    assert.equal(meta.exitCode, 0, JSON.stringify(meta));
    // EXACT, not trimmed: the body is trailing-trimmed once, by bashPayload. A
    // test that trims its own side would accept a payload that shipped the raw
    // `echo` newline through to the caller.
    assert.equal(result.content[1].text, 'hi');
    assert.deepEqual(await listProjects(), [], 'nothing was registered as a project');
    assert.deepEqual(instances.list(), [], 'and no worker was spawned to carry the command');
  });

  // PINS: the default cwd is `/` — the one path docs/systems-protocol.md §7
  // requires every conforming provider to accept. Both halves are asserted
  // deliberately: the metadata echo (what the caller is told) and the body
  // (what the shell on the far side actually saw).
  test('system_bash defaults cwd to / when none is given', async () => {
    const result = await callTool(baseUrl, 'system_bash', { system: remote.id, command: 'pwd' });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const meta = JSON.parse(result.content[0].text);
    assert.equal(meta.cwd, '/');
    assert.equal(result.content[1].text.trim(), '/');
  });

  // PINS: an explicit `cwd: null` is accepted and means `/`, the same thing an
  // omitted one means — the contract its sibling `remoteId` has, and the one the
  // tool description advertises. Narrowing the schema back to a bare string
  // would refuse it at validation with "argument 'cwd' must be string"; dropping
  // the handler's default would carry the null into path.isAbsolute.
  test('system_bash accepts an explicit null cwd and runs in /', async () => {
    const result = await callTool(baseUrl, 'system_bash', {
      system: remote.id, command: 'pwd', cwd: null,
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const meta = JSON.parse(result.content[0].text);
    assert.equal(meta.cwd, '/', 'the metadata echoes the default');
    assert.equal(result.content[1].text, '/', 'and that is where the shell actually ran');
  });

  // PINS: an empty-string remoteId means the provider's own DEFAULT target, the
  // same normalisation set_project_remote uses and the same thing an omitted one
  // means. Without it `''` takes systemById's named-target path and this
  // reference provider — which advertises no remotes — answers SYSTEM_NO_REMOTES
  // instead of running the command: a misroute reported as a refusal.
  test('system_bash treats an empty remoteId as the default target', async () => {
    const result = await callTool(baseUrl, 'system_bash', {
      system: remote.id, remoteId: '', command: 'echo hi', cwd: remote.root,
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const meta = JSON.parse(result.content[0].text);
    assert.equal(meta.remoteId, null, 'the metadata reports the default target, not the empty string');
    assert.equal(meta.exitCode, 0, JSON.stringify(meta));
    assert.equal(result.content[1].text, 'hi');
  });

  // PINS: the body is trimmed at its TRAILING end ONLY. `content[1]` is
  // documented as the raw combined stdout+stderr, so leading whitespace is the
  // command's output and has to survive — a trim of both ends would eat it, and
  // an `echo hi` body cannot tell the two apart.
  test('system_bash trims the trailing end of the body and nothing else', async () => {
    const result = await callTool(baseUrl, 'system_bash', {
      system: remote.id, command: "printf '\\n  hi\\n'", cwd: remote.root,
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.content[1].text, '\n  hi');
  });

  // PINS: the metadata keys the tool DESCRIPTION advertises are the keys
  // bashPayload actually emits. The description's key set is a hand-typed
  // literal; tests/mcp.test.mjs pins the two tools' literals against each other,
  // which cannot catch a rename in the payload that neither description follows.
  //
  // The emitted set is OBSERVED, never reflected out of the source: five calls
  // cover every branch of bashPayload — the plain close, the output cap, a
  // timeout, a timeout on a provider that cannot signal the group, and a command
  // that never started. project_bash's half of the claim is covered elsewhere and
  // not here: its shared keys ride on the cross-description equality in
  // tests/mcp.test.mjs, and its two identity keys (`project`, `worktree`) are
  // observed by the canonical-echo tests in tests/mcp-inspect-tools.test.mjs.
  test('system_bash advertises exactly the metadata keys its payload emits', async () => {
    const nopg = await bindRemoteSystem({ id: 'nopgbox', flags: ['--no-process-group-signal'] });
    const keysOf = async (args) => {
      const r = await callTool(baseUrl, 'system_bash', args);
      assert.equal(r.isError, undefined, JSON.stringify(r));
      return Object.keys(JSON.parse(r.content[0].text));
    };
    const observed = new Set([
      ...await keysOf({ system: remote.id, command: 'echo hi', cwd: remote.root }),
      ...await keysOf({ system: remote.id, command: 'yes x | head -c 300000', cwd: remote.root }),
      ...await keysOf({ system: remote.id, command: 'sleep 2', cwd: remote.root, timeout: 300 }),
      ...await keysOf({ system: nopg.id, command: 'sleep 2', cwd: nopg.root, timeout: 300 }),
      // A cwd that is absolute and not there: the command never starts, which is
      // the only way to reach the spawn-error payload.
      ...await keysOf({ system: remote.id, command: 'echo hi', cwd: path.join(remote.root, 'no-such-dir') }),
    ]);
    for (const k of ['truncated', 'timedOut', 'descendantsMaySurvive', 'error']) {
      assert.ok(observed.has(k), `the ${k} branch of bashPayload was never reached — the fixture is stale`);
    }

    const res = await fetch(baseUrl + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9001, method: 'tools/list' }),
    });
    const tool = (await res.json()).result.tools.find(t => t.name === 'system_bash');
    const m = /metadata block \(content\[0\]\) \{([^}]*)\}/.exec(tool.description);
    assert.ok(m, `the description states its metadata block: ${tool.description}`);
    // `?` marks a key as optional in the description; it is not part of the name.
    const advertised = m[1].split(',').map(k => k.trim().replace(/\?$/, ''));

    assert.deepEqual([...observed].sort(), advertised.sort());
  });

  // PINS: output past the cap is marked IN THE BODY, not only by the metadata
  // flag — a caller reading the text has to be able to see where it was cut. The
  // command still runs to completion (exitCode 0), so the marker means
  // "truncated", never "killed". system_bash's own truncation path, so a
  // regression in the one shared payload helper fails on both bash tools.
  test('system_bash marks a capped body in the text, and lets the command finish', async () => {
    const result = await callTool(baseUrl, 'system_bash', {
      system: remote.id, command: 'yes x | head -c 300000', cwd: remote.root,
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const meta = JSON.parse(result.content[0].text);
    assert.equal(meta.truncated, true, JSON.stringify(meta));
    assert.equal(meta.exitCode, 0, 'drained to completion, not killed on the cap');
    const body = result.content.slice(1).map(c => c.text).join('');
    assert.ok(body.endsWith('… [truncated at the output cap]'),
      `the capped body must carry the marker; ends with ${JSON.stringify(body.slice(-60))}`);
  });

  // PINS: a non-zero exit is the command's ANSWER, not a tool failure — the
  // caller reads exitCode rather than retrying.
  test('system_bash reports a non-zero exit as a normal result', async () => {
    const result = await callTool(baseUrl, 'system_bash', { system: remote.id, command: 'exit 3' });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(JSON.parse(result.content[0].text).exitCode, 3);
  });

  // PINS: a system whose provider command was cleared refuses SYSTEM_NO_PROVIDER
  // (501) through system_bash, carrying its own code — the same refusal a
  // project on it would get, reached with no project involved.
  test('system_bash refuses SYSTEM_NO_PROVIDER when the system has no launch command', async () => {
    disposeSystemHandles();
    await updateSystem(remote.id, { launch: null });
    const result = await callTool(baseUrl, 'system_bash', { system: remote.id, command: 'echo hi' });
    assert.equal(result.isError, true, JSON.stringify(result));
    const structured = JSON.parse(result.content[1].text);
    assert.equal(structured.code, 'SYSTEM_NO_PROVIDER', JSON.stringify(structured));
    assert.equal(structured.statusCode, 501);
    assert.match(result.content[0].text, new RegExp(remote.id));
  });

  // PINS: a system that is registered and simply does not answer refuses
  // SYSTEM_UNREACHABLE (502) through system_bash. Distinct from the 501 above
  // because the repair is different — fix the box, not the registry row.
  test('system_bash refuses SYSTEM_UNREACHABLE when the provider cannot be reached', async () => {
    const gate = path.join(home, 'gate');
    await addSystem({ id: 'gatedbox', label: 'Gated box', launch: ['node', GATED, '--gate', gate] });
    // Registered while the box was up; it goes down with the registry row, the
    // launch argv and the live handle all untouched.
    await fs.writeFile(gate, '');
    disposeSystemHandles();

    const result = await callTool(baseUrl, 'system_bash', { system: 'gatedbox', command: 'echo hi' });
    assert.equal(result.isError, true, JSON.stringify(result));
    const structured = JSON.parse(result.content[1].text);
    assert.equal(structured.code, 'SYSTEM_UNREACHABLE', JSON.stringify(structured));
    assert.equal(structured.statusCode, 502);
    assert.match(result.content[0].text, /gatedbox/);
  });
});
