// Integration tests for the "Action on overage" feature (onOverage enum +
// in-place auto-resume). Drives the fake-claude subprocess through a turn that
// emits a `rate_limit_event` with `isUsingOverage:true` and asserts the
// orchestrator's enforcement: `none` does nothing; `stop` soft-interrupts and
// leaves the session idle-but-alive; `stop-resume` additionally arms an
// in-memory timer that resumes the still-alive session (no kill/respawn).
//
// The resume buffer is forced to 0ms via ORCH_OVERAGE_RESUME_BUFFER_MS so the
// timer fires off the test's `resetsAt` alone (now+1s ⇒ fires ~1s later).

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bootServer, api, waitFor } from './helpers.mjs';
import { setOnOverageAction, setOverageThreshold } from '../src/appSettings.js';
import { AUTO_RESUME_TEXT } from '../src/instances.js';

const nowSec = () => Math.floor(Date.now() / 1000);
// The live `rate_limit_event` delivers the window reset as the camelCase
// epoch-seconds `resetsAt` (confirmed against a real CLI capture), alongside
// `status`, `rateLimitType`, and — on an overage trip — a far-future overage
// window `overageResetsAt`. We emit that real shape; resume timing must key off
// the five-hour `resetsAt`, NOT `overageResetsAt`.

const INIT = { type: 'system', subtype: 'init', session_id: '$SID', cwd: '$CWD',
  model: 'claude-sonnet-4-6', permissionMode: '$MODE', tools: ['Bash'], uuid: 'init-1' };
const RESULT = { type: 'result', subtype: 'success', stop_reason: 'end_turn',
  duration_ms: 10, total_cost_usd: 0.0001, is_error: false };

function overageEvent({ resetsAt } = {}) {
  // Real overage trip: status:"rejected" + isUsingOverage:true, carrying the
  // five-hour window `resetsAt` (epoch secs) AND a much later overage window
  // `overageResetsAt`. The orchestrator must resume on the five-hour `resetsAt`.
  const info = { status: 'rejected', rateLimitType: 'five_hour',
    overageStatus: 'allowed', isUsingOverage: true };
  if (resetsAt !== undefined) {
    info.resetsAt = resetsAt;
    info.overageResetsAt = resetsAt + 10 * 86400; // overage window ~10 days out
  }
  return { type: 'system', subtype: 'rate_limit_event', uuid: 'rl-1', rate_limit_info: info };
}

// A rate_limit_event with NO hard overage flag — only a utilization fraction
// (and optional window type). Used to exercise the optional usage threshold.
function utilEvent({ util, resetsAt, rateLimitType } = {}) {
  const info = { status: 'allowed_warning', utilization: util };
  if (resetsAt !== undefined) info.resetsAt = resetsAt;
  if (rateLimitType !== undefined) info.rateLimitType = rateLimitType;
  return { type: 'system', subtype: 'rate_limit_event', uuid: 'rl-1', rate_limit_info: info };
}

// Turn 1 emits the overage event then a result (so status is `turn` when the
// orchestrator processes the overage line, then winds to idle). Extra empty
// turns absorb the soft-interrupt steer + any later prompts (FIFO) so the
// fake never blocks on an unmatched message.
function scenario(turn1emit, extraTurns = 2) {
  const turns = [{ on: { type: 'prompt' }, emit: turn1emit }];
  for (let i = 0; i < extraTurns; i++) turns.push({ on: { type: 'prompt' }, emit: [] });
  return { events: [INIT], turns };
}

async function writeScenario(obj) {
  const p = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-overage-')), 'scenario.json');
  await fs.writeFile(p, JSON.stringify(obj));
  return p;
}

let savedBuf;
before(() => { savedBuf = process.env.ORCH_OVERAGE_RESUME_BUFFER_MS; process.env.ORCH_OVERAGE_RESUME_BUFFER_MS = '0'; });
after(() => {
  if (savedBuf === undefined) delete process.env.ORCH_OVERAGE_RESUME_BUFFER_MS;
  else process.env.ORCH_OVERAGE_RESUME_BUFFER_MS = savedBuf;
});

