// The live-only attention counters on Instance.summary() (liveTurnEnds,
// lastTurnError, liveAsks), read by public/attention.js, and the 'status'
// emissions that carry each transition input to the instances hint. A bare
// Instance driven through _handleStdoutLine, no subprocess.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Instance } from '../src/instances.ts';

function makeInstance() {
  const inst = new Instance({
    id: 'i-attn', project: 'demo', cwd: '/nonexistent-cwd',
    mode: 'bypassPermissions', effort: 'high', thinking: 'adaptive', model: null,
  });
  const statuses = [];
  inst.on('status', (s) => statuses.push(s));
  return { inst, statuses };
}

const line = (obj) => JSON.stringify(obj);
const msgStart = (id) => line({
  type: 'stream_event',
  event: { type: 'message_start', message: { id, role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 0 } } },
});
const textBlock = (text) => [
  line({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }),
  line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } }),
  line({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
];
const result = ({ isError = false } = {}) => line({
  type: 'result', subtype: isError ? 'error_during_execution' : 'success', stop_reason: 'end_turn',
  duration_ms: 1, total_cost_usd: 0, is_error: isError,
});
const feed = (inst, ...lines) => { for (const l of lines.flat()) inst._handleStdoutLine(l); };
const textTurn = (inst, id, text) => feed(inst, msgStart(id), textBlock(text), result());

test('each live turn end raises liveTurnEnds by one and summary() carries it', () => {
  const { inst } = makeInstance();
  assert.equal(inst.summary().liveTurnEnds, 0);
  textTurn(inst, 'm1', 'done.');
  assert.equal(inst.summary().liveTurnEnds, 1);
  textTurn(inst, 'm2', 'done again.');
  assert.equal(inst.summary().liveTurnEnds, 2);
});

test('lastTurnError follows is_error of the latest counted turn end', () => {
  const { inst } = makeInstance();
  feed(inst, msgStart('m1'), result({ isError: true }));
  assert.equal(inst.summary().lastTurnError, true);
  feed(inst, msgStart('m2'), result());
  assert.equal(inst.summary().lastTurnError, false, 'the next ok turn clears it');
});

test('a turn end a commanded stop interrupted moves neither liveTurnEnds nor lastTurnError', () => {
  const { inst } = makeInstance();
  inst._stopInterruptedTurn = true;
  feed(inst, msgStart('m1'), result({ isError: true }));
  const s = inst.summary();
  assert.equal(s.liveTurnEnds, 0);
  assert.equal(s.lastTurnError, false);
});

test('a live text ask raises liveAsks once; a second ask while still waiting does not', () => {
  const { inst } = makeInstance();
  textTurn(inst, 'm1', 'Should I continue with the tests?');
  assert.deepEqual([inst.summary().awaitingUser, inst.summary().liveAsks], ['question', 1]);
  textTurn(inst, 'm2', 'Or should I stop here?');
  assert.deepEqual([inst.summary().awaitingUser, inst.summary().liveAsks], ['question', 1]);
});

test('a hydrate-style _setAwaitingUser write leaves liveAsks unchanged', () => {
  const { inst } = makeInstance();
  inst._setAwaitingUser({ kind: 'question', source: 'tool' });
  const s = inst.summary();
  assert.deepEqual([s.awaitingUser, s.liveAsks], ['question', 0]);
});

// ── transition inputs reach the instances hint ──────────────────────────────
// The hub turns every 'status' emission into an {t:'instances'} frame
// (tests/wshub-playbook-hint.test.mjs), so each input must emit one whose
// summary already shows the new state.

test('the turn-end flip to idle emits a status whose summary already carries the counters', () => {
  const { inst, statuses } = makeInstance();
  feed(inst, msgStart('m1'), result({ isError: true }));
  const idle = statuses.findLast(s => s.status === 'idle');
  assert.ok(idle, 'the last status emission reports idle');
  assert.deepEqual([idle.liveTurnEnds, idle.lastTurnError], [1, true]);
});

test('a live ask emits a status carrying the ask and the bumped liveAsks', () => {
  const { inst, statuses } = makeInstance();
  textTurn(inst, 'm1', 'Should I continue?');
  assert.ok(statuses.some(s => s.awaitingUser === 'question' && s.liveAsks === 1));
});

test('the last subagent draining while idle emits a status whose displayStatus is idle', () => {
  const { inst, statuses } = makeInstance();
  feed(inst, msgStart('m1'), line({
    type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'tu_1', description: 'bg', task_type: 'local_agent',
  }), result());
  assert.equal(inst.summary().displayStatus, 'running');
  statuses.length = 0;
  feed(inst, line({ type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'tu_1', status: 'completed', output_file: '' }));
  assert.ok(statuses.some(s => s.displayStatus === 'idle' && s.activeAgentTasks === 0));
});
