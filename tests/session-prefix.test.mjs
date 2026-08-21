// Tests for sessionId PREFIX resolution at the MCP boundary. A conductor may
// address a worker by any unambiguous prefix of its sessionId (e.g. first 8
// chars) instead of the full 36-char UUID. Resolution happens once, uniformly,
// in the MCP dispatch layer (src/mcp/server.ts) via
// InstanceManager.resolveSessionRef (src/instances.ts).
//
// Two layers:
//   A. unit — resolveSessionRef branch coverage on a manager with controlled
//      byId entries (deterministic ids that real random UUIDs can't reproduce).
//   B. integration — through the real MCP tools/call dispatch: full-UUID
//      (exact match), unique-prefix resolves, ambiguous-prefix soft-refuses,
//      unknown stays unknown.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InstanceManager, SESSION_PREFIX_MIN } from '../src/instances.ts';
import { bootServer, api, waitFor, instForSession, freshProjectsRoot, rmrf, driveTurn } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');

// ---------------------------------------------------------------------------
// A. Unit: resolveSessionRef
// ---------------------------------------------------------------------------

// Build a manager whose byId holds bare stand-ins. resolveSessionRef reads
// `.sessionId` (the PERMANENT public id) and `._segments` (every backing id the
// session has run under), so an entry is either a bare id or
// `[publicId, ...segments]`. Sufficient, and leaves no open handles.
function managerWith(entries) {
  const im = new InstanceManager();
  let n = 0;
  for (const e of entries) {
    const [sessionId, ...segments] = Array.isArray(e) ? e : [e];
    im.byId.set(`i${n++}`, { id: `i${n}`, sessionId, _segments: segments });
  }
  return im;
}

test('resolveSessionRef: exact match wins even when it is a prefix of another id', () => {
  const im = managerWith(['abc', 'abcdef']);
  // 'abc' is both a full id and a prefix of 'abcdef' — exact must win, no ambiguity.
  assert.deepEqual(im.resolveSessionRef('abc'), { sessionId: 'abc' });
});

test('resolveSessionRef: unique prefix (>= min) resolves to the single full id', () => {
  const im = managerWith(['aaaa1111-2222', 'bbbb3333-4444']);
  assert.deepEqual(im.resolveSessionRef('aaaa1'), { sessionId: 'aaaa1111-2222' });
});

test('resolveSessionRef: ambiguous prefix returns all matches', () => {
  const im = managerWith(['aaaa1111', 'aaaa2222', 'bbbb0000']);
  const r = im.resolveSessionRef('aaaa');
  assert.equal(r.tooShort, false);
  assert.deepEqual(r.ambiguous.sort(), ['aaaa1111', 'aaaa2222']);
});

test('resolveSessionRef: too-short prefix is refused even when it matches exactly one', () => {
  const im = managerWith(['aaaa1111', 'bbbb2222']);
  const short = 'aa'.slice(0, SESSION_PREFIX_MIN - 2); // length < min
  const r = im.resolveSessionRef(short);
  assert.ok(r && r.tooShort === true, 'flagged tooShort');
  assert.deepEqual(r.ambiguous, ['aaaa1111']);
});

test('resolveSessionRef: no match returns null (caller falls through to SESSION_UNKNOWN)', () => {
  const im = managerWith(['aaaa1111', 'bbbb2222']);
  assert.equal(im.resolveSessionRef('zzzz'), null);
});

test('resolveSessionRef: full id resolves to itself (exact match)', () => {
  const full = '1234abcd-5678-90ef-1234-567890abcdef';
  const im = managerWith([full, 'bbbb2222-aaaa']);
  assert.deepEqual(im.resolveSessionRef(full), { sessionId: full });
});

// ---------------------------------------------------------------------------
// The widened candidate universe (card 2026-0126, decision D4). A session answers
// to its public id AND to every backing id it has run under, permanently.
// ---------------------------------------------------------------------------

