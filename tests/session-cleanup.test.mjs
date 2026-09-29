// Integration tests for src/sessionCleanup.ts: the boot pass that removes a
// session record once no segment of its lineage has a transcript on disk, its
// every-boot pre-image snapshot, and every rule that keeps a record instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-session-cleanup-'));
process.env.PROJECTS_ROOT = path.join(tmp, 'projects');
process.env.CLAUDE_PROJECTS_ROOT = path.join(tmp, 'claude-projects');

const { cleanupSessionsWithoutTranscripts, CLEANUP_GRACE_MS } = await import('../src/sessionCleanup.ts');
const { setTitle } = await import('../src/sessionStore.ts');
const { sessionFilePath, localPlace, claudeConfigFarmRoot, encodeCwd } = await import('../src/projects.ts');

const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const OLD = '2025-01-01T00:00:00.000Z';
const CWD = '/work/demo';

let testNo = 0;
// A fresh store root and CLI transcript root per test.
async function fresh() {
  const root = path.join(tmp, `root-${testNo++}`);
  const store = path.join(root, '.code-conductor');
  const claude = path.join(root, 'claude-projects');
  await fs.mkdir(store, { recursive: true });
  await fs.mkdir(claude, { recursive: true });
  process.env.PROJECTS_ROOT = root;
  process.env.CLAUDE_PROJECTS_ROOT = claude;
  return {
    root, store, claude,
    primary: path.join(store, 'sessions.json'),
    bak: path.join(store, 'sessions.json.bak'),
    snapshot: path.join(store, 'sessions.json.startup.bak'),
    manifest: path.join(store, 'pending-resume.json'),
  };
}

const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const seg = (id, extra = {}) => ({ id, reason: 'initial', at: OLD, ...extra });

// Raw store write, tmp + rename (the store's read cache keys on the inode).
async function writeStore(f, sessions) {
  const tmpFile = `${f.primary}.test-tmp`;
  await fs.writeFile(tmpFile, JSON.stringify({ sessions }, null, 2) + '\n');
  await fs.rename(tmpFile, f.primary);
}
async function readSessions(f) { return JSON.parse(await fs.readFile(f.primary, 'utf8')).sessions; }
async function seedLocal(id) {
  const file = sessionFilePath(localPlace(CWD), id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{"type":"user"}\n');
}
async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}
function captureLog() {
  const lines = [];
  return {
    lines,
    log: { log: (...a) => lines.push(['log', a.join(' ')]), warn: (...a) => lines.push(['warn', a.join(' ')]) },
    warns: () => lines.filter(([k]) => k === 'warn').map(([, l]) => l),
  };
}
// A record kept alive by a seeded transcript: beside it, a dead record is never
// the whole store, so the mass-wipe guard is not what decides the test.
const LIVE_ID = uuid(9999);
async function liveCompanion() {
  await seedLocal(LIVE_ID);
  return { '99999999': { current: LIVE_ID, segments: [seg(LIVE_ID)] } };
}
const run = (cap, now = NOW) => cleanupSessionsWithoutTranscripts({ log: cap.log, now: () => now });

test('a record none of whose segments has a transcript is removed; the others are untouched', async () => {
  // Invariant: removal requires every segment of the chain to be absent, and only that record goes.
  const f = await fresh();
  const [a1, a2, b1] = [uuid(1), uuid(2), uuid(3)];
  const sessions = {
    aaaaaaaa: { current: a2, segments: [seg(a1, { archived: true }), { id: a2, reason: 'renew', at: OLD }], title: 'gone' },
    bbbbbbbb: { current: b1, segments: [seg(b1)], title: 'kept', mode: 'plan' },
  };
  await writeStore(f, sessions);
  await seedLocal(b1);
  const cap = captureLog();
  const r = await run(cap);
  assert.deepEqual(r.removed, ['aaaaaaaa']);
  const after = await readSessions(f);
  assert.deepEqual(Object.keys(after), ['bbbbbbbb']);
  assert.deepEqual(after.bbbbbbbb, sessions.bbbbbbbb);
  assert.ok(cap.lines.some(([k, l]) => k === 'log' && l.includes('removed 1 session record(s)') && l.includes('aaaaaaaa')),
    JSON.stringify(cap.lines));
});

