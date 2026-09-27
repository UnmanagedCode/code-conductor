// Unit tests for src/sessionStore.ts: the write path's no-op precheck and loud
// failures, the stat-validated read cache, the sync read, `.bak` recovery, and
// the refusal of writes naming an unknown minted-shaped id.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-session-store-'));
process.env.PROJECTS_ROOT = path.join(tmp, 'projects');
// Read by storeLock.ts at module load: a held lock must fail fast here.
process.env.ORCH_STORE_LOCK_RETRY_MAX = '2';
process.env.ORCH_STORE_LOCK_RETRY_BASE_MS = '5';

const store = await import('../src/sessionStore.ts');
const {
  loadSessions, loadSessionsSync, mutateSessions, orphanedTempIdsSync,
  getTitle, setTitle, getSessionMode, setSessionMode, setSegmentTemp, isTemp, setSummary, getSummaries,
  setSessionBackend, getSessionBackend, markConducted, isConducted, setSegmentArchived, isArchived,
} = store;

let testNo = 0;
async function freshRoot() {
  const root = path.join(tmp, `root-${testNo++}`);
  await fs.mkdir(path.join(root, '.code-conductor'), { recursive: true });
  process.env.PROJECTS_ROOT = root;
  return root;
}
const storeFile = (root) => path.join(root, '.code-conductor', 'sessions.json');
const bakFile = (root) => storeFile(root) + '.bak';
const lockFile = (root) => storeFile(root) + '.lock';
async function readJson(f) { return JSON.parse(await fs.readFile(f, 'utf8')); }
async function listCorrupt(root) {
  return (await fs.readdir(path.join(root, '.code-conductor'))).filter(n => n.includes('.corrupt-'));
}
// A doc of base-case records, one per id; `archived` names ids whose segment is archived.
function doc(ids, { archived = [] } = {}) {
  const sessions = {};
  for (const id of ids) {
    sessions[id] = { current: id, segments: [{ id, reason: 'initial', at: '', ...(archived.includes(id) ? { archived: true } : {}) }] };
  }
  return JSON.stringify({ sessions });
}
// Captures console.warn for the duration of `fn`.
async function captureWarn(fn) {
  const lines = [];
  const orig = console.warn;
  console.warn = (...a) => { lines.push(a.join(' ')); };
  try { return { value: await fn(), lines }; }
  finally { console.warn = orig; }
}
async function holdLock(root) {
  await fs.writeFile(lockFile(root), JSON.stringify({ pid: process.pid, token: 'held-by-test' }));
}

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';

test('a no-op write takes no lock and writes nothing', async () => {
  const root = await freshRoot();
  assert.equal(await setSessionMode(A, 'plan'), true);
  const before = await fs.stat(storeFile(root), { bigint: true });
  await holdLock(root);
  try {
    // The recorded value: the precheck sees it in the cache and returns before
    // the (held) lock would have made it wait and fail.
    assert.equal(await setSessionMode(A, 'plan'), true);
    const after = await fs.stat(storeFile(root), { bigint: true });
    assert.equal(after.ino, before.ino, 'no rename happened');
    assert.equal(after.mtimeNs, before.mtimeNs, 'no write happened');
    // A real change needs the lock, so it fails — and says so.
    const { lines } = await captureWarn(() =>
      assert.rejects(setSessionMode(A, 'bypassPermissions'), /could not acquire/));
    assert.ok(lines.some(l => l.includes(`sessionStore: setSessionMode ${A} failed`)),
      `the failed acquisition is logged at the store boundary: ${JSON.stringify(lines)}`);
  } finally {
    await fs.rm(lockFile(root), { force: true });
  }
});