test('resolveSessionRef: any full backing/segment id resolves to the PUBLIC id', () => {
  const first = 'aabbccdd-1111-4111-8111-111111111111';
  const rotated = 'eeff0011-2222-4222-8222-222222222222';
  const im = managerWith([['aabbccdd', first, rotated]]);
  // All three accepted input forms, one answer — and the answer is never a
  // backing id, because a rotating id must never reach a conductor.
  assert.deepEqual(im.resolveSessionRef('aabbccdd'), { sessionId: 'aabbccdd' });
  assert.deepEqual(im.resolveSessionRef('aabb'), { sessionId: 'aabbccdd' });
  assert.deepEqual(im.resolveSessionRef(first), { sessionId: 'aabbccdd' });
  assert.deepEqual(im.resolveSessionRef(rotated), { sessionId: 'aabbccdd' });
});

test('resolveSessionRef: two segments of the SAME session sharing a prefix RESOLVE', () => {
  // The case the brief singles out. `ab` prefixes both of this session's backing
  // ids; a candidate-string-counting implementation would call that ambiguous.
  // The answer set is of SESSIONS, so it collapses to one.
  const im = managerWith([
    ['abcd1234', 'abcd1234-1111-4111-8111-111111111111', 'abcd9999-2222-4222-8222-222222222222'],
    ['ffff0000', 'ffff0000-3333-4333-8333-333333333333'],
  ]);
  assert.deepEqual(im.resolveSessionRef('abcd'), { sessionId: 'abcd1234' });
  // …and a prefix spanning the public id and one of its own segments, likewise.
  assert.deepEqual(im.resolveSessionRef('abcd1'), { sessionId: 'abcd1234' });
});

test('resolveSessionRef: two DIFFERENT sessions sharing a prefix stay ambiguous, public ids only', () => {
  const im = managerWith([
    ['aaaa1111', 'aaaa1111-1111-4111-8111-111111111111'],
    ['aaaa2222', 'aaaa2222-2222-4222-8222-222222222222'],
  ]);
  const r = im.resolveSessionRef('aaaa');
  assert.equal(r.tooShort, false);
  assert.deepEqual(r.ambiguous.sort(), ['aaaa1111', 'aaaa2222']);
  // Never a segment id: `ambiguous` is what ambiguousRefusal shows a conductor.
  for (const m of r.ambiguous) assert.equal(m.length, 8, `${m} must be a public id`);
});

test('resolveSessionRef: two different sessions sharing a SEGMENT prefix are ambiguous too', () => {
  // Correct: the input genuinely names two sessions, even though neither public
  // id matches it.
  const im = managerWith([
    ['11111111', '11111111-1111-4111-8111-111111111111', 'beef0001-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    ['22222222', '22222222-2222-4222-8222-222222222222', 'beef0002-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
  ]);
  const r = im.resolveSessionRef('beef');
  assert.equal(r.tooShort, false);
  assert.deepEqual(r.ambiguous.sort(), ['11111111', '22222222']);
});

test('resolveSessionRef: an exact public-id match beats a longer session\'s segment prefix', () => {
  // Deterministic by construction: public ids are claimed before segments, and an
  // exact match always wins. The shadowed session stays addressable by its full
  // id or a longer prefix.
  const shadowed = 'c0ffee00-1111-4111-8111-111111111111';
  const im = managerWith([['c0ffee00'], ['deadbe01', shadowed]]);
  assert.deepEqual(im.resolveSessionRef('c0ffee00'), { sessionId: 'c0ffee00' });
  assert.deepEqual(im.resolveSessionRef(shadowed), { sessionId: 'deadbe01' });
  assert.deepEqual(im.resolveSessionRef('c0ffee00-1'), { sessionId: 'deadbe01' });
});

test('resolveSessionRef: empty / non-string input returns null', () => {
  const im = managerWith(['aaaa1111']);
  assert.equal(im.resolveSessionRef(''), null);
  assert.equal(im.resolveSessionRef(undefined), null);
  assert.equal(im.resolveSessionRef(null), null);
});

// ---------------------------------------------------------------------------
// B. Integration: through the MCP tools/call dispatch
// ---------------------------------------------------------------------------

let nextRpcId = 1;
async function rpc(baseUrl, method, params) {
  const id = nextRpcId++;
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const body = await res.json();
  return { status: res.status, body };
}
async function callTool(baseUrl, name, args) {
  const { body } = await rpc(baseUrl, 'tools/call', { name, arguments: args });
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}
function unwrap(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  return JSON.parse(result.content[0].text);
}

let ctx, baseUrl, instances, home;

before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => {
  ({ home } = await freshProjectsRoot());
});
afterEach(async () => {
  await instances.shutdown();
  instances._idleSubscribers?.clear();
  await rmrf(home);
});

