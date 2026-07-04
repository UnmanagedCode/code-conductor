import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { encodeCwd, orchStoreRoot } from '../src/projects.js';
import { isTemp } from '../src/tempSessions.js';
import {
  pendingTempCleanupPath,
  writePendingTempCleanup,
  sweepPendingTempCleanup,
} from '../src/tempCleanup.js';

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
