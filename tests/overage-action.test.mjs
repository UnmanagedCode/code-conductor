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
import { mkdtemp } from './tmpRegistry.mjs';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { setOnOverageAction, setOverageThreshold } from '../src/appSettings.ts';
import { AUTO_RESUME_TEXT } from '../src/instances.ts';
import { buildConductorResumePreamble } from '../src/overageResume.ts';
import { sendPrompt, approvePlan, rejectPlan, answerQuestion } from '../src/mcp/handlers.ts';
import { getAccountUsage } from '../src/accountUsage.ts';
import { ensureConductProject, CONDUCT_PROJECT_NAME } from '../src/conduct.ts';

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
// An ABORTED turn's ending. Card 2026-0183: the overage stop now soft-interrupts a
// mid-turn conductor instead of steering it, so nothing is written to that
// session's stdin and the generic `{on:{type:'prompt'}}` turns can no longer
// deliver its `result`. Without this turn the conductor never leaves 'turn' and
// every routing test dies on the runner's per-file timeout, reading as a flake.
const INTERRUPT_TURN = {
  on: { type: 'control', subtype: 'interrupt' },
  emit: [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null },
    { type: 'result', subtype: 'error_during_execution', stop_reason: 'interrupted',
      duration_ms: 20, total_cost_usd: 0.0001, is_error: true },
  ],
};

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
  const p = path.join(await mkdtemp('cc-overage-'), 'scenario.json');
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
  // usage cache — see src/overageResume.ts's _recheckMs()).
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

// Account-usage payload shape (src/accountUsage.ts): five_hour carries a 0–100
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
  assert.equal(ctx.instances._autoResumeTimers.has(inst.id), true, 'timer armed');
  assert.equal(inst.proc != null, true, 'session alive while waiting to resume');

  // Fire the armed timer deterministically: usage verifies clear, so the resume
  // prompt is delivered to the still-live session, just as the wall-clock fire would.
  assert.equal(ctx.instances._fireAutoResumeNow(inst.id), true, 'pending resume fired');
  await waitFor(() => evs.some(e => e.kind === 'user_echo' && e.text === AUTO_RESUME_TEXT),
    { timeout: 10000 });

  // Single teardown: no timer remains, flags cleared, session never killed.
  await waitFor(() => !ctx.instances._autoResumeTimers.has(inst.id));
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
  assert.equal(ctx.instances._autoResumeTimers.has(inst.id), true, 'timer armed from epoch resetsAt');
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
  assert.equal(ctx.instances._autoResumeTimers.has(inst.id), true, 'recheck deadline armed');
  assert.equal(inst.autoStoppedForOverage, true, 'stays flagged auto-stopped (not given up)');
  // Let a couple of recheck cycles run; it must never emit the give-up notice.
  await waitFor(() => ctx.instances._autoResumeTimers.has(inst.id)); // still parked
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
  assert.equal(ctx.instances._autoResumeTimers.has(inst.id), true, 'deadline recorded');
  assert.equal(inst.proc != null, true, 'session alive while waiting to resume');

  // The real wall-clock sweep delivers the resume prompt once now >= deadline.
  await waitFor(() => evs.some(e => e.kind === 'user_echo' && e.text === AUTO_RESUME_TEXT),
    { timeout: 10000 });

  // Regression: after fire the badge no longer outlives the timer — deadline
  // gone, flags cleared, and a status with autoResumeAt:null was emitted.
  await waitFor(() => !ctx.instances._autoResumeTimers.has(inst.id));
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
  const id = inst.id;

  inst.prompt('go');
  await waitFor(() => inst.autoResumeAt != null);
  assert.equal(ctx.instances._autoResumeTimers.has(id), true, 'deadline armed for the temp session');

  // Subprocess exits → temp-exit branch fires (instance dropped from byId).
  await inst.kill({ graceMs: 100 });
  await waitFor(() => !ctx.instances.get(r.body.id)); // temp row collapsed

  // No orphaned deadline survives; sweep has nothing left to fire.
  assert.equal(ctx.instances._autoResumeTimers.has(id), false, 'no orphan deadline after temp exit');
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
      INTERRUPT_TURN,
      { on: { type: 'prompt' }, emit: [] },
      { on: { type: 'prompt' }, emit: [] },
      { on: { type: 'prompt' }, emit: [] },
      { on: { type: 'prompt' }, emit: [] },
    ],
  };
}

