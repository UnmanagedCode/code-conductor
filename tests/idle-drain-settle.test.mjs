// Tests for the idle task-drain settle wake path (IdleSubscriptionHub
// _onTaskEvent / _fireSettle) — the fix for the orphaned-subscription
// deadlock: a background task completing while its worker is ALREADY idle,
// with NO re-invocation turn ever following (verified real trace: a nested
// Monitor's completion emits only task_updated + task_notification and the
// stream goes silent), used to leave the subscription waiting for a turn_end
// that never comes, until the 30-min watchdog.
//
// The settle must ALSO not reintroduce the wake-one-turn-early bug: an idle
// completion that DOES get a re-invocation turn (2nd system/init + status →
// message_start → turn_end) must wake at that turn's turn_end, not at the
// task event. Guarded two-sided: pre-arm via Instance.idleWindowDirty
// (re-invocation already opening when the drain lands), post-arm via the
// ring-seq freeze check (re-invocation opening after the arm).
//
// Three layers, mirroring tests/idle-subagent-defer.test.mjs +
// tests/mcp-subscribe-to-idle.test.mjs:
//   1. Hub-gate tests (fake instances on the manager 'event' edge)
//   2. Instance-lifecycle tests (_idleWindowDirty edges via _handleStdoutLine)
//   3. End-to-end tests (fake-claude scenarios through the MCP surface)

// The settle length is a module-load-time constant, so the env var must be
// set BEFORE src/instances.js (→ idleSubscriptions.js) is imported — hence
// the dynamic imports below.
process.env.ORCH_IDLE_DRAIN_SETTLE_MS = '400';
const SETTLE_MS = 400;

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { InstanceManager, Instance } = await import('../src/instances.js');
const { bootServer, api, waitFor, instForSession, freshProjectsRoot, rmrf } =
  await import('./helpers.mjs');
const { WAKE_CALLBACK_MARKER, WAKE_BODY_SEP } = await import('../public/wakeCallback.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');
const SCENARIO_IDLE_DRAIN = path.join(__dirname, 'fixtures', 'scenario-bg-task-idle-drain.json');
const SCENARIO_IDLE_REINVOKE = path.join(__dirname, 'fixtures', 'scenario-bg-task-idle-reinvoke.json');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Past the settle deadline with margin, so "did the settle fire?" is decided.
const pastSettle = () => sleep(SETTLE_MS + 250);

// ---------------------------------------------------------------------------
// Layer 1: hub-gate tests with fake instances (pattern of
// idle-subagent-defer.test.mjs, extended with the settle-path surface:
// ring.nextSeq for the freeze check, idleWindowDirty for the pre-arm guard).
// ---------------------------------------------------------------------------

const instances = new InstanceManager();
after(() => instances.shutdown().catch(() => {}));

function makeFake({ id, sessionId, activeAgentTaskCount = 0, taskNotificationPending = false, idleWindowDirty = false }) {
  const _promptCalls = [];
  const inst = {
    id,
    sessionId,
    project: 'test-project',
    proc: { pid: 999 },
    status: 'idle',
    activeAgentTaskCount,
    taskNotificationPending,
    idleWindowDirty,
    _emitUi() {},
    // nextSeq present so the settle path can arm (the hub refuses to arm on a
    // ring whose freeze baseline it can't verify). Tests simulate "an event
    // arrived after the arm" by bumping nextSeq directly.
    ring: { trimmedBefore: 0, nextSeq: 0 },
    ringSnapshot() { return []; },
    async prompt(text, _atts, opts) { _promptCalls.push({ text, opts }); },
  };
  inst._promptCalls = _promptCalls;
  return inst;
}

function emitTurnEnd(id) {
  instances.emit('event', { id, ev: { kind: 'turn_end', isError: false, stopReason: 'end_turn' } });
}
function emitTaskEvent(id, subtype = 'task_notification') {
  instances.emit('event', { id, ev: { kind: 'system', subtype, data: { task_id: 'tX' } } });
}

