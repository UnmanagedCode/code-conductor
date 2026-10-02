// The sticky prompt's swipe-down reveal on the one-row phone header: the real
// index.html and real installHeader() at 360px, wired to the real
// installPromptReveal() over the same zones app.js passes (#instance-header and
// the pin). tests/prompt-reveal.test.mjs pins the gesture algorithm on a stub
// header; this pins that the restructured header's real surface is the hit area.
// Whether `touch-action` really suppresses pull-to-refresh is a browser-UI
// property and not reachable here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SWIPE_MIN_PX } from '../public/promptReveal.js';
import { setupHeader, session, WORKTREE, PUB } from './headerCompactHarness.mjs';

async function swipeSetup() {
  const t = await setupHeader({ width: 360 });
  const { installPromptReveal } = await import(pathToFileURL(path.join(PUB, 'promptReveal.js')).href);
  const calls = [];
  installPromptReveal({
    textarea: t.document.getElementById('composer-input'),
    swipeZones: [t.document.getElementById('instance-header'), t.document.getElementById('pinned-prompt')],
    onReveal: () => calls.push('reveal'),
    onConceal: () => calls.push('conceal'),
  });
  const touch = (el, type, points) => {
    const e = new t.window.TouchEvent(type, {
      bubbles: true, cancelable: true,
      touches: points.map(([clientX, clientY]) => ({ clientX, clientY })),
    });
    el.dispatchEvent(e);
    return e;
  };
  const swipe = (el, dy) => {
    touch(el, 'touchstart', [[0, 0]]);
    touch(el, 'touchmove', [[0, dy]]);
    touch(el, 'touchend', []);
  };
  t.show(session('idle', { title: 'My task', worktree: WORKTREE }));
  return { ...t, calls, touch, swipe };
}

// Invariant: a vertical swipe starting on ANY part of the one-row bar — title
// chip, subline chip, ≡, the mode switch, 📋, ⋮ — reveals (down) or conceals
// (up); buttons are not dead zones.
test('a swipe down/up starting anywhere on the one-row bar reveals/conceals', async (tt) => {
  const starts = {
    'title chip': (t) => t.dom.instanceTitle.querySelector('.ih-title'),
    'subline worktree chip': (t) => t.dom.instanceTitle.querySelector('.ih-line-sub .ih-worktree'),
    '≡ toggle': (t) => t.document.getElementById('sidebar-toggle'),
    'Plan/Code button': (t) => t.dom.modeToggle.querySelector('[data-mode="bypassPermissions"]'),
    '📋': (t) => t.dom.autoApprovePlanBtn,
    '⋮ toggle': (t) => t.dom.overflowToggle,
  };
  for (const [name, pick] of Object.entries(starts)) {
    await tt.test(name, async () => {
      const t = await swipeSetup();
      const el = pick(t);
      assert.ok(el, `${name} resolves`);
      t.swipe(el, SWIPE_MIN_PX + 20);
      t.swipe(el, -(SWIPE_MIN_PX + 20));
      assert.deepEqual(t.calls, ['reveal', 'conceal']);
    });
  }
});

// Invariant: the menu exclusion covers the Sync / Merge items relocated into ⋮.
test('a swipe starting on the relocated ⋮ Sync item is ignored', async () => {
  const t = await swipeSetup();
  t.dom.overflowToggle.click();
  assert.equal(t.dom.syncMenuBtn.hidden, false, 'precondition: the item is shown');
  t.swipe(t.dom.syncMenuBtn, SWIPE_MIN_PX + 20);
  t.swipe(t.dom.mergeMenuBtn, -(SWIPE_MIN_PX + 20));
  assert.deepEqual(t.calls, []);
});

// Invariant: a tap on a bar button is neither a swipe nor blocked — the touch
// listeners never cancel it, and the click still lands.
test('a tap on a bar button neither reveals nor is blocked', async () => {
  const t = await swipeSetup();
  const code = t.dom.modeToggle.querySelector('[data-mode="bypassPermissions"]');
  const start = t.touch(code, 'touchstart', [[0, 0]]);
  t.touch(code, 'touchend', []);
  assert.deepEqual(t.calls, [], 'no reveal or conceal');
  assert.equal(start.defaultPrevented, false, 'touchstart was not cancelled');
  code.click();
  await new Promise(r => setImmediate(r));
  assert.equal(t.framesOf('mode').length, 1, 'the click still sends the mode frame');
});

// Invariant: an open ⋮ does not block the gesture for a swipe that starts
// outside the panel.
test('with ⋮ open, a swipe starting outside the panel still reveals', async () => {
  const t = await swipeSetup();
  t.dom.overflowToggle.click();
  assert.equal(t.dom.overflowPanel.hidden, false, 'precondition: the menu is open');
  t.swipe(t.dom.instanceTitle.querySelector('.ih-title'), SWIPE_MIN_PX + 20);
  assert.deepEqual(t.calls, ['reveal']);
});
