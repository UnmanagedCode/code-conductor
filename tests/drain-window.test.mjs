// Tests for the post-hard-abort drain window (see src/instances.js _openDrainWindow).
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

  // Instance remains healthy.
  assert.equal(inst.status, 'idle', 'instance is still idle after expired window');
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
