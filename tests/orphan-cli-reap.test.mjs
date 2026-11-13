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
import { readRunningRecord, writeRunningRecord, writeResumeManifest, readResumeManifest, runningRecordPath } from '../src/resumeManifest.ts';
import fs from 'node:fs';
import { captureResumeFacts, finishDrain } from '../src/resumeRestart.ts';
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
  writeRunningRecord({ instances: [], clis: ['a', 'b', 'c'].map((sessionId) => ({ sessionId, pid: process.pid, start: `recorded-${sessionId}`, group: false })) });
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

// Invariant: each row is signalled in its own continuation, right after its own
// read matched — never after a later row's read, by which time its pid could name
// a stranger — and the same holds for the SIGKILL re-read of the survivors,
// which also runs concurrently. A survivor whose identity changed is not killed.
test('each row is signalled right after its own read, for SIGTERM and for the concurrent SIGKILL re-read', async (t) => {
  const home = await makeTmpHome();
  const restoreEnv = useHome(home);
  const a = sleeper();
  const b = sleeper();
  t.after(async () => { kill(a.pid); kill(b.pid); restoreEnv(); await rmrf(home); });
  writeRunningRecord({ instances: [], clis: [
    { sessionId: 'A', pid: a.pid, start: 'sA', group: false },
    { sessionId: 'B', pid: b.pid, start: 'sB', group: false },
  ] });
  const reads = new Map(); // `${pid}:${n}` → resolve
  const count = new Map();
  const signals = [];
  const platform = {
    ...hostPlatform,
    processStartTime: (pid) => {
      const n = count.get(pid) ?? 0;
      count.set(pid, n + 1);
      return new Promise((r) => reads.set(`${pid}:${n}`, r));
    },
    // Recorded, not delivered: both sleepers stay alive, so both survive the grace.
    killProcess: (pid, sig) => { signals.push([pid, sig]); },
    killGroup: () => { throw new Error('no group was recorded'); },
  };
  const reaping = reapOrphanedClis({ platform, log: QUIET, termGraceMs: 50 });
  await waitFor(() => reads.has(`${a.pid}:0`) && reads.has(`${b.pid}:0`));
  reads.get(`${a.pid}:0`)('sA');
  await waitFor(() => signals.length === 1);
  assert.deepEqual(signals, [[a.pid, 'SIGTERM']], 'A is signalled while B\'s read is still pending');
  reads.get(`${b.pid}:0`)('sB');
  await waitFor(() => signals.length === 2);
  assert.deepEqual(signals[1], [b.pid, 'SIGTERM']);

  await waitFor(() => reads.has(`${a.pid}:1`) && reads.has(`${b.pid}:1`), { timeout: 2000 });
  reads.get(`${a.pid}:1`)('sA');
  await waitFor(() => signals.length === 3);
  assert.deepEqual(signals[2], [a.pid, 'SIGKILL'], 'A\'s SIGKILL follows its own re-read, B\'s still pending');
  reads.get(`${b.pid}:1`)('a-stranger');
  const r = await reaping;
  assert.equal(signals.length, 3, 'B changed identity before its re-read answered: no SIGKILL');
  assert.deepEqual(r.terminated.sort(), [a.pid, b.pid].sort());
});