// Each test boots its own server (its scenario is fixed at boot via env) and
// tears it down. The scenario temp dirs are left to the OS tmp reaper.
let ctx;
beforeEach(() => { ctx = null; });
afterEach(async () => { if (ctx) await ctx.close(); ctx = null; });

async function boot(scenarioObj, action) {
  ctx = await bootServer({ scenarioPath: await writeScenario(scenarioObj) });
  await setOnOverageAction(action);
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });
  return ctx;
}

async function spawnIdle() {
  const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
  assert.equal(r.status, 201);
  const inst = ctx.instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  return inst;
}

function collect(inst) {
  const evs = [];
  inst.on('event', (ev) => evs.push(ev));
  return evs;
}

const sub = (evs, subtype) => evs.filter(e => e.kind === 'system' && e.subtype === subtype);

test('onOverage "none": overage event is ignored — no notice, no interrupt', async () => {
  await boot(scenario([overageEvent({ resetsAt: nowSec() + 1 }), RESULT]), 'none');
  const inst = await spawnIdle();
  const evs = collect(inst);
  inst.prompt('go');
  // Turn completes normally back to idle.
  await waitFor(() => inst.status === 'idle' && sub(evs, 'init').length > 0);
  // Give the (absent) auto-stop path a beat — assert nothing fired.
  assert.equal(sub(evs, 'auto_stop_overage').length, 0, 'no auto_stop_overage notice');
  assert.equal(inst.autoResumeAt, null, 'no resume armed');
  assert.equal(inst.proc != null, true, 'session still alive');
});

test('onOverage "stop": soft-interrupts, session stays idle-but-alive, no resume armed', async () => {
  await boot(scenario([overageEvent({ resetsAt: nowSec() + 1 }), RESULT]), 'stop');
  const inst = await spawnIdle();
  const evs = collect(inst);
  inst.prompt('go');
  await waitFor(() => sub(evs, 'auto_stop_overage').length > 0);
  const notice = sub(evs, 'auto_stop_overage')[0];
  assert.equal(notice.data.resume, false, 'stop ⇒ resume:false');
  await waitFor(() => inst.status === 'idle');
  assert.equal(inst.proc != null, true, 'session not killed');
  assert.equal(inst.autoResumeAt, null, 'no resume timer for plain stop');
  assert.equal(ctx.instances._autoResumeTimers.size, 0);
});

test('onOverage "stop-resume": stays alive, arms timer, delivers resume prompt at reset', async () => {
  // resetsAt is far in the future so arming is unambiguous (no race between the
  // turn round-trip and resetsAt going stale). We assert the timer ARMS — the
  // real behavior under test — then fire it on-demand via the _fireAutoResumeNow
  // seam instead of sleeping out the wall-clock timer, so the only remaining wait
  // is the inherent subprocess resume round-trip. The resume prompt is observed
  // via the orchestrator's user_echo (text === AUTO_RESUME_TEXT).
  await boot(scenario([overageEvent({ resetsAt: nowSec() + 3600 }), RESULT]), 'stop-resume');
  const inst = await spawnIdle();
  const evs = collect(inst);
  inst.prompt('go');

  // Notice is resume-aware and the timer arms on the idle transition.
  await waitFor(() => sub(evs, 'auto_stop_overage').length > 0);
  assert.equal(sub(evs, 'auto_stop_overage')[0].data.resume, true, 'stop-resume ⇒ resume:true');
  await waitFor(() => inst.autoResumeAt != null);
  assert.equal(ctx.instances._autoResumeTimers.has(inst.sessionId), true, 'timer armed');
  assert.equal(inst.proc != null, true, 'session alive while waiting to resume');

  // Fire the armed timer deterministically: the resume prompt is delivered to the
  // still-live session, just as the wall-clock fire would.
  assert.equal(ctx.instances._fireAutoResumeNow(inst.sessionId), true, 'pending resume fired');
  await waitFor(() => evs.some(e => e.kind === 'user_echo' && e.text === AUTO_RESUME_TEXT),
    { timeout: 10000 });

  // Single teardown: no timer remains, flags cleared, session never killed.
  await waitFor(() => !ctx.instances._autoResumeTimers.has(inst.sessionId));
  assert.equal(inst.autoResumeAt, null, 'badge cleared after resume');
  assert.equal(inst.autoStoppedForOverage, false);
  assert.equal(inst._overageHandled, false);
  assert.equal(inst.proc != null, true, 'never killed/respawned');
});

