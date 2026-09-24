// awaitingUser on a live, hand-spawned session (bootServer + the fake CLI):
// what sets it, what clears it, what must NOT clear it, that a conducted worker
// never carries it, that a resume hydrates it from the transcript and the
// history replay does not wipe it, and that every surface reports it.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor, seedSessionJsonl, instForSession } from './helpers.mjs';
import { localPlace } from '../src/projects.ts';
import { sendPrompt } from '../src/mcp/handlers.ts';
import { markPlainStub } from '../public/wakeCallback.js';
import { buildRenewSeed } from '../public/renewSeed.js';
import { RESUME_TEXT, buildConductorResumeText } from '../src/resumeRestart.ts';
import { buildRenewRequest } from '../src/sessionRenew.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fx = (f) => path.join(__dirname, 'fixtures', f);
const TEXT_ASK = fx('scenario-text-ask.json');
const TEXT_ASK_RECONCILED = fx('scenario-text-ask-reconciled.json');
const TEXT_NO_ASK = fx('scenario-text-no-ask.json');
const Q_STREAM = fx('scenario-canusetool-question.json');
const Q_RECONCILED = fx('scenario-ask-user-question-inline-reconciled.json');
const PLAN_STREAM = fx('scenario-exit-plan-inline.json');
const PLAN_RECONCILED = fx('scenario-exit-plan-inline-reconciled.json');

let ctx;
before(async () => { ctx = await bootServer({ scenarioPath: TEXT_ASK }); });
after(async () => { await ctx.close(); });
afterEach(async () => { await ctx.instances.shutdown(); });

let n = 0;
const ask = (inst) => [inst.summary().awaitingUser, inst.summary().awaitingUserSource];

async function spawnHand(scenario, extra = {}) {
  const project = `au-live-${++n}`;
  process.env.FAKE_CLAUDE_SCENARIO = scenario;
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: project });
  const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions', temp: false, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inst = ctx.instances.get(r.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId);
  return inst;
}

// Every awaitingUser value the instance ever broadcast — "never set" is a claim
// about the whole run, not the end state.
function watchAsks(inst) {
  const seen = [];
  const on = (s) => { if (s.id === inst.id) seen.push(s.awaitingUser); };
  ctx.instances.on('status', on);
  return { seen, stop: () => ctx.instances.off('status', on) };
}

async function turn(inst, text) {
  await inst.prompt(text);
  await waitFor(() => inst.status === 'idle');
}

async function askedWithText() {
  const inst = await spawnHand(TEXT_ASK);
  await turn(inst, 'do the first pass');
  assert.deepEqual(ask(inst), ['question', 'text'], 'premise: the turn ended asking');
  return inst;
}

function wsClient(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const messages = [];
    ws.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString())); } catch { /* not JSON */ } });
    ws.once('open', () => resolve({
      send(obj) { ws.send(JSON.stringify(obj)); },
      wait(p) { return waitFor(() => messages.find(p)); },
      close() { return new Promise(r => { ws.once('close', r); ws.close(); }); },
    }));
  });
}

async function wsPrompt(inst, text) {
  const c = await wsClient(ctx.wsUrl);
  try {
    c.send({ t: 'prompt', id: inst.id, text, reqId: 'r1' });
    await c.wait(m => m.t === 'ack' || m.reqId === 'r1');
  } finally { await c.close(); }
}