const tick = () => sleep(20);
const pendingSettles = () => instances._idleHub._pendingSettles;

function inject(cond, work) {
  instances.byId.set(cond.id, cond);
  instances.byId.set(work.id, work);
}
function cleanup(cond, work) {
  instances._idleSubscribers.clear();
  instances._idleHub._cancelAllSettles();
  instances.byId.delete(cond.id);
  instances.byId.delete(work.id);
}

test('orphan repro: idle task-drain with no following turn_end wakes via the settle', async () => {
  const cond = makeFake({ id: 'c1', sessionId: 'cs1' });
  const work = makeFake({ id: 'w1', sessionId: 'ws1', activeAgentTaskCount: 1 });
  inject(cond, work);
  instances.subscribeIdle('cs1', 'ws1', 3000); // watchdog well past the settle
  const subChanges = [];
  const onSub = (e) => subChanges.push(e);
  instances.on('subscription_changed', onSub);

  // Turn ends while the bg task is live → classic defer, subscription kept.
  emitTurnEnd('w1'); await tick();
  assert.equal(cond._promptCalls.length, 0, 'deferred while the subagent runs');
  assert.equal(instances._idleHub.hasSubscriber('ws1'), true);

  // The task drains while the worker is idle — the stream's last words.
  work.activeAgentTaskCount = 0;
  emitTaskEvent('w1', 'task_updated');
  emitTaskEvent('w1', 'task_notification'); // re-arms
  assert.equal(pendingSettles().size, 1, 'settle armed on the idle drain');
  await tick();
  assert.equal(cond._promptCalls.length, 0, 'no wake before the settle window elapses');

  await pastSettle();
  assert.equal(cond._promptCalls.length, 1, 'settle delivered the wake exactly once');
  assert.equal(instances._idleHub.hasSubscriber('ws1'), false, 'subscription consumed');
  assert.equal(pendingSettles().size, 0, 'settle entry self-cleaned');
  assert.ok(subChanges.some(e => e.targetId === 'ws1'), 'subscription_changed emitted on settle-consume');
  assert.equal(instances._idleHub.wasConsumed('ws1'), false,
    '_justConsumed stays turn_end-only (no turn_notification exists at settle-fire)');

  // The watchdog was cancelled by the consume — no second delivery at its deadline.
  await sleep(3200 - SETTLE_MS);
  assert.equal(cond._promptCalls.length, 1, 'watchdog cancelled — still exactly one delivery');

  instances.off('subscription_changed', onSub);
  cleanup(cond, work);
});

test('trap (post-arm evidence): any event after the arm freezes out the settle; turn_end delivers', async () => {
  const cond = makeFake({ id: 'c2', sessionId: 'cs2' });
  const work = makeFake({ id: 'w2', sessionId: 'ws2' });
  inject(cond, work);
  instances.subscribeIdle('cs2', 'ws2');

  emitTaskEvent('w2', 'task_notification');
  assert.equal(pendingSettles().size, 1, 'idle drain armed the settle');
  // The re-invocation's CLI-local init/status writes advance the ring before
  // the settle fires (status stays 'idle' until message_start — the API-bound
  // part the settle must NOT outwait).
  work.ring.nextSeq += 2;

  await pastSettle();
  assert.equal(cond._promptCalls.length, 0, 'frozen-stream check failed → no early wake');
  assert.equal(instances._idleHub.hasSubscriber('ws2'), true, 'one-shot subscription NOT consumed');

  // The re-invocation turn completes — the classic path owns the wake.
  emitTurnEnd('w2'); await tick();
  assert.equal(cond._promptCalls.length, 1, 'woken exactly once, at the re-invocation turn_end');
  cleanup(cond, work);
});