// Minimal shape: bare isUsingOverage + camelCase epoch `resetsAt` (no
// status/rateLimitType/overageResetsAt companions) must still arm the timer.
function overageEventCamelEpoch(resetsAt) {
  return { type: 'system', subtype: 'rate_limit_event', uuid: 'rl-1',
    rate_limit_info: { isUsingOverage: true, resetsAt } };
}

test('onOverage "stop-resume": bare camelCase epoch resetsAt also arms', async () => {
  await boot(scenario([overageEventCamelEpoch(nowSec() + 3600), RESULT]), 'stop-resume');
  const inst = await spawnIdle();
  const evs = collect(inst);
  inst.prompt('go');
  await waitFor(() => sub(evs, 'auto_stop_overage').length > 0);
  assert.equal(sub(evs, 'auto_stop_overage')[0].data.resume, true);
  await waitFor(() => inst.autoResumeAt != null);
  assert.equal(ctx.instances._autoResumeTimers.has(inst.sessionId), true, 'timer armed from epoch resetsAt');
});

test('onOverage "stop-resume": missing/past resetsAt is skipped, not armed', async () => {
  await boot(scenario([overageEvent({ resetsAt: nowSec() - 100 }), RESULT]), 'stop-resume');
  const inst = await spawnIdle();
  const evs = collect(inst);
  inst.prompt('go');
  await waitFor(() => sub(evs, 'auto_resume_skipped').length > 0);
  assert.match(sub(evs, 'auto_resume_skipped')[0].data.reason, /resetsAt/);
  assert.equal(inst.autoResumeAt, null, 'nothing armed');
  assert.equal(ctx.instances._autoResumeTimers.size, 0);
});

// ── Optional usage threshold (window-agnostic) ───────────────────────────

test('threshold enabled: a utilization>=pct event trips even without isUsingOverage', async () => {
  await boot(scenario([utilEvent({ util: 0.9, resetsAt: nowSec() + 1 }), RESULT]), 'stop');
  await setOverageThreshold({ enabled: true, value: 85 });
  const inst = await spawnIdle();
  const evs = collect(inst);
  inst.prompt('go');
  await waitFor(() => sub(evs, 'auto_stop_overage').length > 0);
  assert.equal(sub(evs, 'auto_stop_overage')[0].data.resume, false, 'plain stop');
  await waitFor(() => inst.status === 'idle');
  assert.equal(inst.proc != null, true, 'session not killed');
});

test('threshold DISABLED: a utilization-only event (no hard flag) is ignored', async () => {
  await boot(scenario([utilEvent({ util: 0.95, resetsAt: nowSec() + 1 }), RESULT]), 'stop');
  // threshold left off (default)
  const inst = await spawnIdle();
  const evs = collect(inst);
  inst.prompt('go');
  await waitFor(() => inst.status === 'idle' && sub(evs, 'init').length > 0);
  assert.equal(sub(evs, 'auto_stop_overage').length, 0, 'no stop without the hard flag when threshold off');
});

test('threshold trip is window-agnostic: a seven_day event still trips', async () => {
  await boot(scenario([utilEvent({ util: 0.92, resetsAt: nowSec() + 1, rateLimitType: 'seven_day' }), RESULT]), 'stop');
  await setOverageThreshold({ enabled: true, value: 85 });
  const inst = await spawnIdle();
  const evs = collect(inst);
  inst.prompt('go');
  await waitFor(() => sub(evs, 'auto_stop_overage').length > 0);
});

