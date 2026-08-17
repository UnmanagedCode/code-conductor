// Pins that buildMessageFromRing's TWO hoisting paths — the delta path (raw
// `tool_use` ring events) and the reconciled path (`assistant_message`
// envelopes) — agree exactly, now that both go through one
// hoistPlanAndQuestions helper (card 2026-0095). A pure unit test over
// reconstructMessages: no server boot.
//
// The table cases build the same logical message BOTH ways and assert the two
// reconstructions are deepEqual — the two passes number segments on
// independent counters that both start at 0, so a correct implementation
// yields identical objects.
//
// The three non-table cases at the bottom pin the state-sharing rules that a
// plausible-looking rewiring would break: one shared hoist target but two
// independent seq counters, a per-CALL `hoisted` flag, and the -1 textSeq
// sentinel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconstructMessages } from '../src/mcp/messageReconstruction.ts';

const MSG = 'm1';

// A segment spec is {t:'text', text} or {t:'tool', name, input, id}.
// Both builders turn the same spec list into a ring for one message.

function deltaRing(segments, planRequests = []) {
  let seq = 0;
  const ring = planRequests.map(pr => ({ kind: 'plan_request', toolUseId: pr.id, planPath: pr.planPath, ...(pr.plan ? { plan: pr.plan } : {}), _seq: seq++ }));
  segments.forEach((s, i) => {
    if (s.t === 'text') ring.push({ kind: 'text_delta', msgId: MSG, blockIdx: i, text: s.text, _seq: seq++ });
    else ring.push({ kind: 'tool_use', msgId: MSG, name: s.name, input: s.input, toolUseId: s.id, _seq: seq++ });
  });
  return ring;
}

function envelopeRing(segments, planRequests = []) {
  let seq = 0;
  const ring = planRequests.map(pr => ({ kind: 'plan_request', toolUseId: pr.id, planPath: pr.planPath, ...(pr.plan ? { plan: pr.plan } : {}), _seq: seq++ }));
  const content = segments.map(s => (s.t === 'text'
    ? { type: 'text', text: s.text }
    : { type: 'tool_use', name: s.name, input: s.input, id: s.id }));
  ring.push({ kind: 'assistant_message', msgId: MSG, message: { content }, _seq: seq++ });
  return ring;
}

const only = (ring) => {
  const msgs = reconstructMessages(ring, false);
  assert.equal(msgs.length, 1, 'exactly one reconstructed message');
  return msgs[0];
};

const PLAN = { t: 'tool', name: 'ExitPlanMode', input: { plan: 'the plan body' }, id: 'tu-plan' };
const QUESTIONS = [{ question: 'which?', header: 'Pick', options: [{ label: 'a', description: 'A' }] }];
const ASK = { t: 'tool', name: 'AskUserQuestion', input: { questions: QUESTIONS }, id: 'tu-ask' };

const CASES = [
  {
    name: 'ExitPlanMode with an inline input.plan hoists to plan + planSeq',
    segments: [PLAN],
    expect: m => {
      assert.equal(m.plan, 'the plan body');
      assert.equal(m.planSeq, 0);
      assert.equal(m.planPath, undefined);
      assert.equal(m.blocks, undefined, 'the hoisted block is NOT duplicated in blocks[]');
      assert.equal(m.hasToolUse, true);
    },
  },
  {
    name: 'AskUserQuestion with a non-empty questions array hoists to questions + questionsSeq',
    segments: [ASK],
    expect: m => {
      assert.deepEqual(m.questions, QUESTIONS);
      assert.equal(m.questionsSeq, 0);
      assert.equal(m.blocks, undefined, 'the hoisted block is NOT duplicated in blocks[]');
    },
  },
  {
    // The subtlest branch: the join key differs between the two paths
    // (ev.toolUseId vs block.id), so this is where a rewiring slip shows up.
    name: 'path-only hoist — empty input plus a plan_request join sets planPath, not plan',
    segments: [{ t: 'tool', name: 'ExitPlanMode', input: {}, id: 'tu-pathonly' }],
    planRequests: [{ id: 'tu-pathonly', planPath: '/plans/some-plan.md' }],
    expect: m => {
      assert.equal(m.planPath, '/plans/some-plan.md');
      assert.equal(m.plan, undefined, 'no inline text and no enriched plan ⇒ no plan field');
      assert.equal(m.planSeq, 0, 'a path-only hoist still stamps planSeq');
      assert.equal(m.blocks, undefined, 'a path-only hoist still keeps the block out of blocks[]');
    },
  },
  {
    name: 'text then plan → textSeq 0, planSeq 1',
    segments: [{ t: 'text', text: 'here is my plan:' }, PLAN],
    expect: m => {
      assert.equal(m.text, 'here is my plan:');
      assert.equal(m.textSeq, 0);
      assert.equal(m.planSeq, 1);
    },
  },
  {
    name: 'plan then text → planSeq 0, textSeq 1',
    segments: [PLAN, { t: 'text', text: 'and some words after' }],
    expect: m => {
      assert.equal(m.text, 'and some words after');
      assert.equal(m.planSeq, 0);
      assert.equal(m.textSeq, 1);
    },
  },
  {
    name: 'AskUserQuestion with an EMPTY questions array is not hoisted',
    segments: [{ t: 'tool', name: 'AskUserQuestion', input: { questions: [] }, id: 'tu-empty' }],
    expect: m => {
      assert.equal(m.questions, undefined);
      assert.equal(m.questionsSeq, undefined, 'nothing hoisted ⇒ no questionsSeq');
      assert.deepEqual(m.blocks, [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [] }, toolUseId: 'tu-empty' }]);
    },
  },
  {
    name: 'a plain tool is never hoisted and lands in blocks[]',
    segments: [{ t: 'tool', name: 'Read', input: { file_path: '/x.ts' }, id: 'tu-read' }],
    expect: m => {
      assert.equal(m.plan, undefined);
      assert.equal(m.questions, undefined);
      assert.deepEqual(m.blocks, [{ type: 'tool_use', name: 'Read', input: { file_path: '/x.ts' }, toolUseId: 'tu-read' }]);
    },
  },
  {
    name: 'text + ExitPlanMode + AskUserQuestion stamp 0/1/2 in arrival order',
    segments: [{ t: 'text', text: 'prose' }, PLAN, ASK],
    expect: m => {
      assert.equal(m.textSeq, 0);
      assert.equal(m.planSeq, 1);
      assert.equal(m.questionsSeq, 2);
      assert.equal(m.plan, 'the plan body');
      assert.deepEqual(m.questions, QUESTIONS);
      assert.equal(m.blocks, undefined, 'neither hoisted block is duplicated in blocks[]');
    },
  },
];

