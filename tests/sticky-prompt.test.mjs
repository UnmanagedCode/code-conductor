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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNull } from './dom-assert.mjs';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { pickPinned } from '../public/stickyPrompt.js';
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

// A Conversation on a scroll root, the pin, and the installed controller. The
// module graph is imported fresh so the controller binds THIS window's globals.
async function harness({ conducted = false } = {}) {
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
  const layout = { viewOpen: false, tops: new Map(), bodyScrollHeight: 20, bodyClientHeight: 57 };
  Object.defineProperty(pinEl, 'offsetHeight', { get: () => PIN_HEIGHT });
  // The pin's body is created by the controller, so its clamp is faked on the prototype.
  const isPinBody = (el) => el.classList.contains('pinned-prompt-body');
  Object.defineProperty(win.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return isPinBody(this) ? layout.bodyScrollHeight : 0; } });
  Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return isPinBody(this) ? layout.bodyClientHeight : 0; } });
  scrollEl.getBoundingClientRect = () => ({ top: 0 });
  const state = { conducted };
  const ctl = installStickyPrompt({ scrollEl, pinEl, isConducted: () => state.conducted, viewHostEl: host, schedule: fn => fn() });
  const conv = new Conversation(scrollEl, {});
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
  return { win, Conversation, conv, scrollEl, pinEl, pane, host, ctl, layout, state, say, scrollTo, settle };
}

const pinText = (pinEl) => pinEl.querySelector('.user-text')?.textContent.trim();

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
  assert.equal(h.pinEl.hidden, true, 'nothing scrolled past yet');

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
  assert.equal(h.pinEl.hidden, true);
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

test('scrolling back above a prompt un-pins it and leaves the older one', async () => {
  const h = await harness();
  h.say('first', 0);
  h.say('second', 500);
  await h.scrollTo(900);
  assert.equal(pinText(h.pinEl), 'second');
  await h.scrollTo(300);
  assert.equal(pinText(h.pinEl), 'first');
  await h.scrollTo(0);
  assert.equal(h.pinEl.hidden, true);
});

test('clicking the pin (or Enter/Space) scrolls the original bubble to the top; with no earlier prompt the pin hides', async (t) => {
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
      assert.equal(h.pinEl.hidden, true, 'a bubble at the top is no longer scrolled past, and nothing is above it');
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
    assert.equal(h.pinEl.hidden, true);
    assert.equal(h.pinEl.childElementCount, 0);
  });
});

test('a hidden pin with nothing pinned is not rewritten on later frames', async () => {
  const h = await harness();
  h.say('P1', 100); // stays below the viewport top for every scroll below
  await h.scrollTo(0);
  let writes = 0;
  new h.win.MutationObserver(() => { writes++; }).observe(h.pinEl, { attributes: true, childList: true });
  for (let y = 0; y < 5; y++) await h.scrollTo(y);
  await h.settle();
  assert.equal(writes, 0, 'the pin element is untouched while there is nothing to pin');
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

test('clearing the conversation hides the pin', async () => {
  const h = await harness();
  h.say('first', 0); h.say('second', 900);
  await h.scrollTo(300);
  assert.equal(h.pinEl.hidden, false);
  h.conv.clear();
  await h.settle();
  assert.equal(h.pinEl.hidden, true);
  assert.equal(h.pinEl.childElementCount, 0, 'the clone does not linger');
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
