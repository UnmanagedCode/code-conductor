// Sticky prompt header (public/stickyPrompt.js): the pure pick, the controller
// against a real Conversation's DOM, and the static wiring in index.html /
// styles.css.
//
// happy-dom lays nothing out — every rect and scrollHeight is 0 — so geometry is
// injected: each bubble gets a `layoutTop`, its getBoundingClientRect is stubbed
// as `layoutTop - scrollEl.scrollTop`, and `schedule` runs synchronously. What
// these tests can prove is the pick, the eligibility, the DOM the pin shows and
// what click does; whether it LOOKS right needs the headless pass
// (docs/frontend-testing.md).
//
// The pin is shown only once revealed: the harness reveals by default, so the
// geometry tests prove the revealed behaviour. History is a scriptable fake
// ({ loadUntil, state }) whose runs the test resolves by hand; one test drives
// the real lazy-history controller instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNull } from './dom-assert.mjs';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { pickPinned, STATUS_LOADING, STATUS_FAILED, STATUS_NONE } from '../public/stickyPrompt.js';
import { buildApprovePrompt } from '../public/planApproval.js';
import { buildWakeStub } from '../public/wakeCallback.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

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

const PIN_HEIGHT = 60;

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

let uid = 0;
async function importFresh(file) {
  uid++;
  return import(pathToFileURL(path.join(PUB, file)).href + `?uid=${uid}`);
}

// A fake lazy-history controller. Each loadUntil call is recorded with its
// predicates and a `resolve` the test calls to end the run.
function fakeHistory({ ready = true, hasMore = false } = {}) {
  const h = {
    st: { ready, hasMore, loading: false },
    runs: [],
    state: () => ({ ...h.st }),
    loadUntil: (found, keepGoing) => new Promise((resolve) => h.runs.push({ found, keepGoing, resolve })),
  };
  return h;
}

// A Conversation on a scroll root, the pin, and the installed controller. The
// module graph is imported fresh so the controller binds THIS window's globals.
// `history: 'real'` wires the real lazy-history controller (fetch stubbed by
// the test) in place of the fake.
async function harness({ conducted = false, revealed = true, history = fakeHistory() } = {}) {
  const win = setupDOM();
  const { Conversation } = await importFresh('conversation.js');
  const { installStickyPrompt } = await importFresh('stickyPrompt.js');
  const host = document.createElement('div'); // stands in for #main
  const pane = document.createElement('div');
  const scrollEl = document.createElement('div');
  const pinEl = document.createElement('div');
  pinEl.hidden = true;
  pane.append(pinEl, scrollEl);
  host.append(pane);
  document.body.append(host);
  // viewOpen: a full-page view has the pane display:none, so every rect reads 0.
  const layout = { viewOpen: false, pinHeight: PIN_HEIGHT, tops: new Map(), bodyScrollHeight: 20, bodyClientHeight: 57, clientHeight: 600 };
  // A display:none element measures 0, as in a browser.
  Object.defineProperty(pinEl, 'offsetHeight', { get: () => (pinEl.hidden ? 0 : layout.pinHeight) });
  // The pin's body is created by the controller, so its clamp is faked on the prototype.
  const isPinBody = (el) => el.classList.contains('pinned-prompt-body');
  Object.defineProperty(win.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return isPinBody(this) ? layout.bodyScrollHeight : 0; } });
  Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return isPinBody(this) ? layout.bodyClientHeight : 0; } });
  // The scroll root's viewport: 0 while a full-page view hides the pane.
  Object.defineProperty(scrollEl, 'clientHeight', { configurable: true, get: () => (layout.viewOpen ? 0 : layout.clientHeight) });
  scrollEl.getBoundingClientRect = () => ({ top: 0 });
  const state = { conducted };
  let conv = null;
  let lazy = null;
  if (history === 'real') {
    const { installLazyHistoryController } = await importFresh('lazyHistory.js');
    conv = new Conversation(scrollEl, {});
    lazy = installLazyHistoryController({
      conversationEl: scrollEl, conversation: conv, conversationOptions: {},
      getActiveId: () => 'inst1', getInstances: () => [],
    });
    history = lazy;
  }
  const ctl = installStickyPrompt({ scrollEl, pinEl, isConducted: () => state.conducted, viewHostEl: host, history, schedule: fn => fn() });
  conv ??= new Conversation(scrollEl, {});
  if (revealed) ctl.reveal();
  let userIndex = 0;
  // Appends a user echo and gives its bubble a document position.
  const say = (text, top, extra = {}) => {
    conv.apply({ kind: 'user_echo', text, userIndex: userIndex++, parentToolUseId: null, ...extra });
    const bubble = scrollEl.lastElementChild;
    layout.tops.set(bubble, top);
    bubble.getBoundingClientRect = () => ({ top: layout.viewOpen ? 0 : layout.tops.get(bubble) - scrollEl.scrollTop });
    return bubble;
  };
  const settle = () => new Promise(r => setTimeout(r, 0)); // MutationObserver delivery
  // A browser delivers the childList records before the next scroll frame; the
  // await gives the test the same order.
  const scrollTo = async (y) => { await settle(); scrollEl.scrollTop = y; ctl.refresh(); };
  return { win, Conversation, conv, scrollEl, pinEl, pane, host, ctl, layout, state, say, scrollTo, settle, history, lazy };
}

