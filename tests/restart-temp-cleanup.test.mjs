import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { encodeCwd, orchStoreRoot } from '../src/projects.js';
import { isTemp, markTemp, orphanedTempIdsSync } from '../src/tempSessions.js';
import { isArchived } from '../src/archivedSessions.js';
import {
  pendingTempCleanupPath,
  writePendingTempCleanup,
  sweepPendingTempCleanup,
} from '../src/tempCleanup.js';
import { runTempCleanup } from '../src/restart.js';
import { drainToManifest } from '../src/resumeRestart.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-basic.json');

// Bug repro: clicking "Restart server" used to leave temp-session jsonls on
// disk. The async `_handleExit` cleanup races process.exit(), so the temp
// jsonl + subagents dir survived the restart and reappeared in the sidebar
// as ordinary persistent sessions. `InstanceManager.shutdownTempSync()`
// performs the cleanup synchronously, and `scheduleRestart` calls it before
// exiting.

let ctx, baseUrl, instances, claudeProjectsRoot, home;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  claudeProjectsRoot = r.claudeProjectsRoot;
  ctx.projectsRoot = r.projectsRoot;
  ctx.claudeProjectsRoot = r.claudeProjectsRoot;
});
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

test('shutdownTempSync archives temp session (jsonl kept, subagents dir deleted) and leaves non-temp alone', async () => {
  const created = await api(baseUrl, 'POST', '/api/projects', { name: 'restartcleanup' });
  assert.equal(created.status, 201);

  const tempRes = await api(baseUrl, 'POST', '/api/instances', { project: 'restartcleanup', temp: true });
  assert.equal(tempRes.status, 201);
  const tempInst = instances.get(tempRes.body.id);
  await waitFor(() => tempInst.status === 'idle' && tempInst.sessionId);
  const tempSid = tempInst.sessionId;

  const normalRes = await api(baseUrl, 'POST', '/api/instances', { project: 'restartcleanup' });
  assert.equal(normalRes.status, 201);
  const normalInst = instances.get(normalRes.body.id);
  await waitFor(() => normalInst.status === 'idle' && normalInst.sessionId);
  const normalSid = normalInst.sessionId;

  // Materialize both jsonls (fake-claude doesn't write to ~/.claude/projects).
  const dir = path.join(claudeProjectsRoot, encodeCwd(tempInst.cwd));
  await fs.mkdir(dir, { recursive: true });
  const tempJsonl = path.join(dir, `${tempSid}.jsonl`);
  const tempSubagents = path.join(dir, tempSid);
  const normalJsonl = path.join(dir, `${normalSid}.jsonl`);
  await fs.writeFile(tempJsonl, '{"type":"user","uuid":"u1"}\n');
  await fs.mkdir(tempSubagents, { recursive: true });
  await fs.writeFile(path.join(tempSubagents, 'agent.jsonl'), '{}\n');
  await fs.writeFile(normalJsonl, '{"type":"user","uuid":"u2"}\n');

  instances.shutdownTempSync();

  // Archive behavior: .jsonl is KEPT (the transcript is preserved for restore).
  await fs.access(tempJsonl); // must still exist
  // Subagent dir is still cleaned up (ephemeral, not needed for restore).
  await assert.rejects(() => fs.access(tempSubagents), 'temp subagents dir must be deleted');
  await fs.access(normalJsonl); // non-temp jsonl untouched
});

test('tempCleanupSnapshot only includes live temp instances with a sessionId', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'snapshotproj' });
  const tempRes = await api(baseUrl, 'POST', '/api/instances', { project: 'snapshotproj', temp: true });
  const tempInst = instances.get(tempRes.body.id);
  await waitFor(() => tempInst.sessionId);
  const normalRes = await api(baseUrl, 'POST', '/api/instances', { project: 'snapshotproj' });
  const normalInst = instances.get(normalRes.body.id);
  await waitFor(() => normalInst.sessionId);

  const snap = instances.tempCleanupSnapshot();
  assert.equal(snap.length, 1);
  assert.deepEqual(snap[0], { cwd: tempInst.cwd, sessionId: tempInst.sessionId });
});

