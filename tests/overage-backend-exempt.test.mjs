// Sessions on a non-Claude backend are exempt from the usage-window (overage)
// stop/resume flow. A usage/rate-limit window is an Anthropic-account concept, so
// a session whose ROOT agent tree touches NO monitored domain must sit entirely
// outside the flow — never auto-stopped on a trip, never queued behind the global
// gate, never armed for auto-resume, and it shows no overage badge.
//
// This file tests BOTH halves of the split the predicate carries (card 2026-0212):
//   - STOPPING is a TREE fact, resolved from the tree's ROOT (`_inUsageWindowFlow`
//     → `agentTreeRoot`). A root tree containing ANY claude-backed agent puts EVERY
//     member in the flow — both a non-Claude conductor whose workers are Claude and
//     a non-Claude worker under a Claude conductor.
//   - TRIPPING is a per-session BACKEND fact (`_handleOverageTrip` →
//     `isMonitoredDomain(usageDomainOfBackend(inst.backend))`). Only the emitting
//     session's own backend says which account's window its `rate_limit_event`
//     reports, so a non-Claude session never trips the anthropic flow even when its
//     tree is in-flow.
// Exercises the backend-scoped usage-window-domain seam (src/usageWindowDomains.ts
// — each backend maps to its own domain, `claude` to the monitored `anthropic`) +
// the guards in instances.ts.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { setOnOverageAction, addBackend, addCustomModel } from '../src/appSettings.ts';
import { installUsageSeamTripwire, assertUsageSeamInjected, assertUsageSeamsInstalled } from './overageUsageSeam.mjs';

const nowSec = () => Math.floor(Date.now() / 1000);
const INIT = { type: 'system', subtype: 'init', session_id: '$SID', cwd: '$CWD',
  model: 'claude-sonnet-4-6', permissionMode: '$MODE', tools: ['Bash'], uuid: 'init-1' };
const RESULT = { type: 'result', subtype: 'success', stop_reason: 'end_turn',
  duration_ms: 10, total_cost_usd: 0.0001, is_error: false };

// Real overage trip shape (five-hour window rejected + isUsingOverage).
function overageEvent(resetsAt) {
  return { type: 'system', subtype: 'rate_limit_event', uuid: 'rl-1',
    rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour',
      overageStatus: 'allowed', isUsingOverage: true, resetsAt } };
}

// No turns ⇒ a prompted instance emits nothing back and HOLDS mid-turn ('turn'
// status) — the state _routeOverageStop's Pass 3 acts on.
const HOLD = { events: [INIT], turns: [] };
// An ABORTED turn's ending. The fake auto-ACKs the stop's soft interrupt but emits
// no `result` unless a control turn matches it — and without that turn→idle
// transition the per-session resume deadline never arms, which would make every
// `autoResumeAt` assertion below pass for the wrong reason.
const INTERRUPT_TURN = {
  on: { type: 'control', subtype: 'interrupt' },
  emit: [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null },
    { type: 'result', subtype: 'error_during_execution', stop_reason: 'interrupted',
      duration_ms: 20, total_cost_usd: 0.0001, is_error: true },
  ],
};
// HOLD mid-turn (no prompt turn matches), then wind down when the stop interrupts.
const HOLD_THEN_ABORT = { events: [INIT], turns: [INTERRUPT_TURN] };
// Prompt turn emits an overage trip then a RESULT (mirrors overage-action.test).
function tripScenario(resetsAt) {
  return { events: [INIT], turns: [{ on: { type: 'prompt' }, emit: [overageEvent(resetsAt), RESULT] }] };
}

async function writeScenario(obj) {
  const p = path.join(await mkdtemp('cc-ollama-overage-'), 'scenario.json');
  await fs.writeFile(p, JSON.stringify(obj));
  return p;
}

let ctx, instances, home, seam;
before(async () => {
  ctx = await bootServer({});
  instances = ctx.instances;
});
after(async () => { await ctx.close(); });

