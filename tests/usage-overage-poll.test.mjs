// Integration tests for the server-side usage poller (UsageOverageMonitor) as a
// first-class overage trigger source, alongside the stream `rate_limit_event`.
//
// The stream event is only emitted near Anthropic's own ~90% threshold, so a LOW
// configured stop threshold (e.g. 25%) is invisible to it — only a live usage poll
// sees it. These tests drive the monitor's `_tick()` directly with an injected
// `fetchUsage` (the constructor seam) so there's no real network, and assert the
// poll drives the SAME `_handleOverageTrip` → `_routeOverageStop` machinery as the
// stream trip: identical routing, dedup via `_overageActive`, and resume timing off
// the FIVE-HOUR window reset.
//
// The resume buffer is forced to 0ms via ORCH_OVERAGE_RESUME_BUFFER_MS so the armed
// timer fires off the test's `resets_at` alone.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bootServer, api, waitFor } from './helpers.mjs';
import { setOnOverageAction, setOverageThreshold } from '../src/appSettings.js';
import { AUTO_RESUME_TEXT } from '../src/instances.js';

const nowSec = () => Math.floor(Date.now() / 1000);

const INIT = { type: 'system', subtype: 'init', session_id: '$SID', cwd: '$CWD',
  model: 'claude-sonnet-4-6', permissionMode: '$MODE', tools: ['Bash'], uuid: 'init-1' };
const RESULT = { type: 'result', subtype: 'success', stop_reason: 'end_turn',
  duration_ms: 10, total_cost_usd: 0.0001, is_error: false };

// A real overage stream trip (status:rejected + isUsingOverage), carrying the
// five-hour `resetsAt` (epoch secs) — used to seed the cross-source dedup tests.
function overageEvent({ resetsAt } = {}) {
  const info = { status: 'rejected', rateLimitType: 'five_hour', isUsingOverage: true };
  if (resetsAt !== undefined) info.resetsAt = resetsAt;
  return { type: 'system', subtype: 'rate_limit_event', uuid: 'rl-1', rate_limit_info: info };
}

// Account-usage payload shape (src/accountUsage.js): each window carries a 0–100
// PERCENT `utilization` and a snake_case ISO `resets_at`.
function usagePayload(fiveHourUtilPct, resetsAtSec) {
  return {
    five_hour: { utilization: fiveHourUtilPct, resets_at: new Date(resetsAtSec * 1000).toISOString() },
    seven_day: { utilization: 0, resets_at: new Date((resetsAtSec + 86400) * 1000).toISOString() },
    extra_usage: { is_enabled: false },
  };
}

// A counting fake usage source, so gating tests can assert we didn't even fetch.
function spyUsage(payload) {
  const spy = async () => { spy.calls++; return payload; };
  spy.calls = 0;
  return spy;
}

// Scenario: 'STAY' holds an instance mid-turn (emit nothing) so the poll can catch
// it; generic prompt turns emit a RESULT so the soft-interrupt the poll triggers
// winds the turn to idle (the transition that arms a per-session resume timer), and
// a later resume prompt also completes. 'TRIP' emits a hard overage stream event.
function pollScenario() {
  return {
    events: [INIT],
    turns: [
      { on: { type: 'prompt', text: 'TRIP' }, emit: [overageEvent({ resetsAt: nowSec() + 3600 }), RESULT] },
      { on: { type: 'prompt', text: 'STAY' }, emit: [] },
      { on: { type: 'prompt' }, emit: [RESULT] },
      { on: { type: 'prompt' }, emit: [RESULT] },
      { on: { type: 'prompt' }, emit: [RESULT] },
      { on: { type: 'prompt' }, emit: [RESULT] },
    ],
  };
}

async function writeScenario(obj) {
  const p = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-usagepoll-')), 'scenario.json');
  await fs.writeFile(p, JSON.stringify(obj));
  return p;
}

let savedBuf;
before(() => { savedBuf = process.env.ORCH_OVERAGE_RESUME_BUFFER_MS; process.env.ORCH_OVERAGE_RESUME_BUFFER_MS = '0'; });
after(() => {
  if (savedBuf === undefined) delete process.env.ORCH_OVERAGE_RESUME_BUFFER_MS;
  else process.env.ORCH_OVERAGE_RESUME_BUFFER_MS = savedBuf;
});

let ctx;
beforeEach(() => { ctx = null; });
afterEach(async () => { if (ctx) await ctx.close(); ctx = null; });

