import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from '../src/parser.ts';

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
  assert.equal(typeof finals[0].startedAt, 'number', 'tool_use carries server-side startedAt ms');

  const results = events.filter(e => e.kind === 'tool_result');
  assert.equal(results.length, 1);
  assert.equal(results[0].toolUseId, 'toolu_a1');
  assert.match(results[0].content, /total 0/);
  assert.equal(results[0].isError, false);
  assert.equal(typeof results[0].finishedAt, 'number', 'tool_result carries server-side finishedAt ms');

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

test('parser: empty thinking_delta is dropped and still emits thinking_redacted (Opus 4.8)', async () => {
  // Opus 4.8 streams thinking_delta events with thinking:"" for redacted
  // thinking (where 4.7 sent only a signature_delta). The empties must be
  // dropped so gotThinkingDelta stays false and content_block_stop takes the
  // redacted path — otherwise the block finalizes empty and renders as
  // "thinking (0 chars)".
  const sc = await loadScenario('scenario-redacted-empty-deltas.json');
  const events = feed(sc);
  const redacted = events.filter(e => e.kind === 'thinking_redacted');
  assert.equal(redacted.length, 1, 'one thinking_redacted emitted');
  const deltas = events.filter(e => e.kind === 'thinking_delta');
  assert.equal(deltas.length, 0, 'empty thinking_delta events are dropped, not forwarded');
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

// ── rate_limit_event ─────────────────────────────────────────────────────
test('parser: rate_limit_event with nested isUsingOverage passes through as system', () => {
  const p = new Parser();
  const events = p.handleObject({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      rateLimitType: 'five_hour',
      resetsAt: 1729281600,
      utilization: 0.85,
      isUsingOverage: true,
      overageStatus: 'allowed',
    },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'system');
  assert.equal(events[0].subtype, 'rate_limit_event');
  assert.equal(events[0].data.rate_limit_info.isUsingOverage, true);
  assert.equal(events[0].data.rate_limit_info.rateLimitType, 'five_hour');
  assert.equal(events[0].data.rate_limit_info.utilization, 0.85);
});

test('parser: rate_limit_event with flat isUsingOverage passes through as system', () => {
  const p = new Parser();
  const events = p.handleObject({
    type: 'rate_limit_event',
    isUsingOverage: true,
    rateLimitType: 'seven_day',
    resetsAt: 1729281600,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'system');
  assert.equal(events[0].subtype, 'rate_limit_event');
  assert.equal(events[0].data.isUsingOverage, true);
});

test('parser: rate_limit_event without isUsingOverage passes through cleanly', () => {
  const p = new Parser();
  const events = p.handleObject({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      rateLimitType: 'seven_day',
      resetsAt: 1729281600,
    },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'system');
  assert.equal(events[0].subtype, 'rate_limit_event');
  assert.equal(events[0].data.rate_limit_info?.isUsingOverage, undefined);
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

test('parser: message_start with usage emits a message_start UI event', () => {
  const p = new Parser();
  const out = p.handleObject({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: {
        id: 'msg_with_usage',
        role: 'assistant',
        usage: {
          input_tokens: 42,
          output_tokens: 0,
          cache_read_input_tokens: 50_000,
          cache_creation_input_tokens: 1_000,
        },
      },
    },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'message_start');
  assert.equal(out[0].msgId, 'msg_with_usage');
  assert.equal(out[0].usage.input_tokens, 42);
  assert.equal(out[0].usage.cache_read_input_tokens, 50_000);
  assert.equal(out[0].parentToolUseId, null);
});

test('parser: message_start without usage stays silent (legacy fixtures)', () => {
  const p = new Parser();
  const out = p.handleObject({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'm', role: 'assistant' } },
  });
  assert.equal(out.length, 0);
});

// ── the zero-sum usage floor (card 2026-0185) ───────────────────────────────
//
// Some substitution backends' gateways report an all-zero usage block on EVERY
// message_start. Zero is not a measurement, so the parser must null the BLOCK
// while still emitting the EVENT (which also carries the turn-boundary model
// reading and the idle→turn flip — see tests/cache-miss-detection.test.mjs).

test('parser: an all-zero message_start usage block is dropped, but the event still fires', () => {
  const p = new Parser();
  const out = p.handleObject({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: {
        id: 'msg_zero',
        role: 'assistant',
        model: 'deepseek-v4-flash',
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
  });
  assert.equal(out.length, 1, 'the event is NOT suppressed — it carries the idle→turn flip');
  assert.equal(out[0].kind, 'message_start');
  assert.equal(out[0].usage, null, 'a zero prompt sum is not a measurement');
  assert.equal(out[0].msgId, 'msg_zero');
  assert.equal(out[0].model, 'deepseek-v4-flash', 'the turn-boundary model reading survives');
});

test('parser: the zero-sum floor sums only the three prompt-side fields, not output_tokens', () => {
  const p = new Parser();
  const out = p.handleObject({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: {
        id: 'msg_out_only',
        role: 'assistant',
        usage: {
          input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 5000,
        },
      },
    },
  });
  assert.equal(out[0].usage, null, 'output_tokens is not part of the context prompt size');
});

test('parser: a non-zero input_tokens alone still latches', () => {
  const p = new Parser();
  const out = p.handleObject({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: { id: 'm', role: 'assistant', usage: { input_tokens: 7, output_tokens: 0 } },
    },
  });
  assert.notEqual(out[0].usage, null, 'the floor must not swallow a real reading');
  assert.equal(out[0].usage.input_tokens, 7);
});

test('parser: a non-zero cache_read alone still latches', () => {
  const p = new Parser();
  const out = p.handleObject({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: { id: 'm', role: 'assistant', usage: { input_tokens: 0, cache_read_input_tokens: 190000 } },
    },
  });
  assert.notEqual(out[0].usage, null);
  assert.equal(out[0].usage.cache_read_input_tokens, 190000);
});

test('parser: a non-zero cache_creation alone still latches, and one token is not zero', () => {
  const p = new Parser();
  const creation = p.handleObject({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: { id: 'mc', role: 'assistant', usage: { input_tokens: 0, cache_creation_input_tokens: 1024 } },
    },
  });
  assert.notEqual(creation[0].usage, null);
  assert.equal(creation[0].usage.cache_creation_input_tokens, 1024);
  // The floor is `> 0`, not `> 1` / `>= 1024`.
  const one = p.handleObject({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'm1', role: 'assistant', usage: { input_tokens: 1 } } },
  });
  assert.notEqual(one[0].usage, null, 'a single token is a measurement');
});

