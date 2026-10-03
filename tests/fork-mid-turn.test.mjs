// POST /api/instances/:id/fork while the source is mid-turn
// (Instance.forkAtUserMessage). The source runs a real open turn (the fake CLI
// emits `message_start` and no `result`); the fake writes no jsonl, so each test
// appends the CLI's lines itself — the `queue-operation` enqueue/dequeue pair,
// the prompt line, open-turn assistant lines. Read ordering is made
// deterministic through the `_readForkSnapshot` seam: a test appends, rotates
// or kills only after a given snapshot read has returned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';
import { encodeCwd } from '../src/projects.ts';
import { PROMPT_NOT_PERSISTED, FORK_SOURCE_CHANGED } from '../src/instances.ts';
import { PROMPT_OUT_OF_RANGE, PROMPT_MISMATCH } from '../src/sessionEdit.ts';
import { rotate } from './segmentChain.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-open-turn.json');

const SEED = [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
  { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'first reply' }] } },
  { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
  { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'second reply — héllo ⑂' }] } },
];
// What the CLI writes for prompt 'third': the queue pair before the prompt
// line, then open-turn output after it.
const QUEUE = [
  { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-03T00:00:00.000Z', content: 'third' },
  { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-10-03T00:00:00.010Z' },
];
const THIRD = { type: 'user', uuid: 'u3', message: { role: 'user', content: 'third' } };
const OPEN_TURN = [
  { type: 'assistant', uuid: 'a3', message: { id: 'm3', role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'ls' } }] } },
  { type: 'user', uuid: 'r3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'a.txt' }] } },
];

const jsonl = (records) => records.map(r => JSON.stringify(r) + '\n').join('');
const parseJsonl = (text) => text.split('\n').filter(Boolean).map(l => JSON.parse(l));
// The copied lines of a fork file, without the resume-picker metadata pair the
// fork appends after them.
const copied = (text) => parseJsonl(text).filter(r => r.type !== 'last-prompt' && r.type !== 'permission-mode');

let boots = 0;
// A resumed 2-prompt session whose third prompt opened a turn that is still
// running. `_userEchoCount` is 3, so prompt 2 ('third') is owed a line.
async function bootMidTurn() {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  const n = String(++boots).padStart(8, '0');
  const sid = `${n}-aaaa-4bbb-8ccc-dddddddddddd`;
  const project = `forkmid${boots}`;
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: project });
  const sessionDir = path.join(ctx.claudeProjectsRoot, encodeCwd(path.join(ctx.projectsRoot, project)));
  await fs.mkdir(sessionDir, { recursive: true });
  const file = path.join(sessionDir, `${sid}.jsonl`);
  await fs.writeFile(file, jsonl(SEED));
  const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions', resume: sid });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inst = ctx.instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle' && inst.backingSessionId === sid);
  await inst.prompt('third');
  await waitFor(() => inst.status === 'turn');
  assert.equal(inst._userEchoCount, 3, 'precondition: the in-flight prompt\'s echo was emitted');
  const fork = (userMessageIndex, text) =>
    api(ctx.baseUrl, 'POST', `/api/instances/${inst.id}/fork`, { userMessageIndex, text });
  const sessionFiles = async () => (await fs.readdir(sessionDir)).filter(f => f.endsWith('.jsonl')).sort();
  return { ctx, inst, sid, file, sessionDir, fork, sessionFiles, append: (records) => fs.appendFile(file, jsonl(records)) };
}

// Wrap the instance's snapshot read: records every snapshot and runs
// `afterRead(n, snap)` once read n has returned, before the fork sees it.
function traceReads(inst, afterRead = async () => {}) {
  const real = inst._readForkSnapshot.bind(inst);
  const snaps = [];
  inst._readForkSnapshot = async (...args) => {
    const snap = await real(...args);
    snaps.push(snap);
    await afterRead(snaps.length, snap);
    return snap;
  };
  return snaps;
}