test('a failed write leaves the cache stale so the next call retries', async () => {
  const root = await freshRoot();
  await setSessionMode(A, 'plan');
  await holdLock(root);
  await captureWarn(() => assert.rejects(setSessionMode(A, 'bypassPermissions')));
  await fs.rm(lockFile(root), { force: true });
  // Had the failure updated the cache, this call's precheck would read
  // bypassPermissions and no-op — and the record would stay plan for good.
  assert.equal(await setSessionMode(A, 'bypassPermissions'), true);
  assert.equal((await readJson(storeFile(root))).sessions[A].mode, 'bypassPermissions');
  assert.equal(await getSessionMode(A), 'bypassPermissions');
});

test('an external rewrite invalidates the cache', async () => {
  const root = await freshRoot();
  await setTitle(A, 'first');
  assert.equal(await getTitle(A), 'first', 'the cache is primed');
  const before = await fs.stat(storeFile(root), { bigint: true });
  // Same-size content through a rename, the way every cc writer replaces the file.
  const next = await readJson(storeFile(root));
  next.sessions[A].title = 'other';
  const tmpFile = storeFile(root) + '.ext';
  await fs.writeFile(tmpFile, JSON.stringify(next, null, 2) + '\n');
  await fs.rename(tmpFile, storeFile(root));
  const after = await fs.stat(storeFile(root), { bigint: true });
  assert.notEqual(after.ino, before.ino, 'guard: the rename produced a new inode');
  assert.equal(await getTitle(A), 'other', 'the next read sees the external write');
});

test('loadSessionsSync reads the same doc, and falls back to .bak', async () => {
  const root = await freshRoot();
  await setTitle(A, 'alpha');
  await setSegmentTemp(B, true);
  const asyncIdx = await loadSessions();
  const syncIdx = loadSessionsSync();
  assert.deepEqual([...syncIdx.byPublic.entries()], [...asyncIdx.byPublic.entries()]);
  assert.deepEqual([...syncIdx.byBacking.entries()], [...asyncIdx.byBacking.entries()]);

  await fs.writeFile(storeFile(root), '{ "sessions": { '); // corrupt
  assert.equal(loadSessionsSync().byPublic.get(A)?.title, 'alpha', 'a corrupt primary serves .bak');
  await fs.rm(storeFile(root));
  assert.equal(loadSessionsSync().byPublic.get(A)?.title, 'alpha', 'a missing primary serves .bak');
});

test('orphanedTempIdsSync lists live temp segments with no live instance', async () => {
  const root = await freshRoot();
  const LIVE = 'dddddddd-0000-4000-8000-000000000004';
  await fs.writeFile(storeFile(root), JSON.stringify({ sessions: {
    [A]: { current: A, segments: [{ id: A, reason: 'initial', at: '', temp: true }] },
    [B]: { current: C, segments: [
      { id: B, reason: 'initial', at: '', temp: true, dropped: true },
      { id: C, reason: 'renew', at: '' },
    ] },
    [LIVE]: { current: LIVE, segments: [{ id: LIVE, reason: 'initial', at: '', temp: true }] },
  } }));
  assert.deepEqual(orphanedTempIdsSync([LIVE]), [A],
    'a dropped temp segment and a live instance\'s segment are not orphans');
});

test('corrupt primary is quarantined and recovered from .bak on mutation', async () => {
  const root = await freshRoot();
  await fs.writeFile(bakFile(root), doc([A, B]));
  await fs.writeFile(storeFile(root), '{ "sessions": { "a'); // truncated
  await captureWarn(() => setTitle(C, 'new'));
  assert.deepEqual(Object.keys((await readJson(storeFile(root))).sessions).sort(), [A, B, C]);
  assert.equal((await listCorrupt(root)).length, 1, 'the corrupt primary is set aside');
});

test('the read path serves .bak on a corrupt primary without quarantining', async () => {
  const root = await freshRoot();
  await fs.writeFile(bakFile(root), doc([A], { archived: [A] }));
  const corrupt = '{ "sessions": { "a';
  await fs.writeFile(storeFile(root), corrupt);
  const { value: idx } = await captureWarn(() => loadSessions());
  assert.deepEqual([...idx.byPublic.keys()], [A]);
  assert.equal((await listCorrupt(root)).length, 0, 'a read never quarantines');
  assert.equal(await fs.readFile(storeFile(root), 'utf8'), corrupt, 'a read never writes');
});