test('parser: synthetic assistant message (slash command) emits text events', () => {
  const p = new Parser();
  // Shape lifted from a real debug trace: the CLI handles slash commands
  // locally and returns a single `assistant` envelope with model="<synthetic>"
  // and no preceding stream_event frames.
  const out = p.handleObject({
    type: 'assistant',
    message: {
      id: 'synth-uuid-001',
      role: 'assistant',
      type: 'message',
      model: '<synthetic>',
      content: [{ type: 'text', text: "/btw isn't available in this environment." }],
    },
    parent_tool_use_id: null,
  });
  const deltas = out.filter(e => e.kind === 'text_delta');
  const ends = out.filter(e => e.kind === 'text_end');
  assert.equal(deltas.length, 1, 'one text_delta emitted for one text block');
  assert.equal(deltas[0].text, "/btw isn't available in this environment.");
  assert.equal(deltas[0].msgId, 'synth-uuid-001');
  assert.equal(deltas[0].blockIdx, 0);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].msgId, 'synth-uuid-001');
  assert.equal(ends[0].blockIdx, 0);
  const assistant = out.filter(e => e.kind === 'assistant_message');
  assert.equal(assistant.length, 1, 'assistant_message still emitted for sub-agent reconcile path');
});

test('parser: non-synthetic assistant message does not emit text events', () => {
  const p = new Parser();
  // Real assistant envelope: msg_… id and a real model. The stream_event
  // path is the source of truth for these; we must NOT also emit text
  // events from the envelope or the UI will double-render.
  const out = p.handleObject({
    type: 'assistant',
    message: {
      id: 'msg_01ABC',
      role: 'assistant',
      type: 'message',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text: 'hello world' }],
    },
    parent_tool_use_id: null,
  });
  assert.equal(out.filter(e => e.kind === 'text_delta').length, 0);
  assert.equal(out.filter(e => e.kind === 'text_end').length, 0);
  assert.equal(out.filter(e => e.kind === 'assistant_message').length, 1);
});

