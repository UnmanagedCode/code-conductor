import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPluginHost } from '../src/plugins/registry.ts';
import { pidAlive } from '../src/plugins/ports.ts';
import { readProjectMeta, writeProjectMeta, listWorkspaces, projectStoreDir, selfProjectDir, createProject, orchStoreRoot } from '../src/projects.ts';
import { setPluginConventionsProvider } from '../src/projectConventions.ts';
import { composeProjectConventionsDoc, ensureProjectConventionsMd, conventionsTargetPath } from '../src/projectClaudeMd.ts';
import { makePluginRoot, readFixtureManifest, waitFor, FAKE_PLUGIN_DIR } from './plugin-helpers.mjs';

const run = promisify(execFile);
async function git(cwd, ...args) { await run('git', ['-C', cwd, ...args]); }

// Fabricate a worktree checkout + its store metadata, backed by a real git
// worktree — getWorktree()/listWorktrees() cross-check `git worktree list`
// against the store metadata, so a purely-synthetic directory + metadata
// file isn't enough to count as "existing" (only discovery's
// worktreeManifestFallback reads the store meta directly, with no git
// verification).
async function fabricateWorktree(env, project, worktreeName, { manifest } = {}) {
  const projectDir = path.join(env.root, project);
  const worktreePath = path.join(env.root, worktreeName);
  const isRepo = await fs.access(path.join(projectDir, '.git')).then(() => true, () => false);
  if (!isRepo) {
    await git(projectDir, 'init', '-q');
    await git(projectDir, 'config', 'user.email', 'test@test');
    await git(projectDir, 'config', 'user.name', 'test');
    await git(projectDir, 'commit', '-q', '--allow-empty', '-m', 'root');
  }
  await git(projectDir, 'worktree', 'add', '-q', worktreePath, '-b', `wt-${worktreeName}`);
  await fs.cp(FAKE_PLUGIN_DIR, worktreePath, { recursive: true });
  if (manifest !== undefined) {
    await fs.writeFile(path.join(worktreePath, 'conductor.plugin.json'), JSON.stringify(manifest));
  }
  const metaFile = path.join(projectStoreDir(project), 'worktrees', worktreeName, 'worktree.json');
  await fs.mkdir(path.dirname(metaFile), { recursive: true });
  await fs.writeFile(metaFile, JSON.stringify({ parentProject: project, worktreeName, worktreePath }));
  return worktreePath;
}

async function rejectsWithStatus(promise, statusCode) {
  try { await promise; }
  catch (e) { assert.equal(e.statusCode, statusCode, `expected ${statusCode}, got ${e.statusCode}: ${e.message}`); return e; }
  assert.fail(`expected rejection with statusCode ${statusCode}`);
}

test('discovery: ok / conflict / invalid / incompatible states', async () => {
  const env = await makePluginRoot();
  try {
    const fixture = await readFixtureManifest();
    await env.addPluginProject('aplug');
    await env.addPluginProject('bdup', { manifest: fixture }); // duplicate id — aplug wins alphabetically
    await env.addPluginProject('cinvalid', { manifest: { id: 'cinvalid', pluginApi: 1 } });
    await env.addPluginProject('dincompat', { manifest: { id: 'dincompat', name: 'D', version: '1', pluginApi: 99 } });
    await env.addProject('eplain');

    const host = createPluginHost();
    const rows = await host.list();
    const byProject = Object.fromEntries(rows.map(r => [r.project, r]));
    assert.equal(byProject.aplug.state, 'discovered');
    assert.equal(byProject.aplug.id, 'fake-plugin');
    assert.equal(byProject.aplug.hasFrontend, true);
    assert.equal(byProject.bdup.state, 'conflict');
    assert.match(byProject.bdup.errors[0], /duplicate id 'fake-plugin'/);
    assert.equal(byProject.cinvalid.state, 'invalid');
    assert.equal(byProject.dincompat.state, 'incompatible');
    assert.equal(byProject.eplain, undefined);

    await rejectsWithStatus(host.enable('nope'), 404);
    await rejectsWithStatus(host.enable('dincompat'), 409);
  } finally {
    await env.restore();
  }
});

test('enable persists, auto-assigns CC-Dev only when unassigned; disable persists', async () => {
  const env = await makePluginRoot();
  try {
    await env.addPluginProject('aplug');
    const host = createPluginHost();
    const row = await host.enable('fake-plugin');
    assert.equal(row.state, 'stopped');
    assert.equal(row.enabled, true);
    assert.deepEqual(row.activeVersion, { type: 'main' });
    assert.equal((await readProjectMeta('aplug')).workspace, 'CC-Dev');
    assert.ok((await listWorkspaces()).includes('CC-Dev'));

    // A second host instance sees the persisted state (registry.json).
    const host2 = createPluginHost();
    const rows = await host2.list();
    assert.equal(rows.find(r => r.id === 'fake-plugin').enabled, true);

    await host.disable('fake-plugin');
    assert.equal((await host.list()).find(r => r.id === 'fake-plugin').state, 'disabled');

    // Pre-assigned workspace is never overwritten.
    await writeProjectMeta('aplug', { workspace: 'Mine' });
    await host.enable('fake-plugin');
    assert.equal((await readProjectMeta('aplug')).workspace, 'Mine');
  } finally {
    await env.restore();
  }
});

test('discovery (rescan), not just enable, auto-assigns CC-Dev to a newly discovered plugin project', async () => {
  const env = await makePluginRoot();
  try {
    await env.addPluginProject('aplug');
    const host = createPluginHost();
    await host.rescan();
    assert.equal((await readProjectMeta('aplug')).workspace, 'CC-Dev');
    assert.ok((await listWorkspaces()).includes('CC-Dev'));
    // Never enabled — still just discovered, but already placed.
    assert.equal((await host.list()).find(r => r.project === 'aplug').state, 'discovered');
  } finally {
    await env.restore();
  }
});

test('discovery (rescan) never moves a plugin project already assigned to another workspace', async () => {
  const env = await makePluginRoot();
  try {
    await env.addPluginProject('aplug');
    await writeProjectMeta('aplug', { workspace: 'Mine' });
    const host = createPluginHost();
    await host.rescan();
    assert.equal((await readProjectMeta('aplug')).workspace, 'Mine');
  } finally {
    await env.restore();
  }
});

test('lazy ensureStarted → ready; repeat is a no-op; stop kills the child', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    await env.addPluginProject('aplug');
    await rejectsWithStatus(host.ensureStarted('fake-plugin'), 404); // not enabled yet
    await host.enable('fake-plugin');

    await host.ensureStarted('fake-plugin');
    const info = host.runtimeInfo('fake-plugin');
    assert.equal(info.status, 'ready');
    const health = await (await fetch(`http://127.0.0.1:${info.port}/health`)).json();
    assert.equal(health.ok, true);

    await host.ensureStarted('fake-plugin'); // already ready — same child
    assert.equal(host.runtimeInfo('fake-plugin').port, info.port);

    const row = await host.status('fake-plugin');
    assert.equal(row.state, 'ready');
    assert.ok(row.pid);
    assert.equal(row.gitHead, null); // tmp project copy is not a git repo

    const pid = row.pid;
    await host.stop('fake-plugin');
    await waitFor(() => !pidAlive(pid));
    assert.equal((await host.status('fake-plugin')).state, 'stopped');
  } finally {
    await host.stopAll();
    await env.restore();
  }
});