const pinText = (pinEl) => pinEl.querySelector('.user-text')?.textContent.trim();
// The status line's text, or undefined when none shows. A status line is the
// pin's only child and never sits beside a clone.
const statusOf = (pinEl) => {
  const line = pinEl.querySelector('.pinned-prompt-status');
  if (!line) return undefined;
  assert.equal(pinEl.childElementCount, 1, 'the status line is alone in the pin');
  assert.equal(pinEl.hidden, false, 'a status line is visible');
  return line.textContent;
};
// Revealed with nothing pinned: no clone, the given status line instead.
const assertStatus = (pinEl, want, msg) => {
  assertNull(pinEl.querySelector('.user-text'), `${msg}: no clone`);
  assert.equal(statusOf(pinEl), want, msg);
};

// ── pickPinned ───────────────────────────────────────────────────────────

const at = (tops) => (i) => tops[i];

test('pickPinned: a prompt at or below the viewport top is never pinned (scrolling above a prompt un-sticks it)', async (t) => {
  await t.test('all below', () => assert.equal(pickPinned(at([10, 200]), 2, 50), null));
  await t.test('exactly at the top', () => assert.equal(pickPinned(at([0, 200]), 2, 50), null));
  await t.test('within the 1px tolerance above the top', () => assert.equal(pickPinned(at([-1, 200]), 2, 50), null));
  await t.test('no prompts', () => assert.equal(pickPinned(at([]), 0, 50), null));
});

test('pickPinned: the last prompt above the top is the one pinned', async (t) => {
  await t.test('middle of three', () => assert.equal(pickPinned(at([-300, -50, 40]), 3, 50).index, 1));
  await t.test('last of three, nothing after', () => assert.deepEqual(pickPinned(at([-300, -200, -50]), 3, 50), { index: 2, shift: 0 }));
  await t.test('agrees with a linear scan at every scroll offset', () => {
    const tops = Array.from({ length: 41 }, (_, i) => i * 37 - 200);
    for (let scroll = -50; scroll < 1400; scroll += 13) {
      const rel = (i) => tops[i] - scroll;
      let want = -1;
      tops.forEach((_, i) => { if (rel(i) < -1) want = i; });
      assert.equal(pickPinned(rel, tops.length, 50)?.index ?? -1, want, `scroll ${scroll}`);
    }
  });
});

test('pickPinned: the next prompt pushes the pin up by exactly the overlap', async (t) => {
  await t.test('next 20px from the top under a 50px pin', () => assert.equal(pickPinned(at([-300, 20]), 2, 50).shift, -30));
  await t.test('next exactly a pin-height away: no shift', () => assert.equal(pickPinned(at([-300, 50]), 2, 50).shift, 0));
  await t.test('next farther away: no shift, never positive', () => assert.equal(Object.is(pickPinned(at([-300, 500]), 2, 50).shift, 0), true));
});

test('pickPinned: a next prompt reaching the top takes over', async (t) => {
  await t.test('next just above the top becomes the pin, unshifted', () => assert.deepEqual(pickPinned(at([-300, -2]), 2, 50), { index: 1, shift: 0 }));
  await t.test('next exactly at the tolerance edge: old pin fully pushed off', () => assert.deepEqual(pickPinned(at([-300, -1]), 2, 50), { index: 0, shift: -51 }));
});

// ── Conversation stamps the origin ───────────────────────────────────────

test('a typed prompt\'s bubble carries data-prompt-origin; a sub-agent echo\'s does not', async () => {
  const h = await harness();
  h.say('fix the test', 0);
  const stamped = h.scrollEl.querySelector('.msg.user');
  assert.equal(stamped.getAttribute('data-prompt-origin'), 'typed');

  const sub = document.createElement('div');
  const subConv = new h.Conversation(sub, { isSub: true });
  subConv.apply({ kind: 'user_echo', text: 'sub prompt', parentToolUseId: 'toolu_1' });
  assert.equal(sub.querySelector('.msg.user').hasAttribute('data-prompt-origin'), false);
});