async function boot(action, threshold) {
  ctx = await bootServer({ scenarioPath: await writeScenario(pollScenario()) });
  await setOnOverageAction(action);
  if (threshold) await setOverageThreshold(threshold);
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });
  return ctx;
}

async function createInst(opts = {}) {
  const inst = await ctx.instances.create({ project: 'demo', mode: 'bypassPermissions', ...opts });
  await waitFor(() => inst.status === 'idle');
  return inst;
}

// Put an instance mid-turn (so the poll's "anyLive mid-turn" gate passes).
async function midTurn(inst) {
  inst.prompt('STAY');
  await waitFor(() => inst.status === 'turn');
  return inst;
}

function collect(inst) {
  const evs = [];
  inst.on('event', (ev) => evs.push(ev));
  return evs;
}
const sub = (evs, subtype) => evs.filter(e => e.kind === 'system' && e.subtype === subtype);

// ── Core: poll trips at a LOW threshold the stream would never report ─────────

test('poll trips at low threshold (25%): five_hour util 30 ⇒ stop', async () => {
  await boot('stop', { enabled: true, value: 25 });
  const inst = await midTurn(await createInst());
  const evs = collect(inst);

  ctx.instances._usageMonitor.fetchUsage = async () => usagePayload(30, nowSec() + 3600);
  await ctx.instances._usageMonitor._tick();

  await waitFor(() => sub(evs, 'auto_stop_overage').length > 0);
  assert.equal(sub(evs, 'auto_stop_overage')[0].data.resume, false, 'action stop ⇒ resume:false');
  assert.equal(ctx.instances._overageActive, true, 'global flag set by the poll trip');
  await waitFor(() => inst.status === 'idle');
  assert.equal(inst.proc != null, true, 'session not killed');
});

test('poll below threshold: five_hour util 20 < 25 ⇒ no trip', async () => {
  await boot('stop', { enabled: true, value: 25 });
  const inst = await midTurn(await createInst());
  const evs = collect(inst);

  ctx.instances._usageMonitor.fetchUsage = async () => usagePayload(20, nowSec() + 3600);
  await ctx.instances._usageMonitor._tick();

  assert.equal(sub(evs, 'auto_stop_overage').length, 0, 'below threshold ⇒ no stop');
  assert.equal(ctx.instances._overageActive, false);
});

// ── Gating: no needless fetches ───────────────────────────────────────────────

test('poll gating: threshold disabled ⇒ no fetch, no trip', async () => {
  await boot('stop', { enabled: false, value: 25 });
  const inst = await midTurn(await createInst());
  const evs = collect(inst);

  const spy = ctx.instances._usageMonitor.fetchUsage = spyUsage(usagePayload(99, nowSec() + 3600));
  await ctx.instances._usageMonitor._tick();

  assert.equal(spy.calls, 0, 'opt-in: disabled threshold must not fetch');
  assert.equal(sub(evs, 'auto_stop_overage').length, 0);
});

test('poll gating: action "none" ⇒ no fetch, no trip', async () => {
  await boot('none', { enabled: true, value: 25 });
  const inst = await midTurn(await createInst());
  const evs = collect(inst);

  const spy = ctx.instances._usageMonitor.fetchUsage = spyUsage(usagePayload(99, nowSec() + 3600));
  await ctx.instances._usageMonitor._tick();

  assert.equal(spy.calls, 0, 'action none ⇒ nothing to stop, no fetch');
  assert.equal(sub(evs, 'auto_stop_overage').length, 0);
});

test('poll gating: no mid-turn instance ⇒ no fetch', async () => {
  await boot('stop', { enabled: true, value: 25 });
  await createInst(); // idle, never prompted

  const spy = ctx.instances._usageMonitor.fetchUsage = spyUsage(usagePayload(99, nowSec() + 3600));
  await ctx.instances._usageMonitor._tick();

  assert.equal(spy.calls, 0, 'nothing mid-turn to stop ⇒ no fetch');
  assert.equal(ctx.instances._overageActive, false);
});

// ── Failure tolerance ─────────────────────────────────────────────────────────

test('poll fetch-error tolerance: null and throwing fetchers ⇒ no trip, no crash', async () => {
  await boot('stop', { enabled: true, value: 25 });
  const inst = await midTurn(await createInst());
  const evs = collect(inst);

  ctx.instances._usageMonitor.fetchUsage = async () => null;
  await ctx.instances._usageMonitor._tick();             // must resolve
  ctx.instances._usageMonitor.fetchUsage = async () => { throw new Error('EAI_AGAIN'); };
  await ctx.instances._usageMonitor._tick();             // must resolve, not reject

  assert.equal(sub(evs, 'auto_stop_overage').length, 0, 'no false-trip on fetch failure');
  assert.equal(ctx.instances._overageActive, false);
});

