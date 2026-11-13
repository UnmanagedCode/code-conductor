// The resume banner's server half: a gated restore respawns the same sessions
// an automatic one does but holds each busy session's continue notice in
// pending-continue.json; Continue sends them exactly once, Dismiss sends none,
// a session's own turn drops its notice, and a notice outlives further
// restarts and crashes. An unclean stop (a running record with no manifest)
// restores the same way with unclean notices; a manifest always wins over a
// record; and self-update's autoContinue restart still prompts at once.
//
// A "second boot" here is shutdownForResumeSync (CLIs gone, jsonl kept, the
// record left as a crash leaves it) followed by a fresh startResumeLifecycle on
// the same server with a fresh recorder and pending store.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf, seedSessionJsonl } from './helpers.mjs';
import { orchStoreRoot, localPlace } from '../src/projects.ts';
import { ensureConductProject, CONDUCT_PROJECT_NAME } from '../src/conduct.ts';
import {
  writeResumeManifest, readResumeManifest, resumeManifestPath, runningRecordPath, readRunningRecord,
  writeRunningRecord, takeRestoreSource,
} from '../src/resumeManifest.ts';
import {
  RESUME_TEXT, UNCLEAN_RESUME_TEXT, buildWorkersResumeText, buildWorkersUncleanResumeText, backgroundWorkLostNote, drainToManifest,
} from '../src/resumeRestart.ts';
import { RESTART_NOTICE_TRUNK, UNCLEAN_STOP_NOTICE_TRUNK } from '../shared/injectedTurns.ts';
import { createRunningRecorder } from '../src/runningRecord.ts';
import { hostPlatform } from '../src/platform/index.ts';
import { createPendingContinue, pendingContinuePath } from '../src/pendingContinue.ts';
import { startResumeLifecycle } from '../src/resumeBoot.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASIC = path.join(__dirname, 'fixtures', 'scenario-basic.json');
// The first prompt leaves the session in 'turn'; the drain's interrupt ends it.
const DRAIN = path.join(__dirname, 'fixtures', 'scenario-drain.json');
const QUIET = { log() {}, warn() {}, error() {} };

let ctx, baseUrl, instances, home, projectsRoot;
let lifecycles = [];
before(async () => { ctx = await bootServer({ scenarioPath: BASIC }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot } = await freshProjectsRoot()); });
afterEach(async () => {
  for (const l of lifecycles) l.dispose();
  lifecycles = [];
  await instances.shutdown();
  instances._idleSubscribers?.clear();
  instances._idleHub?._owners.clear();
  if (instances._idleHub) instances._idleHub._suspended = false;
  await rmrf(home);
});

// One boot's lifecycle with a fresh recorder and pending store.
function boot({ pending = createPendingContinue({ log: QUIET }), wait } = {}) {
  const recorder = createRunningRecorder({ instances, platform: hostPlatform, log: QUIET, debounceMs: 20 });
  const l = startResumeLifecycle({ instances, recorder, pending, log: QUIET, staggerMs: 0, wait });
  lifecycles.push(l);
  return { ...l, pending };
}

// A manifest/record entry for a session with a seeded transcript.
async function entry(project, sessionId, extra = {}) {
  const cwd = path.join(projectsRoot, project);
  await seedSessionJsonl(localPlace(cwd), sessionId);
  return {
    project, sessionId, cwd, mode: 'plan', effort: 'high', thinking: 'adaptive', model: null,
    worktreeName: null, persistent: true, conducted: false, debug: false, title: null,
    autoApprovePlan: false, group: 'other', wasBusy: true, ...extra,
  };
}
const sid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const liveSids = () => [...instances.byId.values()].filter((i) => i.proc).map((i) => i.sessionId);
// Every user turn a session received whose text is one of the notices.
const noticeEchoes = (s) => (instances.liveForSession(s)?.ring.toArray() ?? [])
  .filter((e) => e.kind === 'user_echo').map((e) => String(e.text ?? ''))
  .filter((t) => t.startsWith(RESTART_NOTICE_TRUNK) || t.startsWith(UNCLEAN_STOP_NOTICE_TRUNK));