async function mcpText(name, args) {
  const res = await fetch(ctx.baseUrl + '/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  assert.ok(body.result, JSON.stringify(body));
  return body.result.content[0].text;
}

// ── What sets it ─────────────────────────────────────────────────────────

test('sets: a tool ask from either arm, a text ask from either arm; a plain ending sets nothing', async (t) => {
  for (const [label, scenario, want] of [
    ['streamed AskUserQuestion', Q_STREAM, ['question', 'tool']],
    ['reconciled-only AskUserQuestion', Q_RECONCILED, ['question', 'tool']],
    ['streamed ExitPlanMode', PLAN_STREAM, ['plan', 'tool']],
    ['reconciled-only ExitPlanMode', PLAN_RECONCILED, ['plan', 'tool']],
    ['text ask, streamed deltas', TEXT_ASK, ['question', 'text']],
    ['text ask, envelope only', TEXT_ASK_RECONCILED, ['question', 'text']],
    ['no ask', TEXT_NO_ASK, [null, null]],
  ]) {
    await t.test(label, async () => {
      const inst = await spawnHand(scenario);
      await turn(inst, 'go');
      assert.deepEqual(ask(inst), want);
    });
  }
});

test('sets nothing, ever: a plan the server auto-approves (both arms)', async (t) => {
  for (const [label, scenario] of [['streamed', PLAN_STREAM], ['reconciled-only', PLAN_RECONCILED]]) {
    await t.test(label, async () => {
      const inst = await spawnHand(scenario, { mode: 'plan', autoApprovePlan: true });
      const w = watchAsks(inst);
      try {
        await inst.prompt('plan it');
        // The streamed arm's plan_request is what the gate annotates; the
        // reconciled-only envelope carries the ExitPlanMode with no such event.
        await waitFor(() => inst.ringSnapshot().some(e =>
          (e.kind === 'plan_request' && e.autoApproved)
          || (e.kind === 'assistant_message' && e.message?.content?.some(b => b.name === 'ExitPlanMode'))));
        // Streamed: the approval opens a turn the one-turn fixture never ends.
        await waitFor(() => inst.status === 'idle' || inst.ringSnapshot().some(e => e.kind === 'plan_request'));
        assert.ok(!w.seen.includes('plan'), `awaitingUser was never 'plan' (saw ${JSON.stringify(w.seen)})`);
        assert.equal(ask(inst)[0], null);
      } finally { w.stop(); }
    });
  }
});

test('a conducted worker never carries the flag', async () => {
  const project = `au-live-${++n}`;
  process.env.FAKE_CLAUDE_SCENARIO = Q_STREAM;
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: project });
  const inst = await ctx.instances.create({ project, mode: 'bypassPermissions', conducted: true });
  await waitFor(() => inst.status === 'idle');
  const w = watchAsks(inst);
  try {
    await inst.prompt('ask me');
    await waitFor(() => inst.ringSnapshot().some(e => e.kind === 'user_question'));
    await waitFor(() => inst.status === 'idle');
    assert.deepEqual(ask(inst), [null, null]);
    assert.ok(w.seen.every(v => v == null), 'and it never broadcast one');
  } finally { w.stop(); }
});

// ── What clears it, and what must not ────────────────────────────────────

test('clears: a WS prompt frame (the composer and both answer cards)', async () => {
  const inst = await askedWithText();
  await wsPrompt(inst, 'yes, continue');
  await waitFor(() => ask(inst)[0] === null);
});

test('clears — the stated limit: a plain MCP send_prompt reads as a real user message', async () => {
  const inst = await askedWithText();
  const driver = await spawnHand(TEXT_NO_ASK);
  const r = await sendPrompt({ sessionId: inst.sessionId, text: 'yes' }, { instances: ctx.instances, callerId: driver.sessionId });
  assert.notEqual(r?.ok, false, JSON.stringify(r));
  await waitFor(() => ask(inst)[0] === null);
});

test('does NOT clear: every server-injected turn delivered to the session', async (t) => {
  const cases = {
    // Instance.prompt is the one path each of these reaches the session by —
    // the idle hub (wake / heartbeat), SessionRenewController (reseed),
    // resumeRestart (restart notice) and renew_session's request.
    // deliver(caller, target): the CALLER (our session) is the one woken.
    'wake callback': (inst, driver) => ctx.instances._idleHub.deliver(inst.id, driver.id, {}),
    'heartbeat': (inst, driver) => ctx.instances._idleHub.deliver(inst.id, driver.id, { timedOut: true }),
    'plain wake stub': (inst) => inst.prompt(markPlainStub('session x was INTERRUPTED'), [], { internal: true }),
    'renew reseed': (inst) => inst.prompt(buildRenewSeed({ summary: '## Live work roster\n- none', stateBlock: 'state' }), [], { internal: true }),
    'renew request': (inst) => inst.prompt(buildRenewRequest()),
    'restart notice': (inst) => inst.prompt(RESUME_TEXT),
    'conductor restart notice': (inst) => inst.prompt(buildConductorResumeText([])),
    'forwarded output (send_prompt forward)': async (inst, driver) => {
      const r = await sendPrompt({ sessionId: inst.sessionId, text: 'review it', forward: { sessionId: driver.sessionId } },
        { instances: ctx.instances, callerId: driver.sessionId });
      assert.notEqual(r?.ok, false, JSON.stringify(r));
    },
    'setEffort': (inst) => inst.setEffort('high'),
  };
  for (const [label, deliver] of Object.entries(cases)) {
    await t.test(label, async () => {
      const inst = await askedWithText();
      const driver = await spawnHand(TEXT_NO_ASK);
      await turn(driver, 'produce output'); // something forwardable
      const echoes = inst.ringSnapshot().filter(e => e.kind === 'user_echo').length;
      await deliver(inst, driver);
      await waitFor(() => inst.ringSnapshot().filter(e => e.kind === 'user_echo').length > echoes);
      await waitFor(() => inst.status === 'idle');
      assert.deepEqual(ask(inst), ['question', 'text'], `${label} must leave the ask in place`);
    });
  }
});

