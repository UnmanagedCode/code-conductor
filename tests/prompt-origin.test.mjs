// promptOrigin / isPinEligible (public/promptOrigin.js): which user turns the
// sticky prompt header may pin. Pure — no DOM.
//
// Every input comes from the REAL builder of that turn, never a hand-typed copy,
// so a builder whose opening changes without its recogniser turns this file red
// (the same drift gate tests/awaiting-user.test.mjs runs for classifyUserTurn).
// Table-driven cases are one subtest per row so each row is proved on its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptOrigin, isPinEligible, isInjectedUserTurn } from '../public/promptOrigin.js';
import { classifyUserTurn } from '../src/awaitingUser.ts';
import { buildWakeStub, markPlainStub } from '../public/wakeCallback.js';
import { buildRenewSeed } from '../public/renewSeed.js';
import { formatUserQuestionAnswers, isQuestionAnswerShape } from '../public/userQuestionAnswers.js';
import { buildForwardFrame, FORWARD_FRAME_HEADER } from '../public/forwardFrame.js';
import { buildApprovePrompt, buildRejectPrompt, parsePlanDecision } from '../public/planApproval.js';
import {
  RENEW_REQUEST_LEAD, RESTART_NOTICE_TRUNK, REBASE_PROMPT_LEAD,
  AUTO_RESUME_TEXT, IDLE_PARKED_RESUME_TEXT, QUEUED_ONLY_RESUME_TEXT,
} from '../public/injectedTurns.js';
import { buildRenewRequest } from '../src/sessionRenew.ts';
import { RESUME_TEXT, buildWorkersResumeText } from '../src/resumeRestart.ts';
import { buildCombinedResumeText } from '../src/overageResume.ts';
import { buildRebasePrompt } from '../src/worktrees.ts';

const echo = (text, extra = {}) => ({ kind: 'user_echo', text, parentToolUseId: null, ...extra });
const META = { baseBranch: 'main', baseSha: '0123456789abcdef', worktreeName: 'w', branch: 'b' };
const QUESTIONS = [{ question: 'Pick', header: 'P', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }];
const TWO_QUESTIONS = [...QUESTIONS, { question: 'Also', header: 'Q', multiSelect: false, options: [{ label: 'X' }] }];
const QUEUED = [{ text: 'also fix the typo', attachments: [], ts: 0 }];

// Rows: label → text. Grouped so the per-claim tests and the drift guard share one set.
const WAKE = {
  'wake stub, bare': buildWakeStub({ targetSessionId: 'abcd1234', payloadText: 'worker output' }),
  'wake stub with a note (stale / declined-renewal path)':
    buildWakeStub({ targetSessionId: 'abcd1234', payloadText: 'worker output', note: 'Renewal declined.' }),
  'plain wake stub (heartbeat / interrupted / mid-turn)': markPlainStub('session abcd1234 did NOT finish'),
};
const REBASE = {
  'rebase brief, dirty': buildRebasePrompt(META, 'dirty'),
  'rebase brief, conflict': buildRebasePrompt(META, 'conflict'),
};
const NOTICES = {
  'restart notice (RESUME_TEXT)': RESUME_TEXT,
  'restart notice with workers': buildWorkersResumeText('root', [{ project: 'p', sessionId: 's1', worktreeName: 'w', parentSessionId: 'root' }]),
  'overage preamble AUTO_RESUME_TEXT': AUTO_RESUME_TEXT,
  'overage preamble IDLE_PARKED_RESUME_TEXT': IDLE_PARKED_RESUME_TEXT,
  'overage preamble QUEUED_ONLY_RESUME_TEXT': QUEUED_ONLY_RESUME_TEXT,
  'overage resume, stopped': buildCombinedResumeText([], 'stopped'),
  'overage resume, idle-parked + conductor clauses': buildCombinedResumeText([], 'idle-parked', { droppedCallbacks: true }),
  'renew request': buildRenewRequest(),
  'renew request with a directive': buildRenewRequest({ directive: 'keep the roster short' }),
  'renew request lead alone': RENEW_REQUEST_LEAD,
  'renew reseed': buildRenewSeed({ summary: '## Live work roster\n- none', stateBlock: 'state' }),
  'restart trunk alone': RESTART_NOTICE_TRUNK,
};
const SLASH = {
  '/clear': '/clear',
  '/clear (command-name shape)': '<command-name>/clear</command-name>\n<command-message>clear</command-message>',
  '/effort': '/effort high',
  '/effort (command-name shape)': '<command-name>/effort</command-name>',
  'local command output': '<local-command-stdout>Set effort level to high</local-command-stdout>',
};
// Slash commands classifyUserTurn reads as real (awaitingUser is unchanged for
// them) but that never pin.
const SLASH_GENERIC = {
  'a bare slash command': '/review the diff',
  'a namespaced slash command with no args': '/plugin:cmd',
  'a command-name wrapper': '<command-name>/compact</command-name>',
  // The rule is the first token, so a bare single-segment path reads as a command.
  'a bare single-segment path (/tmp)': '/tmp',
  'a single-segment path opening a sentence': '/etc is read-only here',
  'a bare /compact': '/compact',
};
const FRAMES = {
  'forward frame, payload only': buildForwardFrame({ messages: ['payload'], instruction: '' }),
  'forward frame, whitespace instruction': buildForwardFrame({ messages: ['payload'], instruction: ' \n' }),
  'forward frame, truncated (no footer)': `${FORWARD_FRAME_HEADER}\n\npayload`,
};
const FORWARD_WITH_INSTRUCTION = buildForwardFrame({ messages: ['payload'], instruction: 'review it' });

