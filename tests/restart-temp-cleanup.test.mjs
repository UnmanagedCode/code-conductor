import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { encodeCwd, orchStoreRoot, localPlace} from '../src/projects.ts';
import { isTemp, isArchived, setSegmentTemp } from '../src/sessionStore.ts';
import {
  pendingTempCleanupPath,
  sweepPendingTempCleanup,
} from '../src/tempCleanup.ts';
import { drainToManifest } from '../src/resumeRestart.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-basic.json');

// Temp sessions across a restart: the boot sweep of a pending-temp-cleanup.json
// archives what it lists, the temp flag is durable from spawn, and a drained
// restart carries every temp over instead of archiving it.

// A pending-temp-cleanup.json in the shape the boot sweep reads.
async function plantPendingTempCleanup(entries) {
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  await fs.writeFile(pendingTempCleanupPath(), JSON.stringify({ writtenAt: new Date().toISOString(), entries }));
}

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

test('sweepPendingTempCleanup archives sessions (jsonl kept, subagents removed)', async () => {
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
  await plantPendingTempCleanup([{ place: localPlace(cwd), sessionId: sid }]);

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
  await plantPendingTempCleanup([{ place: localPlace(cwd), sessionId: sid }]);

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

test('temp marker is written at spawn time, before any turn_end', async () => {
  // A SIGKILL before the first turn completes must not leave the segment
  // without its `temp` flag in sessions.json, or the orphaned .jsonl is
  // re-adopted as a persistent session on the next boot. The flag is written
  // at spawn time and awaited by launch(), so it is durable once the awaited
  // create resolves.
  await api(baseUrl, 'POST', '/api/projects', { name: 'spawnmarker' });
  const tempRes = await api(baseUrl, 'POST', '/api/instances', { project: 'spawnmarker', temp: true });
  assert.equal(tempRes.status, 201);
  const tempInst = instances.get(tempRes.body.id);

  // Wait only for sessionId to be set — that is the synchronous part of
  // spawn(). Do NOT wait for idle (which would imply a turn completed).
  await waitFor(() => !!tempInst.sessionId);
  const sid = tempInst.backingSessionId;

  // The temp write has landed by the time the 201 returns; the poll just
  // reads it back — no artificial sleep needed.
  await waitFor(async () => isTemp(sid), { timeout: 3000 });

  assert.equal(await isTemp(sid), true,
    'temp flag must be on the segment in sessions.json before any turn_end fires');
});

test('sweepPendingTempCleanup bookkeeps a cwd-less manifest entry (no dir to clean)', async () => {
  const sid = '11111111-aaaa-bbbb-cccc-dddddddddddd';
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  await plantPendingTempCleanup([{ sessionId: sid }]);

  const result = sweepPendingTempCleanup({ log: { warn() {}, log() {} } });
  assert.equal(result.swept, 1);
  await waitFor(async () => isArchived(sid));
  assert.equal(await isArchived(sid), true);
  await assert.rejects(() => fs.access(pendingTempCleanupPath()));
});

test('a drained restart (drainToManifest) archives nothing — live and orphaned temps are both carried over', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'resumecarry' });
  const tempRes = await api(baseUrl, 'POST', '/api/instances', { project: 'resumecarry', temp: true });
  const tempInst = instances.get(tempRes.body.id);
  await waitFor(() => tempInst.status === 'idle' && tempInst.sessionId);
  const liveSid = tempInst.backingSessionId;
  await waitFor(async () => isTemp(liveSid));

  const orphanSid = '22222222-bbbb-cccc-dddd-eeeeeeeeeeee';
  await setSegmentTemp(orphanSid, true);

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
