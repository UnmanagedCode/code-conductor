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
import { promises as fs } from 'node:fs';
import { InstanceManager, SESSION_PREFIX_MIN } from '../src/instances.ts';
import { orchStoreRoot } from '../src/projects.ts';
import { bootServer, api, waitFor, instForSession, freshProjectsRoot, rmrf, driveTurn,
         seedSessionJsonl } from './helpers.mjs';

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

let ctx, baseUrl, instances, home, claudeProjectsRoot;

before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => {
  ({ home, claudeProjectsRoot } = await freshProjectsRoot());
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

// ---------------------------------------------------------------------------
// C. `resume` (spawn_instance) — the same chokepoint, over a WIDER universe
//
// `resume` names a session that is usually NOT running, and the ordinary one is
// not in `byId` at all: a conductor worker is temp, so it is evicted on exit
// (src/instances.ts), and after an orchestrator restart a conducted worker is
// never re-entered (src/resumeRestart.ts). So the resume site resolves over
// `byId` UNION the lineage store, as one candidate set — see
// InstanceManager.resolveResumeRef.
// ---------------------------------------------------------------------------

// The project every case below spawns into.
async function project(name = 'a') {
  await api(baseUrl, 'POST', '/api/projects', { name });
  return path.join(process.env.PROJECTS_ROOT, name);
}

// The transcript the fake engine never writes, at the cwd the CLI would have
// derived — without it every resume below refuses SESSION_UNKNOWN and the case
// proves nothing about resolution.
async function seedTranscript(sessionId, cwd) {
  await seedSessionJsonl(claudeProjectsRoot, cwd,
    instForSession(instances, sessionId).backingSessionId);
}

// Hand-write a lineage row for a session this process never ran. That is the
// shape a conducted worker has after an ORCHESTRATOR restart: transcript intact,
// listed normally, never archived — and no `byId` entry at all. More than one
// `backingIds` entry makes it a ROTATED session, where `current` is the last and
// the earlier ones are still individually addressable.
async function seedLineageRow(publicId, ...backingIds) {
  const file = path.join(orchStoreRoot(), 'session-lineage.json');
  let sessions = {};
  try { ({ sessions } = JSON.parse(await fs.readFile(file, 'utf8'))); } catch { /* first row */ }
  sessions[publicId] = {
    current: backingIds[backingIds.length - 1],
    segments: backingIds.map((id, i) => (
      { id, reason: i === 0 ? 'initial' : 'renew', at: `2026-09-0${6 + i}T00:00:00Z` })),
  };
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ sessions }, null, 2) + '\n');
}

test('resume is prefix-resolved at the same chokepoint as sessionId', async () => {
  // INVARIANT: `resume` is an ordinary worker handle — any unambiguous prefix of
  // it addresses the session, exactly as for a top-level `sessionId`.
  const cwd = await project();
  // temp:false, so the instance survives its own exit and this case is the
  // in-`byId` one; the evicted case is its own test below.
  const spawned = await api(baseUrl, 'POST', '/api/instances', { project: 'a', mode: 'bypassPermissions', temp: false });
  assert.equal(spawned.status, 201, JSON.stringify(spawned.body));
  const full = spawned.body.sessionId;
  await waitFor(() => instForSession(instances, full)?.status === 'idle');
  await seedTranscript(full, cwd);
  await instForSession(instances, full).kill();
  await waitFor(() => !instForSession(instances, full)?.proc);
  assert.ok(instForSession(instances, full), 'premise: a non-temp instance stays in byId after its exit');

  const back = unwrap(await callTool(baseUrl, 'spawn_instance', { resume: full.slice(0, 5) }));
  assert.notEqual(back.ok, false, `a resume by prefix must not be refused: ${JSON.stringify(back)}`);
  assert.equal(back.sessionId, full, 'the prefix resolved to the canonical public id');
});