// Emit the frames the CLI actually emits for a top-level tool call, IN THE
// ORDER IT EMITS THEM. Measured over the 11 stdout captures on disk: the
// complete `assistant` envelope lands BEFORE `content_block_stop` — 353 of 353
// tool_use ids that appeared on both paths, 0 the other way. A fixture that emits the
// stop frame first is describing a stream the CLI never produces, and any
// invariant about the two registration paths that it "pins" is a false green.
//
// `parent_tool_use_id` is present-and-null on every real top-level envelope
// (720/720 across the surviving captures; 0 omit the key). Omitting it here
// would leave the registration gate's live branch exercising `undefined` only,
// so narrowing that gate to an `=== undefined` test would disable all live
// folding with a green suite.
function emitSkillToolUse(p, { toolUseId, skill, index = 0, args = 'x', name = 'Skill' } = {}) {
  p.handleObject({ type: 'stream_event', event: { type: 'message_start', message: { id: `m_${toolUseId}`, role: 'assistant' } } });
  p.handleObject({
    type: 'stream_event',
    event: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: toolUseId, name, input: {} } },
  });
  p.handleObject({
    type: 'stream_event',
    event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ skill, args }) } },
  });
  p.handleObject({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      id: `m_${toolUseId}`, role: 'assistant', type: 'message', model: 'claude-opus-4-8',
      content: [{ type: 'tool_use', id: toolUseId, name, input: name === 'Skill' ? { skill, args } : { command: 'ls' } }],
    },
  });
  const stopEvs = p.handleObject({ type: 'stream_event', event: { type: 'content_block_stop', index } });
  p.handleObject({ type: 'stream_event', event: { type: 'message_delta', delta: {} } });
  p.handleObject({ type: 'stream_event', event: { type: 'message_stop' } });
  return stopEvs;
}

test('parser: isSynthetic user_echo following a Skill tool_use gets a skillLoad tag', () => {
  const p = new Parser();
  const toolEvs = emitSkillToolUse(p, { toolUseId: 'tu_skill', skill: 'keybindings-help', args: 'what keys?' });
  assert.equal(toolEvs.find(e => e.kind === 'tool_use')?.name, 'Skill');

  // Short tool_result confirming the launch — unaffected, stays a plain tool_result.
  const resultEvs = p.handleObject({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_skill', content: 'Launching skill: keybindings-help' }] },
  });
  assert.equal(resultEvs.length, 1);
  assert.equal(resultEvs[0].kind, 'tool_result');

  // The big content-injection message: isSynthetic:true, no tool_use_id link.
  const contentEvs = p.handleObject({
    type: 'user',
    isSynthetic: true,
    message: { role: 'user', content: [{ type: 'text', text: '# Keybindings Skill\n\nfull reference text here' }] },
  });
  const echo = contentEvs.find(e => e.kind === 'user_echo');
  assert.ok(echo, 'still emits a user_echo');
  assert.deepEqual(echo.skillLoad, { skill: 'keybindings-help' });
});

test('parser: isSynthetic user_echo with no pending Skill tool_use is NOT tagged as a skill load', () => {
  const p = new Parser();
  // Stop-hook feedback and compaction-continuation messages are also
  // isSynthetic:true on this CLI — without a preceding Skill tool_use they
  // must render as ordinary user_echo, not get mislabeled "Loading skill".
  const out = p.handleObject({
    type: 'user',
    isSynthetic: true,
    message: { role: 'user', content: [{ type: 'text', text: 'Stop hook feedback:\n[decrease the value once per turn]' }] },
  });
  const echo = out.find(e => e.kind === 'user_echo');
  assert.ok(echo);
  assert.equal(echo.skillLoad, undefined);
});

