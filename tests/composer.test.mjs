// DOM-level tests for the merged Send/mic composer button.
//
// The Send button is content-driven (WhatsApp-style): an empty composer with
// an active session shows a mic affordance; any text/attachment makes it a
// Send button. Recording uses tap-toggle (first tap starts, second tap stops
// and transcribes) and inserts the transcript at the caret for review.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

// Fresh DOM + composer per test. `transcribeText` is what the stubbed
// /api/transcribe endpoint returns. Returns handles + a `calls` recorder.
async function setupComposer({ transcribeText = 'hello world', getUserMediaThrows = false } = {}) {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.Blob = window.Blob;
  globalThis.alert = () => {};

  const calls = { onSubmit: [], getUserMedia: 0, fetch: [], trackStops: 0, recorderStops: 0 };

  // Stub microphone + recorder + transcribe endpoint. `navigator` is a
  // getter-only global in Node, so define it rather than assign.
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          calls.getUserMedia++;
          if (getUserMediaThrows) throw new Error('denied');
          return { getTracks: () => [{ stop() { calls.trackStops++; } }] };
        },
      },
    },
  });
  globalThis.MediaRecorder = class {
    constructor() { this.listeners = {}; this.mimeType = 'audio/webm'; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    start() {}
    stop() { calls.recorderStops++; this.listeners.stop?.(); }
  };
  globalThis.fetch = async (url, opts) => {
    calls.fetch.push({ url, opts });
    return { ok: true, async text() { return ''; }, async json() { return { text: transcribeText }; } };
  };

  document.body.innerHTML = `
    <form id="composer">
      <div id="composer-attachments" hidden></div>
      <div class="composer-row">
        <textarea id="composer-input"></textarea>
        <input id="composer-file" type="file" hidden />
        <button id="composer-attach" type="button"></button>
        <button id="composer-send" type="button" disabled>
          <span class="cs-label">Send</span>
          <svg class="cs-mic"></svg>
        </button>
      </div>
    </form>`;

  const form = document.getElementById('composer');
  const textarea = document.getElementById('composer-input');
  const sendBtn = document.getElementById('composer-send');
  // happy-dom lacks requestSubmit(); polyfill it to fire a real submit event
  // so the click→requestSubmit→submit-handler chain is exercised end-to-end.
  form.requestSubmit = () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  // Cache-bust the ES module so each test gets fresh closure state.
  const url = pathToFileURL(path.join(PUB, 'composer.js')).href + `?t=${calls.fetch.length}-${Math.floor(performance.now() * 1000)}`;
  const { attachComposer } = await import(url);
  const composer = attachComposer({
    form,
    textarea,
    sendBtn,
    attachBtn: document.getElementById('composer-attach'),
    fileInput: document.getElementById('composer-file'),
    chipsContainer: document.getElementById('composer-attachments'),
    onSubmit: (payload) => calls.onSubmit.push(payload),
  });

  const fire = (target, type) => target.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  const typeInto = (v) => { textarea.value = v; fire(textarea, 'input'); };
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

  return { window, document, form, textarea, sendBtn, composer, calls, fire, typeInto, flush };
}

test('empty composer with whisper available → mic mode, enabled', async () => {
  const { sendBtn, composer } = await setupComposer();
  composer.set({ canType: true, canSend: true });
  composer.setMicAvailable(true);
  assert.ok(sendBtn.classList.contains('mode-mic'), 'should be mic mode');
  assert.equal(sendBtn.disabled, false, 'mic button enabled when whisper available');
});

test('empty composer with whisper unavailable → mic mode, disabled (mic affordance shown but not tappable)', async () => {
  const { sendBtn, composer } = await setupComposer();
  composer.set({ canType: true, canSend: true });
  // setMicAvailable not called → micAvailable stays false.
  assert.ok(sendBtn.classList.contains('mode-mic'), 'mic affordance still shown');
  assert.equal(sendBtn.disabled, true, 'disabled until whisper is installed');
});

test('typing flips mic → send mode; clearing flips back', async () => {
  const { sendBtn, composer, typeInto } = await setupComposer();
  composer.set({ canType: true, canSend: true });
  composer.setMicAvailable(true);

  typeInto('hi there');
  assert.ok(sendBtn.classList.contains('mode-send'), 'text → send mode');
  assert.ok(!sendBtn.classList.contains('mode-mic'));
  assert.equal(sendBtn.disabled, false, 'send enabled with content');

  typeInto('');
  assert.ok(sendBtn.classList.contains('mode-mic'), 'cleared → back to mic mode');
});

test('tap-toggle: first click starts recording, second click transcribes and inserts text', async () => {
  const { sendBtn, textarea, composer, calls, fire, flush } = await setupComposer({ transcribeText: 'hello world' });
  composer.set({ canType: true, canSend: true });
  composer.setMicAvailable(true);

  // First tap → start recording
  fire(sendBtn, 'click');
  await flush();
  assert.equal(calls.getUserMedia, 1, 'requested the mic');
  assert.ok(sendBtn.classList.contains('recording'), 'recording visual on');

  // Second tap → stop recording → transcribe
  fire(sendBtn, 'click');
  await flush();
  assert.equal(calls.recorderStops, 1, 'recorder stopped on second tap');
  assert.equal(calls.fetch.length, 1, 'posted audio once');
  assert.equal(calls.fetch[0].url, '/api/transcribe');
  assert.equal(textarea.value, 'hello world', 'transcript inserted into composer');
  assert.ok(sendBtn.classList.contains('mode-send'), 'now has content → send mode');
  assert.ok(!sendBtn.classList.contains('recording') && !sendBtn.classList.contains('transcribing'));
});

test('send mode: click submits the typed message and clears the composer', async () => {
  const { sendBtn, textarea, composer, calls, typeInto, fire } = await setupComposer();
  composer.set({ canType: true, canSend: true });
  composer.setMicAvailable(true);

  typeInto('ship it');
  fire(sendBtn, 'click');
  assert.equal(calls.onSubmit.length, 1, 'submitted once');
  assert.equal(calls.onSubmit[0].text, 'ship it');
  assert.equal(textarea.value, '', 'composer cleared after send');
});

test('click in send mode does not record', async () => {
  const { sendBtn, composer, calls, typeInto, fire, flush } = await setupComposer();
  composer.set({ canType: true, canSend: true });
  composer.setMicAvailable(true);

  typeInto('already typed');
  fire(sendBtn, 'click');
  await flush();
  assert.equal(calls.getUserMedia, 0, 'no recording started in send mode');
  assert.ok(!sendBtn.classList.contains('recording'));
});