test('trap (pre-arm evidence): a dirty idle window refuses to arm; turn_end delivers', async () => {
  // Review Finding 1: task B drains while task A's re-invocation is ALREADY
  // opening (its init/status written before B's drain events, its
  // message_start still waiting on the API). The freeze check cannot see
  // evidence behind the arm point — idleWindowDirty does.
  const cond = makeFake({ id: 'c3', sessionId: 'cs3' });
  const work = makeFake({ id: 'w3', sessionId: 'ws3', idleWindowDirty: true });
  inject(cond, work);
  instances.subscribeIdle('cs3', 'ws3');

  emitTaskEvent('w3', 'task_updated');
  emitTaskEvent('w3', 'task_notification');
  assert.equal(pendingSettles().size, 0, 'dirty idle window → no arm');

  await pastSettle();
  assert.equal(cond._promptCalls.length, 0, 'no wake while the re-invocation is pending');
  assert.equal(instances._idleHub.hasSubscriber('ws3'), true);

  // The re-invocation turn_end (which also resets the dirty flag on a real
  // Instance) delivers through the unchanged path.
  work.idleWindowDirty = false;
  emitTurnEnd('w3'); await tick();
  assert.equal(cond._promptCalls.length, 1);
  cleanup(cond, work);
});

test('gate blocks arming: mid-turn / pending notification / live tasks / no ring baseline', async () => {
  const cond = makeFake({ id: 'c4', sessionId: 'cs4' });
  const work = makeFake({ id: 'w4', sessionId: 'ws4' });
  inject(cond, work);
  instances.subscribeIdle('cs4', 'ws4');

  // P2: a task draining MID-TURN arms nothing (that turn's turn_end wakes).
  work.status = 'turn';
  emitTaskEvent('w4', 'task_notification');
  assert.equal(pendingSettles().size, 0, 'mid-turn drain → no arm');
  work.status = 'idle';

  // P3: idle with an owed re-invocation (taskNotificationPending) arms nothing.
  work.taskNotificationPending = true;
  emitTaskEvent('w4', 'task_notification');
  assert.equal(pendingSettles().size, 0, 'pending notification → no arm');
  work.taskNotificationPending = false;

  // Live tasks remaining arms nothing.
  work.activeAgentTaskCount = 1;
  emitTaskEvent('w4', 'task_updated');
  assert.equal(pendingSettles().size, 0, 'tasks still live → no arm');
  work.activeAgentTaskCount = 0;

  // No verifiable freeze baseline (ring without nextSeq) arms nothing.
  const bare = makeFake({ id: 'w4b', sessionId: 'ws4b' });
  bare.ring = { trimmedBefore: 0 }; // pre-settle fake shape
  instances.byId.set('w4b', bare);
  instances.subscribeIdle('cs4', 'ws4b');
  emitTaskEvent('w4b', 'task_notification');
  assert.equal(pendingSettles().size, 0, 'no ring.nextSeq → no arm');

  await pastSettle();
  assert.equal(cond._promptCalls.length, 0, 'nothing armed → nothing fired');
  instances.byId.delete('w4b');
  cleanup(cond, work);
});

test('a gate-false task event cancels a pending settle', async () => {
  const cond = makeFake({ id: 'c5', sessionId: 'cs5' });
  const work = makeFake({ id: 'w5', sessionId: 'ws5' });
  inject(cond, work);
  instances.subscribeIdle('cs5', 'ws5');

  emitTaskEvent('w5', 'task_notification');
  assert.equal(pendingSettles().size, 1);
  // A new bg task starts before the settle fires; its task_updated progress
  // patch arrives with count > 0 → the pending settle is stale.
  work.activeAgentTaskCount = 1;
  work.ring.nextSeq += 1;
  emitTaskEvent('w5', 'task_updated');
  assert.equal(pendingSettles().size, 0, 'gate-false task event cancelled the settle');

  await pastSettle();
  assert.equal(cond._promptCalls.length, 0);
  assert.equal(instances._idleHub.hasSubscriber('ws5'), true);
  cleanup(cond, work);
});

