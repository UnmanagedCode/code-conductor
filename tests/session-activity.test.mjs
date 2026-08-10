// Session recency comes off the transcript's CONTENT, not its mtime.
//
// The defect these pin: the Claude CLI appends untimestamped bookkeeping
// records (`last-prompt`, `mode`, `ai-title`, `queue-operation`) as its process
// exits, so when a batch of live subprocesses dies together the whole batch's
// transcripts get an mtime within milliseconds of each other — hours or days
// after those sessions actually stopped. Sorting on mtime then sorts on noise.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLastActivityCache, TAIL_BYTES } from '../src/sessionActivity.ts';
import { encodeCwd, listSessionsForCwd, summarizeSessions } from '../src/projects.ts';

async function withTmp(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-activity-'));
  try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

// A transcript with one real (timestamped) record, then the untimestamped
// bookkeeping tail the CLI writes on exit — the exact shape observed in the
// wild — with its mtime forced to `mtimeMs` to stand in for a mass exit.
async function writeTranscript(file, { timestamp, mtimeMs, tail = true }) {
  const lines = [
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp, message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp, message: { role: 'assistant', content: [] } }),
  ];
  if (tail) {
    lines.push(JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: 'x' }));
    lines.push(JSON.stringify({ type: 'last-prompt', lastPrompt: 'hi', leafUuid: 'a1', sessionId: 'x' }));
  }
  await fs.writeFile(file, lines.join('\n') + '\n');
  if (mtimeMs !== undefined) {
    await fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs));
  }
}

// Pins: lastActivity is the timestamp on the LAST timestamped record in the
// file, NOT the file's mtime, when the tail is untimestamped bookkeeping.
test('lastActivity reads the last timestamped record IN the transcript, not its mtime', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 's.jsonl');
    const realActivity = Date.parse('2026-08-07T06:10:51.000Z');
    const bogusMtime = Date.parse('2026-08-09T09:12:40.000Z');
    await writeTranscript(file, { timestamp: '2026-08-07T06:10:51.000Z', mtimeMs: bogusMtime });

    const cache = createLastActivityCache();
    const got = await cache.lastActivityOf(file, await fs.stat(file));
    assert.equal(got, realActivity);
    assert.notEqual(got, bogusMtime, 'the mass-exit mtime must not be the answer');
  });
});

// Pins that the read is of the TAIL, on a file that is actually longer than
// the window — the arithmetic (`size - len`) every other fixture here leaves
// unobserved, because a handful of short lines makes `len === size` and the
// offset 0 either way. 80% of a real transcript population exceeds TAIL_BYTES,
// and reading the head there would report the session's START time: the exact
// wrong-ordering defect this module exists to remove.
test('lastActivity reads the TAIL of a transcript larger than the window', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 's.jsonl');
    const startedAt = Date.parse('2026-08-01T00:00:00.000Z');
    const endedAt = Date.parse('2026-08-08T22:27:10.000Z');

    // Head: the session's FIRST real record — what a head read would return.
    const lines = [JSON.stringify({
      type: 'user', uuid: 'u1', timestamp: '2026-08-01T00:00:00.000Z',
      message: { role: 'user', content: 'hi' },
    })];
    // Filler carrying no timestamp of its own, so the only two candidate
    // answers in the whole file are the head record and the tail record.
    const filler = JSON.stringify({ type: 'filler', pad: 'x'.repeat(2048) });
    while (lines.join('\n').length < TAIL_BYTES * 2) lines.push(filler);
    // Tail: the last real record, then the untimestamped bookkeeping the CLI
    // appends on exit.
    lines.push(JSON.stringify({
      type: 'assistant', uuid: 'a1', timestamp: '2026-08-08T22:27:10.000Z',
      message: { role: 'assistant', content: [] },
    }));
    lines.push(JSON.stringify({ type: 'last-prompt', lastPrompt: 'hi', leafUuid: 'a1', sessionId: 'x' }));
    await fs.writeFile(file, lines.join('\n') + '\n');

    const st = await fs.stat(file);
    assert.ok(st.size > TAIL_BYTES,
      `fixture must exceed the ${TAIL_BYTES}-byte window for this test to mean anything`);

    const cache = createLastActivityCache();
    const got = await cache.lastActivityOf(file, st);
    assert.equal(got, endedAt);
    assert.notEqual(got, startedAt,
      'reading the head instead of the tail would report when the session STARTED');
  });
});

