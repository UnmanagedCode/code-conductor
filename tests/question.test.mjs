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

test('AskUserQuestion: turn ends cleanly (no auto-interrupt control_request, no [Request interrupted by user] marker)', async () => {
  // With the PreToolUse deny hook in place, the CLI gives the model an
  // is_error tool_result with the hook reason and the model wraps up
  // naturally — no orchestrator interrupt, no marker noise, turn_end is
  // a normal success.
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  const fsp = (await import('node:fs')).promises;
  try {
    const transcriptPath = `${ctx.tmpHome}/transcript.log`;
    process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;

    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'q' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'q', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const c = await wsClient(ctx.wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');

    c.send({ t: 'prompt', id, text: 'go' });
    await c.wait(m => m.t === 'event' && m.ev.kind === 'user_question');
    const turn = await c.wait(m => m.t === 'event' && m.ev.kind === 'turn_end');
    assert.equal(turn.ev.isError, false, 'turn ends cleanly');
    assert.equal(turn.ev.stopReason, 'end_turn');

    // No control_request interrupt should have been written.
    await waitFor(async () => { try { await fsp.stat(transcriptPath); return true; } catch { return false; } });
    const lines = (await fsp.readFile(transcriptPath, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
    const interrupt = lines.find(l => l.type === 'control_request' && l.request?.subtype === 'interrupt');
    assert.equal(interrupt, undefined, `no interrupt should be sent; transcript: ${JSON.stringify(lines)}`);

    // No `[Request interrupted by user]` text reaches the UI.
    const events = c.messages.filter(m => m.t === 'event').map(m => m.ev);
    for (const ev of events) {
      const probe = ev.text ?? ev.content ?? '';
      if (typeof probe === 'string') {
        assert.ok(!/Request interrupted by user/.test(probe), `marker leaked: ${probe}`);
      }
    }

    await c.close();
  } finally {
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    await ctx.close();
  }
});