// Invariant: a CLI that outlives a CLEAN stop (it ignored stdin EOF past the
// sync stop's grace, and the record was removed after the stop) is still
// terminated before its session is respawned: the manifest carries the same
// `clis` rows, and the reap reads them.
test('a CLI that outlived a clean stop is terminated, from the manifest\'s clis, before its session is respawned', async (t) => {
  const launcherA = new ControllableLauncher({ realProcess: true });
  t.after(() => { for (const pid of launcherA.orphans) kill(pid); });
  const a = await bootServer({ claudeLauncher: launcherA, keepHome: true });
  const home = a.tmpHome;
  let aClosed = false;
  t.after(async () => { if (!aClosed) await a.close(); await rmrf(home); });
  const lifeA = startResumeLifecycle({ instances: a.instances, recorder: a.runningRecorder, pending: a.pendingContinue, log: QUIET, staggerMs: 0 });
  await api(a.baseUrl, 'POST', '/api/projects', { name: 'clean' });
  const inst = await a.instances.create({ project: 'clean' });
  await waitFor(() => inst.status === 'idle' && inst.sessionId && inst.pid);
  const survivorPid = inst.pid;
  void inst.prompt('busy');
  await waitFor(() => inst.status === 'turn');
  await waitFor(() => readRunningRecord({ log: QUIET })?.clis.some((c) => c.pid === survivorPid && c.start !== null), { timeout: 10000 });
  await seedSessionJsonl(inst.transcriptPlace, inst.backingSessionId);

  // The clean stop, with a CLI that ignores EOF: the sync stop's short grace
  // runs out, nothing is killed (posix), and the record is removed after it.
  launcherA.orphanAll();
  a.instances._syncStop = { graceMs: 50, killSurvivors: false };
  a.runningRecorder.pause();
  finishDrain({ instances: a.instances, log: QUIET }, captureResumeFacts(a.instances), { deliver: 'gated', clis: a.runningRecorder.clis() });
  assert.equal(fs.existsSync(runningRecordPath()), false, 'premise: a clean stop leaves no record');
  assert.ok(readResumeManifest({ log: QUIET }).clis.some((c) => c.pid === survivorPid && c.start !== null), 'the manifest names the CLI');
  lifeA.dispose();
  await a.close({ keepHome: true });
  aClosed = true;
  assert.equal(pidIsAlive(survivorPid), true, 'premise: the CLI outlived the clean stop');

  const seen = [];
  const launcherB = new ControllableLauncher({ onLaunch: () => seen.push(pidIsAlive(survivorPid)) });
  const restoreEnv = useHome(home);
  try { await prepareResumeBoot({ platform: hostPlatform, log: QUIET }); } finally { restoreEnv(); }
  const b = await bootServer({ claudeLauncher: launcherB, home, keepHome: true });
  t.after(() => b.close());
  const lifeB = startResumeLifecycle({ instances: b.instances, recorder: b.runningRecorder, pending: b.pendingContinue, log: QUIET, staggerMs: 0 });
  t.after(() => lifeB.dispose());
  assert.deepEqual(await lifeB.restored, { restored: 1 });
  assert.deepEqual(seen, [false], 'the respawn launched with the old CLI already gone');
  assert.equal(pidIsAlive(survivorPid), false);
});

// Invariant: the reap reads the union of the record's and the manifest's rows,
// one row per (pid, start), and consumes neither file.
test('the reap reads the record and the manifest, deduplicated, and consumes neither', async (t) => {
  const home = await makeTmpHome();
  const restoreEnv = useHome(home);
  const s1 = sleeper();
  const s2 = sleeper();
  t.after(async () => { kill(s1.pid); kill(s2.pid); restoreEnv(); await rmrf(home); });
  const row = (pid, start) => ({ sessionId: `s${pid}`, pid, start, group: false });
  writeRunningRecord({ instances: [], clis: [row(s1.pid, 'x1'), row(s2.pid, 'x2')] });
  writeResumeManifest([{ sessionId: 'e', group: 'other' }], { deliver: 'gated', clis: [row(s1.pid, 'x1'), row(s2.pid, 'y2')] });
  const read = [];
  const platform = { ...hostPlatform, processStartTime: async (pid) => { read.push(pid); return 'now'; } };
  const r = await reapOrphanedClis({ platform, log: QUIET, termGraceMs: 50 });
  assert.deepEqual(read.sort(), [s1.pid, s2.pid, s2.pid].sort(), 'x1 read once; x2 and y2 are distinct rows');
  assert.deepEqual(r.reused.length, 3);
  assert.ok(readRunningRecord({ log: QUIET }));
  assert.equal(readResumeManifest({ log: QUIET }).present, true);
});
