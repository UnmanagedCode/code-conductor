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

test('parser: isSynthetic user_echo following a Skill tool_use gets a skillLoad tag', () => {
  const p = new Parser();
  p.handleObject({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm', role: 'assistant' } } });
  p.handleObject({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_skill', name: 'Skill', input: {} } },
  });
  p.handleObject({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"skill":"keybindings-help","args":"what keys?"}' } },
  });
  const toolEvs = p.handleObject({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
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
  const invokeSkill = (toolUseId, skillName) => {
    p.handleObject({ type: 'stream_event', event: { type: 'message_start', message: { id: `m_${toolUseId}`, role: 'assistant' } } });
    p.handleObject({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolUseId, name: 'Skill', input: {} } },
    });
    p.handleObject({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ skill: skillName, args: 'x' }) } },
    });
    p.handleObject({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  };
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