for (const c of CASES) {
  test(`hoist parity — ${c.name}`, () => {
    const fromDelta = only(deltaRing(c.segments, c.planRequests));
    const fromEnvelope = only(envelopeRing(c.segments, c.planRequests));
    c.expect(fromDelta);
    c.expect(fromEnvelope);
    assert.deepEqual(fromDelta, fromEnvelope, 'the delta path and the reconciled path must agree exactly');
  });
}

// --- state-sharing rules the parity table alone cannot see -------------------

// One shared hoist target, TWO independent counters. If the two passes shared
// one counter this would report planSeq 0 / textSeq 1; if each pass had its own
// hoist target the reconciled return would carry no `plan` at all.
test('delta-hoisted plan survives a text-only reconciled envelope, WITHOUT a planSeq', () => {
  const m = only([
    { kind: 'tool_use', msgId: MSG, name: 'ExitPlanMode', input: { plan: 'P' }, toolUseId: 'tu1', _seq: 0 },
    { kind: 'assistant_message', msgId: MSG, message: { content: [{ type: 'text', text: 'prose' }] }, _seq: 1 },
  ]);
  assert.equal(m.plan, 'P', 'plan/planPath/questions are SHARED across the two passes');
  assert.equal(m.planSeq, undefined, 'the seq counters are NOT shared — the reconciled pass never hoisted');
  assert.equal(m.textSeq, 0, "the reconciled pass's counter starts fresh at 0");
  assert.equal(m.text, 'prose');
});

// `hoisted` is per CALL, never `!!out.plan`. The delta pass fills plan; the
// reconciled pass then sees an ExitPlanMode with neither inline text nor a
// plan_request join, so that block IS pushed into blocks[].
test('an unhoistable ExitPlanMode still lands in blocks[] even when plan is already set', () => {
  const m = only([
    { kind: 'tool_use', msgId: MSG, name: 'ExitPlanMode', input: { plan: 'P' }, toolUseId: 'tu1', _seq: 0 },
    { kind: 'assistant_message', msgId: MSG, message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', input: {}, id: 'tu2' }] }, _seq: 1 },
  ]);
  assert.equal(m.plan, 'P');
  assert.deepEqual(m.blocks, [{ type: 'tool_use', name: 'ExitPlanMode', input: {}, toolUseId: 'tu2' }],
    'the hoist verdict is per call — not derived from the shared hoist target');
  assert.equal(m.planSeq, undefined);
});

// The -1 sentinel: envelopes carried no text block but deltas streamed one, so
// the delta text is preferred and pinned BELOW every position on the reconciled
// counter (which starts at 0).
test('a delta text block recovered under a reconciled plan gets textSeq -1', () => {
  const m = only([
    { kind: 'text_delta', msgId: MSG, blockIdx: 0, text: 'streamed prose', _seq: 0 },
    { kind: 'assistant_message', msgId: MSG, message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'P' }, id: 'tu1' }] }, _seq: 1 },
  ]);
  assert.equal(m.text, 'streamed prose');
  assert.equal(m.textSeq, -1, 'pinned below any reconciled-counter position');
  assert.equal(m.planSeq, 0);
  assert.ok(m.textSeq < m.planSeq, 'the recovered prose still sorts before the plan');
});
