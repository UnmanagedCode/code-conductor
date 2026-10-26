// Shared harness for the prompt-authorship suite: who wrote a prompt into a
// CONDUCTED worker, and what its conductor is told about a human-started turn.
//
//   prompt-author-parse        the persisted marker block, read back on replay
//   prompt-author-paths        which send surface writes which author
//   prompt-author-steer        mid-turn steers and coalesced deliveries
//   idle-wake-human-author     the human notice on the owner's wake
//   mcp-human-prompts-field    send-time `humanPrompts` on the four send tools
//   mcp-recent-prompted-by     get_recent_messages' `promptedBy`
//
// Builds on ./idleWakeCase.mjs (one server per file, a fresh projects root per
// test, the MCP transport). Every fixture puts a CONDUCTED worker W (spawned by
// conductor C over MCP) beside a hand-spawned instance H (REST), so a test can
// tell the conducted-only gate from authorship itself.
//
// Not named `*.test.mjs`, so run.mjs's discover() ignores it.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { api, waitFor, instForSession, userStdinLines } from './helpers.mjs';
import { ctx, callTool, unwrap } from './idleWakeCase.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Text-filtered turns first (OPENTURN, SLOWTURN, LONGTURN, ASKTURN, and ABSORB —
// an empty turn that swallows a mid-turn steer the way the real CLI folds it into
// the running turn), then generic turns with distinct msgIds.
export const SCENARIO_WORKER = path.join(__dirname, 'fixtures', 'scenario-prompt-author-worker.json');
// Generic turns only: the conductor's prompts are wake stubs that quote the
// worker's prompts, and a quoted filter token must not match a worker-only turn.
export const SCENARIO_CONDUCTOR = path.join(__dirname, 'fixtures', 'scenario-prompt-author-conductor.json');

// The wire literals, written out: they are the protocol, not an import.
export const HUMAN_MARK = '[[cc:author:human]]';
export const CONDUCTOR_MARK = '[[cc:author:conductor]]';
export const HUMAN_NOTICE_LEAD = 'The user prompted this worker directly';

async function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  try { return await fn(); }
  finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export async function createProject(name) {
  await api(ctx.baseUrl, 'POST', '/api/projects', { name });
}

// The conductor: MCP-spawned with no caller, its own stdin unrecorded.
export async function spawnConductor(project) {
  return withEnv({ FAKE_CLAUDE_SCENARIO: SCENARIO_CONDUCTOR, FAKE_CLAUDE_TRANSCRIPT: null }, async () => {
    const { sessionId } = unwrap(await callTool('spawn_instance', { project, mode: 'bypassPermissions' }));
    await waitFor(() => instForSession(ctx.instances, sessionId)?.status === 'idle');
    return sessionId;
  });
}

// A conducted worker spawned BY `callerSid`, recording its stdin to `transcript`;
// `extra` adds spawn_instance args (e.g. createWorktree).
export async function spawnWorker(project, callerSid, transcript, extra = {}) {
  return withEnv({ FAKE_CLAUDE_SCENARIO: SCENARIO_WORKER, FAKE_CLAUDE_TRANSCRIPT: transcript }, async () => {
    const r = unwrap(await callTool('spawn_instance',
      { project, mode: 'bypassPermissions', ...extra }, { caller: callerSid }));
    assert.ok(r.sessionId, `spawn_instance refused: ${JSON.stringify(r)}`);
    const { sessionId } = r;
    const inst = await waitFor(() => {
      const i = instForSession(ctx.instances, sessionId);
      return i?.status === 'idle' && i;
    });
    assert.equal(inst.conducted, true, 'precondition: W is a conducted worker');
    return sessionId;
  });
}

// A hand-spawned (REST) instance — never conducted.
export async function spawnHand(project, transcript) {
  return withEnv({ FAKE_CLAUDE_SCENARIO: SCENARIO_WORKER, FAKE_CLAUDE_TRANSCRIPT: transcript }, async () => {
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions' });
    assert.equal(r.status, 201);
    const inst = ctx.instances.get(r.body.id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);
    assert.equal(inst.conducted, false, 'precondition: H is not conducted');
    return inst.sessionId;
  });
}

// One `{t:'prompt'}` frame — the composer's, the plan card's and the question
// card's shared door — sent over a real socket and acked.
let nextReq = 1;
export async function wsPrompt(sessionId, text) {
  const inst = instForSession(ctx.instances, sessionId);
  const ws = new WebSocket(ctx.baseUrl.replace(/^http/, 'ws') + '/ws');
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  try {
    const reqId = `pa-${nextReq++}`;
    const ack = new Promise((resolve) => {
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.t === 'ack' && m.reqId === reqId) resolve(m);
      });
    });
    ws.send(JSON.stringify({ t: 'prompt', id: inst.id, reqId, text }));
    const m = await ack;
    assert.equal(m.ok, true, `WS prompt refused: ${m.error}`);
  } finally {
    await new Promise(r => { ws.once('close', r); ws.close(); });
  }
}

// The `type:"user"` lines a session's CLI received, oldest first.
export async function stdinUserLines(transcript) {
  try { return await userStdinLines(transcript); } catch { return []; }
}

export const textBlocks = (line) => line.message.content.filter(b => b.type === 'text').map(b => b.text);
export const lastText = (line) => textBlocks(line).at(-1);
export const lineWith = (lines, needle) => lines.find(l => textBlocks(l).some(t => t.includes(needle)));

// Every outer user_echo in a session's ring.
export const echoesOf = (sessionId) => instForSession(ctx.instances, sessionId)
  .ringSnapshot().filter(ev => ev.kind === 'user_echo' && !ev.parentToolUseId);
export const echoWith = (sessionId, needle) => echoesOf(sessionId).find(ev => ev.text.includes(needle));

// A completion wake (folded or plain) about `targetSid` in the conductor's ring.
export function wakesFor(conductorSid, targetSid) {
  return echoesOf(conductorSid).filter(ev => ev.text.startsWith('[[cc:wake-callback]]') && ev.text.includes(targetSid));
}