test('an attachment-only bubble is stamped synthetic: it has no text to pin', async () => {
  const h = await harness();
  h.say('', 0, { attachments: [{ kind: 'file', name: 'a.txt' }] });
  assert.equal(h.scrollEl.querySelector('.msg.user').getAttribute('data-prompt-origin'), 'synthetic');
});

test('a bubble with no user-text block is stamped synthetic even when promptOrigin reads the event as typed, and never pins', async () => {
  const { promptOrigin } = await importFresh('promptOrigin.js');
  const bare = { kind: 'user_echo', text: '<transcribed>\n', parentToolUseId: null };
  assert.equal(promptOrigin(bare), 'typed', 'the event alone reads typed: only the bubble shape can tell');

  const h = await harness();
  const bubble = h.say(bare.text, 0);
  h.say('next prompt', 900);
  assertNull(bubble.querySelector('.user-text'), 'the bubble renders no user-text block');
  assert.equal(bubble.getAttribute('data-prompt-origin'), 'synthetic');
  await h.scrollTo(300); // past the bare bubble: a typed stamp would clone a missing node
  assertStatus(h.pinEl, STATUS_NONE, 'nothing eligible above the top');
});

test('a stamped question-answer bubble is synthetic, faithful or raw-fallback, and never pins even in a worker session', async (t) => {
  const { formatUserQuestionAnswers } = await importFresh('userQuestionAnswers.js');
  const questions = [{ question: 'Pick', header: 'P', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }];
  const faithful = formatUserQuestionAnswers(questions, [{ kind: 'option', label: 'A' }]);
  // Old-format/unparseable text fails the round trip, so the bubble falls back to a
  // raw user-text block nested INSIDE the answer block (not a direct child of .blocks).
  const raw = 'Answer to "Pick": line one\nline two';
  for (const [label, text] of Object.entries({ faithful, 'raw fallback': raw })) {
    await t.test(label, async () => {
      const h = await harness({ conducted: true });
      const bubble = h.say(text, 0, { questionAnswer: { toolUseId: 'toolu_q', questions } });
      h.say('next prompt', 900);
      assert.equal(bubble.getAttribute('data-prompt-origin'), 'synthetic');
      await h.scrollTo(300); // a template stamp here would clone a node that is not there
      assertStatus(h.pinEl, STATUS_NONE, 'nothing eligible above the top');
    });
  }
});

test('a lazy-history page stamps its prompts exactly as the live view does', async () => {
  const h = await harness();
  const { renderEventBatch, spliceBatchAbove } = await importFresh('lazyHistory.js');
  const events = [
    { kind: 'user_echo', text: 'typed prompt', userIndex: 0, parentToolUseId: null },
    { kind: 'user_echo', text: buildApprovePrompt('go small'), userIndex: 1, parentToolUseId: null },
    { kind: 'user_echo', text: buildWakeStub({ targetSessionId: 'abcd1234', payloadText: 'out' }), userIndex: 2, parentToolUseId: null },
  ];
  const live = document.createElement('div');
  new h.Conversation(live, {}).applyEvents(events);
  const liveOrigins = [...live.querySelectorAll('.msg.user')].map(b => b.getAttribute('data-prompt-origin'));
  assert.deepEqual(liveOrigins, ['typed', 'template', 'synthetic']);

  h.say('newer prompt', 500);
  spliceBatchAbove({ root: h.scrollEl, batch: renderEventBatch(events, {}), conversation: h.conv });
  const pagedOrigins = [...h.scrollEl.querySelectorAll('.msg.user')].map(b => b.getAttribute('data-prompt-origin'));
  assert.deepEqual(pagedOrigins, [...liveOrigins, 'typed']);
});

// ── The controller ───────────────────────────────────────────────────────

test('scrolling past a typed prompt pins a clone of its text without rewind/fork/raw/copy controls', async () => {
  const h = await harness();
  const bubble = h.say('the **original** prompt', 0);
  h.say('next prompt', 1000);
  assertStatus(h.pinEl, STATUS_NONE, 'nothing scrolled past yet');

  await h.scrollTo(300);
  assert.equal(h.pinEl.hidden, false);
  assert.equal(pinText(h.pinEl), 'the original prompt');
  assert.ok(h.pinEl.querySelector('.pinned-prompt-body > .user-text strong'), 'markdown rendering rides along');
  assertNull(h.pinEl.querySelector('.role'), 'no role row');
  assertNull(h.pinEl.querySelector('.user-view-controls'), 'no raw/copy controls');
  assertNull(h.pinEl.querySelector('.user-msg-actions'), 'no rewind/fork');
  assertNull(h.pinEl.querySelector('button'), 'no buttons at all');
  assert.ok(bubble.querySelector('.user-text') !== h.pinEl.querySelector('.user-text'), 'a clone, not the original node');
});