test('fire-time drops: status flip (P8), instance removal, proc replacement (respawn/rewind)', async () => {
  const cond = makeFake({ id: 'c6', sessionId: 'cs6' });

  // (a) P8 — a prompt() flips status to 'turn' before the settle fires.
  const w6a = makeFake({ id: 'w6a', sessionId: 'ws6a' });
  inject(cond, w6a);
  instances.subscribeIdle('cs6', 'ws6a');
  emitTaskEvent('w6a', 'task_notification');
  w6a.status = 'turn';
  // (b) removal — the instance disappears from byId before the settle fires.
  const w6b = makeFake({ id: 'w6b', sessionId: 'ws6b' });
  instances.byId.set('w6b', w6b);
  instances.subscribeIdle('cs6', 'ws6b');
  emitTaskEvent('w6b', 'task_notification');
  instances.byId.delete('w6b');
  // (c) respawn/rewind — same Instance and instanceId, NEW proc (and a reset
  // ring that could coincidentally land on armSeq — the proc pin must drop it).
  const w6c = makeFake({ id: 'w6c', sessionId: 'ws6c' });
  instances.byId.set('w6c', w6c);
  instances.subscribeIdle('cs6', 'ws6c');
  emitTaskEvent('w6c', 'task_notification');
  w6c.proc = { pid: 1000 }; // ring.nextSeq left equal to armSeq on purpose

  assert.equal(pendingSettles().size, 3);
  await pastSettle();
  assert.equal(cond._promptCalls.length, 0, 'all three fire-time checks dropped the settle');
  assert.equal(instances._idleHub.hasSubscriber('ws6a'), true);
  assert.equal(instances._idleHub.hasSubscriber('ws6b'), true);
  assert.equal(instances._idleHub.hasSubscriber('ws6c'), true);
  assert.equal(pendingSettles().size, 0, 'dropped settles self-cleaned');

  // P8 tail: the prompted turn's turn_end delivers normally.
  w6a.status = 'idle';
  emitTurnEnd('w6a'); await tick();
  assert.equal(cond._promptCalls.length, 1);

  instances._idleSubscribers.clear();
  instances._idleHub._cancelAllSettles();
  for (const id of ['c6', 'w6a', 'w6b', 'w6c']) instances.byId.delete(id);
});

test('re-arm: a later task event resets the freeze baseline', async () => {
  const cond = makeFake({ id: 'c7', sessionId: 'cs7' });
  const work = makeFake({ id: 'w7', sessionId: 'ws7' });
  inject(cond, work);
  instances.subscribeIdle('cs7', 'ws7');

  emitTaskEvent('w7', 'task_updated'); // arms at nextSeq 0
  work.ring.nextSeq = 5;               // events arrived since (e.g. the notification itself)
  emitTaskEvent('w7', 'task_notification'); // re-arms at nextSeq 5
  assert.equal(pendingSettles().size, 1);

  await pastSettle();
  assert.equal(cond._promptCalls.length, 1, 're-armed baseline matches → fires');
  cleanup(cond, work);
});

test('P5: settle armed-then-dropped still falls back to the watchdog, exactly once', async () => {
  const cond = makeFake({ id: 'c8', sessionId: 'cs8' });
  const work = makeFake({ id: 'w8', sessionId: 'ws8' });
  inject(cond, work);
  instances.subscribeIdle('cs8', 'ws8', 1200); // watchdog past the settle

  emitTaskEvent('w8', 'task_notification');
  work.ring.nextSeq += 1; // stream moved → settle will drop; no turn_end ever follows

  await pastSettle();
  assert.equal(cond._promptCalls.length, 0, 'settle dropped, watchdog not yet due');
  await sleep(1200 - SETTLE_MS + 200);
  assert.equal(cond._promptCalls.length, 1, 'watchdog fired exactly once');
  assert.match(cond._promptCalls[0].text, /did NOT finish/);
  assert.equal(pendingSettles().size, 0);
  cleanup(cond, work);
});

