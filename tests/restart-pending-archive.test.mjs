import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { encodeCwd, orchStoreRoot, localPlace} from '../src/projects.ts';
import { isPersistent, isArchived, setSegmentPersistent } from '../src/sessionStore.ts';
import {
  pendingArchivePath,
  sweepPendingArchive,
} from '../src/pendingArchive.ts';
import { drainToManifest } from '../src/resumeRestart.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-basic.json');

// Sessions across a restart: the boot sweep of a pending-archive.json archives
// what it lists, the persistent flag is durable from spawn, and a drained
// restart carries every session over instead of archiving it.

// A pending-archive.json in the shape the boot sweep reads.
async function plantPendingArchive(entries) {
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  await fs.writeFile(pendingArchivePath(), JSON.stringify({ writtenAt: new Date().toISOString(), entries }));
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

test('sweepPendingArchive archives sessions (jsonl kept, subagents removed)', async () => {
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
  await plantPendingArchive([{ place: localPlace(cwd), sessionId: sid }]);

  const manifest = pendingArchivePath();
  await fs.access(manifest);

  const result = sweepPendingArchive({ log: { warn() {}, log() {} } });
  assert.equal(result.swept, 1);
  // .jsonl must survive (archived, not deleted).
  await fs.access(jsonl);
  // Subagent dir is cleaned up.
  await assert.rejects(() => fs.access(subagents));
  // Manifest is removed after sweep.
  await assert.rejects(() => fs.access(manifest));
});

test('sweepPendingArchive keeps any surviving .jsonl and removes subagent dir', async () => {
  // The sweep never deletes the .jsonl — it marks the session archived and
  // leaves the transcript for restore. The subagent dir is still cleaned.
  // Any .jsonl on disk (including orphaned writes) survives.
  const cwd = '/tmp/cc-orphaned-' + Math.random().toString(36).slice(2);
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const dir = path.join(claudeProjectsRoot, encodeCwd(cwd));

  await fs.mkdir(orchStoreRoot(), { recursive: true });
  await plantPendingArchive([{ place: localPlace(cwd), sessionId: sid }]);

  // Simulate a .jsonl that survived (either was never deleted or reappeared).
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${sid}.jsonl`), '{"type":"user","uuid":"late"}\n');
  await fs.mkdir(path.join(dir, sid), { recursive: true });

  const result = sweepPendingArchive({ log: { warn() {}, log() {} } });
  assert.equal(result.swept, 1);
  // .jsonl is KEPT — we archive, not delete.
  await fs.access(path.join(dir, `${sid}.jsonl`));
  // Subagent dir is removed.
  await assert.rejects(() => fs.access(path.join(dir, sid)));
  await assert.rejects(() => fs.access(pendingArchivePath()));
});

test('sweepPendingArchive is a safe no-op when no manifest exists', async () => {
  const result = sweepPendingArchive({ log: { warn() {}, log() {} } });
  assert.equal(result.swept, 0);
});

test('persistent marker is written at spawn time, before any turn_end', async () => {
  // A SIGKILL before the first turn completes must not leave the segment
  // without its `persistent` flag in sessions.json, or the session comes back
  // normal on its next resume. The flag is written at spawn time and awaited
  // by launch(), so it is durable once the awaited create resolves.
  await api(baseUrl, 'POST', '/api/projects', { name: 'spawnmarker' });
  const res = await api(baseUrl, 'POST', '/api/instances', { project: 'spawnmarker', persistent: true });
  assert.equal(res.status, 201);
  const inst = instances.get(res.body.id);

  // Wait only for sessionId to be set — that is the synchronous part of
  // spawn(). Do NOT wait for idle (which would imply a turn completed).
  await waitFor(() => !!inst.sessionId);
  const sid = inst.backingSessionId;

  // The write has landed by the time the 201 returns; the poll just reads it
  // back — no artificial sleep needed.
  await waitFor(async () => isPersistent(sid), { timeout: 3000 });

  assert.equal(await isPersistent(sid), true,
    'persistent flag must be on the segment in sessions.json before any turn_end fires');
});

test('sweepPendingArchive bookkeeps a cwd-less manifest entry (no dir to clean)', async () => {
  const sid = '11111111-aaaa-bbbb-cccc-dddddddddddd';
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  await plantPendingArchive([{ sessionId: sid }]);

  const result = sweepPendingArchive({ log: { warn() {}, log() {} } });
  assert.equal(result.swept, 1);
  await waitFor(async () => isArchived(sid));
  assert.equal(await isArchived(sid), true);
  await assert.rejects(() => fs.access(pendingArchivePath()));
});

test('a drained restart (drainToManifest) archives nothing — live normal, live persistent and orphaned sessions are all carried over', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'resumecarry' });
  const normalRes = await api(baseUrl, 'POST', '/api/instances', { project: 'resumecarry' });
  const persistentRes = await api(baseUrl, 'POST', '/api/instances', { project: 'resumecarry', persistent: true });
  const normalInst = instances.get(normalRes.body.id);
  const persistentInst = instances.get(persistentRes.body.id);
  await waitFor(() => normalInst.status === 'idle' && normalInst.sessionId
    && persistentInst.status === 'idle' && persistentInst.sessionId);
  const normalSid = normalInst.backingSessionId;
  const persistentSid = persistentInst.backingSessionId;
  await waitFor(async () => isPersistent(persistentSid));

  const orphanSid = '22222222-bbbb-cccc-dddd-eeeeeeeeeeee';
  await setSegmentPersistent(orphanSid, true);

  await drainToManifest({
    server: null, wss: null, instances,
    log: { warn() {}, log() {}, error() {} },
    graceMs: 100,
  });

  assert.equal(await isPersistent(normalSid), false, 'a normal session stays normal across the drain');
  assert.equal(await isPersistent(persistentSid), true, 'a persistent session stays persistent across the drain');
  assert.equal(await isArchived(normalSid), false, 'a live normal session is carried over, not archived');
  assert.equal(await isArchived(persistentSid), false);
  assert.equal(await isArchived(orphanSid), false);
  await assert.rejects(() => fs.access(pendingArchivePath()), 'resume path must not write a pending-archive manifest');
});
