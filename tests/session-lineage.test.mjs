// Unit tests for the session-lineage store (src/sessionLineage.ts) — the
// public-id ↔ backing-id chain that makes a session's public identity permanent
// across a `/clear` renewal or a prune.
//
// The contract these pin, in order of how much depends on them:
//   1. BASE CASE — no row ⇒ every resolver is the identity function. This is what
//      makes the store additive with no migration and no backfill.
//   2. MINTING — 8 hex from the first backing id, extended to 13 on a collision
//      against EITHER index (public or backing), full id as the loud last resort.
//   3. ROTATION — append + advance, lazy row creation from the base case,
//      idempotent on a retry, and exactly reversible by revertRotation.
//   4. READ TOLERANCE — dropSegment keeps a chain from pointing at a missing file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';

// Isolate the central store under a tmp PROJECTS_ROOT. projectsRoot() reads the
// env at call time, so setting it before importing is enough.
const tmp = await mkdtemp('cc-lineage-');
process.env.PROJECTS_ROOT = path.join(tmp, 'project');
// The two read-tolerance tests below plant real transcripts, so the Claude
// projects root has to be isolated too.
process.env.CLAUDE_PROJECTS_ROOT = path.join(tmp, 'claude-projects');

const {
  loadLineage, mintPublicId, recordRotation, revertRotation,
  resolveBacking, publicIdFor, segmentsFor, dropSegment,
  PUBLIC_ID_LEN, PUBLIC_ID_LEN_EXTENDED,
} = await import('../src/sessionLineage.ts');

const STORE_FILE = () => path.join(process.env.PROJECTS_ROOT, '.code-conductor', 'session-lineage.json');

// Every test starts from an empty store — the file is unlinked when the last row
// goes, so removing it IS the reset.
async function reset() {
  await fs.rm(STORE_FILE(), { force: true });
}

// A deterministic UUID-shaped backing id. `head` is the first 8 hex chars (what a
// mint derives from) and `tag` disambiguates the rest.
function backing(head, tag = '0000') {
  return `${head}-${tag}-4000-8000-000000000001`;
}

test('base case: no row ⇒ both resolvers are the identity function', async () => {
  await reset();
  const sid = backing('aaaaaaaa');
  assert.equal(await resolveBacking(sid), sid, 'unknown id resolves to itself');
  assert.equal(await publicIdFor(sid), sid, 'unknown id is its own public id');
  assert.deepEqual(await segmentsFor(sid), [], 'no row ⇒ no segments');
  const { byPublic, byBacking } = await loadLineage();
  assert.equal(byPublic.size, 0);
  assert.equal(byBacking.size, 0);
  // A missing file is the legitimate empty base case, not an error.
  await assert.rejects(fs.access(STORE_FILE()));
});

test('mintPublicId derives 8 hex chars, persists the initial row, and round-trips', async () => {
  await reset();
  const first = backing('12345678');
  const pub = await mintPublicId(first);
  assert.equal(pub, '12345678');
  assert.equal(pub.length, PUBLIC_ID_LEN);

  assert.equal(await resolveBacking(pub), first, 'public → current backing');
  assert.equal(await publicIdFor(first), pub, 'backing → public');
  assert.equal(await publicIdFor(pub), pub, 'public → itself');

  const segs = await segmentsFor(pub);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].id, first);
  assert.equal(segs[0].reason, 'initial');
  assert.ok(segs[0].at, 'segment carries a timestamp');

  // File shape: { sessions: { <publicId>: { current, segments } } }.
  const obj = JSON.parse(await fs.readFile(STORE_FILE(), 'utf8'));
  assert.deepEqual(Object.keys(obj.sessions), [pub]);
  assert.equal(obj.sessions[pub].current, first);
});

test('mint extends to 13 chars when the 8-char form collides with an existing PUBLIC id', async () => {
  await reset();
  await mintPublicId(backing('cafe0000', '1111'));           // takes public 'cafe0000'
  const second = backing('cafe0000', '2222');
  const pub = await mintPublicId(second);
  assert.equal(pub, 'cafe0000-2222');
  assert.equal(pub.length, PUBLIC_ID_LEN_EXTENDED);
  assert.ok(second.startsWith(pub), 'the extension stays a literal prefix of the backing id');
  assert.equal(await resolveBacking(pub), second);
});

