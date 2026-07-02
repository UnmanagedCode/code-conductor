import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { encodeCwd, orchStoreRoot } from '../src/projects.js';
import { SOFT_INTERRUPT_MARKER } from '../src/parser.js';
import {
  resumeManifestPath,
  writeResumeManifest,
  readResumeManifest,
  clearResumeManifest,
} from '../src/resumeManifest.js';
import {
  drainToManifest,
  restoreFromResumeManifest,
  buildConductorResumeText,
  WIND_DOWN_TEXT,
  WIND_DOWN_TEXT_CONDUCTOR,
  RESUME_TEXT,
} from '../src/resumeRestart.js';
import { ensureConductProject, CONDUCT_PROJECT_NAME } from '../src/conduct.js';
import { AUTO_RESUME_TEXT } from '../src/instances.js';

const nowSec = () => Math.floor(Date.now() / 1000);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASIC = path.join(__dirname, 'fixtures', 'scenario-basic.json');
const NO_TURN = path.join(__dirname, 'fixtures', 'scenario-no-turn.json');
// Two-prompt scenario: first prompt keeps instance in 'turn' (empty emit),
// second prompt (the windDown user message) emits a result so drainToManifest's
// waitAllIdle loop can resolve without looping forever.
const DRAIN = path.join(__dirname, 'fixtures', 'scenario-drain.json');

let ctx, baseUrl, instances, home, projectsRoot, claudeProjectsRoot;

before(async () => {
  ctx = await bootServer({ scenarioPath: BASIC });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => {
  ({ home, projectsRoot, claudeProjectsRoot } = await freshProjectsRoot());
  ctx.projectsRoot = projectsRoot;
  ctx.claudeProjectsRoot = claudeProjectsRoot;
});
afterEach(async () => {
  await instances.shutdown();
  instances._idleSubscribers?.clear();
  await rmrf(home);
});

// --- 1. manifest round-trip ------------------------------------------------

test('resume manifest write/read/clear round-trip + corrupt handling', async () => {
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  // Absent → empty.
  assert.deepEqual(readResumeManifest({ log: { warn() {} } }).instances, []);

  const entries = [{ project: 'p', sessionId: 'sid-1', cwd: '/c', mode: 'plan', group: 'other' }];
  writeResumeManifest(entries);
  await fs.access(resumeManifestPath());
  assert.deepEqual(readResumeManifest().instances, entries);

  // Corrupt → empty + file removed.
  await fs.writeFile(resumeManifestPath(), 'not json{');
  assert.deepEqual(readResumeManifest({ log: { warn() {} } }).instances, []);
  await assert.rejects(() => fs.access(resumeManifestPath()));

  // Empty list is a no-op write.
  writeResumeManifest([]);
  await assert.rejects(() => fs.access(resumeManifestPath()));

  writeResumeManifest(entries);
  clearResumeManifest();
  await assert.rejects(() => fs.access(resumeManifestPath()));
});

// --- 2. shutdownForResumeSync preserves temp jsonl -------------------------

test('shutdownForResumeSync SIGKILLs subprocesses but preserves temp + normal jsonl', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'resumekeep' });
  const tempRes = await api(baseUrl, 'POST', '/api/instances', { project: 'resumekeep', temp: true });
  const tempInst = instances.get(tempRes.body.id);
  await waitFor(() => tempInst.status === 'idle' && tempInst.sessionId);
  const normalRes = await api(baseUrl, 'POST', '/api/instances', { project: 'resumekeep' });
  const normalInst = instances.get(normalRes.body.id);
  await waitFor(() => normalInst.status === 'idle' && normalInst.sessionId);

  const dir = path.join(claudeProjectsRoot, encodeCwd(tempInst.cwd));
  await fs.mkdir(dir, { recursive: true });
  const tempJsonl = path.join(dir, `${tempInst.sessionId}.jsonl`);
  const normalJsonl = path.join(dir, `${normalInst.sessionId}.jsonl`);
  await fs.writeFile(tempJsonl, '{"type":"user","uuid":"u1"}\n');
  await fs.writeFile(normalJsonl, '{"type":"user","uuid":"u2"}\n');

  instances.shutdownForResumeSync();
  // Wait for the async _handleExit to fire (clears proc) — the
  // _suppressTempDelete guard must keep it from deleting the jsonl. Poll the
  // real signal instead of a fixed sleep.
  await waitFor(() => tempInst.proc === null && normalInst.proc === null, { timeout: 20000 });

  await fs.access(tempJsonl);   // temp jsonl PRESERVED (contrast shutdownTempSync)
  await fs.access(normalJsonl);
});