test('started plugin backend receives PROJECTS_ROOT (resolved) + CONDUCTOR_PROJECT_DIR', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    await env.addPluginProject('aplug');
    await host.enable('fake-plugin');
    await host.ensureStarted('fake-plugin');
    const { port } = host.runtimeInfo('fake-plugin');
    const childEnv = await (await fetch(`http://127.0.0.1:${port}/env`)).json();
    // projectsRoot() resolves to the temp PROJECTS_ROOT makePluginRoot() set.
    assert.equal(childEnv.projectsRoot, env.root);
    // The conductor's own running checkout dir — injected explicitly, not
    // recomputed by the plugin.
    assert.equal(childEnv.conductorProjectDir, selfProjectDir());
  } finally {
    await host.stopAll();
    await env.restore();
  }
});

test('running plugin flags stale once its checkout moves past the started-at sha; restart picks it up', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    const dir = await env.addPluginProject('aplug');
    await git(dir, 'init', '-q');
    await git(dir, 'config', 'user.email', 'test@test');
    await git(dir, 'config', 'user.name', 'test');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'initial');

    await rejectsWithStatus(host.restart('fake-plugin'), 409); // not enabled yet
    await host.enable('fake-plugin');
    await rejectsWithStatus(host.restart('fake-plugin'), 409); // not running yet

    await host.ensureStarted('fake-plugin');
    const before = await host.status('fake-plugin');
    assert.ok(before.gitHead);
    assert.equal(before.stale, false);
    const pid = before.pid;

    await fs.writeFile(path.join(dir, 'extra.txt'), 'change');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'second');

    const afterCommit = await host.status('fake-plugin');
    assert.equal(afterCommit.stale, true);
    assert.equal(afterCommit.gitHead, before.gitHead); // unchanged until restarted

    const restarted = await host.restart('fake-plugin');
    assert.equal(restarted.state, 'ready');
    await waitFor(() => !pidAlive(pid)); // old child actually replaced
    assert.notEqual(restarted.gitHead, before.gitHead);
    assert.equal(restarted.stale, false);
  } finally {
    await host.stopAll();
    await env.restore();
  }
});

test('start guards: not enabled 409, unknown 404, manifest id mismatch 400', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    const dir = await env.addPluginProject('aplug');
    await rejectsWithStatus(host.start('fake-plugin'), 409);
    await rejectsWithStatus(host.start('ghost'), 404);

    await host.enable('fake-plugin');
    // The active checkout stops being this plugin → start must refuse and
    // keep state.
    const fixture = await readFixtureManifest();
    await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify({ ...fixture, id: 'other-id' }));
    const e = await rejectsWithStatus(host.start('fake-plugin'), 400);
    assert.match(e.message, /does not match plugin 'fake-plugin'/);
    assert.equal((await host.list()).find(r => r.id === 'fake-plugin').state, 'stopped');
  } finally {
    await host.stopAll();
    await env.restore();
  }
});

test('crash backoff: 503 inside the window; 3 crashes in window → failed; enable recovers', async () => {
  const env = await makePluginRoot();
  try {
    const fixture = await readFixtureManifest();
    const crasherManifest = { id: 'crasher', name: 'Crasher', version: '1', pluginApi: 1, backend: { start: 'node crash.mjs' } };
    await env.addPluginProject('crasher', { manifest: crasherManifest });
    await env.addPluginProject('aplug', { manifest: fixture });

    // Long backoff unit: prove the 503-with-retryAfter window.
    const hostA = createPluginHost({ _backoffUnitMs: 60_000 });
    await hostA.enable('crasher');
    const e1 = await rejectsWithStatus(hostA.ensureStarted('crasher'), 502);
    assert.match(e1.tail, /boom/);
    const e2 = await rejectsWithStatus(hostA.ensureStarted('crasher'), 503);
    assert.ok(e2.retryAfter > 0);
    assert.match(e2.tail, /boom/);

    // Tiny backoff unit: let crashes accumulate to failed.
    const hostB = createPluginHost({ _backoffUnitMs: 1 });
    await rejectsWithStatus(hostB.ensureStarted('crasher'), 502); // crash 1
    await new Promise(r => setTimeout(r, 30));
    await rejectsWithStatus(hostB.ensureStarted('crasher'), 502); // crash 2
    await new Promise(r => setTimeout(r, 30));
    await rejectsWithStatus(hostB.ensureStarted('crasher'), 502); // crash 3 → failed
    const eF = await rejectsWithStatus(hostB.ensureStarted('crasher'), 503);
    assert.match(eF.message, /failed/);
    assert.equal((await hostB.list()).find(r => r.id === 'crasher').state, 'failed');

    // Manual start is the other recovery path: clears crash history, tries
    // again (and re-crashes back to plain crashed, not failed).
    await rejectsWithStatus(hostB.start('crasher'), 502);
    assert.equal((await hostB.list()).find(r => r.id === 'crasher').state, 'crashed');

    // Re-enable resets to stopped.
    await hostB.enable('crasher');
    assert.equal((await hostB.list()).find(r => r.id === 'crasher').state, 'stopped');
  } finally {
    await env.restore();
  }
});

test('adopt-don\'t-drain: live child adopted by a fresh host; dead record cleared', async () => {
  const env = await makePluginRoot();
  const host1 = createPluginHost();
  try {
    await env.addPluginProject('aplug');
    await host1.enable('fake-plugin');
    await host1.ensureStarted('fake-plugin');
    const { port } = host1.runtimeInfo('fake-plugin');
    const { pid } = (await host1.status('fake-plugin'));

    // A brand-new host (fresh conductor process) adopts the running child.
    const host2 = createPluginHost();
    const row = (await host2.list()).find(r => r.id === 'fake-plugin');
    assert.equal(row.state, 'ready');
    assert.equal(row.port, port);

    // Stop through the adopting host (only needs the recorded pgid).
    await host2.stop('fake-plugin');
    await waitFor(() => !pidAlive(pid));

    // Dead-pid record: start again, kill behind the registry's back, and a
    // third host must clear the record instead of adopting.
    await host2.start('fake-plugin');
    const rec2 = await host2.status('fake-plugin');
    process.kill(-rec2.pid, 'SIGKILL');
    await waitFor(() => !pidAlive(rec2.pid));
    const host3 = createPluginHost();
    const row3 = (await host3.list()).find(r => r.id === 'fake-plugin');
    assert.equal(row3.state, 'stopped');
    assert.equal(row3.port, null);
  } finally {
    await host1.stopAll();
    await env.restore();
  }
});