beforeEach(async () => {
  ({ home } = await freshProjectsRoot());
  // Reset shared global overage state so nothing leaks between tests.
  instances._clearOverage();
  instances._overageResume.clearAll();
  seam = installUsageSeamTripwire(instances);
  await setOnOverageAction('stop-resume');
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });
});
afterEach(async () => {
  await instances.shutdown();
  await rmrf(home);
  assertUsageSeamInjected(seam);
});

// create() directly (not the REST route) so we can pass callerInstanceId /
// conducted — the MCP-only fields the /api/instances route doesn't expose.
async function spawn({ scenario = HOLD, backend = 'claude', model, callerInstanceId, conducted } = {}) {
  process.env.FAKE_CLAUDE_SCENARIO = await writeScenario(scenario);
  const inst = await instances.create({
    project: 'demo', mode: 'bypassPermissions',
    ...(model ? { model } : {}),
    ...(backend !== 'claude' ? { backend } : {}),
    ...(conducted ? { conducted: true } : {}),
    ...(callerInstanceId ? { callerInstanceId } : {}),
  });
  await waitFor(() => inst.status === 'idle');
  return inst;
}

const sysEvents = (inst) => { const evs = []; inst.on('event', e => evs.push(e)); return evs; };
const sub = (evs, subtype) => evs.filter(e => e.kind === 'system' && e.subtype === subtype);

// Card 2026-0208. This file's own wiring pin — every overage test file needs one,
// because each file's `beforeEach` is independently editable and a sibling file's
// assertion cannot see this one being reverted to the live `getAccountUsage` default.
// It matters here even though no test below touches the seams: `beforeEach` sets
// `stop-resume` for every test, so a reverted default arms the live fetcher behind
// each one. Discriminating assertion: the `strictEqual` inside assertUsageSeamsInstalled.
test('HARNESS (2026-0208): this file\'s beforeEach installs the usage-seam tripwire on both seams', async () => {
  await assertUsageSeamsInstalled(instances, seam);
});

test('_inUsageWindowFlow: a session on a substitution backend is exempt; a Claude session is in-flow', async () => {
  const claude = await spawn({});
  const ollama = await spawn({ backend: 'ollama', model: 'gemma4:cloud' });
  assert.equal(ollama.backend, 'ollama');
  assert.equal(instances._inUsageWindowFlow(claude), true);
  assert.equal(instances._inUsageWindowFlow(ollama), false);
  assert.deepEqual(instances.agentTreeBackends(ollama), new Set(['ollama']));
  assert.deepEqual(instances.usageWindowDomainsOf(ollama), new Set(['backend:ollama']));
  assert.deepEqual(instances.usageWindowDomainsOf(claude), new Set(['anthropic']));
});

// A USER-DEFINED backend gets its OWN unmonitored domain — the exemption is not
// an 'ollama' special case, it falls out of the domain mapping.
test('_inUsageWindowFlow: a user-defined backend gets its own unmonitored domain and is exempt too', async () => {
  await addBackend({ id: 'my-proxy', label: 'My Proxy', template: 'proxyctl claude --model {model} --' });
  await addCustomModel({ label: 'Mine', model: 'mine:v1', backend: 'my-proxy', contextWindow: 100_000 });
  const proxy = await spawn({ backend: 'my-proxy', model: 'mine:v1' });
  assert.equal(proxy.backend, 'my-proxy');
  assert.deepEqual(instances.agentTreeBackends(proxy), new Set(['my-proxy']));
  assert.deepEqual(instances.usageWindowDomainsOf(proxy), new Set(['backend:my-proxy']));
  assert.equal(instances._inUsageWindowFlow(proxy), false);
});

// Backend ids are user-chosen, so an un-namespaced domain map would put a row
// literally named `anthropic` into the MONITORED domain — auto-stopping it and
// globally queueing its sends against a window it never touches. The `backend:`
// namespace makes that impossible by construction.
test('_inUsageWindowFlow: a backend named `anthropic` does NOT collide with the monitored domain', async () => {
  await addBackend({ id: 'anthropic', label: 'Not Anthropic', template: 'notanthropic claude --model {model} --' });
  await addCustomModel({ label: 'Sneaky', model: 'sneaky:v1', backend: 'anthropic', contextWindow: 100_000 });
  const sneaky = await spawn({ backend: 'anthropic', model: 'sneaky:v1' });
  assert.equal(sneaky.backend, 'anthropic');
  assert.deepEqual(instances.usageWindowDomainsOf(sneaky), new Set(['backend:anthropic']),
    'namespaced away from the monitored `anthropic` domain');
  assert.equal(instances._inUsageWindowFlow(sneaky), false, 'must stay exempt');
});

