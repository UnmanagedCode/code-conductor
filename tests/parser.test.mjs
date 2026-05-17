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

test('parser: parent_tool_use_id is propagated onto every emitted UI event (sub-agent routing)', () => {
  // Outer Task tool_use registers itself; its events have no parent.
  // Sub-agent events arrive on the same stream with parent_tool_use_id set,
  // so the conversation view can route them into a nested area under the
  // matching tool block.
  const p = new Parser();
  const outer = p.handleObject({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'msg_outer', role: 'assistant' } },
  });
  assert.equal(outer.length, 0);

  const start = p.handleObject({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'task_id_xyz', name: 'Task', input: {} } },
  });
  const startEv = start[0];
  assert.equal(startEv.kind, 'tool_use_start');
  assert.equal(startEv.parentToolUseId, null, 'outer Task block has no parent');

  // Sub-agent text streams in, wrapped in stream_event with parent_tool_use_id set.
  const subText = p.handleObject({
    type: 'stream_event',
    parent_tool_use_id: 'task_id_xyz',
    event: { type: 'message_start', message: { id: 'msg_sub', role: 'assistant' } },
  });
  // message_start emits nothing user-facing
  assert.equal(subText.length, 0);

  const subStart = p.handleObject({
    type: 'stream_event',
    parent_tool_use_id: 'task_id_xyz',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  });
  assert.equal(subStart.length, 0);

  const subDelta = p.handleObject({
    type: 'stream_event',
    parent_tool_use_id: 'task_id_xyz',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sub thinking' } },
  });
  assert.equal(subDelta.length, 1);
  assert.equal(subDelta[0].kind, 'text_delta');
  assert.equal(subDelta[0].parentToolUseId, 'task_id_xyz');
});

test('parser: ExitPlanMode tool_use emits a plan_request event with plan text when provided', () => {
  const p = new Parser();
  p.handleObject({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm', role: 'assistant' } } });
  p.handleObject({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_plan', name: 'ExitPlanMode', input: {} } },
  });
  p.handleObject({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"plan":"# Plan\\n- step 1\\n- step 2"}' } },
  });
  const out = p.handleObject({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  const tool = out.find(e => e.kind === 'tool_use');
  const plan = out.find(e => e.kind === 'plan_request');
  assert.ok(tool);
  assert.equal(tool.name, 'ExitPlanMode');
  assert.ok(plan);
  assert.equal(plan.toolUseId, 'tu_plan');
  assert.match(plan.plan, /step 1/);
  assert.equal(plan.planPath, null);
});

test('parser: ExitPlanMode with empty input still emits plan_request (plan=null) for orchestrator to enrich', () => {
  const p = new Parser();
  p.handleObject({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm', role: 'assistant' } } });
  p.handleObject({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_x', name: 'ExitPlanMode', input: {} } },
  });
  const out = p.handleObject({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  const plan = out.find(e => e.kind === 'plan_request');
  assert.ok(plan);
  assert.equal(plan.plan, null);
});

test('parser: tags the [Request interrupted by user] marker block with isInterruptMarker=true', () => {
  // The parser only TAGS the block; Instance decides whether to convert
  // it into a text_strip based on whether the orchestrator triggered the
  // interrupt itself (AskUserQuestion / ExitPlanMode flow) or the user
  // pressed Interrupt manually.
  for (const variant of ['[Request interrupted by user]', '[Request interrupted by user for tool use]']) {
    const p = new Parser();
    p.handleObject({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm', role: 'assistant' } } });
    p.handleObject({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    });
    p.handleObject({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: variant } },
    });
    const out = p.handleObject({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
    assert.equal(out.length, 1, `one event expected for variant: ${variant}`);
    assert.equal(out[0].kind, 'text_end', `parser emits text_end, not text_strip — gating happens in Instance`);
    assert.equal(out[0].isInterruptMarker, true, `block flagged as marker for variant: ${variant}`);
  }
});

test('parser: a normal text block emits text_end without isInterruptMarker', () => {
  const p = new Parser();
  p.handleObject({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm', role: 'assistant' } } });
  p.handleObject({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  });
  p.handleObject({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '[Reminder] check the docs' } },
  });
  const out = p.handleObject({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  assert.equal(out[0].kind, 'text_end');
  assert.equal(out[0].isInterruptMarker, undefined);
});

test('parser: an inbound synthetic user message containing the marker is flagged on user_echo too', () => {
  // The CLI sometimes injects the [Request interrupted by user] marker as
  // a synthetic `type:"user"` message. The parser flags those user_echo
  // events the same way so Instance can suppress them on auto-interrupts.
  const p = new Parser();
  const out = p.handleObject({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'user_echo');
  assert.equal(out[0].text, '[Request interrupted by user]');
  assert.equal(out[0].isInterruptMarker, true);
});

test('parser: an ordinary user_echo (not the marker) is NOT flagged', () => {
  const p = new Parser();
  const out = p.handleObject({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'I changed my mind' }] },
  });
  assert.equal(out[0].kind, 'user_echo');
  assert.equal(out[0].isInterruptMarker, undefined);
});

test('parser: marker mixed with surrounding model text still flags the block as isInterruptMarker', () => {
  // Real claude sometimes emits the marker appended to the end of a
  // partial model response in the same text block — the strict
  // anchored regex missed those.
  const p = new Parser();
  p.handleObject({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm', role: 'assistant' } } });
  p.handleObject({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  });
  p.handleObject({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I will continue with' } },
  });
  p.handleObject({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' [Request interrupted by user]' } },
  });
  const out = p.handleObject({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  assert.equal(out[0].kind, 'text_end');
  assert.equal(out[0].isInterruptMarker, true);
});

test('parser: AskUserQuestion tool_use also emits a structured user_question event', () => {
  const p = new Parser();
  p.handleObject({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm', role: 'assistant' } } });
  p.handleObject({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_q', name: 'AskUserQuestion', input: {} } },
  });
  p.handleObject({
    type: 'stream_event',
    event: {
      type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"questions":[{"question":"What color?","header":"Color","multiSelect":false,"options":[{"label":"Red","description":"bold"},{"label":"Blue"}]}]}' },
    },
  });
  const stopEvs = p.handleObject({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  const tool = stopEvs.find(e => e.kind === 'tool_use');
  assert.ok(tool);
  assert.equal(tool.name, 'AskUserQuestion');

  const uq = stopEvs.find(e => e.kind === 'user_question');
  assert.ok(uq, 'user_question emitted alongside tool_use');
  assert.equal(uq.toolUseId, 'tu_q');
  assert.equal(uq.questions.length, 1);
  assert.equal(uq.questions[0].question, 'What color?');
  assert.equal(uq.questions[0].options[0].label, 'Red');
});

test('parser: tool_use for other tools does NOT emit user_question', () => {
  const p = new Parser();
  p.handleObject({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm', role: 'assistant' } } });
  p.handleObject({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_b', name: 'Bash', input: {} } },
  });
  p.handleObject({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
  });
  const out = p.handleObject({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  assert.equal(out.filter(e => e.kind === 'user_question').length, 0);
});

test('parser: parentToolUseId is null when envelope omits parent_tool_use_id', () => {
  const p = new Parser();
  const out = p.handleObject({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'm', role: 'assistant' } },
  });
  // Nothing emitted for message_start, but verify on a delta:
  const d = p.handleObject({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  });
  // text content_block_start emits nothing — verify on the delta itself
  const td = p.handleObject({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  });
  assert.equal(td[0].parentToolUseId, null);
});
