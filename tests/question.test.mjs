import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-question.json');

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

test('AskUserQuestion: user_question UI event is emitted with parsed questions/options', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'q' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'q', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const c = await wsClient(ctx.wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');

    c.send({ t: 'prompt', id, text: 'go' });
    const uq = await c.wait(m => m.t === 'event' && m.ev.kind === 'user_question');
    assert.equal(uq.ev.toolUseId, 'tu_q');
    assert.equal(uq.ev.questions.length, 1);
    assert.equal(uq.ev.questions[0].question, 'Pick a fruit');
    assert.deepEqual(uq.ev.questions[0].options.map(o => o.label), ['Apple', 'Banana']);

    // The AskUserQuestion tool_use event still flows so the conversation
    // view can render the (now-collapsed) tool block alongside the question.
    const tu = c.messages.find(m => m.t === 'event' && m.ev.kind === 'tool_use' && m.ev.name === 'AskUserQuestion');
    assert.ok(tu, 'tool_use for AskUserQuestion still emitted');

    await c.close();
  } finally { await ctx.close(); }
});

test('AskUserQuestion: orchestrator auto-interrupts so the model cannot generate a confused follow-up', async () => {
  // Regression: without this auto-interrupt the model emits an "I see the
  // question was dismissed, want me to just ask in plain text instead?"
  // assistant message below the option card, making the question feel
  // non-blocking and the conversation feel out of sync with the UI.
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  const fsp = (await import('node:fs')).promises;
  try {
    const transcriptPath = `${ctx.tmpHome}/transcript.log`;
    process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;

    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'q' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'q', mode: 'bypassPermissions' });
    const id = r.body.id;
    const inst = ctx.instances.get(id);
    await waitFor(() => inst.status === 'idle');

    const c = await wsClient(ctx.wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');

    c.send({ t: 'prompt', id, text: 'go' });
    // user_question fires before the model can produce a follow-up
    await c.wait(m => m.t === 'event' && m.ev.kind === 'user_question');
    // turn_end arrives because the orchestrator interrupted (the fake
    // scenario only emits the result event in response to the interrupt
    // control_request — if we hadn't interrupted the turn would never end).
    const turn = await c.wait(m => m.t === 'event' && m.ev.kind === 'turn_end');
    assert.equal(turn.ev.stopReason, 'interrupted', 'turn must have been interrupted');
    await waitFor(() => inst.status === 'idle');

    // Verify the orchestrator's outbound transcript contains a
    // control_request with subtype=interrupt.
    await waitFor(async () => { try { await fsp.stat(transcriptPath); return true; } catch { return false; } });
    const lines = (await fsp.readFile(transcriptPath, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
    const interrupt = lines.find(l => l.type === 'control_request' && l.request?.subtype === 'interrupt');
    assert.ok(interrupt, `expected an interrupt control_request, transcript: ${JSON.stringify(lines)}`);

    await c.close();
  } finally {
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    await ctx.close();
  }
});