test('agent tree: a non-Claude conductor with a Claude worker is in-flow; a lone non-Claude leaf is not', async () => {
  const conductor = await spawn({ backend: 'ollama', model: 'gemma4:cloud' });
  const worker = await spawn({ conducted: true, callerInstanceId: conductor.id });
  const lone = await spawn({ backend: 'ollama', model: 'gemma4:cloud' });
  assert.equal(worker.backend, 'claude');
  assert.equal(worker.callerInstanceId, conductor.id);
  assert.deepEqual(instances.agentTreeBackends(conductor), new Set(['ollama', 'claude']));
  assert.equal(instances._inUsageWindowFlow(conductor), true, 'tree touches anthropic via the Claude worker');
  assert.equal(instances._inUsageWindowFlow(worker), true, 'the Claude worker itself is in-flow');
  assert.equal(instances._inUsageWindowFlow(lone), false, 'a childless non-Claude leaf stays exempt');
});

test('global overage trip stops a mid-turn Claude session but exempts a coexisting Ollama session', async () => {
  const claude = await spawn({});
  const ollama = await spawn({ backend: 'ollama', model: 'gemma4:cloud' });
  const cEvs = sysEvents(claude), oEvs = sysEvents(ollama);
  // Drive both mid-turn (HOLD emits no RESULT ⇒ status stays 'turn').
  claude.prompt('go'); ollama.prompt('go');
  await waitFor(() => claude.status === 'turn' && ollama.status === 'turn');

  // Account-global trip (inst=null, the poll-monitor path) routes across all live.
  instances._handleOverageTrip(null, { resetsAt: nowSec() + 3600 });

  await waitFor(() => claude.autoStoppedForOverage === true);
  assert.ok(sub(cEvs, 'auto_stop_overage').length > 0, 'Claude got the stop notice');
  assert.equal(claude.summary().overageActive, true, 'Claude gate is active');

  // Ollama: never stopped, never armed, gate inactive ⇒ no overage badge.
  assert.equal(ollama.autoStoppedForOverage, false, 'Ollama not auto-stopped');
  assert.equal(ollama.autoResumeAt, null, 'Ollama not armed');
  assert.equal(sub(oEvs, 'auto_stop_overage').length, 0, 'Ollama got no stop notice');
  assert.equal(ollama.summary().overageActive, false, 'Ollama gate exempt ⇒ no overage badge');
});

test('during an active overage window an Ollama session still sends normally (not queued)', async () => {
  const claude = await spawn({});
  const ollama = await spawn({ backend: 'ollama', model: 'gemma4:cloud' });
  claude.prompt('go');
  await waitFor(() => claude.status === 'turn');
  instances._handleOverageTrip(null, { resetsAt: nowSec() + 3600 });
  await waitFor(() => instances._overageActive === true);

  // The global gate is active, but the exempt Ollama session must NOT queue.
  await ollama.prompt('hello');
  assert.equal(ollama._overageQueue.length, 0, 'Ollama send not queued behind the gate');
  assert.equal(ollama.summary().queuedCount, 0);
});

// B3 — a LONE ollama session: exempt under both the old (downward) and the new
// (root-scoped) predicate, and refused by the per-session backend test at the trip
// site too. Passes unchanged across card 2026-0212 by design; it is the baseline B1
// and B2 vary from.
test("an Ollama session's own rate_limit_event does not trip the global flow", async () => {
  const ollama = await spawn({ backend: 'ollama', model: 'gemma4:cloud', scenario: tripScenario(nowSec() + 3600) });
  const evs = sysEvents(ollama);
  ollama.prompt('go');
  // The trip event is emitted + processed, then RESULT winds the turn to idle.
  await waitFor(() => ollama.status === 'idle' && sub(evs, 'init').length > 0);

  assert.equal(instances._overageActive, false, 'Ollama trip did not flip the global flag');
  assert.equal(ollama.autoStoppedForOverage, false);
  assert.equal(ollama.autoResumeAt, null);
  assert.equal(sub(evs, 'auto_stop_overage').length, 0, 'no auto-stop notice for the exempt Ollama trip');
});

