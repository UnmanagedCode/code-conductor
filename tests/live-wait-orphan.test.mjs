// send_prompt's LIVE `wait:true` branch must strand no promise.
//
// The branch creates a `turn_end` waiter and then sends. If the send rejects
// (session being rewritten, process gone) before anything consumes the waiter,
// the waiter's own timer later rejects with nobody listening — and Node's
// default --unhandled-rejections=throw takes the ORCHESTRATOR process down,
// orphaning every live worker, not just this call. So the assertion is on
// process-level unhandled rejections, which is the actual failure.
//
// Real instances against the in-process fake CLI, calling sendPrompt directly
// (not over MCP). Harness copied from tests/deferred-steer.test.mjs.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { sendPrompt } from '../src/mcp/handlers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// `"turns": []` — the instance reaches idle with a session id, and ANY prompt
// leaves the turn open forever, so the fake CLI can never answer and nothing
// can settle a waiter for the wrong reason.
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-no-turn.json');

let ctx, baseUrl, instances, home, transcriptPath;
let seq = 0;
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
  transcriptPath = path.join(home, `stdin-${++seq}.jsonl`);
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;
});
afterEach(async () => {
  await instances.shutdown();
  for (const fn of cleanupListeners.splice(0)) fn();
  delete process.env.FAKE_CLAUDE_TRANSCRIPT;
  await rmrf(home);
});

async function stdinLines() {
  try {
    return (await fs.readFile(transcriptPath, 'utf8'))
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}
const userLinesIn = (lines) => lines.filter(l => l.type === 'user' && l.message?.role === 'user');
const textsOf = (line) => line.message.content.filter(b => b.type === 'text').map(b => b.text);

// A default claude-backed worker: acceptsMidTurnSteering === true, so `deferred`
// is false and both tests below take the LIVE branch.
async function setupWorker() {
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
  assert.equal(r.status, 201);
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  return inst;
}

function collect(inst) {
  const evs = [];
  const handler = (ev) => evs.push(ev);
  inst.on('event', handler);
  cleanupListeners.push(() => inst.off('event', handler));
  return evs;
}

const send = (inst, text, extra = {}) =>
  sendPrompt({ sessionId: inst.sessionId, text, subscribe: false, ...extra }, { instances });

// Capture unhandled rejections for the duration of one test. Installing a
// listener also suppresses the default crash, so the assertion is on the
// captured list rather than on the runner surviving.
function captureUnhandled() {
  const seen = [];
  const onUnhandled = (err) => seen.push(err);
  process.on('unhandledRejection', onUnhandled);
  cleanupListeners.push(() => process.off('unhandledRejection', onUnhandled));
  return seen;
}
// Unhandled rejections are reported a tick after the microtask queue drains.
const settleUnhandled = () => new Promise(r => setTimeout(r, 60));

test('live wait:true whose delivery FAILS: the error surfaces and no waiter is left behind', async () => {
  const inst = await setupWorker();
  const evs = collect(inst);
  assert.notEqual(inst.status, 'turn');
  assert.notEqual(inst.acceptsMidTurnSteering, false, 'this test must exercise the LIVE branch');
  const unhandled = captureUnhandled();

  // A rewind is rewriting this session's jsonl, so prompt() refuses — the real
  // Instance guard, not a stub.
  inst._mutating = true;
  const t0 = Date.now();
  await assert.rejects(
    () => send(inst, 'DOOMED', { wait: true, waitTimeoutMs: 120 }),
    /being rewritten/,
    'the delivery failure surfaces, unchanged',
  );
  inst._mutating = false;

  // Wait past the abandoned waiter's whole budget so its timer really fires.
  await new Promise(r => setTimeout(r, 260));
  await settleUnhandled();
  assert.ok(Date.now() - t0 > 120, 'slept past waitTimeoutMs — the orphan had time to reject');

  // FORCING MECHANISM, asserted rather than assumed. Three things could settle
  // the waiter early and mask the orphan; none of them may have happened.
  const users = userLinesIn(await stdinLines());
  assert.equal(users.filter(l => textsOf(l).includes('DOOMED')).length, 0,
    'prompt() threw before _sendRaw — the fake CLI was never given anything to answer');
  assert.equal(evs.filter(e => e?.kind === 'turn_end').length, 0,
    'no turn_end arrived — nothing resolved the waiter');
  assert.ok(inst.proc && inst.status !== 'exited' && inst.status !== 'crashed',
    'the instance stayed live — no exit/crash rejected the waiter into an owned handler');

  assert.deepEqual(unhandled.map(e => e.message), [],
    'the waiter was owned even though nobody awaited its value');
});

test('live wait:true that times out rejects with the documented error, not on the send resolving', async () => {
  const inst = await setupWorker();
  const evs = collect(inst);
  assert.notEqual(inst.status, 'turn');
  assert.notEqual(inst.acceptsMidTurnSteering, false, 'this test must exercise the LIVE branch');

  // Raced rather than awaited bare, so a mutant that leaves the call pending
  // forever fails in ~400 ms instead of hitting the runner's file timeout.
  const call = send(inst, 'UNANSWERED', { wait: true, waitTimeoutMs: 120 });
  const outcome = await Promise.race([
    call.then(v => ({ resolved: v }), e => ({ err: e })),
    new Promise(r => setTimeout(() => r({ pending: true }), 400)),
  ]);
  assert.ok(outcome.err, `the call must reject, got ${JSON.stringify(outcome)}`);
  assert.match(outcome.err.message, /wait timed out after 120 ms/);

  // FORCING MECHANISM, asserted: the send really did reach the CLI (so this is a
  // genuine no-answer timeout, not a delivery failure), and the harness never
  // answered it (so nothing could have settled the waiter for the wrong reason).
  const users = userLinesIn(await stdinLines());
  assert.equal(users.filter(l => textsOf(l).includes('UNANSWERED')).length, 1,
    'the prompt was delivered — prompt() resolved');
  assert.equal(evs.filter(e => e?.kind === 'turn_end').length, 0,
    'the fake CLI never answered — scenario-no-turn declares no turns');
  assert.equal(inst.status, 'turn', 'the turn is still open past the expired budget');
});
