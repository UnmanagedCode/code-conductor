// Card 2026-0204: the overage turn-START lockout guard
// (InstanceManager._guardOverageTurnStart).
//
// `onOverage: 'stop-resume'` is a hard lockout — nothing may be sent to any session
// until the rate-limit window resets. Card 2026-0183 tried to close the hole by
// enumerating injection sites; the observed defect got through anyway (workers
// re-invoked by a background job burned the throttled account). So the guard sits at
// the turn-start seam instead: whatever started the turn, if the lockout is live the
// turn is soft-interrupted, its wakes are severed, and a transcript line says why.
//
// The un-prompted turn technique is tests/self-triggered-turn.test.mjs's: injecting a
// usage-bearing `message_start` through `_handleStdoutLine` flips idle → turn with
// ZERO involvement from prompt() — literally a path the overage queue intercept
// cannot hold, which is the whole point of guarding the seam rather than the sends.
//
// The trip itself is driven through `_handleOverageTrip(null, …)` — the poll monitor's
// own account-global entry point — so each test controls exactly which sessions are
// mid-turn when routing runs, instead of racing a scenario's stream event.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { setOnOverageAction } from '../src/appSettings.ts';
import { installUsageSeamTripwire, assertUsageSeamInjected, assertUsageSeamsInstalled } from './overageUsageSeam.mjs';

const nowSec = () => Math.floor(Date.now() / 1000);

const INIT = { type: 'system', subtype: 'init', session_id: '$SID', cwd: '$CWD',
  model: 'claude-sonnet-4-6', permissionMode: '$MODE', tools: ['Bash'], uuid: 'init-1' };
const RESULT = { type: 'result', subtype: 'success', stop_reason: 'end_turn',
  duration_ms: 10, total_cost_usd: 0.0001, is_error: false };
// The aborted turn's ending, emitted when the guard's interrupt reaches the CLI.
const INTERRUPT_TURN = {
  on: { type: 'control', subtype: 'interrupt' },
  emit: [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null },
    { type: 'result', subtype: 'error_during_execution', stop_reason: 'interrupted',
      duration_ms: 20, total_cost_usd: 0.0001, is_error: true },
  ],
};

// 'WARM' completes a turn; 'STAY' holds one open; the control turn ends whatever the
// guard's interrupt cut. Every session is WARMED before a test trips the lockout: the
// fake emits `scenario.events` (INIT) lazily on its FIRST stdin line, so without a
// warm-up the INIT would land *after* the guard's interrupt and the drain window would
// fire a second, unrelated `control_request` — an artifact of the fake, not behaviour.
function guardScenario() {
  return {
    events: [INIT],
    turns: [
      { on: { type: 'prompt', text: 'WARM' }, emit: [RESULT] },
      { on: { type: 'prompt', text: 'STAY' }, emit: [] },
      INTERRUPT_TURN,
      { on: { type: 'prompt' }, emit: [RESULT] },
      { on: { type: 'prompt' }, emit: [RESULT] },
      { on: { type: 'prompt' }, emit: [RESULT] },
    ],
  };
}

async function writeScenario(obj) {
  const p = path.join(await mkdtemp('cc-guard-'), 'scenario.json');
  await fs.writeFile(p, JSON.stringify(obj));
  return p;
}

let savedBuf, savedSweep, savedRecheck;
let ctx, instances, home, seam;
before(async () => {
  savedBuf = process.env.ORCH_OVERAGE_RESUME_BUFFER_MS;
  process.env.ORCH_OVERAGE_RESUME_BUFFER_MS = '0';
  savedSweep = process.env.ORCH_OVERAGE_RESUME_SWEEP_MS;
  process.env.ORCH_OVERAGE_RESUME_SWEEP_MS = '40';
  savedRecheck = process.env.ORCH_OVERAGE_RECHECK_MS;
  process.env.ORCH_OVERAGE_RECHECK_MS = '60';
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
  ({ home } = await freshProjectsRoot());
  instances._clearOverage();
  instances._overageResume.clearAll();
  seam = installUsageSeamTripwire(instances);
});
afterEach(async () => {
  await instances.shutdown();
  await rmrf(home);
  assertUsageSeamInjected(seam);
});

