// The disk feed of awaitingUser (src/awaitingUserTranscript.ts): what the
// backward chunked scan reads, where it stops, how it walks segments, and what
// its process-lifetime memo re-reads — plus the SessionRow cost bound
// (archived / conducted rows are not derived unless `deriveAwaitingFor` names
// the row).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { deriveAwaitingUser, chainEndingAt } from '../src/awaitingUserTranscript.ts';
import { localPlace, sessionFilePath, listSessionsForCwdWithCounts } from '../src/projects.ts';
import { markArchived } from '../src/archivedSessions.ts';
import { markConducted } from '../src/conductedSessions.ts';
import { buildWakeStub } from '../public/wakeCallback.js';
import { freshProjectsRoot, seedSessionJsonl, rmrf } from './helpers.mjs';

let home;
before(async () => { ({ home } = await freshProjectsRoot()); });
after(async () => { await rmrf(home); });

let n = 0;
const sid = () => `aa11bb22-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const place = (label) => localPlace(`/workspace/transcript-${label}-${n}`);
const user = (t) => ({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'text', text: t }] } });
const asst = (id, blocks, stop) => ({
  type: 'assistant', isSidechain: false,
  message: { id, role: 'assistant', content: blocks, ...(stop === undefined ? {} : { stop_reason: stop }) },
});
const text = (t) => ({ type: 'text', text: t });
const askTool = (id) => ({ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question: 'q' }] } });
const jsonl = (records) => records.map(r => JSON.stringify(r)).join('\n') + '\n';
const Q_TEXT = { kind: 'question', source: 'text' };
const Q_TOOL = { kind: 'question', source: 'tool' };

// Counts every byte the scan reads, so "it stopped early" and "it read only the
// new bytes" are measurements rather than inferences.
function countingIO() {
  const io = {
    bytes: 0,
    stat: (p) => fs.stat(p),
    open: async (p) => {
      const fh = await fs.open(p, 'r');
      return {
        read: async (...args) => { const r = await fh.read(...args); io.bytes += r.bytesRead; return r; },
        close: () => fh.close(),
      };
    },
  };
  return io;
}

test('an inline isSidechain record never contributes an end-of-turn text; the same record top-level does', async () => {
  const records = (sidechain) => [
    user('research it'),
    { ...asst('msg_sub', [text('Should I dig into option B?')], 'end_turn'), isSidechain: sidechain },
    asst('msg_top', [{ type: 'tool_use', id: 't1', name: 'Task', input: {} }], 'tool_use'),
  ];
  const p1 = place('side'); const a = sid();
  await seedSessionJsonl(p1, a, records(true));
  assert.equal(await deriveAwaitingUser(p1, [a]), null);
  const p2 = place('top'); const b = sid();
  await seedSessionJsonl(p2, b, records(false));
  assert.deepEqual(await deriveAwaitingUser(p2, [b]), Q_TEXT);
});

test('only a run\'s FINAL record\'s stop_reason counts: earlier per-block records read absent, null or stale', async (t) => {
  for (const [label, earlier] of [['absent', undefined], ['null', null], ['stale tool_use', 'tool_use']]) {
    await t.test(label, async () => {
      const p = place('final'); const s = sid();
      await seedSessionJsonl(p, s, [user('go'), asst('m1', [text('Want me to push?')], earlier), asst('m1', [{ type: 'thinking', thinking: 'x' }], 'end_turn')]);
      assert.deepEqual(await deriveAwaitingUser(p, [s]), Q_TEXT,
        'the end_turn is on the final record; the text sits in an earlier record of the same message');
    });
  }
  const p = place('final-toolstop'); const s = sid();
  await seedSessionJsonl(p, s, [user('go'), asst('m1', [text('Want me to push?')], 'end_turn'), asst('m1', [{ type: 'tool_use', id: 'b', name: 'Bash', input: {} }], 'tool_use')]);
  assert.equal(await deriveAwaitingUser(p, [s]), null, 'a final record ending tool_use is no end of turn, whatever earlier records say');
});

test('a line straddling a chunk edge is read whole', async () => {
  const p = place('chunk'); const s = sid();
  const long = 'x'.repeat(150 * 1024) + '\n\nShould I keep going?';
  await seedSessionJsonl(p, s, [user('go'), asst('m1', [text(long)], 'end_turn'), { type: 'last-prompt', lastPrompt: 'go' }]);
  assert.deepEqual(await deriveAwaitingUser(p, [s]), Q_TEXT);
});

test('the scan stops at the newest decisive fact instead of reading the whole file', async () => {
  const p = place('stop'); const s = sid();
  const old = [];
  for (let i = 0; i < 200; i++) old.push(user(`old ${i} ` + 'y'.repeat(4000)), asst(`o${i}`, [text('ok')], 'end_turn'));
  await seedSessionJsonl(p, s, [...old, user('latest'), asst('m1', [askTool('tq')], 'tool_use')]);
  const size = (await fs.stat(sessionFilePath(p, s))).size;
  const io = countingIO();
  assert.deepEqual(await deriveAwaitingUser(p, [s], { io }), Q_TOOL);
  assert.ok(io.bytes < size / 4, `read ${io.bytes} of ${size} bytes`);
});

test('segments walk newest→oldest and compose: an undecided newer segment inherits from the older one', async (t) => {
  await t.test('older tool ask + newer injected-only reseed segment → the tool ask', async () => {
    const p = place('seg1'); const a = sid(); const b = sid();
    await seedSessionJsonl(p, a, [user('go'), asst('m1', [askTool('tq')], 'tool_use')]);
    await seedSessionJsonl(p, b, [user(buildWakeStub({ targetSessionId: 'x', payloadText: 'y' })), asst('m2', [text('Which one?')], 'end_turn')]);
    assert.deepEqual(await deriveAwaitingUser(p, [a, b]), Q_TOOL, 'a newer text ask never downgrades the older tool ask');
  });
  await t.test('older real turn + newer text ask → the text ask', async () => {
    const p = place('seg2'); const a = sid(); const b = sid();
    await seedSessionJsonl(p, a, [asst('m0', [askTool('tq')], 'tool_use'), user('answered')]);
    await seedSessionJsonl(p, b, [asst('m2', [text('Which one?')], 'end_turn')]);
    assert.deepEqual(await deriveAwaitingUser(p, [a, b]), Q_TEXT);
  });
  await t.test('a missing segment contributes nothing', async () => {
    const p = place('seg3'); const a = sid();
    await seedSessionJsonl(p, a, [user('go'), asst('m1', [text('Proceed?')], 'end_turn')]);
    assert.deepEqual(await deriveAwaitingUser(p, [a, sid()]), Q_TEXT);
  });
});

test('chainEndingAt appends the newest id once, wherever it sat', () => {
  assert.deepEqual(chainEndingAt(['a', 'b', 'c'], 'c'), ['a', 'b', 'c']);
  assert.deepEqual(chainEndingAt(['a', 'c', 'b'], 'c'), ['a', 'b', 'c']);
  assert.deepEqual(chainEndingAt([], 'c'), ['c']);
});

test('memo: an unchanged stat reads nothing; an append reads only the new bytes plus the trailing message; a rewrite rescans', async (t) => {
  const p = place('memo'); const s = sid();
  const file = sessionFilePath(p, s);
  const trailing = asst('m1', [text('Done.')], 'end_turn');
  await seedSessionJsonl(p, s, [user('go ' + 'z'.repeat(20000)), trailing]);
  assert.equal(await deriveAwaitingUser(p, [s]), null);

  await t.test('unchanged stat → hit, zero bytes read', async () => {
    const io = countingIO();
    assert.equal(await deriveAwaitingUser(p, [s], { io }), null);
    assert.equal(io.bytes, 0);
  });

  await t.test('appended lines → only the appended bytes plus the trailing message are read, and the composed result is right', async () => {
    const appended = jsonl([asst('m2', [text('Shall I tag it?')], 'end_turn')]);
    await fs.appendFile(file, appended);
    const io = countingIO();
    assert.deepEqual(await deriveAwaitingUser(p, [s], { io }), Q_TEXT);
    // The trailing assistant message (m1) is re-read: a later record could have extended it.
    assert.equal(io.bytes, Buffer.byteLength(jsonl([trailing])) + Buffer.byteLength(appended));
  });

  await t.test('a message still being written is re-read once its final record lands', async () => {
    // The final record of m3 has no stop_reason yet: the message is in progress.
    await fs.appendFile(file, jsonl([user('tag it'), asst('m3', [text('Tagged. Want me to push the tag?')])]));
    assert.equal(await deriveAwaitingUser(p, [s]), null, 'the real user turn cleared it; m3 has not ended');
    await fs.appendFile(file, jsonl([asst('m3', [{ type: 'thinking', thinking: 't' }], 'end_turn')]));
    assert.deepEqual(await deriveAwaitingUser(p, [s]), Q_TEXT, 'the text in m3\'s earlier record is the turn\'s final text');
  });

  await t.test('a partial trailing line is not read as a line', async () => {
    await fs.appendFile(file, JSON.stringify(user('half')).slice(0, 20));
    assert.deepEqual(await deriveAwaitingUser(p, [s]), Q_TEXT);
  });

  await t.test('rewritten smaller under a new inode (rewind/prune) → full rescan', async () => {
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, jsonl([user('go'), asst('m1', [askTool('tq')], 'tool_use')]));
    await fs.rename(tmp, file);
    assert.deepEqual(await deriveAwaitingUser(p, [s]), Q_TOOL);
  });
});

// INVARIANT: an incremental read equals a full scan of the same bytes, whatever
// stop_reason the newest record of the message still being written carries.
test('memo: a trailing message extended after an intervening read gives the full-scan answer, both directions', async (t) => {
  const fullScan = async (bytes) => {
    const p = place('fresh'); const s = sid();
    await seedSessionJsonl(p, s, []);
    await fs.writeFile(sessionFilePath(p, s), bytes);
    return deriveAwaitingUser(p, [s]);
  };
  for (const [label, first, last, want] of [
    ['a stale tool_use record, then the end_turn record → the ask appears', 'tool_use', 'end_turn', Q_TEXT],
    ['an earlier end_turn record, then a final tool_use record → no false ask', 'end_turn', 'tool_use', null],
  ]) {
    await t.test(label, async () => {
      const p = place('extend'); const s = sid();
      const file = sessionFilePath(p, s);
      await seedSessionJsonl(p, s, [user('go'), asst('m1', [text('Want me to push?')], first)]);
      await deriveAwaitingUser(p, [s]); // the intervening read that memoises the prefix
      const finalBlock = last === 'end_turn' ? { type: 'thinking', thinking: 't' } : { type: 'tool_use', id: 'b', name: 'Bash', input: {} };
      await fs.appendFile(file, jsonl([asst('m1', [finalBlock], last)]));
      const incremental = await deriveAwaitingUser(p, [s]);
      assert.deepEqual(incremental, await fullScan(await fs.readFile(file)), 'incremental == full scan');
      assert.deepEqual(incremental, want);
    });
  }
});

test('SessionRow: list reads leave archived and conducted rows null; deriveAwaitingFor derives the named row', async () => {
  const p = place('rows');
  const [live, archived, conducted] = [sid(), sid(), sid()];
  const records = [user('go'), asst('m1', [askTool('tq')], 'tool_use')];
  for (const s of [live, archived, conducted]) await seedSessionJsonl(p, s, records);
  await markArchived(archived);
  await markConducted(conducted);

  const rowsOf = async (opts) => new Map((await listSessionsForCwdWithCounts(p, null, { includeArchived: true, ...opts })).rows
    .map(r => [r.sessionId, r]));
  const listed = await rowsOf({});
  assert.equal(listed.get(live).awaitingUser, 'question');
  assert.equal(listed.get(live).awaitingUserSource, 'tool');
  assert.equal(listed.get(archived).awaitingUser, null, 'archived: not derived in a list read');
  assert.equal(listed.get(conducted).awaitingUser, null, 'conducted: never carries the flag');
  assert.ok(!('ownerSessionId' in listed.get(live)), 'a disk row has no owner key');

  const described = await rowsOf({ deriveAwaitingFor: archived });
  assert.equal(described.get(archived).awaitingUser, 'question');
  assert.equal(described.get(archived).awaitingUserSource, 'tool');
});

// INVARIANT: awaitingUser is null on a conducted session on every surface —
// describe_session's deriveAwaitingFor exception included.
test('deriveAwaitingFor on an archived CONDUCTED row with a pending tool ask reports null', async () => {
  const p = place('conducted-archived');
  const s = sid();
  await seedSessionJsonl(p, s, [user('go'), asst('m1', [askTool('tq')], 'tool_use')]);
  await markArchived(s);
  await markConducted(s);
  const row = (await listSessionsForCwdWithCounts(p, null, { includeArchived: true, deriveAwaitingFor: s })).rows
    .find(r => r.sessionId === s);
  assert.equal(row.awaitingUser, null);
  assert.equal(row.awaitingUserSource, null);
});
