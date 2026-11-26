// Which session a `--replay` shows (src/headless/replay.ts → resolveReplaySession)
// and the last-run marker it reads (src/headless/lastRun.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { recordHeadlessRun, readHeadlessRun, headlessLastRunFile } from '../src/headless/lastRun.ts';
import { resolveReplaySession } from '../src/headless/replay.ts';

const PUBLIC = 'pub-1';
const SEGMENT = 'seg-1';
// A session index of one session: public id PUBLIC, live segment SEGMENT.
const index = () => ({
  byPublic: new Map([[PUBLIC, { current: SEGMENT, segments: [{ id: SEGMENT, reason: 'initial', at: '2026-01-01T00:00:00Z' }] }]]),
  byBacking: new Map([[SEGMENT, PUBLIC]]),
});
const pick = (requested, lastRun) => resolveReplaySession({
  requested,
  readLastRun: async () => lastRun,
  loadIndex: async () => index(),
});

async function withStore(fn) {
  const { home } = await freshProjectsRoot();
  try { await fn(); } finally { await rmrf(home); }
}

// Invariant: the marker round-trips the public id, and a later run's record
// replaces an earlier one (the newest run wins).
test('recordHeadlessRun then readHeadlessRun round-trips; a second record overwrites', async () => {
  await withStore(async () => {
    assert.equal(await readHeadlessRun(), null, 'no marker before any run');
    await recordHeadlessRun('first');
    assert.deepEqual(await readHeadlessRun(), { sessionId: 'first' });
    await recordHeadlessRun('second');
    assert.deepEqual(await readHeadlessRun(), { sessionId: 'second' });
  });
});

// Invariant: an unreadable marker is an error naming the file, never a silent "no run".
test('a malformed marker throws naming the file', async () => {
  await withStore(async () => {
    fs.mkdirSync(fs.realpathSync(process.env.PROJECTS_ROOT) + '/.code-conductor', { recursive: true });
    fs.writeFileSync(headlessLastRunFile(), '{not json');
    await assert.rejects(readHeadlessRun(), (e) => e.message.includes(headlessLastRunFile()));
  });
});
test('a marker with no sessionId throws naming the file', async () => {
  await withStore(async () => {
    fs.mkdirSync(fs.realpathSync(process.env.PROJECTS_ROOT) + '/.code-conductor', { recursive: true });
    fs.writeFileSync(headlessLastRunFile(), '{"other":1}');
    await assert.rejects(readHeadlessRun(), (e) => e.message.includes(headlessLastRunFile()));
  });
});

// Invariant: an empty sessionId is a corrupt marker, never "a run with no session".
test('a marker whose sessionId is the empty string throws naming the file', async () => {
  await withStore(async () => {
    fs.mkdirSync(fs.realpathSync(process.env.PROJECTS_ROOT) + '/.code-conductor', { recursive: true });
    fs.writeFileSync(headlessLastRunFile(), '{"sessionId":""}');
    await assert.rejects(readHeadlessRun(), (e) => e.message.includes(headlessLastRunFile()));
  });
});

// Invariant: an explicit --session resolves to the public id, whichever form it names.
test('an explicit public id is shown as itself', async () => {
  assert.deepEqual(await pick(PUBLIC, null), { ok: true, sessionId: PUBLIC });
});
test('an explicit segment id is normalised to its public id', async () => {
  assert.deepEqual(await pick(SEGMENT, null), { ok: true, sessionId: PUBLIC });
});
test('an explicit id the store does not hold is refused, naming it', async () => {
  assert.deepEqual(await pick('nope', { sessionId: PUBLIC }),
    { ok: false, message: "no session 'nope' in this root's session store" });
});

// Invariant: with no --session the last run's recorded session is shown, and
// every way that can fail is a refusal with its own message.
test('no --session shows the last run\'s session', async () => {
  assert.deepEqual(await pick(null, { sessionId: PUBLIC }), { ok: true, sessionId: PUBLIC });
});
test('a marker naming a session the store no longer holds is refused', async () => {
  assert.deepEqual(await pick(null, { sessionId: 'gone' }),
    { ok: false, message: "the last headless run's session gone is no longer in this root's session store" });
});
test('no marker is refused, asking for --session', async () => {
  assert.deepEqual(await pick(null, null),
    { ok: false, message: 'no headless run has recorded a session on this root; pass --session <id>' });
});
test('an unreadable marker is refused with the read error', async () => {
  const r = await resolveReplaySession({
    requested: null,
    readLastRun: async () => { throw new Error('cannot read /x/headless-last-run.json: boom'); },
    loadIndex: async () => index(),
  });
  assert.deepEqual(r, { ok: false, message: 'cannot read /x/headless-last-run.json: boom' });
});