// ── Card 2026-0212: the unit of stopping is the TREE, resolved from its ROOT ──
//
// `agentTreeBackends` walks DOWNWARD only, so asking it about an ollama worker `E`
// under a Claude conductor `C` answers "does E or anything below E use Claude?" —
// no. But C's tree is {claude, ollama} and E is a member of it, so E must be
// stopped with it. `_inUsageWindowFlow` therefore evaluates `agentTreeRoot(inst)`.

// A1 — Invariant: a non-Claude worker whose ROOT tree contains Claude is a FULL
// member of the stop (notice, badge, sever, un-armed refusal), not an exempt
// bystander. FIX-DEPENDENT: every assertion here is unreachable while the predicate
// is downward-only, because the worker is filtered out of `live` entirely.
test('an overage trip stops and severs an ollama worker under a Claude conductor', async () => {
  const conductor = await spawn({});
  const worker = await spawn({ scenario: HOLD_THEN_ABORT, backend: 'ollama',
    model: 'gemma4:cloud', conducted: true, callerInstanceId: conductor.id });
  const wEvs = sysEvents(worker);

  // Driving the worker mid-turn is what arms the conductor's spawn-ownership wake,
  // which makes the conductor IN CONTROL: Pass 1 protects the worker, Pass 2 stops
  // the conductor, Pass 3 stops the worker un-armed.
  worker.prompt('go');
  await waitFor(() => worker.status === 'turn');
  assert.equal(instances.isIdleCaller(conductor.id), true, 'precondition: the conductor is in control');
  assert.equal(instances._inUsageWindowFlow(worker), true,
    'the ollama worker is IN the flow — its root tree contains the Claude conductor');
  assert.equal(instances.agentTreeRoot(worker), conductor, 'and the root walk lands on the conductor');

  // Account-global trip (inst=null, the poll path) so the trip-site backend test is
  // not in play — this test is about routing.
  instances._handleOverageTrip(null, { resetsAt: nowSec() + 3600 });

  await waitFor(() => sub(wEvs, 'auto_stop_overage').length > 0);
  // Protected by an in-control conductor ⇒ stopped UN-ARMED by design: the
  // conductor is the sole driver on resume.
  assert.equal(worker._overageStoppedUnarmed, true, 'stopped un-armed');
  await waitFor(() => worker.status === 'idle');
  assert.equal(worker.autoResumeAt, null, 'and so never armed a resume deadline');
  assert.equal(worker.summary().overageActive, true, 'the overage badge shows on the worker');
  assert.equal(instances.hasArmedWake(worker.id), false, 'the wake on the worker is severed');
  assert.equal(conductor._overageDroppedCallbacks, true, 'and the conductor is marked for it');
  // overageSendRefused ANDs the un-armed flag with the now-active gate.
  await assert.rejects(() => worker.prompt('x'), /cannot be queued/,
    'an un-armed worker refuses sends rather than queueing them');
});