const allNoticeEchoes = () => liveSids().flatMap(noticeEchoes);

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

// A WS client that counts resume_notices hints.
async function hintCounter(t) {
  const ws = new WebSocket(ctx.wsUrl);
  const hints = [];
  ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.t === 'resume_notices') hints.push(m); });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  t.after(() => ws.close());
  return hints;
}

// Invariant: a gated restore respawns exactly the manifest's top-level sessions
// (workers are not spawned), prompts none of them, and stores one notice per
// busy session whose text is the restart notice an automatic restore would have
// sent; GET lists them with each live session's project.
test('a gated restore respawns the same sessions, sends no notice, and stores each busy one\'s notice', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'gate' });
  const [cond, worker, plain, idle] = [sid(1), sid(2), sid(3), sid(4)];
  const workers = [{ project: 'gate', sessionId: worker, worktreeName: null, parentSessionId: cond }];
  writeResumeManifest([
    await entry('gate', cond, { workers }),
    await entry('gate', worker, { group: 'worker', conducted: true }),
    await entry('gate', plain, { backgroundWorkLost: [plain] }),
    await entry('gate', idle, { wasBusy: false }),
  ], { deliver: 'gated' });

  const { restored, pending } = boot();
  assert.deepEqual(await restored, { restored: 3 });
  assert.deepEqual(liveSids().sort(), [cond, plain, idle].sort(), 'the top-level sessions, not the worker');
  assert.deepEqual(allNoticeEchoes(), [], 'no notice is sent at boot');
  const byId = Object.fromEntries(pending.list().map((n) => [n.sessionId, n]));
  assert.deepEqual(Object.keys(byId).sort(), [cond, plain].sort());
  assert.equal(byId[cond].text, buildWorkersResumeText(cond, workers));
  assert.deepEqual(byId[cond].workers, [worker]);
  assert.equal(byId[plain].text, `${RESUME_TEXT}\n\n${backgroundWorkLostNote(plain, [plain])}`);
  assert.ok(pending.list().every((n) => n.kind === 'restart'));
  const listed = (await api(baseUrl, 'GET', '/api/resume-notices')).body.notices;
  assert.deepEqual(listed.map((n) => [n.sessionId, n.kind, n.project]).sort(), [[cond, 'restart', 'gate'], [plain, 'restart', 'gate']].sort());
});

// Invariant: a restore where nothing was busy stores nothing, and the banner's
// list is empty.
test('all idle: no notices, and GET lists none', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'calm' });
  writeResumeManifest([await entry('calm', sid(11), { wasBusy: false })], { deliver: 'gated' });
  const { restored, pending } = boot();
  assert.deepEqual(await restored, { restored: 1 });
  assert.deepEqual(pending.list(), []);
  assert.deepEqual((await api(baseUrl, 'GET', '/api/resume-notices')).body, { notices: [] });
});

// Invariant: Continue sends each stored notice to its session exactly once,
// empties the store, hints every client, and a second Continue (another tab)
// sends nothing.
test('Continue delivers each notice exactly once across tabs', async (t) => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'go' });
  const [a, b] = [sid(21), sid(22)];
  writeResumeManifest([await entry('go', a), await entry('go', b)], { deliver: 'gated' });
  const { restored } = boot({ pending: ctx.pendingContinue });
  await restored;
  const hints = await hintCounter(t);
  const texts = Object.fromEntries(ctx.pendingContinue.list().map((n) => [n.sessionId, n.text]));
  const [first, second] = await Promise.all([
    api(baseUrl, 'POST', '/api/resume-notices/continue'),
    api(baseUrl, 'POST', '/api/resume-notices/continue'),
  ]);
  const sent = [...first.body.sent, ...second.body.sent].sort();
  assert.deepEqual(sent, [a, b].sort(), 'each session is sent to by exactly one Continue');
  assert.deepEqual([...first.body.dropped, ...second.body.dropped, ...first.body.kept, ...second.body.kept], []);
  await waitFor(() => noticeEchoes(a).length === 1 && noticeEchoes(b).length === 1);
  assert.deepEqual(noticeEchoes(a), [texts[a]]);
  assert.deepEqual(noticeEchoes(b), [texts[b]]);
  assert.deepEqual(ctx.pendingContinue.list(), []);
  await waitFor(() => hints.length >= 1);
  assert.deepEqual((await api(baseUrl, 'POST', '/api/resume-notices/continue')).body, { sent: [], dropped: [], kept: [] });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(noticeEchoes(a).length + noticeEchoes(b).length, 2, 'nothing more was sent');
});

