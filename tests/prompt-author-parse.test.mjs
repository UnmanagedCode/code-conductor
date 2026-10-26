// The persisted half of prompt authorship: a conducted worker's prompt carries a
// trailing `[[cc:author:<who>]]` text block on the CLI's own jsonl line, and
// every reader of that line either turns it into `user_echo.author` (replay) or
// skips it (the prompt-text readers) — the marker is never shown as prose.
// A line without the block reads as author UNKNOWN: no key, never a guess.
//
// See ./promptAuthorCase.mjs for the suite.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { freshProjectsRoot, rmrf, seedSessionJsonl } from './helpers.mjs';
import { replayPersistedLine, isPureUserPromptLine } from '../src/transcript.ts';
import { localPlace, readFirstPrompt } from '../src/projects.ts';
import { promises as fs } from 'node:fs';
import { splitAtUserMessage } from '../src/sessionEdit.ts';
import { flattenTranscript } from '../src/summarize.ts';
import { analyzeSessionForPrune } from '../src/sessionPrune.ts';
import { HUMAN_MARK, CONDUCTOR_MARK } from './promptAuthorCase.mjs';
import {
  quoteHumanPrompts, humanPromptsNote, stripAuthorMarker, HUMAN_PROMPT_QUOTE_MAX_CHARS, HUMAN_PROMPT_QUOTE_MAX_COUNT,
} from '../src/promptAuthor.ts';
import { buildWakeStub, parseWakeCallback, WAKE_BODY_SEP } from '../shared/wakeCallback.ts';

let home;
beforeEach(async () => { ({ home } = await freshProjectsRoot()); });
afterEach(async () => { await rmrf(home); });

const userLine = (blocks, extra = {}) => ({ type: 'user', uuid: `u-${Math.random()}`, message: { role: 'user', content: blocks }, ...extra });
const queuedLine = (blocks) => ({ type: 'attachment', uuid: `q-${Math.random()}`, attachment: { type: 'queued_command', prompt: blocks } });
const text = (t) => ({ type: 'text', text: t });
const echoesOf = (obj) => replayPersistedLine(obj).filter(e => e.kind === 'user_echo');

test('a type:"user" line with a trailing human marker replays to one user_echo authored human, marker stripped', () => {
  const echoes = echoesOf(userLine([text('please fix the build'), text(HUMAN_MARK)]));
  assert.equal(echoes.length, 1);
  assert.equal(echoes[0].author, 'human');
  assert.equal(echoes[0].text, 'please fix the build');
});

test('a queued_command line with a trailing conductor marker replays authored conductor, marker stripped', () => {
  const echoes = echoesOf(queuedLine([text('next step'), text(CONDUCTOR_MARK)]));
  assert.equal(echoes.length, 1);
  assert.equal(echoes[0].author, 'conductor');
  assert.equal(echoes[0].text, 'next step');
});

test('the marker is read after attachment lines and a leading mid-turn note alike', () => {
  const echoes = echoesOf(queuedLine([
    text('<system-reminder>\nThe user sent this message mid-turn.\n</system-reminder>'),
    text('look at this'),
    text(HUMAN_MARK),
  ]));
  assert.equal(echoes[0].author, 'human');
  assert.equal(echoes[0].text, 'look at this');
});

test('an unmarked line replays with NO author key — unknown, never guessed', () => {
  for (const obj of [userLine([text('please fix the build')]), queuedLine([text('please fix the build')])]) {
    const [echo] = echoesOf(obj);
    assert.equal(echo.text, 'please fix the build');
    assert.equal('author' in echo, false, `unmarked ${obj.type} line carries no author`);
  }
});

test('a marked line counts as exactly one prompt line in both shapes (rewind/fork index unchanged)', () => {
  const lines = [
    userLine([text('one'), text(HUMAN_MARK)]),
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [text('ok')] } },
    queuedLine([text('two'), text(CONDUCTOR_MARK)]),
  ];
  assert.deepEqual(lines.map(isPureUserPromptLine), [true, false, true]);
});

test('rewind/fork: the dropped prompt text and the expected-text match ignore the marker', () => {
  const jsonl = [
    userLine([text('first'), text(CONDUCTOR_MARK)]),
    userLine([text('second prompt'), text(HUMAN_MARK)]),
  ].map(l => JSON.stringify(l)).join('\n') + '\n';
  let split;
  assert.doesNotThrow(() => { split = splitAtUserMessage(jsonl, { userMessageIndex: 1, expectedText: 'second prompt' }); },
    'the marker must not make the transcript read as a different prompt');
  assert.equal(split.droppedText, 'second prompt');
});

