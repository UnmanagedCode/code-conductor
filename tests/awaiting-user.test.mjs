// The pure core of `awaitingUser` (src/awaitingUser.ts): the text-ask
// detector, the user-turn classifier, the reducer and its summary algebra, and
// the live feed's once-per-toolUseId dedupe across its two arms.
//
// The classifier table is a DRIFT GATE: every case feeds it the actual OUTPUT
// of the builder that produces that turn, so a builder whose opening changes
// without its recogniser turns this file red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isTextAsk, classifyUserTurn, reduceAsk, summaryOfFact, composeSummaries, applySummary,
  IDENTITY_SUMMARY, LiveAskFacts, askFactsOfEvent,
} from '../src/awaitingUser.ts';
import { buildWakeStub, markPlainStub } from '../public/wakeCallback.js';
import { buildRenewSeed } from '../public/renewSeed.js';
import { formatUserQuestionAnswers } from '../public/userQuestionAnswers.js';
import { buildRenewRequest } from '../src/sessionRenew.ts';
import { RESUME_TEXT, buildConductorResumeText } from '../src/resumeRestart.ts';
import { buildCombinedResumeText } from '../src/overageResume.ts';
import { FORWARD_FRAME_HEADER } from '../src/injectedTurns.ts';
import { buildApprovePrompt, buildRejectPrompt } from '../src/planApproval.ts';
import { buildRebasePrompt } from '../src/worktrees.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const echo = (text, extra = {}) => ({ kind: 'user_echo', text, parentToolUseId: null, ...extra });
const Q_TEXT = { kind: 'question', source: 'text' };
const Q_TOOL = { kind: 'question', source: 'tool' };
const P_TOOL = { kind: 'plan', source: 'tool' };

// ── isTextAsk ─────────────────────────────────────────────────────────────

test('isTextAsk: a turn ending in `?` asks, through trailing whitespace and markdown closers', async (t) => {
  for (const text of [
    'Which one?', 'Which one?\n\n', '**Proceed?**', '_ok?_', '`this?`', '(merge now?)', '"ready?"', "'go?' ",
  ]) {
    await t.test(JSON.stringify(text), () => assert.equal(isTextAsk(text), true));
  }
});

test('isTextAsk: each offer phrase in the last paragraph asks, case-insensitively', async (t) => {
  for (const phrase of ['Should I', 'shall i', 'Want me to', 'Would you like', 'DO YOU WANT', 'Let me know']) {
    await t.test(phrase, () => assert.equal(isTextAsk(`Done.\n\n${phrase} tidy the rest.`), true));
  }
});

test('isTextAsk: an offer phrase only counts in the LAST paragraph, and plain statements do not ask', async (t) => {
  for (const text of [
    'Should I have? Anyway.\n\nDone — merged and pushed nothing.',
    'All tests pass.',
    '',
    'The shoulder is fine.', // word-bounded: "should" inside a word is no phrase
  ]) {
    await t.test(JSON.stringify(text), () => assert.equal(isTextAsk(text), false));
  }
  assert.equal(isTextAsk(null), false);
});

// ── classifyUserTurn: the drift gate ─────────────────────────────────────

test('classifyUserTurn: the output of every injected-turn builder classifies injected', async (t) => {
  const cases = {
    'wake stub': buildWakeStub({ targetSessionId: 'abcd1234', payloadText: 'worker output' }),
    'plain wake stub (heartbeat / stale / interrupted)': markPlainStub('session abcd1234 did NOT finish'),
    'renew request': buildRenewRequest(),
    'renew request with a directive': buildRenewRequest({ directive: 'keep the roster short' }),
    'renew reseed': buildRenewSeed({ summary: '## Live work roster\n- none', stateBlock: 'state' }),
    'restart notice (RESUME_TEXT)': RESUME_TEXT,
    'conductor restart notice': buildConductorResumeText([{ project: 'p', sessionId: 's1', worktreeName: 'w' }]),
    'overage resume, stopped': buildCombinedResumeText([], 'stopped'),
    'overage resume, idle-parked': buildCombinedResumeText([], 'idle-parked'),
    'overage resume, stopped + conductor clauses':
      buildCombinedResumeText([], 'stopped', { droppedCallbacks: true, unarmedWorkers: true }),
    'overage resume, idle-parked + conductor clauses':
      buildCombinedResumeText([], 'idle-parked', { droppedCallbacks: true }),
    // Forwarded output: the frame is private to handlers.ts; its header is the
    // shared constant, and tests/awaiting-user-live.test.mjs drives the real
    // send_prompt({forward}) end to end.
    'forward frame': `${FORWARD_FRAME_HEADER}\n\npayload\n\n--- END FORWARDED WORKER OUTPUT ---\n\nreview it`,
    'renew /clear (queued_command shape)': '/clear',
    'renew /clear (type:user shape)': '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>',
    '/effort': '/effort high',
    '/effort (command-name shape)': '<command-name>/effort</command-name>',
    'local command output': '<local-command-stdout>Set effort level to high</local-command-stdout>',
  };
  for (const [label, text] of Object.entries(cases)) {
    await t.test(label, () => assert.equal(classifyUserTurn(echo(text)), 'injected'));
  }
  await t.test('a cliInjected echo, whatever its text', () =>
    assert.equal(classifyUserTurn(echo('Base directory for this skill: …', { cliInjected: true })), 'injected'));
});

