import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { encodeCwd, orchStoreRoot } from '../src/projects.ts';
import { SOFT_INTERRUPT_MARKER } from '../src/parser.ts';
import {
  resumeManifestPath,
  writeResumeManifest,
  readResumeManifest,
  clearResumeManifest,
} from '../src/resumeManifest.ts';
import {
  drainToManifest,
  restoreFromResumeManifest,
  buildConductorResumeText,
  RESUME_TEXT,
} from '../src/resumeRestart.ts';
import { ensureConductProject, CONDUCT_PROJECT_NAME } from '../src/conduct.ts';
import { AUTO_RESUME_TEXT } from '../src/instances.ts';
import { addBackend, addCustomModel } from '../src/appSettings.ts';
import { getDefaultPlaybookEnforcement, setDefaultPlaybookEnforcement } from '../src/conductorConventions.ts';

const nowSec = () => Math.floor(Date.now() / 1000);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASIC = path.join(__dirname, 'fixtures', 'scenario-basic.json');
const NO_TURN = path.join(__dirname, 'fixtures', 'scenario-no-turn.json');
// Drain scenario: the first prompt keeps the instance in 'turn' (empty emit), and
// its control:interrupt turn answers the drain's soft interrupt with a result so
// drainToManifest's wait-without-forcing loop can converge.
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
  const tempJsonl = path.join(dir, `${tempInst.backingSessionId}.jsonl`);
  const normalJsonl = path.join(dir, `${normalInst.backingSessionId}.jsonl`);
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

// --- 3. drain stop semantics ----------------------------------------------