// Invariant: Continue drops the notice of a session no longer live.
test('Continue drops a notice whose session is not live', async () => {
  ctx.pendingContinue.add({ sessionId: sid(29), kind: 'restart', text: RESUME_TEXT, workers: [], at: '' });
  assert.deepEqual((await api(baseUrl, 'POST', '/api/resume-notices/continue')).body, { sent: [], dropped: [sid(29)], kept: [] });
  assert.deepEqual(ctx.pendingContinue.list(), []);
});

// Invariant: Dismiss sends nothing, empties the store and hints every client.
test('Dismiss sends nothing, empties the store and hints', async (t) => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'no' });
  const a = sid(31);
  writeResumeManifest([await entry('no', a)], { deliver: 'gated' });
  await boot({ pending: ctx.pendingContinue }).restored;
  const hints = await hintCounter(t);
  assert.equal(ctx.pendingContinue.list().length, 1, 'premise: one notice');
  assert.deepEqual((await api(baseUrl, 'POST', '/api/resume-notices/dismiss')).body, { dismissed: 1 });
  assert.deepEqual(ctx.pendingContinue.list(), []);
  await waitFor(() => hints.length === 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(noticeEchoes(a), []);
});

// Invariant: a session's own turn (here a hand prompt) drops its notice and only
// its notice, so a stale notice is never sent.
test('a hand prompt drops only that session\'s notice', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'hand' });
  const [a, b] = [sid(41), sid(42)];
  writeResumeManifest([await entry('hand', a), await entry('hand', b)], { deliver: 'gated' });
  const { restored, pending } = boot();
  await restored;
  assert.equal(pending.list().length, 2, 'premise: two notices');
  await instances.liveForSession(a).prompt('carry on with the other thing');
  await waitFor(() => pending.list().length === 1);
  assert.deepEqual(pending.list().map((n) => n.sessionId), [b]);
});

