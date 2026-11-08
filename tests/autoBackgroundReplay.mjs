// Shared rig for the auto-background-replay-*.test.mjs files (one file per
// cell: each takes most of the runner's per-file limit). Replays a real captured
// CLI stream (tests/fixtures/auto-background/<cell>.stdout.ndjson, see its
// README.md) as a worker's CLI through cc's real Instance and
// IdleSubscriptionHub, and records what cc observes:
//   - log: every non-delta worker event and every worker `status` edge, each
//     with a snapshot of status / displayStatus / agent count / armed wake;
//   - every hub.deliver to the worker's owner (src 'WAKE'), with its opts and
//     how many task_notifications the worker had emitted by then.
// The owner is the ordinary in-process fake; it dispatches with send_prompt, so
// the wake is armed exactly as in production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession } from './helpers.mjs';
import { InProcessClaudeLauncher } from './inProcessLauncher.mjs';
import { ReplayLauncher } from './replayLauncher.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(HERE, 'fixtures', 'scenario-ws.json');
export const fixture = (cell) => path.join(HERE, 'fixtures', 'auto-background', `${cell}.stdout.ndjson`);
// IDLE_DRAIN_SETTLE_MS (5 s) plus margin: lets a settle wake fire if one is owed.
export const SETTLE_WAIT_MS = 5800;

let rpcId = 1;
async function callTool(baseUrl, name, args, caller) {
  const res = await fetch(`${baseUrl}/mcp${caller ? `/${encodeURIComponent(caller)}` : ''}?format=text`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body.result, `tools/call ${name}: ${JSON.stringify(body)}`);
  return JSON.parse(body.result.content[0].text);
}

// The prompt the capture's CLI was first sent.
export const firstPrompt = (cell) => fs.readFileSync(fixture(cell), 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).find((o) => o.stdin_sent !== undefined).stdin_sent;

export const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export const turnEnded = (c) => waitFor(() => c.log.some((e) => e.what.startsWith('turn_end')), { timeout: 20000 });

// Runs one cell; `script(ctx)` drives the cc side. Returns
// { wakes, log, final } once the script resolves.
export async function replayCell(cell, script) {
  const launcher = new ReplayLauncher(new InProcessClaudeLauncher());
  const srv = await bootServer({ scenarioPath: SCENARIO_WS, claudeLauncher: launcher });
  const { instances, baseUrl } = srv;
  const hub = instances._idleHub;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
    const spawn = async (replay) => {
      const prev = process.env.CC_TEST_REPLAY_CAPTURE;
      if (replay) process.env.CC_TEST_REPLAY_CAPTURE = replay; else delete process.env.CC_TEST_REPLAY_CAPTURE;
      try {
        const r = await callTool(baseUrl, 'spawn_instance', { project: 'p', mode: 'bypassPermissions' });
        await waitFor(() => instForSession(instances, r.sessionId)?.status === 'idle');
        return r.sessionId;
      } finally { if (prev === undefined) delete process.env.CC_TEST_REPLAY_CAPTURE; else process.env.CC_TEST_REPLAY_CAPTURE = prev; }
    };
    const ownerSid = await spawn(null);
    const workerSid = await spawn(fixture(cell));
    const owner = instForSession(instances, ownerSid);
    const worker = instForSession(instances, workerSid);
    const child = launcher.children.at(-1);

    const log = [];
    let taskNotifications = 0;
    const snap = () => ({
      status: worker.status, display: worker.summary().displayStatus,
      activeAgentTasks: worker.activeAgentTaskCount, wakeArmed: hub.hasArmedWake(worker.id),
    });
    const SKIP = new Set(['text_delta', 'text_end', 'thinking_start', 'thinking_delta', 'thinking_end', 'tool_use_start', 'usage', 'rate_limit']);
    instances.on('event', ({ id, ev, replayed }) => {
      if (id !== worker.id || replayed || !ev || SKIP.has(ev.kind)) return;
      if (ev.kind === 'system' && ev.subtype === 'task_notification') taskNotifications++;
      const what = ev.kind + (ev.subtype ? `/${ev.subtype}` : '');
      log.push({ src: 'event', what, taskType: ev.data?.task_type ?? null, ...snap() });
    });
    worker.on('status', (s) => log.push({ src: 'status-edge', what: 'summary emitted', ...snap(), summary: s }));
    const realDeliver = hub.deliver.bind(hub);
    hub.deliver = (callerId, tid, opts) => {
      if (tid === worker.id) {
        log.push({ src: 'WAKE', what: 'deliver', opts: { timedOut: !!opts?.timedOut, exited: !!opts?.exited }, taskNotificationsSeen: taskNotifications, ...snap() });
      }
      return realDeliver(callerId, tid, opts);
    };

    const ctx = {
      instances, owner, worker, child, log, hub,
      dispatch: (text) => callTool(baseUrl, 'send_prompt', { sessionId: workerSid, text }, ownerSid),
      idle: () => waitFor(() => worker.status === 'idle', { timeout: 20000 }),
      gone: () => waitFor(() => ['exited', 'crashed'].includes(worker.status) || !instances.get(worker.id), { timeout: 20000 }),
      replayDone: () => child.done,
    };
    await script(ctx);

    const final = { ...snap(), armedAfter: hub.hasArmedWake(worker.id), lastExit: worker.lastExit ?? null };
    return { wakes: log.filter((e) => e.src === 'WAKE'), log, final };
  } finally { await srv.close(); }
}
