// Unit tests for the makeDismissable() factory extracted from app.js — the
// shared click-outside / Escape dismiss-listener wiring used by the header
// usage popover and the two ⋮ overflow menus. Mirrors the happy-dom setup in
// lightbox.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function setup() {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.KeyboardEvent = window.KeyboardEvent;
  const url = pathToFileURL(path.resolve(__dirname, '..', 'public', 'dismissable.js')).href + '?t=' + Math.random();
  const { makeDismissable } = await import(url);

  document.body.innerHTML = '<div id="inside"></div><div id="outside"></div>';
  const inside = document.getElementById('inside');
  const outside = document.getElementById('outside');
  let calls = 0;
  const ctl = makeDismissable({
    isInside: (t) => inside.contains(t),
    onDismiss: () => { calls += 1; },
  });
  return { window, document, inside, outside, ctl, calls: () => calls };
}

function pointerdown(window, node) {
  node.dispatchEvent(new window.Event('pointerdown', { bubbles: true, cancelable: true }));
}
function keydown(window, node, key) {
  node.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

test('makeDismissable: armed flips on arm()/disarm() and starts disarmed', async () => {
  const { ctl } = await setup();
  assert.equal(ctl.armed, false);
  ctl.arm();
  assert.equal(ctl.armed, true);
  ctl.disarm();
  assert.equal(ctl.armed, false);
});

test('makeDismissable: outside pointerdown dismisses, inside does not', async () => {
  const { window, inside, outside, ctl, calls } = await setup();
  ctl.arm();
  pointerdown(window, inside);
  assert.equal(calls(), 0, 'inside pointerdown must not dismiss');
  pointerdown(window, outside);
  assert.equal(calls(), 1, 'outside pointerdown dismisses');
});

test('makeDismissable: Escape dismisses, other keys do not', async () => {
  const { window, document, ctl, calls } = await setup();
  ctl.arm();
  keydown(window, document.body, 'a');
  assert.equal(calls(), 0, 'non-Escape key must not dismiss');
  keydown(window, document.body, 'Escape');
  assert.equal(calls(), 1, 'Escape dismisses');
});

test('makeDismissable: disarm() removes both listeners (no further dismiss)', async () => {
  const { window, document, outside, ctl, calls } = await setup();
  ctl.arm();
  ctl.disarm();
  pointerdown(window, outside);
  keydown(window, document.body, 'Escape');
  assert.equal(calls(), 0, 'no dismiss after disarm');
});

test('makeDismissable: disarm() is idempotent', async () => {
  const { ctl } = await setup();
  ctl.disarm();   // never armed
  ctl.arm();
  ctl.disarm();
  ctl.disarm();   // double disarm
  assert.equal(ctl.armed, false);
});