// Each fake-claude process appends to whatever FAKE_CLAUDE_TRANSCRIPT names at ITS
// spawn (Instance.spawn snapshots env per subprocess), so pointing the var at a
// distinct file around each create gives one stdin capture per instance. Reading
// the wire is the only direct proof an abort reached the CLI.
async function createInstCapturing(opts, name) {
  const transcript = path.join(home, `stdin-${name}.jsonl`);
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcript;
  try { return { inst: await createInst(opts), transcript }; }
  finally { delete process.env.FAKE_CLAUDE_TRANSCRIPT; }
}
async function stdinOf(transcript) {
  try {
    return (await fs.readFile(transcript, 'utf8'))
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}
const interruptsIn = (lines) => lines.filter(
  l => l.type === 'control_request' && l.request?.subtype === 'interrupt');
const userLinesIn = (lines) => lines.filter(l => l.type === 'user' && l.message?.role === 'user');

async function createInst(opts) {
  const inst = await ctx.instances.create({ project: 'demo', mode: 'bypassPermissions', ...opts });
  await waitFor(() => inst.status === 'idle');
  return inst;
}

// ── Card 2026-0183 Parts A / A2: the mid-turn conductor is STOPPED, not steered ──
//
// A steer telling a conductor to halt its own workers is silently dropped by a
// model declaring midTurnSteering:false, so nothing may depend on the conductor
// acting on it: the conductor is soft-interrupted like every other mid-turn
// session, and Pass 3 stops the workers it owns directly. This changes behaviour
// for ALL models by design — the one deliberate exception to card 2026-0182's
// "unflagged stays byte-identical" pin.

// Drive one overage trip against a mid-turn in-control conductor, capturing both
// sessions' stdin. `flagged` binds the conductor to the curated preset that
// declares midTurnSteering:false, through the real resolver.
async function tripMidTurnConductor({ flagged, action = 'stop', scenarioObj }) {
  await boot(scenarioObj ?? routingScenario(), action);
  const c = await createInstCapturing({}, `cond-${flagged ? 'f' : 'u'}`);
  const conductor = c.inst;
  if (flagged) {
    conductor.backend = 'ollama';
    conductor.model = 'deepseek-v4-flash:0731-cloud';
    conductor._refreshModelCapabilities();
    assert.equal(conductor.acceptsMidTurnSteering, false, 'the flagged preset resolved');
  }
  const w = await createInstCapturing(
    { conducted: true, callerInstanceId: conductor.id }, `work-${flagged ? 'f' : 'u'}`);
  const cEvs = collect(conductor);
  const wEvs = collect(w.inst);
  const cStatuses = [];
  conductor.on('status', (sm) => cStatuses.push(sm));

  conductor.prompt('STAY');
  await waitFor(() => conductor.status === 'turn');
  w.inst.prompt('TRIP go');
  await waitFor(() => sub(cEvs, 'auto_stop_overage').length > 0);
  return { conductor, worker: w.inst, cEvs, wEvs, cStatuses,
    cTranscript: c.transcript, wTranscript: w.transcript };
}

// A-T1 (REGRESSION) — one shared body, run for both model configurations.
// Invariant: an overage trip against a mid-turn in-control conductor puts EXACTLY
// ONE `control_request subtype:interrupt` and NO steer text on that conductor's
// stdin, and the wire is IDENTICAL for a flagged and an unflagged model. Asserting
// the two configurations agree is what kills a reintroduced flag test inside
// _steerConductor.
for (const flagged of [false, true]) {
  test(`A-T1 routing: mid-turn conductor is soft-interrupted, not steered (flagged: ${flagged})`, async () => {
    const { conductor, cTranscript } = await tripMidTurnConductor({ flagged });
    await waitFor(async () => interruptsIn(await stdinOf(cTranscript)).length === 1);
    const lines = await stdinOf(cTranscript);
    assert.equal(interruptsIn(lines).length, 1, 'exactly one interrupt control_request');
    assert.equal(userLinesIn(lines).length, 1, 'only the STAY prompt — no steer was written');
    assert.ok(!/overage auto-stop just fired/.test(JSON.stringify(lines)),
      'the conductor steer text never reached the CLI');
    await waitFor(() => conductor.status === 'idle', { timeout: 10000 });
  });
}

// A-T2 (REGRESSION, paired) — Invariant: a MID-TURN conductor's
// `auto_stop_overage` no longer carries `steered:true`. The idle+subscribed
// conductor's still does (asserted by the idle test below); that pairing is what
// kills a mutant deleting `steered` from the idle branch's payload.
test('A-T2 routing: the mid-turn conductor stop is NOT reported as a steer', async () => {
  const { cEvs } = await tripMidTurnConductor({ flagged: false });
  const notices = sub(cEvs, 'auto_stop_overage');
  assert.equal(notices.length, 1, 'exactly one stop notice');
  assert.notEqual(notices[0].data.steered, true, 'a stop is not a steer');
});

// A-T3 (PIN) — Invariant: the overage stop is the SOFT tier, never FORCED.
// `interrupt({force:true})` returns before ever setting `this.interrupting`
// (src/instances.ts), so latching that flag off the 'status' event is the ONLY
// thing standing between a future force:true "optimisation" and an overage stop
// that discards partial work. Passes on main by construction; its value is the
// mutant.
test('A-T3 routing: the mid-turn conductor stop is the SOFT tier', async () => {
  const { cStatuses } = await tripMidTurnConductor({ flagged: false });
  // Latched off the event stream: _setStatus clears `interrupting` on turn exit,
  // so reading the live field after the abort lands would race.
  assert.ok(cStatuses.some(sm => sm.interrupting === true),
    'the conductor was ARMED (soft), not force-aborted');
});

// A2-T1 (REGRESSION) — Invariant: a worker protected by an in-control conductor is
// itself soft-interrupted (one interrupt on its stdin, one auto_stop_overage
// event) and is NOT armed for resume — its conductor is the sole driver on
// resume, told so by buildConductorResumePreamble's un-armed clause. Arming both would have the
// conductor's re-drive land mid-turn on a worker that just self-resumed, which is
// the mid-turn injection this whole card exists to close.
test('A2-T1 routing: a conductor\'s own worker is stopped too, and left UN-ARMED', async () => {
  const { conductor, worker, cEvs, wEvs, wTranscript } = await tripMidTurnConductor(
    { flagged: false, action: 'stop-resume', scenarioObj: resumeRoutingScenario() });

  await waitFor(() => sub(wEvs, 'auto_stop_overage').length > 0);
  await waitFor(async () => interruptsIn(await stdinOf(wTranscript)).length === 1);
  assert.equal(interruptsIn(await stdinOf(wTranscript)).length, 1,
    'the protected worker got its own interrupt');

  await waitFor(() => worker.status === 'idle', { timeout: 10000 });
  assert.equal(worker.autoStoppedForOverage, false, 'the worker is NOT armed for resume');
  assert.equal(instances._autoResumeTimers.has(worker.id), false, 'no worker resume timer');
  // …and the event says so. public/blocks.js renders `resume:true` as
  // "auto-resuming at <time>", which for an un-armed worker names a resume that
  // will never happen and contradicts its own null autoResumeAt badge. The event
  // must carry the PER-SESSION arming decision, not the routing mode.
  assert.equal(sub(wEvs, 'auto_stop_overage')[0].data.resume, false,
    'the un-armed worker\'s stop notice does not promise a resume');
  assert.equal(worker.autoResumeAt, null, 'and no badge contradicts it');
  // Paired positive: the CONDUCTOR is armed and its own notice DOES promise the
  // resume, so neither half above can pass by the whole stop-resume path being
  // broken or by `resume` being hard-coded false.
  await waitFor(() => instances._autoResumeTimers.has(conductor.id), { timeout: 10000 });
  assert.equal(conductor.autoStoppedForOverage, true, 'the conductor IS armed');
  assert.equal(sub(cEvs, 'auto_stop_overage')[0].data.resume, true,
    'the armed conductor\'s stop notice does promise a resume');
});

// REGRESSION — Invariant: `_overageDroppedCallbacks` is CLEARED when the resume
// fires, so a conductor stopped once WITH workers and later stopped again with
// none gets the plain resume text. Every set site was covered; no clear site was,
// and a stale flag makes the conductor variant assert dropped callbacks and
// un-armed workers that do not exist.
test('the stopped-workers flag is cleared by the resume, so a later trip gets the plain text', async () => {
  await boot(resumeRoutingScenario(), 'stop-resume');
  const conductor = await createInst({});
  const worker = await createInst({ conducted: true, callerInstanceId: conductor.id });
  const cEvs = collect(conductor);

  // A real pending callback — the flag is set only when a stop actually severs one.
  instances.subscribeIdle(conductor.sessionId, worker.sessionId);
  conductor.prompt('STAY');
  await waitFor(() => conductor.status === 'turn');
  worker.prompt('TRIP go');

  await waitFor(() => conductor._overageDroppedCallbacks === true);
  await waitFor(() => instances._autoResumeTimers.has(conductor.id), { timeout: 10000 });

  setResumeUsage(UNDER);
  assert.equal(instances._fireAutoResumeNow(conductor.id), true, 'pending resume fired');
  // It gets the CONDUCTOR text here — the paired positive that makes the clear
  // assertion below non-vacuous.
  await waitFor(() => cEvs.some(e => e.kind === 'user_echo'
    && /idle callbacks were dropped/.test(e.text ?? '')), { timeout: 10000 });
  assert.equal(conductor._overageDroppedCallbacks, false, 'the resume cleared the flag');

  // A second trip, this time with nothing subscribed, must deliver the PLAIN text —
  // asserting dropped callbacks and un-armed workers that do not exist would send
  // the conductor chasing phantoms.
  instances._clearOverage();
  instances._overageResume.clearAll();
  conductor._overageHandled = false;
  conductor.prompt('TRIP again');
  await waitFor(() => sub(cEvs, 'auto_stop_overage').length > 1, { timeout: 10000 });
  assert.equal(conductor._overageDroppedCallbacks, false,
    'no callback was severed this time, so the flag stays false');
  await waitFor(() => instances._autoResumeTimers.has(conductor.id), { timeout: 10000 });
  setResumeUsage(UNDER);
  assert.equal(instances._fireAutoResumeNow(conductor.id), true, 'second resume fired');
  await waitFor(() => cEvs.some(e => e.kind === 'user_echo' && e.text === AUTO_RESUME_TEXT),
    { timeout: 10000 });
});

// REGRESSION — Invariant: a conductor that owns workers but holds NO subscription
// still gets the un-armed clause. `severForOverageStop` reports only a severed
// CALLBACK, so keying the whole conductor text on it left this conductor with the
// PLAIN resume — never told its workers are un-armed and will not self-resume,
// which is the original hang returning through a narrower door.
test('a conductor with workers but no subscription still gets the un-armed clause', async () => {
  const { conductor, worker, cEvs } = await tripMidTurnConductor(
    { flagged: false, action: 'stop-resume', scenarioObj: resumeRoutingScenario() });
  // tripMidTurnConductor never subscribes — that is the point of this case.
  assert.equal(instances.isIdleCaller(conductor.id), false, 'precondition: no callback pending');

  await waitFor(() => conductor._overageUnarmedWorkers === true);
  assert.equal(conductor._overageDroppedCallbacks, false, 'and no callback was severed');
  await waitFor(() => worker.autoStoppedForOverage === false || worker.status === 'idle',
    { timeout: 10000 });

  await waitFor(() => instances._autoResumeTimers.has(conductor.id), { timeout: 10000 });
  setResumeUsage(UNDER);
  assert.equal(instances._fireAutoResumeNow(conductor.id), true, 'pending resume fired');
  // Exactly the un-armed clause, and NOT the dropped-callbacks one: asserting a
  // severed callback that never existed would send it re-checking phantoms.
  const expected = buildConductorResumePreamble({ unarmedWorkers: true });
  await waitFor(() => cEvs.some(e => e.kind === 'user_echo' && e.text === expected),
    { timeout: 10000 });
  assert.match(expected, /will NOT resume itself/, 'names the un-armed workers');
  // FALSE-6: scoped to the workers that were STOPPED, not to all of them — the flag
  // is set when at least one was, and an exempt or already-idle worker may still be
  // running. Telling the conductor to re-prompt "each one" would steer it into a
  // mid-turn injection, produced by this card's own resume text.
  assert.match(expected, /Any worker of yours that was stopped/, 'scopes the subject');
  assert.match(expected, /may still be running/, 'and warns to check before sending');
  assert.ok(!/idle callbacks were dropped/.test(expected), 'and claims no severed callback');
});

// REGRESSION — Invariant: a worker the stop left UN-ARMED refuses a queued send
// rather than accepting one it can never deliver. The queue is flushed only by a
// fired deadline and `cancel()` discards it, so queueing here strands the text
// forever; and arming a deadline instead would have the worker self-resume while
// its conductor re-drives it — the mid-turn injection this card closes.
test('an un-armed worker REFUSES a queued send instead of stranding it', async () => {
  const { conductor, worker } = await tripMidTurnConductor(
    { flagged: false, action: 'stop-resume', scenarioObj: resumeRoutingScenario() });
  await waitFor(() => worker._overageStoppedUnarmed === true);
  await waitFor(() => worker.status === 'idle', { timeout: 10000 });
  assert.equal(worker._overageGate().active, true, 'precondition: the lockout is engaged');

  await assert.rejects(
    () => worker.prompt('please keep working on this'),
    /messages cannot be queued for it/,
    'the send is refused, loudly');
  assert.equal(worker._overageQueue.length, 0, 'nothing was queued');
  assert.equal(worker.autoStoppedForOverage, false, 'and no resume was armed for it');
  assert.equal(instances._autoResumeTimers.has(worker.id), false, 'still un-armed');
  // The status frame tells the composer not to offer queueing at all.
  assert.equal(worker.summary().overageStoppedUnarmed, true);

  // The MCP surface soft-refuses rather than throwing: this project treats an
  // expected refusal as a normal result carrying a `code` (as sync_worktree,
  // merge_worktree and the session-resolution errors all do), and a conductor that
  // was just told to re-drive these workers hitting one early is a correctable
  // mistake it should be able to branch on. The WS path keeps the throw — an
  // `ack ok:false` and a failed send is the right shape for a human at a composer.
  // All FOUR sending tools: one shared guard with four call sites, so a per-site
  // revert must be caught per site — two entries left reject_plan and
  // answer_question throwing a raw 409, the shape this surface was changed not to
  // produce.
  for (const [label, call] of [
    ['send_prompt', () => sendPrompt({ sessionId: worker.sessionId, text: 'go on', subscribe: false }, { instances })],
    ['approve_plan', () => approvePlan({ sessionId: worker.sessionId, subscribe: false }, { instances })],
    ['reject_plan', () => rejectPlan({ sessionId: worker.sessionId, feedback: 'revise', subscribe: false }, { instances })],
    ['answer_question', () => answerQuestion({ sessionId: worker.sessionId, answers: [{ option: 'x' }], subscribe: false }, { instances })],
  ]) {
    const res = await call();
    assert.equal(res.ok, false, `${label}: soft-refused, not thrown`);
    assert.equal(res.code, 'OVERAGE_STOPPED_UNARMED', `${label}: names the state`);
    // No "Nothing was sent" — `ok:false` plus a refusal code already means that on
    // this surface (docs/protocol.md's refusal convention), so restating it is
    // reassurance on a channel that volunteers the fact.
    assert.match(res.reason, /re-drive it then/, `${label}: says when to retry`);
    assert.ok(!/Nothing was sent/.test(res.reason), `${label}: no redundant reassurance`);
  }
  assert.equal(worker._overageQueue.length, 0, 'and still nothing was queued');

  // Paired positive: its CONDUCTOR still queues normally — the refusal is scoped to
  // the un-armed worker, not a blanket lockout break.
  await conductor.prompt('a queued human message');
  assert.equal(conductor._overageQueue.length, 1, 'the conductor still queues');
});

// REGRESSION — Invariant: the refusal LIFTS. `overageSendRefused` gates on the live
// overage window, and the resume's cancel() clears the flag, so once the window
// resets the same worker accepts sends again. The existing refusal test asserts only
// that the refusal FIRES; nothing asserted it ever stops — and a conductor told to
// "re-prompt the ones you still need" that cannot re-prompt any of them is the
// failure this closes.
test('the un-armed refusal lifts when the window resets', async () => {
  const { worker } = await tripMidTurnConductor(
    { flagged: false, action: 'stop-resume', scenarioObj: resumeRoutingScenario() });
  await waitFor(() => worker._overageStoppedUnarmed === true);
  await waitFor(() => worker.status === 'idle', { timeout: 10000 });
  assert.equal(worker.overageSendRefused, true, 'precondition: refusing');

  // The window resets: the global gate goes inactive.
  instances._clearOverage();
  assert.equal(worker.overageSendRefused, false,
    'the refusal lifts with the window — it is not a latch');
  const res = await sendPrompt(
    { sessionId: worker.sessionId, text: 'carry on', subscribe: false }, { instances });
  assert.notEqual(res?.code, 'OVERAGE_STOPPED_UNARMED', 'and the send is accepted again');
});

// REGRESSION — Invariant: `_overageStoppedUnarmed` is ASSIGNED per trip, not latched.
// A later trip that finds this worker un-protected must clear it, or the worker is
// self-locked: every send refuses, `_armQueuedOnly` will not arm it, and the only
// thing that would clear the flag is the send it refuses.
test('a later trip that leaves a worker un-protected clears the un-armed flag', async () => {
  await boot(resumeRoutingScenario(), 'stop-resume');
  const conductor = await createInst({});
  const worker = await createInst({ conducted: true, callerInstanceId: conductor.id });
  const tripper = await createInst({});
  const wEvs = collect(worker);

  conductor.prompt('STAY');
  await waitFor(() => conductor.status === 'turn');
  worker.prompt('TRIP go');
  await waitFor(() => worker._overageStoppedUnarmed === true, { timeout: 10000 });
  await waitFor(() => worker.status === 'idle', { timeout: 10000 });

  // Trip #2 with the conductor gone: the worker is no longer protected, so this stop
  // ARMS it — and a stale flag would refuse everything queued into a session that
  // demonstrably will auto-resume.
  //
  // Everything below is deliberately arranged so the routing assignment is the ONLY
  // thing that can clear the flag: the worker is driven mid-turn by an INTERNAL
  // prompt (a non-internal one emits `user_prompt` → _cancelAutoResume → cancel(),
  // which clears the flag itself and would make this test pass vacuously), and a
  // THIRD session springs the trip.
  instances._clearOverage();
  instances._overageResume.clearAll();
  await instances.remove(conductor.id);
  assert.equal(worker._overageStoppedUnarmed, true, 'still flagged from trip #1');

  worker.prompt('STAY', [], { internal: true });
  await waitFor(() => worker.status === 'turn');
  tripper._overageHandled = false;
  tripper.prompt('TRIP go');
  await waitFor(() => sub(wEvs, 'auto_stop_overage').length > 1, { timeout: 10000 });

  assert.equal(worker._overageStoppedUnarmed, false,
    'the flag tracks THIS trip — an unprotected worker is not un-armed');
  assert.equal(worker.overageSendRefused, false, 'so nothing refuses its sends');
  await waitFor(() => worker.autoStoppedForOverage === true, { timeout: 10000 });
});

// REGRESSION — Invariant: an IDLE+subscribed conductor's one-shot on a target that is
// ALSO idle at trip time is severed. `_directOverageStop` severs only around sessions
// it stops, and Pass 3 stops only `status === 'turn'`, so this subscription survived
// both — and the watchdog then fires mid-lockout and delivers an `internal:true` wake
// the queue intercept does not hold, starting a fresh turn on the conductor just
// stopped.
test('an idle conductor\'s one-shot on an IDLE target is severed by the stop', async () => {
  await boot(resumeRoutingScenario(), 'stop-resume');
  const conductor = await createInst({});
  const idleWorker = await createInst({ conducted: true, callerInstanceId: conductor.id });
  const tripper = await createInst({});
  const cEvs = collect(conductor);

  // The conductor waits on a worker that is IDLE — subscribe_to_idle re-arms without
  // sending a prompt, so this is the ordinary shape, not an exotic one.
  instances.subscribeIdle(conductor.sessionId, idleWorker.sessionId);
  assert.equal(instances.isIdleCaller(conductor.id), true, 'precondition: parked on an idle target');
  assert.equal(idleWorker.status, 'idle', 'precondition: the target is idle, so Pass 3 skips it');

  tripper.prompt('TRIP go');
  await waitFor(() => sub(cEvs, 'auto_stop_overage').length > 0, { timeout: 10000 });

  assert.equal(instances.hasIdleSubscriber(idleWorker.id), false,
    'the one-shot on the idle target is severed');
  assert.equal(instances.isIdleCaller(conductor.id), false, 'the conductor holds no wait');
  assert.equal(conductor._overageDroppedCallbacks, true,
    'and it is marked, so its resume prompt says the callbacks are gone');
  // The severed wait cannot fire: the idle target reaching turn_end wakes nobody.
  instances.emit('event', { id: idleWorker.id, ev: { kind: 'turn_end', isError: false } });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(cEvs.some(e => e.kind === 'user_echo' && /finished its turn/.test(e.text || '')), false,
    'no wake reaches the stopped conductor');
});

// REGRESSION — Invariant: the conductor clauses ride the QUEUED-ONLY preamble too.
// The human typing into a stopped conductor arms it queued-only, and that branch
// discarded both clauses — so it went back to waiting for a wake nothing will send.
test('a queued-only conductor still gets its dropped-callbacks clause', async () => {
  await boot(resumeRoutingScenario(), 'stop-resume');
  const conductor = await createInst({});
  const worker = await createInst({ conducted: true, callerInstanceId: conductor.id });
  const cEvs = collect(conductor);

  instances.subscribeIdle(conductor.sessionId, worker.sessionId);
  conductor.prompt('STAY');
  await waitFor(() => conductor.status === 'turn');
  worker.prompt('TRIP go');
  await waitFor(() => conductor._overageDroppedCallbacks === true, { timeout: 10000 });
  await waitFor(() => conductor.status === 'idle', { timeout: 10000 });

  // The human types into the stopped conductor → queued, and `_overageWasStopped`
  // stays true here, so force the queued-only preamble the way an idle/new session
  // reaches it: a queued message with wasStopped false.
  conductor._overageWasStopped = false;
  await conductor.prompt('and do this next');
  assert.equal(conductor._overageQueue.length, 1, 'precondition: queued');

  await waitFor(() => instances._autoResumeTimers.has(conductor.id), { timeout: 10000 });
  setResumeUsage(UNDER);
  assert.equal(instances._fireAutoResumeNow(conductor.id), true, 'resume fired');
  const echo = await waitFor(() => cEvs.find(e => e.kind === 'user_echo'
    && /Delivering the messages you queued/.test(e.text || '')), { timeout: 10000 });
  assert.match(echo.text, /idle callbacks were dropped/,
    'the softened preamble still carries the conductor clause');
  assert.match(echo.text, /and do this next/, 'alongside the queued message');
});

// A2 — Invariant: the conductor's OUTGOING idle subscriptions are dropped when its
// workers are stopped. Without this, each interrupted worker's turn_end wakes the
// conductor with an `internal:true` prompt — which the overage queue intercept
// deliberately does NOT hold — restarting the burn the stop exists to prevent.
test('A2 routing: stopping a conductor\'s workers drops its pending idle callbacks', async () => {
  await boot(routingScenario(), 'stop');
  const conductor = await createInst({});
  const worker = await createInst({ conducted: true, callerInstanceId: conductor.id });
  const cEvs = collect(conductor);

  instances.subscribeIdle(conductor.sessionId, worker.sessionId);
  assert.equal(instances.isIdleCaller(conductor.id), true, 'precondition: subscribed');

  conductor.prompt('STAY');
  await waitFor(() => conductor.status === 'turn');
  worker.prompt('TRIP go');
  await waitFor(() => sub(cEvs, 'auto_stop_overage').length > 0);

  assert.equal(instances.isIdleCaller(conductor.id), false,
    'the conductor no longer holds an outgoing subscription');
  assert.equal(instances.hasIdleSubscriber(worker.id), false,
    'and the worker has no watcher left to wake');
  // The interrupted worker reaching idle must NOT produce a wake prompt.
  await waitFor(() => worker.status === 'idle', { timeout: 10000 });
  await waitFor(() => conductor.status === 'idle', { timeout: 10000 });
  assert.equal(cEvs.some(e => e.kind === 'user_echo' && /finished its turn/.test(e.text || '')), false,
    'no wake callback was delivered to the stopped conductor');
  assert.equal(conductor._overageDroppedCallbacks, true,
    'and the conductor is marked so its resume prompt says the callbacks are gone');
});

test('routing: conductor idle+subscribed → conductor is steered via injected prompt, worker untouched', async () => {
  await boot(routingScenario(), 'stop');
  const conductor = await createInst({});
  const worker = await createInst({ conducted: true, callerInstanceId: conductor.id });
  const cEvs = collect(conductor);
  const wEvs = collect(worker);

  // Conductor stays idle but is parked waiting on the worker (isIdleCaller).
  ctx.instances.subscribeIdle(conductor.sessionId, worker.sessionId);
  assert.equal(ctx.instances.isIdleCaller(conductor.id), true);

  worker.prompt('TRIP go');

  await waitFor(() => sub(cEvs, 'auto_stop_overage').some(e => e.data.steered === true));
  // The idle branch alone still STEERS (there is no turn to interrupt), and the steer
  // is INSTRUCTION-ONLY: it is sent from Pass 2, before Pass 3 decides what to stop,
  // so it must claim nothing about what was stopped or which callbacks were dropped.
  const steer = await waitFor(() => cEvs.find(e => e.kind === 'user_echo'
    && /overage auto-stop just fired/.test(e.text || '')));
  assert.match(steer.text, /do not message your workers and do not wait to be woken/);
  assert.ok(!/already been stopped for you/.test(steer.text),
    'the steer claims nothing about what was stopped');
  assert.ok(!/callbacks were dropped/.test(steer.text),
    'nor about which callbacks were dropped');
  // …and Pass 3 does stop them (card 2026-0183 A2 — they used to be skipped).
  await waitFor(() => sub(wEvs, 'auto_stop_overage').length > 0);
  await waitFor(() => worker.status === 'idle', { timeout: 10000 });
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
  assert.equal(ctx.instances._autoResumeTimers.has(inst.id), true, 'timer armed');

  // User types during the paused window — the message is queued, not sent.
  await inst.prompt('actually do this instead');
  await waitFor(() => evs.some(e => e.kind === 'overage_message_queued'));
  // Resume stays armed; nothing was cancelled.
  assert.equal(ctx.instances._autoResumeTimers.has(inst.id), true, 'timer still armed after typing');
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
  assert.equal(ctx.instances._fireAutoResumeNow(inst.id), true, 'pending resume fired');

  // Exactly one delivered turn carrying the resume text AND both queued messages.
  await waitFor(() => evs.some(e => e.kind === 'user_echo' &&
    e.text.includes(AUTO_RESUME_TEXT) && e.text.includes('first queued') && e.text.includes('second queued')),
    { timeout: 10000 });
  const echoes = evs.filter(e => e.kind === 'user_echo' && e.text.includes(AUTO_RESUME_TEXT));
  assert.equal(echoes.length, 1, 'single combined resume turn');

  // A system line records the flush, the queue is drained, flags cleared, alive.
  assert.equal(sub(evs, 'auto_resume').some(e => e.data.count === 2), true, 'auto_resume line with count=2');
  await waitFor(() => !ctx.instances._autoResumeTimers.has(inst.id));
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
  assert.equal(ctx.instances._autoResumeTimers.has(b.id), true, 'timer armed for B');
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
  assert.equal(ctx.instances._fireAutoResumeNow(b.id), true, 'resume fired for B');
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
      INTERRUPT_TURN,                                       // an aborted turn's result
      { on: { type: 'prompt' }, emit: [RESULT] },           // idle steer / resume → idle
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
  assert.equal(ctx.instances.isIdleCaller(conductor.id), true);

  worker.prompt('TRIP go');

  // Conductor is steered, resume-aware.
  await waitFor(() => sub(cEvs, 'auto_stop_overage').some(e => e.data.steered === true && e.data.resume === true));
  // The resume flag survives the steer prompt's synchronous user_prompt, and the
  // conductor's steer turn → idle arms the per-session timer.
  await waitFor(() => ctx.instances._autoResumeTimers.has(conductor.id));
  assert.equal(conductor.autoStoppedForOverage, true, 'flag survived the steer prompt');
  assert.equal(conductor.autoResumeAt != null, true, 'conductor resume badge set');

  // Firing it delivers the resume prompt to the still-live conductor (verify clear).
  // Its workers were stopped and its callbacks dropped, so the CONDUCTOR variant
  // is delivered: without both of its facts the conductor would sit waiting on a
  // callback that will never fire, in front of workers that will never self-resume.
  setResumeUsage(UNDER);
  assert.equal(ctx.instances._fireAutoResumeNow(conductor.id), true, 'pending resume fired');
  // Both clauses: this conductor lost a callback AND owns an un-armed worker.
  const bothClauses = buildConductorResumePreamble({ droppedCallbacks: true, unarmedWorkers: true });
  await waitFor(() => cEvs.some(e => e.kind === 'user_echo' && e.text === bothClauses),
    { timeout: 10000 });
  assert.match(bothClauses, /idle callbacks were dropped/, 'names the dropped callbacks');
  assert.match(bothClauses, /will NOT resume itself/, 'and that the stopped workers are un-armed');
  assert.equal(conductor.proc != null, true, 'conductor never killed');
});

// A-T4 (PIN) — Invariant: under stop-resume a mid-turn conductor stopped by the
// bare soft interrupt STILL arms its per-session resume timer and keeps
// autoStoppedForOverage / _overageWasStopped. Driving it false: dropping the
// `autoStoppedForOverage = true` assignment leaves the status→idle handler nothing
// to arm on. Passes on main; it is a guard, not a regression test.
test('A-T4 routing stop-resume: the mid-turn conductor stop still arms a resume timer', async () => {
  await boot(resumeRoutingScenario(), 'stop-resume');
  const conductor = await createInst({});
  const worker = await createInst({ conducted: true, callerInstanceId: conductor.id });
  const cEvs = collect(conductor);

  // Put the conductor mid-turn first (STAY emits nothing → stays in 'turn').
  conductor.prompt('STAY');
  await waitFor(() => conductor.status === 'turn');

  worker.prompt('TRIP go');

  await waitFor(() => sub(cEvs, 'auto_stop_overage').some(e => e.data.resume === true));
  // The armed abort lands at the block edge; the fake's INTERRUPT_TURN answers it
  // with a result, so the conductor reaches idle and arms.
  await waitFor(() => ctx.instances._autoResumeTimers.has(conductor.id), { timeout: 10000 });
  assert.equal(conductor.autoStoppedForOverage, true);
  assert.equal(conductor._overageWasStopped, true, 'full preamble — stopped mid-work');
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
  await waitFor(() => ctx.instances._autoResumeTimers.has(worker.id));
  assert.equal(worker.autoStoppedForOverage, true);
});

// ── Conduct orchestrator with NO in-control workers ───────────────────────
// A `.conduct` orchestrator that trips overage while owning no in-control workers
// (it tripped itself, or its workers were momentarily idle) used to be steered
// gracefully rather than direct-stopped. Card 2026-0183 Part A ends that
// distinction for the MID-TURN case — a steer the model may silently drop cannot
// be load-bearing, and a `stream` or `poll` trip always finds the orchestrator
// mid-turn — so it now takes the same soft interrupt as every other session. What
// still separates it from a leaf worker is what happens on RESUME, which these two
// pin. Identified durably by project === '.conduct', not the (opposite) `conducted`
// worker flag.
async function createConductor(name) {
  await ensureConductProject();
  const transcript = name ? path.join(home, `stdin-${name}.jsonl`) : null;
  if (transcript) process.env.FAKE_CLAUDE_TRANSCRIPT = transcript;
  try {
    const inst = await ctx.instances.create({ project: CONDUCT_PROJECT_NAME, mode: 'bypassPermissions' });
    await waitFor(() => inst.status === 'idle');
    return { inst, transcript };
  } finally { delete process.env.FAKE_CLAUDE_TRANSCRIPT; }
}

// REGRESSION — Invariant: a mid-turn no-workers orchestrator is soft-interrupted
// with EXACTLY ONE control_request and NO steer text on its stdin, identical to
// any other mid-turn session.
test('routing: a mid-turn no-workers Conduct orchestrator is soft-interrupted, not steered', async () => {
  await boot(routingScenario(), 'stop');
  const { inst: conductor, transcript } = await createConductor('conduct-stop');
  const cEvs = collect(conductor);

  // The orchestrator trips overage itself, with no workers in flight.
  conductor.prompt('TRIP go');

  await waitFor(() => sub(cEvs, 'auto_stop_overage').length > 0);
  await waitFor(async () => interruptsIn(await stdinOf(transcript)).length === 1);
  const lines = await stdinOf(transcript);
  assert.equal(interruptsIn(lines).length, 1, 'exactly one interrupt control_request');
  assert.equal(userLinesIn(lines).length, 1, 'only the TRIP prompt — no steer was written');
  assert.ok(!/overage auto-stop just fired/.test(JSON.stringify(lines)),
    'the conductor steer text never reached the CLI');
  assert.notEqual(sub(cEvs, 'auto_stop_overage')[0].data.steered, true, 'a stop is not a steer');
  await waitFor(() => conductor.status === 'idle', { timeout: 10000 });
});

// PIN — Invariant: the stopped orchestrator arms its resume with the FULL
// preamble, and — having stopped no workers — gets the plain AUTO_RESUME_TEXT, not
// the conductor variant. The variant's two claims ("your callbacks were dropped",
// "your workers will not resume themselves") would both be false here, and a
// resume prompt that lies sends the orchestrator chasing phantom workers.
test('routing stop-resume: a no-workers orchestrator arms a resume and gets the PLAIN resume text', async () => {
  await boot(resumeRoutingScenario(), 'stop-resume');
  const { inst: conductor } = await createConductor();
  const cEvs = collect(conductor);

  conductor.prompt('TRIP go');

  await waitFor(() => sub(cEvs, 'auto_stop_overage').some(e => e.data.resume === true));
  await waitFor(() => ctx.instances._autoResumeTimers.has(conductor.id), { timeout: 10000 });
  assert.equal(conductor.autoStoppedForOverage, true, 'flagged auto-stopped');
  assert.equal(conductor._overageWasStopped, true, 'full preamble — stopped mid-work');
  assert.equal(conductor._overageDroppedCallbacks, false, 'it stopped no workers');
  assert.equal(conductor.autoResumeAt != null, true, 'resume badge set');

  setResumeUsage(UNDER);
  assert.equal(ctx.instances._fireAutoResumeNow(conductor.id), true, 'pending resume fired');
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
  assert.equal(ctx.instances._autoResumeTimers.has(inst.id), true, 'still parked (re-armed each cycle)');
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
  ctx.instances._fireAutoResumeNow(inst.id);
  await new Promise(r => setTimeout(r, 150));
  assert.equal(ctx.instances._overageActive, true, 'lockout held while parked over-threshold');
  assert.equal(ctx.instances._autoResumeTimers.has(inst.id), true, 'still parked');
  assert.equal(inst._overageGate().active, true, 'gate active while parked (resetsAt kept future)');
  assert.equal(evs.some(e => e.kind === 'user_echo' && e.text === AUTO_RESUME_TEXT), false,
    'not resumed while still over');

  // Window clears ⇒ the next (verified) fire resumes it, and only THEN the lockout lifts.
  setResumeUsage(UNDER);
  ctx.instances._fireAutoResumeNow(inst.id);
  await waitFor(() => evs.some(e => e.kind === 'user_echo' && e.text === AUTO_RESUME_TEXT), { timeout: 10000 });
  await waitFor(() => ctx.instances._overageActive === false, { timeout: 10000 });
  assert.equal(ctx.instances._autoResumeTimers.has(inst.id), false, 'nothing parked once released');
  assert.equal(inst._overageGate().active, false, 'gate lifts with the lockout');
});

// (f) Coalescing: many parked sessions coming due in one sweep cycle share ONE
// underlying usage fetch (accountUsage.ts has no in-flight dedup — the controller
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
// threshold, which can be hours away). See src/routes.ts's prefs handler.

test('Apply raising the threshold force-resumes a parked stop-resume session under the new bar', async () => {
  await boot(scenario([utilEvent({ util: 0.9, resetsAt: nowSec() + 3600 }), RESULT]), 'stop-resume');
  await setOverageThreshold({ enabled: true, value: 85 }); // stream utilization 0.9 >= 0.85 ⇒ trips
  const inst = await spawnIdle();
  const evs = collect(inst);
  inst.prompt('go');

  await waitFor(() => inst.autoResumeAt != null);
  assert.equal(ctx.instances._autoResumeTimers.has(inst.id), true, 'parked under the old threshold');

  // Baseline: usage sits at 87% — still over the OLD 85% bar, so a check right now
  // (with no settings change) finds it still throttled. Proves the later resume is
  // caused by Apply's threshold change, not just any usage recheck.
  ctx.instances._overageResume.fetchUsage = async () => usagePayload(87, nowSec() + 3600);
  ctx.instances._fireAutoResumeNow(inst.id);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ctx.instances._autoResumeTimers.has(inst.id), true, 'still parked under the old bar');
  assert.equal(evs.some((e) => e.kind === 'user_echo' && e.text === AUTO_RESUME_TEXT), false, 'not resumed yet');

  // Apply raises the threshold to 90% — the SAME 87% usage now reads "under bar".
  const r = await api(ctx.baseUrl, 'POST', '/api/settings/models/prefs',
    { overageThreshold: { enabled: true, value: 90 } });
  assert.equal(r.status, 200);

  await waitFor(() => evs.some((e) => e.kind === 'user_echo' && e.text === AUTO_RESUME_TEXT), { timeout: 10000 });
  assert.equal(ctx.instances._autoResumeTimers.has(inst.id), false,
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
  // calls createServer() directly, not server.ts's start()) — forceTick() via the
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
