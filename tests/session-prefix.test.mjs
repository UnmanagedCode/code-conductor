// Tests for sessionId PREFIX resolution at the MCP boundary. A conductor may
// address a worker by any unambiguous prefix of its sessionId (e.g. first 8
// chars) instead of the full 36-char UUID. Resolution happens once, uniformly,
// in the MCP dispatch layer (src/mcp/server.js) via
// InstanceManager.resolveSessionRef (src/instances.js).
//
// Two layers:
//   A. unit — resolveSessionRef branch coverage on a manager with controlled
//      byId entries (deterministic ids that real random UUIDs can't reproduce).
//   B. integration — through the real MCP tools/call dispatch: full-UUID
//      back-compat, unique-prefix resolves, ambiguous-prefix soft-refuses,
//      unknown stays unknown.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InstanceManager, SESSION_PREFIX_MIN } from '../src/instances.js';
import { bootServer, api, waitFor, instForSession, freshProjectsRoot, rmrf } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');

// ---------------------------------------------------------------------------
// A. Unit: resolveSessionRef
// ---------------------------------------------------------------------------

// Build a manager whose byId holds bare {id, sessionId} stand-ins. resolveSessionRef
// only reads `.sessionId`, so these are sufficient and leave no open handles.
function managerWith(sessionIds) {
  const im = new InstanceManager();
  let n = 0;
  for (const sid of sessionIds) im.byId.set(`i${n++}`, { id: `i${n}`, sessionId: sid });
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

test('resolveSessionRef: full id back-compat resolves to itself', () => {
  const full = '1234abcd-5678-90ef-1234-567890abcdef';
  const im = managerWith([full, 'bbbb2222-aaaa']);
  assert.deepEqual(im.resolveSessionRef(full), { sessionId: full });
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

test('full UUID still addresses the worker (back-compat)', async () => {
  const full = await spawnLiveWorker();
  const body = unwrap(await callTool(baseUrl, 'send_prompt', {
    sessionId: full, text: 'go', wait: true, waitTimeoutMs: 5000,
  }));
  assert.equal(body.sessionId, full);
  assert.ok(body.turnEnd, 'turn completed — full id resolved to the live worker');
});

test('unique prefix resolves to the full sessionId', async () => {
  const full = await spawnLiveWorker();
  const prefix = full.slice(0, 8);
  const body = unwrap(await callTool(baseUrl, 'send_prompt', {
    sessionId: prefix, text: 'go', wait: true, waitTimeoutMs: 5000,
  }));
  // The handler echoes the CANONICAL full sessionId — proof the prefix was
  // rewritten at the dispatch boundary before the handler ran.
  assert.equal(body.sessionId, full);
  assert.ok(body.turnEnd, 'turn completed via the resolved worker');
});

test('ambiguous prefix soft-refuses with SESSION_AMBIGUOUS + matches', async () => {
  const full = await spawnLiveWorker();
  const prefix = full.slice(0, 8);
  // Inject a second in-memory session sharing the same 8-char prefix. kill() is a
  // noop so the afterEach shutdown sweep over byId doesn't choke on the stand-in.
  const fakeSid = prefix + 'ffffffff-ffff-ffff-ffff-ffffffffffff'.slice(8);
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
