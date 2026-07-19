// Ollama-backed sessions are exempt from the usage-window (overage) stop/resume
// flow. A usage/rate-limit window is an Anthropic-account concept, so a session
// whose agent tree is PURELY Ollama-backed must sit entirely outside the flow —
// never auto-stopped on a trip, never queued behind the global gate, never armed
// for auto-resume, and it shows no overage badge. A tree containing ANY
// claude-backed agent (e.g. an Ollama conductor whose workers are Claude) stays
// in the flow. Exercises the backend-scoped usage-window-domain seam
// (src/usageWindowDomains.js) + the guards in instances.js.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf, fakeOllamaReachable } from './helpers.mjs';
import { setOnOverageAction } from '../src/appSettings.js';
import { getAccountUsage } from '../src/accountUsage.js';

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
// Prompt turn emits an overage trip then a RESULT (mirrors overage-action.test).
function tripScenario(resetsAt) {
  return { events: [INIT], turns: [{ on: { type: 'prompt' }, emit: [overageEvent(resetsAt), RESULT] }] };
}

async function writeScenario(obj) {
  const p = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-ollama-overage-')), 'scenario.json');
  await fs.writeFile(p, JSON.stringify(obj));
  return p;
}

let ctx, instances, home, restoreFetch;
before(async () => {
  restoreFetch = fakeOllamaReachable(); // Ollama spawn preflight sees a live daemon
  ctx = await bootServer({});
  instances = ctx.instances;
});
after(async () => { await ctx.close(); restoreFetch(); });

beforeEach(async () => {
  ({ home } = await freshProjectsRoot());
  // Reset shared global overage state so nothing leaks between tests.
  instances._clearOverage();
  instances._overageResume.clearAll();
  instances._overageResume.fetchUsage = getAccountUsage;
  instances._usageMonitor.fetchUsage = getAccountUsage;
  await setOnOverageAction('stop-resume');
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });
});
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

// create() directly (not the REST route) so we can pass callerInstanceId /
// conducted — the MCP-only fields the /api/instances route doesn't expose.
async function spawn({ scenario = HOLD, backendKind = 'claude', model, callerInstanceId, conducted } = {}) {
  process.env.FAKE_CLAUDE_SCENARIO = await writeScenario(scenario);
  const inst = await instances.create({
    project: 'demo', mode: 'bypassPermissions',
    ...(model ? { model } : {}),
    ...(backendKind === 'ollama' ? { backendKind: 'ollama' } : {}),
    ...(conducted ? { conducted: true } : {}),
    ...(callerInstanceId ? { callerInstanceId } : {}),
  });
  await waitFor(() => inst.status === 'idle');
  return inst;
}

const sysEvents = (inst) => { const evs = []; inst.on('event', e => evs.push(e)); return evs; };
const sub = (evs, subtype) => evs.filter(e => e.kind === 'system' && e.subtype === subtype);

test('_inUsageWindowFlow: a purely-Ollama session is exempt; a Claude session is in-flow', async () => {
  const claude = await spawn({});
  const ollama = await spawn({ backendKind: 'ollama', model: 'gemma4:cloud' });
  assert.equal(ollama.backendKind, 'ollama');
  assert.equal(instances._inUsageWindowFlow(claude), true);
  assert.equal(instances._inUsageWindowFlow(ollama), false);
  assert.deepEqual(instances.agentTreeBackends(ollama), new Set(['ollama']));
  assert.deepEqual(instances.usageWindowDomainsOf(ollama), new Set(['ollama']));
  assert.deepEqual(instances.usageWindowDomainsOf(claude), new Set(['anthropic']));
});

test('agent tree: an Ollama conductor with a Claude worker is in-flow; a lone Ollama leaf is not', async () => {
  const conductor = await spawn({ backendKind: 'ollama', model: 'gemma4:cloud' });
  const worker = await spawn({ conducted: true, callerInstanceId: conductor.id });
  const lone = await spawn({ backendKind: 'ollama', model: 'gemma4:cloud' });
  assert.equal(worker.backendKind, 'claude');
  assert.equal(worker.callerInstanceId, conductor.id);
  assert.deepEqual(instances.agentTreeBackends(conductor), new Set(['ollama', 'claude']));
  assert.equal(instances._inUsageWindowFlow(conductor), true, 'tree touches anthropic via the Claude worker');
  assert.equal(instances._inUsageWindowFlow(worker), true, 'the Claude worker itself is in-flow');
  assert.equal(instances._inUsageWindowFlow(lone), false, 'a childless Ollama leaf stays exempt');
});

test('global overage trip stops a mid-turn Claude session but exempts a coexisting Ollama session', async () => {
  const claude = await spawn({});
  const ollama = await spawn({ backendKind: 'ollama', model: 'gemma4:cloud' });
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
  const ollama = await spawn({ backendKind: 'ollama', model: 'gemma4:cloud' });
  claude.prompt('go');
  await waitFor(() => claude.status === 'turn');
  instances._handleOverageTrip(null, { resetsAt: nowSec() + 3600 });
  await waitFor(() => instances._overageActive === true);

  // The global gate is active, but the exempt Ollama session must NOT queue.
  await ollama.prompt('hello');
  assert.equal(ollama._overageQueue.length, 0, 'Ollama send not queued behind the gate');
  assert.equal(ollama.summary().queuedCount, 0);
});

test("an Ollama session's own rate_limit_event does not trip the global flow", async () => {
  const ollama = await spawn({ backendKind: 'ollama', model: 'gemma4:cloud', scenario: tripScenario(nowSec() + 3600) });
  const evs = sysEvents(ollama);
  ollama.prompt('go');
  // The trip event is emitted + processed, then RESULT winds the turn to idle.
  await waitFor(() => ollama.status === 'idle' && sub(evs, 'init').length > 0);

  assert.equal(instances._overageActive, false, 'Ollama trip did not flip the global flag');
  assert.equal(ollama.autoStoppedForOverage, false);
  assert.equal(ollama.autoResumeAt, null);
  assert.equal(sub(evs, 'auto_stop_overage').length, 0, 'no auto-stop notice for the exempt Ollama trip');
});
