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
import { bootServer, api, waitFor, freshProjectsRoot, rmrf, settle } from './helpers.mjs';
import { setOnOverageAction, setOverageThreshold } from '../src/appSettings.ts';
import { AUTO_RESUME_TEXT } from '../src/instances.ts';
import { buildConductorResumePreamble, IDLE_PARKED_RESUME_TEXT } from '../src/overageResume.ts';
import { sendPrompt, approvePlan, rejectPlan, answerQuestion } from '../src/mcp/handlers.ts';
import { getAccountUsage } from '../src/accountUsage.ts';
import { installUsageSeamTripwire, assertUsageSeamInjected, assertUsageSeamsInstalled } from './overageUsageSeam.mjs';
import { ensureConductProject, CONDUCT_PROJECT_NAME, isConductorInstance } from '../src/conduct.ts';

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
let ctx, instances, home, seam;
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
  // clear timer; clearAll() drops the deadline map/sweep/checking/failCount. The
  // fetchUsage seams reset to a counting NON-NETWORK tripwire, not the real
  // getAccountUsage — see tests/overageUsageSeam.mjs (card 2026-0208).
  instances._clearOverage();
  instances._overageResume.clearAll();
  seam = installUsageSeamTripwire(instances);
});
afterEach(async () => {
  await instances.shutdown();
  await rmrf(home);
  assertUsageSeamInjected(seam);
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
// the two configurations agree is what kills a reintroduced mid-turn-steering flag
// test on the stop path.
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

// A-T2 (REGRESSION, paired) — Invariant: the `steered` field is GONE from
// `auto_stop_overage` entirely (card 2026-0203 deleted the only emitter). Asserted
// as absence, not falsiness: `notEqual(…, true)` alone survives a mutant that
// re-adds `steered:false`.
test('A-T2 routing: the mid-turn conductor stop is NOT reported as a steer', async () => {
  const { cEvs } = await tripMidTurnConductor({ flagged: false });
  const notices = sub(cEvs, 'auto_stop_overage');
  assert.equal(notices.length, 1, 'exactly one stop notice');
  assert.equal('steered' in notices[0].data, false, 'the steer marker no longer exists');
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
  // The conductor already OWNS this worker (callerInstanceId at spawn), so the
  // worker's TRIP turn arms the wake as that turn starts; nothing to register.
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

// REGRESSION — Invariant: the un-armed clause is reported from the STOP marking
// (`_overageUnarmedWorkers`, set in Pass 3), independently of whether a callback
// was severed. Keying the whole conductor text on the severed callback left a
// conductor with the PLAIN resume — never told its workers are un-armed and will
// not self-resume, which is the original hang returning through a narrower door.
//
// The two facts now CO-OCCUR on this path: ownership means a mid-turn owned
// worker always has an armed wake, so the stop that leaves it un-armed always
// also severs a callback. The independence of the clause is therefore pinned
// where it actually lives — on the pure preamble builder, below.
test('a conductor whose workers are stopped un-armed gets the un-armed clause', async () => {
  const { conductor, worker, cEvs } = await tripMidTurnConductor(
    { flagged: false, action: 'stop-resume', scenarioObj: resumeRoutingScenario() });

  await waitFor(() => conductor._overageUnarmedWorkers === true);
  await waitFor(() => worker.autoStoppedForOverage === false || worker.status === 'idle',
    { timeout: 10000 });

  await waitFor(() => instances._autoResumeTimers.has(conductor.id), { timeout: 10000 });
  setResumeUsage(UNDER);
  assert.equal(instances._fireAutoResumeNow(conductor.id), true, 'pending resume fired');
  const expected = buildConductorResumePreamble({
    unarmedWorkers: true, droppedCallbacks: conductor._overageDroppedCallbacks });
  await waitFor(() => cEvs.some(e => e.kind === 'user_echo' && e.text === expected),
    { timeout: 10000 });
  assert.match(expected, /will NOT resume itself/, 'names the un-armed workers');
  // FALSE-6: scoped to the workers that were STOPPED, not to all of them — the flag
  // is set when at least one was, and an exempt or already-idle worker may still be
  // running. Telling the conductor to re-prompt "each one" would steer it into a
  // mid-turn injection, produced by this card's own resume text.
  assert.match(expected, /Any worker of yours that was stopped/, 'scopes the subject');
  assert.match(expected, /may still be running/, 'and warns to check before sending');
  // …and the clause does not RIDE on the severed callback: the same builder, with
  // droppedCallbacks off, still carries it. This is the original invariant's real
  // home — under ownership the two facts co-occur on the integration path above,
  // because a mid-turn owned worker always has an armed wake for its conductor.
  const unarmedOnly = buildConductorResumePreamble({ unarmedWorkers: true });
  assert.match(unarmedOnly, /will NOT resume itself/, 'the un-armed clause stands alone');
  assert.ok(!/idle callbacks were dropped/.test(unarmedOnly),
    'and claims no severed callback when none was severed');
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
    ['send_prompt', () => sendPrompt({ sessionId: worker.sessionId, text: 'go on' }, { instances })],
    ['approve_plan', () => approvePlan({ sessionId: worker.sessionId }, { instances })],
    ['reject_plan', () => rejectPlan({ sessionId: worker.sessionId, feedback: 'revise' }, { instances })],
    ['answer_question', () => answerQuestion({ sessionId: worker.sessionId, answers: [{ option: 'x' }] }, { instances })],
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
// REGRESSION — Invariant: `overageSendRefused` ANDs the un-armed flag with the LIVE
// gate, and the gate is load-bearing. Asserted under plain `Stop`, where Pass 3 still
// sets the flag (it does so regardless of mode) but `_overageGate` is inactive because
// it requires `_overageResumeMode` — so the flag is TRUE and the refusal must still be
// false. That combination is the only place the conjunct is visible: after a window
// RELEASE the flag is cleared too, so `overageSendRefused` short-circuits on its first
// line and a test there cannot see a missing gate. Plain `Stop` has no queue at all,
// so there is nothing to strand and nothing to refuse.
test('plain Stop: an un-armed worker is flagged but NOT refused (no queue to strand)', async () => {
  const { worker } = await tripMidTurnConductor(
    { flagged: false, action: 'stop', scenarioObj: routingScenario() });
  await waitFor(() => worker._overageStoppedUnarmed === true);

  assert.equal(instances._overageActive, true, 'the window is active');
  assert.equal(instances._overageResumeMode, false, 'but not in stop-resume, so the gate is inactive');
  assert.equal(worker._overageGate().active, false, 'gate inactive with the flag still set');
  assert.equal(worker.overageSendRefused, false,
    'the flag alone does not refuse — overageSendRefused ANDs it with the live gate');

  const res = await sendPrompt(
    { sessionId: worker.sessionId, text: 'carry on' }, { instances });
  assert.notEqual(res?.code, 'OVERAGE_STOPPED_UNARMED', 'so the send is accepted');
});

test('the window release clears the un-armed flag, not just the gate', async () => {
  const { worker } = await tripMidTurnConductor(
    { flagged: false, action: 'stop-resume', scenarioObj: resumeRoutingScenario() });
  await waitFor(() => worker._overageStoppedUnarmed === true);
  await waitFor(() => worker.status === 'idle', { timeout: 10000 });
  assert.equal(worker.overageSendRefused, true, 'precondition: refusing');

  const summaries = [];
  const onStatus = (sm) => { if (sm.id === worker.id) summaries.push(sm); };
  instances.on('status', onStatus);

  // The window resets. Asserting the FLAG, not overageSendRefused: the gate alone
  // settles that predicate, so a test that only reads it passes whether or not the
  // flag was ever cleared — the vacuity class that hid this for a round.
  instances._clearOverage();
  instances.off('status', onStatus);
  assert.equal(worker._overageStoppedUnarmed, false,
    'the release clears the flag itself, not merely the window it is ANDed with');
  // The release re-emits every summary; that frame is what re-renders the composer,
  // so a stale flag locks Send with no way for the human to clear it.
  const last = summaries.at(-1);
  assert.ok(last, 'the release re-emitted this session\'s summary');
  assert.equal(last.overageStoppedUnarmed, false, 'and the frame does not re-lock the composer');

  const res = await sendPrompt(
    { sessionId: worker.sessionId, text: 'carry on' }, { instances });
  assert.notEqual(res?.code, 'OVERAGE_STOPPED_UNARMED', 'and sends are accepted again');
});

// REGRESSION — Invariant: the PER-SESSION clear in OverageResumeController.cancel()
// drops the un-armed flag while the global window is still active — the one property
// that distinguishes it from the release clear above, and the reason the two are not
// redundant. Asserted on the flag with the gate left ACTIVE, so neither the gate nor
// the release can settle it.
test('cancelling a session\'s overage state clears its un-armed flag mid-window', async () => {
  const { worker } = await tripMidTurnConductor(
    { flagged: false, action: 'stop-resume', scenarioObj: resumeRoutingScenario() });
  await waitFor(() => worker._overageStoppedUnarmed === true);
  await waitFor(() => worker.status === 'idle', { timeout: 10000 });

  instances._cancelAutoResume(worker.id);

  assert.equal(instances._overageActive, true, 'the global window is still active');
  assert.equal(worker._overageStoppedUnarmed, false, 'yet this session is no longer un-armed');
  assert.equal(worker.overageSendRefused, false, 'so its sends are accepted mid-window');
});

// The round-3 test 'a later trip that leaves a worker un-protected clears the
// un-armed flag' lived here. It is OBSOLETE, not broken: `_handleOverageTrip` returns
// early on `_overageActive`, so routing runs exactly once per window, and the only
// two writers of `_overageActive = false` are the constructor and `_clearOverage` —
// which now clears `_overageStoppedUnarmed` itself. A worker can therefore never
// reach a second routing pass still carrying the previous window's flag, so Pass 3's
// `= unarmed` assignment and a conditional `if (unarmed) = true` are equivalent, and
// the only way to fail the old test was to poke `_overageActive` directly, i.e. to
// assert a state production cannot produce. The window-release clear below owns the
// real invariant.

// REGRESSION — Invariant: the stop's sever (`_severOverageWakes`, called from
// `_directOverageStop`) reaches a wake held on a target Pass 3 leaves RUNNING.
// Pass 3 stops only what is in the usage-window flow, so such a wake would survive
// otherwise, and the heartbeat then fires mid-lockout, repeatedly, delivering an
// `internal:true` wake the queue intercept does not hold and starting a fresh turn
// on the conductor just stopped.
//
// WHY THE TARGET IS NON-OWNED — do NOT "simplify" this back to a conducted worker.
// This test used to stage a CONDUCTED ollama worker under the Claude conductor. Card
// 2026-0212 root-scoped `_inUsageWindowFlow`, so such a worker is now IN the flow and
// Pass 3 stops it — that staging no longer produces a target Pass 3 leaves running.
// The only remaining reachable shape is a NON-OWNED one: `IdleSubscriptionHub`
// imposes no ownership check, so a conductor can hold a wake (via `noteDispatch`) on
// a standalone session it never spawned, which has no `callerInstanceId` for the root
// walk to climb and so stays exempt. That non-owned wake edge is **card 2026-0213**
// and is deliberately NOT fixed here.
//
// NOT FIX-DEPENDENT, and it never was: root-scoping changes nothing for a parentless
// session, so this staging behaves identically either side of card 2026-0212. What
// the card made unreachable was the OLD staging, not the invariant. The mutant this
// test exists to kill is unchanged — delete `this._severOverageWakes(inst)` from
// `_directOverageStop`.
//
// `claudeWorker` is what makes the conductor in-control (Pass 1 only sees instances
// in the flow), which is what gets the conductor stopped in Pass 2 — and the stop is
// what runs the sever. Without it there is no sever to observe.
//
// The both-directions half of the sever (a THIRD session waiting ON this conductor
// also loses its wait and is marked) is pinned at the hub layer, by
// tests/deferred-wake.test.mjs → 'stopping a session drops a subscription held by a
// caller that does not OWN it'; it cannot be staged here, because a wake on the
// conductor would require the conductor to be mid-turn.
test('an idle conductor\'s wake on a NON-OWNED target Pass 3 leaves running is severed by the stop', async () => {
  await boot(resumeRoutingScenario(), 'stop-resume');
  const conductor = await createInst({});
  const claudeWorker = await createInst({ conducted: true, callerInstanceId: conductor.id });
  const standalone = await createInst({});   // NOT conducted, NO callerInstanceId
  const tripper = await createInst({});
  const cEvs = collect(conductor);

  standalone.backend = 'ollama';
  standalone.model = 'deepseek-v4-flash:0731-cloud';
  standalone._refreshModelCapabilities();
  // No `callerInstanceId`, so the root walk has nothing to climb and this session is
  // its own root — which is exactly why it is exempt under BOTH the old downward
  // predicate and the new root-scoped one. Deliberately asserted through
  // `_inUsageWindowFlow` alone (not `agentTreeRoot`) so this test stays runnable, and
  // fix-independent, either side of card 2026-0212.
  assert.equal(instances._inUsageWindowFlow(standalone), false,
    'precondition: an ollama-only root tree is outside the usage-window flow');

  // The owned Claude worker going mid-turn arms the conductor's spawn-ownership wake.
  claudeWorker.prompt('STAY');
  // The non-owned wake: noteDispatch arms immediately when the target is already
  // mid-turn, so drive the standalone session first.
  standalone.prompt('STAY');
  await waitFor(() => claudeWorker.status === 'turn' && standalone.status === 'turn');
  instances.noteDispatch(conductor.sessionId, standalone.sessionId);
  assert.equal(instances.hasArmedWake(standalone.id), true, 'precondition: the non-owned wake is armed');
  assert.equal(instances.isIdleCaller(conductor.id), true, 'precondition: two armed wakes');
  assert.equal(conductor.status, 'idle', 'precondition: the conductor takes the IDLE branch');

  tripper.prompt('TRIP go');
  await waitFor(() => sub(cEvs, 'auto_stop_overage').length > 0, { timeout: 10000 });

  assert.equal(standalone.status, 'turn',
    'Pass 3 leaves the non-owned exempt target running — so only the stop\'s sever can drop its wake');
  assert.equal(instances.hasArmedWake(standalone.id), false,
    'the wake on the still-running target is severed');
  assert.equal(instances.isIdleCaller(conductor.id), false, 'the conductor holds no wait');
  assert.equal(conductor._overageDroppedCallbacks, true,
    'and it is marked, so its resume prompt says the callbacks are gone');
  // The severed wait cannot fire: that target reaching turn_end wakes nobody.
  instances.emit('event', { id: standalone.id, ev: { kind: 'turn_end', isError: false } });
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

  // The conductor owns this worker from spawn, so the worker's TRIP turn arms the
  // conductor's wake, and the stop severs it.
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

  // Ownership comes from the spawn (callerInstanceId); the wake arms when the
  // worker's own turn starts, a few lines down.
  conductor.prompt('STAY');
  await waitFor(() => conductor.status === 'turn');
  worker.prompt('TRIP go');
  await waitFor(() => sub(cEvs, 'auto_stop_overage').length > 0);

  assert.equal(instances.isIdleCaller(conductor.id), false,
    'the conductor no longer holds an outgoing wake');
  assert.equal(instances.hasArmedWake(worker.id), false,
    'and the worker has no watcher left to wake');
  // The interrupted worker reaching idle must NOT produce a wake prompt.
  await waitFor(() => worker.status === 'idle', { timeout: 10000 });
  await waitFor(() => conductor.status === 'idle', { timeout: 10000 });
  assert.equal(cEvs.some(e => e.kind === 'user_echo' && /finished its turn/.test(e.text || '')), false,
    'no wake callback was delivered to the stopped conductor');
  assert.equal(conductor._overageDroppedCallbacks, true,
    'and the conductor is marked so its resume prompt says the callbacks are gone');
});

// Card 2026-0203 (REGRESSION) — Invariant: the stop SENDS NOTHING. An idle
// conductor awaiting a wake used to be prompted with OVERAGE_CONDUCTOR_STEER_TEXT;
// it has no turn to stop, so the send bought nothing the resume preamble does not
// already deliver at reset — and it was a message into a throttled account. It is
// now stopped like everything else: notice emitted, wakes severed, nothing written.
//
// Also PINS THE IDLE INTERRUPT AS A NO-OP (the one gap the plan left open):
// `_directOverageStop` calls `inst.interrupt()` unconditionally, and `interrupt()`
// returns immediately on `status !== 'turn'` — so an already-idle session sees NO
// `control_request` on its stdin and NO `interrupting:true` status frame. Asserted
// rather than inspected, so a future change that makes the idle interrupt reach the
// wire (or emit a spurious frame) fails here.
test('routing: conductor idle+subscribed → stopped with NO message sent, worker stopped too', async () => {
  await boot(routingScenario(), 'stop');
  const c = await createInstCapturing({}, 'idle-nosend-cond');
  const conductor = c.inst;
  const worker = await createInst({ conducted: true, callerInstanceId: conductor.id });
  const cEvs = collect(conductor);
  const wEvs = collect(worker);
  const cStatuses = [];
  conductor.on('status', (sm) => cStatuses.push(sm));

  // Conductor stays idle but is parked waiting on the worker: it owns the worker
  // from spawn, and the worker's TRIP turn arms the wake inside prompt() —
  // synchronously, before the trip event the same turn emits — so the conductor is
  // already an idle caller when Pass 1 resolves who is in control.
  assert.equal(conductor.status, 'idle', 'precondition: the conductor is idle');
  worker.prompt('TRIP go');

  await waitFor(() => sub(cEvs, 'auto_stop_overage').length > 0);
  const notice = sub(cEvs, 'auto_stop_overage')[0];
  // The field is REMOVED, not merely falsy: `notEqual(…, true)` alone survives a
  // mutant that emits `steered:false`.
  assert.equal('steered' in notice.data, false, 'the steer marker is gone from the payload');
  // …and Pass 3 does stop the worker (card 2026-0183 A2).
  await waitFor(() => sub(wEvs, 'auto_stop_overage').length > 0);
  await waitFor(() => worker.status === 'idle', { timeout: 10000 });

  // NOTHING reached the conductor: no echo in the transcript stream, and its stdin
  // carries neither a user line nor an interrupt.
  assert.equal(cEvs.filter(e => e.kind === 'user_echo').length, 0,
    'no prompt was injected into the idle conductor');
  const lines = await stdinOf(c.transcript);
  assert.equal(userLinesIn(lines).length, 0, 'nothing was written to the conductor stdin');
  assert.equal(interruptsIn(lines).length, 0,
    'the idle interrupt is a no-op — interrupt() returns on status !== turn');
  assert.equal(cStatuses.some(sm => sm.interrupting === true), false,
    'and it emits no spurious interrupting frame');
  assert.ok(!/overage auto-stop just fired/.test(JSON.stringify(lines)),
    'the deleted steer text reaches nothing');
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
  assert.equal('steered' in sub(wEvs, 'auto_stop_overage')[0].data, false,
    'fallback is a direct stop; the steer marker no longer exists');
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

  // Orchestrator-injected (internal) prompt — e.g. an idle wake.
  await inst.prompt('internal wake', [], { internal: true });
  // It resumes/steers normally: not queued, and it fell through to a real turn.
  assert.equal(inst._overageQueue.length, 0, 'internal prompt not queued');
  assert.equal(evs.some(e => e.kind === 'overage_message_queued'), false, 'no queued event for internal');
  await waitFor(() => evs.some(e => e.kind === 'user_echo' && e.text === 'internal wake'));
});

test('stop-resume: queued attachments are concatenated into the single resume prompt', async () => {
  await boot(scenario([overageEvent({ resetsAt: nowSec() + 3600 }), RESULT]), 'stop-resume');
  // Capture what actually reaches the CLI: the queue contents alone don't prove
  // the delivery ever fired (pattern: ws-deferred-steer E-T4 reads the fake's
  // stdin transcript for the delivered text).
  const transcriptPath = path.join(home, 'resume-flush-stdin.log');
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;
  try {
    const inst = await spawnIdle();
    // Inject the usage seam like every other fire-path test in this file: without
    // it the fire-time verify hits the REAL getAccountUsage, so the resume lands
    // only after up to FAIL_OPEN_AFTER can't-confirm rechecks — a wall-clock race
    // against this test's own timeout whenever the box is loaded.
    setResumeUsage(UNDER);
    inst.prompt('go');
    await waitFor(() => inst.autoResumeAt != null);

    const att = (name) => ({ name, mediaType: 'text/plain', dataBase64: Buffer.from(name).toString('base64') });
    await inst.prompt('with file A', [att('a.txt')]);
    await inst.prompt('with file B', [att('b.txt')]);
    await waitFor(() => inst._overageQueue.length === 2);
    // Both queued entries retain their attachment for the combined delivery.
    assert.equal(inst._overageQueue.flatMap(e => e.attachments).length, 2, 'two attachments queued for one send');

    // Fire the armed resume deterministically and read the DELIVERED prompt.
    assert.equal(ctx.instances._fireAutoResumeNow(inst.id), true, 'pending resume fired');

    const stdinTextsOfUserLines = async () => {
      const dump = await fs.readFile(transcriptPath, 'utf8').catch(() => '');
      return dump.split('\n').filter(Boolean).map(l => JSON.parse(l))
        .filter(l => l.type === 'user')
        .map(u => (u.message?.content ?? [])
          .filter(p => typeof p?.text === 'string').map(p => p.text).join('\n'))
        .filter(t => t.includes(AUTO_RESUME_TEXT));
    };
    await waitFor(async () => (await stdinTextsOfUserLines()).length === 1, { timeout: 10000 });
    await new Promise(r => setTimeout(r, 200)); // settle — catch any duplicate send

    const delivered = await stdinTextsOfUserLines();
    assert.equal(delivered.length, 1, 'exactly ONE resume prompt reached the CLI stdin');
    for (const frag of ['with file A', 'with file B']) {
      assert.ok(delivered[0].includes(frag),
        `queued text "${frag}" is in the single resume prompt; got ${JSON.stringify(delivered[0])}`);
    }
    // Each queued attachment rode along as its own `Attached file:` block.
    assert.match(delivered[0], /^Attached file: `.*a\.txt`$/m,
      `a.txt reached the single resume prompt; got ${JSON.stringify(delivered[0])}`);
    assert.match(delivered[0], /^Attached file: `.*b\.txt`$/m,
      `b.txt reached the single resume prompt; got ${JSON.stringify(delivered[0])}`);
  } finally {
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    await fs.rm(transcriptPath, { force: true });
  }
});

// ── Card 2026-0208: the harness + the mechanism behind it ──────────────────
// The card's failure was NOT a duplicate resume delivery. It was the fire-time usage
// verify running against the REAL getAccountUsage because the test forgot to inject —
// a live request bounded by a 10 000 ms AbortSignal racing this file's own 10 000 ms
// waitFor. These two tests pin the two facts that together make that possible.

// Pins: the seam default installed by beforeEach is a non-network tripwire, never the
// live fetcher. Discriminating assertions are the two `notStrictEqual`s — reverting
// beforeEach to `= getAccountUsage` fires the first one directly, not via a timeout.
test('HARNESS (2026-0208): the usage seam default is a tripwire, not the live fetcher', async () => {
  assert.notStrictEqual(instances._overageResume.fetchUsage, getAccountUsage,
    'resume seam default must not be the live getAccountUsage (card 2026-0208)');
  assert.notStrictEqual(instances._usageMonitor.fetchUsage, getAccountUsage,
    'monitor seam default must not be the live getAccountUsage (card 2026-0208)');
  // …and it is positively THIS file's tripwire: non-network, counting, null-returning.
  await assertUsageSeamsInstalled(instances, seam);
});

// Pins: resume delivery is strictly downstream of the fire-time usage verify — there is
// no optimistic send. That is why a slow verify became a late resume became a red test.
// Discriminating assertion: 'no resume delivered while the usage verify is outstanding'.
test('MECHANISM (2026-0208): resume delivery is gated on the fire-time usage verify', async () => {
  await boot(scenario([overageEvent({ resetsAt: nowSec() + 3600 }), RESULT]), 'stop-resume');
  const inst = await spawnIdle();
  const evs = collect(inst);
  // Magnitude is load-bearing: any hang SHORTER than the 10 000 ms AbortSignal ceiling
  // (src/accountUsage.ts) would let even the live fetcher resume inside the budget, so a
  // bounded sleep would not discriminate. Unresolved-until-released is strictly longer
  // than that ceiling AND costs zero wall clock.
  let release;
  const hung = new Promise((r) => { release = r; });
  ctx.instances._overageResume.fetchUsage = async () => {
    await hung;
    return usagePayload(UNDER, nowSec() + 3600);
  };
  try {
    inst.prompt('go');
    await waitFor(() => inst.autoResumeAt != null);
    await inst.prompt('queued while paused');
    await waitFor(() => inst._overageQueue.length === 1);

    assert.equal(ctx.instances._fireAutoResumeNow(inst.id), true, 'pending resume fired');
    // The deadline is already gone — fireNow deletes it synchronously, before its await —
    // yet nothing is delivered. The delivery clock is the usage fetch's, not ours.
    await waitFor(() => !ctx.instances._autoResumeTimers.has(inst.id));
    // Negative assertion: fixed sleep for margin, then `settle()` to drain whatever it
    // scheduled (docs/architecture.md → Testing). The sleep alone is the weak half —
    // `settle()` is what makes the kill load-independent.
    await new Promise((r) => setTimeout(r, 200));
    await settle();
    assert.equal(evs.some(e => e.kind === 'user_echo' && e.text.includes(AUTO_RESUME_TEXT)), false,
      'no resume delivered while the usage verify is outstanding');
    assert.equal(inst._overageQueue.length, 1, 'queue still held');

    release(); // releasing the verify — and only that — lands the resume
    await waitFor(() => evs.some(e => e.kind === 'user_echo' && e.text.includes(AUTO_RESUME_TEXT)));
    assert.equal(inst._overageQueue.length, 0, 'queue drained once the verify resolved');
  } finally {
    release(); // never leak the pending promise / _checking entry
  }
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
// turns here emit a RESULT so a session driven by any later prompt — a resume
// fire, a re-drive — winds down to idle (the transition that arms the
// per-session resume timer for a session stopped mid-turn).
function resumeRoutingScenario() {
  return {
    events: [INIT],
    turns: [
      { on: { type: 'prompt', text: 'TRIP' }, emit: [overageEvent({ resetsAt: nowSec() + 3600 }), RESULT] },
      { on: { type: 'prompt', text: 'STAY' }, emit: [] },   // hold a conductor mid-turn
      INTERRUPT_TURN,                                       // an aborted turn's result
      { on: { type: 'prompt' }, emit: [RESULT] },           // resume fire → idle
      { on: { type: 'prompt' }, emit: [RESULT] },
      { on: { type: 'prompt' }, emit: [RESULT] },
      { on: { type: 'prompt' }, emit: [RESULT] },
    ],
  };
}

// Card 2026-0203 (REGRESSION) — Invariant: an IDLE-PARKED conductor's resume is
// armed AT ROUTING TIME, without a turn→idle transition. The per-session timer
// otherwise arms on the stopped session's next `turn → idle` transition; a conductor
// that is no longer prompted and has no turn to interrupt never makes that
// transition, so deleting the steer without `_armResumeNow` in `_directOverageStop`
// leaves it with NO RESUME AT ALL. `cStatuses.every(status !== 'turn')` is what makes
// this a without-a-transition pin rather than a generic resume test.
//
// It also pins the third preamble (D5) END TO END: the conductor was idle, so
// neither "continue where you left off" nor the queued-only line is true for it —
// both conductor clauses still ride along, and that exact text must reach the wire.
test('routing stop-resume: an idle+subscribed conductor arms its resume with NO turn→idle transition', async () => {
  await boot(resumeRoutingScenario(), 'stop-resume');
  const conductor = await createInst({});
  const worker = await createInst({ conducted: true, callerInstanceId: conductor.id });
  const cEvs = collect(conductor);
  const cStatuses = [];
  conductor.on('status', (sm) => cStatuses.push(sm));

  // Conductor parked idle, owning the worker: the worker's TRIP turn arms the wake
  // inside prompt(), before the trip event that same turn emits.
  assert.equal(conductor.status, 'idle', 'precondition: the conductor takes the idle path');
  worker.prompt('TRIP go');

  const notice = await waitFor(() =>
    sub(cEvs, 'auto_stop_overage').find(e => e.data.resume === true));
  assert.equal('steered' in notice.data, false, 'no steer marker — nothing was sent');

  // The resume is armed already, off the routing call itself.
  await waitFor(() => ctx.instances._autoResumeTimers.has(conductor.id));
  assert.equal(conductor.autoStoppedForOverage, true, 'flagged auto-stopped');
  assert.equal(conductor.autoResumeAt != null, true, 'conductor resume badge set');
  assert.equal(conductor._overageWasIdleParked, true, 'and recorded as idle-parked');
  assert.equal(conductor._overageWasStopped, false, 'not as stopped mid-work');
  assert.equal(cStatuses.every(sm => sm.status !== 'turn'), true,
    'it never entered a turn — so nothing but the routing-time arm could have armed it');

  // Firing it delivers the resume prompt to the still-live conductor (verify clear).
  // Its workers were stopped and its callbacks dropped, so both conductor clauses
  // ride the idle-parked base: without them the conductor would sit waiting on a
  // callback that will never fire, in front of workers that will never self-resume.
  setResumeUsage(UNDER);
  assert.equal(ctx.instances._fireAutoResumeNow(conductor.id), true, 'pending resume fired');
  const expected = buildConductorResumePreamble(
    { kind: 'idle-parked', droppedCallbacks: true, unarmedWorkers: true });
  await waitFor(() => cEvs.some(e => e.kind === 'user_echo' && e.text === expected),
    { timeout: 10000 });
  assert.match(expected, /were idle when the overage stop fired/, 'the idle-parked base');
  assert.ok(!/continue where you left off/.test(expected), 'not the mid-work base');
  assert.match(expected, /idle callbacks were dropped/, 'names the dropped callbacks');
  assert.match(expected, /will NOT resume itself/, 'and that the stopped workers are un-armed');
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
  assert.equal('steered' in sub(wEvs, 'auto_stop_overage')[0].data, false, 'fallback is a direct stop');
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
async function createConductor(name, opts = {}) {
  await ensureConductProject();
  const transcript = name ? path.join(home, `stdin-${name}.jsonl`) : null;
  if (transcript) process.env.FAKE_CLAUDE_TRANSCRIPT = transcript;
  try {
    const inst = await ctx.instances.create({ project: CONDUCT_PROJECT_NAME, mode: 'bypassPermissions', ...opts });
    await waitFor(() => inst.status === 'idle');
    return { inst, transcript };
  } finally { delete process.env.FAKE_CLAUDE_TRANSCRIPT; }
}

// Card 2026-0189 — PIN of the ONE case the branch collapse is NOT behaviour-identical
// for, so the next reader finds it decided rather than accidental. A `.conduct`
// session spawned through MCP `spawn_instance` carries `conducted:true` +
// `callerInstanceId` (src/mcp/handlers.ts), so mid-turn under an in-control owner the
// collapsed Pass 3 treats it as a PROTECTED WORKER — stopped un-armed, owner marked —
// where the deleted `isConductorInstance` branch armed it. That is the intended
// reading of "protected worker" (its owner is the sole driver on resume), so the
// behaviour is kept deliberately. Mutant: re-introducing an `isConductorInstance`
// escape hatch in Pass 3 to arm it again.
test('2026-0189: a CONDUCTED .conduct orchestrator is stopped un-armed like any other protected worker', async () => {
  await boot(resumeRoutingScenario(), 'stop-resume');
  const owner = await createInst({});
  const { inst: orch } = await createConductor('conduct-conducted',
    { conducted: true, callerInstanceId: owner.id });
  assert.equal(isConductorInstance(orch), true, 'precondition: it IS a .conduct session');
  assert.equal(orch.conducted, true, 'and it is ALSO a conducted worker (the MCP spawn shape)');
  const oEvs = collect(orch);

  // The owner is in control (mid-turn), which is what makes the orchestrator a
  // protected worker in Pass 1.
  owner.prompt('STAY');
  await waitFor(() => owner.status === 'turn');
  orch.prompt('TRIP go');

  const notice = await waitFor(() => sub(oEvs, 'auto_stop_overage')[0]);
  assert.equal(notice.data.resume, false, 'un-armed: no resume is named for it');
  assert.equal(orch.autoStoppedForOverage, false, 'and none is armed');
  assert.equal(orch._overageStoppedUnarmed, true, 'it is marked un-armed');
  assert.equal(owner._overageUnarmedWorkers, true, 'and its owner is told to re-drive it');
  await waitFor(() => orch.status === 'idle', { timeout: 10000 });
});

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
  assert.equal('steered' in sub(cEvs, 'auto_stop_overage')[0].data, false, 'a stop is not a steer');
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

// ── Card 2026-0203 D5: the resume preamble selector is THREE-WAY ───────────
// PIN (pure unit, no boot) — Invariant: each of the three states resumes on its own
// honest base line, and BOTH conductor clauses ride ALL THREE. A stopped session
// continues where it left off; an IDLE-PARKED one had nothing of its own
// interrupted (so "continue where you left off" is false) and queued nothing (so the
// queued-only line is false too); a queued-only one gets the softened line. Mutants
// killed: collapsing any two branches, and gating either clause on a kind.
test('D5 the three resume kinds each get their own base, and both clauses ride all three', () => {
  const clauses = { droppedCallbacks: true, unarmedWorkers: true };

  // 'stopped' — unchanged, and it is the DEFAULT when no kind is passed.
  const stopped = buildConductorResumePreamble({ kind: 'stopped', ...clauses });
  assert.ok(stopped.startsWith(AUTO_RESUME_TEXT), 'stopped keeps AUTO_RESUME_TEXT verbatim');
  assert.equal(buildConductorResumePreamble(clauses), stopped, 'and is the default kind');

  // 'idle-parked' — the new base. Neither of the other two lines may appear.
  const parked = buildConductorResumePreamble({ kind: 'idle-parked', ...clauses });
  assert.ok(parked.startsWith(IDLE_PARKED_RESUME_TEXT), 'idle-parked gets its own base');
  assert.match(parked, /were idle when the overage stop fired/);
  assert.ok(!/continue where you left off/.test(parked),
    'an idle-parked session is NOT told to continue where it left off');
  assert.ok(!/Delivering the messages you queued/.test(parked),
    'nor promised queued messages it never queued');
  assert.notEqual(parked, stopped, 'the two branches are distinct');

  // Both clauses ride every branch — they are facts the conductor must act on.
  for (const [name, text] of [['stopped', stopped], ['idle-parked', parked]]) {
    assert.match(text, /idle callbacks were dropped/, `${name} carries the dropped-callbacks clause`);
    assert.match(text, /will NOT resume itself/, `${name} carries the un-armed-workers clause`);
  }
  // …and each clause is still independently gated.
  const onlyDropped = buildConductorResumePreamble({ kind: 'idle-parked', droppedCallbacks: true });
  assert.match(onlyDropped, /idle callbacks were dropped/);
  assert.ok(!/will NOT resume itself/.test(onlyDropped), 'un-armed clause not asserted falsely');
  assert.equal(buildConductorResumePreamble({ kind: 'idle-parked' }), IDLE_PARKED_RESUME_TEXT,
    'no clauses ⇒ the bare base');
});

// ── Card 2026-0231: the policy is LIVE authority, not just trip-time input ──
// Switching Settings → Account → Action on overage OFF `Stop & resume` must unmark
// every session already marked under the old policy — badge, deadline, flags, and
// the queue — fleet-wide. Before this, the marks survived the switch and the
// wall-clock sweep still fired them: the operator's change applied to future trips only.

// Spawn an idle session in an arbitrary project (spawnIdle hardcodes 'demo').
async function spawnIdleIn(project) {
  const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions' });
  assert.equal(r.status, 201);
  const inst = ctx.instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle');
  return inst;
}

test('policy switch stop-resume → stop unmarks every marked session, across projects', async () => {
  await boot(scenario([overageEvent({ resetsAt: nowSec() + 3600 }), RESULT]), 'stop-resume');
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo2' });
  const a = await spawnIdle();                 // project 'demo' — stopped mid-turn
  const b = await spawnIdleIn('demo2');        // project 'demo2' — queued-only

  const aEvs = collect(a), bEvs = collect(b);
  a.prompt('go');
  await waitFor(() => sub(aEvs, 'auto_stop_overage').length > 0);
  await waitFor(() => a.autoResumeAt != null);   // armed on the mid-turn→idle transition

  // B never tripped anything: it queues behind the global lockout and arms on the spot.
  await b.prompt('queued while paused');
  await waitFor(() => bEvs.some(e => e.kind === 'overage_message_queued'));
  await waitFor(() => b.autoResumeAt != null);
  assert.equal(b._overageQueue.length, 1, 'B has a queued message to lose');

  // Capture the badge-drop pushes the sweep must emit.
  const statuses = [];
  ctx.instances.on('status', (s) => statuses.push(s));

  const res = await api(ctx.baseUrl, 'POST', '/api/settings/models/prefs', { onOverage: 'stop' });
  assert.equal(res.status, 200);

  for (const [name, inst] of [['A', a], ['B', b]]) {
    assert.equal(inst.autoResumeAt, null, `${name}: badge cleared`);
    assert.equal(inst.autoStoppedForOverage, false, `${name}: stop mark cleared`);
    assert.equal(inst._overageQueue.length, 0, `${name}: queue emptied`);
    assert.equal(ctx.instances._autoResumeTimers.has(inst.id), false, `${name}: deadline cancelled`);
    assert.equal(statuses.some(s => s.id === inst.id && s.autoResumeAt === null), true,
      `${name}: badge-drop status emitted`);
  }
  assert.equal(ctx.instances._autoResumeTimers.size, 0, 'no deadline left anywhere');
  assert.equal(ctx.instances._overageResumeMode, false, 'queue gate disengaged');
  // The dropped queue is announced, not silent — reuses blocks.js' existing renderer.
  const skipped = sub(bEvs, 'auto_resume_skipped');
  assert.equal(skipped.length, 1, 'B told its queued message was dropped');
  assert.match(skipped[0].data.reason, /overage handling changed — 1 queued message\(s\) dropped/);
  assert.equal(sub(aEvs, 'auto_resume_skipped').length, 0, 'A had no queue ⇒ no notice');
  // D4: the global lockout is deliberately left alone — the fleet lands exactly
  // where a NATIVE plain-`stop` trip leaves it, and the window lifts on its own.
  assert.equal(ctx.instances._overageActive, true, 'window lockout untouched by the sweep');
});

test('policy switch while a resume verify is IN FLIGHT does not resume', async () => {
  await boot(scenario([overageEvent({ resetsAt: nowSec() + 3600 }), RESULT]), 'stop-resume');
  const inst = await spawnIdle();
  const evs = collect(inst);
  inst.prompt('go');
  await waitFor(() => inst.autoResumeAt != null);

  // Park the fire-time usage verify mid-flight. fireNow deletes the timers entry
  // BEFORE awaiting fetchUsage, so this session has no timer but is still marked —
  // which is why the sweep iterates byId, not timers.
  let release;
  ctx.instances._overageResume.fetchUsage = () => new Promise((r) => {
    release = () => r(usagePayload(UNDER, nowSec() + 3600));
  });
  assert.equal(ctx.instances._fireAutoResumeNow(inst.id), true, 'pending resume picked up');
  await waitFor(() => release !== undefined, { timeout: 5000 });
  assert.equal(ctx.instances._autoResumeTimers.has(inst.id), false, 'timer already gone (mid-verify)');

  await api(ctx.baseUrl, 'POST', '/api/settings/models/prefs', { onOverage: 'stop' });
  assert.equal(inst.autoStoppedForOverage, false, 'the sweep found it despite having no timer');

  release();                       // the in-flight verify now resolves "window clear"
  await settle();
  assert.equal(evs.some(e => e.kind === 'user_echo' && e.text === AUTO_RESUME_TEXT), false,
    'no resume prompt into a session the operator just unmarked');
  assert.equal(inst.autoResumeAt, null, 'still unmarked');
  assert.equal(inst.autoStoppedForOverage, false);
});

// CHARACTERIZATION (passes before the fix too): the reverse direction is
// deliberately inert. `stop` records nothing identifying which sessions it halted,
// and flipping _overageResumeMode mid-window would start queueing sends into
// sessions with no deadline to flush them — stranded forever. Next trip, not now.
test('policy switch stop → stop-resume mid-lockout marks nothing and engages no queueing', async () => {
  await boot(scenario([overageEvent({ resetsAt: nowSec() + 3600 }), RESULT]), 'stop');
  const inst = await spawnIdle();
  const evs = collect(inst);
  inst.prompt('go');
  await waitFor(() => sub(evs, 'auto_stop_overage').length > 0);
  await waitFor(() => inst.status === 'idle');
  assert.equal(inst.autoResumeAt, null, 'plain stop armed nothing');

  await api(ctx.baseUrl, 'POST', '/api/settings/models/prefs', { onOverage: 'stop-resume' });
  assert.equal(inst.autoResumeAt, null, 'no retro-mark');
  assert.equal(ctx.instances._autoResumeTimers.size, 0, 'no deadline armed');
  assert.equal(ctx.instances._overageResumeMode, false, 'queue gate stays disengaged');

  // …and the operator can still send by hand: nothing is stranded.
  await inst.prompt('hi');
  assert.equal(evs.some(e => e.kind === 'overage_message_queued'), false, 'send not queued');
  assert.equal(inst._overageQueue.length, 0, 'nothing stranded in the queue');
});