// ── Hydrate at resume, and the replay does not wipe it ───────────────────

test('a resume hydrates the ask from the transcript, and the history replay does not clear it', async (t) => {
  for (const [label, records, want] of [
    ['text ask', [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'real prompt' }] } },
      { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Which option?' }], stop_reason: 'end_turn' } },
    ], ['question', 'text']],
    ['tool ask', [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'real prompt' }] } },
      { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'tq', name: 'AskUserQuestion', input: { questions: [{ question: 'q' }] } }], stop_reason: 'tool_use' } },
    ], ['question', 'tool']],
  ]) {
    await t.test(label, async () => {
      const project = `au-live-${++n}`;
      process.env.FAKE_CLAUDE_SCENARIO = TEXT_NO_ASK;
      await api(ctx.baseUrl, 'POST', '/api/projects', { name: project });
      const sid = `cc00dd11-0000-4000-8000-${String(n).padStart(12, '0')}`;
      await seedSessionJsonl(localPlace(path.join(ctx.projectsRoot, project)), sid, records);
      const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions', resume: sid });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const inst = ctx.instances.get(r.body.id);
      await waitFor(() => inst.ringSnapshot().some(e => e.kind === 'system' && e.subtype === 'history_replayed'));
      await waitFor(() => inst.status === 'idle');
      assert.ok(inst.ringSnapshot().some(e => e.kind === 'user_echo' && e.text === 'real prompt'),
        'premise: the replay re-emitted the real user prompt that precedes the ask');
      assert.deepEqual(ask(inst), want);
      await wsPrompt(inst, 'answer');
      await waitFor(() => ask(inst)[0] === null);
    });
  }
});

// ── Surfaces ──────────────────────────────────────────────────────────────

test('surfaces: GET /api/instances, GET /api/projects/:name/sessions, and the list_sessions / describe_session text', async () => {
  const inst = await askedWithText();
  const rows = (await api(ctx.baseUrl, 'GET', '/api/instances')).body;
  const row = rows.find(r => r.id === inst.id);
  assert.equal(row.awaitingUser, 'question');
  assert.equal(row.awaitingUserSource, 'text');
  assert.equal(row.ownerSessionId, null, 'a hand-spawned session has no owner');

  // An inactive row: a seeded transcript no process is attached to.
  const sid = `ee00ff11-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  await seedSessionJsonl(localPlace(path.join(ctx.projectsRoot, inst.project)), sid, [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'tp', name: 'ExitPlanMode', input: { plan: 'p' } }], stop_reason: 'tool_use' } },
  ]);
  const sessions = (await api(ctx.baseUrl, 'GET', `/api/projects/${inst.project}/sessions`)).body;
  const disk = (Array.isArray(sessions) ? sessions : sessions.sessions).find(s => s.sessionId === sid);
  assert.equal(disk.awaitingUser, 'plan');
  assert.equal(disk.awaitingUserSource, 'tool');
  assert.ok(!('ownerSessionId' in disk));

  const listed = await mcpText('list_sessions', { project: inst.project });
  const liveBlock = listed.slice(listed.indexOf(`LIVE ${inst.sessionId}`));
  assert.match(liveBlock.split('\n\n')[0], /flags .*awaiting-user question {2}awaiting-user-via text/);
  const inactiveLine = listed.split('\n').find(l => l.trim().startsWith(sid));
  assert.match(inactiveLine, /awaiting-user plan,awaiting-user-via tool/);

  assert.match(await mcpText('describe_session', { sessionId: inst.sessionId }), /awaiting-user question/);
  assert.match(await mcpText('describe_session', { sessionId: sid }), /awaiting-user plan/);
  assert.equal(instForSession(ctx.instances, inst.sessionId), inst);
});