// --- 3. windDown semantics -------------------------------------------------

test('windDown is a no-op when idle and injects the hidden marker mid-turn', async () => {
  const transcript = path.join(os.tmpdir(), `cc-winddown-${randomUUID()}.log`);
  const prevTranscript = process.env.FAKE_CLAUDE_TRANSCRIPT;
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcript;
  process.env.FAKE_CLAUDE_SCENARIO = NO_TURN;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'winddown' });
    const res = await api(baseUrl, 'POST', '/api/instances', { project: 'winddown' });
    const inst = instances.get(res.body.id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);

    // Idle → no-op.
    inst.windDown('should be ignored');
    assert.equal(inst.interrupting, false);

    // Drive into a turn (no-turn scenario keeps it open).
    await inst.prompt('go');
    await waitFor(() => inst.status === 'turn');
    inst.windDown(WIND_DOWN_TEXT);
    assert.equal(inst.interrupting, true);

    await waitFor(async () => {
      try { return (await fs.readFile(transcript, 'utf8')).includes(SOFT_INTERRUPT_MARKER); }
      catch { return false; }
    });
    const dump = await fs.readFile(transcript, 'utf8');
    assert.ok(dump.includes(SOFT_INTERRUPT_MARKER), 'marker injected to stdin');
    assert.ok(dump.includes('about to restart'), 'wind-down text injected');
  } finally {
    if (prevTranscript === undefined) delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    else process.env.FAKE_CLAUDE_TRANSCRIPT = prevTranscript;
    if (prevScenario === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
    await fs.rm(transcript, { force: true });
  }
});

// --- 4. conductedWorkersOf -------------------------------------------------

test('conductedWorkersOf enumerates a conductor\'s live workers', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'cwproj' });
  const conductor = await instances.create({ project: 'cwproj' });
  await waitFor(() => conductor.sessionId);
  const w1 = await instances.create({ project: 'cwproj', callerInstanceId: conductor.id, conducted: true });
  const w2 = await instances.create({ project: 'cwproj', callerInstanceId: conductor.id, conducted: true });
  await waitFor(() => w1.sessionId && w2.sessionId);

  const workers = instances.conductedWorkersOf(conductor.id);
  assert.equal(workers.length, 2);
  const sids = workers.map(w => w.sessionId).sort();
  assert.deepEqual(sids, [w1.sessionId, w2.sessionId].sort());
  assert.ok(workers.every(w => w.worktreeName === null));
  assert.ok(workers.every(w => w.project === 'cwproj'), 'each worker carries its project');
  assert.equal(instances.conductedWorkersOf('nobody').length, 0);
});

// --- 5+6. boot restore: three-group split + conductor worker injection -----

