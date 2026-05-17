import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { bootServer, api, waitFor } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUESTION_SCENARIO = path.join(__dirname, 'fixtures', 'scenario-question.json');
const QUESTION_MIXED_SCENARIO = path.join(__dirname, 'fixtures', 'scenario-question-mixed.json');
const MANUAL_SCENARIO = path.join(__dirname, 'fixtures', 'scenario-manual-interrupt.json');

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

test('auto-interrupt (AskUserQuestion flow): assistant marker stripped, synthetic user marker suppressed, turn_end non-error', async () => {
  const ctx = await bootServer({ scenarioPath: QUESTION_SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'q' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'q', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const c = await wsClient(ctx.wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');
    c.send({ t: 'prompt', id, text: 'go' });
    const turn = await c.wait(m => m.t === 'event' && m.ev.kind === 'turn_end');

    const events = c.messages.filter(m => m.t === 'event').map(m => m.ev);

    // Assistant text block with the marker → text_strip (no text_end).
    const textEnds = events.filter(e => e.kind === 'text_end');
    const textStrips = events.filter(e => e.kind === 'text_strip');
    assert.equal(textEnds.length, 0, 'no text_end carrying the marker (it was rewritten to text_strip)');
    assert.equal(textStrips.length, 1, 'exactly one text_strip delivered for the assistant-side marker');

    // Synthetic user message carrying the marker → suppressed entirely.
    const markerUserEchoes = events.filter(e => e.kind === 'user_echo' && /Request interrupted by user/.test(e.text ?? ''));
    assert.equal(markerUserEchoes.length, 0, 'synthetic user_echo carrying the marker must not reach the UI');

    // turn_end fires non-error so the footer paints ✓ instead of ❌.
    assert.equal(turn.ev.isError, false, 'auto-interrupt turn_end must be marked non-error');
    // stopReason is preserved for honesty.
    assert.equal(turn.ev.stopReason, 'interrupted');

    await c.close();
  } finally { await ctx.close(); }
});

test('auto-interrupt: marker mixed with surrounding model text in the same block is still stripped', async () => {
  // Real claude sometimes emits the marker appended to a partial model
  // response in the same text block rather than as a standalone block.
  // The whole block must still be stripped on auto-interrupt.
  const ctx = await bootServer({ scenarioPath: QUESTION_MIXED_SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'qm' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'qm', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    const c = await wsClient(ctx.wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');
    c.send({ t: 'prompt', id, text: 'go' });
    await c.wait(m => m.t === 'event' && m.ev.kind === 'turn_end');

    const events = c.messages.filter(m => m.t === 'event').map(m => m.ev);
    const textStrips = events.filter(e => e.kind === 'text_strip');
    const textEnds = events.filter(e => e.kind === 'text_end');
    assert.equal(textStrips.length, 1, 'whole mixed block stripped (the marker contaminated it)');
    assert.equal(textEnds.length, 0, 'no plain text_end for the marker-containing block');

    await c.close();
  } finally { await ctx.close(); }
});

test('manual interrupt (user clicks Interrupt): the [Request interrupted by user] marker stays visible', async () => {
  const ctx = await bootServer({ scenarioPath: MANUAL_SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'p' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const c = await wsClient(ctx.wsUrl);
    c.send({ t: 'subscribe', id });
    await c.wait(m => m.t === 'snapshot');
    c.send({ t: 'prompt', id, text: 'long task' });
    // Wait until we've seen at least one text_delta so we know the model
    // has begun streaming.
    await c.wait(m => m.t === 'event' && m.ev.kind === 'text_delta');
    // Manually interrupt — NOT via auto-interrupt.
    c.send({ t: 'interrupt', id });
    await c.wait(m => m.t === 'event' && m.ev.kind === 'turn_end');

    const events = c.messages.filter(m => m.t === 'event').map(m => m.ev);
    const textEnds = events.filter(e => e.kind === 'text_end');
    const textStrips = events.filter(e => e.kind === 'text_strip');
    assert.equal(textStrips.length, 0, 'no text_strip — manual interrupt leaves the marker visible');
    // The marker text block was finalized via text_end; the deltas for it
    // remain in the stream so the UI renders it as confirmation.
    const markerDeltas = events.filter(e => e.kind === 'text_delta' && /Request interrupted by user/.test(e.text));
    assert.equal(markerDeltas.length, 1, 'marker text streamed through to the UI');
    assert.ok(textEnds.length >= 1, 'text_end fires normally on manual interrupt');

    await c.close();
  } finally { await ctx.close(); }
});
