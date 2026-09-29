// QuestionAnswerCorrelator (src/questionAnswerStamp.ts): pairs the outer
// user_echo answering an AskUserQuestion card with that card and stamps it
// `questionAnswer: {toolUseId, questions}` — the signal the answer bubble renders
// from. Correlation, never text alone: the CLI jsonl stores only the answer
// text, so nothing else exists identically live and on replay.
//
// Two layers: the pure correlator, then a bare Instance to pin the _emitUi
// wiring (stamp lands on the ring/feed object; a resume wipe drops the slot).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { QuestionAnswerCorrelator } from '../src/questionAnswerStamp.ts';
import { Instance } from '../src/instances.ts';

const ONE = [{ question: 'Pick a fruit', header: 'Fruit', multiSelect: false,
  options: [{ label: 'Apple' }, { label: 'Banana' }] }];
const TWO = [
  { question: 'First?', options: [{ label: 'A' }, { label: 'B' }] },
  { question: 'Second?', options: [{ label: 'X' }, { label: 'Y' }] },
];
const SINGLE_ANSWER = 'Answer to "Pick a fruit": Apple';
const MULTI_ANSWER = 'My answers:\n- First?: B\n- Second?: X';

const uq = (questions, toolUseId = 'tu_q', extra = {}) => ({ kind: 'user_question', toolUseId, questions, ...extra });
const echo = (text, extra = {}) => ({ kind: 'user_echo', text, ...extra });

test('stamps the outer echo answering the pending question (single and multi forms)', () => {
  const c = new QuestionAnswerCorrelator();
  c.apply(uq(ONE));
  const single = echo(SINGLE_ANSWER);
  c.apply(single);
  assert.deepEqual(single.questionAnswer, { toolUseId: 'tu_q', questions: ONE });

  c.apply(uq(TWO, 'tu_two'));
  const multi = echo(MULTI_ANSWER);
  c.apply(multi);
  assert.deepEqual(multi.questionAnswer, { toolUseId: 'tu_two', questions: TWO });
});

test('a "My answers:" look-alike with no pending question is not stamped', () => {
  const c = new QuestionAnswerCorrelator();
  const lookAlike = echo(MULTI_ANSWER);
  c.apply(lookAlike);
  assert.equal(lookAlike.questionAnswer, undefined);
  // Also after a consumed question: the slot is empty again.
  c.apply(uq(TWO));
  c.apply(echo(MULTI_ANSWER));
  const later = echo(MULTI_ANSWER);
  c.apply(later);
  assert.equal(later.questionAnswer, undefined);
});

test('a non-matching echo between question and answer is not stamped and leaves the slot armed', () => {
  const c = new QuestionAnswerCorrelator();
  c.apply(uq(ONE));
  const wake = echo('Worker `abc12345` finished its turn. Call get_recent_messages to inspect the result.');
  c.apply(wake);
  assert.equal(wake.questionAnswer, undefined);
  const answer = echo(SINGLE_ANSWER);
  c.apply(answer);
  assert.equal(answer.questionAnswer?.toolUseId, 'tu_q', 'the later matching echo still pairs');
});

test('the slot is consumed: a second matching echo is not stamped', () => {
  const c = new QuestionAnswerCorrelator();
  c.apply(uq(ONE));
  c.apply(echo(SINGLE_ANSWER));
  const second = echo(SINGLE_ANSWER);
  c.apply(second);
  assert.equal(second.questionAnswer, undefined);
});

test('the last pending outer question wins', () => {
  const c = new QuestionAnswerCorrelator();
  c.apply(uq(ONE, 'tu_old'));
  c.apply(uq(TWO, 'tu_new'));
  const stale = echo(SINGLE_ANSWER);
  c.apply(stale);
  assert.equal(stale.questionAnswer, undefined, 'an answer to the superseded question does not pair');
  const fresh = echo(MULTI_ANSWER);
  c.apply(fresh);
  assert.equal(fresh.questionAnswer?.toolUseId, 'tu_new');
});