test('a template prompt pins in a conducted session and is skipped otherwise', async () => {
  const h = await harness({ conducted: false });
  h.say('typed one', 0);
  h.say(buildApprovePrompt('use the small variant'), 400);
  h.say('typed two', 2000);

  await h.scrollTo(700);
  assert.equal(pinText(h.pinEl), 'typed one', 'the plan decision is not a prompt outside a worker session');

  h.state.conducted = true;
  h.ctl.refresh();
  assert.match(pinText(h.pinEl), /^I approve the plan\. Additional notes: use the small variant/);
});

test('a synthetic turn never pins, whatever the session role', async () => {
  const h = await harness({ conducted: true });
  h.say(buildWakeStub({ targetSessionId: 'abcd1234', payloadText: 'worker output' }), 0);
  h.say('/clear', 400);
  await h.scrollTo(2000);
  assertStatus(h.pinEl, STATUS_NONE, 'nothing eligible above the top');
});

test('the pin shifts by the next prompt\'s overlap', async () => {
  const h = await harness();
  h.say('first', 0);
  h.say('second', 500);
  await h.scrollTo(470); // second is 30px below the top; the pin is 60px tall
  assert.equal(pinText(h.pinEl), 'first');
  assert.equal(h.pinEl.style.transform, `translateY(${30 - PIN_HEIGHT}px)`);

  await h.scrollTo(300); // second is 200px below: clear of the pin
  assert.equal(h.pinEl.style.transform, '');

  await h.scrollTo(520); // second has scrolled above the top and takes over
  assert.equal(pinText(h.pinEl), 'second');
  assert.equal(h.pinEl.style.transform, '');
});

test('a height change under the same pinned bubble updates the push-off on the next refresh', async () => {
  const h = await harness();
  h.say('first', 0);
  h.say('second', 500);
  await h.scrollTo(430); // second is 70px below the top; the pin is 60px tall: clear of it
  assert.equal(pinText(h.pinEl), 'first');
  assert.equal(h.pinEl.style.transform, '');
  const held = h.pinEl.querySelector('.pinned-prompt-body');

  h.layout.pinHeight = 90; // the clone re-wrapped (a resize narrowed it)
  h.ctl.refresh();
  assert.equal(h.pinEl.style.transform, 'translateY(-20px)');
  assert.ok(h.pinEl.querySelector('.pinned-prompt-body') === held, 'the same clone: no re-clone for a height change');
});

test('scrolling back above a prompt un-pins it and leaves the older one', async () => {
  const h = await harness();
  h.say('first', 0);
  h.say('second', 500);
  await h.scrollTo(900);
  assert.equal(pinText(h.pinEl), 'second');
  await h.scrollTo(300);
  assert.equal(pinText(h.pinEl), 'first');
  await h.scrollTo(0);
  assertStatus(h.pinEl, STATUS_NONE, 'above every prompt');
});

test('clicking the pin (or Enter/Space) scrolls the original bubble to the top; with no earlier prompt the status line replaces it', async (t) => {
  for (const [label, fire] of [
    ['click', (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))],
    ['Enter', (el) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))],
    ['Space', (el) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))],
  ]) {
    await t.test(label, async () => {
      const h = await harness();
      h.say('first', 100);
      h.say('second', 900);
      await h.scrollTo(400);
      assert.equal(pinText(h.pinEl), 'first');
      fire(h.pinEl);
      assert.equal(h.scrollEl.scrollTop, 100, 'the full bubble lands at the viewport top');
      h.ctl.refresh();
      assertStatus(h.pinEl, STATUS_NONE, 'a bubble at the top is no longer scrolled past, and nothing is above it');
    });
  }
  await t.test('another key does nothing', async () => {
    const h = await harness();
    h.say('first', 100);
    h.say('second', 900);
    await h.scrollTo(400);
    h.pinEl.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    assert.equal(h.scrollEl.scrollTop, 400);
  });
});

