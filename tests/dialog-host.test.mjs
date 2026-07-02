import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_CUT_PLAN = path.join(__dirname, 'fixtures', 'scenario-canusetool-plan.json');
const SCENARIO_CUT_QUESTION = path.join(__dirname, 'fixtures', 'scenario-canusetool-question.json');

function wsClient(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const messages = [];
    ws.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString())); } catch {} });
    ws.once('open', () => resolve({
      ws, messages,
      send(obj) { ws.send(JSON.stringify(obj)); },
      close() { return new Promise(r => { ws.once('close', r); ws.close(); }); },
      wait(p, timeout = 4000) { return waitFor(() => messages.find(p), { timeout }); },
    }));
  });
}

async function readTranscript(p) {
  await waitFor(async () => { try { await fsp.stat(p); return true; } catch { return false; } });
  return (await fsp.readFile(p, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// Mechanism (CLI >= 2.1.x + --permission-prompt-tool stdio): the CLI
// routes ExitPlanMode / AskUserQuestion permission prompts to us as
// `can_use_tool` control_requests. We answer `deny`, which ends the turn — so
// the plan_request / user_question card (from the tool-use) surfaces and the
// existing approve_plan / next-prompt drive-forward path is unchanged. A held
// (in-turn) answer would break the conductor's subscribe_to_idle→turn_end wake.
test('can_use_tool(ExitPlanMode): denied with awaiting-input message, plan_request surfaces, turn ends', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_CUT_PLAN });
  try {
    const transcriptPath = `${ctx.tmpHome}/transcript.log`;
    process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;

    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'cut1' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'cut1', mode: 'plan' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const c = await wsClient(ctx.wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');
    c.send({ t: 'prompt', id, text: 'plan something' });

    const planEv = await c.wait(m => m.t === 'event' && m.ev.kind === 'plan_request');
    assert.equal(planEv.ev.toolUseId, 'tu_exit');
    assert.match(planEv.ev.plan, /# Plan/);

    // The turn only reaches turn_end because the fake CLI emitted `result` in
    // response to our deny control_response — proving we answered can_use_tool.
    const turn = await c.wait(m => m.t === 'event' && m.ev.kind === 'turn_end');
    assert.equal(turn.ev.stopReason, 'end_turn');

    const lines = await readTranscript(transcriptPath);
    const resp = lines.find(l => l.type === 'control_response'
      && l.response?.request_id === 'ct_exit'
      && l.response?.response?.behavior === 'deny');
    assert.ok(resp, `deny control_response must be sent for ExitPlanMode; transcript: ${JSON.stringify(lines)}`);
    assert.match(resp.response.response.message ?? '', /Awaiting user input/);

    await c.close();
  } finally {
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    await ctx.close();
  }
});

test('can_use_tool(AskUserQuestion): denied, user_question surfaces, turn ends', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO_CUT_QUESTION });
  try {
    const transcriptPath = `${ctx.tmpHome}/transcript.log`;
    process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;

    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'cut2' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'cut2', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const c = await wsClient(ctx.wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');
    c.send({ t: 'prompt', id, text: 'ask me something' });

    const uq = await c.wait(m => m.t === 'event' && m.ev.kind === 'user_question');
    assert.equal(uq.ev.toolUseId, 'tu_q');
    assert.equal(uq.ev.questions[0].question, 'Pick a fruit');

    const turn = await c.wait(m => m.t === 'event' && m.ev.kind === 'turn_end');
    assert.equal(turn.ev.stopReason, 'end_turn');

    const lines = await readTranscript(transcriptPath);
    const resp = lines.find(l => l.type === 'control_response'
      && l.response?.request_id === 'ct_q'
      && l.response?.response?.behavior === 'deny');
    assert.ok(resp, `deny control_response must be sent for AskUserQuestion; transcript: ${JSON.stringify(lines)}`);

    await c.close();
  } finally {
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    await ctx.close();
  }
});