test('classifyUserTurn: user-authored turns — incl. answers, approvals and a queued overage resume — are real', async (t) => {
  const queued = [{ text: 'also fix the typo', attachments: [], ts: 0 }];
  const questions = [{ question: 'Pick', header: 'P', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }];
  const cases = {
    'overage resume carrying the queued messages (stopped)': buildCombinedResumeText(queued, 'stopped'),
    'overage resume carrying the queued messages (queued-only)': buildCombinedResumeText(queued, 'queued-only', { droppedCallbacks: true }),
    'plan approval (also what auto-approve sends)': buildApprovePrompt(''),
    'plan rejection': buildRejectPrompt('tighten step 2'),
    'question-card answer': formatUserQuestionAnswers(questions, { 0: 'A' }),
    'rebase button': buildRebasePrompt({ baseBranch: 'main', baseSha: '0123456789abcdef', worktreeName: 'w', branch: 'b' }, 'dirty'),
    // THE DOCUMENTED LIMIT: an MCP send_prompt into a non-worker carries no
    // marker, so it is indistinguishable from the user typing it.
    'plain text (composer, or an MCP send — the stated limit)': 'yes, go ahead',
  };
  for (const [label, text] of Object.entries(cases)) {
    await t.test(label, () => assert.equal(classifyUserTurn(echo(text)), 'real'));
  }
});

// ── Reducer + summary algebra ────────────────────────────────────────────

test('reduceAsk: a tool ask always overwrites; a text ask never downgrades a pending one', () => {
  assert.deepEqual(reduceAsk(null, { t: 'toolAsk', kind: 'plan' }), P_TOOL);
  assert.deepEqual(reduceAsk(Q_TEXT, { t: 'toolAsk', kind: 'question' }), Q_TOOL, 'tool over text');
  assert.deepEqual(reduceAsk(Q_TOOL, { t: 'toolAsk', kind: 'plan' }), P_TOOL, 'tool over tool');
  assert.deepEqual(reduceAsk(P_TOOL, { t: 'endTurn', text: 'Which?' }), P_TOOL, 'a text ask keeps the tool ask');
  assert.deepEqual(reduceAsk(null, { t: 'endTurn', text: 'Which?' }), Q_TEXT);
  assert.equal(reduceAsk(null, { t: 'endTurn', text: 'Done.' }), null);
});

test('reduceAsk: only a REAL user turn clears; an injected one leaves the ask', () => {
  assert.equal(reduceAsk(P_TOOL, { t: 'userTurn', ev: echo('ok') }), null);
  assert.deepEqual(reduceAsk(P_TOOL, { t: 'userTurn', ev: echo(markPlainStub('beat')) }), P_TOOL);
});

test('summary algebra: composing range summaries equals the flat fold, for every split and incoming state', () => {
  const facts = [
    { t: 'endTurn', text: 'Which?' },
    { t: 'userTurn', ev: echo(markPlainStub('beat')) },
    { t: 'endTurn', text: 'Done.' },
    { t: 'toolAsk', kind: 'plan' },
    { t: 'endTurn', text: 'Should I proceed?' },
    { t: 'userTurn', ev: echo('go') },
    { t: 'endTurn', text: 'Anything else?' },
    { t: 'userTurn', ev: echo(RESUME_TEXT) },
  ];
  const summarize = (range) => range.reduce((acc, f) => composeSummaries(summaryOfFact(f), acc), IDENTITY_SUMMARY);
  for (const incoming of [null, Q_TEXT, P_TOOL]) {
    for (let lo = 0; lo <= facts.length; lo++) {
      for (let hi = lo; hi <= facts.length; hi++) {
        const flat = facts.slice(lo, hi).reduce(reduceAsk, incoming);
        for (let mid = lo; mid <= hi; mid++) {
          const composed = applySummary(
            composeSummaries(summarize(facts.slice(mid, hi)), summarize(facts.slice(lo, mid))), incoming);
          assert.deepEqual(composed, flat, `range [${lo},${mid})+[${mid},${hi}) from ${JSON.stringify(incoming)}`);
        }
      }
    }
  }
});

