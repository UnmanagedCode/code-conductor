// Card 2026-0230 — the BOUNDED terminal outcome for an armed soft interrupt.
//
// The resume-restart drain arms a soft stop and then waits for all-idle; step 3
// never forces. That is fine while every arm eventually discharges — but a
// gateway that frames a whole turn as ONE never-closed block (residual R2) gives
// the arm no boundary to land on, and a wedged tool gives it none either. The
// drain then waits forever with nobody to escalate: there is no human behind it.
//
// So the three automatic callers now pass `{ deadlineMs }`. On expiry the arm
// escalates to the FORCED tier and annotates WHY the boundary was never reached
// (the held block keys and unreturned toolUseIds), which is the instrument that
// turns a silent run-to-completion into a one-line diagnosis. Manual ⏸ keeps
// today's unbounded semantics — a human already has ⏹.
//
// The deadline comes from a module constant with an ORCH_* env seam
// (softInterruptDeadlineMs, the ORCH_OVERAGE_RESUME_BUFFER_MS idiom), so this
// test never sleeps out a real clock.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { drainToManifest } from '../src/resumeRestart.ts';
import { clearResumeManifest } from '../src/resumeManifest.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// R2-shaped: one gateway-framed block for the whole turn, never closed, so the
// armed soft stop has no boundary to discharge at — ever.
const LATCHED = path.join(__dirname, 'fixtures', 'scenario-gateway-unclosed-block.json');

let ctx, instances, home, transcript;
const saved = {};

before(async () => {
  ctx = await bootServer({ scenarioPath: LATCHED });
  ({ instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  ctx.projectsRoot = r.projectsRoot;
  ctx.claudeProjectsRoot = r.claudeProjectsRoot;
  transcript = path.join(os.tmpdir(), `cc-drainbackstop-${randomUUID()}.jsonl`);
  saved.transcript = process.env.FAKE_CLAUDE_TRANSCRIPT;
  saved.deadline = process.env.ORCH_SOFT_INTERRUPT_DEADLINE_MS;
  process.env.FAKE_CLAUDE_TRANSCRIPT = transcript;
});
afterEach(async () => {
  await instances.shutdown();
  clearResumeManifest();
  if (saved.transcript === undefined) delete process.env.FAKE_CLAUDE_TRANSCRIPT;
  else process.env.FAKE_CLAUDE_TRANSCRIPT = saved.transcript;
  if (saved.deadline === undefined) delete process.env.ORCH_SOFT_INTERRUPT_DEADLINE_MS;
  else process.env.ORCH_SOFT_INTERRUPT_DEADLINE_MS = saved.deadline;
  await fs.rm(transcript, { force: true });
  await rmrf(home);
});

const QUIET = { warn() {}, log() {}, error() {} };

async function stdinLines() {
  try {
    return (await fs.readFile(transcript, 'utf8'))
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}
const interruptsIn = (lines) => lines.filter(
  l => l.type === 'control_request' && l.request?.subtype === 'interrupt');

// A worker on a substitution backend, held mid-turn inside a block that will
// never close.
async function latchedMidTurn() {
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });
  const inst = await instances.create({
    project: 'demo', mode: 'bypassPermissions', backend: 'ollama', model: 'gemma4:cloud',
  });
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  const evs = [];
  inst.on('event', (ev) => evs.push(ev));
  inst.prompt('gw-text');
  await waitFor(() => evs.some(e => e.kind === 'text_delta'));
  assert.equal(inst.status, 'turn');
  assert.equal(inst._quiescence.empty, false, 'a block is open and its close never comes');
  return { inst, evs };
}

// The whole point: run the drain under a hard ceiling so an unbounded arm FAILS
// the test instead of hanging the runner.
function withCeiling(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: still waiting after ${ms}ms`)), ms).unref()),
  ]);
}

// INVARIANT: drainToManifest returns even when the stop it armed can never reach
// a block boundary — via the deadline's escalation to the forced tier — and says
// in the transcript why. Unfixed (`interrupt()` with no deadline): the arm never
// discharges, step 3's `while (timedOut)` loop waits forever, and this test fails
// on the ceiling rather than hanging.
test('drain backstop: an undischargeable soft stop escalates on its deadline and the drain returns', async () => {
  process.env.ORCH_SOFT_INTERRUPT_DEADLINE_MS = '150';
  const { inst, evs } = await latchedMidTurn();

  await withCeiling(
    drainToManifest({ server: null, wss: null, instances, log: QUIET, graceMs: 3000 }),
    8000, 'drainToManifest',
  );

  assert.equal(inst.status, 'idle', 'the session was actually stopped');
  assert.equal(inst.turnForceAborted, true, 'the soft arm latched; only the forced tier ended it');

  const stderr = evs.filter(e => e.kind === 'system' && e.subtype === 'stderr');
  const line = stderr.map(e => e.data?.line ?? '').find(l => /interrupt deadline/.test(l));
  assert.ok(line, `a diagnostic annotation was emitted (saw: ${JSON.stringify(stderr)})`);
  assert.match(line, /150ms/, 'names the deadline that elapsed');
  assert.match(line, /msg_gw1:0:text/, 'names the block key that withheld the boundary');
  assert.match(line, /tools still unreturned: \[\]/, 'and that no tool was to blame');

  const interrupts = interruptsIn(await stdinLines());
  assert.equal(interrupts.length, 1, 'exactly one interrupt reached the CLI — the escalated one');
});

// The deadline is a BACKSTOP, not the mechanism: a stop that discharges normally
// must fire on its own boundary and leave nothing behind to escalate. Pinned
// because a deadline that fires anyway would turn every drain into a forced
// abort, discarding exactly the partial work the soft tier exists to preserve.
test('drain backstop: a stop that discharges normally is never escalated', async () => {
  process.env.ORCH_SOFT_INTERRUPT_DEADLINE_MS = '150';
  const { inst, evs } = await latchedMidTurn();

  // A second block key arrives ⇒ the arm has a boundary after all. Drive it
  // BEFORE the drain so the soft fire happens first.
  await inst.interrupt();
  assert.equal(inst._interruptFired, false);
  inst._handleStdoutLine(JSON.stringify(
    { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { text: '' } } }));
  inst._handleStdoutLine(JSON.stringify(
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'x' } } }));
  assert.equal(inst._interruptFired, true, 'the soft tier discharged');
  await waitFor(() => inst.status === 'idle');

  await withCeiling(
    drainToManifest({ server: null, wss: null, instances, log: QUIET, graceMs: 500 }),
    8000, 'drainToManifest',
  );

  assert.equal(inst.turnForceAborted, false, 'never escalated');
  assert.equal(evs.filter(e => e.kind === 'system' && e.subtype === 'stderr'
    && /interrupt deadline/.test(e.data?.line ?? '')).length, 0, 'no deadline annotation');
  assert.equal(interruptsIn(await stdinLines()).length, 1, 'the soft stop only');
});