// Pins the sub-property the module header claims for the pathological case: a
// record LONGER than the window degrades to mtime — today's value — rather
// than the reader growing into a whole-file scan. The tail here holds nothing
// but an unparseable fragment of that one giant record.
test('a record longer than the window falls back to mtime, not a whole-file read', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 's.jsonl');
    const mtimeMs = Date.parse('2026-08-09T09:12:40.000Z');
    const earlier = Date.parse('2026-08-07T06:10:51.000Z');

    await fs.writeFile(file, [
      // A parseable record, but pushed out of the window by the one below it.
      JSON.stringify({
        type: 'user', uuid: 'u1', timestamp: '2026-08-07T06:10:51.000Z',
        message: { role: 'user', content: 'hi' },
      }),
      // One record, on one line, longer than the whole window.
      JSON.stringify({
        type: 'user', uuid: 'u2', timestamp: '2026-08-08T22:27:10.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'y'.repeat(TAIL_BYTES * 2) }] },
      }),
    ].join('\n') + '\n');
    await fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs));

    const st = await fs.stat(file);
    const cache = createLastActivityCache();
    const got = await cache.lastActivityOf(file, st);
    assert.equal(got, st.mtimeMs, 'the pathological case degrades to current behaviour');
    assert.notEqual(got, earlier, 'it must not scan back past the window to find one');
    assert.notEqual(got, Date.parse('2026-08-08T22:27:10.000Z'),
      'the giant record itself is unreachable — its head is outside the window');
  });
});

// Pins: the fallback. A transcript with no timestamped record at all still
// reports SOMETHING ordered — today's mtime — rather than 0/null, which would
// sink every such session to the bottom of the list.
test('lastActivity falls back to mtime when no record carries a timestamp', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 's.jsonl');
    await fs.writeFile(file, JSON.stringify({ type: 'last-prompt', leafUuid: 'a1' }) + '\n');
    const mtimeMs = Date.parse('2026-08-09T09:12:40.000Z');
    await fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs));

    const cache = createLastActivityCache();
    const st = await fs.stat(file);
    assert.equal(await cache.lastActivityOf(file, st), st.mtimeMs);
  });
});

// Pins THE CARD'S DEFECT end to end: two sessions where mtime order and real
// activity order disagree must list in real-activity order.
test('listSessionsForCwd orders on real activity, not on a mass-exit mtime', async () => {
  await withTmp(async (tmp) => {
    const claudeProjects = path.join(tmp, '.claude', 'projects');
    const prev = process.env.CLAUDE_PROJECTS_ROOT;
    process.env.CLAUDE_PROJECTS_ROOT = claudeProjects;
    try {
      const cwd = path.join(tmp, 'proj');
      const dir = path.join(claudeProjects, encodeCwd(cwd));
      await fs.mkdir(dir, { recursive: true });

      const newer = '11111111-1111-4111-8111-111111111111';
      const older = '22222222-2222-4222-8222-222222222222';
      // `newer` really ran last, but `older`'s file was touched later — the
      // observed shape, where a mass subprocess exit re-stamps a stale file.
      await writeTranscript(path.join(dir, `${newer}.jsonl`), {
        timestamp: '2026-08-08T22:27:10.000Z', mtimeMs: Date.parse('2026-08-09T09:12:40.700Z'),
      });
      await writeTranscript(path.join(dir, `${older}.jsonl`), {
        timestamp: '2026-08-07T06:10:51.000Z', mtimeMs: Date.parse('2026-08-09T09:12:40.800Z'),
      });

      const rows = await listSessionsForCwd(cwd);
      assert.deepEqual(rows.map(r => r.sessionId), [newer, older],
        'the session that actually ran last must lead');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
      else process.env.CLAUDE_PROJECTS_ROOT = prev;
    }
  });
});