// Invariant: a stop with no drain is detected from the running record and
// restored like a clean one — the same top-level sessions, no prompt — with
// unclean notices; the conductor's lists its subtree.
test('an unclean stop restores the recorded sessions with unclean notices', async () => {
  await ensureConductProject();
  await api(baseUrl, 'POST', '/api/projects', { name: 'crash' });
  boot(); // nothing to restore; starts recording
  const cond = await createWithScenario(DRAIN, { project: CONDUCT_PROJECT_NAME });
  const worker = await createWithScenario(DRAIN, { project: 'crash', callerInstanceId: cond.id, conducted: true });
  const plain = await createWithScenario(DRAIN, { project: 'crash' });
  for (const i of [cond, worker, plain]) void i.prompt('work');
  await waitFor(() => [cond, worker, plain].every((i) => i.status === 'turn'));
  const recorded = () => readRunningRecord({ log: QUIET })?.instances ?? [];
  await waitFor(() => {
    const r = Object.fromEntries(recorded().map((e) => [e.sessionId, e]));
    return r[cond.sessionId]?.wasBusy && r[plain.sessionId]?.wasBusy && r[cond.sessionId].workers?.length === 1;
  });
  const workers = recorded().find((e) => e.sessionId === cond.sessionId).workers;
  const [condSid, workerSid, plainSid] = [cond.sessionId, worker.sessionId, plain.sessionId];

  // The crash: the recorder never hears of it, the CLIs are gone, nothing drained.
  lifecycles.pop().dispose();
  instances.shutdownForResumeSync();
  await waitFor(() => [cond, worker, plain].every((i) => i.proc === null), { timeout: 20000 });
  await seedSessionJsonl(cond.transcriptPlace, cond.backingSessionId);
  await seedSessionJsonl(plain.transcriptPlace, plain.backingSessionId);
  assert.equal(fs.existsSync(resumeManifestPath()), false, 'premise: no manifest');

  const { restored, pending } = boot();
  assert.deepEqual(await restored, { restored: 2 });
  assert.deepEqual(liveSids().sort(), [condSid, plainSid].sort(), 'the conductor and the hand-spawned session, not the worker');
  assert.ok(!liveSids().includes(workerSid));
  assert.deepEqual(allNoticeEchoes(), []);
  const byId = Object.fromEntries(pending.list().map((n) => [n.sessionId, n]));
  assert.deepEqual(Object.keys(byId).sort(), [condSid, plainSid].sort());
  assert.ok(pending.list().every((n) => n.kind === 'unclean'));
  assert.equal(byId[condSid].text, buildWorkersUncleanResumeText(condSid, workers));
  assert.ok(byId[condSid].text.includes(`sessionId \`${workerSid}\``));
  assert.equal(byId[plainSid].text, UNCLEAN_RESUME_TEXT);
  assert.deepEqual((await api(baseUrl, 'GET', '/api/resume-notices')).body.notices.map((n) => n.kind), ['unclean', 'unclean']);
});

// Invariant: a clean exit never reads as unclean — with both files present (a
// crash between finishDrain's two writes) the manifest wins, the record's
// sessions are not restored, and the restore source consumes both files.
test('manifest and record both present: kind restart, and both files are consumed', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'both' });
  const [m, r] = [sid(51), sid(52)];
  writeResumeManifest([await entry('both', m)], { deliver: 'gated' });
  writeRunningRecord({ instances: [await entry('both', r)], clis: [] });
  const src = takeRestoreSource({ log: QUIET });
  assert.equal(src.kind, 'restart');
  assert.deepEqual(src.entries.map((e) => e.sessionId), [m]);
  assert.equal(fs.existsSync(resumeManifestPath()), false);
  assert.equal(fs.existsSync(runningRecordPath()), false);

  writeResumeManifest([await entry('both', m)], { deliver: 'gated' });
  writeRunningRecord({ instances: [await entry('both', r)], clis: [] });
  const { restored, pending } = boot();
  assert.deepEqual(await restored, { restored: 1 });
  assert.deepEqual(liveSids(), [m]);
  assert.deepEqual(pending.list().map((n) => [n.sessionId, n.kind]), [[m, 'restart']]);
});

// Invariant: a manifest written without `deliver` auto-continues: its busy
// session is prompted at once and nothing is stored.
test('a manifest with no deliver field auto-continues', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'legacy' });
  const a = sid(61);
  fs.mkdirSync(orchStoreRoot(), { recursive: true });
  fs.writeFileSync(resumeManifestPath(), JSON.stringify({ writtenAt: 'x', instances: [await entry('legacy', a)] }));
  const { restored, pending } = boot();
  await restored;
  await waitFor(() => noticeEchoes(a).length === 1);
  assert.deepEqual(noticeEchoes(a), [RESUME_TEXT]);
  assert.deepEqual(pending.list(), []);
});