test('fork of a past prompt mid-turn copies exactly the lines before it', async () => {
  const { ctx, inst, file, fork, append } = await bootMidTurn();
  try {
    await append([...QUEUE, THIRD, ...OPEN_TURN]);
    const sourceBefore = await fs.readFile(file, 'utf8');
    const proc = inst.proc;
    const snaps = traceReads(inst);

    const fk = await fork(1, 'second');
    assert.equal(fk.status, 201, JSON.stringify(fk.body));
    assert.equal(snaps.length, 1, 'one snapshot read');
    const forked = await fs.readFile(path.join(path.dirname(file), `${fk.body.newSessionId}.jsonl`), 'utf8');
    assert.deepEqual(copied(forked), SEED.slice(0, 2), 'exactly the lines before prompt 1 — no open-turn line');
    assert.equal(inst.status, 'turn', 'the source keeps running');
    assert.ok(inst.proc === proc, 'the source process was not replaced');
    assert.equal(await fs.readFile(file, 'utf8'), sourceBefore, 'the fork wrote nothing to the source');
    assert.equal(inst._mutating, null);
  } finally { await ctx.close(); }
});

test('fork of the in-flight prompt after its line is persisted', async (t) => {
  await t.test('resolves like an idle fork; a partial trailing line is not copied', async () => {
    const { ctx, file, fork, append } = await bootMidTurn();
    try {
      await append([...QUEUE, THIRD, OPEN_TURN[0]]);
      await fs.appendFile(file, '{"type":"assistant","uuid":"a4","message":{"content":"⑂ par');
      const fk = await fork(2, 'third');
      assert.equal(fk.status, 201, JSON.stringify(fk.body));
      assert.equal(fk.body.droppedText, 'third');
      const forked = await fs.readFile(path.join(path.dirname(file), `${fk.body.newSessionId}.jsonl`), 'utf8');
      assert.deepEqual(copied(forked), [...SEED, ...QUEUE], 'everything before the prompt line, and nothing after it');
      assert.ok(!forked.includes('"uuid":"a4"'), 'the partial line is not copied');
    } finally { await ctx.close(); }
  });

  await t.test('a prompt line missing only its terminating newline is not counted', async () => {
    // Complete JSON but no `\n`: still a write in progress. Counting it would
    // let a fork resolve against a line the CLI has not finished writing.
    const { ctx, inst, file, fork, append, sessionFiles } = await bootMidTurn();
    try {
      inst._forkPersistWaitMs = 150;
      await append(QUEUE);
      await fs.appendFile(file, JSON.stringify(THIRD));
      const before = await sessionFiles();
      const fk = await fork(2, 'third');
      assert.equal(fk.status, 409, JSON.stringify(fk.body));
      assert.equal(fk.body.code, PROMPT_NOT_PERSISTED);
      assert.deepEqual(await sessionFiles(), before, 'no fork file was written');
    } finally { await ctx.close(); }
  });
});

test('fork of the in-flight prompt before its line is persisted waits, then succeeds', async () => {
  const { ctx, inst, file, fork, append } = await bootMidTurn();
  try {
    const snaps = traceReads(inst, async (n) => {
      if (n === 1) await append([...QUEUE, THIRD, ...OPEN_TURN]);
    });
    const fk = await fork(2, 'third');
    assert.equal(fk.status, 201, JSON.stringify(fk.body));
    assert.ok(!snaps[0].text.includes('"third"'), 'precondition: the first snapshot lacks the prompt line');
    assert.ok(snaps.length >= 2, 'a later snapshot was read');
    assert.ok(snaps.at(-1).text.includes('"u3"'), 'the copy came from a snapshot holding the prompt line');
    const forked = await fs.readFile(path.join(path.dirname(file), `${fk.body.newSessionId}.jsonl`), 'utf8');
    assert.deepEqual(copied(forked), [...SEED, ...QUEUE], 'open-turn lines appended with the prompt are excluded');
  } finally { await ctx.close(); }
});

