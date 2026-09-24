// Pure-node tests for public/renewSeed.js — the DOM-free module shared by
// src/sessionRenew.ts (build) and public/conversation.js + foldedText.js
// (parse) for the renew_session reseed text. No DOM involved: this pins the
// parsing/splitting logic in isolation from the bubble it feeds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRenewSeed, parseRenewSeed, splitSummarySections, RENEW_SUMMARY_SECTIONS,
  MECHANICAL_STATE_HEADER,
} from '../public/renewSeed.js';
import { buildWakeStub } from '../public/wakeCallback.js';
import { RENEW_SUMMARY_TEMPLATE } from '../src/sessionRenew.ts';

const S = RENEW_SUMMARY_SECTIONS;

// parseRenewSeed's `state` is the CONTENT after the mechanical-state header,
// not the header-inclusive block buildStateBlock produces — the UI already
// labels that section, so the header text would just duplicate the label.
function stateContentOf(stateBlock) {
  const after = stateBlock.slice(MECHANICAL_STATE_HEADER.length);
  return after.startsWith('\n') ? after.slice(1) : after;
}

test('parseRenewSeed round-trips buildRenewSeed with summary, followUp and state', () => {
  const stateBlock = '--- MECHANICAL STATE (server-generated at renewal; safety net — if this '
    + 'disagrees with your summary above, this list wins for EXISTENCE, the summary wins for '
    + 'INTENT) ---\nLive instances you spawned:\n  (none)\nWorkers you own (their next turn wakes '
    + 'you):\n  (none)';
  const seed = buildRenewSeed({
    summary: 'HANDOFF-XYZ: finish task Q',
    followUp: 'MARK-D: keep going',
    stateBlock,
  });
  const parsed = parseRenewSeed(seed);
  assert.ok(parsed, 'a built seed parses');
  assert.equal(parsed.summary, 'HANDOFF-XYZ: finish task Q');
  assert.equal(parsed.followUp, 'MARK-D: keep going');
  assert.equal(parsed.state, stateContentOf(stateBlock));
});

test('parseRenewSeed yields followUp null when no follow-up fence was built', () => {
  const seed = buildRenewSeed({ summary: 'just a summary, no directive' });
  const parsed = parseRenewSeed(seed);
  assert.ok(parsed);
  assert.equal(parsed.followUp, null);
  assert.equal(parsed.state, null);
  assert.equal(parsed.summary, 'just a summary, no directive');
});

test('parseRenewSeed returns null for an ordinary prompt, a wake stub and a forward-framed prompt', () => {
  assert.equal(parseRenewSeed('please fix the bug in foo.ts'), null, 'ordinary prompt');

  const wakeStub = buildWakeStub({ targetSessionId: 'abc12345', payloadText: 'line1\nline2' });
  assert.equal(parseRenewSeed(wakeStub), null, 'wake stub');

  // Quotes the fence text but is missing the leading preamble.
  const fakeQuote = '--- HANDOFF SUMMARY ---\nsomeone pasted this fence without the preamble';
  assert.equal(parseRenewSeed(fakeQuote), null, 'fence text with no leading preamble');

  // Text carrying the seed prefix at a non-zero index — e.g. inside a
  // send_prompt({forward}) frame's header-then-body shape — is never
  // detected, since parseRenewSeed requires the prefix at offset 0. The
  // `--- message 1/1 ---` line below is illustrative framing only:
  // send_prompt({forward}) relays assistant messages, so this exact payload
  // (a user-turn seed embedded inside it) cannot occur for real.
  const innerSeed = buildRenewSeed({ summary: 'a handoff summary embedded mid-text' });
  const forwardFrame = '--- FORWARDED WORKER OUTPUT (verbatim · context only) ---\n'
    + '--- message 1/1 ---\n' + innerSeed + '\n--- END FORWARDED WORKER OUTPUT ---\n\nplease review this';
  assert.equal(parseRenewSeed(forwardFrame), null, 'seed prefix at a non-zero index is not detected');

  assert.equal(parseRenewSeed(null), null, 'non-string input');
  assert.equal(parseRenewSeed(undefined), null, 'undefined input');
});

test('parseRenewSeed splits on the last mechanical-state header so a summary quoting it stays in the summary', () => {
  const stateBlock = '--- MECHANICAL STATE (server-generated at renewal; safety net — if this '
    + 'disagrees with your summary above, this list wins for EXISTENCE, the summary wins for '
    + 'INTENT) ---\nLive instances you spawned:\n  (none)\nWorkers you own (their next turn wakes '
    + 'you):\n  (none)';
  const summaryQuotingHeader =
    'Before the clear my summary quoted the mechanical state marker itself:\n\n'
    + '--- MECHANICAL STATE (server-generated at renewal; safety net — if this disagrees with your '
    + 'summary above, this list wins for EXISTENCE, the summary wins for INTENT) ---\n'
    + 'this quoted line is part of the summary, not a real state block';
  const seed = buildRenewSeed({ summary: summaryQuotingHeader, stateBlock });
  const parsed = parseRenewSeed(seed);
  assert.ok(parsed);
  assert.equal(parsed.summary, summaryQuotingHeader, 'the quoted header stayed inside the summary');
  assert.equal(parsed.state, stateContentOf(stateBlock), 'the real (last) state block was split off correctly');
});