test('the collision universe is PUBLIC ids only — a shadowed segment prefix is resolution\'s job', async () => {
  await reset();
  // A minted public id can be a PREFIX of another session's segment. Minting does
  // NOT try to avoid that, deliberately: a candidate is a slice of a UUID and can
  // never equal a full backing id, so testing backing ids would be dead code — and
  // the case is already decided one layer up, where an exact match beats a prefix
  // (see tests/session-prefix.test.mjs → "an exact public-id match beats a longer
  // session's segment prefix"). This pins that mint does not pointlessly extend.
  const owner = await mintPublicId(backing('11111111'));
  const shadowed = backing('beef0000', '1234');
  await recordRotation(owner, shadowed, 'renew');
  assert.equal((await loadLineage()).byBacking.get(shadowed), owner);

  const pub = await mintPublicId(backing('beef0000', '9999'));
  assert.equal(pub, 'beef0000', 'no extension: the 8-char form collides with no PUBLIC id');
  // Both remain addressable, each by its own exact id.
  assert.equal(await publicIdFor(shadowed), owner, 'the segment still resolves to its owner');
  assert.equal(await publicIdFor(pub), pub);
});

test('mint falls back to the full backing id when 8 AND 13 both collide', async () => {
  await reset();
  await mintPublicId(backing('dddddddd', '0000'));   // takes public 'dddddddd'
  // A second mint sharing the 8-char head extends, which is what takes the 13-char
  // candidate — as a PUBLIC id, the only thing the universe contains.
  assert.equal(await mintPublicId('dddddddd-eeee-4000-8000-000000000001'), 'dddddddd-eeee');

  const third = 'dddddddd-eeee-4000-8000-000000000009';
  const pub = await mintPublicId(third);
  assert.equal(pub, third, 'falls back to the full id — unique by construction');
  assert.equal(await resolveBacking(pub), third);
});

test('recordRotation appends, advances current, and preserves reason per segment', async () => {
  await reset();
  const first = backing('abcdef01');
  const pub = await mintPublicId(first);
  const renewed = backing('99999999');
  const pruned = backing('88888888');
  await recordRotation(pub, renewed, 'renew');
  await recordRotation(pub, pruned, 'prune');

  assert.deepEqual((await segmentsFor(pub)).map(s => [s.id, s.reason]), [
    [first, 'initial'], [renewed, 'renew'], [pruned, 'prune'],
  ]);
  assert.equal(await resolveBacking(pub), pruned, 'current is the newest segment');
  // Every segment stays addressable, permanently — a full backing/segment id
  // resolves to ITSELF, not to current, so an old transcript still opens.
  assert.equal(await resolveBacking(first), first);
  assert.equal(await resolveBacking(renewed), renewed);
  assert.equal(await publicIdFor(renewed), pub);
});

test('recordRotation creates the row lazily from the base case, minting nothing', async () => {
  await reset();
  // A pre-phase-1 session: full UUID as its public id, no row anywhere.
  const legacy = backing('7777aaaa');
  const rotated = backing('7777bbbb');
  await recordRotation(legacy, rotated, 'renew');

  const segs = await segmentsFor(legacy);
  assert.deepEqual(segs.map(s => [s.id, s.reason]), [[legacy, 'initial'], [rotated, 'renew']]);
  assert.equal(await resolveBacking(legacy), rotated);
  assert.equal(await publicIdFor(rotated), legacy, 'the public id stays the full UUID it already had');
});

test('recordRotation is idempotent — a retried write does not double-append', async () => {
  await reset();
  const pub = await mintPublicId(backing('55555555'));
  const next = backing('66666666');
  await recordRotation(pub, next, 'renew');
  await recordRotation(pub, next, 'renew');
  await recordRotation(pub, next, 'renew');
  assert.equal((await segmentsFor(pub)).length, 2);
  assert.equal(await resolveBacking(pub), next);
});

test('revertRotation drops the trailing segment and restores current', async () => {
  await reset();
  const first = backing('aabbccdd');
  const pub = await mintPublicId(first);
  const mid = backing('11112222');
  const tail = backing('33334444');
  await recordRotation(pub, mid, 'renew');
  await recordRotation(pub, tail, 'prune');

  await revertRotation(pub, tail);
  assert.deepEqual((await segmentsFor(pub)).map(s => s.id), [first, mid]);
  assert.equal(await resolveBacking(pub), mid);

  // A revert that does not name the TRAILING segment is a no-op — it must never
  // punch a hole mid-chain.
  await revertRotation(pub, first);
  assert.deepEqual((await segmentsFor(pub)).map(s => s.id), [first, mid]);
});