// Invariant (mid-restore Continue): a Continue that arrives while the boot
// restore is still bringing a session up never drops that session's notice — it
// is kept (the banner stays), and once the restore has settled a Continue
// delivers it, exactly once. A session the restore has already brought up leaves
// `restoring` at once, so its notice is sent by that same mid-restore Continue,
// not kept. A notice whose session the restore never had is dropped at once.
test('Continue before the restore has reached a session keeps its notice, sends an already-restored one, and delivers the kept one once the restore settles', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'early' });
  const [b, a, gone] = [sid(91), sid(92), sid(93)];
  writeResumeManifest([await entry('early', b, { wasBusy: false }), await entry('early', a, { wasBusy: false })], { deliver: 'gated' });
  const notice = { sessionId: a, kind: 'restart', text: RESUME_TEXT, workers: [], at: 'earlier' };
  const upNotice = { ...notice, sessionId: b, text: `${RESUME_TEXT} (b)` };
  ctx.pendingContinue.add(notice);
  ctx.pendingContinue.add(upNotice);
  ctx.pendingContinue.add({ ...notice, sessionId: gone });
  // Hold the restore in its stagger, after the first session and before the second.
  let release;
  let held;
  const holding = new Promise((r) => { held = r; });
  const wait = () => { held(); return new Promise((r) => { release = r; }); };
  const l = boot({ pending: ctx.pendingContinue, wait });
  await holding;
  assert.ok(instances.liveForSession(b), 'premise: the first session is up');
  assert.equal(instances.liveForSession(a), null, 'premise: the restore has not reached the second');

  assert.deepEqual((await api(baseUrl, 'POST', '/api/resume-notices/continue')).body, { sent: [b], dropped: [gone], kept: [a] });
  assert.deepEqual(ctx.pendingContinue.list(), [notice], 'the notice is kept, so the banner stays');
  await waitFor(() => noticeEchoes(b).length === 1);
  assert.deepEqual(noticeEchoes(b), [upNotice.text], 'the session already up got its notice');
  assert.deepEqual((await api(baseUrl, 'GET', '/api/resume-notices')).body.notices.map((n) => n.sessionId), [a]);

  release();
  assert.deepEqual(await l.restored, { restored: 2 });
  assert.deepEqual(noticeEchoes(a), [], 'the restore itself sends nothing');
  assert.deepEqual((await api(baseUrl, 'POST', '/api/resume-notices/continue')).body, { sent: [a], dropped: [], kept: [] });
  await waitFor(() => noticeEchoes(a).length === 1);
  assert.deepEqual(noticeEchoes(a), [RESUME_TEXT]);
});

// Invariant (settled failure): a session the restore failed to bring up is no
// longer restoring, so Continue then drops its notice rather than keeping it
// forever.
test('once the restore has settled, a notice whose session did not come up is dropped', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'nocome' });
  const a = sid(95);
  // No transcript: the resume pre-flight refuses it, so the restore settles without it.
  writeResumeManifest([{ ...(await entry('nocome', sid(96))), sessionId: a, wasBusy: false }], { deliver: 'gated' });
  ctx.pendingContinue.add({ sessionId: a, kind: 'restart', text: RESUME_TEXT, workers: [], at: '' });
  const l = boot({ pending: ctx.pendingContinue });
  assert.deepEqual(await l.restored, { restored: 0 });
  assert.deepEqual((await api(baseUrl, 'POST', '/api/resume-notices/continue')).body, { sent: [], dropped: [a], kept: [] });
});

// Invariant: a notice outlives further stops until it is clicked — a second
// gated restart and then a crash each respawn the session silently with the
// notice intact, and Continue then delivers it.
test('a notice survives a second restart and a crash, then Continue delivers it', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'keep' });
  const a = sid(71);
  writeResumeManifest([await entry('keep', a)], { deliver: 'gated' });
  let l = boot();
  await l.restored;
  const [notice] = l.pending.list();
  assert.equal(notice.sessionId, a, 'premise: the notice is stored');

  // A second gated restart: the session is idle now, so the manifest says so.
  l.dispose();
  const drained = await drainToManifest({ instances, log: QUIET, deliver: 'gated' });
  assert.deepEqual(drained.map((e) => [e.sessionId, e.wasBusy]), [[a, false]]);
  await waitFor(() => !instances.liveForSession(a));
  l = boot();
  assert.deepEqual(await l.restored, { restored: 1 });
  assert.ok(instances.liveForSession(a), 'respawned');
  assert.deepEqual(l.pending.list(), [notice], 'the notice is intact');
  assert.deepEqual(noticeEchoes(a), []);

  // A crash: the record lists the session (idle), nothing drains.
  await waitFor(() => (readRunningRecord({ log: QUIET })?.instances ?? []).some((e) => e.sessionId === a));
  l.dispose();
  instances.shutdownForResumeSync();
  await waitFor(() => !instances.liveForSession(a), { timeout: 20000 });
  l = boot({ pending: ctx.pendingContinue });
  assert.deepEqual(await l.restored, { restored: 1 });
  assert.deepEqual(ctx.pendingContinue.list(), [notice], 'the notice is intact');
  assert.deepEqual(noticeEchoes(a), []);

  assert.deepEqual((await api(baseUrl, 'POST', '/api/resume-notices/continue')).body, { sent: [a], dropped: [], kept: [] });
  await waitFor(() => noticeEchoes(a).length === 1);
  assert.deepEqual(noticeEchoes(a), [notice.text]);
});