test('status() live-probe flips a silently-dead child to crashed', async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  try {
    await env.addPluginProject('aplug');
    await host.enable('fake-plugin');
    await host.ensureStarted('fake-plugin');
    const { pid } = await host.status('fake-plugin');
    process.kill(-pid, 'SIGKILL');
    await waitFor(() => !pidAlive(pid));
    const row = await host.status('fake-plugin');
    assert.equal(row.state, 'crashed');
    // Lazy restart on next demand brings it back.
    await new Promise(r => setTimeout(r, 2100)); // past the first backoff (2s)
    await host.ensureStarted('fake-plugin');
    assert.equal(host.runtimeInfo('fake-plugin').status, 'ready');
  } finally {
    await host.stopAll();
    await env.restore();
  }
});

test('worktree-only plugin bootstraps: discovered via fallback, enable defaults activeVersion', async () => {
  const env = await makePluginRoot();
  try {
    await env.addProject('wtonly'); // main checkout: no manifest at all
    await fabricateWorktree(env, 'wtonly', 'wtonly_worktree_b');
    await fabricateWorktree(env, 'wtonly', 'wtonly_worktree_a'); // sorted first — deterministic pick
    const host = createPluginHost();
    const row = (await host.list()).find(r => r.id === 'fake-plugin');
    assert.ok(row, 'discovered from the worktree checkout');
    assert.equal(row.project, 'wtonly');
    assert.equal(row.state, 'discovered');
    assert.deepEqual(row.manifestSource, { type: 'worktree', name: 'wtonly_worktree_a' });

    const en = await host.enable('fake-plugin');
    assert.deepEqual(en.activeVersion, { type: 'worktree', name: 'wtonly_worktree_a' },
      'first start must run from the checkout that actually has the manifest');
  } finally {
    await env.restore();
  }
});

// registry.json is the ONLY copy of every plugin's enabled state and pinned
// version. The old behaviour was to warn and fall back to `{plugins:{}}` — which
// silently forgot all of it and left the bad file in place for the next
// saveRegistry() to overwrite. Now the file is moved aside and the failure is
// reported through notices() so the Settings page can say where it went.
test('a corrupt registry.json is preserved as .corrupt and reported as a notice', async () => {
  const env = await makePluginRoot();
  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    await env.addPluginProject('aplug');
    const registryFile = path.join(orchStoreRoot(), 'plugins', 'registry.json');
    await fs.mkdir(path.dirname(registryFile), { recursive: true });
    const BAD = '{ not json';
    await fs.writeFile(registryFile, BAD);

    const host = createPluginHost();
    await host.init();

    // (1) The bad bytes are preserved verbatim, under the fixed .corrupt name.
    const backupFile = `${registryFile}.corrupt`;
    assert.equal(await fs.readFile(backupFile, 'utf8'), BAD,
      'the unreadable file is preserved byte-for-byte, not deleted or truncated');

    // (2) MOVED, not copied — else the next saveRegistry() overwrites the only copy.
    assert.equal(await fs.access(registryFile).then(() => true, () => false), false,
      'the corrupt file is renamed away, not left in place');

    // (3) The notice payload names the file, the reason, and the backup path.
    const notices = host.notices();
    assert.equal(notices.length, 1);
    assert.equal(notices[0].file, 'registry.json');
    assert.ok(notices[0].reason && notices[0].reason.length > 0, 'a non-empty reason');
    assert.match(notices[0].backup, /registry\.json\.corrupt$/);

    // (4) Never fatal: init completed and the host still lists.
    assert.ok(Array.isArray(await host.list()));
  } finally {
    console.warn = origWarn;
    await env.restore();
  }
});

// The preservation is best-effort, and its FAILURE path is the one that must not
// take init down with it: an unreadable registry.json is already a degraded boot,
// so a rename that also fails has to degrade further (no backup) rather than
// escalate into a rejected init that poisons every plugin-host call. Pins the
// inner catch around fs.rename — without it, a rethrow makes ensureInit reject.
test('a corrupt registry.json whose rename FAILS still reports a notice and does not break init', async () => {
  const env = await makePluginRoot();
  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    await env.addPluginProject('aplug');
    const registryFile = path.join(orchStoreRoot(), 'plugins', 'registry.json');
    await fs.mkdir(path.dirname(registryFile), { recursive: true });
    await fs.writeFile(registryFile, '{ not json');

    // Force the rename to reject, without stubbing fs: a DIRECTORY sitting on the
    // exact backup path makes rename(file, backup) fail EISDIR, deterministically
    // and on every platform this runs on. The read still succeeds, so the corrupt
    // branch is entered normally and only the preservation fails.
    await fs.mkdir(`${registryFile}.corrupt`, { recursive: true });

    const host = createPluginHost();
    // (1) Init completes — a failed preservation is not fatal.
    await host.init();
    assert.ok(Array.isArray(await host.list()),
      'init survived the failed rename and the host still lists');

    // (2) The failure is still SURFACED, just with no backup path to offer.
    const notices = host.notices();
    assert.equal(notices.length, 1);
    assert.equal(notices[0].file, 'registry.json');
    assert.ok(notices[0].reason && notices[0].reason.length > 0, 'a non-empty reason');
    assert.equal(notices[0].backup, null,
      'backup is null when the file could not be moved aside — not a bogus path');

    // (3) And the rename failure itself is logged, not swallowed in silence.
    assert.ok(warns.some(w => w.includes('could not preserve') && w.includes('registry.json')),
      'the failed preservation is logged with the file it could not move');
  } finally {
    console.warn = origWarn;
    await env.restore();
  }
});

test('a main-checkout manifest always wins over worktree manifests', async () => {
  const env = await makePluginRoot();
  try {
    await env.addPluginProject('both'); // main manifest present (id fake-plugin)
    await fabricateWorktree(env, 'both', 'both_worktree_a', {
      manifest: { id: 'other-id', name: 'Other', version: '1', pluginApi: 1 },
    });
    const host = createPluginHost();
    const rows = await host.list();
    const row = rows.find(r => r.project === 'both');
    assert.equal(row.id, 'fake-plugin');
    assert.deepEqual(row.manifestSource, { type: 'main' });
    assert.ok(!rows.some(r => r.id === 'other-id'), 'worktree manifest ignored when main has one');
  } finally {
    await env.restore();
  }
});

test('an invalid main manifest is never masked by a valid worktree one', async () => {
  const env = await makePluginRoot();
  try {
    await env.addPluginProject('brokenmain', { manifest: { id: 'brokenmain', pluginApi: 1 } }); // invalid: no name/version
    await fabricateWorktree(env, 'brokenmain', 'brokenmain_worktree_a');
    const host = createPluginHost();
    const rows = await host.list();
    const row = rows.find(r => r.project === 'brokenmain');
    assert.equal(row.state, 'invalid');
    assert.deepEqual(row.manifestSource, { type: 'main' });
    assert.ok(!rows.some(r => r.project === 'brokenmain' && r.state === 'discovered'),
      'no shadow ok-entry from the worktree');
  } finally {
    await env.restore();
  }
});