test('parser: a second Skill invocation in the same session correlates independently (FIFO)', () => {
  const p = new Parser();
  const invokeSkill = (toolUseId, skillName) => emitSkillToolUse(p, { toolUseId, skill: skillName });
  invokeSkill('tu_1', 'keybindings-help');
  const first = p.handleObject({
    type: 'user', isSynthetic: true,
    message: { role: 'user', content: [{ type: 'text', text: '# Keybindings Skill\n\n...' }] },
  }).find(e => e.kind === 'user_echo');
  assert.deepEqual(first.skillLoad, { skill: 'keybindings-help' });

  invokeSkill('tu_2', 'deep-research');
  const second = p.handleObject({
    type: 'user', isSynthetic: true,
    message: { role: 'user', content: [{ type: 'text', text: '# Deep Research\n\n...' }] },
  }).find(e => e.kind === 'user_echo');
  assert.deepEqual(second.skillLoad, { skill: 'deep-research' });
});

test('parser: a Skill tool_use whose tool_result errors does not leave a stale FIFO entry to mislabel a later isSynthetic message', () => {
  const p = new Parser();
  emitSkillToolUse(p, { toolUseId: 'tu_bad', skill: 'no-such-skill' });

  // The skill lookup fails: tool_result errors, no content injection follows.
  const resultEvs = p.handleObject({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_bad', content: 'skill not found', is_error: true }] },
  });
  assert.equal(resultEvs[0].kind, 'tool_result');
  assert.equal(resultEvs[0].isError, true);

  // A later, unrelated isSynthetic message (e.g. Stop-hook feedback) must
  // not inherit the orphaned pending entry.
  const later = p.handleObject({
    type: 'user', isSynthetic: true,
    message: { role: 'user', content: [{ type: 'text', text: 'Stop hook feedback:\n[do the thing]' }] },
  }).find(e => e.kind === 'user_echo');
  assert.ok(later);
  assert.equal(later.skillLoad, undefined);
});

test('parser: a Skill tool_use interrupted with no tool_result is expired by the next real user turn, so a later isSynthetic message is not mislabeled', () => {
  const p = new Parser();
  emitSkillToolUse(p, { toolUseId: 'tu_interrupted', skill: 'keybindings-help' });
  // Turn is interrupted: no tool_result, no content injection ever arrives.

  // The conversation continues normally with a genuine real prompt.
  const realEcho = p.handleObject({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'never mind, let\'s do something else' }] },
  }).find(e => e.kind === 'user_echo');
  assert.ok(realEcho);
  assert.equal(realEcho.skillLoad, undefined);

  // A later, unrelated isSynthetic message (e.g. compaction-continuation)
  // must not inherit the orphaned pending entry.
  const later = p.handleObject({
    type: 'user', isSynthetic: true,
    message: { role: 'user', content: [{ type: 'text', text: 'This session is being continued from a previous conversation...' }] },
  }).find(e => e.kind === 'user_echo');
  assert.ok(later);
  assert.equal(later.skillLoad, undefined);
});

test('parser: a Skill invoked in a live sub-agent turn registers nothing, so its never-arriving injection cannot steal a later top-level one', () => {
  const p = new Parser();
  // Envelope shapes here mirror the one captured sub-agent Skill call (in a
  // capture since deleted, so this shape is no longer re-derivable): the CLI
  // forwards sub-agent turns as complete assistant/user envelopes tagged with
  // parent_tool_use_id and emits NO stream_event frames for them — and no
  // injection followed it. No surviving capture contains a sub-agent turn, so
  // nothing corroborates that either way. Registering the sub-agent
  // Skill would therefore create an entry nothing can consume; its
  // tool_result is not an error, so the error-drop never fires either, and it
  // would sit at the queue head and claim the next TOP-LEVEL injection.
  p.handleObject({
    type: 'assistant',
    parent_tool_use_id: 'call_PYNTj78b23DMS6sVJL6ucp6Q',
    message: {
      id: 'msg_sub', role: 'assistant', type: 'message', model: 'claude-opus-4-8',
      content: [{ type: 'tool_use', id: 'call_8RvDojH0ymttsqv0XkjJH73o', name: 'Skill', input: { skill: 'claude-api', args: 'context windows' } }],
    },
  });
  p.handleObject({
    type: 'user',
    parent_tool_use_id: 'call_PYNTj78b23DMS6sVJL6ucp6Q',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_8RvDojH0ymttsqv0XkjJH73o', content: 'Launching skill: claude-api' }] },
  });

  // The next top-level injection belongs to a DIFFERENT skill entirely.
  emitSkillToolUse(p, { toolUseId: 'tu_top', skill: 'keybindings-help' });
  p.handleObject({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_top', content: 'Launching skill: keybindings-help' }] },
  });
  const echo = p.handleObject({
    type: 'user', isSynthetic: true,
    message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /tmp/...\n\n# Keybindings Skill' }] },
  }).find(e => e.kind === 'user_echo');

  assert.ok(echo);
  assert.deepEqual(echo.skillLoad, { skill: 'keybindings-help' },
    'the top-level injection gets its own skill, not the orphaned sub-agent one');
});