test('after a jump, the previous prompt stays pinned but a fully-pushed-off pin is hidden, not focusable', async (t) => {
  const setup = async () => {
    const h = await harness();
    h.say('P1', 0); h.say('P2', 400); h.say('P3', 1200);
    await h.scrollTo(600); // P2 is scrolled past and pinned
    assert.equal(pinText(h.pinEl), 'P2');
    h.pinEl.click();
    h.ctl.refresh(); // a browser fires `scroll` for the jump
    return h;
  };
  await t.test('the jump lands P2 at the top and the pin is fully pushed off, so it is hidden', async () => {
    const h = await setup();
    assert.equal(h.scrollEl.scrollTop, 400);
    assert.equal(h.pinEl.hidden, true, 'hidden also removes it from the tab order');
    assert.equal(pinText(h.pinEl), 'P1', 'the previous prompt is still the one held');
  });
  await t.test('scrolling on brings the same clone back without re-cloning', async () => {
    const h = await setup();
    const held = h.pinEl.querySelector('.pinned-prompt-body');
    await h.scrollTo(380); // P2 is 20px below the top: P1 peeks 40px of its 60
    assert.equal(h.pinEl.hidden, false);
    assert.equal(h.pinEl.style.transform, `translateY(${20 - PIN_HEIGHT}px)`);
    assert.ok(h.pinEl.querySelector('.pinned-prompt-body') === held, 'the clone is the one held while hidden');
  });
  await t.test('a pin pushed exactly to the top edge is hidden; one pixel lower shows', async () => {
    const h = await harness();
    h.say('P1', 0); h.say('P2', 400);
    await h.scrollTo(400); // P2 top at 0
    assert.equal(h.pinEl.hidden, true);
    await h.scrollTo(399); // P2 top at 1
    assert.equal(h.pinEl.hidden, false);
  });
  await t.test('nothing left to pin drops the clone', async () => {
    const h = await setup();
    await h.scrollTo(0);
    assertStatus(h.pinEl, STATUS_NONE, 'above every prompt');
  });
});

test('with nothing to pin, the pin is not rewritten on later frames', async (t) => {
  for (const revealed of [true, false]) {
    await t.test(revealed ? 'revealed: the status line stays as written' : 'not revealed: the hidden pin stays untouched', async () => {
      const h = await harness({ revealed });
      h.say('P1', 100); // stays below the viewport top for every scroll below
      await h.scrollTo(0);
      assert.equal(statusOf(h.pinEl), revealed ? STATUS_NONE : undefined);
      let writes = 0;
      new h.win.MutationObserver(() => { writes++; }).observe(h.pinEl, { attributes: true, childList: true, subtree: true, characterData: true });
      for (let y = 0; y < 5; y++) await h.scrollTo(y);
      await h.settle();
      assert.equal(writes, 0, 'the pin element is untouched while there is nothing to pin');
    });
  }
});

test('closing a full-page view brings the pin back without a scroll (the view host\'s class change refreshes)', async () => {
  const h = await harness();
  h.say('first', 0); h.say('second', 900);
  await h.scrollTo(300);
  assert.equal(pinText(h.pinEl), 'first');

  h.layout.viewOpen = true;            // the pane is display:none: rects read 0
  h.host.classList.add('settings-open');
  await h.settle();
  assert.equal(h.pinEl.hidden, true, 'the pin hides with the transcript');

  h.layout.viewOpen = false;           // closing the view: no scroll, resize or childList event
  h.host.classList.remove('settings-open');
  await h.settle();
  assert.equal(h.pinEl.hidden, false);
  assert.equal(pinText(h.pinEl), 'first');
});

test('the fade class is set only when the clone overflows the clamp', async (t) => {
  await t.test('overflowing', async () => {
    const h = await harness();
    h.layout.bodyScrollHeight = 200;
    h.say('long', 0); h.say('next', 900);
    await h.scrollTo(300);
    assert.equal(h.pinEl.querySelector('.pinned-prompt-body').classList.contains('overflowing'), true);
  });
  await t.test('fits', async () => {
    const h = await harness();
    h.layout.bodyScrollHeight = 40;
    h.say('short', 0); h.say('next', 900);
    await h.scrollTo(300);
    assert.equal(h.pinEl.querySelector('.pinned-prompt-body').classList.contains('overflowing'), false);
  });
  await t.test('one pixel of rounding is not overflow', async () => {
    const h = await harness();
    h.layout.bodyScrollHeight = h.layout.bodyClientHeight + 1;
    h.say('short', 0); h.say('next', 900);
    await h.scrollTo(300);
    assert.equal(h.pinEl.querySelector('.pinned-prompt-body').classList.contains('overflowing'), false);
  });
});

test('clearing the conversation drops the clone', async () => {
  const h = await harness();
  h.say('first', 0); h.say('second', 900);
  await h.scrollTo(300);
  assert.equal(h.pinEl.hidden, false);
  h.conv.clear();
  await h.settle();
  assertStatus(h.pinEl, STATUS_NONE, 'the clone does not linger');
});

test('a prompt appended after the pin was shown is picked up (the candidate list rebuilds on childList)', async () => {
  const h = await harness();
  h.say('first', 0);
  await h.scrollTo(300);
  assert.equal(h.pinEl.hidden, false);
  h.say('second', 100); // the conversation's own auto-scroll resets scrollTop
  await h.scrollTo(300);
  assert.equal(pinText(h.pinEl), 'second');
});

