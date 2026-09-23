// Lineage tombstones (src/sessionLineage.ts): dropping a segment marks it
// `dropped: true` IN PLACE so the lineage scroll-back walk can still see where
// it was, while every existing reader of the store sees exactly the chain it
// saw when a drop removed the entry.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  dropSegment, revertRotation, recordRotation, resolveBacking, publicIdFor, segmentsFor, loadLineage,
} from '../src/sessionLineage.ts';
import {
  orchStoreRoot, localPlace, resolveToBackingId, findSessionLocation, listSessions, deleteSessionForCwd,
  encodeCwd, transcriptRoot,
} from '../src/projects.ts';
import { segmentTurns, writeSegmentFile, writeLineageRow, mcpTool, newExport } from './segmentChain.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-resume.json');

let ctx, home;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); });
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  ctx.projectsRoot = r.projectsRoot;
});
afterEach(async () => { await ctx.instances.shutdown(); await rmrf(home); });

const A = 'a1a10472-0000-4000-8000-00000000000a';
const B = 'b2b20472-0000-4000-8000-00000000000b';
const C = 'c3c30472-0000-4000-8000-00000000000c';
const D = 'd4d40472-0000-4000-8000-00000000000d';
const E = 'e5e50472-0000-4000-8000-00000000000e';
const P = A.slice(0, 8);
const Q = D.slice(0, 8);

const storeFile = () => path.join(orchStoreRoot(), 'session-lineage.json');
async function rawStore() {
  try { return JSON.parse(await fs.readFile(storeFile(), 'utf8')).sessions; } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}
const statStore = async () => { const s = await fs.stat(storeFile()); return { ino: s.ino, mtimeMs: s.mtimeMs }; };
const seg = (id, reason, extra = {}) => ({ id, reason, ...extra });

test('TL1 dropSegment tombstones in place, moves current to the newest live entry, and a repeat drop writes nothing', async () => {
  await writeLineageRow(P, [seg(A, 'initial'), seg(B, 'renew'), seg(C, 'renew')]);
  await dropSegment(B);
  const afterB = (await rawStore())[P];
  assert.deepEqual(afterB.segments.map(s => [s.id, s.dropped ?? false]), [[A, false], [B, true], [C, false]],
    'the dropped entry stays in the row, marked');
  assert.equal(afterB.current, C, 'dropping a non-current entry leaves current alone');

  await dropSegment(C);
  const afterC = (await rawStore())[P];
  assert.deepEqual(afterC.segments.map(s => [s.id, s.dropped ?? false]), [[A, false], [B, true], [C, true]]);
  assert.equal(afterC.current, A, 'current moves to the newest LIVE entry, past the tombstoned B');

  const before = await statStore();
  await dropSegment(C);
  assert.deepEqual(await statStore(), before, 'an already-tombstoned id is a no-op with no write');
  assert.deepEqual((await rawStore())[P], afterC);
});