test('restoreFromResumeManifest resumes conductors + others, skips workers, injects worker list', async () => {
  const transcript = path.join(os.tmpdir(), `cc-restore-${randomUUID()}.log`);
  const prevTranscript = process.env.FAKE_CLAUDE_TRANSCRIPT;
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcript;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'realproj' });

    const conductorSid = randomUUID();
    const otherSid = randomUUID();
    const workerSid = randomUUID();
    const conductCwd = path.join(projectsRoot, '.conduct');
    const otherCwd = path.join(projectsRoot, 'realproj');

    // Materialize resumable jsonls at the cwd-encoded paths loadHistory reads.
    for (const [cwd, sid] of [[conductCwd, conductorSid], [otherCwd, otherSid]]) {
      const dir = path.join(claudeProjectsRoot, encodeCwd(cwd));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${sid}.jsonl`), '{"type":"user","uuid":"u1"}\n');
    }

    await fs.mkdir(orchStoreRoot(), { recursive: true });
    writeResumeManifest([
      {
        project: '.conduct', sessionId: conductorSid, cwd: conductCwd,
        mode: 'bypassPermissions', effort: 'high', thinking: 'adaptive', model: null,
        worktreeName: null, temp: true, conducted: false, debug: false, title: null,
        autoApprovePlan: false, group: 'conductor',
        workers: [{ project: 'realproj', sessionId: workerSid, worktreeName: 'realproj_worktree_zz' }],
      },
      {
        project: 'realproj', sessionId: workerSid, cwd: otherCwd,
        mode: 'plan', effort: 'high', thinking: 'adaptive', model: null,
        worktreeName: 'realproj_worktree_zz', temp: true, conducted: true, debug: false,
        title: null, autoApprovePlan: false, group: 'worker',
      },
      {
        project: 'realproj', sessionId: otherSid, cwd: otherCwd,
        mode: 'bypassPermissions', effort: 'high', thinking: 'adaptive', model: null,
        worktreeName: null, temp: false, conducted: false, debug: false, title: null,
        autoApprovePlan: false, group: 'other',
      },
    ]);

    const { restored } = await restoreFromResumeManifest({ instances, log: { log() {}, warn() {} }, staggerMs: 0 });
    assert.equal(restored, 2, 'conductor + other resumed, worker skipped');

    const sids = [...instances.byId.values()].map(i => i.sessionId);
    assert.ok(sids.includes(conductorSid), 'conductor resumed');
    assert.ok(sids.includes(otherSid), 'other resumed');
    assert.ok(!sids.includes(workerSid), 'conducted worker NOT resumed from boot loop');

    // Manifest consumed.
    await assert.rejects(() => fs.access(resumeManifestPath()));

    // Resume notifications injected to stdin (shared transcript). fake-claude
    // writes the transcript asynchronously, so poll until both prompts land.
    await waitFor(async () => {
      try {
        const d = await fs.readFile(transcript, 'utf8');
        return d.includes(RESUME_TEXT) && d.includes(workerSid);
      } catch { return false; }
    });
    const dump = await fs.readFile(transcript, 'utf8');
    assert.ok(dump.includes(RESUME_TEXT), 'plain resume text injected');
    assert.ok(dump.includes(workerSid), 'conductor prompt embeds worker sessionId');
    assert.ok(dump.includes('project `realproj`'), 'conductor prompt embeds worker project');
    assert.ok(dump.includes('resume conducting your workers'), 'conductor resume text injected');
  } finally {
    if (prevTranscript === undefined) delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    else process.env.FAKE_CLAUDE_TRANSCRIPT = prevTranscript;
    await fs.rm(transcript, { force: true });
  }
});

test('buildConductorResumeText lists each worker sessionId + worktree', () => {
  const txt = buildConductorResumeText([
    { project: 'p1', sessionId: 'aaa', worktreeName: 'wt-1' },
    { project: 'p2', sessionId: 'bbb', worktreeName: null },
  ]);
  assert.ok(txt.includes('project `p1`, sessionId `aaa`, worktree `wt-1`'));
  assert.ok(txt.includes('project `p2`, sessionId `bbb`, (no worktree)'));
  assert.ok(buildConductorResumeText([]).includes('(none recorded)'));
});

// --- 7. drain: mid-turn instance wound down to idle, written to manifest ----

test('drainToManifest winds a mid-turn instance down to idle and writes it to the manifest', async () => {
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = DRAIN;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'drainproj' });
    const res = await api(baseUrl, 'POST', '/api/instances', { project: 'drainproj' });
    const inst = instances.get(res.body.id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);
    const sid = inst.sessionId;
    await inst.prompt('go');
    await waitFor(() => inst.status === 'turn');

    // Pass null server/wss so the test server stays bindable for close().
    const entries = await drainToManifest({ server: null, wss: null, instances, log: { warn() {}, log() {}, error() {} }, graceMs: 100 });

    assert.equal(entries.length, 1);
    assert.equal(entries[0].sessionId, sid);
    assert.equal(entries[0].group, 'other');
    await fs.access(resumeManifestPath());
    assert.equal(readResumeManifest().instances[0].sessionId, sid);
    // shutdownForResumeSync() SIGKILLs synchronously and busy-waits only for the
    // OS to reap the pid; inst.proc is cleared by the async _handleExit ('exit'
    // event), which can't run until the event loop turns after the sync call
    // returns. Wait on that real signal rather than asserting synchronously.
    await waitFor(() => inst.proc === null, { timeout: 20000 });
    clearResumeManifest();
  } finally {
    if (prevScenario === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
});

// --- 8. manifest excludes non-live (exited) instances ----------------------

// --- 9. wasBusy captured correctly at drain time ---------------------------

test('drainToManifest sets wasBusy:true for mid-turn and wasBusy:false for idle', async () => {
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = DRAIN;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'busycheck' });

    // Idle instance.
    const idleRes = await api(baseUrl, 'POST', '/api/instances', { project: 'busycheck' });
    const idleInst = instances.get(idleRes.body.id);
    await waitFor(() => idleInst.status === 'idle' && idleInst.sessionId);

    // Busy instance — drive into a turn with the no-turn scenario.
    const busyRes = await api(baseUrl, 'POST', '/api/instances', { project: 'busycheck' });
    const busyInst = instances.get(busyRes.body.id);
    await waitFor(() => busyInst.status === 'idle' && busyInst.sessionId);
    await busyInst.prompt('go');
    await waitFor(() => busyInst.status === 'turn');

    const entries = await drainToManifest({ server: null, wss: null, instances, log: { warn() {}, log() {}, error() {} }, graceMs: 200 });
    const byId = Object.fromEntries(entries.map(e => [e.sessionId, e]));

    assert.equal(byId[idleInst.sessionId].wasBusy, false, 'idle session → wasBusy:false');
    assert.equal(byId[busyInst.sessionId].wasBusy, true,  'busy session → wasBusy:true');
    clearResumeManifest();
  } finally {
    if (prevScenario === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
});

// --- 10. idle sessions resurrected silently, busy sessions re-prompted -----

test('restoreFromResumeManifest prompts busy sessions but not idle sessions', async () => {
  const transcript = path.join(os.tmpdir(), `cc-wasBusy-${randomUUID()}.log`);
  const prevTranscript = process.env.FAKE_CLAUDE_TRANSCRIPT;
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcript;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'busygate' });
    const busySid = randomUUID();
    const idleSid = randomUUID();
    const cwd = path.join(projectsRoot, 'busygate');

    for (const sid of [busySid, idleSid]) {
      const dir = path.join(claudeProjectsRoot, encodeCwd(cwd));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${sid}.jsonl`), '{"type":"user","uuid":"u1"}\n');
    }

    const baseEntry = { project: 'busygate', cwd, mode: 'plan', effort: 'high', thinking: 'adaptive', model: null, worktreeName: null, temp: false, conducted: false, debug: false, title: null, autoApprovePlan: false, group: 'other' };
    await fs.mkdir(orchStoreRoot(), { recursive: true });
    writeResumeManifest([
      { ...baseEntry, sessionId: busySid, wasBusy: true  },
      { ...baseEntry, sessionId: idleSid, wasBusy: false },
    ]);

    const { restored } = await restoreFromResumeManifest({ instances, log: { log() {}, warn() {} }, staggerMs: 0 });
    assert.equal(restored, 2, 'both sessions restored');

    // Poll until the busy session's prompt has arrived.
    await waitFor(async () => {
      try { return (await fs.readFile(transcript, 'utf8')).includes(busySid) || (await fs.readFile(transcript, 'utf8')).includes(RESUME_TEXT); }
      catch { return false; }
    }, 5000);

    // Give a short extra window to catch any spurious prompt to the idle session.
    await new Promise(r => setTimeout(r, 300));

    const dump = await fs.readFile(transcript, 'utf8');
    // Count how many times the RESUME_TEXT appears — only the busy session should receive it.
    const promptCount = (dump.match(new RegExp(RESUME_TEXT.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    assert.equal(promptCount, 1, 'exactly one resume prompt sent (to the busy session)');
  } finally {
    if (prevTranscript === undefined) delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    else process.env.FAKE_CLAUDE_TRANSCRIPT = prevTranscript;
    await fs.rm(transcript, { force: true });
  }
});