test('housekeeping: turn_end / purge / unsubscribe / watchdog all cancel a pending settle', async () => {
  const cond = makeFake({ id: 'c9', sessionId: 'cs9' });

  // turn_end consume cancels (and delivers through the classic path, once).
  const w9a = makeFake({ id: 'w9a', sessionId: 'ws9a' });
  inject(cond, w9a);
  instances.subscribeIdle('cs9', 'ws9a');
  emitTaskEvent('w9a', 'task_notification');
  assert.equal(pendingSettles().has('ws9a'), true);
  emitTurnEnd('w9a');
  assert.equal(pendingSettles().has('ws9a'), false, 'turn_end cancelled the settle');
  await tick();
  assert.equal(cond._promptCalls.length, 1);
  await pastSettle();
  assert.equal(cond._promptCalls.length, 1, 'no settle double-delivery after turn_end consumed');

  // purge as target cancels.
  const w9b = makeFake({ id: 'w9b', sessionId: 'ws9b' });
  instances.byId.set('w9b', w9b);
  instances.subscribeIdle('cs9', 'ws9b');
  emitTaskEvent('w9b', 'task_notification');
  assert.equal(pendingSettles().has('ws9b'), true);
  instances._purgeIdleFor('ws9b');
  assert.equal(pendingSettles().has('ws9b'), false, 'purge(target) cancelled the settle');

  // purge as (sole) caller of another target cancels that target's settle.
  const w9c = makeFake({ id: 'w9c', sessionId: 'ws9c' });
  instances.byId.set('w9c', w9c);
  instances.subscribeIdle('cs9', 'ws9c');
  emitTaskEvent('w9c', 'task_notification');
  assert.equal(pendingSettles().has('ws9c'), true);
  instances._purgeIdleFor('cs9'); // cond goes away as caller
  assert.equal(pendingSettles().has('ws9c'), false, 'purge(caller) cancelled the orphaned settle');

  // unsubscribe of the last caller cancels.
  const w9d = makeFake({ id: 'w9d', sessionId: 'ws9d' });
  instances.byId.set('w9d', w9d);
  instances.subscribeIdle('cs9', 'ws9d');
  emitTaskEvent('w9d', 'task_notification');
  assert.equal(pendingSettles().has('ws9d'), true);
  instances.unsubscribeIdle('cs9', 'ws9d');
  assert.equal(pendingSettles().has('ws9d'), false, 'unsubscribe cancelled the settle');

  // watchdog fire (emptying the subs map) cancels; single timeout delivery.
  const w9e = makeFake({ id: 'w9e', sessionId: 'ws9e' });
  instances.byId.set('w9e', w9e);
  instances.subscribeIdle('cs9', 'ws9e', 60); // watchdog BEFORE the settle deadline
  emitTaskEvent('w9e', 'task_notification');
  assert.equal(pendingSettles().has('ws9e'), true);
  await sleep(200);
  assert.equal(pendingSettles().has('ws9e'), false, 'watchdog fire cancelled the settle');
  await pastSettle();
  const timeouts = cond._promptCalls.filter(c => /did NOT finish/.test(c.text));
  assert.equal(timeouts.length, 1, 'exactly one watchdog delivery, no settle follow-up');

  instances._idleSubscribers.clear();
  instances._idleHub._cancelAllSettles();
  for (const id of ['c9', 'w9a', 'w9b', 'w9c', 'w9d', 'w9e']) instances.byId.delete(id);
});

// ---------------------------------------------------------------------------
// Layer 2: Instance-lifecycle tests — the _idleWindowDirty set/clear edges,
// driven through a real (unspawned) Instance's _handleStdoutLine.
// ---------------------------------------------------------------------------

function makeInstance() {
  return new Instance({
    id: 'i-dirty', project: 'test-project', cwd: '/nonexistent-cwd',
    mode: 'plan', effort: 'high', thinking: 'adaptive', model: null,
  });
}