// REGRESSION (card 2026-0183 Part B). Invariant, run for BOTH model
// configurations: drainToManifest stops a mid-turn session with EXACTLY ONE
// `control_request subtype:interrupt` and writes NOTHING to its stdin — zero lines
// carrying SOFT_INTERRUPT_MARKER, zero user lines beyond the prompt that opened
// the turn — and the drain returns.
//
// The blanket change matters most for a flagged model: the wind-down steer was
// silently swallowed there, and step 3 waits forever without forcing, so the
// orchestrator restart hung indefinitely. Asserting the two configurations agree is
// what keeps the fix uniform. Note the OUTCOME (the drain returns) is vacuous on
// main for the unflagged half — the fake answered the wind-down message, so the
// drain converged either way. The mechanism is what fails there.
for (const flagged of [false, true]) {
  test(`drainToManifest soft-interrupts a mid-turn session and writes no steer (flagged: ${flagged})`, async () => {
    const transcript = path.join(os.tmpdir(), `cc-drainstop-${randomUUID()}.log`);
    const prevTranscript = process.env.FAKE_CLAUDE_TRANSCRIPT;
    const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
    process.env.FAKE_CLAUDE_TRANSCRIPT = transcript;
    process.env.FAKE_CLAUDE_SCENARIO = DRAIN;
    try {
      await api(baseUrl, 'POST', '/api/projects', { name: 'drainstop' });
      const res = await api(baseUrl, 'POST', '/api/instances', { project: 'drainstop' });
      const inst = instances.get(res.body.id);
      await waitFor(() => inst.status === 'idle' && inst.sessionId);
      if (flagged) {
        inst.backend = 'ollama';
        inst.model = 'deepseek-v4-flash:0731-cloud';
        inst._refreshModelCapabilities();
        assert.equal(inst.acceptsMidTurnSteering, false, 'the flagged preset resolved');
      }

      await inst.prompt('go');
      await waitFor(() => inst.status === 'turn');
      // The fake emits its startup `system/init` lazily, on its first stdin line —
      // so it can still be in flight here. Draining before it lands would have the
      // post-abort drain window mistake it for a spurious new turn and fire a
      // SECOND interrupt, which is a harness artifact, not the drain's behaviour.
      await waitFor(() => inst.ring.toArray().some(ev => ev.kind === 'system' && ev.subtype === 'init'));

      // PIN (owner-requested, mirroring the overage stop's soft-tier pin): the
      // drain's stop is the SOFT tier. `interrupt({force:true})` returns before
      // ever setting `interrupting`, so latching that flag off the status stream is
      // the only thing standing between a future force:true "optimisation" and a
      // restart that starts discarding partial work.
      let armedSoft = false;
      const latch = (sm) => { if (sm.interrupting) armedSoft = true; };
      inst.on('status', latch);

      await drainToManifest({ server: null, wss: null, instances,
        log: { warn() {}, log() {}, error() {} }, graceMs: 200 });
      inst.off('status', latch);
      assert.equal(armedSoft, true, 'the drain armed a SOFT interrupt, never a forced abort');

      const lines = (await fs.readFile(transcript, 'utf8'))
        .split('\n').filter(Boolean).map(l => JSON.parse(l));
      const interrupts = lines.filter(
        l => l.type === 'control_request' && l.request?.subtype === 'interrupt');
      const users = lines.filter(l => l.type === 'user' && l.message?.role === 'user');
      assert.equal(interrupts.length, 1, 'exactly one interrupt control_request');
      assert.equal(users.length, 1, 'only the prompt that opened the turn — no wind-down text');
      assert.ok(!JSON.stringify(lines).includes(SOFT_INTERRUPT_MARKER),
        'no marked steer was written to the CLI');
      clearResumeManifest();
    } finally {
      if (prevTranscript === undefined) delete process.env.FAKE_CLAUDE_TRANSCRIPT;
      else process.env.FAKE_CLAUDE_TRANSCRIPT = prevTranscript;
      if (prevScenario === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
      else process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
      await fs.rm(transcript, { force: true });
    }
  });
}

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

test('a manifest carrying the retired playbookEnforcement `off` resurrects at warn', async () => {
  // The migrate-on-read path, end to end. A pending-resume.json written by the
  // build that still had three levels is the ONLY way 'off' can reach this
  // process, and it is consumed once at boot — so it is normalized here rather
  // than by a migration.
  //
  // It must land on `warn`: that session was deliberately running unenforced,
  // and bringing it back enforced would start refusing calls that used to be
  // allowed with nothing announcing it. This is independent of whichever level
  // is currently the shipped default — "a restarted conductor keeps its OWN
  // level, not a default that changed under it" below covers that invariant
  // separately, by making the two values differ on purpose. What this test
  // pins is the migrate-on-read path itself: `off` must not reach an instance
  // field.
  const conductorSid = randomUUID();
  const conductCwd = path.join(projectsRoot, '.conduct');
  const dir = path.join(claudeProjectsRoot, encodeCwd(conductCwd));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${conductorSid}.jsonl`), '{"type":"user","uuid":"u1"}\n');

  await fs.mkdir(orchStoreRoot(), { recursive: true });
  writeResumeManifest([{
    project: '.conduct', sessionId: conductorSid, cwd: conductCwd,
    mode: 'bypassPermissions', effort: 'high', thinking: 'adaptive', model: null,
    worktreeName: null, temp: true, conducted: false, debug: false, title: null,
    autoApprovePlan: false, playbookEnforcement: 'off', group: 'conductor',
  }]);

  await restoreFromResumeManifest({ instances, log: { log() {}, warn() {} }, staggerMs: 0 });
  const inst = [...instances.byId.values()].find(i => i.sessionId === conductorSid);
  assert.ok(inst, 'conductor resumed');
  assert.equal(inst.playbookEnforcement, 'warn',
    "the retired level must normalize to warn, never resurrect as enforced");
});

test('a restarted conductor keeps its OWN level, not a default that changed under it', async () => {
  // Invariant: an explicit create-time playbookEnforcement wins over the
  // persisted Settings default, which is what makes a restart faithful.
  //
  // The two are made to DIFFER by construction — session at `enforce`, persisted
  // default at `warn` — so the assertion discriminates whatever the shipped
  // constant happens to be. Dropping the field from the manifest entry (or
  // re-reading the default on restore) resurrects this conductor unenforced:
  // exactly the silent downgrade the carry exists to prevent, and invisible to
  // any test that lets the two values coincide.
  await ensureConductProject();
  const res = await api(baseUrl, 'POST', '/api/instances', {
    project: CONDUCT_PROJECT_NAME, mode: 'bypassPermissions', temp: true, playbookEnforcement: 'enforce',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const inst = instances.get(res.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  assert.equal(inst.playbookEnforcement, 'enforce');

  // The default moves AFTER the session was born, the way a user changing the
  // setting mid-life would move it.
  await setDefaultPlaybookEnforcement('warn');
  assert.notEqual(await getDefaultPlaybookEnforcement(), inst.playbookEnforcement,
    'the persisted default must differ from the session level, or this proves nothing');

  const dir = path.join(claudeProjectsRoot, encodeCwd(inst.cwd));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${inst.backingSessionId}.jsonl`), '{"type":"user","uuid":"u1"}\n');

  const entries = await drainToManifest({ server: null, wss: null, instances, log: { warn() {}, log() {}, error() {} }, graceMs: 100 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].playbookEnforcement, 'enforce', 'the recorded level rides the manifest');
  await waitFor(() => inst.proc === null, { timeout: 20000 });

  const { restored } = await restoreFromResumeManifest({ instances, log: { log() {}, warn() {} }, staggerMs: 0 });
  assert.equal(restored, 1);
  const newInst = [...instances.byId.values()].find(i => i.sessionId === inst.sessionId && i.id !== inst.id);
  assert.ok(newInst, 'conductor restored as a fresh instance');
  assert.equal(newInst.playbookEnforcement, 'enforce',
    'the restored session kept its own level; it did not inherit the changed default');
  clearResumeManifest();
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

// --- 11b. the manifest round trip across a ROTATION (card 2026-0126) ---------

test('the restart manifest carries the PUBLIC id, so a rotated session resumes its CURRENT segment', async () => {
  // drainToManifest writes `summary().sessionId` — the public id — and
  // restoreFromResumeManifest feeds it straight back into create({resume}). That
  // has no resolution of its own, so the whole round trip rests on _doCreate
  // resolving the public id to `current`. If it resolved to the FIRST segment
  // instead, every restart after a renewal or prune would silently resurrect the
  // pre-rotation transcript — so prove it rather than infer it.
  await api(baseUrl, 'POST', '/api/projects', { name: 'rot-restart' });
  const res = await api(baseUrl, 'POST', '/api/instances', { project: 'rot-restart', mode: 'bypassPermissions' });
  const inst = instances.get(res.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  const publicId = inst.sessionId;
  const firstBacking = inst.backingSessionId;

  // Rotate through the real store API, then move the in-memory field the way the
  // system/init handler does. (Driving a live `/clear` needs the renew fixture; the
  // round trip under test is indifferent to which mechanism rotated it.)
  const rotated = 'b0000000-0000-4000-8000-00000000beef';
  const { recordRotation, resolveBacking } = await import('../src/sessionLineage.ts');
  await recordRotation(publicId, rotated, 'renew');
  inst.backingSessionId = rotated;
  inst._segments.push(rotated);
  assert.equal(await resolveBacking(publicId), rotated);

  // BOTH transcripts exist, with distinguishable content: a resume onto the wrong
  // segment would find a perfectly valid file, which is the silent failure a
  // mere existence check would miss.
  const dir = path.join(claudeProjectsRoot, encodeCwd(inst.cwd));
  await fs.mkdir(dir, { recursive: true });
  const line = (uuid, text) => JSON.stringify({
    type: 'user', uuid, message: { role: 'user', content: text },
  }) + '\n';
  await fs.writeFile(path.join(dir, `${firstBacking}.jsonl`), line('old-1', 'PRE-ROTATION'));
  await fs.writeFile(path.join(dir, `${rotated}.jsonl`), line('new-1', 'POST-ROTATION'));

  const entries = await drainToManifest({ server: null, wss: null, instances, log: { warn() {}, log() {}, error() {} }, graceMs: 100 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sessionId, publicId, 'the manifest records the PUBLIC id, not the backing one');
  await waitFor(() => inst.proc === null, { timeout: 20000 });

  const { restored } = await restoreFromResumeManifest({ instances, log: { log() {}, warn() {} }, staggerMs: 0 });
  assert.equal(restored, 1, 'one session restored');
  const newInst = [...instances.byId.values()].find(i => i.sessionId === publicId && i.id !== inst.id);
  assert.ok(newInst, 'restored as a fresh instance under the same public id');
  await waitFor(() => newInst.status === 'idle');

  assert.equal(newInst.backingSessionId, rotated, 'resumed the CURRENT segment');
  // The WHOLE chain is rehydrated, not just `current`. _segments is never
  // persisted — the lineage store is the durable copy and _doCreateResolved's
  // segmentsFor() is the rehydration point — and it is the entire candidate
  // universe for resolveSessionRef (D4 keeps that synchronous by staying
  // in-memory). Without the rebuild a restored session answers to its public id
  // and its current backing id but to NO older segment, so a conductor, wiki page
  // or kanban card naming a pre-rotation id gets SESSION_NOT_LIVE instead of the
  // live worker, and segmentCount under-reports. Asserted on the RESTORED
  // instance: the `_segments.push` above is fixture setup on the pre-drain one,
  // and reading that back would prove nothing about the restore.
  assert.deepEqual(newInst._segments, [firstBacking, rotated],
    'the restored instance carries its full segment chain, oldest first');
  assert.deepEqual(instances.resolveSessionRef(firstBacking), { sessionId: publicId },
    'so the pre-rotation id still resolves to the live session after a restart');
  assert.equal(instances.liveForSession(firstBacking)?.id, newInst.id,
    'and reaches the restored instance, not SESSION_NOT_LIVE');
  assert.equal(newInst.summary().segmentCount, 2, 'and segmentCount reports the real chain length');
  const at = newInst._spawnArgv.indexOf('--resume');
  assert.ok(at > 0, `--resume must be in the argv: ${JSON.stringify(newInst._spawnArgv)}`);
  assert.equal(newInst._spawnArgv[at + 1], rotated, 'and the argv names it');
  const echoes = newInst.ringSnapshot().filter(ev => ev.kind === 'user_echo').map(ev => ev.text);
  assert.ok(echoes.some(t => t.includes('POST-ROTATION')), `replayed the post-rotation transcript: ${JSON.stringify(echoes)}`);
  assert.ok(!echoes.some(t => t.includes('PRE-ROTATION')), `must NOT replay the pre-rotation one: ${JSON.stringify(echoes)}`);
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
  await fs.writeFile(path.join(dir, `${inst.backingSessionId}.jsonl`), '{"type":"user","uuid":"u1"}\n');

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
// subscription stays wasBusy:false → resurrected silently. The shutdown stop stays
// mid-turn-only regardless.

test('drainToManifest: idle conductor parked on a subscription is wasBusy:true; idle-no-sub stays silent; the stop is mid-turn-only', async () => {
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
    // subscribeIdle takes sessionIds (MCP boundary); isIdleCaller is keyed by the
    // stable instanceId.
    instances.subscribeIdle(parked.sessionId, worker.sessionId);
    assert.equal(instances.isIdleCaller(parked.id), true, 'parked conductor is an idle caller');
    assert.equal(instances.isIdleCaller(idleNoSub.id), false, 'idle-no-sub conductor is not a caller');

    // Drive only `midTurn` into a turn (DRAIN scenario keeps it open until stopped).
    await midTurn.prompt('go');
    await waitFor(() => midTurn.status === 'turn');
    // Let the fake's lazily-emitted startup `system/init` land before draining, or
    // the post-abort drain window mistakes it for a spurious new turn and fires a
    // second interrupt (a harness artifact — see the drain-stop tests above).
    await waitFor(() => midTurn.ring.toArray().some(ev => ev.kind === 'system' && ev.subtype === 'init'));

    // Capture the stop via the status event: drainToManifest's step 2 calls
    // interrupt() which sets interrupting=true and emits 'status'. Step 3 then waits
    // for the instance to go idle (the DRAIN scenario's control:interrupt turn
    // answers with a result), which transitions status away from 'turn' and resets
    // interrupting=false via _setStatus(). We must capture the flag before that reset.
    let midTurnStopped = false;
    const captureStop = (s) => { if (s.interrupting) midTurnStopped = true; };
    midTurn.on('status', captureStop);

    const entries = await drainToManifest({ server: null, wss: null, instances, log: { warn() {}, log() {}, error() {} }, graceMs: 200 });
    midTurn.off('status', captureStop);
    const byId = Object.fromEntries(entries.map(e => [e.sessionId, e]));

    // wasBusy (the predicate Edit 1 widened): mid-turn OR parked ⇒ true.
    assert.equal(byId[midTurn.sessionId].wasBusy,   true,  'mid-turn conductor → wasBusy:true');
    assert.equal(byId[parked.sessionId].wasBusy,    true,  'idle conductor parked on a subscription → wasBusy:true');
    assert.equal(byId[idleNoSub.sessionId].wasBusy, false, 'idle conductor with no subscription → wasBusy:false (silent)');
    // Regression: a plain idle worker (no outgoing subscription) stays silent.
    assert.equal(byId[worker.sessionId].wasBusy,    false, 'idle worker with no outgoing subscription → wasBusy:false');

    // Shutdown side (Bug 1, unchanged): the stop fires ONLY for the mid-turn one.
    assert.equal(midTurnStopped,         true,  'mid-turn conductor stopped');
    assert.equal(parked.interrupting,    false, 'idle parked conductor NOT stopped');
    assert.equal(idleNoSub.interrupting, false, 'idle conductor NOT stopped');
    assert.equal(worker.interrupting,    false, 'idle worker NOT stopped');

    // …and exactly one abort reached a CLI (the mid-turn one). The four sessions
    // share this transcript, so a stop leaking to an idle session shows up here.
    const dump = (await fs.readFile(transcript, 'utf8'))
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(
      dump.filter(l => l.type === 'control_request' && l.request?.subtype === 'interrupt').length,
      1, 'one interrupt total — to the mid-turn conductor only');

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
  await fs.writeFile(path.join(dir, `${inst.backingSessionId}.jsonl`), '{"type":"user","uuid":"u1"}\n');

  // Arm a real overage resume: stamp the reset time + intent, then let the
  // controller compute the fire deadline (resetsAt + buffer) exactly as the
  // live idle-transition path does.
  inst.autoStoppedForOverage = true;
  inst._overageWasStopped = true;
  inst._overageStoppedWorkers = true;              // this stop also severed a callback
  inst._overageResetsAt = nowSec() + 100;          // 100s out, comfortably future
  inst._overageQueue = [{ text: 'hold this for me', attachments: [], ts: Date.now() }];
  instances._armAutoResume(inst);
  assert.ok(Number.isFinite(inst.autoResumeAt), 'resume deadline armed');
  assert.ok(instances._autoResumeTimers.has(inst.id), 'sweep deadline set');

  const entries = await drainToManifest({ server: null, wss: null, instances, log: { warn() {}, log() {}, error() {} }, graceMs: 100 });
  const e = entries.find(x => x.sessionId === inst.sessionId);
  assert.ok(e, 'session captured in manifest');
  assert.equal(e.overageStopped, true, 'stop-resume intent persisted');
  assert.equal(e.overageResumeAt, inst.autoResumeAt, 'fire deadline (epoch secs) persisted');
  assert.equal(e.overageResetsAt, inst._overageResetsAt, 'reset time persisted');
  assert.deepEqual(e.overageQueue, inst._overageQueue, 'queued messages persisted');
  // Both preamble selectors, for the same reason: losing either delivers the wrong
  // resume text after a restart. `overageStoppedWorkers` picks
  // AUTO_RESUME_TEXT_CONDUCTOR — without it a conductor whose callbacks were
  // severed and whose workers are un-armed gets the PLAIN text and waits forever
  // for a wake nothing will send.
  assert.equal(e.overageWasStopped, true, 'full-preamble selector persisted');
  assert.equal(e.overageStoppedWorkers, true, 'conductor-variant selector persisted');
  await waitFor(() => inst.proc === null, { timeout: 20000 });
  clearResumeManifest();
});

// REGRESSION — the RESTORE half of the same field. drainToManifest writing it is
// worthless if boot drops it, and the two live in different files.
test('restoreFromResumeManifest restores overageStoppedWorkers onto the revived session', async () => {
  const prevSweep = process.env.ORCH_OVERAGE_RESUME_SWEEP_MS;
  process.env.ORCH_OVERAGE_RESUME_SWEEP_MS = '40';
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'ovg-swk' });
    const sid = randomUUID();
    const cwd = path.join(projectsRoot, 'ovg-swk');
    const dir = path.join(claudeProjectsRoot, encodeCwd(cwd));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${sid}.jsonl`), '{"type":"user","uuid":"u1"}\n');

    writeResumeManifest([{
      project: 'ovg-swk', sessionId: sid, cwd, mode: 'bypassPermissions',
      effort: null, thinking: null, model: null, contextWindowTokens: null,
      backend: 'claude', worktreeName: null, temp: false, conducted: false,
      debug: false, title: null, firstPrompt: null, autoApprovePlan: false,
      playbookEnforcement: getDefaultPlaybookEnforcement(), group: 'conductor',
      wasBusy: true,
      // Far-future deadline: this test is about the FLAG surviving the restore,
      // not about the resume firing (which test 14 covers).
      overageResumeAt: nowSec() + 3600,
      overageStopped: true,
      overageWasStopped: true,
      overageStoppedWorkers: true,
      overageResetsAt: nowSec() + 3600,
      overageQueue: [],
    }]);

    await restoreFromResumeManifest({ instances, log: { warn() {}, log() {}, error() {} } });
    const inst = await waitFor(() => [...instances.byId.values()].find(i => i.sessionId === sid));
    // The re-arm is fire-and-forget after live+idle, and it is what reads the
    // restored flags — so wait on the deadline, then read them.
    await waitFor(() => instances._autoResumeTimers.has(inst.id), { timeout: 20000 });
    assert.equal(inst._overageStoppedWorkers, true,
      'the conductor-variant selector survived the restart');
    assert.equal(inst._overageWasStopped, true, 'and so did the full-preamble selector');
    clearResumeManifest();
  } finally {
    if (prevSweep === undefined) delete process.env.ORCH_OVERAGE_RESUME_SWEEP_MS;
    else process.env.ORCH_OVERAGE_RESUME_SWEEP_MS = prevSweep;
  }
});

// --- 14. CRITICAL: a PAST-DUE overage resume fires on the first boot tick ----
// The whole point: a window that reset while the orchestrator was down must
// resume immediately after boot. armRestored re-inserts the (already-past)
// deadline as-is; the wall-clock sweep fires it on the first tick — now routed
// through the usage-verified fire, so we inject an under-threshold usage fetcher
// (the window HAS reset) and assert AUTO_RESUME_TEXT lands. We drive the sweep
// fast via ORCH_OVERAGE_RESUME_SWEEP_MS.

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

    // Fire-time verify sees the window clear (util 10 < 100) ⇒ the restored resume
    // actually fires rather than parking for a recheck.
    instances._overageResume.fetchUsage = async () => ({
      five_hour: { utilization: 10, resets_at: new Date((nowSec() + 3600) * 1000).toISOString() },
      seven_day: { utilization: 0, resets_at: new Date((nowSec() + 90000) * 1000).toISOString() },
      extra_usage: { is_enabled: false },
    });

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
    // The restored session got a fresh instanceId, so assert on the map emptying
    // (single session under test) rather than the manifest sessionId.
    await waitFor(() => instances._autoResumeTimers.size === 0);
    assert.equal(instances._autoResumeTimers.size, 0, 'deadline cleared after firing');
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

    // (a) Overage session: deadline armed + badge set, but not fired. The
    // restored session has a fresh instanceId, so probe the timer by that id.
    const ovgInst = [...instances.byId.values()].find(i => i.sessionId === ovgSid);
    assert.ok(instances._autoResumeTimers.has(ovgInst.id), 'future overage deadline armed');
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
    const plainInst = [...instances.byId.values()].find(i => i.sessionId === plainSid);
    assert.ok(!instances._autoResumeTimers.has(plainInst.id), 'non-overage session has no resume timer');
  } finally {
    if (prevTranscript === undefined) delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    else process.env.FAKE_CLAUDE_TRANSCRIPT = prevTranscript;
    await fs.rm(transcript, { force: true });
  }
});


// ── graceful restart carries {backend, model, contextWindowTokens} ────────
// The manifest is the ONLY carrier across a graceful restart, and a
// substitution session's model id is an opaque registry key. Losing the tag or
// the backend here re-spawns the session against the real `claude` backend, or
// silently drops its context env vars.
test('a drained substitution session restores with its exact model, backend and capacity', async () => {
  const ctx = await bootServer({ scenarioPath: BASIC });
  try {
    await addBackend({
      id: 'codex', label: 'Codex',
      template: 'codexctl run claude --model {model} --', env: [],
    });
    await addCustomModel({ label: 'Sol', model: 'gpt-5.6-sol[1m]', backend: 'codex', contextWindow: 1_000_000 });
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'restartsub' });

    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'restartsub', mode: 'bypassPermissions',
      backend: 'codex', model: 'gpt-5.6-sol[1m]',
    });
    assert.equal(r.status, 201);
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    const sessionId = ctx.instances.get(id).sessionId;

    await drainToManifest({ instances: ctx.instances, log: { log() {}, warn() {} } });

    const entry = readResumeManifest().instances.find(e => e.sessionId === sessionId);
    assert.ok(entry, 'the live session must be in the manifest');
    assert.equal(entry.backend, 'codex');
    assert.equal(entry.model, 'gpt-5.6-sol[1m]', 'the registry key rides the manifest byte-exact');
    assert.equal(entry.contextWindowTokens, 1_000_000);
    assert.ok(!('sonnetWindow' in entry), 'the retired field must not be written');
  } finally { await ctx.close(); }
});

test('a restored session whose custom-model row was DELETED keeps its last known capacity', async () => {
  // The one path where two sources of the same number can disagree: live
  // registry resolution returns null, so the carried value is the only thing
  // standing between the user and a ctx bar that reads `—` for the rest of the
  // session. The live registry still WINS whenever it can resolve.
  const ctx = await bootServer({ scenarioPath: BASIC });
  try {
    await addBackend({
      id: 'codex', label: 'Codex',
      template: 'codexctl run claude --model {model} --', env: [],
    });
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'restartgone' });
    const cwd = path.join(ctx.projectsRoot, 'restartgone');
    const sid = randomUUID();
    const dir = path.join(ctx.claudeProjectsRoot, encodeCwd(cwd));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${sid}.jsonl`), '{"type":"user","uuid":"u1"}\n');

    await fs.mkdir(orchStoreRoot(), { recursive: true });
    writeResumeManifest([{
      project: 'restartgone', sessionId: sid, cwd,
      mode: 'bypassPermissions', effort: 'high', thinking: 'adaptive',
      // The model is NOT in customModels — the row was deleted before restart.
      backend: 'codex', model: 'gpt-5.6-sol[1m]', contextWindowTokens: 1_000_000,
      worktreeName: null, temp: false, conducted: false, debug: false, title: null,
      autoApprovePlan: false, group: 'other',
    }]);

    await restoreFromResumeManifest({ instances: ctx.instances, log: { log() {}, warn() {} }, staggerMs: 0 });
    const inst = ctx.instances.liveForSession(sid);
    assert.ok(inst, 'the session must be restored');
    assert.equal(inst.backend, 'codex');
    assert.equal(inst.model, 'gpt-5.6-sol[1m]');
    assert.equal(inst.contextWindowTokens, 1_000_000,
      'the carried capacity is the fallback when the registry can no longer resolve one');
  } finally { await ctx.close(); }
});
