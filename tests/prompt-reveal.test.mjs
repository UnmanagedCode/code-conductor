// The sticky prompt's reveal gestures (public/promptReveal.js): Down/Up in the
// composer at the caret's ends, and a vertical swipe on the swipe zones.
//
// happy-dom's TouchEvent carries `touches` from its init dict, so the swipes are
// real TouchEvents with plain `{ clientX, clientY }` touch points. Whether
// `touch-action: pan-x pinch-zoom` really suppresses pull-to-refresh is a
// property of the browser UI and is not reachable here (the declaration itself is pinned in
// tests/sticky-prompt.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { SWIPE_MIN_PX } from '../public/promptReveal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

let uid = 0;
async function importFresh(file) {
  uid++;
  return import(pathToFileURL(path.join(PUB, file)).href + `?uid=${uid}`);
}

async function harness() {
  const win = new Window({ url: 'http://localhost/' });
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Element = win.Element;
  globalThis.Node = win.Node;
  document.body.innerHTML = `
    <header id="instance-header"><button id="btn">⋯</button>
      <div id="overflow-panel" role="menu"><button id="menu-item">Item</button></div></header>
    <div id="pinned-prompt"></div>
    <div id="conversation"></div>
    <textarea id="composer-input"></textarea>`;
  const { installPromptReveal } = await importFresh('promptReveal.js');
  const $ = (id) => document.getElementById(id);
  const calls = [];
  installPromptReveal({
    textarea: $('composer-input'),
    swipeZones: [$('instance-header'), $('pinned-prompt')],
    onReveal: () => calls.push('reveal'),
    onConceal: () => calls.push('conceal'),
  });
  const textarea = $('composer-input');
  const key = (k, init = {}) => {
    const e = new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    textarea.dispatchEvent(e);
    return e;
  };
  const setText = (value, start = value.length, end = start) => {
    textarea.value = value;
    textarea.setSelectionRange(start, end);
  };
  const touch = (el, type, points) => el.dispatchEvent(new win.TouchEvent(type, {
    bubbles: true, cancelable: true,
    touches: points.map(([clientX, clientY]) => ({ clientX, clientY })),
  }));
  // A one-finger gesture from (0, 0) through each [dx, dy], then lifted.
  const swipe = (el, moves) => {
    touch(el, 'touchstart', [[0, 0]]);
    for (const m of moves) touch(el, 'touchmove', [m]);
    touch(el, 'touchend', []);
  };
  return { win, $, calls, textarea, key, setText, touch, swipe };
}

// ── Keyboard ─────────────────────────────────────────────────────────────

test('Down reveals only with the caret at the very end of the text', async (t) => {
  await t.test('at the end', async () => {
    const h = await harness();
    h.setText('hello');
    h.key('ArrowDown');
    assert.deepEqual(h.calls, ['reveal']);
  });
  await t.test('mid-text', async () => {
    const h = await harness();
    h.setText('hello', 4);
    h.key('ArrowDown');
    assert.deepEqual(h.calls, []);
  });
  await t.test('at the start of non-empty text', async () => {
    const h = await harness();
    h.setText('hello', 0);
    h.key('ArrowDown');
    assert.deepEqual(h.calls, []);
  });
});

test('Up conceals only with the caret at the very start of the text', async (t) => {
  await t.test('at the start', async () => {
    const h = await harness();
    h.setText('hello', 0);
    h.key('ArrowUp');
    assert.deepEqual(h.calls, ['conceal']);
  });
  await t.test('mid-text', async () => {
    const h = await harness();
    h.setText('hello', 1);
    h.key('ArrowUp');
    assert.deepEqual(h.calls, []);
  });
  await t.test('at the end of non-empty text', async () => {
    const h = await harness();
    h.setText('hello');
    h.key('ArrowUp');
    assert.deepEqual(h.calls, []);
  });
});

test('an empty composer satisfies both caret rules', async () => {
  const h = await harness();
  h.setText('');
  h.key('ArrowDown');
  h.key('ArrowUp');
  assert.deepEqual(h.calls, ['reveal', 'conceal']);
});

