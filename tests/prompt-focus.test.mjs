// public/promptFocus.js against the real public/composer.js under happy-dom:
// the disabled state comes from composer.set({canType}), not a hand-set
// attribute. Node identity is asserted with assert.ok(a === b) (see
// docs/frontend-testing.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const load = (name) => import(pathToFileURL(path.join(PUB, name)).href + `?t=${Math.random()}`);

async function setup({ canType = true, touch = false } = {}) {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.alert = () => {};
  const doc = window.document;
  doc.body.innerHTML = `
    <form id="composer">
      <div id="composer-attachments" hidden></div>
      <textarea id="composer-input"></textarea>
      <input id="composer-file" type="file" hidden />
      <button id="composer-attach" type="button"></button>
      <button id="composer-send" type="button" disabled>
        <span class="cs-label">Send</span><svg class="cs-mic"></svg>
      </button>
    </form>
    <button id="other-button" type="button"></button>
    <input id="other-input" type="text" />
    <div id="other-editable" contenteditable="true" tabindex="0"></div>
    <dialog id="modal"></dialog>`;
  const textarea = doc.getElementById('composer-input');
  const { attachComposer } = await load('composer.js');
  const composer = attachComposer({
    form: doc.getElementById('composer'),
    textarea,
    sendBtn: doc.getElementById('composer-send'),
    attachBtn: doc.getElementById('composer-attach'),
    fileInput: doc.getElementById('composer-file'),
    chipsContainer: doc.getElementById('composer-attachments'),
    onSubmit: () => {},
  });
  composer.set({ canType, canSend: canType });

  const { installPromptFocus } = await load('promptFocus.js');
  const { TOUCH_QUERY } = await load('layout.js');
  // A touch-primary device answers the (hover: none) query; every other
  // query still goes to the real window.
  const win = touch
    ? { matchMedia: (q) => (q === TOUCH_QUERY ? { matches: true } : window.matchMedia(q)) }
    : window;
  const promptFocus = installPromptFocus({ textarea, win, doc });
  const byId = (id) => doc.getElementById(id);
  // The lightbox backdrop: an [aria-modal] element, open unless it carries hidden.
  const addLightbox = ({ hidden = false } = {}) => {
    const el = doc.createElement('div');
    el.setAttribute('aria-modal', 'true');
    if (hidden) el.setAttribute('hidden', '');
    doc.body.appendChild(el);
    return el;
  };
  return { doc, textarea, promptFocus, byId, addLightbox };
}

test('a user-gesture selection focuses an enabled prompt bar', async () => {
  const { doc, textarea, promptFocus } = await setup();
  assert.ok(doc.activeElement !== textarea, 'precondition: the prompt bar is not focused');
  promptFocus.afterSelect({ userGesture: true });
  assert.ok(doc.activeElement === textarea, 'focus moved to the prompt bar');
});

test('a selection with no options leaves focus where it was', async () => {
  const { doc, byId, promptFocus } = await setup();
  const button = byId('other-button');
  button.focus();
  promptFocus.afterSelect();
  assert.ok(doc.activeElement === button, 'focus stayed on the button');
});

test('a selection with userGesture:false leaves focus where it was', async () => {
  const { doc, byId, promptFocus } = await setup();
  const button = byId('other-button');
  button.focus();
  promptFocus.afterSelect({ userGesture: false });
  assert.ok(doc.activeElement === button, 'focus stayed on the button');
});

test('a session whose prompt bar is disabled is not focused', async () => {
  const { doc, textarea, promptFocus } = await setup({ canType: false });
  assert.equal(textarea.disabled, true, 'precondition: composer.set({canType:false}) disabled the box');
  promptFocus.afterSelect({ userGesture: true });
  assert.ok(doc.activeElement !== textarea, 'a disabled prompt bar takes no focus');
});

test('an open modal dialog keeps focus', async () => {
  const { doc, byId, textarea, promptFocus } = await setup();
  const button = byId('other-button');
  button.focus();
  byId('modal').setAttribute('open', '');
  promptFocus.afterSelect({ userGesture: true });
  assert.ok(doc.activeElement !== textarea, 'the open dialog blocks the focus');
});

test('a closed dialog does not block focus', async () => {
  const { doc, textarea, promptFocus } = await setup();
  promptFocus.afterSelect({ userGesture: true });
  assert.ok(doc.activeElement === textarea, 'a dialog without [open] is not a modal');
});

test('an open lightbox keeps focus', async () => {
  const { doc, byId, textarea, promptFocus, addLightbox } = await setup();
  byId('other-button').focus();
  addLightbox();
  promptFocus.afterSelect({ userGesture: true });
  assert.ok(doc.activeElement !== textarea, 'an [aria-modal] element without hidden blocks the focus');
});

test('a closed lightbox does not block focus', async () => {
  const { doc, textarea, promptFocus, addLightbox } = await setup();
  addLightbox({ hidden: true });
  promptFocus.afterSelect({ userGesture: true });
  assert.ok(doc.activeElement === textarea, 'the same element carrying hidden is not a modal');
});

test('typing in another text input keeps focus', async () => {
  const { doc, byId, textarea, promptFocus } = await setup();
  const input = byId('other-input');
  input.focus();
  promptFocus.afterSelect({ userGesture: true });
  assert.ok(doc.activeElement === input, 'focus stayed in the text input');
  assert.ok(doc.activeElement !== textarea);
});

test('typing in a contenteditable element keeps focus', async () => {
  const { doc, byId, promptFocus } = await setup();
  const editable = byId('other-editable');
  editable.focus();
  assert.ok(doc.activeElement === editable, 'precondition: the contenteditable took focus');
  promptFocus.afterSelect({ userGesture: true });
  assert.ok(doc.activeElement === editable, 'focus stayed in the contenteditable');
});

test('a focused button does not block focus', async () => {
  const { doc, byId, textarea, promptFocus } = await setup();
  byId('other-button').focus();
  promptFocus.afterSelect({ userGesture: true });
  assert.ok(doc.activeElement === textarea, 'a button is not text entry');
});

test('a touch-primary device does not focus', async () => {
  const { doc, textarea, promptFocus } = await setup({ touch: true });
  promptFocus.afterSelect({ userGesture: true });
  assert.ok(doc.activeElement !== textarea, 'no focus (and no on-screen keyboard) on touch');
});
