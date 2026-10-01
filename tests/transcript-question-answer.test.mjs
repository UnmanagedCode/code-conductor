// Disk parity for the AskUserQuestion answer stamp: a persisted jsonl session
// where an AskUserQuestion tool_use is followed by its answer line must replay
// with the same `questionAnswer` the live path stamps in Instance._emitUi
// (src/questionAnswerStamp.ts) — otherwise the dedicated answer bubble would
// exist live and regress to a plain "My answers:" bubble on reload.
//
// Fixtures use the PERSISTED shape (what the CLI writes to a jsonl).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';
import { encodeCwd, localPlace } from '../src/projects.ts';
import { loadPersistedTranscript } from '../src/transcript.ts';
import { AWAITING_INPUT_MESSAGE } from '../src/settings.ts';
import { MID_TURN_NOTE } from '../src/instances.ts';
import { formatUserQuestionAnswers, parseUserQuestionAnswers } from '../public/userQuestionAnswers.js';

const CWD = '/tmp/question-answer-project';
const SID = 'sess-question-answer';
const QUESTIONS = [{ question: 'Pick a fruit', header: 'Fruit', multiSelect: false,
  options: [{ label: 'Apple' }, { label: 'Banana' }] }];
const ANSWER = formatUserQuestionAnswers(QUESTIONS, [{ kind: 'option', label: 'Apple' }]);

const askLines = (questions = QUESTIONS) => [
  { type: 'user', uuid: 'u0', message: { role: 'user', content: 'go' } },
  { type: 'assistant', uuid: 'a0', message: { id: 'm_q', role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu_q', name: 'AskUserQuestion', input: { questions } }] } },
  { type: 'user', uuid: 'u1', message: { role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu_q', is_error: true, content: AWAITING_INPUT_MESSAGE }] } },
];

async function seed(lines) {
  const rootDir = await mkdtemp('cc-question-answer-');
  process.env.CLAUDE_PROJECTS_ROOT = rootDir;
  const file = path.join(rootDir, encodeCwd(CWD), `${SID}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

async function echoes() {
  const result = await loadPersistedTranscript({ place: localPlace(CWD), sessionId: SID });
  return result.lines.flatMap(l => l.events).filter(ev => ev.kind === 'user_echo');
}

test('replayed answer echo carries questionAnswer', async () => {
  await seed([...askLines(),
    { type: 'user', uuid: 'u2', message: { role: 'user', content: ANSWER } }]);
  const answer = (await echoes()).find(e => e.text === ANSWER);
  assert.ok(answer, 'the answer line replays as a user_echo');
  assert.equal(answer.questionAnswer?.toolUseId, 'tu_q');
  assert.deepEqual(answer.questionAnswer.questions, QUESTIONS);
});

test('a replayed hard-case answer recovers its exact structure from the text alone', async () => {
  const questions = [{ question: 'Is "x" ok?', header: 'X', multiSelect: false,
    options: [{ label: 'Fast — risky' }, { label: 'Slow — safe' }] }];
  const submitted = [{ kind: 'option', label: 'Slow — safe', note: 'thanks' }];
  const text = formatUserQuestionAnswers(questions, submitted);
  await seed([...askLines(questions),
    { type: 'user', uuid: 'u2', message: { role: 'user', content: text } }]);
  const answer = (await echoes()).find(e => e.text === text);
  assert.ok(answer, 'the answer line replays as a user_echo');
  assert.equal(answer.questionAnswer?.toolUseId, 'tu_q');
  assert.deepEqual(parseUserQuestionAnswers(answer.questionAnswer.questions, answer.text), submitted);
});

test('a mid-turn answer (MID_TURN_NOTE block + answer text) is still stamped', async () => {
  await seed([...askLines(),
    { type: 'user', uuid: 'u2', message: { role: 'user',
      content: [{ type: 'text', text: MID_TURN_NOTE }, { type: 'text', text: ANSWER }] } }]);
  const answer = (await echoes()).find(e => e.text === ANSWER);
  assert.ok(answer, 'the note block is dropped and the answer text remains');
  assert.equal(answer.questionAnswer?.toolUseId, 'tu_q');
});

test('a look-alike prompt line with no preceding question replays unstamped', async () => {
  await seed([
    { type: 'user', uuid: 'u0', message: { role: 'user', content: formatUserQuestionAnswers(
      [{ question: 'First?', options: [{ label: 'B' }] }, { question: 'Second?', options: [{ label: 'X' }] }],
      [{ kind: 'option', label: 'B' }, { kind: 'option', label: 'X' }]) } },
    { type: 'assistant', uuid: 'a0', message: { id: 'm_r', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    { type: 'user', uuid: 'u1', message: { role: 'user', content: ANSWER } },
  ]);
  const all = await echoes();
  assert.equal(all.length, 2);
  for (const e of all) assert.equal(e.questionAnswer, undefined, e.text);
});
