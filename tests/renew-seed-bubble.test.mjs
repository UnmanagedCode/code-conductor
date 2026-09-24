// Tests for the renew_session reseed bubble: a user_echo whose text is a
// renew-seed (public/renewSeed.js's parseRenewSeed recognises it) renders as
// a collapsed <details class="block renew-seed"> — summary line always
// visible, body built lazily on first expand into one labelled section per
// summary heading, then the conductor's follow-up directive and the
// mechanical state (literal text, never markdown). Shares mountFoldedText /
// buildUserText with the wake-callback bubble — see wake-callback-bubble.test.mjs
// for the shared lazy-build mechanism, which this file does not re-pin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNull } from './dom-assert.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { buildRenewSeed, RENEW_SUMMARY_SECTIONS, MECHANICAL_STATE_HEADER } from '../public/renewSeed.js';
import { buildWakeStub } from '../public/wakeCallback.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

const S = RENEW_SUMMARY_SECTIONS;

globalThis.AudioContext = class {
  constructor() { this.currentTime = 0; this.destination = {}; }
  resume() { return Promise.resolve(); }
  createBufferSource() { return { connect() {}, start() {}, onended: null, buffer: null }; }
  decodeAudioData() { return Promise.resolve({ duration: 0.1 }); }
};
globalThis.fetch = async () => ({
  ok: true,
  body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
});

function setupDOM() {
  const win = new Window({ url: 'http://localhost/' });
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Element = win.Element;
  globalThis.Node = win.Node;
  globalThis.MutationObserver = win.MutationObserver;
  return win;
}

function stubClipboard() {
  const copied = [];
  const orig = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (t) => { copied.push(t); } } },
    configurable: true,
  });
  const restore = () => {
    if (orig) Object.defineProperty(globalThis, 'navigator', orig);
  };
  return { copied, restore };
}

function expand(details) {
  details.querySelector(':scope > summary').click();
}

let uid = 0;
async function importConversation() {
  uid++;
  const { Conversation } =
    await import(pathToFileURL(path.join(PUB, 'conversation.js')).href + `?uid=${uid}`);
  return Conversation;
}

const STATE_BLOCK = `${MECHANICAL_STATE_HEADER}\n`
  + 'Live instances you spawned:\n'
  + '  - sessionId=abc12345 project=p worktree=my_branch_name status=idle\n'
  + 'Workers you own (their next turn wakes you):\n'
  + '  (none)';

const TEMPLATE_SUMMARY = `## ${S.roster}\nworker abc12345 is on task 1\n\n`
  + `## ${S.completed}\nlanded the migration\n\n`
  + `## ${S.userContext}\nprefers terse replies`;

const SEED = buildRenewSeed({
  summary: TEMPLATE_SUMMARY,
  followUp: 'MARK-D: keep going on the migration',
  stateBlock: STATE_BLOCK,
});

test('a renew seed echo renders a collapsed renew-seed details bubble, not a plain user-text body', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});

  conv.apply({ kind: 'user_echo', text: SEED, userIndex: 0 });

  const wrap = root.querySelector('.msg.user.renew-seed');
  assert.ok(wrap, 'user bubble carries the renew-seed class');

  const details = wrap.querySelector('details.block.renew-seed');
  assert.ok(details, 'renew seed renders inside a <details class="block renew-seed">');
  assert.equal(details.open, false, 'details is collapsed by default');

  const summary = details.querySelector('summary');
  assert.ok(summary, 'summary present');
  assert.match(summary.textContent, /Context renewed/);
  assert.ok(summary.querySelector('.renew-badge'), 'renew badge present on summary');

  assertNull(wrap.querySelector('.user-text'), 'no plain user-text body outside the details');
});

test('the renew seed body is not built until first expand', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  conv.apply({ kind: 'user_echo', text: SEED, userIndex: 0 });

  const details = root.querySelector('details.block.renew-seed');
  assert.equal(details.children.length, 1, 'only the summary is present before first expand');
  assertNull(details.querySelector('.renew-section'), 'no section rendered before expand');
  assertNull(details.querySelector('.fold-controls'), 'no fold-controls before expand');
});