test('TL2 every reader of the store sees a tombstoned chain exactly as the entry-removed chain', async () => {
  const project = 'tl2';
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: project });
  const place = localPlace(path.join(ctx.projectsRoot, project));
  for (const [id, reason, tag] of [[A, 'initial', 'a'], [B, 'renew', 'b'], [C, 'renew', 'c'], [D, 'initial', 'd'], [E, 'renew', 'e']]) {
    await writeSegmentFile(place, { id, reason, records: segmentTurns(tag, 2) });
  }
  await writeLineageRow(P, [seg(A, 'initial'), seg(B, 'renew'), seg(C, 'renew')]);
  await writeLineageRow(Q, [seg(D, 'initial'), seg(E, 'renew')]);
  // Settings → Archived → Delete, for a superseded segment (B) and a current one (E).
  for (const sid of [A, B, E]) {
    const r = await api(ctx.baseUrl, 'POST', `/api/projects/${project}/sessions/${sid}/archive`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  for (const sid of [B, E]) {
    const r = await api(ctx.baseUrl, 'DELETE', `/api/projects/${project}/sessions/${sid}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const s1 = await rawStore();
  assert.equal(s1[P].segments.find(s => s.id === B)?.dropped, true, 'S1: B is tombstoned in place');
  assert.equal(s1[Q].segments.find(s => s.id === E)?.dropped, true, 'S1: E is tombstoned in place');

  const ids = [P, Q, A, B, C, D, E, A.slice(0, 10), B.slice(0, 10), C.slice(0, 10), E.slice(0, 10)];
  async function measure() {
    const out = {};
    for (const id of ids) {
      out[id] = {
        resolveBacking: await resolveBacking(id),
        publicIdFor: await publicIdFor(id),
        segmentsFor: await segmentsFor(id),
        resolveToBackingId: await resolveToBackingId(id),
        findSessionLocation: await findSessionLocation(id),
        resolveResumeRef: await ctx.instances.resolveResumeRef(id),
      };
    }
    const lineage = await loadLineage();
    out.byBacking = [...lineage.byBacking].sort();
    out.current = [...lineage.byPublic].map(([k, row]) => [k, row.current]).sort();
    out.sessionRows = (await listSessions(project)).map(r => [r.sessionId, !!r.archived]).sort();
    const archived = await api(ctx.baseUrl, 'GET', '/api/archived');
    assert.equal(archived.status, 200);
    out.archived = archived.body.groups.flatMap(g => g.sessions.map(s => s.sessionId)).sort();
    out.transcriptB = await mcpTool(ctx, 'get_transcript', { sessionId: B });
    out.transcriptE = await mcpTool(ctx, 'get_transcript', { sessionId: E });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions', resume: P });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const inst = ctx.instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle');
    out.segmentCount = inst.summary().segmentCount;
    out.liveB = ctx.instances.liveForSession(B);
    out.liveC = ctx.instances.liveForSession(C)?.id === inst.id;
    await ctx.instances.shutdown();
    return out;
  }

  const m1 = await measure();
  assert.deepEqual(m1.archived, [A], 'a tombstoned row is not listed in Settings → Archived');
  assert.equal(m1.liveB, null, 'a live resume does not answer to the tombstoned segment');

  // S0: the same rows, the dropped entries absent.
  await writeLineageRow(P, s1[P].segments.filter(s => !s.dropped));
  await writeLineageRow(Q, s1[Q].segments.filter(s => !s.dropped));
  const m0 = await measure();
  assert.deepEqual(m1, m0, 'every reader answers identically for S1 and S0');

  // Only the walk's own reader sees the tombstone.
  await writeLineageRow(P, s1[P].segments);
  const chainFor = await newExport('src/sessionLineage.ts', 'chainFor');
  assert.deepEqual((await chainFor(P)).map(s => [s.id, !!s.dropped]), [[A, false], [B, true], [C, false]]);
});

test('TL3 Settings → Archived → Delete and loadHistory\'s missing-transcript branch tombstone identically', async () => {
  const project = 'tl3';
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: project });
  const place = localPlace(path.join(ctx.projectsRoot, project));
  const A1 = 'a1a1f472-0000-4000-8000-0000000000a1', B1 = 'b1b1f472-0000-4000-8000-0000000000b1';
  const A2 = 'a2a2f472-0000-4000-8000-0000000000a2', B2 = 'b2b2f472-0000-4000-8000-0000000000b2';
  const P1 = A1.slice(0, 8), P2 = A2.slice(0, 8);
  for (const [id, reason, tag] of [[A1, 'initial', 'a'], [B1, 'renew', 'b'], [A2, 'initial', 'a'], [B2, 'renew', 'b']]) {
    await writeSegmentFile(place, { id, reason, records: segmentTurns(tag, 2) });
  }
  await writeLineageRow(P1, [seg(A1, 'initial'), seg(B1, 'renew')]);
  await writeLineageRow(P2, [seg(A2, 'initial'), seg(B2, 'renew')]);

  // Path 1: the function behind Settings → Archived → Delete.
  assert.equal(await deleteSessionForCwd(place, B1), true);

  // Path 2: a relaunch onto a transcript that has gone missing.
  const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions', resume: P2 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inst = ctx.instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  assert.equal(inst.backingSessionId, B2, 'precondition: resumed onto B2');
  await inst.kill({ graceMs: 50 });
  await waitFor(() => inst.proc == null && (inst.status === 'exited' || inst.status === 'crashed'));
  await fs.unlink(path.join(transcriptRoot(place), encodeCwd(place.cwd), `${B2}.jsonl`));
  const rs = await api(ctx.baseUrl, 'POST', `/api/instances/${r.body.id}/respawn`);
  assert.equal(rs.status, 200, JSON.stringify(rs.body));
  await waitFor(() => inst.status === 'idle');
  await inst.flushLineage();

  const store = await rawStore();
  assert.equal(store[P2].segments.find(s => s.id === B2)?.dropped, true, 'the missing-transcript branch tombstones B2');
  const norm = (row, names) => JSON.parse(JSON.stringify(row).replaceAll(names.A, 'A').replaceAll(names.B, 'B'));
  const n1 = norm(store[P1], { A: A1, B: B1 });
  const n2 = norm(store[P2], { A: A2, B: B2 });
  assert.deepEqual(n1, n2, 'both paths write the same row');
  assert.deepEqual(n1, {
    current: 'A',
    segments: [
      { id: 'A', reason: 'initial', at: store[P1].segments[0].at },
      { id: 'B', reason: 'renew', at: store[P1].segments[1].at, dropped: true },
    ],
  });
});

test('TL4 mutations keep the row invariant: at least one live entry, and current is live', async (t) => {
  const rowless = async () => ({
    resolveBacking: await resolveBacking(P), publicIdFor: await publicIdFor(B), segmentsFor: await segmentsFor(P),
  });

  await t.test('(a) reverting the only live entry removes the row', async () => {
    await writeLineageRow(P, [seg(A, 'initial', { dropped: true }), seg(B, 'prune')]);
    await revertRotation(P, B);
    assert.equal((await rawStore())[P], undefined, 'the row is gone');
    assert.deepEqual(await rowless(), { resolveBacking: P, publicIdFor: B, segmentsFor: [] },
      'every resolver answers as for a row-less store');
  });

  await t.test('(b) revertRotation removes the last LIVE entry and keeps a trailing tombstone', async () => {
    await fs.rm(storeFile(), { force: true });
    await writeLineageRow(P, [seg(A, 'initial'), seg(B, 'renew'), seg(C, 'renew', { dropped: true })]);
    await revertRotation(P, B);
    const row = (await rawStore())[P];
    assert.deepEqual(row?.segments.map(s => [s.id, s.dropped ?? false]), [[A, false], [C, true]]);
    assert.equal(row.current, A);
  });

  await t.test('(c) dropping the last live entry removes the row', async () => {
    await fs.rm(storeFile(), { force: true });
    await writeLineageRow(P, [seg(A, 'initial', { dropped: true }), seg(B, 'renew')]);
    await dropSegment(B);
    assert.equal((await rawStore())[P], undefined, 'the row is gone');
    assert.deepEqual(await rowless(), { resolveBacking: P, publicIdFor: B, segmentsFor: [] });
  });

  await t.test('(d) recordRotation after a tombstone appends, and is idempotent against the last live entry', async () => {
    await fs.rm(storeFile(), { force: true });
    await writeLineageRow(P, [seg(A, 'initial'), seg(B, 'renew', { dropped: true })]);
    await recordRotation(P, C, 'renew');
    let row = (await rawStore())[P];
    assert.deepEqual(row.segments.map(s => [s.id, s.dropped ?? false]), [[A, false], [B, true], [C, false]]);
    assert.equal(row.current, C);
    const before = await statStore();
    await recordRotation(P, C, 'renew');
    assert.deepEqual(await statStore(), before, 'a repeat is a no-op with no write');

    await writeLineageRow(P, [seg(A, 'initial'), seg(C, 'renew'), seg(D, 'renew', { dropped: true })]);
    await recordRotation(P, C, 'renew');
    row = (await rawStore())[P];
    assert.deepEqual(row.segments.map(s => s.id), [A, C, D], 'current C is the last LIVE entry, so nothing is appended');
  });

  await t.test('(e) a row that falls back to its own live initial entry is deleted', async () => {
    await fs.rm(storeFile(), { force: true });
    const self = 'f6f60472';
    await writeLineageRow(self, [seg(self, 'initial'), seg(B, 'renew', { dropped: true }), seg(C, 'renew')]);
    await revertRotation(self, C);
    assert.equal((await rawStore())[self], undefined, 'the base case is restored');
  });

  await t.test('(f) a hand-written row with no live entry parses as absent', async () => {
    await fs.mkdir(orchStoreRoot(), { recursive: true });
    await fs.writeFile(storeFile(), JSON.stringify({ sessions: {
      [P]: { current: A, segments: [{ id: A, reason: 'initial', at: '', dropped: true }] },
    } }));
    const lineage = await loadLineage();
    assert.equal(lineage.byPublic.has(P), false);
    assert.equal(lineage.byBacking.has(A), false);
    assert.equal(await resolveBacking(P), P);
    assert.equal(await publicIdFor(A), A);
  });
});