async function boot(action) {
  process.env.FAKE_CLAUDE_SCENARIO = await writeScenario(guardScenario());
  await setOnOverageAction(action);
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });
}

// Card 2026-0208. This file's own wiring pin — every overage test file needs one,
// because each file's `beforeEach` is independently editable and a sibling file's
// assertion cannot see this one being reverted to the live `getAccountUsage` default.
// Discriminating assertion: the `strictEqual` inside assertUsageSeamsInstalled.
test('HARNESS (2026-0208): this file\'s beforeEach installs the usage-seam tripwire on both seams', async () => {
  await assertUsageSeamsInstalled(instances, seam);
});

// One stdin capture per instance: fake-claude appends to whatever
// FAKE_CLAUDE_TRANSCRIPT names at ITS spawn.
async function createInst(opts = {}, name = null) {
  const transcript = name ? path.join(home, `stdin-${name}.jsonl`) : null;
  if (transcript) process.env.FAKE_CLAUDE_TRANSCRIPT = transcript;
  try {
    const inst = await instances.create({ project: 'demo', mode: 'bypassPermissions', ...opts });
    await waitFor(() => inst.status === 'idle');
    return { inst, transcript };
  } finally { delete process.env.FAKE_CLAUDE_TRANSCRIPT; }
}

// Drive one complete turn so the fake flushes its INIT before the test proper — see
// guardScenario. Returns once the session is idle again.
async function warm(inst) {
  await inst.prompt('WARM');
  await waitFor(() => inst.status === 'idle', { timeout: 10000 });
  return inst;
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

function collect(inst) {
  const evs = [];
  inst.on('event', (ev) => evs.push(ev));
  return evs;
}
const sub = (evs, subtype) => evs.filter(e => e.kind === 'system' && e.subtype === subtype);

// Latch `interrupting` off the status STREAM, not the live field: _setStatus clears
// it on turn exit, and `interrupt({force:true})` returns before ever setting it — so
// this is also the pin that the guard never escalates to the forced tier.
function latchInterrupting(inst) {
  const seen = { armed: false };
  inst.on('status', (sm) => { if (sm.interrupting === true) seen.armed = true; });
  return seen;
}

// A usage-bearing message_start — the shape the real stream emits at the start of
// each agent-loop step. Flips idle → turn without prompt() ever being called.
function injectMessageStart(inst, id = 'msg_wake') {
  inst._handleStdoutLine(JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: { id, role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: 1 } },
    },
  }));
}

// Trip the account-global lockout with a FUTURE reset (the poll monitor's entry
// point: inst === null is account-global, so no session's own stream is involved).
function trip(resetsAt = nowSec() + 3600) {
  instances._handleOverageTrip(null, { resetsAt });
}

function usagePayload(fiveHourUtilPct, resetsAtSec) {
  return {
    five_hour: { utilization: fiveHourUtilPct, resets_at: new Date(resetsAtSec * 1000).toISOString() },
    seven_day: { utilization: 0, resets_at: new Date((resetsAtSec + 86400) * 1000).toISOString() },
    extra_usage: { is_enabled: false },
  };
}

// ── The guard fires on a turn the queue intercept cannot hold ──────────────
// REGRESSION — Invariant: a turn that starts during a live stop-resume lockout is
// soft-interrupted, whether it was started by a path prompt() never touches (an
// injected message_start — the observed defect's shape) or by an orchestrator wake
// (`internal:true`, which the queue intercept deliberately does NOT hold).
// Mutant: deleting the guard — both turns then run against the throttled account.
test('G-T1 a self-triggered turn during the lockout is soft-interrupted', async () => {
  await boot('stop-resume');
  const a = await createInst({}, 'g1-self');
  const b = await createInst({}, 'g1-wake');
  await warm(a.inst);
  await warm(b.inst);
  const aBase = interruptsIn(await stdinOf(a.transcript)).length;
  const bBase = interruptsIn(await stdinOf(b.transcript)).length;
  assert.equal(aBase + bBase, 0, 'precondition: the warm-up turns were not interrupted');
  trip();
  assert.equal(a.inst._overageGate().active, true, 'precondition: the lockout is live');

  // (1) A turn nothing wrote to stdin to start.
  const aArmed = latchInterrupting(a.inst);
  injectMessageStart(a.inst);
  assert.equal(a.inst.status, 'turn', 'the injected message_start opened a turn');
  await waitFor(async () => interruptsIn(await stdinOf(a.transcript)).length === 1);
  assert.equal(aArmed.armed, true, 'the self-triggered turn was ARMED for interrupt');

  // (2) A wake-shaped internal prompt — bypasses the queue intercept by design.
  const bArmed = latchInterrupting(b.inst);
  b.inst.prompt('w1 finished its turn', [], { internal: true }).catch(() => {});
  await waitFor(async () => interruptsIn(await stdinOf(b.transcript)).length === 1);
  assert.equal(bArmed.armed, true, 'the internal wake turn was ARMED for interrupt too');

  await waitFor(() => a.inst.status === 'idle' && b.inst.status === 'idle', { timeout: 10000 });
});

