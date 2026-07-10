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
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { setOnOverageAction, setOverageThreshold } from '../src/appSettings.js';
import { AUTO_RESUME_TEXT } from '../src/instances.js';
import { getAccountUsage } from '../src/accountUsage.js';
import { ensureConductProject, CONDUCT_PROJECT_NAME } from '../src/conduct.js';

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

// Boot the server ONCE for the whole file (each test injects its own fake-claude
// scenario via FAKE_CLAUDE_SCENARIO before spawning, and gets a pristine
// projects/settings namespace via freshProjectsRoot) — 38 per-test bootServer()
// calls otherwise dominate the wall-clock under the concurrent runner on a
// throttled Termux box and blow the 60s per-file ceiling.
let savedBuf, savedSweep, savedRecheck;
let ctx, instances, home;
before(async () => {
  savedBuf = process.env.ORCH_OVERAGE_RESUME_BUFFER_MS;
  process.env.ORCH_OVERAGE_RESUME_BUFFER_MS = '0';
  // Drive the wall-clock sweep fast so the wake-after-suspend test fires off the
  // real sweep (not a setTimeout) within the round-trip budget. Harmless to the
  // fireNow-based tests (their far-future deadlines never come due).
  savedSweep = process.env.ORCH_OVERAGE_RESUME_SWEEP_MS;
  process.env.ORCH_OVERAGE_RESUME_SWEEP_MS = '40';
  // Short recheck cadence so a still-over / can't-confirm park re-checks fast enough
  // to observe within a test (production default is 60s, independent of the 180s
  // usage cache — see src/overageResume.js's _recheckMs()).
  savedRecheck = process.env.ORCH_OVERAGE_RECHECK_MS;
  process.env.ORCH_OVERAGE_RECHECK_MS = '60';
  // No scenario at boot — each test's boot() sets FAKE_CLAUDE_SCENARIO before it
  // spawns (Instance.spawn snapshots process.env per subprocess; fake-claude reads
  // the var at its own startup), so the shared server serves per-test scenarios.
  ctx = await bootServer({});
  instances = ctx.instances;
});
after(async () => {
  await ctx.close();
  if (savedBuf === undefined) delete process.env.ORCH_OVERAGE_RESUME_BUFFER_MS;
  else process.env.ORCH_OVERAGE_RESUME_BUFFER_MS = savedBuf;
  if (savedSweep === undefined) delete process.env.ORCH_OVERAGE_RESUME_SWEEP_MS;
  else process.env.ORCH_OVERAGE_RESUME_SWEEP_MS = savedSweep;
  if (savedRecheck === undefined) delete process.env.ORCH_OVERAGE_RECHECK_MS;
  else process.env.ORCH_OVERAGE_RECHECK_MS = savedRecheck;
});

beforeEach(async () => {
  // Fresh projects/settings namespace per test (projectsRoot()/orchStoreRoot()/
  // claudeProjectsRoot() read process.env live; appSettings caches by settingsPath()).
  ({ home } = await freshProjectsRoot());
  // Reset the shared manager's GLOBAL overage state so nothing leaks between tests.
  // _clearOverage() resets _overageActive/_overageResumeMode/_overageResetsAt + the
  // clear timer; clearAll() drops the deadline map/sweep/checking/failCount. Restoring
  // the injected fetchUsage seams to the real getAccountUsage reproduces exactly the
  // fresh-manager-per-test default this file used to get from a per-test reboot.
  instances._clearOverage();
  instances._overageResume.clearAll();
  instances._overageResume.fetchUsage = getAccountUsage;
  instances._usageMonitor.fetchUsage = getAccountUsage;
});
afterEach(async () => {
  await instances.shutdown();
  await rmrf(home);
});