const line = (obj) => JSON.stringify(obj);
const MESSAGE_START = line({
  type: 'stream_event',
  event: { type: 'message_start', message: { id: 'msg_1', role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 0 } } },
});
const TURN_END = line({
  type: 'result', subtype: 'success', stop_reason: 'end_turn', duration_ms: 1,
  total_cost_usd: 0, is_error: false,
});
const INIT = line({ type: 'system', subtype: 'init', session_id: 'sid-dirty', model: 'claude-sonnet-5' });
const STATUS = line({ type: 'system', subtype: 'status', status: 'requesting' });
const taskUpdated = (taskId) => line({
  type: 'system', subtype: 'task_updated', task_id: taskId, patch: { status: 'completed', end_time: 1 },
});
const taskNotification = (taskId) => line({
  type: 'system', subtype: 'task_notification', task_id: taskId, status: 'completed', output_file: '',
});

test('lifecycle: idle-time task events keep the window clean; init/status dirty it', () => {
  const inst = makeInstance();
  assert.equal(inst.idleWindowDirty, false, 'starts clean');
  // Pure task bookkeeping while idle — stays clean (the orphan drain shape).
  inst._handleStdoutLine(taskUpdated('t1'));
  inst._handleStdoutLine(taskNotification('t1'));
  assert.equal(inst.idleWindowDirty, false, 'idle task events do not dirty the window');
  // A re-invocation announces itself: idle-time init (and status) dirty it.
  inst._handleStdoutLine(INIT);
  assert.equal(inst.idleWindowDirty, true, 'idle-time system/init dirties the window');
  inst._handleStdoutLine(STATUS);
  assert.equal(inst.idleWindowDirty, true);
});

test('lifecycle: turn_end starts a fresh clean window; mid-turn events do not dirty', () => {
  const inst = makeInstance();
  inst._handleStdoutLine(INIT); // dirty while idle
  assert.equal(inst.idleWindowDirty, true);
  inst._handleStdoutLine(MESSAGE_START); // idle→turn
  assert.equal(inst.status, 'turn');
  // Mid-turn traffic must not touch the flag (it describes the IDLE window).
  inst._handleStdoutLine(STATUS);
  inst._handleStdoutLine(taskNotification('t9')); // mid-turn completion
  inst._handleStdoutLine(TURN_END);
  assert.equal(inst.status, 'idle');
  assert.equal(inst.idleWindowDirty, false, 'turn_end resets the window clean');
  // And a subsequent pure drain keeps it clean.
  inst._handleStdoutLine(taskUpdated('t2'));
  assert.equal(inst.idleWindowDirty, false);
});

// ---------------------------------------------------------------------------
// Layer 3: end-to-end through the MCP surface with fake-claude scenarios.
// ---------------------------------------------------------------------------

let ctx, baseUrl, srvInstances, home;
before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO_WS });
  ({ baseUrl } = ctx);
  srvInstances = ctx.instances;
});
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => {
  await srvInstances.shutdown();
  srvInstances._idleSubscribers?.clear();
  srvInstances._idleHub?._cancelAllSettles();
  await rmrf(home);
});