// A2 — Invariant: the QUEUEING half of membership. An in-flow non-Claude worker with
// no in-control conductor takes the ordinary armed-and-queued path, not the un-armed
// refusal. FIX-DEPENDENT: the worker is untouched by routing while the predicate is
// downward-only.
test('an ollama worker whose conductor is not in control is stopped ARMED and queues', async () => {
  const conductor = await spawn({});
  const worker = await spawn({ scenario: HOLD_THEN_ABORT, backend: 'ollama',
    model: 'gemma4:cloud', conducted: true, callerInstanceId: conductor.id });

  worker.prompt('go');
  await waitFor(() => worker.status === 'turn');
  // Drop the conductor's wake: it is then neither mid-turn nor a waiting caller, so
  // Pass 1 protects nothing, Pass 2 stops nobody, and Pass 3 owns this worker.
  instances.disarmIdleSilently(conductor.sessionId, worker.id);
  assert.equal(instances.isIdleCaller(conductor.id), false, 'precondition: conductor NOT in control');
  assert.equal(instances._inUsageWindowFlow(worker), true, 'still in-flow via its root tree');

  instances._handleOverageTrip(null, { resetsAt: nowSec() + 3600 });

  await waitFor(() => worker.autoStoppedForOverage === true);
  assert.equal(worker._overageStoppedUnarmed, false, 'not protected ⇒ not un-armed');
  await waitFor(() => worker.autoResumeAt !== null);

  await worker.prompt('later');
  assert.equal(worker._overageQueue.length, 1, 'its send queues behind the lockout');
  assert.equal(worker.summary().queuedCount, 1);
});

// A3 — Invariant (card 2026-0212's F1 burn, made UNREACHABLE rather than patched):
// after the stop, no wake stub reaches the conductor and the worker starts no
// further turn inside the window. Deliberately NOT "the worker emits no turn_end" —
// a mid-turn worker emits exactly one final turn_end from the soft interrupt; the
// point is that it wakes nobody. FIX-DEPENDENT: with the worker filtered out of
// `live`, Pass 1 sees no protected worker, so the idle conductor is never stopped,
// never severed, and its wake survives to deliver the stub.
test('F1: an ollama worker under a Claude conductor delivers no wake stub during the lockout', async () => {
  const conductor = await spawn({});
  const worker = await spawn({ scenario: HOLD_THEN_ABORT, backend: 'ollama',
    model: 'gemma4:cloud', conducted: true, callerInstanceId: conductor.id });
  const cEvs = [];
  conductor.on('event', e => cEvs.push(e));

  worker.prompt('go');
  await waitFor(() => worker.status === 'turn');
  assert.equal(instances.hasArmedWake(worker.id), true, 'precondition: the conductor holds a wake');
  assert.equal(instances._inUsageWindowFlow(worker), true, 'precondition: the worker is in-flow');

  instances._handleOverageTrip(null, { resetsAt: nowSec() + 3600 });
  await waitFor(() => instances._overageActive === true);

  assert.equal(instances.hasArmedWake(worker.id), false, 'the wake is severed by the stop');
  // Replay the worker's turn boundary: the severed wait cannot fire.
  instances.emit('event', { id: worker.id, ev: { kind: 'turn_end', isError: false } });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(cEvs.some(e => e.kind === 'user_echo' && /finished its turn/.test(e.text || '')), false,
    'no internal:true wake stub reaches the conductor mid-lockout');
});

// A4 — Invariant (the must-not-regress guard): root-scoping must not drag an exempt
// tree into the flow merely because it HAS a parent. NOT fix-dependent for its
// verdicts — an ollama-only tree was exempt before and after — but it does exercise
// the new helper, so it kills a resolver that returns any-parent-implies-in-flow or
// that mis-picks the root.
test('an ollama-only tree stays fully exempt at every depth', async () => {
  const parent = await spawn({ backend: 'ollama', model: 'gemma4:cloud' });
  const child = await spawn({ backend: 'ollama', model: 'gemma4:cloud',
    conducted: true, callerInstanceId: parent.id });
  assert.equal(instances.agentTreeRoot(child), parent, 'the root walk climbs to the parent');
  assert.equal(instances.agentTreeRoot(parent), parent, 'and stops there');
  assert.equal(instances._inUsageWindowFlow(child), false, 'the child stays exempt');
  assert.equal(instances._inUsageWindowFlow(parent), false, 'and so does the parent');
});