test('a modifier, a selection or IME composition makes Down/Up do nothing', async (t) => {
  for (const mod of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey', 'isComposing']) {
    await t.test(mod, async () => {
      const h = await harness();
      h.setText('');
      h.key('ArrowDown', { [mod]: true });
      h.key('ArrowUp', { [mod]: true });
      assert.deepEqual(h.calls, []);
    });
  }
  await t.test('a non-collapsed selection touching both ends', async () => {
    const h = await harness();
    h.setText('hello', 0, 5);
    h.key('ArrowDown');
    h.key('ArrowUp');
    assert.deepEqual(h.calls, []);
  });
});

test('Down/Up are never prevented, whether or not they act', async () => {
  const h = await harness();
  const cases = [['', 0], ['hello', 5], ['hello', 0], ['hello', 2]];
  for (const [text, caret] of cases) {
    for (const k of ['ArrowDown', 'ArrowUp']) {
      h.setText(text, caret);
      assert.equal(h.key(k).defaultPrevented, false, `${k} in ${JSON.stringify(text)} at ${caret}`);
    }
  }
  assert.ok(h.calls.length > 0, 'some of those acted');
});

test('Enter still submits with the reveal listener on the same textarea', async () => {
  const win = new Window({ url: 'http://localhost/' });
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Element = win.Element;
  globalThis.Node = win.Node;
  document.body.innerHTML = `
    <form id="composer">
      <div id="composer-attachments" hidden></div>
      <textarea id="composer-input"></textarea>
      <input id="composer-file" type="file" hidden />
      <button id="composer-attach" type="button"></button>
      <button id="composer-send" type="button"><span class="cs-label">Send</span></button>
    </form>`;
  const form = document.getElementById('composer');
  form.requestSubmit = () => form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  const textarea = document.getElementById('composer-input');
  const { attachComposer } = await importFresh('composer.js');
  const { installPromptReveal } = await importFresh('promptReveal.js');
  const submitted = [];
  const composer = attachComposer({
    form, textarea,
    sendBtn: document.getElementById('composer-send'),
    attachBtn: document.getElementById('composer-attach'),
    fileInput: document.getElementById('composer-file'),
    chipsContainer: document.getElementById('composer-attachments'),
    onSubmit: (payload) => submitted.push(payload.text),
  });
  const reveals = [];
  installPromptReveal({ textarea, swipeZones: [], onReveal: () => reveals.push('reveal'), onConceal: () => reveals.push('conceal') });
  composer.set({ canType: true, canSend: true });
  textarea.value = 'ship it';
  textarea.dispatchEvent(new win.Event('input', { bubbles: true }));
  textarea.setSelectionRange(7, 7);
  textarea.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.deepEqual(submitted, ['ship it']);
  assert.deepEqual(reveals, [], 'Enter is not a reveal key');
});

// ── Swipe ────────────────────────────────────────────────────────────────

test('a vertical swipe on a zone reveals (down) or conceals (up)', async (t) => {
  for (const zone of ['instance-header', 'pinned-prompt']) {
    await t.test(`${zone}: down`, async () => {
      const h = await harness();
      h.swipe(h.$(zone), [[0, SWIPE_MIN_PX]]);
      assert.deepEqual(h.calls, ['reveal']);
    });
    await t.test(`${zone}: up`, async () => {
      const h = await harness();
      h.swipe(h.$(zone), [[0, -SWIPE_MIN_PX]]);
      assert.deepEqual(h.calls, ['conceal']);
    });
  }
});

test('a swipe commits once per gesture, however far it continues', async () => {
  const h = await harness();
  h.swipe(h.$('instance-header'), [[0, SWIPE_MIN_PX], [0, 2 * SWIPE_MIN_PX], [0, 5 * SWIPE_MIN_PX]]);
  assert.deepEqual(h.calls, ['reveal']);
  h.swipe(h.$('instance-header'), [[0, SWIPE_MIN_PX]]);
  assert.deepEqual(h.calls, ['reveal', 'reveal'], 'the next gesture commits again');
});

test('a swipe short of the threshold does nothing', async () => {
  const h = await harness();
  h.swipe(h.$('instance-header'), [[0, SWIPE_MIN_PX - 1]]);
  h.swipe(h.$('instance-header'), [[0, 1 - SWIPE_MIN_PX]]);
  assert.deepEqual(h.calls, []);
});

