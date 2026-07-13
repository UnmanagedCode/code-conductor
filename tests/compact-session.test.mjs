// Integration tests for the compact_session MCP tool — a managed, server-driven
// `/clear` that rotates the calling session's context in place (same process,
// new sessionId) and reseeds it with a self-authored summary. See
// src/sessionCompact.js + src/mcp/handlers.js (compactSession).
//
// The fake CLI can't call MCP tools, so each test arms the compaction out of
// band (POST /mcp?caller=<sid>) and then drives a turn_end with send_prompt —
// faithfully standing in for the model finishing the turn the tool was called
// in. The fixture's `/clear` turn emits a system/init with a fixed NEW sessionId
// so the real Instance rotation-follow fires; observing that rotation is itself
// proof the `/clear` text was written to the CLI and matched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession } from './helpers.mjs';
import { isConducted } from '../src/conductedSessions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-compact.json');
// Must match the session_id the `/clear` turn emits in scenario-compact.json.
const NEW_SID = 'c0000000-0000-4000-8000-000000000001';

let nextRpcId = 1;
async function rpc(baseUrl, method, params, { caller } = {}) {
  const url = baseUrl + '/mcp' + (caller ? `?caller=${encodeURIComponent(caller)}` : '');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextRpcId++, method, params }),
  });
  return { status: res.status, body: await res.json() };
}
async function callTool(baseUrl, name, args, opts) {
  const { body } = await rpc(baseUrl, 'tools/call', { name, arguments: args }, opts);
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return JSON.parse(body.result.content[0].text);
}
const userTexts = (transcript) =>
  transcript.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((o) => o.type === 'user')
    .map((o) => (o.message?.content ?? []).map((c) => c.text ?? '').join(' '));

test('compact_session drives a /clear that rotates the session in place and reseeds with the summary', async () => {
  const transcript = path.join(os.tmpdir(), `compact-tx-${process.pid}.jsonl`);
  await fs.rm(transcript, { force: true });
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcript;
  const srv = await bootServer({ scenarioPath: SCENARIO, realProcess: true });
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    // Plain, non-conducted (UI-spawned) worker — the tool must work for any
    // code-conductor-managed session, not just orchestrator-spawned ones.
    const spawn = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    assert.equal(spawn.status, 201);
    const sid1 = spawn.body.sessionId;
    const instanceId = spawn.body.id;
    await waitFor(() => instForSession(srv.instances, sid1)?.status === 'idle');
    const pidBefore = instForSession(srv.instances, sid1).pid;

    const armed = await callTool(srv.baseUrl, 'compact_session', { summary: 'HANDOFF-XYZ: finish task Q' }, { caller: sid1 });
    assert.equal(armed.ok, true);
    assert.equal(armed.willClearAtTurnEnd, true);

    // End the turn the tool was "called in" → the compaction fires.
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sid1, text: 'go1' });

    await waitFor(() => instForSession(srv.instances, NEW_SID)?.status === 'idle');
    const rotated = instForSession(srv.instances, NEW_SID);
    assert.ok(rotated, 'a live instance now carries the rotated sessionId');
    assert.equal(rotated.id, instanceId, 'same Instance object across the in-place clear');
    assert.equal(rotated.pid, pidBefore, 'same OS process (pid unchanged) — in-place clear, not respawn');
    assert.equal(instForSession(srv.instances, sid1), undefined, 'old sessionId no longer maps to a live instance');

    const seedEcho = rotated.ringSnapshot().find(
      (ev) => ev.kind === 'user_echo' && typeof ev.text === 'string' && ev.text.includes('HANDOFF-XYZ'));
    assert.ok(seedEcho, 'summary was injected as a user turn on the cleared session');

    await waitFor(async () => (await fs.readFile(transcript, 'utf8').catch(() => '')).includes('HANDOFF-XYZ'));
    const texts = userTexts(await fs.readFile(transcript, 'utf8'));
    const iGo = texts.findIndex((t) => t.includes('go1'));
    const iClear = texts.findIndex((t) => t.trim() === '/clear');
    const iSeed = texts.findIndex((t) => t.includes('HANDOFF-XYZ'));
    assert.ok(iGo >= 0 && iClear > iGo && iSeed > iClear,
      `stdin order should be go1 < /clear < seed; got ${JSON.stringify(texts)}`);
  } finally {
    await srv.close();
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    await fs.rm(transcript, { force: true });
  }
});

test('compact_session preserves the conducted marker across the rotation', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await callTool(srv.baseUrl, 'spawn_instance', { project: 'p', mode: 'bypassPermissions' });
    const sid1 = spawn.sessionId;
    await waitFor(() => instForSession(srv.instances, sid1)?.status === 'idle');
    const id = instForSession(srv.instances, sid1).id;
    assert.equal(instForSession(srv.instances, sid1).conducted, true, 'spawn_instance yields a conducted worker');

    await callTool(srv.baseUrl, 'compact_session', { summary: 'carry on with the migration' }, { caller: sid1 });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sid1, text: 'go1' });

    await waitFor(() => instForSession(srv.instances, NEW_SID)?.status === 'idle');
    const rotated = instForSession(srv.instances, NEW_SID);
    assert.equal(rotated.id, id, 'same Instance across the clear');
    assert.equal(rotated.conducted, true, 'rotated session is still conducted');
    // The durable conducted marker followed the rotation onto the new sessionId.
    await waitFor(async () => await isConducted(NEW_SID));
  } finally {
    await srv.close();
  }
});

