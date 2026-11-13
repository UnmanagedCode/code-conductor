// The boot-time orphan reap (reapOrphanedClis, src/runningRecord.ts, run by
// prepareResumeBoot): a CLI the running record names that outlived an unclean
// stop is terminated before its session is respawned; a pid now naming another
// process is left alone; a pid whose identity cannot be read is left running,
// with a warning, and the restore still runs.
//
// Real idle node processes stand in for the CLIs: ControllableLauncher's
// `realProcess` backs each fake child with one, and `orphanAll()` leaves them
// running when cc's instances go, as a crash does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { bootServer, api, waitFor, makeTmpHome, rmrf, seedSessionJsonl } from './helpers.mjs';
import { ControllableLauncher } from './controllableLauncher.mjs';
import { hostPlatform } from '../src/platform/index.ts';
import { pidIsAlive } from '../src/systems/fuse/driver.ts';
import { readRunningRecord, writeRunningRecord } from '../src/resumeManifest.ts';
import { reapOrphanedClis } from '../src/runningRecord.ts';
import { prepareResumeBoot, startResumeLifecycle } from '../src/resumeBoot.ts';
import { localPlace } from '../src/projects.ts';

const QUIET = { log() {}, warn() {}, error() {} };
const BASIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'scenario-basic.json');

function sleeper() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  return child;
}
const kill = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };

// Point the store at `home` the way bootServer does, for a step that runs before
// any server exists (production order); returns the restore.
function useHome(home) {
  const prev = { PROJECTS_ROOT: process.env.PROJECTS_ROOT, CLAUDE_PROJECTS_ROOT: process.env.CLAUDE_PROJECTS_ROOT };
  process.env.PROJECTS_ROOT = path.join(home, 'project');
  process.env.CLAUDE_PROJECTS_ROOT = path.join(home, '.claude', 'projects');
  return () => Object.assign(process.env, prev);
}

// Invariant: a CLI that survives an unclean stop is never live alongside its
// resumed self — the reap terminates it before the next boot respawns the session.
test('a CLI left running by an unclean stop is terminated before its session is respawned', async (t) => {
  const launcherA = new ControllableLauncher({ realProcess: true });
  t.after(() => { for (const pid of launcherA.orphans) kill(pid); });
  const a = await bootServer({ claudeLauncher: launcherA, keepHome: true });
  const home = a.tmpHome;
  let aClosed = false;
  t.after(async () => { if (!aClosed) await a.close(); await rmrf(home); });
  const lifeA = startResumeLifecycle({ instances: a.instances, recorder: a.runningRecorder, pending: a.pendingContinue, log: QUIET, staggerMs: 0 });
  await api(a.baseUrl, 'POST', '/api/projects', { name: 'orph' });
  const inst = await a.instances.create({ project: 'orph' });
  await waitFor(() => inst.status === 'idle' && inst.sessionId && inst.pid);
  const orphanPid = inst.pid;
  void inst.prompt('busy');
  await waitFor(() => inst.status === 'turn');
  const row = await waitFor(() => readRunningRecord({ log: QUIET })?.clis.find((c) => c.sessionId === inst.sessionId && c.start !== null), { timeout: 10000 });
  assert.equal(row.pid, orphanPid);
  await seedSessionJsonl(inst.transcriptPlace, inst.backingSessionId);

  // The crash: recording stops with the record in place, the CLI keeps running.
  lifeA.dispose();
  launcherA.orphanAll();
  await a.close({ keepHome: true });
  aClosed = true;
  assert.equal(pidIsAlive(orphanPid), true, 'premise: the CLI outlived cc');

  // Boot B, in production order: the reap, then the server, then the lifecycle.
  const seen = [];
  const launcherB = new ControllableLauncher({ onLaunch: () => seen.push(pidIsAlive(orphanPid)) });
  const restoreEnv = useHome(home);
  try { await prepareResumeBoot({ platform: hostPlatform, log: QUIET }); } finally { restoreEnv(); }
  const b = await bootServer({ claudeLauncher: launcherB, home, keepHome: true });
  t.after(() => b.close());
  const lifeB = startResumeLifecycle({ instances: b.instances, recorder: b.runningRecorder, pending: b.pendingContinue, log: QUIET, staggerMs: 0 });
  t.after(() => lifeB.dispose());
  assert.deepEqual(await lifeB.restored, { restored: 1 });
  assert.ok(b.instances.liveForSession(inst.sessionId), 'the session is respawned');
  assert.deepEqual(seen, [false], 'its respawn launched with the old CLI already gone');
  assert.equal(pidIsAlive(orphanPid), false);
  assert.deepEqual(b.pendingContinue.list().map((n) => [n.sessionId, n.kind]), [[inst.sessionId, 'unclean']]);
});