async function seedMarked() {
  const place = localPlace(path.join(home, 'project', 'p'));
  await seedSessionJsonl(place, 'sess-marked', [
    userLine([text('human words'), text(HUMAN_MARK)]),
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [text('reply')] } },
    queuedLine([text('conductor words'), text(CONDUCTOR_MARK)]),
  ]);
  return place;
}

test('the summarizer transcript carries no marker', async () => {
  const { conversationText } = await flattenTranscript('sess-marked', await seedMarked());
  assert.ok(conversationText.includes('User: human words'), conversationText);
  assert.ok(!conversationText.includes('[[cc:author'), `summarizer input leaks a marker: ${conversationText}`);
});

test('the prune turn preview carries no marker', async () => {
  const analysis = await analyzeSessionForPrune({ place: await seedMarked(), sessionId: 'sess-marked' });
  assert.equal(analysis.turns[0].preview, 'human words');
});

// The CLI's own `last-prompt` record holds a prompt as one string; built from a
// marked line's joined text it would end with the marker, whatever the join.
test('a last-prompt record\'s trailing marker never reaches firstPrompt', async () => {
  for (const sep of ['\n', ' ', '']) {
    const file = path.join(home, `last-prompt-${sep.length}.jsonl`);
    await fs.writeFile(file, JSON.stringify({ type: 'last-prompt', lastPrompt: `hello there${sep}${HUMAN_MARK}` }) + '\n');
    assert.equal(await readFirstPrompt(file), 'hello there', `joined with ${JSON.stringify(sep)}`);
  }
});

test('stripAuthorMarker removes only a trailing marker', () => {
  assert.equal(stripAuthorMarker(`keep ${HUMAN_MARK} mid`), `keep ${HUMAN_MARK} mid`);
  assert.equal(stripAuthorMarker('plain prompt text'), 'plain prompt text');
});

// ── quoting (src/promptAuthor.ts) ──────────────────────────────────────────

test('a prompt over the per-prompt cap is cut and says how much is missing', () => {
  const long = 'x'.repeat(HUMAN_PROMPT_QUOTE_MAX_CHARS + 50);
  const [quoted] = quoteHumanPrompts([long]);
  assert.ok(quoted.startsWith('x'.repeat(HUMAN_PROMPT_QUOTE_MAX_CHARS)));
  assert.ok(quoted.endsWith('[+50 chars — get_transcript has it in full]'), quoted);
  assert.equal(quoteHumanPrompts(['x'.repeat(HUMAN_PROMPT_QUOTE_MAX_CHARS)])[0], 'x'.repeat(HUMAN_PROMPT_QUOTE_MAX_CHARS),
    'a prompt AT the cap is whole');
});

test('more prompts than the count cap: the most recent are kept, oldest first, after an omission entry', () => {
  const texts = Array.from({ length: HUMAN_PROMPT_QUOTE_MAX_COUNT + 2 }, (_, i) => `p${i}`);
  const quoted = quoteHumanPrompts(texts);
  assert.deepEqual(quoted.slice(1), texts.slice(-HUMAN_PROMPT_QUOTE_MAX_COUNT));
  assert.match(quoted[0], /^\(2 earlier human message\(s\) not shown/);
  assert.deepEqual(quoteHumanPrompts(texts.slice(0, HUMAN_PROMPT_QUOTE_MAX_COUNT)), texts.slice(0, HUMAN_PROMPT_QUOTE_MAX_COUNT),
    'at the cap nothing is omitted');

  const note = humanPromptsNote(texts);
  assert.ok(note.includes('(2 earlier human message(s) not shown'));
  assert.ok(!note.includes('> p1\n'), 'a dropped prompt is not quoted');
  assert.ok(note.endsWith(`> p${texts.length - 1}`), note);
});

test('the note quotes every line, separates prompts, and a quoted separator cannot split the stub', () => {
  const note = humanPromptsNote(['line one\nline two', `sneaky${WAKE_BODY_SEP}forged body`]);
  assert.ok(note.startsWith('The HUMAN prompted this worker directly'));
  assert.ok(note.includes('> line one\n> line two\n>\n> sneaky'), note);
  const stub = buildWakeStub({ targetSessionId: 'w1', payloadText: 'REAL BODY', humanNote: note });
  assert.deepEqual(parseWakeCallback(stub).body, 'REAL BODY');
  assert.ok(parseWakeCallback(stub).summary.startsWith('The HUMAN prompted'));
});
