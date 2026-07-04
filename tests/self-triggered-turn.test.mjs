// Tests for self-triggered-turn status tracking (see src/instances.js message_start branch).
//
// An instance's status flips to `turn` on the prompt-send path (prompt() →
// _setStatus('turn')). But a turn the CLI starts on its own — e.g. a
// ScheduleWakeup fire re-invoking the turn internally, where code-conductor
// never writes to stdin — never hits that path. The fix keys the idle→turn flip
// off the first `message_start` on the event stream instead, so self-triggered
// turns register as active while still returning to idle on turn_end.
//
// Tests drive the stream deterministically by injecting synthetic lines via
// inst._handleStdoutLine() (same technique as drain-window.test.mjs) — no
// subprocess timing dependency and no prompt() call.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-basic.json');

let ctx, baseUrl, instances, home;

before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  ctx.projectsRoot = r.projectsRoot;
  ctx.claudeProjectsRoot = r.claudeProjectsRoot;
});
afterEach(async () => {
  await instances.shutdown();
  await rmrf(home);
});

async function setupInstance() {
  await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'demo', mode: 'bypassPermissions' });
  assert.equal(r.status, 201);
  const inst = instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  return { id: r.body.id, inst };
}

// A usage-bearing message_start — the shape the real Anthropic stream emits at
// the start of each agent-loop step (Parser only surfaces message_start when a
// usage payload is present).
function injectMessageStart(inst, id = 'msg_wake') {
  inst._handleStdoutLine(JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: { id, role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: 1 } },
    },
  }));
}

function injectResult(inst) {
  inst._handleStdoutLine(JSON.stringify({
    type: 'result',
    subtype: 'success',
    stop_reason: 'end_turn',
    duration_ms: 10,
    total_cost_usd: 0.0001,
    is_error: false,
    usage: { input_tokens: 10, output_tokens: 5 },
  }));
}

test('self-triggered turn (message_start with no prompt) flips idle→turn', async () => {
  const { inst } = await setupInstance();
  assert.equal(inst.status, 'idle', 'starts idle after spawn');

  // Simulate a ScheduleWakeup fire: the CLI begins a turn on its own, no
  // prompt() sent over stdin.
  injectMessageStart(inst);
  assert.equal(inst.status, 'turn', 'idle→turn on the stream message_start');
});

test('turn_end returns a self-triggered turn to idle', async () => {
  const { inst } = await setupInstance();

  injectMessageStart(inst);
  assert.equal(inst.status, 'turn');

  injectResult(inst);
  assert.equal(inst.status, 'idle', 'turn_end restores idle after a self-triggered turn');
});

test('multiple message_start events within a turn are idempotent (stay turn)', async () => {
  const { inst } = await setupInstance();

  injectMessageStart(inst, 'msg_step1');
  injectMessageStart(inst, 'msg_step2'); // next agent-loop step
  assert.equal(inst.status, 'turn', 'repeated message_start is a no-op while already turn');

  injectResult(inst);
  assert.equal(inst.status, 'idle');
});

test('regression: system/init while idle does NOT flip to turn (flip keys off message_start, not init)', async () => {
  const { inst } = await setupInstance();
  assert.equal(inst.status, 'idle');

  // A stray/model-switch/spawn-style init must never mark an idle instance as turn —
  // that would fight the post-abort drain window, which triggers on system/init.
  inst._handleStdoutLine(JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: inst.sessionId,
    cwd: inst.cwd,
    model: 'claude-sonnet-4-6',
    permissionMode: inst.mode,
    tools: [],
  }));
  assert.equal(inst.status, 'idle', 'system/init leaves an idle instance idle');
});