test('an ambiguous resume prefix soft-refuses SESSION_AMBIGUOUS, naming `resume`', async () => {
  // The `where` argument is what distinguishes this site from the three above it.
  const full = await spawnLiveWorker();
  const prefix = full.slice(0, 5);
  const fakeSid = prefix + 'ffffffff-ffff-ffff-ffff-ffffffffffff'.slice(prefix.length);
  instances.byId.set('fake-ambig', { id: 'fake-ambig', sessionId: fakeSid, kill: async () => {} });
  try {
    const body = unwrap(await callTool(baseUrl, 'spawn_instance', { resume: prefix }));
    assert.equal(body.ok, false);
    assert.equal(body.code, 'SESSION_AMBIGUOUS');
    assert.equal(body.isError, undefined, 'a soft refusal, serialized like every other');
    assert.equal(body.matches.length, 2);
    assert.match(body.reason, /\(resume\)/);
  } finally {
    instances.byId.delete('fake-ambig');
  }
});

test('a backing id passed as resume is normalised to the handle before the gate sees it', async () => {
  // Pins docs/protocol.md's "a public id or any backing id is fine" to behaviour.
  const cwd = await project();
  const full = await spawnLiveWorker();
  const backing = instForSession(instances, full).backingSessionId;
  assert.notEqual(backing, full, 'premise: the backing id must differ from the handle');
  await seedTranscript(full, cwd);
  await callTool(baseUrl, 'kill_instance', { sessionId: full });
  await waitFor(() => !instForSession(instances, full));

  const back = unwrap(await callTool(baseUrl, 'spawn_instance', { resume: backing }));
  assert.notEqual(back.ok, false, `a resume by backing id must not be refused: ${JSON.stringify(back)}`);
  assert.equal(back.sessionId, full, 'the answer is always the handle, never a ~/.claude UUID');
});

test('a resume prefix resolves for a session that is NOT in byId', async () => {
  // THE LOAD-BEARING CASE. A conductor worker is temp, so its exit evicts it —
  // an in-memory-only or exact-only resolver misses the ordinary killed-worker
  // resume entirely.
  const cwd = await project();
  const full = await spawnLiveWorker();
  await seedTranscript(full, cwd);
  await callTool(baseUrl, 'kill_instance', { sessionId: full });
  // PREMISE GUARD: without this the case silently degrades into the in-byId one.
  await waitFor(() => !instForSession(instances, full));
  assert.equal(instForSession(instances, full), undefined,
    'premise: the evicted worker must be outside the in-memory universe');

  const back = unwrap(await callTool(baseUrl, 'spawn_instance', { resume: full.slice(0, 5) }));
  assert.notEqual(back.ok, false, `a resume by prefix must not be refused: ${JSON.stringify(back)}`);
  assert.equal(back.sessionId, full);
});

test('a resume prefix resolves for a session this process never ran (the post-restart shape)', async () => {
  // The second route out of `byId`: an orchestrator crash leaves a conducted
  // worker un-archived and unrestored, so it looks entirely healthy from every
  // tool surface while having no `byId` entry to resolve against. Reaching this
  // state by eviction would not exercise it — the point is a session that never
  // went through _handleExit at all.
  const cwd = await project();
  const publicId = 'ba5eba11';
  const backing = 'ba5eba11-1111-4111-8111-111111111111';
  await seedLineageRow(publicId, backing);
  await seedSessionJsonl(claudeProjectsRoot, cwd, backing);
  assert.equal(instances.anyForSession(publicId), null, 'premise: no byId entry for it');

  const back = unwrap(await callTool(baseUrl, 'spawn_instance', { resume: 'ba5eb' }));
  assert.notEqual(back.ok, false, `a cold session must resume by prefix: ${JSON.stringify(back)}`);
  assert.equal(back.sessionId, publicId);
});

test('a resume prefix unique in memory but shared with a COLD session is ambiguous, not a confident wrong answer', async () => {
  // Pins the UNION candidate set specifically. A resolver that consults the store
  // only when memory misses answers {sessionId} here — confidently, and wrongly.
  await project();
  instances.byId.set('fake-warm', { id: 'fake-warm', sessionId: 'c0ffee11', kill: async () => {} });
  try {
    await seedLineageRow('c0ffee22', 'c0ffee22-2222-4222-8222-222222222222');
    assert.deepEqual(instances.resolveSessionRef('c0ffee'), { sessionId: 'c0ffee11' },
      'premise: in memory alone the prefix resolves uniquely — that is the wrong answer');

    const body = unwrap(await callTool(baseUrl, 'spawn_instance', { resume: 'c0ffee' }));
    assert.equal(body.ok, false);
    assert.equal(body.code, 'SESSION_AMBIGUOUS');
    assert.deepEqual(body.matches.sort(), ['c0ffee11', 'c0ffee22']);
  } finally {
    instances.byId.delete('fake-warm');
  }
});