test('compact_session re-keys the caller\'s outgoing idle subscription onto the rotated sessionId (no orphan)', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    // `worker` is watched; `sub` watches it and then compacts ITSELF — the
    // self-compact case where the caller's own sessionId rotates while it holds
    // an outgoing subscription keyed by that (now dead) id.
    const worker = await callTool(srv.baseUrl, 'spawn_instance', { project: 'p', mode: 'bypassPermissions' });
    const sub = await callTool(srv.baseUrl, 'spawn_instance', { project: 'p', mode: 'bypassPermissions' });
    const wSid = worker.sessionId, sSid = sub.sessionId;
    await waitFor(() => instForSession(srv.instances, wSid)?.status === 'idle'
      && instForSession(srv.instances, sSid)?.status === 'idle');

    await callTool(srv.baseUrl, 'subscribe_to_idle', { sessionId: wSid }, { caller: sSid });
    let snap = srv.instances._idleSubscriberSnapshot();
    assert.ok(snap[wSid]?.includes(sSid), 'subscription registered under the caller\'s original sid');

    await callTool(srv.baseUrl, 'compact_session', { summary: 'keep watching the worker' }, { caller: sSid });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sSid, text: 'go1' });
    await waitFor(() => instForSession(srv.instances, NEW_SID)?.status === 'idle');

    snap = srv.instances._idleSubscriberSnapshot();
    assert.ok(snap[wSid]?.includes(NEW_SID), 'subscription re-keyed onto the rotated caller sid');
    assert.ok(!snap[wSid]?.includes(sSid), 'stale caller sid dropped — not orphaned on the dead id');
  } finally {
    await srv.close();
  }
});

test('compact_session defers the /clear while an overage-queued turn is pending, then proceeds once it drains', async () => {
  const srv = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await callTool(srv.baseUrl, 'spawn_instance', { project: 'p', mode: 'bypassPermissions' });
    const sid1 = spawn.sessionId;
    await waitFor(() => instForSession(srv.instances, sid1)?.status === 'idle');
    const id = instForSession(srv.instances, sid1).id;

    await callTool(srv.baseUrl, 'compact_session', { summary: 'compact me later' }, { caller: sid1 });
    const inst = instForSession(srv.instances, sid1);
    // Stand in for a user turn parked in the overage queue at turn_end (the real
    // stop→idle-with-queued-work case). We drive the armed turn_end DIRECTLY
    // rather than via send_prompt: a real prompt fires user_prompt → cancel(),
    // which empties _overageQueue (overageResume.js) — so it could never leave a
    // queued entry standing at turn_end. This isolates the controller's defer gate.
    inst._overageQueue.push({ text: 'queued task', attachments: [], ts: 1 });
    srv.instances.emit('event', { id, ev: { kind: 'turn_end' } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(instForSession(srv.instances, NEW_SID), undefined, 'no rotation while a queued turn is pending');
    const pend = srv.instances._sessionCompact.pending.get(id);
    assert.ok(pend && pend.state === 'armed', 'compaction is still armed (deferred), not fired');

    // Drain the queue and drive another turn_end — the compaction now proceeds.
    inst._overageQueue.length = 0;
    srv.instances.emit('event', { id, ev: { kind: 'turn_end' } });
    await waitFor(() => instForSession(srv.instances, NEW_SID)?.status === 'idle');
    assert.ok(instForSession(srv.instances, NEW_SID), 'rotation proceeds once the queue drains');
    assert.ok(!srv.instances._sessionCompact.pending.has(id), 'pending compaction consumed');
  } finally {
    await srv.close();
  }
});

// Real-binary confirmation that `_sendRaw` of a `/clear` user message actually
// rotates the session on the real claude CLI (the fake fixture only simulates
// the rotation). Gated behind RUN_REAL_CLAUDE=1 — needs auth + network.
test('compact_session against the real claude binary rotates the sessionId', { skip: process.env.RUN_REAL_CLAUDE !== '1' }, async () => {
  const srv = await bootServer({ useRealClaude: true });
  try {
    await api(srv.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = await api(srv.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const sid1 = spawn.body.sessionId;
    await waitFor(() => instForSession(srv.instances, sid1)?.status === 'idle', { timeout: 30000 });
    const pidBefore = instForSession(srv.instances, sid1).pid;

    await callTool(srv.baseUrl, 'compact_session', { summary: 'REAL-SMOKE: continue' }, { caller: sid1 });
    await callTool(srv.baseUrl, 'send_prompt', { sessionId: sid1, text: 'hello' });

    await waitFor(() => {
      const cur = srv.instances.get(instForSession(srv.instances, sid1)?.id ?? spawn.body.id);
      return cur && cur.sessionId !== sid1 && cur.status === 'idle';
    }, { timeout: 60000 });
    const rotated = srv.instances.get(spawn.body.id);
    assert.notEqual(rotated.sessionId, sid1, 'real /clear rotated the sessionId');
    assert.equal(rotated.pid, pidBefore, 'same process across the real /clear');
  } finally {
    await srv.close();
  }
});
