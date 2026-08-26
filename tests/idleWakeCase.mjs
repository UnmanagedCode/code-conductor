// Shared harness for the idle-wake-by-OWNERSHIP suite (cards 2026-0126, 2026-0221).
//
// The contract under test, in one sentence: an owned session enters a turn,
// therefore its owner is woken when that turn ends. Ownership is spawn
// (`callerInstanceId`) OR dispatch (any turn-starting MCP call), the arm happens
// on the transition INTO `turn`, and there is no register verb and no opt-out.
// When the *target* hits turn_end a stub user prompt lands in the *owner* (via
// Instance.prompt(), the same path WS / auto-approve use). Caller identity is
// read from `?caller=<id>` on the MCP URL. Alongside the armed wake runs a
// repeating heartbeat that reports "did NOT finish" WITHOUT consuming it.
//
// Tests drive the MCP transport via fetch (same shape a real `claude
// mcp add --transport http` client would use), and use the fake-claude
// subprocess via bootServer() so no real LLM is needed.
//
// The cases live in the eight tests/idle-wake-*.test.mjs files, which each
// import from here — one harness, eight consumers, so the transport and the
// lifecycle cannot drift between them:
//
//   idle-wake-ownership       the ownership edge (spawn OR dispatch), the arm
//                             that follows it, purge on removal, the delivered
//                             stub's shape, the caller-side awaitingWake flag
//   idle-wake-defer           what holds a wake back: a session rotation, a
//                             live/queued background subagent
//   idle-wake-interrupt       the two interrupt tiers and who each silences
//   idle-wake-abort-qualifier turnForceAborted: latch, rollback, lifetime
//   idle-wake-heartbeat       what a beat consumes: nothing, except a target
//                             gone for good
//   idle-wake-interval        one interval per caller→target pair, and turn_end
//                             clears every one
//   idle-wake-window          set_idle_timeout's three states, the clamp, the
//                             identity refusals
//   idle-wake-retire-gaps     the three states _goneForGood must not mistake
//                             for death
//
// Card 2026-0221 split them out of a single 1610-line file: the per-file
// hang-guard deadline (FILE_KILL_MS, tests/hangGuardConfig.mjs) is charged one
// file the SUM of its cases' bounded wall-clock windows, and that sum had
// already passed the deadline under a plausible regression. See the FILE_KILL_MS
// comment there for the measurements.
//
// This module is NOT named `*.test.mjs`, so run.mjs's discover() (which globs
// `*.test.mjs`) ignores it — same convention as helpers.mjs / hangGuardCase.mjs.

import { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession, freshProjectsRoot, rmrf } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCENARIO_WS = path.join(__dirname, 'fixtures', 'scenario-ws.json');
export const SCENARIO_QUESTION = path.join(__dirname, 'fixtures', 'scenario-question.json');
export const SCENARIO_SLOW = path.join(__dirname, 'fixtures', 'scenario-slow-turn.json');
export const SCENARIO_BG_HANG = path.join(__dirname, 'fixtures', 'scenario-bg-task-hang.json');
export const SCENARIO_BG_COMPLETE = path.join(__dirname, 'fixtures', 'scenario-bg-task-complete.json');
export const SCENARIO_BG_MIDTURN = path.join(__dirname, 'fixtures', 'scenario-bg-task-midturn-complete.json');
export const SCENARIO_BG_CONSUMED = path.join(__dirname, 'fixtures', 'scenario-bg-task-midturn-consumed.json');
// A turn that stays open ~1s and then ends on its own (delay_ms spaces every
// event), so a short heartbeat can fire several times inside one real turn.
export const SCENARIO_PACED = path.join(__dirname, 'fixtures', 'scenario-paced-turn.json');
// Same turn, 800ms between events, so the mid-turn span is ~4s. Used where the
// assertion needs SEVERAL heartbeats inside one turn: with a bounded span the
// budget for them is the span itself, not waitFor's timeout, and a starved event
// loop coalesces missed setInterval fires rather than replaying them — so a wide
// SPAN is the only thing that buys schedule tolerance. A window count does not:
// halving the interval doubles the windows but survives no longer a stall.
export const SCENARIO_LONG = path.join(__dirname, 'fixtures', 'scenario-long-turn.json');
// The paced turn, but the fake swallows `interrupt` control_requests instead of
// auto-ACKing — the only way to stage a REAL _controlRequest timeout end to end.
export const SCENARIO_NO_ACK = path.join(__dirname, 'fixtures', 'scenario-no-interrupt-ack.json');
// A turn parked mid-text-block that never ends on its own — a SOFT interrupt
// never reaches an output boundary on it — plus an interrupt turn, so a FORCED
// interrupt produces the turn_end a real forced abort produces.
export const SCENARIO_OPEN = path.join(__dirname, 'fixtures', 'scenario-open-turn.json');
// ONE prompt, TWO CLI turns: the second message_start has no prompt behind it.
export const SCENARIO_UNPROMPTED = path.join(__dirname, 'fixtures', 'scenario-unprompted-second-turn.json');
// prompt opens a turn holding a live background Agent; the forced abort's own
// turn_end therefore DEFERS, the task drains, and an UNPROMPTED re-invocation
// turn's turn_end is where the deferred wake finally resolves.
export const SCENARIO_ABORT_DEFER = path.join(__dirname, 'fixtures', 'scenario-abort-defer-reinvoke.json');
// Same open turn, but the abort's turn_end STAYS deferred — the drain and the
// following turn are gated behind a fresh 'again' prompt, so a new instruction is
// what moves the deferred wake on.
export const SCENARIO_ABORT_DEFER_THEN_PROMPT = path.join(__dirname, 'fixtures', 'scenario-abort-defer-then-prompt.json');