test('a transcript for any one lineage member keeps the record', async (t) => {
  // Invariant: presence is checked over the FULL chain — a non-head archived segment and a tombstone both count.
  await t.test('an older, non-head archived segment', async () => {
    const f = await fresh();
    const [x1, x2] = [uuid(11), uuid(12)];
    await writeStore(f, { cccccccc: { current: x2, segments: [seg(x1, { archived: true }), { id: x2, reason: 'renew', at: OLD }] } });
    await seedLocal(x1);
    const r = await run(captureLog());
    assert.deepEqual(r.removed, []);
    assert.ok((await readSessions(f)).cccccccc);
  });
  await t.test('a tombstoned segment', async () => {
    const f = await fresh();
    const [x1, x2] = [uuid(13), uuid(14)];
    await writeStore(f, { dddddddd: { current: x2, segments: [seg(x1, { dropped: true }), { id: x2, reason: 'renew', at: OLD }] } });
    await seedLocal(x1);
    const r = await run(captureLog());
    assert.deepEqual(r.removed, []);
    assert.ok((await readSessions(f)).dddddddd);
  });
});

test('when nothing is removed the primary is not rewritten', async () => {
  // Invariant: a pass with nothing to remove performs no store write.
  const f = await fresh();
  const [x1, x2] = [uuid(21), uuid(22)];
  await writeStore(f, { eeeeeeee: { current: x2, segments: [seg(x1), { id: x2, reason: 'renew', at: OLD }] } });
  await seedLocal(x1);
  await seedLocal(x2);
  const before = await fs.stat(f.primary, { bigint: true });
  const r = await run(captureLog());
  assert.deepEqual(r.removed, []);
  const after = await fs.stat(f.primary, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
});

test('every run writes the byte-exact pre-image to sessions.json.startup.bak, overwriting the last one', async () => {
  // Invariant: the snapshot is the primary's bytes as read at the start of THIS run, including a run that removes nothing.
  const f = await fresh();
  const [k1, g1] = [uuid(31), uuid(32)];
  await writeStore(f, {
    kkkkkkkk: { current: k1, segments: [seg(k1)] },
    gggggggg: { current: g1, segments: [seg(g1)] },
  });
  await seedLocal(k1);
  const preRun1 = await fs.readFile(f.primary);
  const r1 = await run(captureLog());
  assert.deepEqual(r1.removed, ['gggggggg']);
  assert.deepEqual(await fs.readFile(f.snapshot), preRun1);

  const postRun1 = await fs.readFile(f.primary);
  assert.notDeepEqual(postRun1, preRun1);
  const r2 = await run(captureLog());
  assert.deepEqual(r2.removed, []);
  assert.deepEqual(await fs.readFile(f.snapshot), postRun1);
});

test('a snapshot that cannot be written stops the pass before the store changes', async () => {
  // Invariant: no record is removed unless its pre-image was captured first.
  const f = await fresh();
  const g1 = uuid(41);
  await writeStore(f, { ...(await liveCompanion()), gggggggg: { current: g1, segments: [seg(g1)] } });
  await fs.mkdir(path.join(f.snapshot, 'occupied'), { recursive: true });
  const before = await fs.readFile(f.primary);
  const cap = captureLog();
  const r = await run(cap);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(await fs.readFile(f.primary), before);
  assert.ok(cap.warns().some(l => l.includes('session-cleanup')), JSON.stringify(cap.lines));
});

test('fail-safe: an unresolvable lineage keeps the record', async () => {
  // Invariant: a segment id that is not a valid transcript filename (isSessionId) is never judged absent.
  const f = await fresh();
  await writeStore(f, {
    hhhhhhhh: { current: uuid(51), segments: [seg('../escape'), { id: uuid(51), reason: 'renew', at: OLD }] },
  });
  const cap = captureLog();
  const r = await run(cap);
  assert.deepEqual(r.removed, []);
  assert.ok((await readSessions(f)).hhhhhhhh);
  assert.ok(cap.warns().some(l => l.includes('hhhhhhhh')), JSON.stringify(cap.lines));
});

test('fail-safe: an absent CLI transcript root removes nothing but still snapshots', async () => {
  // Invariant: a missing claudeProjectsRoot() never reads as "every transcript is gone".
  const f = await fresh();
  await fs.rm(f.claude, { recursive: true });
  const g1 = uuid(61);
  await writeStore(f, { gggggggg: { current: g1, segments: [seg(g1)] } });
  const before = await fs.readFile(f.primary);
  const cap = captureLog();
  const r = await run(cap);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(await fs.readFile(f.primary), before);
  assert.deepEqual(await fs.readFile(f.snapshot), before);
  assert.ok(cap.warns().some(l => l.includes('transcript scan failed')), JSON.stringify(cap.lines));
});

test('fail-safe: a transcript root that cannot be read removes nothing', async () => {
  // Invariant: a non-ENOENT scan error aborts the removal, not just the unreadable root.
  const f = await fresh();
  await fs.rm(f.claude, { recursive: true });
  await fs.writeFile(f.claude, 'not a directory');
  const g1 = uuid(71);
  await writeStore(f, { gggggggg: { current: g1, segments: [seg(g1)] } });
  const before = await fs.readFile(f.primary);
  const cap = captureLog();
  const r = await run(cap);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(await fs.readFile(f.primary), before);
  assert.ok(cap.warns().some(l => l.includes('transcript scan failed')), JSON.stringify(cap.lines));
});

test('fail-safe: a corrupt primary is left in place, unquarantined, and snapshotted', async () => {
  // Invariant: the pass never quarantines or rewrites a store it cannot parse; its bytes go to the snapshot.
  const f = await fresh();
  await fs.writeFile(f.primary, '{"sessions": {broken');
  const cap = captureLog();
  const r = await run(cap);
  assert.deepEqual(r.removed, []);
  assert.ok(r.skipped);
  assert.equal(await fs.readFile(f.primary, 'utf8'), '{"sessions": {broken');
  assert.deepEqual((await fs.readdir(f.store)).filter(n => n.includes('.corrupt-')), []);
  assert.equal(await fs.readFile(f.snapshot, 'utf8'), '{"sessions": {broken');
});

test('fail-safe: an absent store is skipped and writes nothing', async () => {
  // Invariant: no primary means no snapshot and no primary created.
  const f = await fresh();
  const r = await run(captureLog());
  assert.deepEqual(r.removed, []);
  assert.ok(r.skipped);
  assert.equal(await exists(f.primary), false);
  assert.equal(await exists(f.snapshot), false);
});

test('sessions named by the resume manifest are kept, and the manifest is left for restore', async (t) => {
  // Invariant: a session about to be resumed (entry sessionId, conductor workers[], by public OR segment id) is never removed.
  const f = await fresh();
  const [p1, p2, p3, p4] = [uuid(81), uuid(82), uuid(83), uuid(84)];
  await writeStore(f, {
    '11111111': { current: p1, segments: [seg(p1)] },
    '22222222': { current: p2, segments: [seg(p2)] },
    '33333333': { current: p3, segments: [seg(p3)] },
    '44444444': { current: p4, segments: [seg(p4)] },
  });
  const manifest = JSON.stringify({
    writtenAt: OLD,
    instances: [
      { sessionId: '11111111', group: 'other' },
      { sessionId: 'cafecafe', group: 'conductor', workers: [{ project: 'p', sessionId: '22222222', worktreeName: null }] },
      { sessionId: p3, group: 'other' },
    ],
  });
  await fs.writeFile(f.manifest, manifest);
  const r = await run(captureLog());
  const after = await readSessions(f);
  await t.test('an entry naming the public id', () => assert.ok(after['11111111']));
  await t.test('a conductor entry\'s worker', () => assert.ok(after['22222222']));
  await t.test('an entry naming a segment id', () => assert.ok(after['33333333']));
  await t.test('an unnamed record in the same run is removed', () => assert.deepEqual(r.removed, ['44444444']));
  await t.test('the manifest is untouched', async () => assert.equal(await fs.readFile(f.manifest, 'utf8'), manifest));
});

test('a record whose newest segment is within the grace window is kept', async (t) => {
  // Invariant: removal needs the NEWEST segment's `at` to be at least CLEANUP_GRACE_MS old; an unparseable `at` is old.
  const T = Date.parse('2026-05-01T00:00:00.000Z');
  const rec = (n) => ({ current: uuid(n + 1), segments: [seg(uuid(n)), { id: uuid(n + 1), reason: 'renew', at: new Date(T).toISOString() }] });
  await t.test('just inside the window', async () => {
    const f = await fresh();
    await writeStore(f, { ...(await liveCompanion()), ffffffff: rec(91) });
    assert.deepEqual((await run(captureLog(), T + CLEANUP_GRACE_MS - 1)).removed, []);
  });
  await t.test('just past the window', async () => {
    const f = await fresh();
    await writeStore(f, { ...(await liveCompanion()), ffffffff: rec(93) });
    assert.deepEqual((await run(captureLog(), T + CLEANUP_GRACE_MS + 1)).removed, ['ffffffff']);
  });
  await t.test('an unparseable at counts as old', async () => {
    const f = await fresh();
    const x = uuid(95);
    await writeStore(f, { ...(await liveCompanion()), ffffffff: { current: x, segments: [{ id: x, reason: 'initial', at: '' }] } });
    assert.deepEqual((await run(captureLog(), T)).removed, ['ffffffff']);
  });
});

test('a transcript in an unregistered remote\'s config farm keeps the record', async () => {
  // Invariant: the scan covers every <store>/claude-config/<dir>/.claude/projects on disk, not only registered remotes'.
  const f = await fresh();
  const x = uuid(101);
  await writeStore(f, { rrrrrrrr: { current: x, segments: [seg(x)] } });
  const dir = path.join(claudeConfigFarmRoot(), 'box-abc123', '.claude', 'projects', encodeCwd('/root/app'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, path.basename(sessionFilePath(localPlace('/x'), x))), '{}\n');
  const r = await run(captureLog());
  assert.deepEqual(r.removed, []);
  assert.ok((await readSessions(f)).rrrrrrrr);
});

test('the rolling sessions.json.bak keeps refreshing after a bulk removal', async () => {
  // Invariant: the removal's own drop is tolerated by the .bak guard, so neither this write nor later ones freeze it.
  const f = await fresh();
  const ids = [uuid(111), uuid(112), uuid(113), uuid(114)];
  const sessions = {
    'a1111111': { current: ids[0], segments: [seg(ids[0], { archived: true })] },
    'a2222222': { current: ids[1], segments: [seg(ids[1], { archived: true })] },
    'a3333333': { current: ids[2], segments: [seg(ids[2])] },
    'a4444444': { current: ids[3], segments: [seg(ids[3])] },
  };
  await writeStore(f, sessions);
  await fs.copyFile(f.primary, f.bak);
  await seedLocal(ids[3]);
  const r = await run(captureLog());
  assert.deepEqual(r.removed.sort(), ['a1111111', 'a2222222', 'a3333333']);
  assert.deepEqual(await fs.readFile(f.bak, 'utf8'), await fs.readFile(f.primary, 'utf8'), 'the removal itself refreshed .bak');
  assert.equal(await setTitle('a4444444', 'after cleanup'), 'after cleanup');
  assert.deepEqual(await fs.readFile(f.bak, 'utf8'), await fs.readFile(f.primary, 'utf8'), 'a later write refreshed .bak');
  assert.equal(JSON.parse(await fs.readFile(f.bak, 'utf8')).sessions.a4444444.title, 'after cleanup');
});

test('fail-safe: an empty resolved transcript root removes nothing', async () => {
  // Invariant: a root that exists but holds no transcripts (a changed CLAUDE_CONFIG_DIR) never wipes the store.
  const f = await fresh();
  const [x1, x2] = [uuid(121), uuid(122)];
  await writeStore(f, {
    'b1111111': { current: x1, segments: [seg(x1)] },
    'b2222222': { current: x2, segments: [seg(x2)] },
  });
  const before = await fs.readFile(f.primary);
  const cap = captureLog();
  const r = await run(cap);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(await fs.readFile(f.primary), before);
  assert.ok(cap.warns().some(l => l.includes('refusing to wipe the store')), JSON.stringify(cap.lines));
});

test('fail-safe: a dangling-symlink encoded dir is a scan failure', async () => {
  // Invariant: an encoded-cwd entry that is a symlink or directory but cannot be read aborts the removal.
  const f = await fresh();
  const d1 = uuid(131);
  await writeStore(f, { ...(await liveCompanion()), dddddddd: { current: d1, segments: [seg(d1)] } });
  await fs.symlink(path.join(f.root, 'unmounted-volume'), path.join(f.claude, '-mnt-volume-proj'));
  const before = await fs.readFile(f.primary);
  const cap = captureLog();
  const r = await run(cap);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(await fs.readFile(f.primary), before);
  assert.ok(cap.warns().some(l => l.includes('transcript scan failed')), JSON.stringify(cap.lines));
});

test('a plain file among the encoded dirs is skipped and the scan still judges', async () => {
  // Invariant: a non-directory, non-symlink entry in a transcript root neither aborts the scan nor counts as a transcript.
  const f = await fresh();
  const d1 = uuid(141);
  await writeStore(f, { ...(await liveCompanion()), dddddddd: { current: d1, segments: [seg(d1)] } });
  await fs.writeFile(path.join(f.claude, '.DS_Store'), 'x');
  const r = await run(captureLog());
  assert.deepEqual(r.removed, ['dddddddd']);
  assert.ok((await readSessions(f))['99999999']);
});

test('a stray file directly under the config farm does not disable the pass', async () => {
  // Invariant: the farm root contributes directories only; a non-directory entry there is ignored.
  const f = await fresh();
  const d1 = uuid(151);
  await writeStore(f, { ...(await liveCompanion()), dddddddd: { current: d1, segments: [seg(d1)] } });
  await fs.mkdir(claudeConfigFarmRoot(), { recursive: true });
  await fs.writeFile(path.join(claudeConfigFarmRoot(), 'stray.txt'), 'x');
  const cap = captureLog();
  const r = await run(cap);
  assert.deepEqual(r.removed, ['dddddddd'], JSON.stringify(cap.lines));
});

test('mass-wipe guard: a pick naming every record removes nothing', async (t) => {
  // Invariant: the pass never removes every record of a non-empty store; a partial pick still removes.
  await t.test('only dead records → nothing removed, warned, snapshot written', async () => {
    const f = await fresh();
    const [x1, x2] = [uuid(161), uuid(162)];
    await seedLocal(uuid(163)); // the root is non-empty: the guard, not an empty scan, is under test
    await writeStore(f, {
      'c1111111': { current: x1, segments: [seg(x1)] },
      'c2222222': { current: x2, segments: [seg(x2)] },
    });
    const before = await fs.readFile(f.primary);
    const cap = captureLog();
    const r = await run(cap);
    assert.deepEqual(r.removed, []);
    assert.deepEqual(await fs.readFile(f.primary), before);
    assert.deepEqual(await fs.readFile(f.snapshot), before);
    assert.ok(cap.warns().some(l => l.includes('every record looks transcript-less')), JSON.stringify(cap.lines));
  });
  await t.test('one live, one dead → the dead one is removed', async () => {
    const f = await fresh();
    const x1 = uuid(164);
    await writeStore(f, { ...(await liveCompanion()), 'c1111111': { current: x1, segments: [seg(x1)] } });
    const r = await run(captureLog());
    assert.deepEqual(r.removed, ['c1111111']);
  });
});