test('threshold below the bar does not trip; the hard flag still trips regardless', async () => {
  // utilization 0.6 < 0.85 ⇒ no threshold trip, AND no hard flag ⇒ nothing.
  await boot(scenario([utilEvent({ util: 0.6, resetsAt: nowSec() + 1 }), RESULT]), 'stop');
  await setOverageThreshold({ enabled: true, value: 85 });
  const inst = await spawnIdle();
  const evs = collect(inst);
  inst.prompt('go');
  await waitFor(() => inst.status === 'idle' && sub(evs, 'init').length > 0);
  assert.equal(sub(evs, 'auto_stop_overage').length, 0, 'below threshold, no flag ⇒ no stop');
});

// ── Central routing: global flag + conductor-aware steering ───────────────

// Shared scenario for routing tests. Text-matched turns let one scenario drive
// differentiated behavior across instances loaded from the same fake-claude:
//   prompt containing 'TRIP' → emit a hard overage event + result (the trigger)
//   prompt containing 'STAY' → emit nothing (keeps that session mid-turn)
//   any other prompt         → emit nothing (absorbs steer prompts / interrupts)
// resetsAt is far in the future so the global clear timer can't fire mid-test.
function routingScenario() {
  return {
    events: [INIT],
    turns: [
      { on: { type: 'prompt', text: 'TRIP' }, emit: [overageEvent({ resetsAt: nowSec() + 3600 }), RESULT] },
      { on: { type: 'prompt', text: 'STAY' }, emit: [] },
      { on: { type: 'prompt' }, emit: [] },
      { on: { type: 'prompt' }, emit: [] },
      { on: { type: 'prompt' }, emit: [] },
      { on: { type: 'prompt' }, emit: [] },
    ],
  };
}

async function createInst(opts) {
  const inst = await ctx.instances.create({ project: 'demo', mode: 'bypassPermissions', ...opts });
  await waitFor(() => inst.status === 'idle');
  return inst;
}

test('routing: conductor mid-turn → conductor is steered (windDown), worker untouched', async () => {
  await boot(routingScenario(), 'stop');
  const conductor = await createInst({});
  const worker = await createInst({ conducted: true, callerInstanceId: conductor.id });
  const cEvs = collect(conductor);
  const wEvs = collect(worker);

  // Put the conductor mid-turn first.
  conductor.prompt('STAY');
  await waitFor(() => conductor.status === 'turn');

  // Worker trips overage.
  worker.prompt('TRIP go');

  // Conductor is steered; the steer notice carries steered:true.
  await waitFor(() => sub(cEvs, 'auto_stop_overage').some(e => e.data.steered === true));
  // windDown surfaces a visible user_echo with the steer instructions.
  await waitFor(() => cEvs.some(e => e.kind === 'user_echo' && /interrupt_turn/.test(e.text || '')));
  // Worker was NOT interrupted and got no stop notice.
  await waitFor(() => worker.status === 'idle');
  assert.equal(sub(wEvs, 'auto_stop_overage').length, 0, 'worker must not be stopped directly');
  assert.equal(worker.interrupting, false, 'worker turn was not interrupted');
});

test('routing: conductor idle+subscribed → conductor is steered via injected prompt, worker untouched', async () => {
  await boot(routingScenario(), 'stop');
  const conductor = await createInst({});
  const worker = await createInst({ conducted: true, callerInstanceId: conductor.id });
  const cEvs = collect(conductor);
  const wEvs = collect(worker);

  // Conductor stays idle but is parked waiting on the worker (isIdleCaller).
  ctx.instances.subscribeIdle(conductor.sessionId, worker.sessionId);
  assert.equal(ctx.instances.isIdleCaller(conductor.sessionId), true);

  worker.prompt('TRIP go');

  await waitFor(() => sub(cEvs, 'auto_stop_overage').some(e => e.data.steered === true));
  await waitFor(() => cEvs.some(e => e.kind === 'user_echo' && /interrupt_turn/.test(e.text || '')));
  await waitFor(() => worker.status === 'idle');
  assert.equal(sub(wEvs, 'auto_stop_overage').length, 0, 'worker must not be stopped directly');
});