// The live server handles, as a MUTABLE OBJECT rather than exported bindings: a
// consumer that destructured `baseUrl` at import time would capture the
// pre-boot `undefined` forever, since `before` has not run yet. Every helper
// below reads through `ctx` for the same reason.
export const ctx = {};
let server, home;

// Registers the whole lifecycle on the CALLING FILE's root suite — `before` and
// friends imported from node:test bind to whichever file is being loaded, and
// run.mjs gives each test file its own process (isolation:'process'), so one
// server + one fresh projects root per file, torn down with it. Call it once at
// top level.
//
// `onReady` is how each file binds the bare `baseUrl` / `instances` identifiers
// its test bodies read, and it is a CALLBACK rather than a second `before` in the
// file because node:test does NOT sequence root `before` hooks: measured, three
// root hooks run as `A-start | B-sync | C-start | C-end | A-end` — started in
// registration order, never awaited between. A file-side `before` reading `ctx`
// therefore sees the pre-boot `undefined`. Called here, after the await, it
// cannot.
export function setupIdleWake(onReady) {
  before(async () => {
    server = await bootServer({ scenarioPath: SCENARIO_WS });
    ctx.baseUrl = server.baseUrl;
    ctx.instances = server.instances;
    onReady?.(ctx);
  });
  after(async () => { await server.close(); });
  beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
  afterEach(async () => {
    await ctx.instances.shutdown();
    // shutdown() clears byId but not the hub's maps — purge both so neither a
    // stale armed wake nor a stale ownership edge bleeds into the next test.
    ctx.instances._idleSubscribers?.clear();
    ctx.instances._idleHub?._owners.clear();
    await rmrf(home);
  });
}

let nextRpcId = 1;

export async function rpc(baseUrl, method, params, { caller } = {}) {
  const id = nextRpcId++;
  // `?caller=` now carries the stable instanceId (what Instance.spawn bakes);
  // translate a caller sessionId to it. Unresolved values pass through so the
  // no-caller / bogus-caller refusal paths still fire.
  const handle = caller ? (instForSession(ctx.instances, caller)?.id ?? caller) : null;
  const url = baseUrl + '/mcp' + (handle ? `?caller=${encodeURIComponent(handle)}` : '');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (res.status === 202) return { status: 202, body: null };
  const body = await res.json();
  return { status: res.status, body };
}

export async function callTool(name, args, opts) {
  const { body } = await rpc(ctx.baseUrl, 'tools/call', { name, arguments: args }, opts);
  assert.ok(body, 'rpc returned a response');
  assert.ok(body.result, `tools/call ${name} returned no result; body=${JSON.stringify(body)}`);
  return body.result;
}

export function unwrap(result) {
  assert.ok(Array.isArray(result.content), 'tool result has content[]');
  return JSON.parse(result.content[0].text);
}

export async function spawnReady(project) {
  const spawn = unwrap(await callTool('spawn_instance', {
    project, mode: 'bypassPermissions',
  }));
  await waitFor(() =>
    instForSession(ctx.instances, spawn.sessionId)?.status === 'idle',
  );
  return spawn.sessionId;
}