const ALL_INJECTED = { ...WAKE, ...NOTICES, ...SLASH, ...FRAMES,
  'forward frame with an instruction': FORWARD_WITH_INSTRUCTION };

async function eachRow(t, rows, want) {
  for (const [label, text] of Object.entries(rows)) {
    await t.test(label, () => assert.equal(promptOrigin(echo(text)), want));
  }
}

test('a composer prompt, plain or dictated, is typed and pins in every session role', async (t) => {
  for (const [label, text] of Object.entries({
    plain: 'please fix the flaky test',
    dictated: '<transcribed>\nplease fix the flaky test',
    'multi-line with a markdown heading': '# Goal\n\nmake it faster',
    'a path, not a slash command': '/etc/hosts is wrong',
  })) {
    await t.test(label, () => {
      const origin = promptOrigin(echo(text));
      assert.equal(origin, 'typed');
      assert.equal(isPinEligible(origin, { conducted: false }), true);
      assert.equal(isPinEligible(origin, { conducted: true }), true);
    });
  }
});

test('a send_prompt brief is typed: indistinguishable from a composer send (documented non-worker degradation)', () => {
  const brief = 'Implement the plan in docs/x.md and report back.';
  assert.equal(promptOrigin(echo(brief)), 'typed');
  assert.equal(isPinEligible(promptOrigin(echo(brief)), { conducted: false }), true);
});

test('a plan decision with feedback is a template; without feedback it is boilerplate and never pins', async (t) => {
  await t.test('approve with feedback', () => assert.equal(promptOrigin(echo(buildApprovePrompt('use the small variant'))), 'template'));
  await t.test('reject with feedback', () => assert.equal(promptOrigin(echo(buildRejectPrompt('tighten step 2\nand step 3'))), 'template'));
  await t.test('approve without feedback', () => assert.equal(promptOrigin(echo(buildApprovePrompt(''))), 'synthetic'));
  await t.test('reject without feedback', () => assert.equal(promptOrigin(echo(buildRejectPrompt(''))), 'synthetic'));
  await t.test('whitespace-only feedback is no feedback', () => assert.equal(promptOrigin(echo(buildApprovePrompt('  \n'))), 'synthetic'));
  await t.test('whitespace-only reject feedback is no feedback: the no-feedback form, never pins', () => {
    assert.equal(buildRejectPrompt('  \n'), buildRejectPrompt(''));
    assert.equal(promptOrigin(echo(buildRejectPrompt('  \n'))), 'synthetic');
  });
});