test('a sub-agent user_question is not tracked', () => {
  const c = new QuestionAnswerCorrelator();
  c.apply(uq(ONE, 'tu_sub', { parentToolUseId: 'tu_agent' }));
  const answer = echo(SINGLE_ANSWER);
  c.apply(answer);
  assert.equal(answer.questionAnswer, undefined);
});

test('a user_question with no questions arms nothing', () => {
  const c = new QuestionAnswerCorrelator();
  c.apply(uq([]));
  c.apply({ kind: 'user_question', toolUseId: 'tu_x' });
  const answer = echo(SINGLE_ANSWER);
  c.apply(answer);
  assert.equal(answer.questionAnswer, undefined);
});

test('cliInjected / skillLoad / sub-agent echoes are never stamped and do not consume the slot', () => {
  const c = new QuestionAnswerCorrelator();
  c.apply(uq(ONE));
  for (const extra of [{ cliInjected: true }, { skillLoad: { skill: 's' } }, { parentToolUseId: 'tu_agent' }]) {
    const e = echo(SINGLE_ANSWER, extra);
    c.apply(e);
    assert.equal(e.questionAnswer, undefined, JSON.stringify(extra));
  }
  const real = echo(SINGLE_ANSWER);
  c.apply(real);
  assert.equal(real.questionAnswer?.toolUseId, 'tu_q', 'the slot survived all three');
});

test('an already-stamped echo consumes the slot without restamping', () => {
  const c = new QuestionAnswerCorrelator();
  c.apply(uq(ONE, 'tu_q'));
  const stamp = { toolUseId: 'tu_disk', questions: ONE };
  const stamped = echo(SINGLE_ANSWER, { questionAnswer: stamp });
  c.apply(stamped);
  assert.ok(stamped.questionAnswer === stamp, 'the disk stamp is kept as-is');
  const next = echo(SINGLE_ANSWER);
  c.apply(next);
  assert.equal(next.questionAnswer, undefined, 'the slot was consumed by the stamped echo');
});

async function makeInstance() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-qa-stamp-'));
  const inst = new Instance({
    id: 'inst-qa', project: 'demo', cwd, mode: 'bypassPermissions',
    effort: 'medium', thinking: 'medium', model: 'claude-haiku-4-5',
  });
  inst.sessionId = 'sess-qa';
  inst.backingSessionId = 'sess-qa';
  const emitted = [];
  inst.on('event', (ev) => emitted.push(ev));
  return { inst, emitted, cwd };
}

test('_emitUi stamps before ring.push: ring event and emitted event are the same stamped object', async () => {
  const { inst, emitted, cwd } = await makeInstance();
  try {
    inst._emitUi(uq(ONE));
    inst._emitUi(echo(SINGLE_ANSWER));
    const fed = emitted.find(e => e.kind === 'user_echo');
    const ringed = inst.ring.toArray().find(e => e.kind === 'user_echo');
    assert.equal(fed.questionAnswer?.toolUseId, 'tu_q');
    assert.ok(fed === ringed, 'one object, so the stamp reaches both the ring and the live frame');
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

test('_wipeForResume drops a pending question', async () => {
  const { inst, emitted, cwd } = await makeInstance();
  try {
    inst._emitUi(uq(ONE));
    inst._wipeForResume();
    inst._emitUi(echo(SINGLE_ANSWER));
    const answer = emitted.find(e => e.kind === 'user_echo');
    assert.equal(answer.questionAnswer, undefined);
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

test('a segment rotation (system/init with a new session id) drops a pending question', async () => {
  const { inst, emitted, cwd } = await makeInstance();
  try {
    // No public id: the rotation branch then kicks no durable lineage write.
    inst.sessionId = null;
    inst._emitUi(uq(ONE));
    inst._handleStdoutLine(JSON.stringify({
      type: 'system', subtype: 'init', session_id: 'sess-rotated', model: 'claude-haiku-4-5',
    }));
    assert.equal(inst.backingSessionId, 'sess-rotated', 'premise: the init was a rotation');
    inst._emitUi(echo(SINGLE_ANSWER));
    const answer = emitted.find(e => e.kind === 'user_echo');
    assert.equal(answer.questionAnswer, undefined,
      'an answer in the new segment must not pair with a card from the old file, as on reload');
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});