// Arm a wake without running a turn: `noteDispatch` records the ownership edge
// and `onTurnStart` is the exact call Instance._setStatus makes when a turn
// begins. Used only where the target must STAY idle for the case under test.
export function armWake(callerSid, targetSid, timeoutMs) {
  ctx.instances.noteDispatch(callerSid, targetSid, timeoutMs);
  ctx.instances._idleHub.onTurnStart(instForSession(ctx.instances, targetSid).id);
}

// Both soft-interrupt pins need the target PARKED MID-TEXT-BLOCK, not merely in a
// turn. prompt() flips status to `turn` synchronously at stdin-write time, while
// QuiescenceScan only opens a block on the first text_delta — so `status === 'turn'`
// alone admits an EMPTY quiescence, and a soft interrupt arriving in that window is
// fired IMMEDIATELY by _maybeFireArmedInterrupt. SCENARIO_OPEN answers that
// control_request with a `result`, so the turn ends, the turn_end consumes the wake
// and clears the heartbeat, and the pin fails — as `hasArmedWake === false` if the
// result is parsed in time, or as a 20s `beats.n > 0` timeout if it is not.
// Same barrier as tests/mcp.test.mjs:305.
export function waitParkedMidBlock(target) {
  return waitFor(() => target.status === 'turn' && !target._quiescence.empty);
}

export async function spawnReadyWithScenario(project, scenarioPath) {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = scenarioPath;
  try {
    return await spawnReady(project);
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prev;
  }
}

export function countUserEchoes(inst, predicate = () => true) {
  return inst.ringSnapshot().filter(ev => ev.kind === 'user_echo' && predicate(ev)).length;
}

export function findStubFor(inst, targetId) {
  return inst.ringSnapshot().find(ev =>
    ev.kind === 'user_echo' &&
    typeof ev.text === 'string' &&
    ev.text.includes(targetId) &&
    ev.text.includes('get_recent_messages'),
  );
}

// Count heartbeat deliveries for one target AT THE HUB. "The heartbeat keeps
// firing" is a statement about the interval, and routing that observation through
// the caller's fake subprocess (deliver → prompt → stdin → user_echo → ring) puts
// four contention-sensitive hops between the fact and the assertion — measured:
// two of eight concurrent copies of this file timed out at 20s waiting for an echo
// whose beat had almost certainly fired. Where the assertion is about the timer,
// watch the timer. Where it is about the conductor actually being TOLD (the
// repeat pin), the echo is the point and stays.
export function watchBeats(hub, targetInstanceId) {
  const real = hub.deliver.bind(hub);
  const state = { n: 0, restore() { hub.deliver = real; } };
  hub.deliver = (callerId, tid, opts) => {
    if (tid === targetInstanceId && opts?.timedOut) state.n++;
    return real(callerId, tid, opts);
  };
  return state;
}

// A COMPLETION stub specifically — findStubFor matches any wake naming the
// target, heartbeat pings included.
export function findCompletionStubFor(inst, targetId) {
  return inst.ringSnapshot().find(ev =>
    ev.kind === 'user_echo' &&
    typeof ev.text === 'string' &&
    ev.text.includes(targetId) &&
    ev.text.includes('finished its turn'),
  );
}

export function findInterruptedStubFor(inst, targetId) {
  return inst.ringSnapshot().find(ev =>
    ev.kind === 'user_echo' &&
    typeof ev.text === 'string' &&
    ev.text.includes(targetId) &&
    ev.text.includes('was INTERRUPTED'),
  );
}

export function findTimeoutStubFor(inst, targetId) {
  return inst.ringSnapshot().find(ev =>
    ev.kind === 'user_echo' &&
    typeof ev.text === 'string' &&
    ev.text.includes(targetId) &&
    ev.text.includes('did NOT finish'),
  );
}

// A NON-temp worker (the REST spawn path): an MCP-spawned worker is temp, so its
// exit drops it from byId and purge() clears the graph before any beat can land —
// which is exactly the case these tests are NOT about. Shared by
// idle-wake-heartbeat (the retirement) and idle-wake-retire-gaps (the three
// gaps that must not be mistaken for it).
export async function restWorker(project, scenarioPath) {
  const prev = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = scenarioPath;
  try {
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions' });
    assert.equal(r.status, 201);
    const inst = ctx.instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);
    return inst;
  } finally { process.env.FAKE_CLAUDE_SCENARIO = prev; }
}
