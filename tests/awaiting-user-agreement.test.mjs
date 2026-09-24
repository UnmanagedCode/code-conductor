// NO FLIP ON RESTART: for each real-shaped fixture pair under
// tests/fixtures/awaiting-user/, the live feed (the CLI's stdout through Parser
// and LiveAskFacts) and the disk feed (deriveAwaitingUser over what the CLI
// persisted for the same conversation) reduce to the SAME awaitingUser. A
// session's flag therefore reads the same before a restart (live) and after it
// (hydrated from the transcript).
//
// Fixture format. `<case>.stdout.jsonl` is the CLI's stdout, plus lines
// `{"cc":"prompt"|"effort","text":…}` standing for Instance.prompt() /
// setEffort(), which emit the user_echo the CLI itself never echoes.
// `<case>.transcript.jsonl` is what the CLI wrote, one file per segment, each
// segment introduced by a `{"cc_segment":"<backing id>"}` line.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from '../src/parser.ts';
import { replayPersistedLine } from '../src/transcript.ts';
import { LiveAskFacts, reduceAsk } from '../src/awaitingUser.ts';
import { deriveAwaitingUser } from '../src/awaitingUserTranscript.ts';
import { localPlace } from '../src/projects.ts';
import { freshProjectsRoot, seedSessionJsonl, rmrf } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures', 'awaiting-user');

// What each conversation is waiting on at its end — pinned so agreement can't
// pass by both feeds being wrong the same way.
const EXPECTED = {
  'text-ask-per-block': { kind: 'question', source: 'text' },
  'tool-ask-survives-injected': { kind: 'question', source: 'tool' },
  'queued-real-clears': null,
  'renew-two-segments': { kind: 'question', source: 'text' },
  'sidechain-inline': null,
  'compaction-keeps-ask': { kind: 'question', source: 'text' },
  'plan-pending': { kind: 'plan', source: 'tool' },
};

let home;
before(async () => { ({ home } = await freshProjectsRoot()); });
after(async () => { await rmrf(home); });

const readJsonl = async (f) => (await fs.readFile(f, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));

function liveState(stdoutLines) {
  const parser = new Parser();
  const live = new LiveAskFacts(() => false);
  let state = null;
  let idle = true;
  const feed = (ev) => {
    // Instance._setStatus calls onTurnStart on every idle→turn transition:
    // prompt() for a prompted turn, message_start for an unprompted one.
    if (idle && (ev.kind === 'user_echo' || ev.kind === 'message_start')) { live.onTurnStart(); idle = false; }
    for (const f of live.feed(ev)) state = reduceAsk(state, f);
    if (ev.kind === 'turn_end') idle = true;
  };
  for (const line of stdoutLines) {
    if (line.cc === 'prompt' || line.cc === 'effort') {
      feed({ kind: 'user_echo', text: line.text, attachments: [], parentToolUseId: null });
      continue;
    }
    for (const ev of parser.handleObject(line)) feed(ev);
  }
  return state;
}

async function seedSegments(cwd, transcriptLines) {
  const segments = [];
  for (const line of transcriptLines) {
    if (line.cc_segment) segments.push({ id: line.cc_segment, lines: [] });
    else segments.at(-1).lines.push(line);
  }
  const place = localPlace(cwd);
  for (const s of segments) await seedSessionJsonl(place, s.id, s.lines);
  return { place, ids: segments.map(s => s.id) };
}

test('every fixture pair: the live feed and the transcript scan agree on awaitingUser', async (t) => {
  const cases = (await fs.readdir(FIXTURES)).filter(f => f.endsWith('.stdout.jsonl')).map(f => f.replace('.stdout.jsonl', ''));
  assert.deepEqual(cases.sort(), Object.keys(EXPECTED).sort(), 'every fixture pair has a pinned expectation');
  for (const name of cases) {
    await t.test(name, async () => {
      const live = liveState(await readJsonl(path.join(FIXTURES, `${name}.stdout.jsonl`)));
      const { place, ids } = await seedSegments(`/workspace/agree-${name}`,
        await readJsonl(path.join(FIXTURES, `${name}.transcript.jsonl`)));
      const disk = await deriveAwaitingUser(place, ids);
      assert.deepEqual(live, EXPECTED[name], 'live feed');
      assert.deepEqual(disk, live, 'the transcript scan equals the live feed');
    });
  }
});

test('cliInjected parity: an isSynthetic stdout line and an isMeta / isVisibleInTranscriptOnly jsonl line stamp alike', async (t) => {
  const content = [{ type: 'text', text: 'Base directory for this skill: /skills/x' }];
  const liveEcho = (obj) => new Parser().handleObject(obj).find(e => e.kind === 'user_echo');
  const diskEcho = (obj) => replayPersistedLine(obj).find(e => e.kind === 'user_echo');
  await t.test('array content', () => {
    assert.equal(liveEcho({ type: 'user', message: { role: 'user', content }, isSynthetic: true }).cliInjected, true);
    assert.equal(diskEcho({ type: 'user', message: { role: 'user', content }, isMeta: true }).cliInjected, true);
    assert.equal(diskEcho({ type: 'user', message: { role: 'user', content }, isMeta: true, sourceToolUseID: 'toolu_x' }).cliInjected, true,
      'a skill injection with no pending Skill tool_use to match still stamps');
  });
  await t.test('string content (a compaction continuation)', () => {
    const text = 'This session is being continued from a previous conversation.';
    assert.equal(liveEcho({ type: 'user', message: { role: 'user', content: text }, isSynthetic: true }).cliInjected, true);
    assert.equal(diskEcho({ type: 'user', message: { role: 'user', content: text }, isCompactSummary: true, isVisibleInTranscriptOnly: true }).cliInjected, true);
  });
  await t.test('a plain user line stamps nothing on either surface', () => {
    assert.equal(liveEcho({ type: 'user', message: { role: 'user', content } }).cliInjected, undefined);
    assert.equal(diskEcho({ type: 'user', message: { role: 'user', content } }).cliInjected, undefined);
  });
});