// --- 8. manifest excludes non-live (exited) instances ----------------------

test('drainToManifest excludes exited instances still retained in byId', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'liveonly' });
  const deadRes = await api(baseUrl, 'POST', '/api/instances', { project: 'liveonly' });
  const dead = instances.get(deadRes.body.id);
  await waitFor(() => dead.status === 'idle' && dead.sessionId);
  const liveRes = await api(baseUrl, 'POST', '/api/instances', { project: 'liveonly' });
  const live = instances.get(liveRes.body.id);
  await waitFor(() => live.status === 'idle' && live.sessionId);

  // Kill one (non-temp) instance: proc becomes null but it stays in byId.
  await dead.kill({ graceMs: 50 });
  assert.equal(dead.proc, null);
  assert.ok(instances.byId.has(dead.id), 'exited non-temp instance retained in byId');

  const entries = await drainToManifest({ server: null, wss: null, instances, log: { warn() {}, log() {}, error() {} }, graceMs: 100 });
  const sids = entries.map(e => e.sessionId);
  assert.ok(sids.includes(live.sessionId), 'live instance included');
  assert.ok(!sids.includes(dead.sessionId), 'exited instance excluded');
  clearResumeManifest();
});

// --- 12. firstPrompt round-trips through manifest (temp session title bug) ---