// Invariant: self-update's restart (autoContinue:true) and a supervised relaunch
// still auto-continue and never misfire as unclean — the manifest says `auto`,
// the record is gone, and the next boot prompts the busy session at once while
// the pending store is left exactly as it was.
test('POST /api/admin/restart {autoContinue:true}: auto manifest, record removed, the next boot prompts at once', async (t) => {
  const spawned = [];
  const a = await bootServer({
    scenarioPath: DRAIN, keepHome: true,
    relaunch: { flags: { buildWeb: false, syncDeps: false }, supervised: true, spawnAndExit: () => { spawned.push('spawn'); } },
  });
  let b = null;
  let aClosed = false;
  t.after(async () => {
    if (!aClosed) await a.close({ keepHome: true });
    await b?.close();
    await rmrf(a.tmpHome);
  });
  await api(a.baseUrl, 'POST', '/api/projects', { name: 'upd' });
  const inst = await a.instances.create({ project: 'upd' });
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  void inst.prompt('busy');
  await waitFor(() => inst.status === 'turn');
  a.runningRecorder.start();
  const other = { sessionId: sid(81), kind: 'restart', text: RESUME_TEXT, workers: [], at: 'earlier' };
  a.pendingContinue.add(other);
  const res = await fetch(`${a.baseUrl}/api/admin/restart`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autoContinue: true }) });
  assert.deepEqual((await res.text()).trim().split('\n').map((l) => JSON.parse(l)).at(-1), { type: 'result', ok: true });
  assert.deepEqual(spawned, ['spawn']);
  assert.equal(readResumeManifest({ log: QUIET }).deliver, 'auto');
  assert.equal(fs.existsSync(runningRecordPath()), false);
  const pendingBefore = fs.readFileSync(pendingContinuePath(), 'utf8');
  await waitFor(() => inst.proc === null, { timeout: 20000 });
  await seedSessionJsonl(inst.transcriptPlace, inst.backingSessionId);
  const store = orchStoreRoot();
  await a.close({ keepHome: true });
  aClosed = true;

  b = await bootServer({ scenarioPath: BASIC, home: a.tmpHome, keepHome: true });
  assert.equal(orchStoreRoot(), store, 'premise: the same store');
  const l = startResumeLifecycle({ instances: b.instances, recorder: b.runningRecorder, pending: b.pendingContinue, log: QUIET, staggerMs: 0 });
  t.after(() => l.dispose());
  assert.deepEqual(await l.restored, { restored: 1 });
  const echoes = () => (b.instances.liveForSession(inst.sessionId)?.ring.toArray() ?? [])
    .filter((e) => e.kind === 'user_echo').map((e) => String(e.text ?? ''));
  await waitFor(() => echoes().includes(RESUME_TEXT));
  assert.deepEqual(echoes().filter((e) => e.startsWith(UNCLEAN_STOP_NOTICE_TRUNK)), [], 'nothing reads as unclean');
  assert.equal(fs.readFileSync(pendingContinuePath(), 'utf8'), pendingBefore, 'the pending store is untouched');
});