test('registry entry whose project vanished still lists as invalid', async () => {
  const env = await makePluginRoot();
  try {
    const dir = await env.addPluginProject('aplug');
    const host = createPluginHost();
    await host.enable('fake-plugin');
    await fs.rm(path.join(dir, 'conductor.plugin.json'));
    const rows = await host.rescan();
    const row = rows.find(r => r.id === 'fake-plugin');
    assert.equal(row.state, 'invalid');
    assert.match(row.errors[0], /no longer present/);
  } finally {
    await env.restore();
  }
});

test('a transient init failure does not permanently poison the plugin host — the next call retries', async () => {
  const env = await makePluginRoot();
  try {
    // No manifest at all -> rescanInternal() falls through to
    // worktreeManifestFallback(), which fs.readdir()s <projectStoreDir>/worktrees
    // and rethrows anything other than ENOENT. Put a FILE there instead of a
    // directory: a real, deterministic ENOTDIR, not a mock.
    await env.addProject('plain');
    const wtDir = path.join(projectStoreDir('plain'), 'worktrees');
    await fs.mkdir(path.dirname(wtDir), { recursive: true });
    await fs.writeFile(wtDir, '');

    const host = createPluginHost();
    await assert.rejects(host.list());

    // Clear the obstruction. If the rejected init promise were cached (as it
    // used to be), every subsequent call would keep rethrowing the same
    // stale failure forever; it must instead reinitialize and succeed.
    await fs.rm(wtDir, { force: true });
    const rows = await host.list();
    assert.ok(Array.isArray(rows));
  } finally {
    await env.restore();
  }
});

test('stopAll() still stops an already-recorded backend even when init fails', async () => {
  const env = await makePluginRoot();
  try {
    // Seed runtime.json BEFORE the host ever inits — runtimeRecords is
    // assigned from this file at the top of ensureInit's async body, before
    // rescanInternal() (which we're about to force to throw) even runs. A
    // fake pid/pgid is enough: supervisor.stop() never throws on a bogus or
    // already-dead one (it wraps process.kill in try/catch), so this needs
    // no real spawned child to observe the stop being attempted.
    const runtimeDir = path.join(orchStoreRoot(), 'plugins');
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(path.join(runtimeDir, 'runtime.json'), JSON.stringify({
      fakeid: { pid: 999999, pgid: 999999, port: 1, startedAt: new Date(0).toISOString(), gitHead: null },
    }));

    // Same forced-rescan-failure fixture as the test above.
    await env.addProject('plain');
    const wtDir = path.join(projectStoreDir('plain'), 'worktrees');
    await fs.mkdir(path.dirname(wtDir), { recursive: true });
    await fs.writeFile(wtDir, '');

    const host = createPluginHost();
    await assert.rejects(host.list()); // init failed; initPromise is now null (see ensureInit)

    // Must not early-return just because initPromise is null: runtimeRecords
    // was already loaded with 'fakeid' before the failure, so stopAll() has
    // to attempt stopping it — proven by the record being cleared from disk.
    await host.stopAll();
    const persisted = JSON.parse(await fs.readFile(path.join(runtimeDir, 'runtime.json'), 'utf8'));
    assert.deepEqual(Object.keys(persisted), [], 'stopAll() must still stop (and clear) a backend recorded before the failed init');
  } finally {
    await env.restore();
  }
});

// The one manifest shape whose cwd resolution can genuinely fail: an
// activeVersion of type 'worktree' routes resolveCwd() through
// getWorktree()->listWorktrees()->getProject(entry.project) — a REAL I/O
// path, unlike 'main' (which is just entry.dir, no I/O, and so can never
// throw). Deleting the plugin's MAIN checkout after the worktree version is
// already active — without triggering a fresh rescan in between, so the
// entry's discoveryState stays the stale 'ok' from before the deletion —
// makes that getProject() call throw a real, deterministic 404.
const CWD_FAIL_MANIFEST = {
  id: 'cwdfail', name: 'CwdFail', version: '1.0.0', pluginApi: 1,
  conventions: [{ slug: 'vis', name: 'Vis', description: 'x', file: 'conventions/sample.md', scope: 'project' }],
};

test('conventions(): a resolveCwd failure degrades every scope array, all the way through to a project regeneration outcome', async () => {
  const env = await makePluginRoot();
  try {
    await env.addPluginProject('aplug', { manifest: CWD_FAIL_MANIFEST });
    await fabricateWorktree(env, 'aplug', 'wt1', { manifest: CWD_FAIL_MANIFEST });

    const host = createPluginHost();
    await host.enable('cwdfail');
    await host.setActiveVersion('cwdfail', { type: 'worktree', name: 'wt1' });

    // Sanity: resolves fine right now — the worktree genuinely exists.
    const healthy = await host.conventions();
    assert.ok(healthy.project.some(e => e.slug === 'cwdfail/vis'));
    assert.ok(!healthy.project.degraded);

    setPluginConventionsProvider(async () => (await host.conventions()).project);
    const doc = await composeProjectConventionsDoc(['cwdfail/vis', 'design-guidelines']);
    await createProject('referencer', { conventionsDoc: doc });
    const target = conventionsTargetPath(path.join(env.root, 'referencer'));

    // Remove the MAIN checkout only (the worktree at a sibling path survives).
    // No rescan happens between here and the conventions() call below, so
    // discovery still reports 'cwdfail' as 'ok' from the earlier call —
    // resolveCwd() itself is what fails now, live.
    await fs.rm(path.join(env.root, 'aplug'), { recursive: true, force: true });

    const degraded = await host.conventions();
    assert.equal(degraded.project.some(e => e.slug === 'cwdfail/vis'), false, 'the entry drops out when its cwd cannot be resolved');
    assert.equal(degraded.project.degraded, true, 'a resolveCwd failure flags the scope array degraded');
    assert.equal(degraded.conductor.degraded, true, 'every scope array is flagged, including ones with no contributions from this plugin');

    const res = await ensureProjectConventionsMd('referencer');
    assert.equal(res.skipped, 'catalog-degraded');
    assert.deepEqual(res.missing, ['cwdfail/vis']);
    assert.equal(await fs.readFile(target, 'utf8'), doc, 'never blank/rewrite a slug the degraded catalog cannot vouch for');
  } finally {
    setPluginConventionsProvider(null);
    await env.restore();
  }
});