test('parser: a top-level Skill is registered once even though it arrives on both the assistant envelope and the streaming frames', () => {
  const p = new Parser();
  // Real frame order (see emitSkillToolUse): the assistant envelope lands
  // BEFORE content_block_stop. Registering from both paths would leave a
  // duplicate entry behind after the injection consumed one, and the next
  // unrelated isSynthetic message would inherit it.
  emitSkillToolUse(p, { toolUseId: 'tu_dup', skill: 'keybindings-help' });
  p.handleObject({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_dup', content: 'Launching skill: keybindings-help' }] },
  });

  const first = p.handleObject({
    type: 'user', isSynthetic: true,
    message: { role: 'user', content: [{ type: 'text', text: '# Keybindings Skill\n\nreference' }] },
  }).find(e => e.kind === 'user_echo');
  assert.deepEqual(first.skillLoad, { skill: 'keybindings-help' });

  // A later unrelated synthetic message — the real "[Your previous response
  // had no visible output…]" nudge shape. With a duplicate entry left in the
  // queue this renders as a bogus "Loading skill: keybindings-help" bubble.
  const later = p.handleObject({
    type: 'user', isSynthetic: true,
    message: { role: 'user', content: [{ type: 'text', text: '[Your previous response had no visible output. Please continue.]' }] },
  }).find(e => e.kind === 'user_echo');
  assert.ok(later);
  assert.equal(later.skillLoad, undefined, 'no duplicate pending entry survived the first injection');
});

// The next two pin the cross-surface guards in skillInjectionMarker /
// attachSkillLoad. No line in the persisted corpus carries both markers, and
// no stdout envelope carries sourceToolUseID — these shapes are constructed
// deliberately. The guards stay because a line arriving with the *other*
// surface's fields is exactly the mismatch this change exists to prevent, and
// silently falling through to FIFO would mis-stamp; constructing the shape is
// cheap, so they are exercised rather than left as untested speculation.
test('parser: a line carrying BOTH markers is treated as streamed (identity is required only on the jsonl surface)', () => {
  const p = new Parser();
  emitSkillToolUse(p, { toolUseId: 'tu_both', skill: 'keybindings-help' });
  p.handleObject({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_both', content: 'Launching skill: keybindings-help' }] },
  });
  const echo = p.handleObject({
    type: 'user', isSynthetic: true, isMeta: true,
    message: { role: 'user', content: [{ type: 'text', text: '# Keybindings Skill\n\nreference' }] },
  }).find(e => e.kind === 'user_echo');
  assert.deepEqual(echo.skillLoad, { skill: 'keybindings-help' },
    'isSynthetic present means stdout, where FIFO is the only correlation available');
});

