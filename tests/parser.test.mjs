import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from '../src/parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(__dirname, 'fixtures');

async function loadScenario(name) {
  const obj = JSON.parse(await fs.readFile(path.join(FX, name), 'utf8'));
  return obj;
}

function feed(scenario) {
  const p = new Parser();
  const events = [];
  for (const e of scenario.events) {
    events.push(...p.handleObject(e));
  }
  for (const turn of scenario.turns) {
    for (const e of turn.emit) {
      events.push(...p.handleObject(e));
    }
  }
  return events;
}

test('parser: init event emits system', async () => {
  const sc = await loadScenario('scenario-basic.json');
  const events = feed(sc);
  assert.equal(events[0].kind, 'system');
  assert.equal(events[0].subtype, 'init');
  assert.equal(events[0].data.session_id, '$SID');
});

test('parser: basic text deltas merge under stable msgId/blockIdx', async () => {
  const sc = await loadScenario('scenario-basic.json');
  const events = feed(sc);
  const textDeltas = events.filter(e => e.kind === 'text_delta');
  assert.equal(textDeltas.length, 3);
  assert.deepEqual(textDeltas.map(e => e.text), ['Hello, ', 'world', '!']);
  const msgIds = new Set(textDeltas.map(e => e.msgId));
  assert.equal(msgIds.size, 1);
  assert.equal([...msgIds][0], 'msg_001');
  const blockIdxs = new Set(textDeltas.map(e => e.blockIdx));
  assert.equal(blockIdxs.size, 1);

  const ends = events.filter(e => e.kind === 'text_end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].msgId, 'msg_001');

  const assistant = events.filter(e => e.kind === 'assistant_message');
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].msgId, 'msg_001');

  const turn = events.filter(e => e.kind === 'turn_end');
  assert.equal(turn.length, 1);
  assert.equal(turn[0].stopReason, 'end_turn');
  assert.equal(turn[0].cost, 0.0001);
  assert.equal(turn[0].isError, false);
});

test('parser: tool_use input streams via input_json_delta and finalizes parsed', async () => {
  const sc = await loadScenario('scenario-tool.json');
  const events = feed(sc);

  const start = events.find(e => e.kind === 'tool_use_start');
  assert.ok(start);
  assert.equal(start.name, 'Bash');
  assert.equal(start.toolUseId, 'toolu_a1');

  const partials = events.filter(e => e.kind === 'tool_use_input_delta');
  assert.equal(partials.length, 2);
  assert.equal(partials[0].toolUseId, 'toolu_a1');
  assert.equal(partials.map(p => p.partialJson).join(''), '{"command":"ls -la"}');

  const finals = events.filter(e => e.kind === 'tool_use');
  assert.equal(finals.length, 1);
  assert.deepEqual(finals[0].input, { command: 'ls -la' });
  assert.equal(finals[0].toolUseId, 'toolu_a1');

  const results = events.filter(e => e.kind === 'tool_result');
  assert.equal(results.length, 1);
  assert.equal(results[0].toolUseId, 'toolu_a1');
  assert.match(results[0].content, /total 0/);
  assert.equal(results[0].isError, false);

  const turn = events.filter(e => e.kind === 'turn_end');
  assert.equal(turn.length, 1);
});

test('parser: thinking_start emitted on content_block_start with type=thinking', async () => {
  const sc = await loadScenario('scenario-thinking.json');
  const events = feed(sc);
  const starts = events.filter(e => e.kind === 'thinking_start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].blockIdx, 0);
});

test('parser: thinking_redacted fires when only signature_delta arrives (no thinking_delta)', async () => {
  const sc = await loadScenario('scenario-redacted.json');
  const events = feed(sc);
  const redacted = events.filter(e => e.kind === 'thinking_redacted');
  assert.equal(redacted.length, 1, 'one thinking_redacted emitted');
  const deltas = events.filter(e => e.kind === 'thinking_delta');
  assert.equal(deltas.length, 0, 'no thinking_delta when content was internal');
  // Followed by thinking_end and the subsequent text block.
  const ends = events.filter(e => e.kind === 'thinking_end');
  assert.equal(ends.length, 1);
});

test('parser: thinking deltas tracked separately from text', async () => {
  const sc = await loadScenario('scenario-thinking.json');
  const events = feed(sc);

  const thinking = events.filter(e => e.kind === 'thinking_delta');
  assert.equal(thinking.length, 2);
  assert.equal(thinking.map(t => t.text).join(''), 'Pondering. Concluded.');
  assert.equal(thinking[0].blockIdx, 0);

  const text = events.filter(e => e.kind === 'text_delta');
  assert.equal(text.length, 1);
  assert.equal(text[0].text, '42');
  assert.equal(text[0].blockIdx, 1);

  const thinkingEnds = events.filter(e => e.kind === 'thinking_end');
  assert.equal(thinkingEnds.length, 1);
  const textEnds = events.filter(e => e.kind === 'text_end');
  assert.equal(textEnds.length, 1);
});

test('parser: malformed line falls back to raw', () => {
  const p = new Parser();
  const out = p.handleLine('not json {');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'raw');
});

test('parser: control_response surfaces ok/error', () => {
  const p = new Parser();
  const ok = p.handleObject({
    type: 'control_response',
    response: { subtype: 'success', request_id: 'r1', response: { mode: 'plan' } },
  });
  assert.equal(ok[0].kind, 'control_response');
  assert.equal(ok[0].ok, true);
  assert.equal(ok[0].requestId, 'r1');
  assert.deepEqual(ok[0].response, { mode: 'plan' });

  const err = p.handleObject({
    type: 'control_response',
    response: { subtype: 'error', request_id: 'r2', error: 'nope' },
  });
  assert.equal(err[0].ok, false);
  assert.equal(err[0].error, 'nope');
});

test('parser: keep_alive emits nothing', () => {
  const p = new Parser();
  assert.deepEqual(p.handleObject({ type: 'keep_alive' }), []);
});
