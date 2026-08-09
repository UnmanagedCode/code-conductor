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
import { createLastActivityCache } from '../src/sessionActivity.ts';
import { encodeCwd, listSessionsForCwd } from '../src/projects.ts';

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

// Pins: lastActivity is the newest in-file timestamp, NOT the file's mtime,
// when the tail is untimestamped bookkeeping.
test('lastActivity reads the newest record IN the transcript, not its mtime', async () => {
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

// Pins the dev/ino half of the cache key. This is the fork/prune shape
// (tmp -> rename), reproduced adversarially: the replacement is the SAME SIZE
// and has its mtime forced back to the original's, so mtime and size both
// match and only the inode (and ctime) differ.
test('a rename-over replacement invalidates the memoized value', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 's.jsonl');
    const replacement = path.join(dir, 'replacement.jsonl');
    // Whole-ms so fs.utimes can restore it exactly — sub-ms precision is lost
    // through utimes, which would otherwise make mtime differ by accident and
    // let a key WITHOUT dev/ino pass this test for the wrong reason.
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
    assert.equal(st.mtimeMs, frozen, 'mtime is restored, so only inode/ctime can invalidate');
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