// A followUp is searched for only when a real state block was found — never
// in a state-less seed, since there a real followUp and a summary that merely
// quotes the fence text are byte-identical (buildRenewSeed trims and joins
// both the same way), and a state-less seed with a real followUp does not
// occur in production (buildStateBlock is always built before buildRenewSeed
// is called). This is the one shape that guard actually fixes: with a state
// block present, a lone mid-summary quote is still indistinguishable from a
// real followUp and still gets split off — every position a match could
// occur at is equally consistent with buildRenewSeed's own output, so no
// text-only check can tell them apart. That residual case is accepted, not
// pinned by a test — see public/renewSeed.js's parseRenewSeed comment.
test('parseRenewSeed splits the follow-up at the LAST fence, not the first, when the summary also quotes it', () => {
  const stateBlock = '--- MECHANICAL STATE (server-generated at renewal; safety net — if this '
    + 'disagrees with your summary above, this list wins for EXISTENCE, the summary wins for '
    + 'INTENT) ---\nLive instances you spawned:\n  (none)\nWorkers you own (their next turn wakes '
    + 'you):\n  (none)';
  const summaryQuotingFollowUp =
    'Earlier I quoted the fence format for reference:\n\n'
    + '--- YOUR CONDUCTOR\'S FOLLOW-UP DIRECTIVE ---\n'
    + 'This quoted example line should stay part of the summary, not be mistaken for the real one.';
  const seed = buildRenewSeed({
    summary: summaryQuotingFollowUp,
    followUp: 'MARK-D: the real directive text',
    stateBlock,
  });
  const parsed = parseRenewSeed(seed);
  assert.ok(parsed);
  assert.equal(parsed.summary, summaryQuotingFollowUp, 'the whole summary, quote included, stayed intact');
  assert.equal(parsed.followUp, 'MARK-D: the real directive text', 'the LAST (real) fence was used, not the quoted first one');
  assert.equal(parsed.state, stateContentOf(stateBlock));
});

test('parseRenewSeed never splits a follow-up out of a state-less seed, even when the summary quotes the fence verbatim', () => {
  const summaryQuotingFollowUp =
    'Notes: quoting the follow-up fence text below because that is what the conductor asked for:\n\n'
    + '--- YOUR CONDUCTOR\'S FOLLOW-UP DIRECTIVE ---\n'
    + 'This quoted text should stay part of the summary, not become a phantom follow-up section.';
  const seed = buildRenewSeed({ summary: summaryQuotingFollowUp });
  const parsed = parseRenewSeed(seed);
  assert.ok(parsed);
  assert.equal(parsed.summary, summaryQuotingFollowUp, 'the quoted fence and everything after it stayed in the summary');
  assert.equal(parsed.followUp, null, 'no state block to anchor against, so no follow-up is recognised');
  assert.equal(parsed.state, null);
});

test('splitSummarySections splits a template-conforming summary into catalog titles in document order', () => {
  const summary = `## ${S.roster}\nworker A is on task 1\n\n## ${S.completed}\nlanded X\n\n`
    + `## ${S.userContext}\nprefers terse replies`;
  const sections = splitSummarySections(summary);
  assert.deepEqual(sections.map((s) => s.title), [S.roster, S.completed, S.userContext]);
  assert.equal(sections[0].body, 'worker A is on task 1');
  assert.equal(sections[1].body, 'landed X');
  assert.equal(sections[2].body, 'prefers terse replies');
});

test('splitSummarySections accepts bold, numbered and parenthesised heading variants', async (t) => {
  const cases = [
    ['plain ##', `## ${S.userContext}`],
    ['bold', `**${S.userContext}**`],
    ['parenthesised number', `(2) ${S.completed}`],
    ['dotted number with trailing colon', `1. ${S.roster}:`],
    ['hash + number + bold', `### 3) **${S.userContext}**`],
  ];
  for (const [name, heading] of cases) {
    await t.test(name, () => {
      const sections = splitSummarySections(`${heading}\nbody text here`);
      const titled = sections.find((s) => s.title !== null);
      assert.ok(titled, `a titled section was recognised for: ${heading}`);
      assert.equal(titled.body, 'body text here');
    });
  }
});