test('a missing primary recovers from .bak; missing both is legitimately empty', async () => {
  const root = await freshRoot();
  assert.equal((await loadSessions()).byPublic.size, 0, 'no primary, no .bak: empty');
  await fs.writeFile(bakFile(root), doc([A]));
  assert.ok((await loadSessions()).byPublic.has(A), 'the read recovers via .bak');
  await setTitle(B, 'b');
  assert.deepEqual(Object.keys((await readJson(storeFile(root))).sessions).sort(), [A, B],
    'the mutation recovers its base from .bak');
  assert.equal((await listCorrupt(root)).length, 0);
});

test('an emptied store is written as {"sessions":{}}, never unlinked', async () => {
  const root = await freshRoot();
  await setTitle(A, 'a');
  await mutateSessions('drop', A, (d) => { d.delete(A); return { changed: true, value: null }; });
  assert.deepEqual(await readJson(storeFile(root)), { sessions: {} });
});

test('the .bak refresh survives a single delete and refuses a two-record drop', async () => {
  const root = await freshRoot();
  const D = 'dddddddd-0000-4000-8000-000000000004';
  await setTitle(A, 'a'); await setTitle(B, 'b'); await setTitle(C, 'c'); await setTitle(D, 'd');
  await mutateSessions('drop', D, (d) => { d.delete(D); return { changed: true, value: null }; });
  assert.deepEqual(Object.keys((await readJson(bakFile(root))).sessions).sort(), [A, B, C],
    'a one-record delete refreshes .bak');
  // A wrongly-small base: the primary holds only one of .bak's three records.
  await fs.writeFile(storeFile(root), doc([A]));
  await setTitle(A, 'x');
  assert.deepEqual(Object.keys((await readJson(bakFile(root))).sessions).sort(), [A, B, C],
    'a write two records short of .bak leaves it alone');
});

test('the .bak refresh refuses a write that drops two archived segments', async () => {
  const root = await freshRoot();
  await fs.writeFile(storeFile(root), doc([A, B, C], { archived: [A, B] }));
  await setTitle(C, 'seed .bak');
  // Un-archive both behind the store's back, then write through it.
  await fs.writeFile(storeFile(root), doc([A, B, C]));
  await setTitle(C, 'next');
  const bak = (await readJson(bakFile(root))).sessions;
  assert.equal(bak[A].segments[0].archived, true, '.bak keeps the archived flags');
  assert.equal(bak[C].title, 'seed .bak');
});

test('an I/O error reading the primary aborts the mutation instead of reading as empty', async () => {
  // Unreadable (mode 000) but still replaceable by rename — so a mutation that
  // laundered the read error into an empty store would WRITE, and the primary's
  // records would be gone. Needs a non-root uid: root reads through mode 000.
  const root = await freshRoot();
  await setTitle(A, 'a');
  await fs.chmod(storeFile(root), 0o000);
  try {
    await captureWarn(() => assert.rejects(setTitle(B, 'b'), { code: 'EACCES' }));
  } finally {
    await fs.chmod(storeFile(root), 0o644);
  }
  const { sessions } = await readJson(storeFile(root));
  assert.deepEqual(Object.keys(sessions), [A], 'the primary still holds its records, and only them');
  assert.equal(sessions[A].title, 'a');
});