// PIN — Invariant: the guard is the SOFT tier, never `force:true`. Two independent
// witnesses: `interrupting` latched true off the status stream (force returns before
// ever setting it), and `_turnForceAborted` still false (force sets it synchronously,
// before its own await).
test('G-T2 the guard never escalates to the forced tier', async () => {
  await boot('stop-resume');
  const a = await createInst({}, 'g2');
  await warm(a.inst);
  trip();
  const armed = latchInterrupting(a.inst);
  injectMessageStart(a.inst);
  await waitFor(async () => interruptsIn(await stdinOf(a.transcript)).length === 1);
  assert.equal(armed.armed, true, 'armed (soft), not force-aborted');
  assert.equal(a.inst._turnForceAborted, false, 'force:true was never used');
  await waitFor(() => a.inst.status === 'idle', { timeout: 10000 });
});

// PIN — Invariant: the cut is VISIBLE. The observed defect was silence — workers
// silently re-invoked — so the guard emits a `system/soft_interrupted` carrying the
// reason, which public/blocks.js renders as `⏸ Turn interrupted: <text>`.
// Mutant: dropping the emit.
test('G-T3 the guard says why in the transcript', async () => {
  await boot('stop-resume');
  const a = await createInst({}, 'g3');
  await warm(a.inst);
  const evs = collect(a.inst);
  trip();
  injectMessageStart(a.inst);
  const ev = await waitFor(() => sub(evs, 'soft_interrupted')[0]);
  assert.match(ev.data?.text ?? '', /overage lockout/, 'names the lockout as the cause');
  await waitFor(() => a.inst.status === 'idle', { timeout: 10000 });
});

// REGRESSION (D1) — Invariant: the guard SEVERS before it interrupts. `purge()`
// clears the dispatch edges but NOT spawn ownership: `ownersOf` re-adds the parent
// from `callerInstanceId` on every call, so a stopped worker whose turn starts again
// re-arms its conductor's wake at `onTurnStart`. Without the sever, the guard's own
// interrupt produces a `turn_end` that delivers an `internal:true` wake stub to the
// conductor — violating 2026-0203 from inside 2026-0204. Mutant: dropping
// `_severOverageWakes` from the guard.
test('G-T4 the guard severs the wake onTurnStart just re-armed', async () => {
  await boot('stop-resume');
  const c = await createInst({}, 'g4-cond');
  const w = await createInst({ conducted: true, callerInstanceId: c.inst.id }, 'g4-work');
  // Only the conductor is warmed: warming the WORKER would arm and then spend the
  // conductor's wake before the test begins, delivering the very wake stub the last
  // assertions are looking for.
  await warm(c.inst);
  const cEvs = collect(c.inst);
  trip();
  assert.equal(c.inst.status, 'idle', 'precondition: both idle');
  assert.equal(w.inst.status, 'idle');

  injectMessageStart(w.inst);
  // onTurnStart armed the conductor's wake off spawn ownership; the guard removed it.
  assert.equal(instances.hasArmedWake(w.inst.id), false,
    'the re-armed wake was severed by the guard');
  assert.equal(c.inst._overageDroppedCallbacks, true,
    'and the conductor is marked, so its resume prompt says the callbacks are gone');

  // The worker's turn_end must therefore wake nobody.
  const cLinesBefore = (await stdinOf(c.transcript)).length;
  await waitFor(() => w.inst.status === 'idle', { timeout: 10000 });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(cEvs.some(e => e.kind === 'user_echo'), false,
    'no wake stub reached the conductor');
  assert.equal((await stdinOf(c.transcript)).length, cLinesBefore,
    'and nothing new was written to its stdin');
});