// Spawn one live worker and return its full sessionId. It is the only in-memory
// session (afterEach clears byId), so any prefix of it is unique.
async function spawnLiveWorker() {
  await api(baseUrl, 'POST', '/api/projects', { name: 'a' });
  const spawn = unwrap(await callTool(baseUrl, 'spawn_instance', { project: 'a', mode: 'bypassPermissions' }));
  assert.ok(spawn.sessionId, 'spawn returns sessionId');
  await waitFor(() => instForSession(instances, spawn.sessionId)?.status === 'idle'
    && instForSession(instances, spawn.sessionId)?.sessionId);
  return spawn.sessionId;
}

test('full UUID addresses the worker (exact match)', async () => {
  const full = await spawnLiveWorker();
  const body = unwrap(await driveTurn(instances, full, () => callTool(baseUrl, 'send_prompt', {
    sessionId: full, text: 'go',
  })));
  assert.equal(body.sessionId, full);
});

test('unique prefix resolves to the full sessionId', async () => {
  const full = await spawnLiveWorker();
  const prefix = full.slice(0, 5);
  const body = unwrap(await driveTurn(instances, full, () => callTool(baseUrl, 'send_prompt', {
    sessionId: prefix, text: 'go',
  })));
  // The handler echoes the CANONICAL full sessionId — proof the prefix was
  // rewritten at the dispatch boundary before the handler ran.
  assert.equal(body.sessionId, full);
});

test('ambiguous prefix soft-refuses with SESSION_AMBIGUOUS + matches', async () => {
  const full = await spawnLiveWorker();
  // A public id is only 8 chars, so a genuine prefix is SHORTER than the whole id
  // — passing the full id would be an exact match and resolve outright.
  const prefix = full.slice(0, 5);
  // Inject a second in-memory session sharing that prefix. kill() is a noop so the
  // afterEach shutdown sweep over byId doesn't choke on the stand-in.
  const fakeSid = prefix + 'ffffffff-ffff-ffff-ffff-ffffffffffff'.slice(prefix.length);
  instances.byId.set('fake-ambig', { id: 'fake-ambig', sessionId: fakeSid, kill: async () => {} });
  try {
    const body = unwrap(await callTool(baseUrl, 'send_prompt', {
      sessionId: prefix, text: 'go',
    }));
    assert.equal(body.ok, false);
    assert.equal(body.code, 'SESSION_AMBIGUOUS');
    assert.equal(body.sessionId, prefix);
    assert.ok(Array.isArray(body.matches) && body.matches.length === 2, 'lists both candidates');
    assert.ok(typeof body.reason === 'string' && body.reason.length > 0);
  } finally {
    instances.byId.delete('fake-ambig');
  }
});

test('unknown prefix stays SESSION_UNKNOWN (unchanged behavior)', async () => {
  await spawnLiveWorker();
  const body = unwrap(await callTool(baseUrl, 'send_prompt', {
    sessionId: 'zzzzzzzz', text: 'go',
  }));
  assert.equal(body.ok, false);
  assert.equal(body.code, 'SESSION_UNKNOWN');
});