// ── Cross-source dedup (the stream event and the poll never double-trip) ───────

test('dedup stream-first: a stream trip makes the subsequent poll a no-op', async () => {
  await boot('stop', { enabled: true, value: 25 });
  const a = await createInst();
  const aEvs = collect(a);
  // Stream overage trips on A.
  a.prompt('TRIP go');
  await waitFor(() => sub(aEvs, 'auto_stop_overage').length > 0);
  assert.equal(ctx.instances._overageActive, true, 'stream set the flag first');

  // A second instance is mid-turn; the poll would otherwise trip it.
  const b = await midTurn(await createInst());
  const bEvs = collect(b);
  const spy = ctx.instances._usageMonitor.fetchUsage = spyUsage(usagePayload(99, nowSec() + 3600));
  await ctx.instances._usageMonitor._tick();

  assert.equal(spy.calls, 0, 'poll short-circuits on _overageActive before fetching');
  assert.equal(sub(bEvs, 'auto_stop_overage').length, 0, 'poll did not double-trip');
});

test('dedup poll-first: a poll trip makes a subsequent stream event a no-op', async () => {
  await boot('stop', { enabled: true, value: 25 });
  const a = await midTurn(await createInst());
  const aEvs = collect(a);

  // Poll trips first.
  ctx.instances._usageMonitor.fetchUsage = async () => usagePayload(99, nowSec() + 3600);
  await ctx.instances._usageMonitor._tick();
  await waitFor(() => sub(aEvs, 'auto_stop_overage').length > 0);
  assert.equal(ctx.instances._overageActive, true, 'poll set the flag first');

  // A second instance then trips overage via the stream — must be a no-op.
  const b = await createInst();
  const bEvs = collect(b);
  b.prompt('TRIP go');
  await waitFor(() => b.status === 'idle');
  assert.equal(sub(bEvs, 'auto_stop_overage').length, 0, 'one-shot: stream did not double-route');
});

// ── Resume: arms off the FIVE-HOUR reset and fires ────────────────────────────

test('poll stop-resume: arms a timer off five_hour reset and delivers the resume prompt', async () => {
  await boot('stop-resume', { enabled: true, value: 25 });
  const inst = await midTurn(await createInst());
  const evs = collect(inst);
  const resetsAt = nowSec() + 3600;

  ctx.instances._usageMonitor.fetchUsage = async () => usagePayload(30, resetsAt);
  await ctx.instances._usageMonitor._tick();

  await waitFor(() => sub(evs, 'auto_stop_overage').length > 0);
  assert.equal(sub(evs, 'auto_stop_overage')[0].data.resume, true, 'stop-resume ⇒ resume:true');
  // Soft-interrupt → idle arms the per-session timer (five_hour reset, not overage).
  await waitFor(() => inst.autoResumeAt != null);
  assert.equal(ctx.instances._autoResumeTimers.has(inst.sessionId), true, 'resume timer armed');
  assert.equal(inst.autoResumeAt, resetsAt, 'armed off the five_hour resets_at (buffer 0)');

  assert.equal(ctx.instances._fireAutoResumeNow(inst.sessionId), true, 'pending resume fired');
  await waitFor(() => evs.some(e => e.kind === 'user_echo' && e.text === AUTO_RESUME_TEXT),
    { timeout: 10000 });
  assert.equal(inst.proc != null, true, 'never killed/respawned');
});

// ── Routing parity: conductor steered, worker untouched (same as the stream) ──

test('poll routing parity: in-control conductor is steered, worker untouched', async () => {
  await boot('stop', { enabled: true, value: 25 });
  const conductor = await createInst({});
  const worker = await createInst({ conducted: true, callerInstanceId: conductor.id });
  const cEvs = collect(conductor);
  const wEvs = collect(worker);

  // Conductor mid-turn (in control); worker also mid-turn so the poll's gate passes.
  await midTurn(conductor);
  await midTurn(worker);

  ctx.instances._usageMonitor.fetchUsage = async () => usagePayload(99, nowSec() + 3600);
  await ctx.instances._usageMonitor._tick();

  await waitFor(() => sub(cEvs, 'auto_stop_overage').some(e => e.data.steered === true));
  await waitFor(() => cEvs.some(e => e.kind === 'user_echo' && /interrupt_turn/.test(e.text || '')));
  assert.equal(sub(wEvs, 'auto_stop_overage').length, 0, 'worker is left to its conductor, not direct-stopped');
});