test('writePendingTempCleanup + sweepPendingTempCleanup round-trip archives sessions (jsonl kept, subagents removed)', async () => {
  const cwd = '/tmp/cc-fake-cwd-' + Math.random().toString(36).slice(2);
  const sid = '11111111-2222-3333-4444-555555555555';
  const dir = path.join(claudeProjectsRoot, encodeCwd(cwd));
  await fs.mkdir(dir, { recursive: true });
  const jsonl = path.join(dir, `${sid}.jsonl`);
  const subagents = path.join(dir, sid);
  await fs.writeFile(jsonl, '{"type":"user","uuid":"u1"}\n');
  await fs.mkdir(subagents, { recursive: true });
  await fs.writeFile(path.join(subagents, 'a.jsonl'), '{}\n');

  // Manifest dir must exist (orchStoreRoot lives under projectsRoot).
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  writePendingTempCleanup([{ cwd, sessionId: sid }]);

  const manifest = pendingTempCleanupPath();
  await fs.access(manifest);

  const result = sweepPendingTempCleanup({ log: { warn() {}, log() {} } });
  assert.equal(result.swept, 1);
  // .jsonl must survive (archived, not deleted).
  await fs.access(jsonl);
  // Subagent dir is cleaned up.
  await assert.rejects(() => fs.access(subagents));
  // Manifest is removed after sweep.
  await assert.rejects(() => fs.access(manifest));
});