// Invariant: a reused pid is never killed — a live process whose start time
// differs from the recorded one is left running.
test('a pid that now names another process is left alone', async (t) => {
  const home = await makeTmpHome();
  const restoreEnv = useHome(home);
  const s = sleeper();
  t.after(async () => { kill(s.pid); restoreEnv(); await rmrf(home); });
  await waitFor(async () => (await hostPlatform.processStartTime(s.pid)) !== null);
  writeRunningRecord({ instances: [], clis: [{ sessionId: 'x', pid: s.pid, start: 'some-other-start', group: false }] });
  const r = await reapOrphanedClis({ platform: hostPlatform, log: QUIET, termGraceMs: 200 });
  assert.deepEqual(r, { terminated: [], unverifiable: [], reused: [s.pid] });
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(pidIsAlive(s.pid), true);
  assert.equal(s.exitCode, null);
  assert.equal(s.signalCode, null);
});

// Invariant: no identity, no kill — a live pid whose start time cannot be read is
// left running with a warning naming it, and the restore still respawns its
// session.
test('an unverifiable pid is not signalled, a warning names it, and the restore still runs', async (t) => {
  const s = sleeper();
  t.after(() => kill(s.pid));
  const ctx = await bootServer({ scenarioPath: BASIC });
  t.after(() => ctx.close());
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'unv' });
  const sessionId = '00000091-0000-4000-8000-000000000091';
  const cwd = path.join(ctx.projectsRoot, 'unv');
  await seedSessionJsonl(localPlace(cwd), sessionId);
  const entry = {
    project: 'unv', sessionId, cwd, mode: 'plan', effort: 'high', thinking: 'adaptive', model: null,
    worktreeName: null, temp: false, conducted: false, debug: false, title: null, autoApprovePlan: false,
    group: 'other', wasBusy: true,
  };
  const signalled = [];
  const blind = {
    ...hostPlatform,
    processStartTime: async () => null,
    killProcess: (pid, sig) => signalled.push([pid, sig]),
    killGroup: (pid, sig) => signalled.push([pid, sig]),
  };
  for (const start of [null, 'recorded-start']) {
    writeRunningRecord({ instances: [entry], clis: [{ sessionId, pid: s.pid, start, group: false }] });
    const warns = [];
    const r = await reapOrphanedClis({ platform: blind, log: { log() {}, warn: (...a) => warns.push(a.join(' ')) }, termGraceMs: 200 });
    assert.deepEqual(r, { terminated: [], unverifiable: [s.pid], reused: [] }, `start ${start}`);
    assert.equal(warns.length, 1);
    assert.match(warns[0], new RegExp(`${sessionId}.*pid ${s.pid}`));
  }
  assert.deepEqual(signalled, []);
  assert.equal(pidIsAlive(s.pid), true);

  const l = startResumeLifecycle({ instances: ctx.instances, recorder: ctx.runningRecorder, pending: ctx.pendingContinue, log: QUIET, staggerMs: 0 });
  t.after(() => l.dispose());
  assert.deepEqual(await l.restored, { restored: 1 });
  assert.ok(ctx.instances.liveForSession(sessionId));
});

// Invariant: the reap reads every recorded start time at once, so its wait is
// about one start-time read timeout, not one per row.
test('the reap reads every recorded start time concurrently', async (t) => {
  const home = await makeTmpHome();
  const restoreEnv = useHome(home);
  t.after(async () => { restoreEnv(); await rmrf(home); });
  writeRunningRecord({ instances: [], clis: ['a', 'b', 'c'].map((sessionId) => ({ sessionId, pid: process.pid, start: 'recorded', group: false })) });
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const platform = {
    ...hostPlatform,
    processStartTime: async () => { calls++; await gate; return null; },
    killProcess: () => { throw new Error('nothing may be signalled'); },
    killGroup: () => { throw new Error('nothing may be signalled'); },
  };
  const reaping = reapOrphanedClis({ platform, log: QUIET, termGraceMs: 100 });
  await waitFor(() => calls === 3, { timeout: 2000 });
  release();
  const r = await reaping;
  assert.deepEqual(r.unverifiable, [process.pid, process.pid, process.pid]);
});