test('an in-place rewrite that keeps inode, size and mtime is still seen (ctime)', async () => {
  const root = await freshRoot();
  const f = storeFile(root);
  const T = new Date('2026-01-01T00:00:00Z'); // whole seconds: utimes restores it exactly
  await setTitle(A, 'first');
  await fs.utimes(f, T, T);
  assert.equal(await getTitle(A), 'first', 'the cache is primed');
  const primed = await fs.stat(f, { bigint: true });
  const next = (await fs.readFile(f, 'utf8')).replace('"first"', '"other"');
  // ctime ticks at the filesystem's timestamp granularity: rewrite until it moves.
  let after;
  for (let i = 0; i < 50; i++) {
    await fs.writeFile(f, next); // in place: same inode
    await fs.utimes(f, T, T);
    after = await fs.stat(f, { bigint: true });
    if (after.ctimeNs !== primed.ctimeNs) break;
    await new Promise(r => setTimeout(r, 2));
  }
  assert.equal(after.ino, primed.ino, 'guard: same inode');
  assert.equal(after.size, primed.size, 'guard: same size');
  assert.equal(after.mtimeNs, primed.mtimeNs, 'guard: mtime restored');
  assert.notEqual(after.ctimeNs, primed.ctimeNs, 'guard: only ctime moved');
  assert.equal(await getTitle(A), 'other', 'the ctime component invalidates the cache');
});

test('a session-level write for an unknown minted-shaped id is refused', async () => {
  const root = await freshRoot();
  const { value, lines } = await captureWarn(() => setTitle('abcdef12', 'phantom'));
  assert.equal(value, null);
  assert.ok(lines.some(l => l.includes('setTitle abcdef12 refused')), JSON.stringify(lines));
  await assert.rejects(fs.stat(storeFile(root)), { code: 'ENOENT' }, 'no record was written');
  const r2 = await captureWarn(() => setSummary('abcdef12-0a0b', 'short', { summary: 's' }));
  assert.equal(r2.value, null);
  assert.deepEqual(await getSummaries('abcdef12-0a0b'), {});
});

test('a segment write on an unknown non-minted id creates its base-case record', async () => {
  await freshRoot();
  assert.equal(await setSegmentTemp(A, true), true);
  const rec = (await loadSessions()).byPublic.get(A);
  assert.equal(rec.current, A);
  assert.deepEqual(rec.segments.map(s => [s.id, s.reason, s.temp]), [[A, 'initial', true]]);
  assert.equal(await isTemp(A), true);
  // A session-level write naming the same id lands on that record, not a second one.
  await setTitle(A, 't');
  assert.deepEqual([...(await loadSessions()).byPublic.keys()], [A]);
});

test('a segment write naming an owner that lacks the segment is refused', async () => {
  const root = await freshRoot();
  await setTitle(A, 'owner');
  const { value, lines } = await captureWarn(() => setSegmentTemp(B, true, { owner: A }));
  assert.equal(value, false);
  assert.ok(lines.some(l => l.includes(`setSegmentTemp ${B} refused`)), JSON.stringify(lines));
  assert.deepEqual(Object.keys((await readJson(storeFile(root))).sessions), [A], 'no stray record for B');
});

test('a segment write after a kicked rotation lands on the new segment', async () => {
  const root = await freshRoot();
  const { recordRotation, trackLineageWrite } = await import('../src/sessionLineage.ts');
  await setTitle(A, 'owner');
  // A rotation write kicked but not yet landed, as Instance._kickLineageWrite
  // leaves it between `system/init` and the store write.
  let release;
  const gate = new Promise((r) => { release = r; });
  trackLineageWrite(gate.then(() => recordRotation(A, B, 'renew')));
  const write = setSegmentTemp(B, true, { owner: A });
  release();
  assert.equal(await write, true);
  const sessions = (await readJson(storeFile(root))).sessions;
  assert.deepEqual(Object.keys(sessions), [A], 'no stray base-case record for the new id');
  assert.equal(sessions[A].segments.find(s => s.id === B)?.temp, true, 'the flag is on the recorded segment');
});