test('drainToManifest captures firstPrompt; restoreFromResumeManifest restores it on a temp session', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'fp-roundtrip' });
  const res = await api(baseUrl, 'POST', '/api/instances', { project: 'fp-roundtrip', temp: true });
  const inst = instances.get(res.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);

  // Sending a prompt caches firstPrompt on the instance.
  await inst.prompt('my first test prompt');
  await waitFor(() => inst.status === 'idle');
  assert.equal(inst.firstPrompt, 'my first test prompt', 'firstPrompt set in memory after prompt');

  // Materialize a jsonl so --resume can find the session on restore.
  const dir = path.join(claudeProjectsRoot, encodeCwd(inst.cwd));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${inst.sessionId}.jsonl`), '{"type":"user","uuid":"u1"}\n');

  const entries = await drainToManifest({ server: null, wss: null, instances, log: { warn() {}, log() {}, error() {} }, graceMs: 100 });
  assert.equal(entries.length, 1, 'one entry in manifest');
  assert.equal(entries[0].firstPrompt, 'my first test prompt', 'firstPrompt persisted to manifest');
  assert.equal(entries[0].temp, true, 'temp flag preserved in manifest');

  // Wait for the process to die after shutdownForResumeSync.
  await waitFor(() => inst.proc === null, { timeout: 20000 });

  const { restored } = await restoreFromResumeManifest({ instances, log: { log() {}, warn() {} }, staggerMs: 0 });
  assert.equal(restored, 1, 'one session restored');

  // The restored instance is a fresh object (new id) with the same sessionId.
  const newInst = [...instances.byId.values()].find(i => i.sessionId === inst.sessionId && i.id !== inst.id);
  assert.ok(newInst, 'new instance created for the restored temp session');
  assert.equal(newInst.firstPrompt, 'my first test prompt', 'firstPrompt restored on new instance');
  assert.equal(newInst.temp, true, 'temp flag preserved on restored instance');
  clearResumeManifest();
});

// --- 11. a parked (idle, waiting-on-worker) conductor is treated as busy ----
// The regression fix: an idle conductor that ended its turn and is parked on an
// OUTGOING idle-subscription (waiting on a worker) has durable re-conduct work,
// so it must be wasBusy:true → re-prompted on boot. An idle conductor with NO
// subscription stays wasBusy:false → resurrected silently. Shutdown stop
// (windDown) stays mid-turn-only regardless.

test('drainToManifest: idle conductor parked on a subscription is wasBusy:true; idle-no-sub stays silent; windDown is mid-turn-only', async () => {
  const transcript = path.join(os.tmpdir(), `cc-parked-${randomUUID()}.log`);
  const prevTranscript = process.env.FAKE_CLAUDE_TRANSCRIPT;
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcript;
  process.env.FAKE_CLAUDE_SCENARIO = DRAIN;
  try {
    await ensureConductProject();
    await api(baseUrl, 'POST', '/api/projects', { name: 'workproj' });

    // Three conductors in .conduct + one worker (the subscription target).
    const midTurn   = await instances.create({ project: CONDUCT_PROJECT_NAME });
    const parked    = await instances.create({ project: CONDUCT_PROJECT_NAME });
    const idleNoSub = await instances.create({ project: CONDUCT_PROJECT_NAME });
    const worker    = await instances.create({ project: 'workproj', callerInstanceId: parked.id, conducted: true });
    await waitFor(() => [midTurn, parked, idleNoSub, worker].every(i => i.sessionId));
    await waitFor(() => [midTurn, parked, idleNoSub, worker].every(i => i.status === 'idle'));

    // Park `parked` on the worker's idle: an OUTGOING subscription (parked is the
    // caller) ⇒ isIdleCaller(parked) true. `idleNoSub` has no subscription.
    // The idle-subscription graph is keyed by sessionId.
    instances.subscribeIdle(parked.sessionId, worker.sessionId);
    assert.equal(instances.isIdleCaller(parked.sessionId), true, 'parked conductor is an idle caller');
    assert.equal(instances.isIdleCaller(idleNoSub.sessionId), false, 'idle-no-sub conductor is not a caller');

    // Drive only `midTurn` into a turn (DRAIN scenario keeps it open until windDown).
    await midTurn.prompt('go');
    await waitFor(() => midTurn.status === 'turn');

    // Capture windDown invocation via status event: drainToManifest's step 2 calls
    // windDown() which sets interrupting=true and emits 'status'. Step 3 then waits
    // for the instance to go idle (result event from the DRAIN scenario's second
    // turn), which transitions status away from 'turn' and resets interrupting=false
    // via _setStatus(). We must capture the flag before that reset.
    let midTurnWoundDown = false;
    const captureWindDown = (s) => { if (s.interrupting) midTurnWoundDown = true; };
    midTurn.on('status', captureWindDown);

    const entries = await drainToManifest({ server: null, wss: null, instances, log: { warn() {}, log() {}, error() {} }, graceMs: 200 });
    midTurn.off('status', captureWindDown);
    const byId = Object.fromEntries(entries.map(e => [e.sessionId, e]));

    // wasBusy (the predicate Edit 1 widened): mid-turn OR parked ⇒ true.
    assert.equal(byId[midTurn.sessionId].wasBusy,   true,  'mid-turn conductor → wasBusy:true');
    assert.equal(byId[parked.sessionId].wasBusy,    true,  'idle conductor parked on a subscription → wasBusy:true');
    assert.equal(byId[idleNoSub.sessionId].wasBusy, false, 'idle conductor with no subscription → wasBusy:false (silent)');
    // Regression: a plain idle worker (no outgoing subscription) stays silent.
    assert.equal(byId[worker.sessionId].wasBusy,    false, 'idle worker with no outgoing subscription → wasBusy:false');

    // Shutdown side (Bug 1, unchanged): windDown fires ONLY for the mid-turn one.
    assert.equal(midTurnWoundDown,        true,  'mid-turn conductor wound down');
    assert.equal(parked.interrupting,    false, 'idle parked conductor NOT wound down');
    assert.equal(idleNoSub.interrupting, false, 'idle conductor NOT wound down');
    assert.equal(worker.interrupting,    false, 'idle worker NOT wound down');

    // The conductor wind-down variant was injected exactly once (mid-turn only).
    await waitFor(async () => {
      try { return (await fs.readFile(transcript, 'utf8')).includes(WIND_DOWN_TEXT_CONDUCTOR); }
      catch { return false; }
    });
    const dump = await fs.readFile(transcript, 'utf8');
    const frag = 'Every worker you are conducting';
    const condWindCount = (dump.match(new RegExp(frag, 'g')) || []).length;
    assert.equal(condWindCount, 1, 'WIND_DOWN_TEXT_CONDUCTOR injected once — to the mid-turn conductor only');

    clearResumeManifest();
  } finally {
    if (prevTranscript === undefined) delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    else process.env.FAKE_CLAUDE_TRANSCRIPT = prevTranscript;
    if (prevScenario === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
    await fs.rm(transcript, { force: true });
  }
});

// --- 13. overage resume survives a restart: manifest round-trip -------------
// A pending overage auto-resume (in-memory-only sweep deadline) must be captured
// in the manifest so boot can re-arm it. Arm a real resume via _armAutoResume,
// then drain and assert the deadline + intent round-trip into the entry.

test('drainToManifest persists a pending overage auto-resume (overageResumeAt/overageStopped)', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'ovg-rt' });
  const res = await api(baseUrl, 'POST', '/api/instances', { project: 'ovg-rt' });
  const inst = instances.get(res.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);

  // Materialize a jsonl so the entry is a valid resume target.
  const dir = path.join(claudeProjectsRoot, encodeCwd(inst.cwd));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${inst.sessionId}.jsonl`), '{"type":"user","uuid":"u1"}\n');

  // Arm a real overage resume: stamp the reset time + intent, then let the
  // controller compute the fire deadline (resetsAt + buffer) exactly as the
  // live idle-transition path does.
  inst.autoStoppedForOverage = true;
  inst._overageResetsAt = nowSec() + 100;          // 100s out, comfortably future
  inst._overageQueue = [{ text: 'hold this for me', attachments: [], ts: Date.now() }];
  instances._armAutoResume(inst);
  assert.ok(Number.isFinite(inst.autoResumeAt), 'resume deadline armed');
  assert.ok(instances._autoResumeTimers.has(inst.sessionId), 'sweep deadline set');

  const entries = await drainToManifest({ server: null, wss: null, instances, log: { warn() {}, log() {}, error() {} }, graceMs: 100 });
  const e = entries.find(x => x.sessionId === inst.sessionId);
  assert.ok(e, 'session captured in manifest');
  assert.equal(e.overageStopped, true, 'stop-resume intent persisted');
  assert.equal(e.overageResumeAt, inst.autoResumeAt, 'fire deadline (epoch secs) persisted');
  assert.equal(e.overageResetsAt, inst._overageResetsAt, 'reset time persisted');
  assert.deepEqual(e.overageQueue, inst._overageQueue, 'queued messages persisted');
  await waitFor(() => inst.proc === null, { timeout: 20000 });
  clearResumeManifest();
});