test('sweepPendingTempCleanup keeps any surviving .jsonl and removes subagent dir', async () => {
  // The sweep never deletes the .jsonl — it marks the session archived and
  // leaves the transcript for restore. The subagent dir is still cleaned.
  // Any .jsonl on disk (including orphaned writes) survives.
  const cwd = '/tmp/cc-orphaned-' + Math.random().toString(36).slice(2);
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const dir = path.join(claudeProjectsRoot, encodeCwd(cwd));

  await fs.mkdir(orchStoreRoot(), { recursive: true });
  writePendingTempCleanup([{ cwd, sessionId: sid }]);

  // Simulate a .jsonl that survived (either was never deleted or reappeared).
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${sid}.jsonl`), '{"type":"user","uuid":"late"}\n');
  await fs.mkdir(path.join(dir, sid), { recursive: true });

  const result = sweepPendingTempCleanup({ log: { warn() {}, log() {} } });
  assert.equal(result.swept, 1);
  // .jsonl is KEPT — we archive, not delete.
  await fs.access(path.join(dir, `${sid}.jsonl`));
  // Subagent dir is removed.
  await assert.rejects(() => fs.access(path.join(dir, sid)));
  await assert.rejects(() => fs.access(pendingTempCleanupPath()));
});

test('sweepPendingTempCleanup is a safe no-op when no manifest exists', async () => {
  const result = sweepPendingTempCleanup({ log: { warn() {}, log() {} } });
  assert.equal(result.swept, 0);
});

test('shutdownTempSync is a safe no-op when there are no temp instances', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'restartcleanup2' });
  const normalRes = await api(baseUrl, 'POST', '/api/instances', { project: 'restartcleanup2' });
  const normalInst = instances.get(normalRes.body.id);
  await waitFor(() => normalInst.status === 'idle' && normalInst.sessionId);

  const dir = path.join(claudeProjectsRoot, encodeCwd(normalInst.cwd));
  await fs.mkdir(dir, { recursive: true });
  const jsonl = path.join(dir, `${normalInst.sessionId}.jsonl`);
  await fs.writeFile(jsonl, '{"type":"user","uuid":"u1"}\n');

  assert.doesNotThrow(() => instances.shutdownTempSync());
  await fs.access(jsonl);
});

test('temp marker is written at spawn time, before any turn_end', async () => {
  // Regression: markTemp() was only called at turn_end. A SIGKILL before
  // the first turn completed left the sessionId absent from temp-sessions.json,
  // so the orphaned .jsonl was re-adopted as a persistent session on the next
  // boot. The fix calls markTemp() at spawn time (fire-and-forget) so the
  // sidecar is durable from the moment the subprocess starts.
  await api(baseUrl, 'POST', '/api/projects', { name: 'spawnmarker' });
  const tempRes = await api(baseUrl, 'POST', '/api/instances', { project: 'spawnmarker', temp: true });
  assert.equal(tempRes.status, 201);
  const tempInst = instances.get(tempRes.body.id);

  // Wait only for sessionId to be set — that is the synchronous part of
  // spawn(). Do NOT wait for idle (which would imply a turn completed).
  await waitFor(() => !!tempInst.sessionId);
  const sid = tempInst.sessionId;

  // The markTemp() fire-and-forget write should land almost immediately
  // (local file write). Poll until it does — no artificial sleep needed.
  await waitFor(async () => isTemp(sid), { timeout: 3000 });

  assert.equal(await isTemp(sid), true,
    'temp marker must be in temp-sessions.json before any turn_end fires');
});

// Crash-orphaned temps: recorded in temp-sessions.json but with no live
// instance (e.g. a prior hard crash before this restart). shutdownTempSync's
// kill/wipe loop never sees these since it only iterates live instances —
// runTempCleanup must archive them too so a plain restart clears every
// durable temp, not just the attached ones.

test('orphanedTempIdsSync returns durable temp ids with no matching live instance', async () => {
  const liveSid = 'ffffffff-0000-1111-2222-333333333333';
  const orphanSid = '00000000-1111-2222-3333-444444444444';
  await markTemp(liveSid);
  await markTemp(orphanSid);

  const orphaned = orphanedTempIdsSync([liveSid]);
  assert.deepEqual(orphaned, [orphanSid]);
});

test('runTempCleanup archives a crash-orphaned temp session with no live instance', async () => {
  const orphanSid = 'dddddddd-eeee-ffff-0000-111111111111';
  await markTemp(orphanSid);
  assert.equal(await isTemp(orphanSid), true);

  runTempCleanup({ instances, log: { warn() {}, log() {} } });

  await waitFor(async () => isArchived(orphanSid));
  assert.equal(await isArchived(orphanSid), true, 'orphaned temp must be archived');
  assert.equal(await isTemp(orphanSid), false, 'orphaned temp must be unmarked temp');
});

test('runTempCleanup archives a live temp and a crash-orphaned temp without double-processing', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'runtempcleanup' });
  const tempRes = await api(baseUrl, 'POST', '/api/instances', { project: 'runtempcleanup', temp: true });
  const tempInst = instances.get(tempRes.body.id);
  await waitFor(() => tempInst.status === 'idle' && tempInst.sessionId);
  const liveSid = tempInst.sessionId;
  await waitFor(async () => isTemp(liveSid));

  const orphanSid = 'eeeeeeee-ffff-0000-1111-222222222222';
  await markTemp(orphanSid);

  // The live sessionId must be excluded from the orphaned set — it's handled
  // by shutdownTempSync, not the orphan path — so it's never processed twice.
  const orphaned = orphanedTempIdsSync([liveSid]);
  assert.ok(!orphaned.includes(liveSid), 'live sessionId must not be treated as orphaned');
  assert.ok(orphaned.includes(orphanSid), 'truly orphaned sessionId must be found');

  runTempCleanup({ instances, log: { warn() {}, log() {} } });

  await waitFor(async () => isArchived(liveSid));
  await waitFor(async () => isArchived(orphanSid));
  assert.equal(await isArchived(liveSid), true);
  assert.equal(await isArchived(orphanSid), true);
  assert.equal(await isTemp(liveSid), false);
  assert.equal(await isTemp(orphanSid), false);
});

test('sweepPendingTempCleanup bookkeeps a cwd-less manifest entry (no dir to clean)', async () => {
  const sid = '11111111-aaaa-bbbb-cccc-dddddddddddd';
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  writePendingTempCleanup([{ sessionId: sid }]);

  const result = sweepPendingTempCleanup({ log: { warn() {}, log() {} } });
  assert.equal(result.swept, 1);
  await waitFor(async () => isArchived(sid));
  assert.equal(await isArchived(sid), true);
  await assert.rejects(() => fs.access(pendingTempCleanupPath()));
});

test('Restart + Resume (drainToManifest) archives nothing — live and orphaned temps are both carried over', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'resumecarry' });
  const tempRes = await api(baseUrl, 'POST', '/api/instances', { project: 'resumecarry', temp: true });
  const tempInst = instances.get(tempRes.body.id);
  await waitFor(() => tempInst.status === 'idle' && tempInst.sessionId);
  const liveSid = tempInst.sessionId;
  await waitFor(async () => isTemp(liveSid));

  const orphanSid = '22222222-bbbb-cccc-dddd-eeeeeeeeeeee';
  await markTemp(orphanSid);

  await drainToManifest({
    server: null, wss: null, instances,
    log: { warn() {}, log() {}, error() {} },
    graceMs: 100,
  });

  assert.equal(await isTemp(liveSid), true, 'live temp must remain marked temp (carried over, not archived)');
  assert.equal(await isTemp(orphanSid), true, 'orphaned temp must remain marked temp (carried over, not archived)');
  assert.equal(await isArchived(liveSid), false);
  assert.equal(await isArchived(orphanSid), false);
  await assert.rejects(() => fs.access(pendingTempCleanupPath()), 'resume path must not write a pending-temp-cleanup manifest');
});