test('session facts and segment flags round-trip in the documented shape', async () => {
  const root = await freshRoot();
  await setTitle(A, '  A title  ');
  await setSessionMode(A, 'plan');
  await setSessionBackend(A, 'ollama');
  await markConducted(A, { parent: 'cafe0123', project: 'p', worktree: 'wt' });
  await setSummary(A, 'short', { summary: 'sum', generatedAt: 7, messageCount: 3 });
  await setSegmentTemp(A, true);
  await setSegmentArchived(A, true);
  const rec = (await readJson(storeFile(root))).sessions[A];
  assert.equal(typeof rec.segments[0].at, 'string');
  delete rec.segments[0].at;
  assert.deepEqual(rec, {
    current: A,
    segments: [{ id: A, reason: 'initial', temp: true, archived: true }],
    title: 'A title',
    mode: 'plan',
    backend: { backend: 'ollama', model: null, contextWindowTokens: null },
    summaries: { short: { summary: 'sum', generatedAt: 7, messageCount: 3 } },
    conducted: true, parent: 'cafe0123', project: 'p', worktree: 'wt',
  });
  assert.equal(await getTitle(A), 'A title');
  assert.equal(await getSessionMode(A), 'plan');
  assert.deepEqual(await getSessionBackend(A), { backend: 'ollama', model: null, contextWindowTokens: null });
  assert.equal(await isConducted(A), true);
  assert.equal(await isTemp(A), true);
  assert.equal(await isArchived(A), true);
  assert.equal(await isTemp(B), false, 'an unknown id carries no flag');
  assert.equal(await getSessionBackend(B), null, 'absence means the claude backend');
});

test('a segment id reads and writes its session\'s facts', async () => {
  const root = await freshRoot();
  const { recordRotation } = await import('../src/sessionLineage.ts');
  await setTitle(A, 'session title');
  await recordRotation(A, B, 'renew');
  assert.equal(await getTitle(B), 'session title', 'a segment id reads the session-level fact');
  await setSessionMode(B, 'plan');
  const sessions = (await readJson(storeFile(root))).sessions;
  assert.deepEqual(Object.keys(sessions), [A], 'no second record for the segment id');
  assert.equal(sessions[A].mode, 'plan');
});

test('markConducted patches its extras and never clears one with null', async () => {
  const root = await freshRoot();
  await markConducted(A, { parent: 'cafe0123', project: 'p', worktree: 'wt' });
  await markConducted(A, { parent: null, project: null, worktree: null });
  await markConducted(A);
  const rec = (await readJson(storeFile(root))).sessions[A];
  assert.deepEqual([rec.parent, rec.project, rec.worktree], ['cafe0123', 'p', 'wt']);
  await markConducted(A, { project: 'q' });
  assert.equal((await readJson(storeFile(root))).sessions[A].project, 'q');
});

test('guards: an empty id, empty backend, or unknown mode refuse and store nothing', async () => {
  const root = await freshRoot();
  assert.equal(await setSessionBackend('', 'ollama'), false);
  assert.equal(await setSessionBackend(A, ''), false);
  assert.equal(await setSessionMode(A, 'default'), false);
  assert.equal(await setSessionMode('', 'plan'), false);
  assert.equal(await setTitle('', 't'), null);
  assert.equal(await setSegmentTemp('', true), false);
  assert.equal(await setSummary(A, 'huge', { summary: 's' }), null);
  await assert.rejects(fs.stat(storeFile(root)), { code: 'ENOENT' }, 'nothing was written');
});

test('an on-disk value outside the schema is dropped, not trusted', async () => {
  const root = await freshRoot();
  await fs.writeFile(storeFile(root), JSON.stringify({ sessions: {
    [A]: { current: A, segments: [{ id: A, reason: 'initial', at: '', temp: 'yes' }],
      mode: 'default', backend: { backend: '' }, title: '   ', conducted: 'true' },
    [B]: { current: B, segments: [{ id: B, reason: 'bogus', at: '' }] },
  } }));
  const idx = await loadSessions();
  assert.deepEqual([...idx.byPublic.keys()], [A], 'a record with no valid segment is dropped');
  assert.deepEqual(idx.byPublic.get(A), { current: A, segments: [{ id: A, reason: 'initial', at: '' }] },
    'every malformed fact is dropped');
});