test('the pin\'s right edge clears the scroll root\'s scrollbar gutter (--conv-scrollbar)', async (t) => {
  const cases = {
    'a 15px gutter': { offsetWidth: 1000, clientWidth: 985, clientLeft: 0, want: '15px' },
    'no gutter': { offsetWidth: 1000, clientWidth: 1000, clientLeft: 0, want: '0px' },
    'a 1px border each side is not gutter': { offsetWidth: 1000, clientWidth: 983, clientLeft: 1, want: '15px' },
    'a border wider than the difference never goes negative': { offsetWidth: 1000, clientWidth: 999, clientLeft: 1, want: '0px' },
  };
  for (const [label, c] of Object.entries(cases)) {
    await t.test(label, async () => {
      const h = await harness();
      for (const k of ['offsetWidth', 'clientWidth', 'clientLeft']) {
        Object.defineProperty(h.scrollEl, k, { configurable: true, get: () => c[k] });
      }
      h.say('first', 0); h.say('second', 900);
      await h.scrollTo(300);
      assert.equal(h.pinEl.hidden, false);
      assert.equal(h.pinEl.style.getPropertyValue('--conv-scrollbar'), c.want);
    });
  }
});

test('the pin lives outside the scroll root', async () => {
  const h = await harness();
  h.say('first', 0); h.say('second', 900);
  const before = h.scrollEl.childElementCount;
  await h.scrollTo(300);
  assert.equal(h.pinEl.hidden, false);
  assert.equal(h.scrollEl.contains(h.pinEl), false);
  assert.equal(h.scrollEl.childElementCount, before, 'pinning adds nothing to the transcript');

  const html = await fs.readFile(path.join(PUB, 'index.html'), 'utf8');
  const doc = new Window().document;
  doc.write(html.replace(/<script\b[\s\S]*?<\/script>/g, ''));
  const pin = doc.getElementById('pinned-prompt');
  const conversation = doc.getElementById('conversation');
  assert.ok(pin.parentElement === conversation.parentElement, 'siblings inside one pane');
  assert.equal(pin.parentElement.id, 'conversation-pane');
  assert.equal(conversation.contains(pin), false);
});

// ── Reveal and autoload ──────────────────────────────────────────────────

test('the pin stays hidden until revealed, even with a prompt scrolled past; conceal() hides it and drops the clone', async () => {
  const h = await harness({ revealed: false });
  h.say('first', 0); h.say('second', 900);
  await h.scrollTo(300);
  assert.equal(h.pinEl.hidden, true, 'not revealed');
  assert.equal(h.pinEl.childElementCount, 0);

  h.ctl.reveal();
  assert.equal(h.pinEl.hidden, false);
  assert.equal(pinText(h.pinEl), 'first');

  h.ctl.conceal();
  assert.equal(h.pinEl.hidden, true);
  assert.equal(h.pinEl.childElementCount, 0, 'the clone is dropped');
  await h.scrollTo(310);
  assert.equal(h.pinEl.hidden, true, 'scrolling while concealed shows nothing');
});

test('revealed with no prompt above the top, history loads until one is pinned; found() sees a spliced bubble before any observer runs', async () => {
  const h = await harness({ revealed: false, history: fakeHistory({ hasMore: true }) });
  h.say('only', 100);
  await h.settle();
  h.ctl.reveal();
  assert.equal(h.history.runs.length, 1, 'a run starts');
  const run = h.history.runs[0];
  assert.equal(run.found(), false, 'nothing above the top yet');
  assert.equal(run.keepGoing(), true);

  // A page lands above: synchronous, as loadEarlier splices before resolving.
  const older = h.say('older', -200);
  h.scrollEl.prepend(older);
  assert.equal(run.found(), true, 'the eligible list was rebuilt inside found()');
  assert.equal(pinText(h.pinEl), 'older');
  assert.equal(statusOf(h.pinEl), undefined);

  run.resolve('found');
  await h.settle();
  assert.equal(pinText(h.pinEl), 'older');
  assert.equal(h.history.runs.length, 1, 'no further run');
});