test('splitSummarySections rejects a title mentioned mid-sentence or followed by prose on the same line', async (t) => {
  await t.test('mid-sentence', () => {
    const summary = `See the ${S.roster} below for details.`;
    const sections = splitSummarySections(summary);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].title, null);
    assert.equal(sections[0].body, summary);
  });
  await t.test('title with trailing prose on the same line', () => {
    const summary = `## ${S.roster} — see each worker's row below\nbody`;
    const sections = splitSummarySections(summary);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].title, null);
    assert.ok(sections[0].body.includes(S.roster));
  });
  // The start anchor, isolated: lead-in prose before the title with nothing
  // (but an allowed trailing colon) after it on the same line. The
  // "mid-sentence" case above also has trailing prose, so the trailing-prose
  // rule alone rejects it without ever exercising the start anchor; this one
  // has no trailing prose to reject on, so only the start anchor can reject it.
  await t.test('lead-in prose before the title, with nothing but the title after it', () => {
    const summary = `Please complete the ${S.roster}:\nbody`;
    const sections = splitSummarySections(summary);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].title, null, 'lead-in prose before the title is not an allowed prefix');
    assert.ok(sections[0].body.includes(S.roster));
  });
});

test('splitSummarySections titles a section with the catalog\'s canonical casing, not the line\'s', () => {
  assert.notEqual(S.roster, S.roster.toLowerCase(), 'sanity: the catalog title actually has non-lowercase casing');
  const summary = `## ${S.roster.toLowerCase()}\nworker A is on task 1`;
  const sections = splitSummarySections(summary);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].title, S.roster, 'title is the catalog\'s exact casing, not the lowercased line');
  assert.equal(sections[0].body, 'worker A is on task 1');
});

test('splitSummarySections ignores a heading line inside a fenced code block', () => {
  const summary = `## ${S.roster}\nreal heading\n\n`
    + '```\n' + `## ${S.completed}\n` + 'fenced, not a heading\n```\n'
    + 'still part of the roster section';
  const sections = splitSummarySections(summary);
  assert.equal(sections.length, 1, 'only the real heading outside the fence counts');
  assert.equal(sections[0].title, S.roster);
  assert.ok(sections[0].body.includes('```'));
  assert.ok(sections[0].body.includes(`## ${S.completed}`));
  assert.ok(sections[0].body.includes('fenced, not a heading'));
  assert.ok(sections[0].body.includes('still part of the roster section'));
});

test('splitSummarySections keeps text before the first heading as a leading untitled section', () => {
  const summary = `some preamble the worker wrote\n\n## ${S.userContext}\nprefers terse replies`;
  const sections = splitSummarySections(summary);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].title, null);
  assert.equal(sections[0].body, 'some preamble the worker wrote');
  assert.equal(sections[1].title, S.userContext);
});

test('splitSummarySections falls back to one untitled body equal to the input when no heading matches', async (t) => {
  await t.test('plain prose', () => {
    const summary = 'just some free-form prose the worker wrote with no headings at all.';
    assert.deepEqual(splitSummarySections(summary), [{ title: null, body: summary }]);
  });
  await t.test('leading and trailing blank lines are preserved exactly, not trimmed', () => {
    const summary = '\n\nfree prose\n\n';
    assert.deepEqual(splitSummarySections(summary), [{ title: null, body: summary }]);
  });
  // An all-blank summary must still yield exactly one untitled section — the
  // early-return fallback (no heading matched) doesn't filter on content, so
  // this never collapses to an empty array, which is what keeps the renew
  // bubble from rendering nothing at all for a degenerate summary.
  await t.test('an all-blank summary yields exactly one untitled section, never an empty array', () => {
    const summary = '\n\n   \n';
    const sections = splitSummarySections(summary);
    assert.equal(sections.length, 1, 'never an empty array');
    assert.deepEqual(sections, [{ title: null, body: summary }]);
  });
});

test('splitSummarySections drops no non-heading line', () => {
  const summary = `intro line one\nintro line two\n\n## ${S.roster}\nroster line one\nroster line two\n\n`
    + `## ${S.completed}\ncompleted line one`;
  const sections = splitSummarySections(summary);
  const allBodyText = sections.map((s) => s.body).join('\n');
  for (const line of ['intro line one', 'intro line two', 'roster line one', 'roster line two', 'completed line one']) {
    assert.ok(allBodyText.includes(line), `line preserved: ${line}`);
  }
});

test('RENEW_SUMMARY_TEMPLATE names every catalog title as a ## heading', () => {
  for (const title of Object.values(S)) {
    assert.ok(RENEW_SUMMARY_TEMPLATE.includes(`## ${title}`), `template names "## ${title}"`);
  }
});