// ── askFactsOfEvent ───────────────────────────────────────────────────────

test('askFactsOfEvent: an auto-approved plan and a sub-agent event are no facts', () => {
  assert.deepEqual(askFactsOfEvent({ kind: 'plan_request', toolUseId: 't', autoApproved: true, parentToolUseId: null }), []);
  assert.deepEqual(askFactsOfEvent({ kind: 'user_question', toolUseId: 't', parentToolUseId: 'agent' }), []);
  assert.deepEqual(askFactsOfEvent(echo('x', { parentToolUseId: 'agent' })), []);
});

// ── LiveAskFacts: one toolAsk per toolUseId across both arms ─────────────

const envelope = (content, msgId = 'm1') => ({ kind: 'assistant_message', msgId, message: { id: msgId, content }, parentToolUseId: null });
const askBlock = { type: 'tool_use', id: 'tu1', name: 'AskUserQuestion', input: { questions: [{ question: 'q' }] } };
const planBlock = { type: 'tool_use', id: 'tp1', name: 'ExitPlanMode', input: { plan: 'p' } };
const toolAsks = (facts) => facts.filter(f => f.t === 'toolAsk');

test('LiveAskFacts: the envelope arm alone, the delta arm alone, and both in real order each emit exactly one toolAsk', async (t) => {
  await t.test('envelope only (a reconciled-only turn)', () => {
    const live = new LiveAskFacts(() => false);
    assert.equal(toolAsks(live.feed(envelope([askBlock]))).length, 1);
  });
  await t.test('delta only', () => {
    const live = new LiveAskFacts(() => false);
    assert.equal(toolAsks(live.feed({ kind: 'user_question', toolUseId: 'tu1', parentToolUseId: null })).length, 1);
  });
  await t.test('envelope then delta (the real CLI order)', () => {
    const live = new LiveAskFacts(() => false);
    const n = toolAsks(live.feed(envelope([askBlock]))).length
      + toolAsks(live.feed({ kind: 'user_question', toolUseId: 'tu1', parentToolUseId: null })).length;
    assert.equal(n, 1);
  });
});

test('LiveAskFacts: the envelope arm reads the plan auto-approve rule the gate reads', () => {
  assert.deepEqual(toolAsks(new LiveAskFacts(() => true).feed(envelope([planBlock]))), []);
  assert.equal(toolAsks(new LiveAskFacts(() => false).feed(envelope([planBlock])))[0].kind, 'plan');
});

test('LiveAskFacts: end_turn yields the last message\'s final text from either arm; other stops yield nothing', () => {
  const live = new LiveAskFacts(() => false);
  live.feed({ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'Should I ', parentToolUseId: null });
  live.feed({ kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'merge?', parentToolUseId: null });
  assert.deepEqual(live.feed({ kind: 'turn_end', stopReason: 'end_turn', isError: false, parentToolUseId: null }),
    [{ t: 'endTurn', text: 'Should I merge?' }]);
  live.feed(envelope([{ type: 'text', text: 'Pick one?' }], 'm2'));
  assert.deepEqual(live.feed({ kind: 'turn_end', stopReason: 'end_turn', isError: false, parentToolUseId: null }),
    [{ t: 'endTurn', text: 'Pick one?' }]);
  live.feed(envelope([{ type: 'text', text: 'Pick one?' }], 'm3'));
  assert.deepEqual(live.feed({ kind: 'turn_end', stopReason: 'end_turn', isError: true, parentToolUseId: null }), []);
});

// ── Acceptance 4: no playbook / stage / kanban logic ─────────────────────

test('the new modules read no playbook, stage, ledger or kanban fact', async () => {
  for (const f of ['awaitingUser.ts', 'awaitingUserTranscript.ts', 'injectedTurns.ts']) {
    const src = await fs.readFile(path.join(__dirname, '..', 'src', f), 'utf8');
    assert.doesNotMatch(src, /playbook|stage|ledger|kanban/i, `${f} must not name a playbook/stage/ledger/kanban fact`);
  }
});