test('routing: conducted worker with NO in-control conductor → fallback direct interrupt', async () => {
  await boot(routingScenario(), 'stop');
  const conductor = await createInst({});
  const worker = await createInst({ conducted: true, callerInstanceId: conductor.id });
  const wEvs = collect(worker);

  // Conductor gone → no in-control owner → fallback path.
  await ctx.instances.remove(conductor.id);

  worker.prompt('TRIP go');
  await waitFor(() => sub(wEvs, 'auto_stop_overage').length > 0);
  assert.notEqual(sub(wEvs, 'auto_stop_overage')[0].data.steered, true, 'fallback is a direct stop, not a steer');
});

test('routing: global flag is one-shot while active; clears so it can trip again', async () => {
  await boot(routingScenario(), 'stop');
  const a = await createInst({});
  const b = await createInst({});
  const aEvs = collect(a);
  const bEvs = collect(b);

  a.prompt('TRIP go');
  await waitFor(() => sub(aEvs, 'auto_stop_overage').length > 0);
  assert.equal(ctx.instances._overageActive, true, 'flag set on first trip');

  // Second instance trips while active → routing does not run for it.
  b.prompt('TRIP go');
  await waitFor(() => b.status === 'idle');
  assert.equal(sub(bEvs, 'auto_stop_overage').length, 0, 'one-shot: no second routing while active');

  // Clearing releases the flag and re-enables per-instance trip detection.
  ctx.instances._clearOverage();
  assert.equal(ctx.instances._overageActive, false);
  assert.equal(a._overageHandled, false, 'per-instance throttle reset on clear');
  assert.equal(b._overageHandled, false);
});

test('routing: action "none" never flips the global flag', async () => {
  await boot(routingScenario(), 'none');
  const inst = await createInst({});
  const evs = collect(inst);
  inst.prompt('TRIP go');
  await waitFor(() => inst.status === 'idle' && sub(evs, 'init').length > 0);
  assert.equal(ctx.instances._overageActive, false, 'none ⇒ no flag flip');
  assert.equal(sub(evs, 'auto_stop_overage').length, 0, 'none ⇒ no routing');
});

test('stop-resume: a user prompt before the timer fires cancels the pending resume', async () => {
  // resetsAt far in the future so the real timer never fires during the test —
  // we assert the timer ARMS, then prove a user takeover CANCELS it (no
  // _fireAutoResumeNow, no wall-clock wait on a fire). Deterministic by
  // construction: the only awaits are the inherent turn round-trips.
  await boot(scenario([overageEvent({ resetsAt: nowSec() + 3600 }), RESULT]), 'stop-resume');
  const inst = await spawnIdle();
  const evs = collect(inst);
  inst.prompt('go');
  await waitFor(() => inst.autoResumeAt != null);
  assert.equal(ctx.instances._autoResumeTimers.has(inst.sessionId), true, 'timer armed');

  // User takes over — their prompt must cancel the pending resume.
  inst.prompt('actually do this instead');
  await waitFor(() => !ctx.instances._autoResumeTimers.has(inst.sessionId));
  assert.equal(inst.autoResumeAt, null, 'badge cleared on user takeover');
  assert.equal(inst.autoStoppedForOverage, false);
  assert.equal(ctx.instances._autoResumeTimers.size, 0);
  // The cancelled resume was never delivered.
  assert.equal(evs.some(e => e.kind === 'user_echo' && e.text === AUTO_RESUME_TEXT), false,
    'cancelled ⇒ no resume prompt delivered');
});

// ── Conducted stop-resume: resume must arm through the routing paths ───────
// The routing tests above all use action 'stop' — they never exercised whether
// a `stop-resume` overage trip ARMS a resume when the stop is routed through a
// conductor. These cover that gap. Unlike routingScenario(), generic prompt
// turns here emit a RESULT so the steered/wound-down conductor reaches idle
// (the transition that arms the per-session resume timer).
function resumeRoutingScenario() {
  return {
    events: [INIT],
    turns: [
      { on: { type: 'prompt', text: 'TRIP' }, emit: [overageEvent({ resetsAt: nowSec() + 3600 }), RESULT] },
      { on: { type: 'prompt', text: 'STAY' }, emit: [] },   // hold a conductor mid-turn
      { on: { type: 'prompt' }, emit: [RESULT] },           // steer / windDown / resume → idle
      { on: { type: 'prompt' }, emit: [RESULT] },
      { on: { type: 'prompt' }, emit: [RESULT] },
      { on: { type: 'prompt' }, emit: [RESULT] },
    ],
  };
}