// --- 14. CRITICAL: a PAST-DUE overage resume fires on the first boot tick ----
// The whole point: a window that reset while the orchestrator was down must
// resume immediately after boot. armRestored re-inserts the (already-past)
// deadline as-is; the wall-clock sweep fires it on the first tick. We drive the
// sweep fast via ORCH_OVERAGE_RESUME_SWEEP_MS and assert AUTO_RESUME_TEXT lands.

test('restoreFromResumeManifest fires a PAST-DUE overage resume promptly on boot', async () => {
  const transcript = path.join(os.tmpdir(), `cc-ovg-past-${randomUUID()}.log`);
  const prevTranscript = process.env.FAKE_CLAUDE_TRANSCRIPT;
  const prevSweep = process.env.ORCH_OVERAGE_RESUME_SWEEP_MS;
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcript;
  process.env.ORCH_OVERAGE_RESUME_SWEEP_MS = '40'; // drive the sweep fast
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'ovg-past' });
    const sid = randomUUID();
    const cwd = path.join(projectsRoot, 'ovg-past');
    const dir = path.join(claudeProjectsRoot, encodeCwd(cwd));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${sid}.jsonl`), '{"type":"user","uuid":"u1"}\n');

    await fs.mkdir(orchStoreRoot(), { recursive: true });
    writeResumeManifest([{
      project: 'ovg-past', sessionId: sid, cwd, mode: 'plan', effort: 'high',
      thinking: 'adaptive', model: null, worktreeName: null, temp: false,
      conducted: false, debug: false, title: null, autoApprovePlan: false,
      group: 'other', wasBusy: false,
      overageStopped: true, overageResumeAt: nowSec() - 10, overageResetsAt: nowSec() - 15,
    }]);

    const { restored } = await restoreFromResumeManifest({ instances, log: { log() {}, warn() {} }, staggerMs: 0 });
    assert.equal(restored, 1, 'session restored');

    // The sweep fires the past-due deadline → AUTO_RESUME_TEXT is sent.
    await waitFor(async () => {
      try { return (await fs.readFile(transcript, 'utf8')).includes(AUTO_RESUME_TEXT); }
      catch { return false; }
    }, { timeout: 8000 });
    const dump = await fs.readFile(transcript, 'utf8');
    assert.ok(dump.includes(AUTO_RESUME_TEXT), 'AUTO_RESUME_TEXT delivered on boot');
    // Firing tears the deadline down (the resume prompt's user_prompt cancels it).
    await waitFor(() => !instances._autoResumeTimers.has(sid));
    assert.ok(!instances._autoResumeTimers.has(sid), 'deadline cleared after firing');
  } finally {
    if (prevTranscript === undefined) delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    else process.env.FAKE_CLAUDE_TRANSCRIPT = prevTranscript;
    if (prevSweep === undefined) delete process.env.ORCH_OVERAGE_RESUME_SWEEP_MS;
    else process.env.ORCH_OVERAGE_RESUME_SWEEP_MS = prevSweep;
    await fs.rm(transcript, { force: true });
  }
});

// --- 15. FUTURE deadline re-arms but does NOT fire; non-overage unaffected ---
// One restore with two entries: (a) overage-stopped with a far-future deadline
// → timer armed + badge set, AUTO_RESUME_TEXT NOT sent and no RESUME_TEXT;
// (b) plain wasBusy session → unchanged RESUME_TEXT, no overage timer.

test('restoreFromResumeManifest arms a FUTURE overage deadline without firing; leaves non-overage sessions unchanged', async () => {
  const transcript = path.join(os.tmpdir(), `cc-ovg-future-${randomUUID()}.log`);
  const prevTranscript = process.env.FAKE_CLAUDE_TRANSCRIPT;
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcript;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'ovg-fut' });
    const ovgSid = randomUUID();
    const plainSid = randomUUID();
    const cwd = path.join(projectsRoot, 'ovg-fut');
    const dir = path.join(claudeProjectsRoot, encodeCwd(cwd));
    await fs.mkdir(dir, { recursive: true });
    for (const sid of [ovgSid, plainSid]) {
      await fs.writeFile(path.join(dir, `${sid}.jsonl`), '{"type":"user","uuid":"u1"}\n');
    }

    const futureAt = nowSec() + 3600; // 1h out — never fires within the test
    const base = { project: 'ovg-fut', cwd, mode: 'plan', effort: 'high', thinking: 'adaptive', model: null, worktreeName: null, temp: false, conducted: false, debug: false, title: null, autoApprovePlan: false, group: 'other' };
    await fs.mkdir(orchStoreRoot(), { recursive: true });
    writeResumeManifest([
      { ...base, sessionId: ovgSid, wasBusy: false, overageStopped: true, overageResumeAt: futureAt, overageResetsAt: futureAt - 5,
        overageQueue: [{ text: 'queued while paused', attachments: [], ts: Date.now() }] },
      { ...base, sessionId: plainSid, wasBusy: true }, // no overage fields
    ]);

    const { restored } = await restoreFromResumeManifest({ instances, log: { log() {}, warn() {} }, staggerMs: 0 });
    assert.equal(restored, 2, 'both restored');

    // (a) Overage session: deadline armed + badge set, but not fired.
    assert.ok(instances._autoResumeTimers.has(ovgSid), 'future overage deadline armed');
    const ovgInst = [...instances.byId.values()].find(i => i.sessionId === ovgSid);
    assert.equal(ovgInst.autoResumeAt, futureAt, 'badge deadline set to persisted value');
    assert.equal(ovgInst._overageQueue.length, 1, 'queued messages restored');
    assert.equal(ovgInst.summary().queuedCount, 1, 'restored queuedCount surfaced on summary');

    // (b) Plain session: gets RESUME_TEXT, no overage timer.
    await waitFor(async () => {
      try { return (await fs.readFile(transcript, 'utf8')).includes(RESUME_TEXT); }
      catch { return false; }
    });
    await new Promise(r => setTimeout(r, 300)); // let any stray prompt surface
    const dump = await fs.readFile(transcript, 'utf8');
    assert.ok(dump.includes(RESUME_TEXT), 'plain session re-prompted with RESUME_TEXT');
    assert.ok(!dump.includes(AUTO_RESUME_TEXT), 'future overage deadline did NOT fire');
    assert.ok(!instances._autoResumeTimers.has(plainSid), 'non-overage session has no resume timer');
  } finally {
    if (prevTranscript === undefined) delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    else process.env.FAKE_CLAUDE_TRANSCRIPT = prevTranscript;
    await fs.rm(transcript, { force: true });
  }
});