test('parsePlanDecision reverses both builders and refuses lookalikes', async (t) => {
  await t.test('approve with multi-line feedback', () =>
    assert.deepEqual(parsePlanDecision(buildApprovePrompt('a\n\nb')), { decision: 'approve', feedback: 'a\n\nb' }));
  await t.test('reject with feedback', () =>
    assert.deepEqual(parsePlanDecision(buildRejectPrompt('x')), { decision: 'reject', feedback: 'x' }));
  await t.test('approve without feedback', () =>
    assert.deepEqual(parsePlanDecision(buildApprovePrompt(null)), { decision: 'approve', feedback: null }));
  await t.test('reject without feedback', () =>
    assert.deepEqual(parsePlanDecision(buildRejectPrompt(undefined)), { decision: 'reject', feedback: null }));
  // Long enough that the slice between lead and tail is non-empty, so only the
  // tail check tells a hand-typed prompt from a decision.
  const TYPED_APPROVE = 'I approve the plan. Additional notes: please also fix the retry loop and the logging';
  await t.test('a long hand-typed prompt opening with the approve lead is not a decision', () =>
    assert.equal(parsePlanDecision(TYPED_APPROVE), null));
  await t.test('and it stays typed to promptOrigin', () => assert.equal(promptOrigin(echo(TYPED_APPROVE)), 'typed'));
  await t.test('the bare lead a person might type', () => assert.equal(parsePlanDecision('I approve the plan.'), null));
  await t.test('an approve carrying notes but no closing line', () =>
    assert.equal(parsePlanDecision('I approve the plan. Additional notes: fine'), null));
  await t.test('a non-string', () => assert.equal(parsePlanDecision(null), null));
});

test('a server-stamped question answer never pins: it renders as its own bubble with no user-text', async (t) => {
  const stamp = { toolUseId: 'toolu_q', questions: QUESTIONS };
  await t.test('single-question form', () =>
    assert.equal(promptOrigin(echo(formatUserQuestionAnswers(QUESTIONS, { 0: { kind: 'option', label: 'A' } }), { questionAnswer: stamp })), 'synthetic'));
  await t.test('multi-question form', () =>
    assert.equal(promptOrigin(echo(formatUserQuestionAnswers(TWO_QUESTIONS, { 0: { kind: 'option', label: 'A' }, 1: { kind: 'custom', text: 'y' } }),
      { questionAnswer: { toolUseId: 'toolu_q', questions: TWO_QUESTIONS } })), 'synthetic'));
  await t.test('the same text without the stamp is still a template', () =>
    assert.equal(promptOrigin(echo(formatUserQuestionAnswers(QUESTIONS, { 0: { kind: 'option', label: 'A' } }))), 'template'));
});

test('an unstamped question answer, single and multi form, is a template', async (t) => {
  await t.test('single-question short form', () =>
    assert.equal(promptOrigin(echo(formatUserQuestionAnswers(QUESTIONS, { 0: { kind: 'option', label: 'A' } }))), 'template'));
  await t.test('multi-question form', () =>
    assert.equal(promptOrigin(echo(formatUserQuestionAnswers(TWO_QUESTIONS, {
      0: { kind: 'option', label: 'A' }, 1: { kind: 'custom', text: 'y' },
    }))), 'template'));
  await t.test('a lookalike opening without the quoted-question shape stays typed', () =>
    assert.equal(promptOrigin(echo('Answer to my prayers: none')), 'typed'));
  await t.test('isQuestionAnswerShape refuses a non-string', () => assert.equal(isQuestionAnswerShape(undefined), false));
});

test('isQuestionAnswerShape recognises only the numbered multi-question form', async (t) => {
  await t.test('formatter output for several questions', () =>
    assert.equal(isQuestionAnswerShape(formatUserQuestionAnswers(TWO_QUESTIONS, [
      { kind: 'option', label: 'A' }, { kind: 'option', label: 'X' }])), true));
  await t.test('formatter output for one question', () =>
    assert.equal(isQuestionAnswerShape(formatUserQuestionAnswers(QUESTIONS, [{ kind: 'option', label: 'A' }])), true));
  await t.test('the old bulleted multi form', () =>
    assert.equal(isQuestionAnswerShape('My answers:\n- Q1: A\n- Q2: B'), false));
  await t.test('a plain prompt that begins "My answers:"', () =>
    assert.equal(isQuestionAnswerShape('My answers: yes to both, ship it'), false));
  await t.test('"My answers:" and a line break with no numbered line', () =>
    assert.equal(isQuestionAnswerShape('My answers:\nyes to both'), false));
});

test('a forward frame\'s instruction is a template; a payload-only frame never pins', async (t) => {
  await t.test('frame with an instruction', () => assert.equal(promptOrigin(echo(FORWARD_WITH_INSTRUCTION)), 'template'));
  await eachRow(t, FRAMES, 'synthetic');
});