// REGRESSION (fails before the fix): a worker trips while its conductor is
// idle + subscribed (the CONDUCT.md `subscribe_to_idle` pattern). The conductor
// is steered via a fresh prompt() — whose synchronous user_prompt runs
// _cancelAutoResume — so the resume flags must be set AFTER the prompt or no
// timer ever arms. This asserts the timer arms ON THE CONDUCTOR and fires.
test('routing stop-resume: idle+subscribed conductor is steered AND a resume timer arms', async () => {
  await boot(resumeRoutingScenario(), 'stop-resume');
  const conductor = await createInst({});
  const worker = await createInst({ conducted: true, callerInstanceId: conductor.id });
  const cEvs = collect(conductor);

  // Conductor parked idle, subscribed to the worker.
  ctx.instances.subscribeIdle(conductor.sessionId, worker.sessionId);
  assert.equal(ctx.instances.isIdleCaller(conductor.sessionId), true);

  worker.prompt('TRIP go');

  // Conductor is steered, resume-aware.
  await waitFor(() => sub(cEvs, 'auto_stop_overage').some(e => e.data.steered === true && e.data.resume === true));
  // The resume flag survives the steer prompt's synchronous user_prompt, and the
  // conductor's steer turn → idle arms the per-session timer.
  await waitFor(() => ctx.instances._autoResumeTimers.has(conductor.sessionId));
  assert.equal(conductor.autoStoppedForOverage, true, 'flag survived the steer prompt');
  assert.equal(conductor.autoResumeAt != null, true, 'conductor resume badge set');

  // Firing it delivers the resume prompt to the still-live conductor.
  assert.equal(ctx.instances._fireAutoResumeNow(conductor.sessionId), true, 'pending resume fired');
  await waitFor(() => cEvs.some(e => e.kind === 'user_echo' && e.text === AUTO_RESUME_TEXT),
    { timeout: 10000 });
  assert.equal(conductor.proc != null, true, 'conductor never killed');
});

// Guard the mid-turn conductor branch under stop-resume (windDown arms resume).
test('routing stop-resume: mid-turn conductor windDown arms a resume timer', async () => {
  await boot(resumeRoutingScenario(), 'stop-resume');
  const conductor = await createInst({});
  const worker = await createInst({ conducted: true, callerInstanceId: conductor.id });
  const cEvs = collect(conductor);

  // Put the conductor mid-turn first (STAY emits nothing → stays in 'turn').
  conductor.prompt('STAY');
  await waitFor(() => conductor.status === 'turn');

  worker.prompt('TRIP go');

  await waitFor(() => sub(cEvs, 'auto_stop_overage').some(e => e.data.steered === true && e.data.resume === true));
  // windDown injects a steer user-message; the fake answers it with a RESULT, so
  // the conductor reaches idle and arms.
  await waitFor(() => ctx.instances._autoResumeTimers.has(conductor.sessionId));
  assert.equal(conductor.autoStoppedForOverage, true);
});

// Guard the fallback (no in-control conductor) direct-stop under stop-resume.
test('routing stop-resume: fallback worker direct-stop arms a resume timer', async () => {
  await boot(resumeRoutingScenario(), 'stop-resume');
  const conductor = await createInst({});
  const worker = await createInst({ conducted: true, callerInstanceId: conductor.id });
  const wEvs = collect(worker);

  // Conductor gone → no in-control owner → worker is direct-stopped.
  await ctx.instances.remove(conductor.id);

  worker.prompt('TRIP go');
  await waitFor(() => sub(wEvs, 'auto_stop_overage').length > 0);
  assert.notEqual(sub(wEvs, 'auto_stop_overage')[0].data.steered, true, 'fallback is a direct stop');
  await waitFor(() => ctx.instances._autoResumeTimers.has(worker.sessionId));
  assert.equal(worker.autoStoppedForOverage, true);
});