test('expanding renders one labelled section per summary heading, then the follow-up and mechanical state, in order', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  conv.apply({ kind: 'user_echo', text: SEED, userIndex: 0 });

  const details = root.querySelector('details.block.renew-seed');
  expand(details);

  const labels = [...details.querySelectorAll('.renew-section-label')].map((n) => n.textContent);
  assert.deepEqual(labels, [
    S.roster, S.completed, S.userContext,
    'Conductor\'s follow-up directive',
    'Mechanical state (server-generated)',
  ]);

  const bodies = [...details.querySelectorAll('.renew-section-body')];
  assert.ok(bodies[0].textContent.includes('worker abc12345 is on task 1'));
  assert.ok(bodies[1].textContent.includes('landed the migration'));
  assert.ok(bodies[2].textContent.includes('prefers terse replies'));

  const followUpBody = details.querySelectorAll('.renew-section-body')[3];
  assert.ok(followUpBody.textContent.includes('MARK-D: keep going on the migration'));
});

test('a summary without template headings renders in full as one Handoff summary section', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  const plainSeed = buildRenewSeed({ summary: 'just some free-form prose with no headings at all.' });
  conv.apply({ kind: 'user_echo', text: plainSeed, userIndex: 0 });

  const details = root.querySelector('details.block.renew-seed');
  expand(details);

  const labels = [...details.querySelectorAll('.renew-section-label')].map((n) => n.textContent);
  assert.deepEqual(labels, ['Handoff summary']);
  assert.ok(details.querySelector('.renew-section-body').textContent
    .includes('just some free-form prose with no headings at all.'));
});

test('the mechanical state renders as literal text, never markdown', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  conv.apply({ kind: 'user_echo', text: SEED, userIndex: 0 });

  const details = root.querySelector('details.block.renew-seed');
  expand(details);

  const stateEl = details.querySelector('.renew-state');
  assert.ok(stateEl, '.renew-state element present');
  assert.ok(stateEl.textContent.includes('worktree=my_branch_name'),
    'the worktree line appears verbatim');
  assertNull(stateEl.querySelector('em'), 'underscores in the state block never become markdown emphasis');
  assertNull(stateEl.querySelector('strong'), 'no markdown elements at all in the state block');
});

test('raw view and copy of a renew seed yield the exact seed text', async () => {
  setupDOM();
  const { copied, restore } = stubClipboard();
  try {
    const Conversation = await importConversation();
    const root = document.createElement('div');
    const conv = new Conversation(root, {});
    conv.apply({ kind: 'user_echo', text: SEED, userIndex: 0 });

    const details = root.querySelector('details.block.renew-seed');
    expand(details);

    const toggle = details.querySelector('.user-view-toggle');
    const copyBtn = details.querySelector('.user-view-copy');
    const body = details.querySelector(':scope > .user-text');

    toggle.click(); // -> raw
    assert.equal(body.dataset.view, 'raw');
    assert.equal(body.textContent, SEED, 'raw view is the exact seed text');

    copyBtn.click();
    await Promise.resolve();
    assert.equal(copied[0], SEED, 'copy yields the exact seed text');
  } finally {
    restore();
  }
});

test('ordinary prompts and forward-framed prompts still render as plain user bubbles', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});

  conv.apply({ kind: 'user_echo', text: 'please fix the bug in foo.ts', userIndex: 0 });
  const plainWrap = root.querySelector('.msg.user');
  assertNull(plainWrap.querySelector('details.block.renew-seed'), 'no renew-seed details');
  assert.ok(plainWrap.querySelector('.user-text'), 'plain prompt still gets a user-text body');
  assert.ok(!plainWrap.classList.contains('renew-seed'), 'wrap carries no renew-seed class');
});

test('a wake stub still renders as the wake bubble, not a renew seed', async () => {
  setupDOM();
  const Conversation = await importConversation();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});

  const wakeStub = buildWakeStub({ targetSessionId: 'abc12345', payloadText: 'line1\nline2' });
  conv.apply({ kind: 'user_echo', text: wakeStub, userIndex: 0 });

  const wrap = root.querySelector('.msg.user.wake-callback');
  assert.ok(wrap, 'wake bubble still renders');
  assertNull(wrap.querySelector('details.block.renew-seed'), 'no renew-seed details for a wake stub');
  assert.ok(wrap.querySelector('details.block.wake'), 'the wake details block is present');
});