// ── Each term of `_overageGate().active` gets its own killer ───────────────

// PIN — Invariant: plain `Stop` is NOT a lockout, so a turn starting afterwards runs.
// Mutant: swapping `_overageGate().active` for a bare `this._overageActive` — the
// gate's `_overageResumeMode` term is the only thing excluding plain Stop.
test('G-T5 plain Stop does not guard a later turn', async () => {
  await boot('stop');
  const a = await createInst({}, 'g5');
  await warm(a.inst);
  trip();
  assert.equal(instances._overageActive, true, 'precondition: the flag IS set');
  assert.equal(a.inst._overageGate().active, false, 'but plain Stop is not a lockout');
  const armed = latchInterrupting(a.inst);

  injectMessageStart(a.inst);
  a.inst._handleStdoutLine(JSON.stringify({ ...RESULT, uuid: 'r-g5' }));
  await waitFor(() => a.inst.status === 'idle');
  assert.equal(interruptsIn(await stdinOf(a.transcript)).length, 0, 'no interrupt was sent');
  assert.equal(armed.armed, false, 'and the turn was never armed');
});

// PIN — Invariant: a domain-EXEMPT session (an ollama-only agent tree consumes no
// monitored account window) is never guarded. Mutant: restating the condition as
// `_overageActive && _overageResumeMode` without `_inUsageWindowFlow`.
//
// `ex` is deliberately STANDALONE (no `callerInstanceId`), which is what keeps it
// exempt now that `_inUsageWindowFlow` is root-scoped (card 2026-0212): making it a
// conducted worker of `claude` would put its root tree in the flow and it WOULD be
// guarded.
test('G-T6 a domain-exempt session is never guarded', async () => {
  await boot('stop-resume');
  const claude = await createInst({}, 'g6-claude'); // keeps the account in flow
  const ex = await createInst({}, 'g6-exempt');
  await warm(claude.inst);
  await warm(ex.inst);
  ex.inst.backend = 'ollama';
  ex.inst.model = 'deepseek-v4-flash:cloud';
  ex.inst._refreshModelCapabilities();
  assert.equal(instances._inUsageWindowFlow(ex.inst), false, 'precondition: exempt');
  trip();
  assert.equal(claude.inst._overageGate().active, true, 'the lockout is live for a Claude session');
  assert.equal(ex.inst._overageGate().active, false, 'but not for the exempt one');
  const armed = latchInterrupting(ex.inst);

  injectMessageStart(ex.inst);
  ex.inst._handleStdoutLine(JSON.stringify({ ...RESULT, uuid: 'r-g6' }));
  await waitFor(() => ex.inst.status === 'idle');
  assert.equal(interruptsIn(await stdinOf(ex.transcript)).length, 0, 'no interrupt was sent');
  assert.equal(armed.armed, false, 'and the exempt turn was never armed');
});

// PIN — Invariant: the live-window condition has ONE owner. `_overageActive` and
// `_overageResumeMode` can both be true while `resetsAt` is already PAST (the
// `_armOverageClear` buffer between the window expiring and `_clearOverage` running).
// A queued send bypasses the manual-resume clear, so a missing/past/NaN reset must
// mean the lockout is over. Mutant: any restatement of the condition that omits the
// future-`resetsAt` safety rail.
test('G-T7 a past resetsAt means the lockout is over — no guard', async () => {
  await boot('stop-resume');
  const a = await createInst({}, 'g7');
  await warm(a.inst);
  trip();
  instances._overageResetsAt = nowSec() - 100; // window expired, clear not yet run
  assert.equal(instances._overageActive, true);
  assert.equal(instances._overageResumeMode, true);
  assert.equal(a.inst._overageGate().active, false, 'past resetsAt ⇒ gate inactive');
  const armed = latchInterrupting(a.inst);

  injectMessageStart(a.inst);
  a.inst._handleStdoutLine(JSON.stringify({ ...RESULT, uuid: 'r-g7' }));
  await waitFor(() => a.inst.status === 'idle');
  assert.equal(interruptsIn(await stdinOf(a.transcript)).length, 0, 'no interrupt was sent');
  assert.equal(armed.armed, false, 'and the turn was never armed');
});

