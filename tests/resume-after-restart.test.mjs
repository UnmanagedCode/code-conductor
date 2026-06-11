import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';
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
  RESUME_TEXT,
} from '../src/resumeRestart.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASIC = path.join(__dirname, 'fixtures', 'scenario-basic.json');
const NO_TURN = path.join(__dirname, 'fixtures', 'scenario-no-turn.json');

// --- 1. manifest round-trip ------------------------------------------------

test('resume manifest write/read/clear round-trip + corrupt handling', async () => {
  const { close } = await bootServer({ scenarioPath: BASIC });
  try {
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
  } finally { await close(); }
});

// --- 2. shutdownForResumeSync preserves temp jsonl -------------------------

test('shutdownForResumeSync SIGKILLs subprocesses but preserves temp + normal jsonl', async () => {
  const { baseUrl, instances, claudeProjectsRoot, close } = await bootServer({ scenarioPath: BASIC });
  try {
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
    // Let any async _handleExit fire — the guard must keep it from deleting.
    await new Promise(r => setTimeout(r, 100));

    await fs.access(tempJsonl);   // temp jsonl PRESERVED (contrast shutdownTempSync)
    await fs.access(normalJsonl);
    assert.equal(tempInst.proc, null, 'temp subprocess killed');
    assert.equal(normalInst.proc, null, 'normal subprocess killed');
  } finally { await close(); }
});

// --- 3. windDown semantics -------------------------------------------------

test('windDown is a no-op when idle and injects the hidden marker mid-turn', async () => {
  const transcript = path.join(os.tmpdir(), `cc-winddown-${randomUUID()}.log`);
  const prev = process.env.FAKE_CLAUDE_TRANSCRIPT;
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcript;
  const { baseUrl, instances, close } = await bootServer({ scenarioPath: NO_TURN });
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
    await close();
    if (prev === undefined) delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    else process.env.FAKE_CLAUDE_TRANSCRIPT = prev;
    await fs.rm(transcript, { force: true });
  }
});

// --- 4. conductedWorkersOf -------------------------------------------------

test('conductedWorkersOf enumerates a conductor\'s live workers', async () => {
  const { baseUrl, instances, close } = await bootServer({ scenarioPath: BASIC });
  try {
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
    assert.equal(instances.conductedWorkersOf('nobody').length, 0);
  } finally { await close(); }
});

// --- 5+6. boot restore: three-group split + conductor worker injection -----

test('restoreFromResumeManifest resumes conductors + others, skips workers, injects worker list', async () => {
  const transcript = path.join(os.tmpdir(), `cc-restore-${randomUUID()}.log`);
  const prev = process.env.FAKE_CLAUDE_TRANSCRIPT;
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcript;
  const { baseUrl, instances, projectsRoot, claudeProjectsRoot, close } = await bootServer({ scenarioPath: BASIC });
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
        workers: [{ sessionId: workerSid, worktreeName: 'realproj_worktree_zz' }],
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
    assert.ok(dump.includes('resume conducting your workers'), 'conductor resume text injected');
  } finally {
    await close();
    if (prev === undefined) delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    else process.env.FAKE_CLAUDE_TRANSCRIPT = prev;
    await fs.rm(transcript, { force: true });
  }
});

test('buildConductorResumeText lists each worker sessionId + worktree', () => {
  const txt = buildConductorResumeText([
    { sessionId: 'aaa', worktreeName: 'wt-1' },
    { sessionId: 'bbb', worktreeName: null },
  ]);
  assert.ok(txt.includes('sessionId `aaa`, worktree `wt-1`'));
  assert.ok(txt.includes('sessionId `bbb`, (no worktree)'));
  assert.ok(buildConductorResumeText([]).includes('(none recorded)'));
});

// --- 7. drain force-timeout ------------------------------------------------

test('drainToManifest force-interrupts stragglers past the grace and still writes the manifest', async () => {
  const { baseUrl, instances, close } = await bootServer({ scenarioPath: NO_TURN });
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
    assert.equal(inst.proc, null, 'straggler subprocess killed after force + shutdownForResumeSync');
    clearResumeManifest();
  } finally { await close(); }
});