test('conventions(): a vanished fragment file does NOT degrade the catalog — the referencing project keeps regenerating', async () => {
  const env = await makePluginRoot();
  try {
    // Manifest validation checks a declared convention's `file` exists AT
    // DISCOVERY TIME — a manifest declaring a file that never existed is
    // `invalid` and never even reaches enable(). So "vanished" has to mean
    // exactly that: present at discovery/enable, deleted afterward, with no
    // rescan in between (a rescan would re-validate and mark it invalid,
    // which is a different, already-tested state).
    const manifest = {
      id: 'ghostfrag', name: 'GhostFrag', version: '1.0.0', pluginApi: 1,
      conventions: [{ slug: 'vis', name: 'Vis', description: 'x', file: 'conventions/sample.md', scope: 'project' }],
    };
    const dir = await env.addPluginProject('bplug', { manifest });
    const host = createPluginHost();
    await host.enable('ghostfrag'); // activeVersion defaults to 'main' — no worktree, no I/O to fail; file exists right now

    await fs.rm(path.join(dir, 'conventions', 'sample.md'));

    const rows = await host.conventions();
    assert.equal(rows.project.some(e => e.slug === 'ghostfrag/vis'), false, 'a convention whose fragment 404s contributes nothing');
    assert.ok(!rows.project.degraded, 'a vanished FILE is a different, already-accepted case — it must not be treated as degraded');

    // The slug is already gone from the catalog at this point, so simulate a
    // project committed BEFORE the fragment vanished (a hand-written stale
    // marker + body), same fixture pattern as the other never-blanks tests.
    setPluginConventionsProvider(async () => (await host.conventions()).project);
    await createProject('referencer2');
    const target = conventionsTargetPath(path.join(env.root, 'referencer2'));
    await fs.writeFile(target, '<!-- cc:conventions ghostfrag/vis,design-guidelines -->\n\nSTALE\n');

    const res = await ensureProjectConventionsMd('referencer2');
    assert.equal(res.regenerated, true, 'a missing fragment FILE must leave the project regenerating, not frozen');
    assert.deepEqual(res.missing, ['ghostfrag/vis']);
    const content = await fs.readFile(target, 'utf8');
    assert.match(content, /## Design guidelines/);
    assert.doesNotMatch(content, /STALE/);
  } finally {
    setPluginConventionsProvider(null);
    await env.restore();
  }
});

test('conventions(): a vanished SCAFFOLD file does NOT degrade the catalog either — the referencing project keeps regenerating', async () => {
  const env = await makePluginRoot();
  try {
    // Twin of the vanished-fragment test, one facet over: the scaffold half
    // of "a vanished fragment/scaffold file is skipped, not degraded" needs
    // its own pin — reading the scaffold file is a separate catch from
    // reading the fragment body, and only one of the two used to be tested.
    const manifest = {
      id: 'ghostscaffold', name: 'GhostScaffold', version: '1.0.0', pluginApi: 1,
      conventions: [{ slug: 'vis', name: 'Vis', description: 'x', file: 'conventions/sample.md', scope: 'project', scaffold: { file: 'scaffolds/sample.md' } }],
    };
    const dir = await env.addPluginProject('cplug', { manifest });
    const host = createPluginHost();
    await host.enable('ghostscaffold'); // file exists right now; scaffold file exists right now

    await fs.rm(path.join(dir, 'scaffolds', 'sample.md'));

    const rows = await host.conventions();
    assert.equal(rows.project.some(e => e.slug === 'ghostscaffold/vis'), false, 'a convention whose scaffold file 404s contributes nothing (fragment body included)');
    assert.ok(!rows.project.degraded, 'a vanished scaffold FILE is the same already-accepted case as a vanished fragment — must not be treated as degraded');

    setPluginConventionsProvider(async () => (await host.conventions()).project);
    await createProject('referencer3');
    const target = conventionsTargetPath(path.join(env.root, 'referencer3'));
    await fs.writeFile(target, '<!-- cc:conventions ghostscaffold/vis,design-guidelines -->\n\nSTALE\n');

    const res = await ensureProjectConventionsMd('referencer3');
    assert.equal(res.regenerated, true, 'a missing scaffold FILE must leave the project regenerating, not frozen');
    assert.deepEqual(res.missing, ['ghostscaffold/vis']);
    const content = await fs.readFile(target, 'utf8');
    assert.match(content, /## Design guidelines/);
    assert.doesNotMatch(content, /STALE/);
  } finally {
    setPluginConventionsProvider(null);
    await env.restore();
  }
});

// A contributions-only manifest: no backend/frontend/mcp, only conventions.
// Three shapes exercised: fragment+scaffold (scaffold via file, mirrors
// code-playwright), scaffold-only (inline text, no fragment), and fragment-only.
// Must validate, enable, and never start a process; describeRow flags
// hasBackend:false, state 'enabled'.
const CONTRIB_ONLY = {
  id: 'conv-plugin', name: 'Conv Plugin', version: '1.0.0', pluginApi: 1,
  conventions: [
    { slug: 'vis-check', name: 'Visual check', description: 'verify UX', file: 'conventions/sample.md', scope: 'project', scaffold: { file: 'scaffolds/sample.md' } },
    { slug: 'seed-config', name: 'Seed config', description: 'seed the config', scope: 'project', scaffold: { text: 'write a default config file' } },
    { slug: 'plain-conv', name: 'Plain', description: 'fragment only', file: 'conventions/sample.md', scope: 'project' },
  ],
};

test('contributions-only plugin: enables without a backend, state=enabled, no child', async () => {
  const env = await makePluginRoot();
  try {
    await env.addPluginProject('convp', { manifest: CONTRIB_ONLY });
    const host = createPluginHost();
    const discovered = (await host.list()).find(r => r.id === 'conv-plugin');
    assert.equal(discovered.state, 'discovered');
    assert.equal(discovered.hasBackend, false);
    assert.equal(discovered.conventions.length, 3);
    assert.equal(discovered.scaffolds, undefined); // no separate scaffolds array anymore
    assert.deepEqual(discovered.conventions[0], { slug: 'conv-plugin/vis-check', name: 'Visual check', description: 'verify UX', hasScaffold: true });
    assert.deepEqual(discovered.conventions[1], { slug: 'conv-plugin/seed-config', name: 'Seed config', description: 'seed the config', hasScaffold: true });
    assert.deepEqual(discovered.conventions[2], { slug: 'conv-plugin/plain-conv', name: 'Plain', description: 'fragment only', hasScaffold: false });

    const row = await host.enable('conv-plugin');
    assert.equal(row.enabled, true);
    assert.equal(row.state, 'enabled'); // never 'stopped' — no process lifecycle
    // start must refuse (no backend), and nothing should ever be recorded live.
    await rejectsWithStatus(host.start('conv-plugin'), 400);
    assert.equal(host.runtimeInfo('conv-plugin').port, null);
  } finally {
    await env.restore();
  }
});

test('conventions() surfaces body + scaffold facet for enabled+ok plugins only', async () => {
  const env = await makePluginRoot();
  try {
    await env.addPluginProject('convp', { manifest: CONTRIB_ONLY });
    const host = createPluginHost();

    // Not enabled yet → no contributions (conventions() is grouped by scope).
    assert.deepEqual(await host.conventions(), { project: [], conductor: [] });

    await host.enable('conv-plugin');
    const g = (await host.conventions()).project;
    assert.equal(g.length, 3);

    // fragment + scaffold (scaffold via file).
    assert.equal(g[0].slug, 'conv-plugin/vis-check');
    assert.equal(g[0].plugin, 'conv-plugin');
    assert.match(g[0].body, /Visual UX verification/);
    assert.match(g[0].scaffold, /harness wrapper/); // resolved from scaffolds/sample.md

    // scaffold only (inline text, no fragment body).
    assert.equal(g[1].slug, 'conv-plugin/seed-config');
    assert.equal(g[1].body, '');
    assert.match(g[1].scaffold, /default config/);

    // fragment only (no scaffold facet).
    assert.equal(g[2].slug, 'conv-plugin/plain-conv');
    assert.match(g[2].body, /Visual UX verification/);
    assert.equal(g[2].scaffold, undefined);

    // Disable → contributions drop.
    await host.disable('conv-plugin');
    assert.deepEqual(await host.conventions(), { project: [], conductor: [] });
  } finally {
    await env.restore();
  }
});

test('rescan drops the cached fragment body so an on-disk edit reaches conventions()', async () => {
  const env = await makePluginRoot();
  try {
    const dir = await env.addPluginProject('convp', { manifest: CONTRIB_ONLY });
    const host = createPluginHost();
    await host.enable('conv-plugin');

    const before = (await host.conventions()).project.find(e => e.slug === 'conv-plugin/plain-conv');
    assert.match(before.body, /Visual UX verification/);

    await fs.writeFile(path.join(dir, 'conventions', 'sample.md'), '## V2 body\n- new text');
    await host.rescan();

    const after = (await host.conventions()).project.find(e => e.slug === 'conv-plugin/plain-conv');
    assert.match(after.body, /V2 body/);
    assert.doesNotMatch(after.body, /Visual UX verification/);
  } finally {
    await env.restore();
  }
});

test('enable drops the cached fragment body so a fragment edited while disabled reaches conventions() on re-enable', async () => {
  const env = await makePluginRoot();
  try {
    const dir = await env.addPluginProject('convp', { manifest: CONTRIB_ONLY });
    const host = createPluginHost();
    await host.enable('conv-plugin');

    // Populate the cache while enabled.
    const before = (await host.conventions()).project.find(e => e.slug === 'conv-plugin/plain-conv');
    assert.match(before.body, /Visual UX verification/);

    await host.disable('conv-plugin');
    // Edited while disabled — the plugin contributes nothing right now, so
    // this must NOT be visible until (and unless) re-enable refreshes it.
    await fs.writeFile(path.join(dir, 'conventions', 'sample.md'), '## V2 body\n- new text');

    await host.enable('conv-plugin');
    const after = (await host.conventions()).project.find(e => e.slug === 'conv-plugin/plain-conv');
    assert.match(after.body, /V2 body/);
    assert.doesNotMatch(after.body, /Visual UX verification/);
  } finally {
    await env.restore();
  }
});

test('setActiveVersion drops the cached fragment body even for a backendless (never-started) plugin', async () => {
  const env = await makePluginRoot();
  try {
    const dir = await env.addPluginProject('convp', { manifest: CONTRIB_ONLY });
    const host = createPluginHost();
    await host.enable('conv-plugin');

    const before = (await host.conventions()).project.find(e => e.slug === 'conv-plugin/plain-conv');
    assert.match(before.body, /Visual UX verification/);

    await fs.writeFile(path.join(dir, 'conventions', 'sample.md'), '## V2 body\n- new text');
    // CONTRIB_ONLY has no backend, so it never reaches 'ready'/'starting' —
    // setActiveVersion's own restart branch never fires. The refresh has to
    // come from the unconditional clear right after saveRegistry(), not from
    // doStart's clear.
    await host.setActiveVersion('conv-plugin', { type: 'main' });

    const after = (await host.conventions()).project.find(e => e.slug === 'conv-plugin/plain-conv');
    assert.match(after.body, /V2 body/);
    assert.doesNotMatch(after.body, /Visual UX verification/);
  } finally {
    await env.restore();
  }
});

// conventions() is memoized on a registry generation counter (it walks
// contributingEntries + resolveCwd per plugin, and resolveCwd →
// reconcileActiveVersion does a dynamic import + a store read for any
// worktree-pinned plugin). These two tests are the invalidation contract.
const CACHE_MANIFEST = {
  id: 'cacheplug', name: 'CachePlug', version: '1.0.0', pluginApi: 1,
  conventions: [{ slug: 'vis', name: 'Vis', description: 'x', file: 'conventions/sample.md', scope: 'project' }],
};

test('conventions() invalidation matrix: every registry mutation and every fragment-cache drop changes the result', async () => {
  const env = await makePluginRoot();
  try {
    const dir = await env.addPluginProject('cachep', { manifest: CACHE_MANIFEST });
    const host = createPluginHost();
    const slugs = async () => (await host.conventions()).project.map(e => e.slug);
    const body = async () => (await host.conventions()).project.find(e => e.slug === 'cacheplug/vis')?.body;

    // Populate the memo BEFORE each mutation — otherwise every assertion below
    // would pass against a cache that never gets to be stale.
    await host.list();
    assert.deepEqual(await slugs(), [], 'discovered but disabled: contributes nothing');

    await host.enable('cacheplug');
    assert.deepEqual(await slugs(), ['cacheplug/vis'], 'enable()');

    // THE critical case: invalidateFragmentBodies deliberately does NOT run on
    // disable (a disabled plugin's bodies can stay cached), so this is caught
    // only by the bump inside saveRegistry(). A cache hooked to the four
    // fragment-cache sites alone keeps serving a disabled plugin's conventions.
    await host.disable('cacheplug');
    assert.deepEqual(await slugs(), [], 'disable()');

    await host.enable('cacheplug');
    assert.deepEqual(await slugs(), ['cacheplug/vis'], 're-enable()');

    await fs.writeFile(path.join(dir, 'conventions', 'sample.md'), '## V2 body\n- rescan');
    await host.rescan();
    assert.match(await body(), /V2 body/, 'rescan()');

    await fs.writeFile(path.join(dir, 'conventions', 'sample.md'), '## V3 body\n- enable');
    await host.enable('cacheplug');
    assert.match(await body(), /V3 body/, 'fragment edit + enable()');

    await fs.writeFile(path.join(dir, 'conventions', 'sample.md'), '## V4 body\n- setActiveVersion');
    await host.setActiveVersion('cacheplug', { type: 'main' });
    assert.match(await body(), /V4 body/, 'fragment edit + setActiveVersion()');

    // A manifest edit changes the ENTRY LIST, not just a body.
    await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify({
      ...CACHE_MANIFEST,
      conventions: [
        ...CACHE_MANIFEST.conventions,
        { slug: 'extra', name: 'Extra', description: 'y', file: 'conventions/sample.md', scope: 'project' },
      ],
    }));
    await host.rescan();
    assert.deepEqual(await slugs(), ['cacheplug/vis', 'cacheplug/extra'], 'manifest edit + rescan()');
  } finally {
    await env.restore();
  }
});

// The cache HIT is otherwise unobservable — every input to conventions() is
// in-memory state reachable only through a mutation that bumps the generation.
// So the hit needs an fs-visible divergence the recomputation WOULD notice:
// a worktree-pinned plugin whose worktree metadata vanishes underneath it.
test('conventions() serves a cache hit: an activeVersion gone stale on disk is not re-resolved until something bumps', async () => {
  const env = await makePluginRoot();
  try {
    const mainDir = await env.addPluginProject('cachewt', { manifest: CACHE_MANIFEST });
    // Sorts after 'cachewt', so the MAIN checkout wins discovery and the
    // worktree copy is the (ignored) alphabetical loser.
    const wtPath = await fabricateWorktree(env, 'cachewt', 'cachewt_worktree_a', { manifest: CACHE_MANIFEST });
    await fs.writeFile(path.join(mainDir, 'conventions', 'sample.md'), '## MAIN-BODY');
    await fs.writeFile(path.join(wtPath, 'conventions', 'sample.md'), '## WORKTREE-BODY');

    const host = createPluginHost();
    const body = async () => (await host.conventions()).project.find(e => e.slug === 'cacheplug/vis').body;

    await host.enable('cacheplug');
    await host.setActiveVersion('cacheplug', { type: 'worktree', name: 'cachewt_worktree_a' });
    assert.match(await body(), /WORKTREE-BODY/, 'pinned to the worktree checkout');

    // Delete the worktree's STORE METADATA only. Nothing here touches the
    // registry, so the generation does not move — and BOTH checkout dirs
    // survive, so the per-call liveness re-check finds nothing missing either.
    // (That second half is load-bearing: a vanished checkout dir is exactly
    // what the re-check exists to catch, and would recompute instead.)
    await fs.rm(path.join(projectStoreDir('cachewt'), 'worktrees', 'cachewt_worktree_a'), { recursive: true, force: true });
    assert.ok(await fs.access(mainDir).then(() => true, () => false), 'main checkout still on disk');
    assert.ok(await fs.access(wtPath).then(() => true, () => false), 'worktree checkout still on disk');

    assert.match(await body(), /WORKTREE-BODY/,
      'served from the memo — recomputing would have let reconcileActiveVersion self-heal to main and return MAIN-BODY');

    // ...and the memo is not permanent: the next bump exposes the self-heal.
    await host.rescan();
    assert.match(await body(), /MAIN-BODY/, 'a bump re-resolves and the stale pin heals back to main');
  } finally {
    await env.restore();
  }
});

// A manifest mixing project- and conductor-scope conventions, to verify
// conventions() partitions strictly by scope with no cross-leak.
const MIXED_SCOPE = {
  id: 'mixed-plugin', name: 'Mixed Plugin', version: '1.0.0', pluginApi: 1,
  conventions: [
    { slug: 'proj-conv', name: 'Project conv', description: 'project scope', file: 'conventions/sample.md', scope: 'project' },
    { slug: 'cond-conv', name: 'Conductor conv', description: 'conductor scope', file: 'conventions/sample.md', scope: 'conductor' },
  ],
};

test('conventions() partitions project- and conductor-scope entries with no cross-leak', async () => {
  const env = await makePluginRoot();
  try {
    await env.addPluginProject('mixp', { manifest: MIXED_SCOPE });
    const host = createPluginHost();
    await host.enable('mixed-plugin');

    const byScope = await host.conventions();
    assert.equal(byScope.project.length, 1);
    assert.equal(byScope.project[0].slug, 'mixed-plugin/proj-conv');
    assert.equal(byScope.conductor.length, 1);
    assert.equal(byScope.conductor[0].slug, 'mixed-plugin/cond-conv');

    // Neither group contains the other's entry.
    assert.ok(!byScope.project.some(e => e.slug === 'mixed-plugin/cond-conv'));
    assert.ok(!byScope.conductor.some(e => e.slug === 'mixed-plugin/proj-conv'));
  } finally {
    await env.restore();
  }
});

test('roles(): only enabled+ok plugins contribute, namespaced; disable drops them; describeRow carries roles', async () => {
  const env = await makePluginRoot();
  try {
    const manifest = {
      id: 'roleplug', name: 'Role Plugin', version: '1.0.0', pluginApi: 1,
      roles: [
        { slug: 'captain', name: 'Captain', binding: { kind: 'tier', tier: 'powerful' } },
        { slug: 'scribe', name: 'Scribe', binding: { backend: 'claude', model: 'claude-opus-4-8' } },
      ],
    };
    await env.addPluginProject('roleplug', { manifest, withFixtureFiles: false });
    const host = createPluginHost();
    await host.list(); // ensureInit + discovery
    // Disabled → no roles.
    assert.deepEqual(host.roles(), []);
    await host.enable('roleplug');
    const roles = host.roles();
    assert.deepEqual(roles.map(r => r.role), ['roleplug/captain', 'roleplug/scribe']);
    assert.deepEqual(roles[0], { role: 'roleplug/captain', label: 'Captain', binding: { kind: 'tier', tier: 'powerful' }, plugin: 'roleplug' });
    // describeRow surfaces the roles for the Plugins-UI badge.
    const row = (await host.list()).find(r => r.id === 'roleplug');
    assert.deepEqual(row.roles, [{ slug: 'roleplug/captain', name: 'Captain' }, { slug: 'roleplug/scribe', name: 'Scribe' }]);
    // Disable → roles vanish automatically (no purge).
    await host.disable('roleplug');
    assert.deepEqual(host.roles(), []);
  } finally {
    await env.restore();
  }
});

// Write a Claude Code plugin root (the dir --plugin-dir expects) at
// <dir>/<rel>/.claude-plugin/plugin.json.
async function writeClaudePluginRoot(dir, rel, name) {
  const root = path.join(dir, rel);
  await fs.mkdir(path.join(root, '.claude-plugin'), { recursive: true });
  await fs.writeFile(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }));
  return root;
}

