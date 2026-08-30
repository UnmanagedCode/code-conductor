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
import { bindRemoteSystem, seedRepo, referenceLaunch } from './remoteSystem.mjs';
import { adoptProject, projectsRoot, projectStoreDir } from '../src/projects.ts';
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

  // PINS: spawning a worker on a remote project is refused with a NAMED code
  // and no instance is created. Worker sessions on a system are the next phase;
  // starting one here would run the CLI against a path that is not on this
  // machine, and the CLI would silently create it.
  test('spawning a worker on a remote project refuses, and creates no instance', async () => {
    await adoptRemote();
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'app' });
    assert.equal(r.status, 501, JSON.stringify(r.body));
    assert.match(r.body.error, /WORKER_SESSIONS_LOCAL_ONLY/);
    assert.match(r.body.error, new RegExp(remote.id));
    assert.equal(instances.list().length, 0, 'nothing was spawned');
    assert.equal(await exists(path.join(projectsRoot(), 'app')), false,
      'and no local directory was conjured for it');
  });

  // PINS: the same refusal on the MCP surface a conductor drives.
  test('spawn_instance refuses a remote project too', async () => {
    await adoptRemote();
    const r = await callTool(baseUrl, 'spawn_instance', { project: 'app' });
    assert.equal(r.isError, true, JSON.stringify(r));
    assert.match(r.content[0].text, /WORKER_SESSIONS_LOCAL_ONLY/);
    assert.equal(instances.list().length, 0);
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
      ['project_diff', { project: 'app', worktree: 'app_worktree_feature' }],
      ['project_bash', { project: 'app', command: 'echo hi' }],
    ]) {
      const r = await callTool(baseUrl, tool, args);
      assert.equal(r.isError, true, `${tool} must refuse: ${JSON.stringify(r)}`);
      assert.match(r.content[0].text, new RegExp(remote.id), `${tool} names the system`);
    }
  });

  // ── Failure state: mid-merge ─────────────────────────────────────────

  // PINS: an unreachable system reaches mergeWorktreeIntoParent as a STRUCTURED
  // refusal carrying its own code, not as a throw. Every other blocker there is
  // a returned {ok:false, code}, and callers render the code — one that threw
  // instead would surface as a 500 with no code to render.
  test('a merge on an unreachable system returns SYSTEM_UNREACHABLE, not a throw', async () => {
    const tree = await adoptRemote();
    await createWorktree('app', { name: 'feature' });
    await fs.writeFile(path.join(tree, '..', 'x'), 'x').catch(() => {});
    disposeSystemHandles();
    await updateSystem(remote.id, { launch: null });

    const r = await mergeWorktreeIntoParent('app', 'app_worktree_feature');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SYSTEM_UNREACHABLE');
    assert.match(r.reason, new RegExp(remote.id));
  });

  // PINS: the merge refusal survives the MCP surface as a rendered refusal
  // rather than a tool error, which is what lets a conductor act on it.
  test('merge_worktree renders the SYSTEM_UNREACHABLE refusal', async () => {
    await adoptRemote();
    await createWorktree('app', { name: 'feature' });
    disposeSystemHandles();
    await updateSystem(remote.id, { launch: null });
    const r = await callTool(baseUrl, 'merge_worktree', { project: 'app', worktree: 'app_worktree_feature' });
    const text = r.content.map(c => c.text).join('\n');
    assert.match(text, /SYSTEM_UNREACHABLE/, text);
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
});