test('parser: a streamed line whose sourceToolUseID names nothing pending claims nothing and consumes nothing', () => {
  const p = new Parser();
  emitSkillToolUse(p, { toolUseId: 'tu_real', skill: 'keybindings-help' });
  p.handleObject({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_real', content: 'Launching skill: keybindings-help' }] },
  });
  const stray = p.handleObject({
    type: 'user', isSynthetic: true, sourceToolUseID: 'tu_nothing_pending',
    message: { role: 'user', content: [{ type: 'text', text: 'injected content naming an unknown tool_use' }] },
  }).find(e => e.kind === 'user_echo');
  assert.equal(stray.skillLoad, undefined, 'an unmatched id must not fall through to the FIFO head');

  const real = p.handleObject({
    type: 'user', isSynthetic: true,
    message: { role: 'user', content: [{ type: 'text', text: '# Keybindings Skill\n\nreference' }] },
  }).find(e => e.kind === 'user_echo');
  assert.deepEqual(real.skillLoad, { skill: 'keybindings-help' }, 'and must not have consumed the entry either');
});

test('parser: two Skill invocations in one turn each get their own name (the second is not labeled with the first)', () => {
  const p = new Parser();
  // The user-visible shape of a double registration: with the queue holding
  // ["claude-api", "claude-api"] instead of ["claude-api", "keybindings-help"]
  // the second bubble is titled with the previous skill's name.
  const invokeAndInject = (toolUseId, skill) => {
    emitSkillToolUse(p, { toolUseId, skill });
    p.handleObject({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `Launching skill: ${skill}` }] },
    });
    return p.handleObject({
      type: 'user', isSynthetic: true,
      message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: /tmp/...\n\n# ${skill}` }] },
    }).find(e => e.kind === 'user_echo');
  };
  const a = invokeAndInject('call_first', 'claude-api');
  const b = invokeAndInject('call_second', 'keybindings-help');
  assert.deepEqual(
    [a.skillLoad?.skill, b.skillLoad?.skill],
    ['claude-api', 'keybindings-help'],
  );
});

test('parser: a non-Skill tool_use registers nothing, so the next injected message is not mislabeled', () => {
  const p = new Parser();
  // The over-firing direction of the registration gate. Every other test puts
  // either a Skill tool_use or nothing at all in front of the injected
  // message, so dropping the `name !== 'Skill'` half of the filter goes
  // unnoticed — and under it an ordinary Bash call registers
  // {skill: undefined} and the next injected line renders "Loading skill:
  // undefined".
  emitSkillToolUse(p, { toolUseId: 'call_bash', name: 'Bash' });
  p.handleObject({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_bash', content: 'file-a\nfile-b' }] },
  });
  const echo = p.handleObject({
    type: 'user', isSynthetic: true,
    message: { role: 'user', content: [{ type: 'text', text: '[Your previous response had no visible output…]' }] },
  }).find(e => e.kind === 'user_echo');
  assert.ok(echo, 'still emits a user_echo');
  assert.equal(echo.skillLoad, undefined, 'a Bash tool_use must never register a pending skill load');
});

test('parser: two Skill tool_uses pending at once keep FIFO order (the first injection takes the first skill)', () => {
  const p = new Parser();
  // SEQUENCE COMPOSED from attested primitives, not lifted from a capture: no
  // surviving capture holds two Skill tool_uses. The primitives are each real
  // — a tool_use-carrying `assistant` envelope with parent_tool_use_id
  // present-and-null (720/720), and the envelope landing before its
  // tool_result (353/353) — which is what lets both entries be pending before
  // either injection arrives. Every other skill test injects between the two
  // invocations, so the queue never holds two entries and shift()/pop() are
  // indistinguishable; under pop() BOTH labels swap.
  emitSkillToolUse(p, { toolUseId: 'call_first', skill: 'claude-api', index: 0 });
  emitSkillToolUse(p, { toolUseId: 'call_second', skill: 'keybindings-help', index: 1 });
  const inject = () => p.handleObject({
    type: 'user', isSynthetic: true,
    message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /tmp/…' }] },
  }).find(e => e.kind === 'user_echo');
  assert.deepEqual(
    [inject().skillLoad?.skill, inject().skillLoad?.skill],
    ['claude-api', 'keybindings-help'],
    'injections are consumed oldest-first',
  );
});