test('revertRotation restores the base case EXACTLY for a row-less session', async () => {
  await reset();
  const legacy = backing('0f0f0f0f');
  const rotated = backing('f0f0f0f0');
  await recordRotation(legacy, rotated, 'prune');   // lazily created the row
  await revertRotation(legacy, rotated);

  assert.deepEqual(await segmentsFor(legacy), [], 'the row is gone, not left as a stub');
  assert.equal(await resolveBacking(legacy), legacy);
  assert.equal(await publicIdFor(legacy), legacy);
  assert.equal((await loadLineage()).byPublic.size, 0);
  await assert.rejects(fs.access(STORE_FILE()), 'emptying the store unlinks the file');
});

test('revertRotation on a minted session keeps the row (initial id !== public id)', async () => {
  await reset();
  const first = backing('4c4c4c4c');
  const pub = await mintPublicId(first);
  await recordRotation(pub, backing('5d5d5d5d'), 'prune');
  await revertRotation(pub, backing('5d5d5d5d'));

  assert.deepEqual((await segmentsFor(pub)).map(s => s.id), [first],
    'the initial segment survives — its id is the full UUID, not the 8-char public id');
  assert.equal(await resolveBacking(pub), first);
});

test('dropSegment: on current, mid-chain, and last-remaining', async () => {
  await reset();
  const first = backing('a1a1a1a1');
  const pub = await mintPublicId(first);
  const mid = backing('b2b2b2b2');
  const tail = backing('c3c3c3c3');
  await recordRotation(pub, mid, 'renew');
  await recordRotation(pub, tail, 'renew');

  // Mid-chain: current is untouched.
  await dropSegment(mid);
  assert.deepEqual((await segmentsFor(pub)).map(s => s.id), [first, tail]);
  assert.equal(await resolveBacking(pub), tail);
  assert.equal(await publicIdFor(mid), mid, 'the dropped segment no longer resolves to the session');

  // Current: falls back to the newest survivor.
  await dropSegment(tail);
  assert.deepEqual((await segmentsFor(pub)).map(s => s.id), [first]);
  assert.equal(await resolveBacking(pub), first, 'current retreats to the newest survivor');

  // Last remaining: the row goes.
  await dropSegment(first);
  assert.deepEqual(await segmentsFor(pub), []);
  assert.equal(await resolveBacking(pub), pub, 'back to the base case');

  // Unknown id is a no-op, not a throw.
  await dropSegment('nothing-like-this');
});

test('concurrent mintPublicId calls produce two DISTINCT ids', async () => {
  await reset();
  // Same 8-char head, so the second mint MUST see the first one's row and extend.
  const a = backing('deadbeef', 'aaaa');
  const b = backing('deadbeef', 'bbbb');
  const [pa, pb] = await Promise.all([mintPublicId(a), mintPublicId(b)]);
  assert.notEqual(pa, pb, 'derive-check-extend-and-write is one atomic operation');
  const shorter = pa.length < pb.length ? pa : pb;
  const longer = pa.length < pb.length ? pb : pa;
  assert.equal(shorter, 'deadbeef');
  assert.equal(longer.length, PUBLIC_ID_LEN_EXTENDED);
  assert.equal(await resolveBacking(pa), a);
  assert.equal(await resolveBacking(pb), b);
});

// ---------------------------------------------------------------------------
// Read tolerance and crash safety. These two pin the properties that let a row
// outlive the files it names — Claude prunes its own ~/.claude/projects after
// ~30 days, and a crash can land between a rotation and its persist.
// ---------------------------------------------------------------------------

