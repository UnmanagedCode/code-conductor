// The running recorder (src/runningRecord.ts): the record holds the same resume
// entries the manifest does, and its writes are change-driven, debounced,
// pausable and atomic. Plus the `clis` row builder's FUSE exclusion.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, waitFor, freshProjectsRoot, rmrf, api } from './helpers.mjs';
import { orchStoreRoot } from '../src/projects.ts';
import { createRunningRecorder, cliRows, START_TIME_ATTEMPTS } from '../src/runningRecord.ts';
import { hostPlatform } from '../src/platform/index.ts';
import { captureResumeFacts, buildResumeEntries, finishDrain } from '../src/resumeRestart.ts';
import { readRunningRecord, readResumeManifest, runningRecordPath, clearResumeManifest, writeRunningRecord } from '../src/resumeManifest.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASIC = path.join(__dirname, 'fixtures', 'scenario-basic.json');
// The first prompt leaves the session in 'turn'.
const DRAIN = path.join(__dirname, 'fixtures', 'scenario-drain.json');
const QUIET = { log() {}, warn() {}, error() {} };

let ctx, instances, home;
before(async () => { ctx = await bootServer({ scenarioPath: BASIC }); ({ instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => {
  await instances.shutdown();
  if (instances._idleHub) instances._idleHub._suspended = false;
  await rmrf(home);
});

async function createWithScenario(scenario, opts) {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = scenario;
  try {
    const inst = await instances.create(opts);
    await waitFor(() => inst.sessionId && inst.status === 'idle');
    return inst;
  } finally {
    if (prev === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
}

const recordInstances = () => readRunningRecord({ log: QUIET })?.instances ?? null;
const roundTrip = (v) => JSON.parse(JSON.stringify(v));

// Invariant: the record holds exactly the entries buildResumeEntries builds from
// the live set, and finishDrain writes those same entries into the manifest.
test('the record holds the manifest\'s facts for the same live state', async () => {
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'rec' });
  const busy = await createWithScenario(DRAIN, { project: 'rec' });
  const idle = await createWithScenario(BASIC, { project: 'rec' });
  void busy.prompt('stay busy');
  await waitFor(() => busy.status === 'turn');
  const recorder = createRunningRecorder({ instances, platform: hostPlatform, log: QUIET, debounceMs: 10 });
  recorder.start();
  try {
    const want = roundTrip(buildResumeEntries(instances, captureResumeFacts(instances)));
    assert.equal(want.length, 2, 'premise: both sessions are entries');
    assert.deepEqual(want.map((e) => [e.sessionId, e.wasBusy]).sort(), [[busy.sessionId, true], [idle.sessionId, false]].sort());
    await waitFor(() => JSON.stringify(recordInstances()) === JSON.stringify(want));
    recorder.pause();
    finishDrain({ instances, log: QUIET }, captureResumeFacts(instances), { deliver: 'gated' });
    assert.deepEqual(readResumeManifest({ log: QUIET }).instances, want);
    assert.equal(fs.existsSync(runningRecordPath()), false, 'finishDrain removes the record');
  } finally {
    recorder.stop();
    clearResumeManifest();
  }
});

// A manager stand-in whose live set the test edits by hand, with an
// EventEmitter-shaped subscription surface.
function fakeManager() {
  const listeners = new Map();
  const mgr = {
    byId: new Map(),
    conductedSubtreeOf: () => [],
    isIdleCaller: () => false,
    liveForSession: () => null,
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); },
    off(ev, fn) { listeners.get(ev)?.delete(fn); },
    emit(ev) { for (const fn of listeners.get(ev) ?? []) fn(); },
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
  return mgr;
}
function fakeInst(n) {
  return {
    id: `i${n}`, sessionId: `s${n}`, proc: {}, pid: null, status: 'idle', conducted: false, pristine: false,
    backgroundJobs: [], activeAgentTaskCount: 0, project: 'p',
    summary: () => ({ project: 'p', sessionId: `s${n}`, cwd: '/w', mode: 'plan' }),
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Invariant: writes are bounded and atomic — start() writes at once (an empty
// live set too); a burst of change events coalesces into one trailing write;
// an unchanged state writes nothing; pause() stops writes until resume(), which
// writes at once; stop() unsubscribes; no tmp file is ever left behind.
test('debounced, change-only, pausable, atomic writes', async () => {
  fs.mkdirSync(orchStoreRoot(), { recursive: true });
  const mgr = fakeManager();
  const writes = [];
  const write = (payload) => { writes.push(payload.instances.map((e) => e.sessionId)); writeRunningRecord(payload); };
  const recorder = createRunningRecorder({ instances: mgr, platform: hostPlatform, log: QUIET, debounceMs: 30, write });
  recorder.start();
  assert.deepEqual(writes, [[]], 'start writes at once, an empty live set included');
  assert.deepEqual(readRunningRecord({ log: QUIET }), { instances: [], clis: [] });

  mgr.byId.set('i1', fakeInst(1));
  for (let i = 0; i < 20; i++) mgr.emit(i % 2 ? 'status' : 'list_changed');
  assert.equal(writes.length, 1, 'nothing is written inside the debounce window');
  await waitFor(() => writes.length === 2, { timeout: 2000, interval: 5 });
  await sleep(100);
  assert.deepEqual(writes, [[], ['s1']], 'the burst wrote once');

  mgr.emit('subscription_changed');
  await sleep(100);
  assert.equal(writes.length, 2, 'an unchanged state writes nothing');

  recorder.pause();
  mgr.byId.set('i2', fakeInst(2));
  mgr.emit('status');
  await sleep(100);
  assert.equal(writes.length, 2, 'paused: no write');
  recorder.resume();
  assert.deepEqual(writes.at(-1), ['s1', 's2'], 'resume writes at once');
  assert.deepEqual(recordInstances().map((e) => e.sessionId), ['s1', 's2']);

  recorder.stop();
  assert.equal(mgr.listenerCount(), 0, 'stop unsubscribes');
  mgr.byId.delete('i1');
  mgr.emit('status');
  await sleep(100);
  assert.equal(writes.length, 3, 'stopped: no write');
  const residue = fs.readdirSync(orchStoreRoot()).filter((n) => n.startsWith('running-sessions.json.tmp-'));
  assert.deepEqual(residue, [], 'the atomic write leaves no tmp file');
});

// Invariant: a start time that could not be read is retried — never cached as
// unknown on one failure, never guessed — until it resolves or the bounded
// attempts run out, after which the row stays null; the delay before each retry
// doubles from startRetryMs.
test('a failed start-time read is retried with backoff, a bounded number of times', async () => {
  fs.mkdirSync(orchStoreRoot(), { recursive: true });
  const run = async (answers) => {
    const mgr = fakeManager();
    mgr.byId.set('i1', { ...fakeInst(1), pid: 4242, _fuse: null });
    let calls = 0;
    const delays = [];
    const platform = { ...hostPlatform, processStartTime: async () => answers[calls++] ?? null };
    const setTimer = (fn, ms) => { delays.push(ms); return setTimeout(fn, 1); };
    const recorder = createRunningRecorder({ instances: mgr, platform, log: QUIET, debounceMs: 5, startRetryMs: 5, setTimer });
    recorder.start();
    return { recorder, delays, calls: () => calls, start: () => readRunningRecord({ log: QUIET })?.clis[0]?.start };
  };
  const flaky = await run([null, null, 'T']);
  await waitFor(() => flaky.start() === 'T', { timeout: 2000, interval: 5 });
  assert.equal(flaky.calls(), 3);
  flaky.recorder.stop();

  const never = await run([]);
  await waitFor(() => never.calls() === START_TIME_ATTEMPTS, { timeout: 2000, interval: 5 });
  await sleep(150);
  assert.equal(never.calls(), START_TIME_ATTEMPTS, 'no read past the bound');
  assert.equal(never.start(), null);
  assert.deepEqual(never.delays, Array.from({ length: START_TIME_ATTEMPTS - 1 }, (_, i) => 5 * 2 ** i), 'each retry waits twice the last');
  never.recorder.stop();
});

// Invariant: every live CLI the launcher spawned gets one row — top-level,
// conducted and pristine alike — and a FUSE-wrapped one or one with no pid none.
test('clis rows: one per live pid, FUSE-wrapped and pid-less instances excluded', () => {
  const live = (over) => ({ id: over.sessionId, proc: {}, pid: 100, _fuse: null, ...over });
  const rows = cliRows([
    live({ sessionId: 'top', pid: 101 }),
    live({ sessionId: 'worker', pid: 102, conducted: true }),
    live({ sessionId: 'pristine', pid: 103, pristine: true }),
    live({ sessionId: 'fuse', pid: 104, _fuse: { record: {} } }),
    live({ sessionId: 'inproc', pid: null }),
    live({ sessionId: 'dead', pid: 105, proc: null }),
  ], { group: false, startOf: (i) => `t${i.pid}` });
  assert.deepEqual(rows, [
    { sessionId: 'top', pid: 101, start: 't101', group: false },
    { sessionId: 'worker', pid: 102, start: 't102', group: false },
    { sessionId: 'pristine', pid: 103, start: 't103', group: false },
  ]);
});