test('claudePluginDirs() resolves validated roots for enabled+ok plugins only', async () => {
  const env = await makePluginRoot();
  try {
    const dir = await env.addPluginProject('skillp', {
      manifest: { id: 'skill-plugin', name: 'Skill Plugin', version: '1.0.0', pluginApi: 1, claudePlugin: 'claude' },
    });
    const expectedRoot = await writeClaudePluginRoot(dir, 'claude', 'skill-plugin-cc');
    const host = createPluginHost();

    // Not enabled → no flag.
    assert.deepEqual(await host.claudePluginDirs(), []);

    await host.enable('skill-plugin');
    assert.deepEqual(await host.claudePluginDirs(), [expectedRoot]);

    // Disabled → drops automatically.
    await host.disable('skill-plugin');
    assert.deepEqual(await host.claudePluginDirs(), []);
  } finally {
    await env.restore();
  }
});

test('claudePluginDirs() supports "." (cc plugin root itself)', async () => {
  const env = await makePluginRoot();
  try {
    const dir = await env.addPluginProject('selfp', {
      manifest: { id: 'self-plugin', name: 'Self Plugin', version: '1.0.0', pluginApi: 1, claudePlugin: '.' },
    });
    await writeClaudePluginRoot(dir, '.', 'self-plugin-cc');
    const host = createPluginHost();
    await host.enable('self-plugin');
    assert.deepEqual(await host.claudePluginDirs(), [dir]);
  } finally {
    await env.restore();
  }
});

