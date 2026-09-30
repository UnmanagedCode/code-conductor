// Server side of the compaction bubble: the CLI's `compact_boundary` becomes one
// normalized `compaction` UI event on both surfaces (live stdout, replayed
// jsonl), and the injected summary's user_echo is stamped `compactSummary`
// while staying a counted, `userIndex`ed user_echo.
//
// Fixtures: `compaction-manual.*` are committed trims of one real CLI 2.1.284
// capture of a manual `/compact`: structural fields verbatim, the init frame's
// long arrays shortened, machine-specific paths/names scrubbed. `compaction-auto.*`
// are committed trims of one real CLI 2.1.284 auto-compaction (structural fields
// verbatim; tool-result bodies shortened, environment-dump attachments dropped,
// paths scrubbed; the instance id in the kept hook-callback URLs is a
// placeholder). In the stdout fixture each tool_use block's `input_json_delta`
// fragments were re-chunked from the scrubbed concatenation at the original
// fragment lengths (a path split across fragments cannot be scrubbed
// piecewise), so those frames differ from the capture in where the path text
// splits. The two differ in shape: the auto summary arrives as an ARRAY of text
// blocks on stdout but as a plain string in the jsonl; the manual one is a
// string on both.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, compactionEvent, isOuterUserEcho } from '../src/parser.ts';
import { replayPersistedLine, isPureUserPromptLine, loadPersistedTranscript } from '../src/transcript.ts';
import { stampArchiveEvents } from '../src/eventArchive.ts';
import { localPlace } from '../src/projects.ts';
import { freshProjectsRoot, seedSessionJsonl, rmrf } from './helpers.mjs';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readJsonl = async (name) =>
  (await fs.readFile(path.join(FX, name), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

const EXPECTED_COMPACTION = { trigger: 'manual', preTokens: 27152, postTokens: 2952, durationMs: 12099 };
const EXPECTED_AUTO_COMPACTION = { trigger: 'auto', preTokens: 183658, postTokens: 24338, durationMs: 37309 };
const pickMeta = ({ trigger, preTokens, postTokens, durationMs }) => ({ trigger, preTokens, postTokens, durationMs });
const SUMMARY_PREFIX = 'This session is being continued';

function liveEvents(frames) {
  const parser = new Parser();
  return frames.flatMap((f) => parser.handleObject(f));
}

test('live: the real boundary frame becomes one normalized `compaction` event and arms the summary stamp', async () => {
  const events = liveEvents(await readJsonl('compaction-manual.stdout.jsonl'));

  const compactions = events.filter((e) => e.kind === 'compaction');
  assert.equal(compactions.length, 1);
  assert.deepEqual(pickMeta(compactions[0]), EXPECTED_COMPACTION);
  assert.equal(events.some((e) => e.kind === 'system' && e.subtype === 'compact_boundary'), false,
    'the boundary is no longer a passthrough system event');

  const echoes = events.filter((e) => e.kind === 'user_echo');
  const summary = echoes.find((e) => e.text.startsWith(SUMMARY_PREFIX));
  assert.equal(summary.compactSummary, true);
  assert.equal(summary.cliInjected, true, 'the summary stays a CLI-injected echo');
  const stdout = echoes.find((e) => e.text.includes('<local-command-stdout>'));
  assert.equal(stdout.compactSummary, undefined);
});

test('replay: the persisted boundary and `isCompactSummary` line produce the same events as live', async () => {
  const live = liveEvents(await readJsonl('compaction-manual.stdout.jsonl'));
  const replayed = (await readJsonl('compaction-manual.transcript.jsonl')).flatMap((l) => replayPersistedLine(l));

  const compactions = replayed.filter((e) => e.kind === 'compaction');
  assert.equal(compactions.length, 1);
  assert.deepEqual(pickMeta(compactions[0]), EXPECTED_COMPACTION);
  assert.deepEqual(pickMeta(compactions[0]), pickMeta(live.find((e) => e.kind === 'compaction')),
    'snake_case stdout metadata and camelCase jsonl metadata normalize alike');

  const summary = replayed.find((e) => e.kind === 'user_echo' && e.text.startsWith(SUMMARY_PREFIX));
  assert.equal(summary.compactSummary, true);
  assert.equal(summary.cliInjected, true);
  assert.equal(summary.text, live.find((e) => e.kind === 'user_echo' && e.text.startsWith(SUMMARY_PREFIX)).text,
    'both surfaces carry the same summary text');
  const stamped = replayed.filter((e) => e.compactSummary);
  assert.equal(stamped.length, 1, 'only the summary line is stamped — not the command line or its stdout');
});

test('live auto: the real array-content summary frame is stamped', async () => {
  const events = liveEvents(await readJsonl('compaction-auto.stdout.jsonl'));

  const compactions = events.filter((e) => e.kind === 'compaction');
  assert.equal(compactions.length, 1);
  assert.deepEqual(pickMeta(compactions[0]), EXPECTED_AUTO_COMPACTION);
  assert.equal(events.some((e) => e.kind === 'system' && e.subtype === 'compact_boundary'), false,
    'the boundary is not a passthrough system event');

  const echoes = events.filter((e) => e.kind === 'user_echo');
  assert.equal(echoes.length, 1, 'the summary is the slice\'s only user echo');
  assert.ok(echoes[0].text.startsWith(SUMMARY_PREFIX));
  assert.equal(echoes[0].compactSummary, true);
  assert.equal(echoes[0].cliInjected, true, 'the summary stays a CLI-injected echo');

  const after = events.slice(events.indexOf(echoes[0]) + 1);
  assert.ok(after.some((e) => e.kind === 'message_start'), 'the turn continues after the summary');
  const result = after.find((e) => e.kind === 'tool_result');
  assert.equal(result.toolUseId, 'toolu_018NkZsSbNGTyofHVNhcTUJK');
  assert.equal(result.content, '  1897 total');
});

test('replay auto: the persisted boundary and summary produce the same events as live', async () => {
  const live = liveEvents(await readJsonl('compaction-auto.stdout.jsonl'));
  const lines = await readJsonl('compaction-auto.transcript.jsonl');
  const replayed = lines.flatMap((l) => replayPersistedLine(l));

  const compactions = replayed.filter((e) => e.kind === 'compaction');
  assert.equal(compactions.length, 1);
  assert.deepEqual(pickMeta(compactions[0]), EXPECTED_AUTO_COMPACTION);
  assert.deepEqual(pickMeta(compactions[0]), pickMeta(live.find((e) => e.kind === 'compaction')));

  const echoes = replayed.filter((e) => e.kind === 'user_echo');
  assert.equal(echoes.length, 1, 'the summary is the slice\'s only user echo');
  assert.equal(echoes[0].compactSummary, true);
  assert.equal(echoes[0].cliInjected, true);
  assert.equal(echoes[0].text, live.find((e) => e.kind === 'user_echo').text,
    'both surfaces carry the same summary text');

  const quiet = lines.filter((l) => l.type === 'last-prompt' || l.type === 'atis-latch'
    || (l.type === 'attachment' && ['date', 'deferred_tools_record'].includes(l.attachment?.type)));
  assert.ok(quiet.length >= 4, 'sanity: the slice keeps non-message lines between boundary and summary');
  for (const l of quiet) assert.deepEqual(replayPersistedLine(l), [], `${l.type} emits nothing`);
});

test('the boundary metadata is narrowed field by field', () => {
  assert.deepEqual(pickMeta(compactionEvent({ compact_metadata: { trigger: 'weird', pre_tokens: '5', post_tokens: NaN } })),
    { trigger: null, preTokens: null, postTokens: null, durationMs: null });
  assert.deepEqual(pickMeta(compactionEvent({})),
    { trigger: null, preTokens: null, postTokens: null, durationMs: null });
  assert.deepEqual(pickMeta(compactionEvent({ compactMetadata: { trigger: 'auto', preTokens: 9 } })),
    { trigger: 'auto', preTokens: 9, postTokens: null, durationMs: null });
});

test('the arm is one frame wide', async (t) => {
  const boundary = { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } };
  const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
  const summaryOf = (frames) => liveEvents(frames).filter((e) => e.kind === 'user_echo').at(-1);

  await t.test('control: a synthetic user frame directly after the boundary is stamped', () => {
    assert.equal(summaryOf([boundary, user('summary', { isSynthetic: true })]).compactSummary, true);
  });
  await t.test('a synthetic string user frame with no boundary before it is not stamped', () => {
    assert.equal(summaryOf([user('hook feedback', { isSynthetic: true })]).compactSummary, undefined);
  });
  await t.test('boundary, then a non-synthetic user frame, then a synthetic one: the later one is not stamped', () => {
    const echoes = liveEvents([boundary, user('typed'), user('hook feedback', { isSynthetic: true })])
      .filter((e) => e.kind === 'user_echo');
    assert.equal(echoes[0].compactSummary, undefined, 'a non-synthetic frame in the window is not the summary');
    assert.equal(echoes[1].compactSummary, undefined);
  });
  await t.test('boundary, then a result, then a synthetic frame: not stamped', () => {
    assert.equal(summaryOf([boundary, { type: 'result', subtype: 'success' }, user('late', { isSynthetic: true })])
      .compactSummary, undefined);
  });

  const blocks = (text) => [{ type: 'text', text }];
  await t.test('control: a synthetic ARRAY user frame directly after the boundary is stamped', () => {
    assert.equal(summaryOf([boundary, user(blocks('summary'), { isSynthetic: true })]).compactSummary, true);
  });
  await t.test('boundary, then a non-synthetic array user frame: not stamped', () => {
    assert.equal(summaryOf([boundary, user(blocks('typed'))]).compactSummary, undefined);
  });
  await t.test('boundary, then a non-synthetic array frame, then a synthetic one: the later one is not stamped', () => {
    const echoes = liveEvents([boundary, user(blocks('typed')), user(blocks('hook feedback'), { isSynthetic: true })])
      .filter((e) => e.kind === 'user_echo');
    assert.equal(echoes.length, 2);
    assert.equal(echoes[0].compactSummary, undefined);
    assert.equal(echoes[1].compactSummary, undefined, 'the arm was already spent on the first frame');
  });
});

test('the prompt-index space is unchanged by compaction', async () => {
  const lines = await readJsonl('compaction-manual.transcript.jsonl');
  for (const line of lines) {
    const echoes = replayPersistedLine(line).filter(isOuterUserEcho);
    assert.equal(echoes.length, isPureUserPromptLine(line) ? 1 : 0,
      `${line.type}/${line.subtype ?? ''}: one echo iff a counted prompt line`);
  }

  const { home } = await freshProjectsRoot();
  try {
    const place = localPlace('/workspace/compaction-index');
    const sid = '971de298-4d09-4fc1-8114-da27ce342593';
    await seedSessionJsonl(place, sid, lines);
    const result = await loadPersistedTranscript({ place, sessionId: sid, seqHint: 0 });
    const echoes = stampArchiveEvents(result.lines).filter(isOuterUserEcho);
    assert.deepEqual(echoes.map((e) => e.userIndex), [0, 1, 2, 3], 'contiguous ordinals across the boundary');
    const summary = echoes.find((e) => e.compactSummary);
    assert.equal(summary.userIndex, 1, 'the summary keeps its ordinal');
    assert.equal(echoes.find((e) => e.text.includes('<local-command-stdout>')).userIndex, 3,
      'the stdout line keeps its ordinal');
  } finally {
    await rmrf(home);
  }
});

test('auto: the prompt-index space is unchanged', async () => {
  const lines = await readJsonl('compaction-auto.transcript.jsonl');
  for (const line of lines) {
    const echoes = replayPersistedLine(line).filter(isOuterUserEcho);
    assert.equal(echoes.length, isPureUserPromptLine(line) ? 1 : 0,
      `${line.type}/${line.subtype ?? ''}: one echo iff a counted prompt line`);
  }
});