let nextRpcId = 1;
async function rpc(method, params, { caller } = {}) {
  const id = nextRpcId++;
  const url = baseUrl + '/mcp' + (caller ? `?caller=${encodeURIComponent(caller)}` : '');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { status: res.status, body: await res.json() };
}
async function callTool(name, args, opts) {
  const { body } = await rpc('tools/call', { name, arguments: args }, opts);
  assert.ok(body?.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return JSON.parse(body.result.content[0].text);
}
async function spawnReadyWithScenario(project, scenarioPath) {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  if (scenarioPath) process.env.FAKE_CLAUDE_SCENARIO = scenarioPath;
  try {
    const spawn = await callTool('spawn_instance', { project, mode: 'bypassPermissions' });
    await waitFor(() => instForSession(srvInstances, spawn.sessionId)?.status === 'idle');
    return spawn.sessionId;
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
}
const wakeStubs = (inst, targetId) => inst.ringSnapshot().filter(ev =>
  ev.kind === 'user_echo' && typeof ev.text === 'string'
  && ev.text.includes(targetId) && ev.text.includes('get_recent_messages'));

test('e2e orphan: bg task drains at idle with no re-invocation → settle wakes the caller', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReadyWithScenario('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_IDLE_DRAIN);

  const sub = await callTool('subscribe_to_idle', { sessionId: targetId }, { caller: callerId });
  assert.equal(sub.already, false);

  // Drive the target's single turn: turn_end fires while the bg task is live
  // (deferred), then task_updated + task_notification arrive at idle and the
  // stream goes silent — the orphan repro.
  await callTool('send_prompt', { sessionId: targetId, text: 'go', wait: true, waitTimeoutMs: 5000 });
  assert.equal(srvInstances._idleHub.hasSubscriber(targetId), true,
    'deferred at turn_end (bg task still live)');

  const caller = instForSession(srvInstances, callerId);
  await waitFor(() => wakeStubs(caller, targetId).length > 0);
  const stubs = wakeStubs(caller, targetId);
  assert.equal(stubs.length, 1, 'exactly one wake delivered');
  assert.ok(stubs[0].text.startsWith(WAKE_CALLBACK_MARKER), 'idle caller gets the folded stub');
  assert.ok(stubs[0].text.includes(WAKE_BODY_SEP), 'folded stub carries the payload fold');
  assert.equal(srvInstances._idleHub.hasSubscriber(targetId), false, 'subscription consumed');

  // Proves the wake came from the settle: the worker's stream ended at ONE
  // turn_end (no re-invocation turn ever ran).
  const target = instForSession(srvInstances, targetId);
  assert.equal(target.ringSnapshot().filter(ev => ev.kind === 'turn_end').length, 1);
});

test('e2e trap: idle completion WITH a re-invocation turn → no early wake, single wake at its turn_end', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const callerId = await spawnReadyWithScenario('p');
  const targetId = await spawnReadyWithScenario('p', SCENARIO_IDLE_REINVOKE);

  await callTool('subscribe_to_idle', { sessionId: targetId }, { caller: callerId });
  await callTool('send_prompt', { sessionId: targetId, text: 'go', wait: true, waitTimeoutMs: 8000 });

  const caller = instForSession(srvInstances, callerId);
  const target = instForSession(srvInstances, targetId);

  // Fixture timing (150ms spacing): notification → init(+150) → status(+300)
  // → message_start(+450) …; the 400ms settle deadline falls BEFORE the
  // re-invocation's message_start, i.e. inside the API-bound silence where a
  // broken settle would fire early. When the second message_start is visible
  // the deadline has passed — assert nothing fired.
  try {
    await waitFor(() => target.ringSnapshot().filter(ev => ev.kind === 'message_start').length >= 2);
  } catch (err) {
    err.message += ` | ring=[${target.ringSnapshot().map(e => e.kind + (e.subtype ? ':' + e.subtype : '')).join(',')}]`
      + ` | status=${target.status} proc=${!!target.proc}`;
    throw err;
  }
  assert.equal(wakeStubs(caller, targetId).length, 0,
    'no wake during the notification → re-invocation window');
  assert.equal(srvInstances._idleHub.hasSubscriber(targetId), true, 'one-shot not consumed early');

  // The re-invocation turn's turn_end delivers — exactly once.
  await waitFor(() => wakeStubs(caller, targetId).length > 0);
  await sleep(SETTLE_MS + 250); // past any straggler settle
  assert.equal(wakeStubs(caller, targetId).length, 1, 'exactly one wake, no settle double-fire');
  assert.equal(srvInstances._idleHub.hasSubscriber(targetId), false);
  assert.equal(target.ringSnapshot().filter(ev => ev.kind === 'turn_end').length, 2,
    'the wake corresponds to the re-invocation turn completing');
});