test('revealed with nothing pinned, the status line says what the history is doing', async (t) => {
  await t.test('loading while a run is in flight', async () => {
    const h = await harness({ history: fakeHistory({ hasMore: true }) });
    h.say('only', 100);
    await h.scrollTo(0);
    assert.equal(h.history.runs.length, 1);
    assertStatus(h.pinEl, STATUS_LOADING, 'run pending');
  });
  await t.test('loading while history is not ready (no snapshot yet), with no run started', async () => {
    const h = await harness({ history: fakeHistory({ ready: false, hasMore: false }) });
    await h.scrollTo(0);
    assertStatus(h.pinEl, STATUS_LOADING, 'not ready');
    assert.equal(h.history.runs.length, 0);
  });
  await t.test('none when history is exhausted', async () => {
    const h = await harness({ history: fakeHistory({ hasMore: false }) });
    h.say('only', 100);
    await h.scrollTo(0);
    assertStatus(h.pinEl, STATUS_NONE, 'exhausted');
    assert.equal(h.history.runs.length, 0);
  });
  await t.test('none once a run ends exhausted', async () => {
    const h = await harness({ history: fakeHistory({ hasMore: true }) });
    await h.scrollTo(0);
    h.history.st.hasMore = false;
    h.history.runs[0].resolve('exhausted');
    await h.settle();
    assertStatus(h.pinEl, STATUS_NONE, 'run exhausted');
  });
  await t.test('failed after a stalled run', async () => {
    const h = await harness({ history: fakeHistory({ hasMore: true }) });
    await h.scrollTo(0);
    h.history.runs[0].resolve('stalled');
    await h.settle();
    assertStatus(h.pinEl, STATUS_FAILED, 'stalled');
  });
  await t.test('without a history controller: none', async () => {
    const h = await harness({ history: null });
    await h.scrollTo(0);
    assertStatus(h.pinEl, STATUS_NONE, 'no history');
  });
  await t.test('a pushed-off pin counts as found and shows no status', async () => {
    const h = await harness({ revealed: false, history: fakeHistory({ hasMore: true }) });
    h.say('P1', 10); h.say('P2', 400);
    await h.settle();
    h.ctl.reveal();
    const run = h.history.runs[0];
    h.scrollEl.scrollTop = 400; // P1 above the top, P2 at it: P1 is held but fully pushed off
    assert.equal(run.found(), true);
    assert.equal(h.pinEl.hidden, true);
    assert.equal(statusOf(h.pinEl), undefined);
    assert.equal(pinText(h.pinEl), 'P1');
  });
});

test('a stalled run is not retried by refreshes; reveal() retries', async () => {
  const h = await harness({ history: fakeHistory({ hasMore: true }) });
  await h.scrollTo(0);
  h.history.runs[0].resolve('stalled');
  await h.settle();
  for (let y = 0; y < 4; y++) await h.scrollTo(y);
  assert.equal(h.history.runs.length, 1, 'scrolling does not hammer a failing endpoint');
  h.ctl.reveal();
  assert.equal(h.history.runs.length, 2, 'pressing Down again retries');
  assertStatus(h.pinEl, STATUS_LOADING, 'retrying');
});

test('conceal() mid-run cancels it; its late result shows nothing', async () => {
  const h = await harness({ history: fakeHistory({ hasMore: true }) });
  await h.scrollTo(0);
  const run = h.history.runs[0];
  assert.equal(run.keepGoing(), true);
  h.ctl.conceal();
  assert.equal(run.keepGoing(), false, 'the run stops at its next check');
  run.resolve('stalled');
  await h.settle();
  assert.equal(h.pinEl.hidden, true);
  assert.equal(h.pinEl.childElementCount, 0, 'neither a pin nor a status line');
  h.ctl.reveal();
  assert.equal(h.history.runs.length, 2, 'a new reveal starts a fresh run, not blocked by the cancelled one');
  assert.equal(run.keepGoing(), false, 'the cancelled run stays cancelled');
  assertStatus(h.pinEl, STATUS_LOADING, 'the stale stall did not mark the new reveal failed');
});

test('no layout (a full-page view) starts no run; closing the view starts one', async () => {
  const h = await harness({ revealed: false, history: fakeHistory({ hasMore: true }) });
  h.layout.viewOpen = true;
  h.host.classList.add('settings-open');
  await h.settle();
  h.ctl.reveal();
  assert.equal(h.history.runs.length, 0, 'every rect reads 0: a run would page the whole history');
  assert.equal(h.pinEl.hidden, true, 'no status line in a hidden pane');

  h.layout.viewOpen = false;
  h.host.classList.remove('settings-open');
  await h.settle();
  assert.equal(h.history.runs.length, 1);
  assertStatus(h.pinEl, STATUS_LOADING, 'view closed');
});

test('a view opening mid-run stops it at the next check', async () => {
  const h = await harness({ history: fakeHistory({ hasMore: true }) });
  await h.scrollTo(0);
  const run = h.history.runs[0];
  h.layout.viewOpen = true;
  assert.equal(run.keepGoing(), false);
});

test('refreshes while a run is in flight start no second run', async () => {
  const h = await harness({ history: fakeHistory({ hasMore: true }) });
  await h.scrollTo(0);
  for (let y = 0; y < 4; y++) await h.scrollTo(y);
  h.ctl.reveal();
  assert.equal(h.history.runs.length, 1);
});