async function boot(scenarioObj, action) {
  process.env.FAKE_CLAUDE_SCENARIO = await writeScenario(scenarioObj);
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

// Account-usage payload shape (src/accountUsage.js): five_hour carries a 0–100
// PERCENT `utilization` and an ISO `resets_at`. The fire-time resume verify reads it.
function usagePayload(fiveHourUtilPct, resetsAtSec) {
  return {
    five_hour: { utilization: fiveHourUtilPct, resets_at: new Date(resetsAtSec * 1000).toISOString() },
    seven_day: { utilization: 0, resets_at: new Date((resetsAtSec + 86400) * 1000).toISOString() },
    extra_usage: { is_enabled: false },
  };
}
// Inject the resume controller's usage-verify seam. util < 100 (and under any enabled
// threshold) ⇒ "clear" ⇒ the due resume proceeds; util >= 100 ⇒ "still over" ⇒ it parks.
function setResumeUsage(utilPct) {
  ctx.instances._overageResume.fetchUsage = async () => usagePayload(utilPct, nowSec() + 3600);
}
const UNDER = 10, OVER = 100;

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
  setResumeUsage(UNDER); // fire-time verify sees the window clear ⇒ resume proceeds
  const evs = collect(inst);
  inst.prompt('go');

  // Notice is resume-aware and the timer arms on the idle transition.
  await waitFor(() => sub(evs, 'auto_stop_overage').length > 0);
  assert.equal(sub(evs, 'auto_stop_overage')[0].data.resume, true, 'stop-resume ⇒ resume:true');
  await waitFor(() => inst.autoResumeAt != null);
  assert.equal(ctx.instances._autoResumeTimers.has(inst.sessionId), true, 'timer armed');
  assert.equal(inst.proc != null, true, 'session alive while waiting to resume');

  // Fire the armed timer deterministically: usage verifies clear, so the resume
  // prompt is delivered to the still-live session, just as the wall-clock fire would.
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

// (c) A past/missing resetsAt is NOT a dead-end anymore: arm() schedules a usage
// recheck instead of emitting auto_resume_skipped + giving up. Here the verify keeps
// reporting "still over", so the session stays parked-and-rechecking (never skipped),
// which is exactly what fixes the boundary re-trip.
test('onOverage "stop-resume": past resetsAt schedules a recheck, not a skip', async () => {
  await boot(scenario([overageEvent({ resetsAt: nowSec() - 100 }), RESULT]), 'stop-resume');
  const inst = await spawnIdle();
  setResumeUsage(OVER); // still throttled ⇒ each recheck reschedules, no resume
  const evs = collect(inst);
  inst.prompt('go');
  // A deadline IS armed (recheck ~now+recheck) even though resetsAt was in the past.
  await waitFor(() => inst.autoResumeAt != null);
  assert.equal(ctx.instances._autoResumeTimers.has(inst.sessionId), true, 'recheck deadline armed');
  assert.equal(inst.autoStoppedForOverage, true, 'stays flagged auto-stopped (not given up)');
  // Let a couple of recheck cycles run; it must never emit the give-up notice.
  await waitFor(() => ctx.instances._autoResumeTimers.has(inst.sessionId)); // still parked
  assert.equal(sub(evs, 'auto_resume_skipped').length, 0, 'no give-up while still throttled');
});

// ── Wall-clock sweep: fires on real time, survives suspension ─────────────
// REGRESSION for the non-firing-resume bug: the resume used to be a single
// per-session setTimeout, which rides the libuv MONOTONIC clock — frozen while
// the process is suspended (Android Doze / Termux backgrounding), so a deadline
// could lapse in wall-clock terms yet never fire. The controller now records a
// wall-clock deadline and a shared sweep fires it once now >= deadline. Here we
// arm a near-future deadline (buffer 0, resetsAt now+2s) and let the REAL sweep
// (40ms cadence) fire it — NO _fireAutoResumeNow — proving the fire is driven by
// the wall clock, not a setTimeout. A deadline that elapsed during suspension is
// the same case: due on the next tick after wake.
test('stop-resume: the wall-clock sweep (not a setTimeout) fires the resume when due', async () => {
  await boot(scenario([overageEvent({ resetsAt: nowSec() + 2 }), RESULT]), 'stop-resume');
  const inst = await spawnIdle();
  setResumeUsage(UNDER); // sweep's fire-time verify sees the window clear ⇒ resumes
  const evs = collect(inst);
  // Capture manager-level status pushes to prove the badge-drop is emitted.
  const statuses = [];
  ctx.instances.on('status', (s) => { if (s.id === inst.id) statuses.push(s); });

  inst.prompt('go');

  // Deadline arms (badge set) — but we never call the fire seam.
  await waitFor(() => inst.autoResumeAt != null);
  assert.equal(ctx.instances._autoResumeTimers.has(inst.sessionId), true, 'deadline recorded');
  assert.equal(inst.proc != null, true, 'session alive while waiting to resume');

  // The real wall-clock sweep delivers the resume prompt once now >= deadline.
  await waitFor(() => evs.some(e => e.kind === 'user_echo' && e.text === AUTO_RESUME_TEXT),
    { timeout: 10000 });

  // Regression: after fire the badge no longer outlives the timer — deadline
  // gone, flags cleared, and a status with autoResumeAt:null was emitted.
  await waitFor(() => !ctx.instances._autoResumeTimers.has(inst.sessionId));
  assert.equal(inst.autoResumeAt, null, 'badge cleared after sweep fire');
  assert.equal(inst.autoStoppedForOverage, false);
  assert.equal(statuses.some(s => s.autoResumeAt === null), true, 'badge-drop status emitted');
  assert.equal(inst.proc != null, true, 'never killed/respawned');
});

// FIX #3: a temp session whose subprocess exits before its resume is due must
// not leave an orphaned deadline (nor a badge that outlives the timer). Killing
// the proc directly hits the temp-exit branch (NOT remove(), which cancels on
// its own); the branch now cancels the pending resume.
test('stop-resume: temp-session exit cancels the pending resume (no orphan deadline)', async () => {
  // Far-future deadline so it can't fire on its own before we kill the proc.
  await boot(scenario([overageEvent({ resetsAt: nowSec() + 3600 }), RESULT]), 'stop-resume');
  const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions', temp: true });
  assert.equal(r.status, 201);
  const inst = ctx.instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  const sid = inst.sessionId;

  inst.prompt('go');
  await waitFor(() => inst.autoResumeAt != null);
  assert.equal(ctx.instances._autoResumeTimers.has(sid), true, 'deadline armed for the temp session');

  // Subprocess exits → temp-exit branch fires (instance dropped from byId).
  await inst.kill({ graceMs: 100 });
  await waitFor(() => !ctx.instances.get(r.body.id)); // temp row collapsed

  // No orphaned deadline survives; sweep has nothing left to fire.
  assert.equal(ctx.instances._autoResumeTimers.has(sid), false, 'no orphan deadline after temp exit');
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

// BEHAVIOR FLIP: a user prompt during the wait window used to CANCEL the pending
// resume and drive the session immediately. It now QUEUES the message — the
// resume stays armed and only the deadline (or _fireAutoResumeNow) resumes.
test('stop-resume: a user prompt during the wait window is QUEUED, not delivered, and does NOT cancel the resume', async () => {
  await boot(scenario([overageEvent({ resetsAt: nowSec() + 3600 }), RESULT]), 'stop-resume');
  const inst = await spawnIdle();
  const evs = collect(inst);
  inst.prompt('go');
  await waitFor(() => inst.autoResumeAt != null);
  assert.equal(ctx.instances._autoResumeTimers.has(inst.sessionId), true, 'timer armed');

  // User types during the paused window — the message is queued, not sent.
  await inst.prompt('actually do this instead');
  await waitFor(() => evs.some(e => e.kind === 'overage_message_queued'));
  // Resume stays armed; nothing was cancelled.
  assert.equal(ctx.instances._autoResumeTimers.has(inst.sessionId), true, 'timer still armed after typing');
  assert.equal(inst.autoResumeAt != null, true, 'badge still set');
  assert.equal(inst.autoStoppedForOverage, true, 'still auto-stopped');
  assert.equal(inst._overageQueue.length, 1, 'message queued');
  assert.equal(inst._overageQueue[0].text, 'actually do this instead');
  assert.equal(inst.summary().queuedCount, 1, 'queuedCount surfaced on summary');
  // Neither the queued text nor the resume text was delivered to the CLI yet.
  assert.equal(evs.some(e => e.kind === 'user_echo' && e.text === AUTO_RESUME_TEXT), false,
    'resume not delivered while paused');
  assert.equal(evs.some(e => e.kind === 'user_echo' && e.text === 'actually do this instead'), false,
    'queued message not delivered on its own');
});

test('stop-resume: queued messages flush as ONE combined prompt when the resume fires', async () => {
  await boot(scenario([overageEvent({ resetsAt: nowSec() + 3600 }), RESULT]), 'stop-resume');
  const inst = await spawnIdle();
  setResumeUsage(UNDER); // verify sees the window clear ⇒ resume + flush
  const evs = collect(inst);
  inst.prompt('go');
  await waitFor(() => inst.autoResumeAt != null);

  await inst.prompt('first queued');
  await inst.prompt('second queued');
  await waitFor(() => inst._overageQueue.length === 2);

  // Fire the armed resume deterministically.
  assert.equal(ctx.instances._fireAutoResumeNow(inst.sessionId), true, 'pending resume fired');

  // Exactly one delivered turn carrying the resume text AND both queued messages.
  await waitFor(() => evs.some(e => e.kind === 'user_echo' &&
    e.text.includes(AUTO_RESUME_TEXT) && e.text.includes('first queued') && e.text.includes('second queued')),
    { timeout: 10000 });
  const echoes = evs.filter(e => e.kind === 'user_echo' && e.text.includes(AUTO_RESUME_TEXT));
  assert.equal(echoes.length, 1, 'single combined resume turn');

  // A system line records the flush, the queue is drained, flags cleared, alive.
  assert.equal(sub(evs, 'auto_resume').some(e => e.data.count === 2), true, 'auto_resume line with count=2');
  await waitFor(() => !ctx.instances._autoResumeTimers.has(inst.sessionId));
  assert.equal(inst._overageQueue.length, 0, 'queue drained');
  assert.equal(inst.autoResumeAt, null, 'badge cleared');
  assert.equal(inst.autoStoppedForOverage, false);
  assert.equal(inst.proc != null, true, 'never killed');
});

test('stop-resume: an internal prompt during the wait window is NOT queued and does not cancel', async () => {
  await boot(scenario([overageEvent({ resetsAt: nowSec() + 3600 }), RESULT]), 'stop-resume');
  const inst = await spawnIdle();
  const evs = collect(inst);
  inst.prompt('go');
  await waitFor(() => inst.autoResumeAt != null);

  // Orchestrator-injected (internal) prompt — e.g. an idle-subscription wake.
  await inst.prompt('internal wake', [], { internal: true });
  // It resumes/steers normally: not queued, and it fell through to a real turn.
  assert.equal(inst._overageQueue.length, 0, 'internal prompt not queued');
  assert.equal(evs.some(e => e.kind === 'overage_message_queued'), false, 'no queued event for internal');
  await waitFor(() => evs.some(e => e.kind === 'user_echo' && e.text === 'internal wake'));
});

test('stop-resume: queued attachments are concatenated into the single resume prompt', async () => {
  await boot(scenario([overageEvent({ resetsAt: nowSec() + 3600 }), RESULT]), 'stop-resume');
  const inst = await spawnIdle();
  inst.prompt('go');
  await waitFor(() => inst.autoResumeAt != null);

  const att = (name) => ({ name, mediaType: 'text/plain', dataBase64: Buffer.from(name).toString('base64') });
  await inst.prompt('with file A', [att('a.txt')]);
  await inst.prompt('with file B', [att('b.txt')]);
  await waitFor(() => inst._overageQueue.length === 2);
  // Both queued entries retain their attachment for the combined delivery.
  assert.equal(inst._overageQueue.flatMap(e => e.attachments).length, 2, 'two attachments queued for one send');
});

// ── GLOBAL stop-and-queue lockout ──────────────────────────────────────────
// While the window is active in stop-resume mode, EVERY session queues its
// sends — not just the one stopped mid-turn. An idle/never-stopped session and a
// brand-new session both queue; each arms a resume deadline immediately (no
// mid-turn→idle transition to arm on). Hard lockout: no override, no early
// resume. Plain `stop` mode never queues (it has no flush path).

test('stop-resume GLOBAL: an existing idle, never-stopped session queues while the window is active', async () => {
  await boot(scenario([overageEvent({ resetsAt: nowSec() + 3600 }), RESULT]), 'stop-resume');
  // A trips the overage; B is an existing idle session that was never stopped.
  const b = await spawnIdle();
  const a = await spawnIdle();
  a.prompt('go');
  await waitFor(() => ctx.instances._overageActive === true && a.autoResumeAt != null);
  assert.equal(ctx.instances._overageResumeMode, true, 'stop-resume ⇒ resume mode');
  // B never stopped: not armed, but the gate surfaces the paused state.
  assert.equal(b.autoResumeAt, null, 'B not armed before it sends');
  assert.equal(b.summary().overageActive, true, 'B sees paused state via the gate');

  const bEvs = collect(b);
  await b.prompt('idle send during window');
  await waitFor(() => bEvs.some(e => e.kind === 'overage_message_queued'));
  assert.equal(b._overageQueue.length, 1, 'idle session queued');
  assert.equal(b._overageQueue[0].text, 'idle send during window');
  assert.equal(b.autoResumeAt != null, true, 'armed immediately via overage_queued');
  assert.equal(ctx.instances._autoResumeTimers.has(b.sessionId), true, 'timer armed for B');
  assert.equal(b._overageWasStopped, false, 'queued-only, not stopped mid-work');
  assert.equal(b.summary().queuedCount, 1, 'queuedCount surfaced');
  // Nothing delivered to B's CLI while paused.
  assert.equal(bEvs.some(e => e.kind === 'user_echo' && e.text === 'idle send during window'), false,
    'queued message not delivered while paused');
});

test('stop-resume GLOBAL: a brand-new session started during the window queues its first prompt', async () => {
  await boot(scenario([overageEvent({ resetsAt: nowSec() + 3600 }), RESULT]), 'stop-resume');
  const a = await spawnIdle();
  a.prompt('go');
  await waitFor(() => ctx.instances._overageActive === true && a.autoResumeAt != null);

  // Brand-new session created AFTER the trip — inherits the gate at create().
  const fresh = await spawnIdle();
  assert.equal(fresh.summary().overageActive, true, 'new session shows paused before any input');
  const fEvs = collect(fresh);
  await fresh.prompt('first message ever');
  await waitFor(() => fEvs.some(e => e.kind === 'overage_message_queued'));
  assert.equal(fresh._overageQueue.length, 1, 'first prompt queued');
  assert.equal(fresh.autoResumeAt != null, true, 'armed immediately');
  assert.equal(fresh._overageWasStopped, false, 'queued-only');
});

// SAFETY RAIL: a queued send bypasses the manual-resume clear path, so if the
// gate engaged without a valid FUTURE resetsAt every session would lock out
// PERMANENTLY. A missing/past/NaN resetsAt must mean gate inactive ⇒ sends flow.
test('SAFETY RAIL: global-active but past/missing resetsAt ⇒ NO queueing, sends flow normally', async () => {
  await boot(scenario([RESULT]), 'stop-resume'); // plain turn, no overage
  const inst = await spawnIdle();
  // Simulate the dangerous state directly: window "active" in resume mode but the
  // reset time is already PAST (as if the clear timer hadn't fired yet).
  ctx.instances._overageActive = true;
  ctx.instances._overageResumeMode = true;
  ctx.instances._overageResetsAt = nowSec() - 100; // PAST
  assert.equal(inst._overageGate().active, false, 'past resetsAt ⇒ gate inactive');
  ctx.instances._overageResetsAt = null;           // missing
  assert.equal(inst._overageGate().active, false, 'missing resetsAt ⇒ gate inactive');
  ctx.instances._overageResetsAt = NaN;            // NaN
  assert.equal(inst._overageGate().active, false, 'NaN resetsAt ⇒ gate inactive');

  // A send flows through as a real turn — never locked out.
  ctx.instances._overageResetsAt = nowSec() - 100;
  const evs = collect(inst);
  await inst.prompt('should flow through');
  assert.equal(inst._overageQueue.length, 0, 'not queued');
  assert.equal(evs.some(e => e.kind === 'overage_message_queued'), false, 'nothing queued');
  await waitFor(() => evs.some(e => e.kind === 'user_echo' && e.text === 'should flow through'));
});

test('stop-resume GLOBAL: a queued-only session flushes with the SOFTENED preamble', async () => {
  await boot(scenario([overageEvent({ resetsAt: nowSec() + 3600 }), RESULT]), 'stop-resume');
  const a = await spawnIdle();
  a.prompt('go');
  await waitFor(() => ctx.instances._overageActive === true && a.autoResumeAt != null);

  const b = await spawnIdle();
  const bEvs = collect(b);
  await b.prompt('please do X');
  await waitFor(() => b._overageQueue.length === 1);
  assert.equal(b._overageWasStopped, false, 'queued-only');

  setResumeUsage(UNDER); // verify clear ⇒ resume + flush
  assert.equal(ctx.instances._fireAutoResumeNow(b.sessionId), true, 'resume fired for B');
  await waitFor(() => bEvs.some(e => e.kind === 'user_echo' && e.text.includes('please do X')),
    { timeout: 10000 });
  const echo = bEvs.find(e => e.kind === 'user_echo' && e.text.includes('please do X'));
  assert.equal(echo.text.includes('Delivering the messages you queued while paused'), true,
    'softened preamble used');
  assert.equal(echo.text.includes('continue where you left off'), false,
    'no mid-work "continue" line for a queued-only session');
  assert.equal(b._overageQueue.length, 0, 'queue drained');
  assert.equal(b.autoResumeAt, null, 'badge cleared');
});

test('stop mode (not stop-resume): GLOBAL queueing does NOT engage', async () => {
  await boot(scenario([overageEvent({ resetsAt: nowSec() + 3600 }), RESULT]), 'stop');
  const a = await spawnIdle();
  a.prompt('go');
  await waitFor(() => ctx.instances._overageActive === true);
  assert.equal(ctx.instances._overageResumeMode, false, 'plain stop ⇒ not resume mode');

  const b = await spawnIdle();
  assert.equal(b._overageGate().active, false, 'gate inactive in plain stop');
  assert.equal(b.summary().overageActive, false, 'no paused state in plain stop');
  const bEvs = collect(b);
  await b.prompt('flows through in stop mode');
  assert.equal(b._overageQueue.length, 0, 'not queued in stop mode');
  assert.equal(bEvs.some(e => e.kind === 'overage_message_queued'), false, 'nothing queued');
  await waitFor(() => bEvs.some(e => e.kind === 'user_echo' && e.text === 'flows through in stop mode'));
});

// The window reset drops the paused state everywhere: _clearOverage emits a
// fresh status (overageActive:false) for every session, including not-yet-queued
// ones surfacing the banner via the gate.
test('stop-resume GLOBAL: window-reset clear drops the paused state on a not-yet-queued session', async () => {
  await boot(scenario([overageEvent({ resetsAt: nowSec() + 3600 }), RESULT]), 'stop-resume');
  const a = await spawnIdle();
  a.prompt('go');
  await waitFor(() => ctx.instances._overageActive === true);

  const b = await spawnIdle(); // never queues; sees paused only via the gate
  assert.equal(b.summary().overageActive, true, 'B paused via gate');
  const statuses = [];
  ctx.instances.on('status', (s) => { if (s.id === b.id) statuses.push(s); });

  ctx.instances._clearOverage(); // window reset
  assert.equal(ctx.instances._overageResumeMode, false, 'resume mode cleared');
  assert.equal(b._overageGate().active, false, 'gate inactive after clear');
  assert.equal(b.summary().overageActive, false, 'B no longer paused');
  assert.equal(statuses.some(s => s.overageActive === false), true,
    'a status with overageActive:false was emitted for B');
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

  // Firing it delivers the resume prompt to the still-live conductor (verify clear).
  setResumeUsage(UNDER);
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

// ── Conduct orchestrator with NO in-control workers ───────────────────────
// The bug this fixes: a `.conduct` orchestrator that trips overage while owning
// no in-control workers (it tripped itself, or its workers were momentarily
// idle) used to fall into the terse Pass-3 `_directOverageStop` path and receive
// the leaf-worker soft-interrupt ("Do not make any more tool calls") — semantically wrong
// for the brain that must reconstruct state on resume. It's now ALWAYS steered
// gracefully (hasWorkers:false ⇒ no worker-halting clause). Identified durably by
// project === '.conduct', not the (opposite) `conducted` worker flag.
async function createConductor() {
  await ensureConductProject();
  const inst = await ctx.instances.create({ project: CONDUCT_PROJECT_NAME, mode: 'bypassPermissions' });
  await waitFor(() => inst.status === 'idle');
  return inst;
}

test('routing: no-workers Conduct orchestrator gets the graceful steer, not the terse soft-interrupt', async () => {
  await boot(routingScenario(), 'stop');
  const conductor = await createConductor();
  const cEvs = collect(conductor);

  // The orchestrator trips overage itself, with no workers in flight.
  conductor.prompt('TRIP go');

  // Steered (not direct-interrupted): steer notice + a VISIBLE graceful user_echo.
  await waitFor(() => sub(cEvs, 'auto_stop_overage').some(e => e.data.steered === true));
  await waitFor(() => cEvs.some(e => e.kind === 'user_echo' && /no workers in flight/.test(e.text || '')));
  const echo = cEvs.find(e => e.kind === 'user_echo' && /overage auto-stop/.test(e.text || ''));
  assert.ok(echo, 'graceful conductor steer surfaced as a visible user_echo');
  assert.equal(/interrupt_turn/.test(echo.text), false, 'no worker-halting clause when nothing is in flight');
  assert.equal(/Do not make any more tool calls/.test(echo.text), false, 'not the terse leaf-worker soft-interrupt');
  // The terse direct path (a hidden soft_interrupted annotation) was NOT taken.
  assert.equal(sub(cEvs, 'soft_interrupted').length, 0, 'orchestrator not direct-interrupted');
});

test('routing stop-resume: no-workers Conduct orchestrator is steered AND arms a resume timer', async () => {
  await boot(resumeRoutingScenario(), 'stop-resume');
  const conductor = await createConductor();
  const cEvs = collect(conductor);

  conductor.prompt('TRIP go');

  // Steered, resume-aware, with the graceful no-workers frame.
  await waitFor(() => sub(cEvs, 'auto_stop_overage').some(e => e.data.steered === true && e.data.resume === true));
  await waitFor(() => cEvs.some(e => e.kind === 'user_echo' && /no workers in flight/.test(e.text || '')));
  // The steer turn → idle arms the per-session resume timer (full preamble — it
  // was genuinely stopped mid-work), exactly as the direct path would have.
  await waitFor(() => ctx.instances._autoResumeTimers.has(conductor.sessionId));
  assert.equal(conductor.autoStoppedForOverage, true, 'flagged auto-stopped');
  assert.equal(conductor._overageWasStopped, true, 'full preamble — stopped mid-work');
  assert.equal(conductor.autoResumeAt != null, true, 'resume badge set');

  // Firing it delivers the resume prompt to the still-live orchestrator.
  setResumeUsage(UNDER);
  assert.equal(ctx.instances._fireAutoResumeNow(conductor.sessionId), true, 'pending resume fired');
  await waitFor(() => cEvs.some(e => e.kind === 'user_echo' && e.text === AUTO_RESUME_TEXT),
    { timeout: 10000 });
  assert.equal(conductor.proc != null, true, 'orchestrator never killed');
});

// ── Usage-verified resume: poll before resuming ──────────────────────────────

// (a) A due deadline whose usage-verify still reports OVER the bar does NOT resume —
// it reschedules ~recheck out and stays parked. This is what prevents the boundary
// re-trip (we never send a resume turn while still throttled). resetsAt is in the past
// (the window "reset" on our clock) so the fire is due immediately, yet usage says the
// account is still throttled.
test('stop-resume: fire while still-over-threshold reschedules, no resume sent', async () => {
  await boot(scenario([overageEvent({ resetsAt: nowSec() - 100 }), RESULT]), 'stop-resume');
  const inst = await spawnIdle();
  setResumeUsage(OVER); // window still fully consumed ⇒ verify says "still over"
  const evs = collect(inst);
  inst.prompt('go');
  // Past resetsAt ⇒ arm() schedules a near-now recheck rather than dead-ending.
  await waitFor(() => inst.autoResumeAt != null);
  assert.ok(inst.autoResumeAt < nowSec() + 30, 'recheck deadline is near-now, not a far-future clock');

  // Let the real sweep fire + re-check several times; it must never resume while OVER.
  await new Promise(r => setTimeout(r, 250)); // ~6 sweep cycles (40ms) × recheck (60ms)
  assert.equal(evs.some(e => e.kind === 'user_echo' && e.text === AUTO_RESUME_TEXT), false,
    'no resume prompt delivered while still throttled');
  assert.equal(ctx.instances._autoResumeTimers.has(inst.sessionId), true, 'still parked (re-armed each cycle)');
  assert.equal(inst.autoStoppedForOverage, true, 'still auto-stopped');
  assert.equal(ctx.instances._overageActive, true, 'global lockout still engaged while parked');
});

// (d) Fetch failure is "can't confirm": reschedule (do NOT resume blindly) until the
// bounded fallback trips (FAIL_OPEN_AFTER consecutive failures), then fail open and
// resume so a persistently-down usage API can't park the session forever.
test('stop-resume: fetch-failure fallback reschedules, then fails open and resumes', async () => {
  await boot(scenario([overageEvent({ resetsAt: nowSec() - 100 }), RESULT]), 'stop-resume');
  const inst = await spawnIdle();
  // Usage API unavailable (null) on every check → can't confirm, every time.
  ctx.instances._overageResume.fetchUsage = async () => null;
  const evs = collect(inst);
  inst.prompt('go');
  await waitFor(() => inst.autoResumeAt != null);
  // No resume yet (parks on the first can't-confirm rather than resuming blindly)...
  assert.equal(evs.some(e => e.kind === 'user_echo' && e.text === AUTO_RESUME_TEXT), false,
    'no blind resume on a can\'t-confirm fetch');
  // ...then the sweep re-checks each cycle and fails open on the Nth consecutive failure.
  await waitFor(() => evs.some(e => e.kind === 'user_echo' && e.text === AUTO_RESUME_TEXT),
    { timeout: 10000 });
  assert.equal(inst.proc != null, true, 'resumed via fail-open, never killed');
});

// (e) The global lockout must NOT lift while a session is still parked over-threshold;
// it releases only once the (usage-verified) resume actually fires. Ties the lockout
// release to the same sweep that resumes the session.
test('stop-resume GLOBAL: lockout held while parked over-threshold, lifts on verified resume', async () => {
  // Far-enough-future resetsAt that the gate's future-resetsAt rail is unambiguously
  // active regardless of subprocess round-trip latency (and stays future across a
  // reschedule). We drive the fire via fireNow, so we don't wait out this deadline.
  await boot(scenario([overageEvent({ resetsAt: nowSec() + 30 }), RESULT]), 'stop-resume');
  const inst = await spawnIdle();
  setResumeUsage(OVER);
  const evs = collect(inst);
  inst.prompt('go');
  await waitFor(() => ctx.instances._overageActive === true && inst.autoResumeAt != null);
  assert.equal(inst._overageGate().active, true, 'gate active while the window is pending');

  // Force a fire while usage still reports OVER ⇒ it reschedules, does NOT resume,
  // and the lockout + gate stay engaged.
  ctx.instances._fireAutoResumeNow(inst.sessionId);
  await new Promise(r => setTimeout(r, 150));
  assert.equal(ctx.instances._overageActive, true, 'lockout held while parked over-threshold');
  assert.equal(ctx.instances._autoResumeTimers.has(inst.sessionId), true, 'still parked');
  assert.equal(inst._overageGate().active, true, 'gate active while parked (resetsAt kept future)');
  assert.equal(evs.some(e => e.kind === 'user_echo' && e.text === AUTO_RESUME_TEXT), false,
    'not resumed while still over');

  // Window clears ⇒ the next (verified) fire resumes it, and only THEN the lockout lifts.
  setResumeUsage(UNDER);
  ctx.instances._fireAutoResumeNow(inst.sessionId);
  await waitFor(() => evs.some(e => e.kind === 'user_echo' && e.text === AUTO_RESUME_TEXT), { timeout: 10000 });
  await waitFor(() => ctx.instances._overageActive === false, { timeout: 10000 });
  assert.equal(ctx.instances._autoResumeTimers.has(inst.sessionId), false, 'nothing parked once released');
  assert.equal(inst._overageGate().active, false, 'gate lifts with the lockout');
});

// (f) Coalescing: many parked sessions coming due in one sweep cycle share ONE
// underlying usage fetch (accountUsage.js has no in-flight dedup — the controller
// must not open a fetch per session).
test('stop-resume: one usage fetch per sweep cycle across all due sessions', async () => {
  // Suppress the fast background sweep for this test so the single manual _tick() is
  // the only cycle — otherwise a background tick could steal the fetch and race the count.
  const savedLocal = process.env.ORCH_OVERAGE_RESUME_SWEEP_MS;
  process.env.ORCH_OVERAGE_RESUME_SWEEP_MS = '600000';
  try {
    await boot(scenario([overageEvent({ resetsAt: nowSec() + 3600 }), RESULT]), 'stop-resume');
    const a = await spawnIdle();
    a.prompt('go');
    await waitFor(() => a.autoResumeAt != null);
    const b = await spawnIdle();
    await b.prompt('queued while paused');
    await waitFor(() => b.autoResumeAt != null);

    // Force both deadlines due right now.
    const timers = ctx.instances._overageResume.timers;
    for (const sid of [...timers.keys()]) timers.set(sid, Date.now() - 1);

    // Counting fetcher returning still-over (so they reschedule, staying around).
    let calls = 0;
    ctx.instances._overageResume.fetchUsage = async () => { calls++; return usagePayload(OVER, nowSec() + 3600); };

    await ctx.instances._overageResume._tick(); // ONE sweep cycle, two due sessions
    assert.equal(calls, 1, 'exactly one underlying fetch for the whole cycle');
    assert.equal(timers.size, 2, 'both rescheduled, still parked');
  } finally {
    if (savedLocal === undefined) delete process.env.ORCH_OVERAGE_RESUME_SWEEP_MS;
    else process.env.ORCH_OVERAGE_RESUME_SWEEP_MS = savedLocal;
  }
});

// ── Settings → Models Apply: bidirectional on-demand re-evaluation ───────
// POST /api/settings/models/prefs, when it touches onOverage/overageThreshold,
// force-reevaluates whatever is happening right now instead of waiting for the
// next ~60s poll tick (lower threshold) or the resume deadline (raised/disabled
// threshold, which can be hours away). See src/routes.js's prefs handler.

test('Apply raising the threshold force-resumes a parked stop-resume session under the new bar', async () => {
  await boot(scenario([utilEvent({ util: 0.9, resetsAt: nowSec() + 3600 }), RESULT]), 'stop-resume');
  await setOverageThreshold({ enabled: true, value: 85 }); // stream utilization 0.9 >= 0.85 ⇒ trips
  const inst = await spawnIdle();
  const evs = collect(inst);
  inst.prompt('go');

  await waitFor(() => inst.autoResumeAt != null);
  assert.equal(ctx.instances._autoResumeTimers.has(inst.sessionId), true, 'parked under the old threshold');

  // Baseline: usage sits at 87% — still over the OLD 85% bar, so a check right now
  // (with no settings change) finds it still throttled. Proves the later resume is
  // caused by Apply's threshold change, not just any usage recheck.
  ctx.instances._overageResume.fetchUsage = async () => usagePayload(87, nowSec() + 3600);
  ctx.instances._fireAutoResumeNow(inst.sessionId);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ctx.instances._autoResumeTimers.has(inst.sessionId), true, 'still parked under the old bar');
  assert.equal(evs.some((e) => e.kind === 'user_echo' && e.text === AUTO_RESUME_TEXT), false, 'not resumed yet');

  // Apply raises the threshold to 90% — the SAME 87% usage now reads "under bar".
  const r = await api(ctx.baseUrl, 'POST', '/api/settings/models/prefs',
    { overageThreshold: { enabled: true, value: 90 } });
  assert.equal(r.status, 200);

  await waitFor(() => evs.some((e) => e.kind === 'user_echo' && e.text === AUTO_RESUME_TEXT), { timeout: 10000 });
  assert.equal(ctx.instances._autoResumeTimers.has(inst.sessionId), false,
    'resumed promptly by Apply, not the far-off deadline');
});

test('Apply lowering the threshold force-stops a live mid-turn session via the poll tick', async () => {
  // A single turn that never emits a result — the instance stays mid-turn
  // (status:'turn') for the whole test, which is what the poll tick requires.
  await boot(scenario([], 0), 'none');
  const inst = await spawnIdle();
  const evs = collect(inst);
  inst.prompt('go');
  await waitFor(() => inst.status === 'turn');

  // Test harness never starts the real ORCH_USAGE_POLL_MS interval (bootServer
  // calls createServer() directly, not server.js's start()) — forceTick() via the
  // route is the only thing that can trip this before the test times out.
  ctx.instances._usageMonitor.fetchUsage = async () => usagePayload(90, nowSec() + 3600);

  const r = await api(ctx.baseUrl, 'POST', '/api/settings/models/prefs',
    { onOverage: 'stop', overageThreshold: { enabled: true, value: 50 } });
  assert.equal(r.status, 200);

  await waitFor(() => sub(evs, 'auto_stop_overage').length > 0);
  assert.equal(sub(evs, 'auto_stop_overage')[0].data.resume, false, 'plain stop, no resume armed');
  assert.equal(inst.autoResumeAt, null);
  assert.equal(inst.proc != null, true, 'soft-interrupted, not killed');
});

test('Apply with nothing live or parked is a clean no-op', async () => {
  await boot(scenario([], 0), 'none');
  const r = await api(ctx.baseUrl, 'POST', '/api/settings/models/prefs',
    { onOverage: 'stop', overageThreshold: { enabled: true, value: 50 } });
  assert.equal(r.status, 200);
  assert.equal(ctx.instances._autoResumeTimers.size, 0);
  assert.equal(ctx.instances._overageActive, false);
});