// Pins the mtime+size half of the cache key: the ordinary append.
test('an appended record invalidates the memoized value', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 's.jsonl');
    await writeTranscript(file, { timestamp: '2026-08-07T06:10:51.000Z', tail: false });
    const cache = createLastActivityCache();
    assert.equal(await cache.lastActivityOf(file, await fs.stat(file)),
      Date.parse('2026-08-07T06:10:51.000Z'));

    await fs.appendFile(file, JSON.stringify({
      type: 'assistant', uuid: 'a2', timestamp: '2026-08-08T22:27:10.000Z', message: {},
    }) + '\n');
    assert.equal(await cache.lastActivityOf(file, await fs.stat(file)),
      Date.parse('2026-08-08T22:27:10.000Z'), 'a new turn must not read through a stale entry');
  });
});

// Pins the PROJECT-LEVEL summary, which feeds the sidebar's per-project
// "last N ago" and list_projects. Same disagreement as the row-ordering test
// above: the summary must report the newer ACTIVITY, not the newer mtime.
// Without this, summarizeSessions can be reverted to stat.mtimeMs and every
// other test still passes — and the claim that it reports the same recency as
// the rows underneath it would be unbacked.
test('summarizeSessions reports real activity, not the newest mtime', async () => {
  await withTmp(async (tmp) => {
    const claudeProjects = path.join(tmp, '.claude', 'projects');
    const prev = process.env.CLAUDE_PROJECTS_ROOT;
    process.env.CLAUDE_PROJECTS_ROOT = claudeProjects;
    try {
      const cwd = path.join(tmp, 'proj');
      const dir = path.join(claudeProjects, encodeCwd(cwd));
      await fs.mkdir(dir, { recursive: true });

      const realNewest = Date.parse('2026-08-08T22:27:10.000Z');
      // The session that actually ran last, but whose file was touched FIRST.
      await writeTranscript(path.join(dir, '11111111-1111-4111-8111-111111111111.jsonl'), {
        timestamp: '2026-08-08T22:27:10.000Z', mtimeMs: Date.parse('2026-08-09T09:12:40.700Z'),
      });
      // Older session, but its file carries the latest mtime — the mass-exit shape.
      const bogusNewestMtime = Date.parse('2026-08-09T09:12:40.800Z');
      await writeTranscript(path.join(dir, '22222222-2222-4222-8222-222222222222.jsonl'), {
        timestamp: '2026-08-07T06:10:51.000Z', mtimeMs: bogusNewestMtime,
      });

      const summary = await summarizeSessions(cwd);
      assert.equal(summary.count, 2);
      assert.equal(summary.lastActivity, realNewest);
      assert.notEqual(summary.lastActivity, bogusNewestMtime,
        'the project number must not be the mass-exit mtime either');

      // And it must agree with the rows the sidebar renders underneath it.
      const rows = await listSessionsForCwd(cwd);
      assert.equal(summary.lastActivity, Math.max(...rows.map(r => r.lastActivity)),
        'project summary and session rows must be one definition of recency');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
      else process.env.CLAUDE_PROJECTS_ROOT = prev;
    }
  });
});

// Pins ctimeMs — the field that makes the key SOUND rather than merely
// convenient. Constructed so mtime, size and the inode are all unchanged and
// only ctime moves: a same-length write at offset 0, then fs.utimes putting
// mtime back. A key of (mtimeMs, size) or (dev, ino, mtimeMs, size) reads
// through to the stale value here.
test('an in-place rewrite that restores mtime and preserves size still invalidates', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 's.jsonl');
    // Whole-ms, because fs.utimes cannot restore sub-ms precision — otherwise
    // mtime would differ by accident and mtimeMs alone would catch the rewrite.
    const frozen = Date.parse('2026-08-09T09:12:40.000Z');
    await writeTranscript(file, { timestamp: '2026-08-07T06:10:51.000Z', mtimeMs: frozen, tail: false });

    const cache = createLastActivityCache();
    const before = await fs.stat(file);
    assert.equal(await cache.lastActivityOf(file, before), Date.parse('2026-08-07T06:10:51.000Z'));

    // Same-length body, different timestamp, written in place through the SAME
    // inode — no rename, so dev/ino cannot help.
    const body = await fs.readFile(file, 'utf8');
    const rewritten = body.replaceAll('2026-08-07T06:10:51.000Z', '2026-08-08T22:27:10.000Z');
    assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(body), 'rewrite must be same-length');
    const fh = await fs.open(file, 'r+');
    try { await fh.write(Buffer.from(rewritten), 0, Buffer.byteLength(rewritten), 0); }
    finally { await fh.close(); }
    await fs.utimes(file, new Date(frozen), new Date(frozen));

    const after = await fs.stat(file);
    assert.equal(after.ino, before.ino, 'same inode — dev/ino cannot detect this');
    assert.equal(after.size, before.size, 'same size');
    assert.equal(after.mtimeMs, frozen, 'mtime restored');
    assert.notEqual(after.ctimeMs, before.ctimeMs, 'only ctime moved — it cannot be rolled back');

    assert.equal(await cache.lastActivityOf(file, after), Date.parse('2026-08-08T22:27:10.000Z'));
  });
});