test('a vanished segment file: reads still succeed, and NOTHING is written on a read', async () => {
  await reset();
  const { encodeCwd, findSessionLocation } = await import('../src/projects.ts');
  const cwd = path.join(process.env.PROJECTS_ROOT, 'vanish');
  const dir = path.join(process.env.CLAUDE_PROJECTS_ROOT, encodeCwd(cwd));
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(dir, { recursive: true });

  const publicId = 'f0f0aaaa';
  const older = 'f0f0aaaa-0000-4000-8000-000000000001';
  const current = 'aaaa0000-0000-4000-8000-000000000002';
  await recordRotation(publicId, older, 'initial');
  await recordRotation(publicId, current, 'renew');
  for (const id of [older, current]) {
    await fs.writeFile(path.join(dir, `${id}.jsonl`), '{"type":"user","uuid":"u1"}\n');
  }
  assert.deepEqual((await findSessionLocation(publicId)), { project: 'vanish', worktreeName: null });

  // Claude's own cleanup removes CURRENT's file out of band — no delete path of
  // ours ran, so nothing pruned the chain.
  await fs.rm(path.join(dir, `${current}.jsonl`), { force: true });
  const rowBefore = await segmentsFor(publicId);

  // The read still resolves, via the newest-first walk over surviving segments.
  assert.deepEqual(await findSessionLocation(publicId), { project: 'vanish', worktreeName: null },
    'the public id still locates its session through an older surviving segment');
  assert.deepEqual(await findSessionLocation(older), { project: 'vanish', worktreeName: null });

  // …and the read wrote NOTHING. This is the deviation from the design's
  // "self-prunes on read": a write inside a hot read path races concurrent
  // readers, which is the same objection the design raises against lazy
  // mint-on-first-touch. The delete path and loadHistory's ENOENT branch own the
  // pruning instead (see archive-sessions.test.mjs).
  assert.deepEqual(await segmentsFor(publicId), rowBefore, 'a read must not mutate the row');
  assert.equal(await resolveBacking(publicId), current,
    'current still points at the vanished id — the row is not silently rewritten');

  // With EVERY file gone the locate honestly reports nothing rather than throwing.
  await fs.rm(path.join(dir, `${older}.jsonl`), { force: true });
  assert.equal(await findSessionLocation(publicId), null);
});

test('crash safety: a rotation lost before its persist still resolves to a real transcript', async () => {
  await reset();
  const { encodeCwd, findSessionLocation } = await import('../src/projects.ts');
  const cwd = path.join(process.env.PROJECTS_ROOT, 'crashy');
  const dir = path.join(process.env.CLAUDE_PROJECTS_ROOT, encodeCwd(cwd));
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(dir, { recursive: true });

  // The window: the CLI has already written the new transcript (it mints on
  // `/clear`, so the file exists before we ever see the system/init), and the
  // process dies before recordRotation lands. On disk the row still names only
  // the OLD segment.
  const first = 'dd00dd00-0000-4000-8000-000000000001';
  const publicId = await mintPublicId(first);
  const rotatedButUnrecorded = 'ee11ee11-0000-4000-8000-000000000002';
  for (const id of [first, rotatedButUnrecorded]) {
    await fs.writeFile(path.join(dir, `${id}.jsonl`), '{"type":"user","uuid":"u1"}\n');
  }

  // Recovery: the public id resolves to the last DURABLE segment — the pre-clear
  // transcript. That is the honest answer and it is a real, readable file; the
  // alternative (an unresolvable id) would strand the session entirely.
  assert.equal(await resolveBacking(publicId), first);
  assert.deepEqual(await findSessionLocation(publicId), { project: 'crashy', worktreeName: null });
  assert.equal(await publicIdFor(rotatedButUnrecorded), rotatedButUnrecorded,
    'the unrecorded segment is simply unknown — it never claims to belong');

  // The tail is not lost forever: the same write, replayed after recovery, is
  // idempotent and reattaches it in order.
  await recordRotation(publicId, rotatedButUnrecorded, 'renew');
  await recordRotation(publicId, rotatedButUnrecorded, 'renew');
  assert.deepEqual((await segmentsFor(publicId)).map(g => g.id), [first, rotatedButUnrecorded]);
  assert.equal(await resolveBacking(publicId), rotatedButUnrecorded);
});

test('loadLineage tolerates a malformed sidecar', async () => {
  await reset();
  await fs.mkdir(path.dirname(STORE_FILE()), { recursive: true });
  await fs.writeFile(STORE_FILE(), 'not json{');
  const { byPublic } = await loadLineage();
  assert.equal(byPublic.size, 0, 'garbage parses to an empty store, not a throw');
  // …but a MUTATION must refuse to clobber a store it could not read.
  await assert.rejects(() => recordRotation('somepub', 'somebacking', 'renew'));
  await fs.rm(STORE_FILE(), { force: true });
});

test('a row whose segments are all unparseable is dropped, not half-loaded', async () => {
  await reset();
  await fs.mkdir(path.dirname(STORE_FILE()), { recursive: true });
  await fs.writeFile(STORE_FILE(), JSON.stringify({
    sessions: {
      good: { current: 'x', segments: [{ id: 'x', reason: 'initial', at: '' }] },
      bad: { current: 'y', segments: [{ id: 'y', reason: 'not-a-reason', at: '' }] },
      alsoBad: { current: 'z' },
    },
  }));
  const { byPublic, byBacking } = await loadLineage();
  assert.deepEqual([...byPublic.keys()], ['good']);
  assert.deepEqual([...byBacking.keys()], ['x']);
  await fs.rm(STORE_FILE(), { force: true });
});
