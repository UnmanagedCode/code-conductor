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
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'q', mode: 'default' });
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