test('no wake stub shape pins', async (t) => { await eachRow(t, WAKE, 'synthetic'); });

test('a rebase brief never pins, for both blockers', async (t) => {
  await eachRow(t, REBASE, 'synthetic');
  await t.test('and it opens with the shared lead', () => {
    for (const text of Object.values(REBASE)) assert.ok(text.startsWith(REBASE_PROMPT_LEAD), text.slice(0, 40));
  });
});

test('restart notices, overage preambles, renew request and seed never pin', async (t) => { await eachRow(t, NOTICES, 'synthetic'); });

test('an overage resume carrying queued messages is typed: it is how the human\'s prompts arrive', async (t) => {
  await t.test('stopped', () => assert.equal(promptOrigin(echo(buildCombinedResumeText(QUEUED, 'stopped'))), 'typed'));
  await t.test('queued-only', () =>
    assert.equal(promptOrigin(echo(buildCombinedResumeText(QUEUED, 'queued-only', { droppedCallbacks: true }))), 'typed'));
});

test('CLI-injected lines, skill loads, compaction summaries and sub-agent echoes never pin', async (t) => {
  const text = 'plain text that would otherwise be typed';
  await t.test('cliInjected', () => assert.equal(promptOrigin(echo(text, { cliInjected: true })), 'synthetic'));
  await t.test('skillLoad', () => assert.equal(promptOrigin(echo(text, { skillLoad: { skill: 's' } })), 'synthetic'));
  await t.test('compactSummary', () => assert.equal(promptOrigin(echo(text, { compactSummary: true })), 'synthetic'));
  await t.test('sub-agent echo', () => assert.equal(promptOrigin(echo(text, { parentToolUseId: 'toolu_1' })), 'synthetic'));
});

test('slash commands never pin, bare or command-name wrapped; /clear and /effort stay injected', async (t) => {
  await eachRow(t, SLASH, 'synthetic');
  await eachRow(t, SLASH_GENERIC, 'synthetic');
  await t.test('/clear and /effort are still isInjectedUserTurn', () => {
    for (const k of ['/clear', '/clear (command-name shape)', '/effort', '/effort (command-name shape)', 'local command output']) {
      assert.equal(isInjectedUserTurn(echo(SLASH[k])), true, k);
    }
  });
  await t.test('a multi-segment path is not a slash command: it stays typed', () => {
    assert.equal(promptOrigin(echo('/etc/hosts is wrong')), 'typed');
    assert.equal(promptOrigin(echo('/tmp/x')), 'typed');
  });
  await t.test('a generic slash command is not injected (awaitingUser keeps reading it as real)', () =>
    assert.equal(isInjectedUserTurn(echo(SLASH_GENERIC['a bare slash command'])), false));
});

test('an attachment-only prompt never pins', async (t) => {
  await t.test('empty text', () => assert.equal(promptOrigin(echo('', { attachments: [{ kind: 'image' }] })), 'synthetic'));
  await t.test('whitespace text', () => assert.equal(promptOrigin(echo(' \n')), 'synthetic'));
  await t.test('missing text', () => assert.equal(promptOrigin({ kind: 'user_echo' }), 'synthetic'));
});

test('isPinEligible: typed always, template only when conducted, synthetic never', async (t) => {
  await t.test('typed, worker', () => assert.equal(isPinEligible('typed', { conducted: true }), true));
  await t.test('typed, non-worker', () => assert.equal(isPinEligible('typed', { conducted: false }), true));
  await t.test('template, worker', () => assert.equal(isPinEligible('template', { conducted: true }), true));
  await t.test('template, non-worker', () => assert.equal(isPinEligible('template', { conducted: false }), false));
  await t.test('synthetic, worker', () => assert.equal(isPinEligible('synthetic', { conducted: true }), false));
  await t.test('synthetic, non-worker', () => assert.equal(isPinEligible('synthetic', { conducted: false }), false));
});

test('every turn classifyUserTurn calls injected is synthetic to promptOrigin, except a forward frame with an instruction', async (t) => {
  for (const [label, text] of Object.entries(ALL_INJECTED)) {
    await t.test(label, () => {
      const ev = echo(text);
      assert.equal(classifyUserTurn(ev), 'injected');
      assert.equal(promptOrigin(ev), text === FORWARD_WITH_INSTRUCTION ? 'template' : 'synthetic');
    });
  }
});
