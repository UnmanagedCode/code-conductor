// Unit tests for the turn-scoped default-count bond (Bug 2). Exercises
// ringTurnIndex + bondTrailingTurn directly on hand-built ring/message arrays —
// no server boot — so the turn-boundary edge (a plan in a PREVIOUS turn must not
// be pulled in) is pinned cheaply alongside the integration coverage in
// mcp-recent-bond.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ringTurnIndex, bondTrailingTurn } from '../src/mcp/messageReconstruction.js';

// Helper: build a text-bearing message stub.
const prose = (msgId, text) => ({ msgId, text });
const planMsg = (msgId, plan, text = '') => ({ msgId, text, plan });

test('bonds a plan + TWO trailing prose messages in the same turn', () => {
  const ring = [
    { kind: 'tool_use', msgId: 'm1', _seq: 1 },
    { kind: 'tool_result', _seq: 2 },
    { kind: 'text_delta', msgId: 'm2', _seq: 3 },
    { kind: 'text_delta', msgId: 'm3', _seq: 4 },
    { kind: 'turn_end', _seq: 5 },
  ];
  const filtered = [planMsg('m1', 'P'), prose('m2', 'first'), prose('m3', 'last')];
  const out = bondTrailingTurn(filtered, ringTurnIndex(ring));
  assert.deepEqual(out.map(m => m.msgId), ['m1', 'm2', 'm3']);
});

test('does NOT pull a plan from the previous turn', () => {
  const ring = [
    { kind: 'tool_use', msgId: 'p1', _seq: 1 },     // plan — turn 1
    { kind: 'text_delta', msgId: 'p2', _seq: 2 },   // prose — turn 1
    { kind: 'turn_end', _seq: 3 },
    { kind: 'text_delta', msgId: 'q1', _seq: 4 },   // pure prose — turn 2
    { kind: 'turn_end', _seq: 5 },
  ];
  const filtered = [planMsg('p1', 'P'), prose('p2', 'a'), prose('q1', 'b')];
  const out = bondTrailingTurn(filtered, ringTurnIndex(ring));
  assert.deepEqual(out.map(m => m.msgId), ['q1'], 'walk-back stops at the turn boundary');
});

test('a last message carrying its own plan is returned alone', () => {
  const ring = [
    { kind: 'text_delta', msgId: 'x1', _seq: 1 },
    { kind: 'tool_use', msgId: 'x2', _seq: 2 },
    { kind: 'turn_end', _seq: 3 },
  ];
  const filtered = [prose('x1', 'earlier'), planMsg('x2', 'P', 'here is my plan')];
  const out = bondTrailingTurn(filtered, ringTurnIndex(ring));
  assert.deepEqual(out.map(m => m.msgId), ['x2']);
});

test('no bonding when the current turn has no plan/question', () => {
  const ring = [
    { kind: 'text_delta', msgId: 'a1', _seq: 1 },
    { kind: 'text_delta', msgId: 'a2', _seq: 2 },
    { kind: 'turn_end', _seq: 3 },
  ];
  const filtered = [prose('a1', 'one'), prose('a2', 'two')];
  const out = bondTrailingTurn(filtered, ringTurnIndex(ring));
  assert.deepEqual(out.map(m => m.msgId), ['a2']);
});

test('bonds a split plan + single trailing prose (the original one-step case still works)', () => {
  const ring = [
    { kind: 'tool_use', msgId: 's1', _seq: 1 },
    { kind: 'text_delta', msgId: 's2', _seq: 2 },
    { kind: 'turn_end', _seq: 3 },
  ];
  const filtered = [planMsg('s1', 'P'), prose('s2', 'standing by')];
  const out = bondTrailingTurn(filtered, ringTurnIndex(ring));
  assert.deepEqual(out.map(m => m.msgId), ['s1', 's2']);
});

test('questions (not just plans) also bond through the end of the turn', () => {
  const ring = [
    { kind: 'tool_use', msgId: 'q1', _seq: 1 },
    { kind: 'text_delta', msgId: 'q2', _seq: 2 },
    { kind: 'turn_end', _seq: 3 },
  ];
  const filtered = [
    { msgId: 'q1', text: '', questions: [{ question: 'Which?', options: [] }] },
    prose('q2', 'waiting'),
  ];
  const out = bondTrailingTurn(filtered, ringTurnIndex(ring));
  assert.deepEqual(out.map(m => m.msgId), ['q1', 'q2']);
});