// Pins the fork/prune shape (tmp -> rename), reproduced adversarially: the
// replacement is the SAME SIZE with its mtime forced back, so neither mtimeMs
// nor size can detect the swap.
//
// This does NOT isolate dev/ino: fs.utimes after the rename sets a fresh ctime,
// so ctime alone would also catch it. That case is not constructible — a rename
// always lands a new inode WITH a new ctime — which is exactly why dev/ino are
// documented as a redundant guard rather than a load-bearing field.
test('a rename-over replacement invalidates the memoized value', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 's.jsonl');
    const replacement = path.join(dir, 'replacement.jsonl');
    // Whole-ms so fs.utimes can restore it exactly — sub-ms precision is lost
    // through utimes, which would otherwise let mtimeMs catch the swap by
    // accident and make this test pass for the wrong reason.
    const frozen = Date.parse('2026-08-09T09:12:40.000Z');

    await writeTranscript(file, { timestamp: '2026-08-07T06:10:51.000Z', mtimeMs: frozen, tail: false });
    const cache = createLastActivityCache();
    assert.equal(await cache.lastActivityOf(file, await fs.stat(file)),
      Date.parse('2026-08-07T06:10:51.000Z'));

    // Same-length body, different timestamp — so size cannot betray the swap.
    await writeTranscript(replacement, { timestamp: '2026-08-08T22:27:10.000Z', mtimeMs: frozen, tail: false });
    assert.equal((await fs.stat(replacement)).size, (await fs.stat(file)).size,
      'fixture must be the same size for this test to exercise dev/ino');
    await fs.rename(replacement, file);
    await fs.utimes(file, new Date(frozen), new Date(frozen));

    const st = await fs.stat(file);
    assert.equal(st.mtimeMs, frozen, 'mtime is restored, so mtimeMs/size cannot invalidate');
    assert.equal(await cache.lastActivityOf(file, st), Date.parse('2026-08-08T22:27:10.000Z'));
  });
});

// Pins the bound AND that eviction is by least-recently-USED, not merely
// least-recently-inserted — an unbounded map would grow for the life of the
// server as sessions come and go.
test('the cache is bounded and evicts the least-recently-used entry', async () => {
  await withTmp(async (dir) => {
    const files = [];
    for (let i = 0; i < 4; i++) {
      const f = path.join(dir, `s${i}.jsonl`);
      await writeTranscript(f, { timestamp: `2026-08-0${i + 1}T00:00:00.000Z`, tail: false });
      files.push(f);
    }
    const cache = createLastActivityCache({ max: 3 });
    for (const f of files.slice(0, 3)) await cache.lastActivityOf(f, await fs.stat(f));
    assert.equal(cache.size(), 3);

    // Touch the oldest-INSERTED entry, so it is the newest-USED one. A cache
    // that evicted by insertion order would now pick the wrong victim.
    await cache.lastActivityOf(files[0], await fs.stat(files[0]));
    await cache.lastActivityOf(files[3], await fs.stat(files[3]));

    assert.equal(cache.size(), 3, 'the cap must hold');
    assert.ok(cache.has(files[0]), 'a recently-used entry must survive eviction');
    assert.ok(!cache.has(files[1]), 'the least-recently-USED entry is the victim');
    assert.ok(cache.has(files[3]), 'the newest entry is resident');
  });
});