test('after a same-session reset (rewind) a revealed pin reads none, after a switch it reads loading', async (t) => {
  const stubFetch = (calls) => {
    globalThis.fetch = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ events: [], nextBefore: 0, hasMore: false }) };
    };
  };
  await t.test('reset() without switching: none, no fetch', async () => {
    const calls = [];
    stubFetch(calls);
    const h = await harness({ revealed: false, history: 'real' });
    h.lazy.init({ tailStartSeq: 0 }); // the silent probe finds nothing earlier
    await h.settle();
    h.lazy.reset();
    const fetched = calls.length;
    h.ctl.reveal();
    await h.settle();
    assertStatus(h.pinEl, STATUS_NONE, 'paging stays off after a rewind');
    assert.equal(calls.length, fetched, 'nothing to page');
  });
  await t.test('reset({ switching: true }): loading until the next snapshot', async () => {
    const calls = [];
    stubFetch(calls);
    const h = await harness({ revealed: false, history: 'real' });
    h.lazy.init({ tailStartSeq: 0 });
    await h.settle();
    h.lazy.reset({ switching: true });
    h.ctl.reveal();
    await h.settle();
    assertStatus(h.pinEl, STATUS_LOADING, 'waiting for the snapshot');
  });
});

// ── Static wiring ────────────────────────────────────────────────────────

test('no full-page view hides #conversation without its pane', async () => {
  const css = await fs.readFile(path.join(PUB, 'styles.css'), 'utf8');
  assert.equal(/#main\.[\w-]+-open #conversation(?![\w-])/.test(css), false, 'a hide list still names #conversation itself');
  // Every full-page view hides the transcript's siblings together.
  const views = new Set([...css.matchAll(/#main\.([\w-]+-open) #turn-indicator/g)].map(m => m[1]));
  assert.ok(views.size >= 5, `expected the full-page views, found ${[...views]}`);
  for (const v of views) {
    assert.ok(css.includes(`#main.${v} #conversation-pane`), `#main.${v} must hide #conversation-pane`);
  }
});

// The pin's look is CSS the happy-dom layout cannot reach, so its contract is
// read from styles.css: the declarations of one rule, by exact selector.
async function pinRule(selector) {
  const css = await fs.readFile(path.join(PUB, 'styles.css'), 'utf8');
  const esc = selector.replace(/[.]/g, '\\.');
  const m = css.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `${selector} rule not found`);
  return m[1];
}

test('the clamp is five lines, and the fade is anchored to the bottom of the clamp, not a share of it', async () => {
  const body = await pinRule('.pinned-prompt-body');
  assert.match(body, /max-height:\s*calc\(5 \* 1lh\)/, 'five lines show before the fade');
  const fade = await pinRule('.pinned-prompt-body.overflowing');
  for (const prop of ['-webkit-mask-image', 'mask-image']) {
    const m = fade.match(new RegExp(`(?:^|[\\s;])${prop}:\\s*linear-gradient\\(([^;]*)\\);`));
    assert.ok(m, `${prop} declared`);
    // A percentage stop scales with the clamp: at 55% it would dim lines 3-5.
    assert.match(m[1], /#000 calc\(100% - [\d.]+lh\)/, `${prop} fades over the last lines only`);
  }
});

test('the pin\'s shadow sits on the outer box, adds a light edge line, and takes no layout space', async () => {
  const outer = await pinRule('.pinned-prompt');
  const m = outer.match(/box-shadow:\s*([^;]+);/);
  assert.ok(m, 'the pin declares a box-shadow');
  const layers = m[1].split(/,(?![^(]*\))/).map(s => s.trim());
  assert.equal(layers.some(l => /^inset\b/.test(l)), false, 'an inset shadow would paint inside the box');
  // A black shadow alone is hard to see on near-black surfaces: the first layer
  // is a faint white 1px line hugging the bottom edge (no blur, no spread).
  assert.match(layers[0], /^0 1px 0 rgba\(255, 255, 255, \.\d+\)$/, 'first layer is the light separator');
  assert.ok(layers.slice(1).some(l => /^0 [1-9]\d*px [1-9]\d*px rgba\(0, 0, 0, /.test(l)), 'a black shadow falls below the pin');
  // The mask belongs to the inner body: on the outer box it would clip the shadow.
  assert.equal(/mask/.test(outer), false, 'no mask on the outer box');
  assert.equal(/overflow/.test(outer), false, 'no overflow clip on the outer box');
});

test('the swipe zones (the top bar and the pin) start no browser vertical pan', async () => {
  for (const selector of ['#instance-header', '.pinned-prompt']) {
    assert.match(await pinRule(selector), /(?:^|[\s;])touch-action:\s*pan-x;/, `${selector} declares touch-action: pan-x`);
  }
});