test('parser: the real captured live Skill turn folds (committed stdout scenario)', async () => {
  // Committed trim of a REAL capture, so the live-side evidence survives the
  // debug dir it came from: lines 3/11/12/52-57 of
  // .conduct/debug/570bbe7c-…/claude-stdout.jsonl (gpt-5.6-sol, CLI 2.1.220).
  // Structural fields verbatim; only long text/args bodies truncated.
  const sc = await loadScenario('scenario-live-skill-load.json');
  const events = feed(sc);
  const echo = events.filter(e => e.kind === 'user_echo').at(-1);
  assert.ok(echo, 'the injected content message emits a user_echo');
  assert.deepEqual(echo.skillLoad, { skill: 'claude-api' });
  // The tool_result confirming the launch stays a plain tool_result.
  assert.ok(events.some(e => e.kind === 'tool_result'));
});

// ── A1: forwarded sub-agent envelopes emit tool_use heads ──────────────────
// The CLI forwards a depth-2+ sub-agent's turn as a finals-only `assistant`
// envelope tagged with `parent_tool_use_id` — no stream_event frames exist
// for it, so unless _handleAssistant unpacks the envelope's own content
// blocks, that sub-agent's tool_use never enters the ring at all.

test('parser: forwarded sub-agent envelope emits a tool_use head for its own tool_use block', () => {
  const p = new Parser();
  const out = p.handleObject({
    type: 'assistant',
    parent_tool_use_id: 'tu_outer',
    message: {
      id: 'msg_sub', role: 'assistant', type: 'message', model: 'claude-opus-4-8',
      content: [
        { type: 'text', text: 'thinking about it' },
        { type: 'tool_use', id: 'tu_inner', name: 'Agent', input: { description: 'deep' } },
      ],
    },
  });
  assert.deepEqual(out.map(e => e.kind), ['tool_use', 'assistant_message'],
    'a head event precedes the reconciled assistant_message, and nothing else is emitted');
  const head = out[0];
  assert.equal(head.toolUseId, 'tu_inner');
  assert.equal(head.name, 'Agent');
  assert.equal(head.blockIdx, 1, 'the tool_use is the SECOND content block (index 1), not the first');
  assert.deepEqual(head.input, { description: 'deep' });
  assert.equal(head.parentToolUseId, 'tu_outer', 'handleObject stamps the envelope\'s own parent tag');
});

test('parser: a top-level envelope does not double-emit the tool_use head its own stream_event frames already produced', () => {
  const p = new Parser();
  const all = [];
  const origHandle = p.handleObject.bind(p);
  p.handleObject = (obj) => { const evs = origHandle(obj); all.push(...evs); return evs; };
  emitSkillToolUse(p, { toolUseId: 'tu_top', name: 'Bash', skill: undefined });
  const heads = all.filter(e => e.kind === 'tool_use' && e.toolUseId === 'tu_top');
  assert.equal(heads.length, 1, 'exactly one tool_use head for the whole turn, not one per path');
});

test('parser: a forwarded sub-agent envelope emits one head per tool_use block it carries', () => {
  const p = new Parser();
  const out = p.handleObject({
    type: 'assistant',
    parent_tool_use_id: 'tu_outer2',
    message: {
      id: 'msg_sub2', role: 'assistant', type: 'message', model: 'claude-opus-4-8',
      content: [
        { type: 'tool_use', id: 'X', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: 'Y', name: 'Read', input: { path: 'a.txt' } },
      ],
    },
  });
  const heads = out.filter(e => e.kind === 'tool_use');
  assert.deepEqual(heads.map(e => e.toolUseId), ['X', 'Y']);
  assert.deepEqual(heads.map(e => e.blockIdx), [0, 1]);
});

// ── ctx fallback: message_delta.usage when message_start.usage is all-zero ──
// Card 2026-0195. A backend whose gateway reports {input_tokens:0,
// output_tokens:0} on EVERY message_start latched nothing (the block is
// floored to null), so a fresh session read `ctx —` for its whole life even
// though the real prompt size rides the same stream on message_delta.usage.
// The parser arms per-message on a present-but-zero-sum message_start and
// disarms on a usage-bearing one, so the two sources are mutually exclusive
// within a message and no merge site exists.