test('a diagonal or horizontal move does nothing', async (t) => {
  await t.test('diagonal: vertical travel under twice the horizontal', async () => {
    const h = await harness();
    h.swipe(h.$('instance-header'), [[SWIPE_MIN_PX, 2 * SWIPE_MIN_PX - 1]]);
    assert.deepEqual(h.calls, []);
  });
  await t.test('horizontal-dominant abandons the gesture, even if it then turns vertical', async () => {
    const h = await harness();
    h.swipe(h.$('instance-header'), [[SWIPE_MIN_PX, 0], [SWIPE_MIN_PX, 10 * SWIPE_MIN_PX]]);
    assert.deepEqual(h.calls, []);
  });
});

test('a small sideways lead under the threshold does not abandon a swipe that then goes vertical', async () => {
  const h = await harness();
  h.swipe(h.$('instance-header'), [[10, 3], [10, SWIPE_MIN_PX]]);
  assert.deepEqual(h.calls, ['reveal']);
});

test('an exactly-45° lead at the threshold does not abandon a swipe: horizontal must strictly dominate', async () => {
  const h = await harness();
  h.swipe(h.$('instance-header'), [[SWIPE_MIN_PX, SWIPE_MIN_PX], [SWIPE_MIN_PX, 2 * SWIPE_MIN_PX]]);
  assert.deepEqual(h.calls, ['reveal']);
});

test('a two-finger touch does nothing', async (t) => {
  await t.test('two fingers from the start', async () => {
    const h = await harness();
    const el = h.$('instance-header');
    h.touch(el, 'touchstart', [[0, 0], [50, 0]]);
    h.touch(el, 'touchmove', [[0, SWIPE_MIN_PX], [50, SWIPE_MIN_PX]]);
    assert.deepEqual(h.calls, []);
  });
  await t.test('a second finger mid-gesture abandons it', async () => {
    const h = await harness();
    const el = h.$('instance-header');
    h.touch(el, 'touchstart', [[0, 0]]);
    h.touch(el, 'touchmove', [[0, 10], [50, 10]]);
    h.touch(el, 'touchmove', [[0, SWIPE_MIN_PX]]);
    assert.deepEqual(h.calls, []);
  });
});

test('a gesture that starts with two fingers is never tracked, even once one lifts', async (t) => {
  await t.test('one finger left, dragged with no lift event in between', async () => {
    const h = await harness();
    const el = h.$('instance-header');
    h.touch(el, 'touchstart', [[0, 0], [50, 0]]);
    h.touch(el, 'touchmove', [[0, SWIPE_MIN_PX]]);
    h.touch(el, 'touchmove', [[0, 3 * SWIPE_MIN_PX]]);
    assert.deepEqual(h.calls, []);
  });
  await t.test('one finger lifts (touchend with one touch left), then the other drags', async () => {
    const h = await harness();
    const el = h.$('instance-header');
    h.touch(el, 'touchstart', [[0, 0], [50, 0]]);
    h.touch(el, 'touchend', [[0, 0]]);
    h.touch(el, 'touchmove', [[0, SWIPE_MIN_PX]]);
    h.touch(el, 'touchmove', [[0, 3 * SWIPE_MIN_PX]]);
    assert.deepEqual(h.calls, []);
  });
});

test('a swipe that starts inside the overflow menu is ignored', async () => {
  const h = await harness();
  h.swipe(h.$('menu-item'), [[0, SWIPE_MIN_PX]]);
  assert.deepEqual(h.calls, []);
  h.swipe(h.$('btn'), [[0, SWIPE_MIN_PX]]);
  assert.deepEqual(h.calls, ['reveal'], 'a header button outside the menu is still a swipe zone');
});

test('touchcancel ends tracking', async () => {
  const h = await harness();
  const el = h.$('instance-header');
  h.touch(el, 'touchstart', [[0, 0]]);
  h.touch(el, 'touchcancel', []);
  h.touch(el, 'touchmove', [[0, SWIPE_MIN_PX]]);
  assert.deepEqual(h.calls, []);
});

test('touchend ends tracking', async () => {
  const h = await harness();
  const el = h.$('instance-header');
  h.touch(el, 'touchstart', [[0, 0]]);
  h.touch(el, 'touchend', []);
  h.touch(el, 'touchmove', [[0, SWIPE_MIN_PX]]);
  assert.deepEqual(h.calls, []);
});

test('a swipe outside the zones (the transcript) does nothing', async () => {
  const h = await harness();
  h.swipe(h.$('conversation'), [[0, SWIPE_MIN_PX]]);
  h.swipe(h.$('conversation'), [[0, -SWIPE_MIN_PX]]);
  assert.deepEqual(h.calls, []);
});