// ── The one turn that MUST run ─────────────────────────────────────────────
// REGRESSION — Invariant: the auto-resume's own fire is exempt. THE EXEMPTION RESTS
// ON THE FLAG, not on any ordering — `_overageResumeFiring` is set before the send and
// cleared in `.finally()`, so it covers every interleaving. Mutant: deleting that set
// in OverageResumeController.run.
//
// The ordering explains only why the gate is OBSERVABLY live at `turn_start` in the
// case pinned here — an EMPTY-QUEUE resume. `prompt()`'s only `await` sits in its
// attachment loop, so with no attachments the whole synchronous body (including
// `_setStatus('turn')` → `turn_start`) completes inside `run()`'s frame, while
// `_resolveDue` calls `_maybeReleaseOverageLock()` only after `run()` returns. With
// QUEUED ATTACHMENTS that no longer holds: each `await saveAttachment(...)` precedes
// `_setStatus('turn')` and `run()` does not await its own prompt, so the release can
// interleave first and — with nothing else parked — lift the gate before `turn_start`.
// That case is still safe, but only because of the flag. Which is exactly why the flag
// is the mechanism and the ordering is not.
//
// KEEP THE SECOND PARKED SESSION. It is not what creates the window; it keeps the
// window OBSERVABLE after the fire, which is what the post-fire `_overageActive` /
// `gate.active` preconditions below assert. With only one session the lock lifts as
// soon as `run()` returns, those two assertions become false, and the test can no
// longer state on its own evidence that the exempted turn started inside a live
// lockout.
test('G-T8 the auto-resume\'s own fire is NOT guarded', async () => {
  await boot('stop-resume');
  const a = await createInst({}, 'g8-a');
  const b = await createInst({}, 'g8-b');
  await warm(a.inst);
  await warm(b.inst);
  const aEvs = collect(a.inst);

  // Both mid-turn when routing runs ⇒ both stopped and both armed ⇒ two parked
  // deadlines, so _maybeReleaseOverageLock cannot lift the lock for either.
  a.inst.prompt('STAY-A');
  b.inst.prompt('STAY-B');
  await waitFor(() => a.inst.status === 'turn' && b.inst.status === 'turn');
  trip();
  await waitFor(() => instances._autoResumeTimers.has(a.inst.id)
    && instances._autoResumeTimers.has(b.inst.id), { timeout: 10000 });
  assert.equal(instances._overageResume.timers.size, 2, 'two sessions parked');

  const aInterruptsBefore = interruptsIn(await stdinOf(a.transcript)).length;
  const aUserLinesBefore = userLinesIn(await stdinOf(a.transcript)).length;
  const armed = latchInterrupting(a.inst);

  instances._overageResume.fetchUsage = async () => usagePayload(10, nowSec() + 3600);
  assert.equal(instances._fireAutoResumeNow(a.inst.id), true, 'a resume fired');
  // The resume's own turn started while the lockout was STILL live (b is parked).
  await waitFor(async () => userLinesIn(await stdinOf(a.transcript)).length > aUserLinesBefore,
    { timeout: 10000 });
  assert.equal(instances._overageActive, true, 'the lockout is still active — b is parked');
  assert.equal(a.inst._overageGate().active, true, 'and the gate still reports it');
  await waitFor(() => aEvs.some(e => e.kind === 'user_echo' && /rate-limit window has reset/.test(e.text || '')),
    { timeout: 10000 });
  assert.equal(interruptsIn(await stdinOf(a.transcript)).length, aInterruptsBefore,
    'the resume turn was not interrupted');
  assert.equal(armed.armed, false, 'nor even armed');
  assert.equal(sub(aEvs, 'soft_interrupted').length, 0, 'and no lockout notice was emitted for it');
  await waitFor(() => a.inst.status === 'idle', { timeout: 10000 });
});