// A5 — Invariant: `agentTreeRoot` TERMINATES in every degenerate shape, and every
// member of one tree gets the SAME verdict (one tree returning two verdicts is the
// exact bug class this card fixes). The declared timeout catches a resolver that
// loses termination without blocking; a `seen` guard deleted outright spins
// synchronously and takes the whole file's runner slot down instead — either way the
// mutant is killed, just not gracefully.
test('agentTreeRoot terminates on a cycle and on a missing parent', { timeout: 5000 }, async () => {
  // Missing parent: stop at the deepest instance still visible in byId.
  const orphan = await spawn({ backend: 'ollama', model: 'gemma4:cloud' });
  orphan.callerInstanceId = 'no-such-id';
  assert.equal(instances.agentTreeRoot(orphan), orphan);
  assert.equal(instances._inUsageWindowFlow(orphan), false);

  // Exempt cycle: both calls return, both members agree.
  const a = await spawn({ backend: 'ollama', model: 'gemma4:cloud' });
  const b = await spawn({ backend: 'ollama', model: 'gemma4:cloud' });
  a.callerInstanceId = b.id;
  b.callerInstanceId = a.id;
  assert.ok(instances.agentTreeRoot(a));
  assert.ok(instances.agentTreeRoot(b));
  assert.equal(instances._inUsageWindowFlow(a), false);
  assert.equal(instances._inUsageWindowFlow(b), false);

  // Mixed cycle — the load-bearing case. agentTreeRoot lands on a different member
  // depending on where the walk starts, but agentTreeBackends is cycle-safe and
  // reaches every member from any of them, so the verdict is the same for both.
  const oll = await spawn({ backend: 'ollama', model: 'gemma4:cloud' });
  const cla = await spawn({});
  oll.callerInstanceId = cla.id;
  cla.callerInstanceId = oll.id;
  assert.equal(instances._inUsageWindowFlow(oll), true, 'the ollama member of a mixed cycle is in-flow');
  assert.equal(instances._inUsageWindowFlow(cla), true, 'and so is the claude member — they must agree');
});

// ── The stop-vs-trip split: TRIPPING is a per-session BACKEND fact ──────────

// B1 — Invariant: an unmonitored backend's own rate_limit_event reports ITS
// endpoint's window and must not flip the anthropic lockout, no matter what its tree
// contains. FIX-DEPENDENT, and it closes a PRE-EXISTING imprecision: today the
// downward tree of an ollama conductor with a Claude worker contains `claude`, so the
// ollama-endpoint event trips the global flow and stops the whole fleet.
test("an ollama conductor's own rate_limit_event does not trip the anthropic flow even with a Claude worker", async () => {
  const oc = await spawn({ backend: 'ollama', model: 'gemma4:cloud',
    scenario: tripScenario(nowSec() + 3600) });
  const w = await spawn({ conducted: true, callerInstanceId: oc.id });
  const ocEvs = sysEvents(oc);
  oc.prompt('go');
  await waitFor(() => oc.status === 'idle');

  assert.equal(instances._overageActive, false,
    "an ollama endpoint's 429 must not flip the anthropic lockout");
  assert.equal(sub(ocEvs, 'auto_stop_overage').length, 0, 'nothing was stopped');
  assert.equal(w.autoStoppedForOverage, false, 'including its Claude worker');
});

// B2 — Invariant: the trip site is STRICTLY NARROWER than `_inUsageWindowFlow` — the
// tree being in-flow is not enough to trip. Guards the regression root-scoping would
// otherwise introduce: an ollama worker's own endpoint 429 flipping a global
// anthropic lockout. The `_inUsageWindowFlow` half IS fix-dependent; the
// `_overageActive` half holds today for the wrong reason (the worker is exempt) and
// after the fix for the right one (its own backend is unmonitored). Killed by
// reverting the trip guard to `_inUsageWindowFlow`.
test("an ollama worker's own rate_limit_event does not trip, though its tree is in-flow", async () => {
  const c = await spawn({});
  const e = await spawn({ backend: 'ollama', model: 'gemma4:cloud', conducted: true,
    callerInstanceId: c.id, scenario: tripScenario(nowSec() + 3600) });
  const eEvs = sysEvents(e);
  e.prompt('go');
  await waitFor(() => e.status === 'idle');

  assert.equal(instances._inUsageWindowFlow(e), true, 'its tree IS in the flow');
  assert.equal(instances._overageActive, false, 'yet its own 429 does not trip the anthropic window');
  assert.equal(sub(eEvs, 'auto_stop_overage').length, 0);
});