function msgStartEv({ usage, id = 'm1', model = 'deepseek-v4-flash' }) {
  return { type: 'stream_event', event: { type: 'message_start', message: { id, role: 'assistant', model, ...(usage === undefined ? {} : { usage }) } } };
}
function msgDeltaEv(usage) {
  const event = { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } };
  if (usage !== undefined) event.usage = usage;
  return { type: 'stream_event', event };
}
const ZERO_USAGE = { input_tokens: 0, output_tokens: 0 };
const REAL_DELTA_USAGE = { input_tokens: 12_000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 8_000, output_tokens: 110 };

// T1 — the emission itself, plus "one whole usage object" (deepEqual, not a sum).
test('parser T1: a zero-sum message_start still fires with usage:null and its delta emits one context_usage', () => {
  const p = new Parser();
  const starts = p.handleObject(msgStartEv({ usage: ZERO_USAGE }));
  assert.equal(starts.length, 1, 'the message_start event must still fire (it carries the idle→turn flip)');
  assert.equal(starts[0].kind, 'message_start');
  assert.equal(starts[0].usage, null, 'the zero BLOCK is dropped, not the event');

  const out = p.handleObject(msgDeltaEv(REAL_DELTA_USAGE));
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'context_usage');
  assert.equal(out[0].msgId, 'm1');
  assert.deepEqual(out[0].usage, REAL_DELTA_USAGE, 'the whole usage object rides through — no per-field copy');
});

// T2 — criterion 2: a backend whose message_start IS a measurement never gets a
// fallback. Shape taken from the real capture in scenario-live-skill-load.json.
test('parser T2: a usage-bearing message_start suppresses the fallback entirely', () => {
  const p = new Parser();
  const starts = p.handleObject(msgStartEv({ usage: { input_tokens: 46179, output_tokens: 0 } }));
  assert.equal(starts[0].usage.input_tokens, 46179, 'the real reading is the message_start one');
  const out = p.handleObject(msgDeltaEv({ input_tokens: 37395, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 110 }));
  assert.deepEqual(out, [], 'a native backend\'s message_delta must never win over its message_start');
});

// T3 — the delta-side floor. Latching a zero renders `ctx 0% · 0/200k`.
test('parser T3: an armed all-zero message_delta usage emits nothing', () => {
  const p = new Parser();
  p.handleObject(msgStartEv({ usage: ZERO_USAGE }));
  assert.deepEqual(p.handleObject(msgDeltaEv({ input_tokens: 0, output_tokens: 110 })), []);
});

// T4 — stays armed within a message (last non-zero wins is the latch's job),
// and re-decides per message.
test('parser T4: the flag stays armed across deltas of one message and is re-decided by the next', () => {
  const p = new Parser();
  p.handleObject(msgStartEv({ usage: ZERO_USAGE, id: 'm1' }));
  const a = p.handleObject(msgDeltaEv({ input_tokens: 100 }));
  const b = p.handleObject(msgDeltaEv({ input_tokens: 200 }));
  assert.deepEqual([...a, ...b].map(e => [e.kind, e.usage.input_tokens]),
    [['context_usage', 100], ['context_usage', 200]],
    'both deltas emit, in order — disarming after the first would break "last non-zero wins"');

  p.handleObject(msgStartEv({ usage: { input_tokens: 5000 }, id: 'm2' }));
  assert.deepEqual(p.handleObject(msgDeltaEv({ input_tokens: 300 })), [],
    'a usage-bearing message_start disarms — the flag is not "armed once, forever"');
});

// T5 — reads event-level `usage`, and never emits an undefined-usage event.
test('parser T5: an armed message_delta with no usage key emits nothing', () => {
  const p = new Parser();
  p.handleObject(msgStartEv({ usage: ZERO_USAGE }));
  assert.deepEqual(p.handleObject(msgDeltaEv(undefined)), []);
});

// T6 — reset()/rewind isolation: _wipeForResume clears the flag alongside
// Instance._lastContextUsage.
test('parser T6: reset() disarms the ctx fallback', () => {
  const p = new Parser();
  p.handleObject(msgStartEv({ usage: ZERO_USAGE }));
  p.reset();
  assert.deepEqual(p.handleObject(msgDeltaEv(REAL_DELTA_USAGE)), [],
    'a rewound session must not inherit an armed flag');
});
