// Tests for the post-hard-abort drain window (see src/instances.ts _openDrainWindow).
//
// The drain window kills spurious new turns that the CLI starts by dequeuing
// messages it had buffered before the hard abort (e.g. the soft-interrupt steer
// written mid-turn). The spurious turn announces itself with a system/init event
// on the 'event' channel ~39ms after the abort — well before any API round-trip.
//
// Tests drive the drain by injecting synthetic system/init events directly via
// inst._handleStdoutLine() — deterministic and independent of subprocess timing.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-drain-window.json');

let ctx, baseUrl, instances, home;
const cleanupListeners = [];

before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  ctx.projectsRoot = r.projectsRoot;
  ctx.claudeProjectsRoot = r.claudeProjectsRoot;
});
afterEach(async () => {
  await instances.shutdown();
  for (const fn of cleanupListeners.splice(0)) fn();
  await rmrf(home);
});

function collectEvents(instances) {
  const events = [];
  const handler = ({ id, ev }) => events.push({ id, ev });
  instances.on('event', handler);
  cleanupListeners.push(() => instances.off('event', handler));
  return events;
}

async function setupInstance() {
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
  assert.equal(r.status, 201);
  const id = r.body.id;
  const inst = instances.get(id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  return { id, inst };
}

// Inject a synthetic system/init event directly into the instance's
// stdout processing path — simulates the CLI starting a spurious turn
// after the hard abort without any subprocess timing dependency.
function injectSpuriousInit(inst) {
  inst._handleStdoutLine(JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: inst.sessionId,
    cwd: inst.cwd,
    permissionMode: inst.mode,
    tools: [],
  }));
}

// Run the slow turn through hard abort and wait for idle.
// Returns the events array (shared reference) populated after the turn.
async function runHardAbort(id, inst, events) {
  inst.prompt('start slow');
  await waitFor(() => events.some(e => e.id === id && e.ev.kind === 'text_delta'));
  assert.equal(inst.status, 'turn');

  await inst.interrupt({ force: true });
  // _openDrainWindow() is called synchronously here (same microtask as ACK).
  await waitFor(() => inst.status === 'idle');
  assert.ok(inst._drainListener !== null, 'drain listener is attached after hard abort');
  assert.ok(inst._drainTimer !== null, 'drain timer is active after hard abort');
}

test('system/init during drain window triggers drain_abort and fires interrupt', async () => {
  const events = collectEvents(instances);
  const { id, inst } = await setupInstance();

  await runHardAbort(id, inst, events);

  const beforeDrain = events.length;

  // Inject the spurious init — simulates CLI dequeuing a buffered message.
  injectSpuriousInit(inst);

  // drain_abort system event must appear synchronously (emitted by _emitUi before
  // the async _controlRequest is dispatched).
  const drainEvs = events.filter(e => e.id === id && e.ev.kind === 'system' && e.ev.subtype === 'drain_abort');
  assert.equal(drainEvs.length, 1, 'exactly one drain_abort emitted');
  assert.equal(drainEvs[0].ev.data.count, 1, 'drain count is 1');

  // The init event itself was also emitted (the drain does not suppress it).
  const initEvs = events.slice(beforeDrain).filter(e => e.id === id && e.ev.kind === 'system' && e.ev.subtype === 'init');
  assert.equal(initEvs.length, 1, 'init event emitted through to ring');

  // Window remains open for subsequent spurious inits.
  assert.ok(inst._drainTimer !== null, 'drain timer was reset (window slid)');
  assert.ok(inst._drainListener !== null, 'drain listener still attached');
});

// Invariant (INV-1 guard: no drain window open): a turn the drain severs at its
// opener is not a turn for cc. An init or a UserPromptSubmit hook_started inside
// the window, after the aborted turn's result, leaves the status `idle` and emits
// no `turn_start` (so no owner is armed for it).
test('an opener inside the drain window does not start a turn', async () => {
  const events = collectEvents(instances);
  const { id, inst } = await setupInstance();

  await runHardAbort(id, inst, events);
  const starts = [];
  const onStart = () => starts.push(inst.status);
  inst.on('turn_start', onStart);
  cleanupListeners.push(() => inst.off('turn_start', onStart));

  inst._handleStdoutLine(JSON.stringify({
    type: 'system', subtype: 'hook_started', hook_id: '00000000-0000-4000-8000-000000000001',
    hook_name: 'UserPromptSubmit', hook_event: 'UserPromptSubmit', session_id: inst.sessionId,
  }));
  injectSpuriousInit(inst);

  assert.equal(inst.status, 'idle', 'still idle');
  assert.deepEqual(starts, [], 'no turn_start');
  const drainEvs = events.filter(e => e.id === id && e.ev.kind === 'system' && e.ev.subtype === 'drain_abort');
  assert.equal(drainEvs.length, 1, 'premise: the init was drained');
});

