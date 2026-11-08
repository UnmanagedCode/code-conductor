// Shared rig for the two gated auto-background-cli*.real.test.mjs files: a
// REAL `claude` worker behind a real cc, owned by an in-process fake that
// dispatches to it with send_prompt (so the wake is armed as in production).
// The worker is told to call cc's own run_code with a program that waits
// RUN_CODE_WAIT_MS, then reply DONE.
//
// Routing: a launch whose env carries CC_TEST_REAL_WORKER goes to
// RealClaudeLauncher; every other launch (the owner) to the in-process fake.
// bootServer's in-process setup leaves CLAUDE_BIN at the bare sentinel
// `claude`, which RealClaudeLauncher resolves to the real CLI on PATH. The
// marker is set in process.env only around the worker's spawn_instance.
//
// Uses your real auth and writes the worker's session jsonl under the CLI's
// config dir; the rig deletes it afterwards (best effort).
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, instForSession } from './helpers.mjs';
import { InProcessClaudeLauncher } from './inProcessLauncher.mjs';
import { RealClaudeLauncher } from '../src/claudeLauncher.ts';
import { setAutoBackground, AUTO_BACKGROUND_MIN_MS } from '../src/appSettings.ts';
import { claudeConfigDir } from '../src/claudeConfigDir.ts';
import { encodeCwd } from '../src/projects.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_WS = path.join(HERE, 'fixtures', 'scenario-ws.json');
export const MODEL = 'claude-haiku-4-5';
export const THRESHOLD_MS = AUTO_BACKGROUND_MIN_MS;
export const RUN_CODE_WAIT_MS = 20_000;
export const PROMPT = 'Call the mcp__code-conductor__run_code tool exactly once, with this as its `code` argument:\n'
  + `await new Promise((r) => setTimeout(r, ${RUN_CODE_WAIT_MS})); return 'SLEPT';\n`
  + 'When it returns, reply with exactly the word DONE. Do nothing else.';

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

class RoutingLauncher {
  inProcess = true;
  constructor() { this.fake = new InProcessClaudeLauncher(); this.real = new RealClaudeLauncher(); }
  launch(opts) { return (opts.env?.CC_TEST_REAL_WORKER ? this.real : this.fake).launch(opts); }
}

// Runs the scenario with the toggle `enabled` or off; `done(ctx)` says when
// to stop watching. `timeout` leaves room inside the runner's per-file
// watchdog, so a regression fails as an assertion, not a kill. Returns what cc
// observed for the worker.
export async function runRealWorker({ enabled, done, timeout = 55_000 }) {
  const srv = await bootServer({ scenarioPath: SCENARIO_WS, claudeLauncher: new RoutingLauncher() });
  const { instances, baseUrl } = srv;
  const hub = instances._idleHub;
  let worker = null;
  try {
    assert.equal((await api(baseUrl, 'POST', '/api/projects', { name: 'p' })).status, 201);
    const owner = await callTool(baseUrl, 'spawn_instance', { project: 'p', mode: 'bypassPermissions' });
    await waitFor(() => instForSession(instances, owner.sessionId)?.status === 'idle');
    if (enabled) await setAutoBackground({ enabled: true, thresholdMs: THRESHOLD_MS });

    const prev = process.env.CC_TEST_REAL_WORKER;
    process.env.CC_TEST_REAL_WORKER = '1';
    let w;
    try { w = await callTool(baseUrl, 'spawn_instance', { project: 'p', mode: 'bypassPermissions', model: MODEL }); }
    finally { if (prev === undefined) delete process.env.CC_TEST_REAL_WORKER; else process.env.CC_TEST_REAL_WORKER = prev; }
    await waitFor(() => instForSession(instances, w.sessionId)?.status === 'idle', { timeout: 30_000 });
    worker = instForSession(instances, w.sessionId);

    // One ordered log: worker events (with the agent count at that moment) and wakes.
    const log = [];
    let taskNotifications = 0;
    instances.on('event', ({ id, ev, replayed }) => {
      if (id !== worker.id || replayed || !ev) return;
      if (ev.kind === 'system' && ev.subtype === 'task_notification') taskNotifications++;
      log.push({ src: 'event', ev, activeAgentTasks: worker.activeAgentTaskCount });
    });
    const realDeliver = hub.deliver.bind(hub);
    hub.deliver = (callerId, tid, opts) => {
      if (tid === worker.id) log.push({ src: 'WAKE', opts: { timedOut: !!opts?.timedOut, exited: !!opts?.exited }, taskNotificationsSeen: taskNotifications });
      return realDeliver(callerId, tid, opts);
    };

    await callTool(baseUrl, 'send_prompt', { sessionId: w.sessionId, text: PROMPT }, owner.sessionId);
    const ctx = { log, worker };
    await waitFor(() => done(ctx), { timeout, interval: 200 });
    return { log, spawnEnv: { ...worker._spawnEnv } };
  } finally {
    const argv = worker?._spawnArgv ?? [];
    const cliSid = argv[argv.indexOf('--session-id') + 1];
    const cwd = worker?.cwd;
    await srv.close();
    if (cliSid && cwd) {
      const jsonl = path.join(claudeConfigDir(), 'projects', encodeCwd(cwd), `${cliSid}.jsonl`);
      await fs.rm(jsonl, { force: true }).catch(() => {});
      await fs.rm(path.join(path.dirname(jsonl), cliSid), { recursive: true, force: true }).catch(() => {});
      // The CLI also creates an empty memory/ dir; rmdir leaves anything non-empty alone.
      await fs.rmdir(path.join(path.dirname(jsonl), 'memory')).catch(() => {});
      await fs.rmdir(path.dirname(jsonl)).catch(() => {});
    }
  }
}

export const events = (log) => log.filter((e) => e.src === 'event');
export const wakes = (log) => log.filter((e) => e.src === 'WAKE');
export const turnEnds = (log) => events(log).filter((e) => e.ev.kind === 'turn_end');
export const runCodeResult = (log) => {
  const use = events(log).find((e) => e.ev.kind === 'tool_use' && /run_code$/.test(e.ev.name ?? ''));
  if (!use) return null;
  return events(log).find((e) => e.ev.kind === 'tool_result' && e.ev.toolUseId === use.ev.toolUseId)?.ev ?? null;
};
export const resultText = (ev) => (typeof ev?.content === 'string' ? ev.content : JSON.stringify(ev?.content ?? ''));