test('a resume naming a NON-CURRENT segment opens THAT segment, not the newest — MCP and REST alike', async () => {
  // INVARIANT: the transport may normalise `resume` for the policy gate, but it
  // must not destroy the only copy of the segment the caller named. `resolveBacking`
  // returns a named segment verbatim and `current` only for a public id
  // (src/sessionLineage.ts), so rewriting a segment to its public id upstream
  // silently redirects the resume to the newest transcript — the same class of
  // wrong-transcript landing this card exists to close. Both surfaces must agree:
  // REST does not go through the transport chokepoint at all.
  const cwd = await project();
  const publicId = 'deadbeef';
  const older = 'deadbeef-1111-4111-8111-111111111111';
  const current = 'deadbeef-2222-4222-8222-222222222222';
  await seedLineageRow(publicId, older, current);
  await seedSessionJsonl(claudeProjectsRoot, cwd, older);
  await seedSessionJsonl(claudeProjectsRoot, cwd, current);

  // One resume at a time: two live instances on one public id is a 409 by design.
  async function resumeVia(fn) {
    const out = await fn();
    await waitFor(() => instForSession(instances, publicId));
    const inst = instForSession(instances, publicId);
    const backing = inst.backingSessionId;
    await instances.remove(inst.id);
    return { out, backing };
  }

  // PREMISE GUARD: the public id resolves to `current`, so "landed on `older`"
  // below is a real distinction and not an identity.
  const byHandle = await resumeVia(() => callTool(baseUrl, 'spawn_instance', { resume: publicId }));
  assert.equal(byHandle.backing, current, 'premise: the handle opens the newest segment');
  assert.notEqual(older, current);

  const mcp = await resumeVia(() => callTool(baseUrl, 'spawn_instance', { resume: older }));
  assert.equal(unwrap(mcp.out).sessionId, publicId, 'the answer is still the handle');
  assert.equal(mcp.backing, older, 'MCP: a named segment must open the transcript it names');

  const rest = await resumeVia(() => api(baseUrl, 'POST', '/api/instances',
    { project: 'a', resume: older, mode: 'bypassPermissions' }));
  assert.equal(rest.out.status, 201, JSON.stringify(rest.out.body));
  assert.equal(rest.backing, older, 'REST: the same input must resolve the same way');
});

test('SESSION_AMBIGUOUS lists FULL public ids, so collision-minted candidates stay distinguishable', async () => {
  // INVARIANT: the candidate list must be actionable. A public id is 8 chars
  // normally but 13 on a mint-time collision (PUBLIC_ID_LEN_EXTENDED,
  // src/sessionLineage.ts), and two of those share their first 8 — truncating
  // the list renders them as the same string, so the refusal tells the caller to
  // "pass more characters" while showing two identical candidates to choose from.
  await spawnLiveWorker();
  const a = 'aabbccdd-1111';
  const b = 'aabbccdd-2222';
  assert.equal(a.length, 13);
  assert.notEqual(a.slice(0, 8), a, 'premise: these ids are longer than the 8-char form');
  instances.byId.set('fake-x1', { id: 'fake-x1', sessionId: a, kill: async () => {} });
  instances.byId.set('fake-x2', { id: 'fake-x2', sessionId: b, kill: async () => {} });
  try {
    const body = unwrap(await callTool(baseUrl, 'send_prompt', { sessionId: 'aabbccdd', text: 'go' }));
    assert.equal(body.code, 'SESSION_AMBIGUOUS');
    assert.deepEqual(body.matches.sort(), [a, b], 'both candidates, in full');
  } finally {
    instances.byId.delete('fake-x1');
    instances.byId.delete('fake-x2');
  }
});