// Invariant (the queued-prompt flag never outlives the CLI-held input it stands
// for): a write queued in a turn that is then hard-aborted is discarded by the
// drain, which severs the turn the CLI opens for it. queuedPromptPending is false
// once that turn is severed, so a later wake delivered to the idle instance is
// not marked queued and does not park.
test('a queued write severed by the drain clears queuedPromptPending; a later idle wake does not park', async () => {
  const events = collectEvents(instances);
  const { id, inst } = await setupInstance();
  inst.prompt('start slow');
  await waitFor(() => events.some(e => e.id === id && e.ev.kind === 'text_delta'));
  // A wake written into the running turn (the fake CLI holds it: no scenario turn).
  await inst.prompt('queued wake', [], { internal: true, annotateIfMidTurn: false });
  assert.equal(inst.queuedPromptPending, true, 'premise: written into a running turn');
  await inst.interrupt({ force: true });
  await waitFor(() => inst.status === 'idle');
  assert.ok(inst._drainListener !== null, 'premise: drain window open');

  // The CLI dequeues the held write and opens a turn for it; the drain severs it.
  injectSpuriousInit(inst);
  assert.equal(events.filter(e => e.id === id && e.ev.kind === 'system' && e.ev.subtype === 'drain_abort').length, 1,
    'premise: severed');
  assert.equal(inst.status, 'idle');
  const heldAfterSever = inst.queuedPromptPending;
  inst._closeDrainWindow();

  // A later wake to the now-idle instance, from a worker it owns.
  const hub = instances._idleHub;
  const worker = {
    id: 'w-drain', sessionId: 'w-drain-sid', project: 'demo', proc: { pid: 1 }, status: 'turn',
    acceptsMidTurnSteering: true, steerPending: false, activeAgentTaskCount: 0, taskNotificationPending: false,
    rotationPending: false, _stopInterruptedTurn: false, _emitUi() {}, ring: { trimmedBefore: 0 },
    ringSnapshot() { return []; }, async prompt() {}, async interrupt() {},
  };
  instances.byId.set(worker.id, worker);
  let parked;
  try {
    hub._buildFoldedStub = async () => 'stub';
    instances.noteDispatch(inst.sessionId, worker.sessionId);
    hub.onTurnStart(worker.id);
    worker.status = 'idle';
    instances.emit('event', { id: worker.id, ev: { kind: 'turn_end', isError: false, stopReason: 'end_turn' } });
    await waitFor(() => !hub._inFlight.has(id) || hub._parked.has(id));
    parked = hub._parked.has(id);
  } finally {
    instances.byId.delete(worker.id);
  }
  assert.equal(parked, false, 'the later idle wake is not parked');
  assert.equal(inst.queuedPromptPending, false);
  assert.equal(heldAfterSever, false, 'the severed write was no longer held');
});

test('multiple system/init events each trigger a drain, window slides', async () => {
  const events = collectEvents(instances);
  const { id, inst } = await setupInstance();

  await runHardAbort(id, inst, events);

  // Inject three spurious inits in sequence.
  injectSpuriousInit(inst);
  injectSpuriousInit(inst);
  injectSpuriousInit(inst);

  const drainEvs = events.filter(e => e.id === id && e.ev.kind === 'system' && e.ev.subtype === 'drain_abort');
  assert.equal(drainEvs.length, 3, 'three drain_abort events emitted');
  assert.deepEqual(
    drainEvs.map(e => e.ev.data.count),
    [1, 2, 3],
    'drain count increments for each spurious init',
  );

  // Window still open after three drains.
  assert.ok(inst._drainTimer !== null, 'drain timer still active after multiple drains');
});

test('explicit prompt() before system/init closes the window — intentional turn not intercepted', async () => {
  const events = collectEvents(instances);
  const { id, inst } = await setupInstance();

  await runHardAbort(id, inst, events);

  // User explicitly starts a new turn — this must close the drain window.
  inst.prompt('explicit follow');
  assert.equal(inst._drainTimer, null, 'drain timer cancelled by prompt()');
  assert.equal(inst._drainListener, null, 'drain listener removed by prompt()');

  // Inject a system/init AFTER the window has been closed — must not drain.
  const beforeInject = events.length;
  injectSpuriousInit(inst);

  const drainEvs = events.slice(beforeInject).filter(
    e => e.id === id && e.ev.kind === 'system' && e.ev.subtype === 'drain_abort',
  );
  assert.equal(drainEvs.length, 0, 'no drain_abort after prompt() closed the window');

  // Explicit follow-up turn completes normally.
  await waitFor(() => inst.status === 'idle');
  const turnEnds = events.filter(e => e.id === id && e.ev.kind === 'turn_end' && e.ev.subtype === 'success');
  assert.equal(turnEnds.length, 1, 'explicit follow-up turn completed successfully');
});

test('closing the window manually prevents any subsequent system/init from draining', async () => {
  const events = collectEvents(instances);
  const { id, inst } = await setupInstance();

  await runHardAbort(id, inst, events);

  // Simulate timer expiry by closing the window directly.
  inst._closeDrainWindow();
  assert.equal(inst._drainTimer, null, 'timer gone after _closeDrainWindow');
  assert.equal(inst._drainListener, null, 'listener gone after _closeDrainWindow');

  const beforeInject = events.length;
  injectSpuriousInit(inst);

  const drainEvs = events.slice(beforeInject).filter(
    e => e.id === id && e.ev.kind === 'system' && e.ev.subtype === 'drain_abort',
  );
  assert.equal(drainEvs.length, 0, 'no drain_abort after window expired');

  // Outside the window, an init after the aborted turn's result is the opener of
  // a turn the CLI started, so cc's status follows it into `turn`.
  assert.equal(inst.status, 'turn', 'an init after the window starts a turn');
});

test('hard abort with nothing queued: window opens and closes harmlessly, normal behavior intact', async () => {
  const events = collectEvents(instances);
  const { id, inst } = await setupInstance();

  await runHardAbort(id, inst, events);

  // No spurious init injected — window should close cleanly on its own.
  // Close it now to avoid keeping a live timer in the test.
  inst._closeDrainWindow();

  // No drain_abort should have been emitted.
  const drainEvs = events.filter(e => e.id === id && e.ev.kind === 'system' && e.ev.subtype === 'drain_abort');
  assert.equal(drainEvs.length, 0, 'no spurious drain when nothing was queued');

  // Instance is idle and ready for the next prompt.
  assert.equal(inst.status, 'idle', 'instance is idle after harmless window expiry');
  assert.equal(inst.proc !== null, true, 'subprocess is still running');
});