test('a steer and a renew_session arm sent while the fork waits are accepted', async () => {
  const { ctx, inst, fork, append } = await bootMidTurn();
  try {
    let steer = null;
    let renew = null;
    traceReads(inst, async (n) => {
      if (n !== 1) return;
      assert.equal(inst._mutating, 'fork', 'precondition: the fork holds the flag');
      steer = await inst.prompt('steer while forking').then(() => 'accepted', (e) => e);
      const res = await fetch(`${ctx.baseUrl}/mcp?caller=${encodeURIComponent(inst.id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'renew_session', arguments: { summary: 'while forking' } } }),
      });
      renew = JSON.parse((await res.json()).result.content[0].text);
      await append([...QUEUE, THIRD]);
    });
    const fk = await fork(2, 'third');
    assert.equal(fk.status, 201, JSON.stringify(fk.body));
    assert.equal(steer, 'accepted', 'prompt() is not refused during the fork hold');
    assert.equal(renew?.ok, true, `renew_session arms during the fork hold: ${JSON.stringify(renew)}`);
    assert.equal(inst.rotationInFlight, 'renew');
  } finally { await ctx.close(); }
});

test('an in-flight prompt that never persists refuses PROMPT_NOT_PERSISTED', async () => {
  const { ctx, inst, fork, sessionFiles } = await bootMidTurn();
  try {
    inst._forkPersistWaitMs = 150;
    const before = await sessionFiles();
    const fk = await fork(2, 'third');
    assert.equal(fk.status, 409, JSON.stringify(fk.body));
    assert.equal(fk.body.code, PROMPT_NOT_PERSISTED);
    assert.match(fk.body.error, /hasn't been written to the session transcript yet/);
    assert.deepEqual(await sessionFiles(), before, 'no fork file was written');
    assert.equal(inst._mutating, null, 'the flag is released');
  } finally { await ctx.close(); }
});

test('an unchanged file size is polled, not re-read: reads stay bounded during the wait', async (t) => {
  // The wait compares the file's size with the RAW byte length of the last read.
  // A multibyte character or a partial last line makes the decoded snapshot's
  // length differ from the file size, so comparing against it would re-read the
  // whole jsonl on every tick until the deadline.
  for (const [name, tail] of [['multibyte content', ''], ['multibyte content and a partial last line', '{"type":"assistant","message":"⑂']]) {
    await t.test(name, async () => {
      const { ctx, inst, file, fork } = await bootMidTurn();
      try {
        if (tail) await fs.appendFile(file, tail);
        inst._forkPersistWaitMs = 400;
        const snaps = traceReads(inst);
        const fk = await fork(2, 'third');
        assert.equal(fk.status, 409, JSON.stringify(fk.body));
        assert.equal(fk.body.code, PROMPT_NOT_PERSISTED);
        assert.notEqual(snaps[0].text.length, snaps[0].size, 'precondition: the decoded snapshot\'s length is not the file size');
        assert.equal(snaps.length, 2, 'one read, then one more at the deadline');
      } finally { await ctx.close(); }
    });
  }
});

test('killing the source mid-wait ends the wait with FORK_SOURCE_CHANGED', async () => {
  const { ctx, inst, fork, sessionFiles } = await bootMidTurn();
  try {
    let killed = null;
    const snaps = traceReads(inst, async (n) => {
      if (n === 1) killed = inst.kill({ graceMs: 50 });
    });
    const before = await sessionFiles();
    const fk = await fork(2, 'third');
    await killed;
    assert.equal(fk.status, 409, JSON.stringify(fk.body));
    assert.equal(fk.body.code, FORK_SOURCE_CHANGED);
    assert.ok(snaps.length <= 2, `at most one more read after the kill, got ${snaps.length}`);
    assert.deepEqual(await sessionFiles(), before, 'no fork file was written');
    assert.equal(inst._mutating, null);
  } finally { await ctx.close(); }
});

test('a rotation during the fork never yields a copy mixing two segments', async (t) => {
  const NEW_SID = 'eeeeeeee-0000-4000-8000-000000000001';

  await t.test('a rotation before an attempt refuses FORK_SOURCE_CHANGED', async () => {
    const { ctx, inst, fork, sessionFiles } = await bootMidTurn();
    try {
      let rotated = null;
      const snaps = traceReads(inst, async (n) => {
        if (n === 1) rotated = rotate(inst, NEW_SID);
      });
      const before = await sessionFiles();
      const fk = await fork(2, 'third');
      await rotated;
      assert.equal(fk.status, 409, JSON.stringify(fk.body));
      assert.equal(fk.body.code, FORK_SOURCE_CHANGED);
      assert.equal(snaps.length, 1, 'no read after the rotation');
      assert.deepEqual(await sessionFiles(), before, 'no fork file was written');
    } finally { await ctx.close(); }
  });

  await t.test('a rotation landing inside the read still forks from the pinned file', async () => {
    const { ctx, inst, sid, file, sessionDir, fork, append } = await bootMidTurn();
    try {
      await append([...QUEUE, THIRD, ...OPEN_TURN]);
      // The new segment's file holds prompts of its own: a fork that read or
      // calibrated against it could not produce the pinned file's prefix.
      await fs.writeFile(path.join(sessionDir, `${NEW_SID}.jsonl`), jsonl([
        { type: 'user', uuid: 'n1', message: { role: 'user', content: 'third' } },
        { type: 'assistant', uuid: 'na1', message: { id: 'nm1', role: 'assistant', content: [{ type: 'text', text: 'new' }] } },
      ]));
      traceReads(inst, async (n) => { if (n === 1) await rotate(inst, NEW_SID); });
      const fk = await fork(2, 'third');
      assert.equal(fk.status, 201, JSON.stringify(fk.body));
      assert.equal(inst.backingSessionId, NEW_SID, 'precondition: the source rotated during the fork');
      const forked = await fs.readFile(path.join(sessionDir, `${fk.body.newSessionId}.jsonl`), 'utf8');
      assert.deepEqual(copied(forked), [...SEED, ...QUEUE], `the prefix of the pinned file ${sid}, and only it`);
      assert.ok(!forked.includes('"n1"') && !forked.includes('"na1"'), 'nothing from the new segment');
      assert.ok((await fs.readFile(file, 'utf8')).includes('"r3"'), 'the pinned file is intact');
    } finally { await ctx.close(); }
  });
});

test('wrong anchors mid-turn are refused promptly, nothing written', async (t) => {
  await t.test('an ordinal with no echo 400s PROMPT_OUT_OF_RANGE after exactly one read', async () => {
    const { ctx, inst, fork, sessionFiles } = await bootMidTurn();
    try {
      const snaps = traceReads(inst);
      const before = await sessionFiles();
      const fk = await fork(5, 'sixth');
      assert.equal(fk.status, 400, JSON.stringify(fk.body));
      assert.equal(fk.body.code, PROMPT_OUT_OF_RANGE);
      assert.equal(snaps.length, 1, 'no wait for a prompt no echo owes');
      assert.deepEqual(await sessionFiles(), before);
    } finally { await ctx.close(); }
  });

  await t.test('a wrong text on a persisted prompt 409s PROMPT_MISMATCH after exactly one read', async () => {
    const { ctx, inst, fork, sessionFiles } = await bootMidTurn();
    try {
      const snaps = traceReads(inst);
      const before = await sessionFiles();
      const fk = await fork(1, 'not second');
      assert.equal(fk.status, 409, JSON.stringify(fk.body));
      assert.ok(fk.body.error.startsWith(PROMPT_MISMATCH), fk.body.error);
      assert.equal(snaps.length, 1);
      assert.deepEqual(await sessionFiles(), before);
    } finally { await ctx.close(); }
  });
});