test('claudePluginDirs() drops (with warn) a target missing .claude-plugin/plugin.json', async () => {
  const env = await makePluginRoot();
  try {
    // claudePlugin points at a dir with no .claude-plugin/plugin.json.
    await env.addPluginProject('brokenp', {
      manifest: { id: 'broken-plugin', name: 'Broken Plugin', version: '1.0.0', pluginApi: 1, claudePlugin: 'claude' },
    });
    const host = createPluginHost();
    await host.enable('broken-plugin');
    const warnings = [];
    const orig = console.warn;
    console.warn = (m) => warnings.push(String(m));
    try {
      assert.deepEqual(await host.claudePluginDirs(), []);
    } finally { console.warn = orig; }
    assert.ok(warnings.some(w => w.includes('broken-plugin') && w.includes('.claude-plugin/plugin.json')));
  } finally {
    await env.restore();
  }
});

test('claudePluginDirs() is empty for a plugin without the field', async () => {
  const env = await makePluginRoot();
  try {
    await env.addPluginProject('convp', { manifest: CONTRIB_ONLY });
    const host = createPluginHost();
    await host.enable('conv-plugin');
    assert.deepEqual(await host.claudePluginDirs(), []);
  } finally {
    await env.restore();
  }
});

// Board 2026-0156: stopInternal's awaited runtime.json write raced
// handleChildExit's fire-and-forget one, and both raced each other across
// plugins — all sharing one `${file}.${pid}.tmp` name meant the second
// rename to land deleted the first writer's still-in-flight tmp file, and
// the loser threw ENOENT on a file it wrote itself. This pins the production
// path (two real `stop()` calls), not the helper in isolation.
test("two concurrent stops both persist runtime.json — neither steals the other's tmp", async () => {
  const env = await makePluginRoot();
  const host = createPluginHost();
  const origWriteFile = fs.writeFile;
  const origRename = fs.rename;
  let restored = false;
  const restoreFsPatch = () => {
    if (restored) return;
    restored = true;
    fs.writeFile = origWriteFile;
    fs.rename = origRename;
  };
  try {
    const fixture = await readFixtureManifest();
    await env.addPluginProject('aplug', { manifest: { ...fixture, id: 'aplug' } });
    await env.addPluginProject('bplug', { manifest: { ...fixture, id: 'bplug' } });
    await host.enable('aplug');
    await host.enable('bplug');
    await host.ensureStarted('aplug');
    await host.ensureStarted('bplug');
    // Both must be structurally guaranteed to reach stopInternal — assert
    // readiness (and a recorded pid) BEFORE the barrier goes up, so the pair
    // held at it is by construction, not by an event landing in a window.
    const rows = await host.list();
    assert.equal(rows.find(r => r.id === 'aplug').state, 'ready');
    assert.equal(rows.find(r => r.id === 'bplug').state, 'ready');
    assert.ok((await host.status('aplug')).pid);
    assert.ok((await host.status('bplug')).pid);

    // Barrier scoped to runtime.json's own tmp files only, so the
    // registry.json / project.json writes from enable()/auto-assign are
    // never held.
    const tmpPaths = [];
    let arrived = 0;
    let renamesBeforeRelease = 0;
    let released = false;
    let resolveGate;
    const gate = new Promise((resolve) => { resolveGate = resolve; });
    const N = 2;
    const safety = setTimeout(() => { released = true; resolveGate(); }, 8000);
    fs.writeFile = async function (file, data, ...rest) {
      const f = String(file);
      if (f.includes('runtime.json.')) {
        tmpPaths.push(f);
        arrived++;
        const result = await origWriteFile.call(this, file, data, ...rest);
        if (arrived >= N && !released) { released = true; clearTimeout(safety); resolveGate(); }
        await gate;
        return result;
      }
      return origWriteFile.call(this, file, data, ...rest);
    };
    fs.rename = async function (oldPath, newPath) {
      if (String(oldPath).includes('runtime.json.') && !released) renamesBeforeRelease++;
      return origRename.call(this, oldPath, newPath);
    };

    const [ra, rb] = await Promise.allSettled([host.stop('aplug'), host.stop('bplug')]);
    restoreFsPatch();

    // Forcing asserted first, on a snapshot taken at release: two writers
    // reached the boundary and none renamed early.
    const snapshot = tmpPaths.slice(0, N);
    assert.equal(snapshot.length, N, 'two runtime.json writers must reach the write→rename boundary');
    assert.equal(renamesBeforeRelease, 0, 'no writer may rename before both arrived');

    assert.equal(ra.status, 'fulfilled', `stop('aplug') must not reject: ${ra.reason}`);
    assert.equal(rb.status, 'fulfilled', `stop('bplug') must not reject: ${rb.reason}`);
    // Measured (tmp name reverted to the shared `${file}.${pid}.tmp`, 8
    // runs): 8/8 died on `stop(...) must not reject` above, not here — the
    // losing stop's saveRuntimeRecords rename threw ENOENT on the stolen tmp
    // before this line ever ran. That assertion is what actually fires in
    // practice. This one remains the guaranteed backstop: killing 'aplug'
    // also fires handleChildExit('aplug') (rejection swallowed to
    // console.warn), so the pair held at the barrier may be {stop-a, exit-a}
    // rather than {stop-a, stop-b} — but with a shared tmp name, whichever
    // pair arrives, one writer's rename always steals the other's tmp, so
    // Set.size === 1 is unconditional even on a run where `fulfilled`
    // doesn't catch it first.
    //
    // Also measured: no production mutation kills this test on its own — the
    // only one that does is the shared-tmp-name revert, which kills test 1
    // too (making `stop`/`stopInternal` reject outright is too broad, since
    // it fails every stop-calling test in this file; dropping stopInternal's
    // saveRuntimeRecords() call survives, since handleChildExit still writes
    // runtime.json for each killed child). So this test is a production-path
    // symptom guard — it pins that a real stop() does not reject with ENOENT
    // — not an independent pin on the tmp-uniqueness invariant; that
    // invariant's only independent pin is test 1, above.
    assert.equal(new Set(snapshot).size, N, 'the two concurrent writers must not share a tmp path');
  } finally {
    restoreFsPatch();
    await host.stopAll();
    await env.restore();
  }
});
