// Shared DOM harness for the tests that drive the real attachComposer wired to
// the real createDraftStore / installComposerDrafts (public/drafts.js) in
// happy-dom. Not a `.test.mjs` file, so tests/run.mjs's readdir discovery skips
// it (same precedent as tests/spawnDialogHarness.mjs).

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
export const { createDraftStore, installComposerDrafts, DRAFT_KEY_PREFIX, DRAFT_MAX_AGE_MS } =
  await import(pathToFileURL(path.join(PUB, 'drafts.js')).href);

export const keyOf = (sid) => DRAFT_KEY_PREFIX + sid;
export const NOW = 1_700_000_000_000;

// Map-backed Storage with length/key(i). `throwOn` forces the quota /
// private-mode path for one method.
export function fakeStorage(seed = {}, { throwOn = null } = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { if (throwOn === 'setItem') throw new Error('quota'); map.set(k, String(v)); },
    removeItem: (k) => { if (throwOn === 'removeItem') throw new Error('denied'); map.delete(k); },
  };
}

export function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout: (fn) => { const id = next++; pending.set(id, fn); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    get count() { return pending.size; },
    fireAll() { const fns = [...pending.values()]; pending.clear(); for (const fn of fns) fn(); },
  };
}

// Replaces URL.createObjectURL / revokeObjectURL with a `blob:fake/N` counter
// and a `revoked` log, restored when `t` finishes.
export function stubObjectUrls(t) {
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  const revoked = [];
  let n = 0;
  URL.createObjectURL = () => `blob:fake/${++n}`;
  URL.revokeObjectURL = (u) => { revoked.push(u); };
  t.after(() => {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  });
  return { revoked };
}

// A File stand-in: the composer reads name / type / size and arrayBuffer().
// `gate` (a promise) holds the read open until the test releases it.
export function fakeFile({ name = 'f.png', type = 'image/png', size, bytes = [1, 2, 3], gate = null } = {}) {
  const u8 = Uint8Array.from(bytes);
  return {
    name,
    type,
    size: size ?? u8.length,
    async arrayBuffer() { if (gate) await gate; return u8.buffer; },
  };
}

export function gate() {
  let open;
  const promise = new Promise((r) => { open = r; });
  return { promise, open };
}

export const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

// A fresh page: new DOM + composer + drafts wiring over the given store.
// `wire: false` builds the composer WITHOUT onDraftChange / claimTranscriptTarget
// or the drafts module.
// `dictation: true` stubs the mic, recorder and /api/transcribe (returns
// `transcript`), and records alert() calls in `alerts`. `dictation: 'deferred'`
// holds the /api/transcribe response until `releaseTranscript(text)`.
// `t` (a test context) stubs URL.createObjectURL and exposes `revoked`.
export async function setupPage({ store, timers = fakeTimers(), wire = true, dictation = false, transcript = 'dictated words', t = null }) {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.Blob = window.Blob;
  const document = window.document;
  const alerts = [];
  const errors = [];
  const revoked = t ? stubObjectUrls(t).revoked : [];
  window.addEventListener('error', (e) => errors.push(e.message ?? String(e.error)));
  let releaseFetch = null;
  const transcriptResponse = (text) => ({ ok: true, async text() { return ''; }, async json() { return { text }; } });
  if (dictation) {
    globalThis.alert = (m) => alerts.push(m);
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
    });
    globalThis.MediaRecorder = class {
      constructor() { this.listeners = {}; this.mimeType = 'audio/webm'; }
      addEventListener(type, fn) { this.listeners[type] = fn; }
      start() {}
      stop() { this.listeners.stop?.(); }
    };
    globalThis.fetch = dictation === 'deferred'
      ? () => new Promise((resolve) => { releaseFetch = (text) => resolve(transcriptResponse(text)); })
      : async () => transcriptResponse(transcript);
  }

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
  const chipsContainer = document.getElementById('composer-attachments');
  form.requestSubmit = () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  const url = pathToFileURL(path.join(PUB, 'composer.js')).href + `?t=${Math.floor(performance.now() * 1000)}-${Math.random()}`;
  const { attachComposer } = await import(url);
  const submits = [];
  let drafts = null;
  const composer = attachComposer({
    form,
    textarea,
    sendBtn,
    attachBtn: document.getElementById('composer-attach'),
    fileInput: document.getElementById('composer-file'),
    chipsContainer,
    onSubmit: (p) => submits.push(p),
    ...(wire ? {
      onDraftChange: (d) => drafts.noteChange(d),
      claimTranscriptTarget: () => drafts.claimTranscriptTarget(),
    } : {}),
  });
  composer.set({ canType: true, canSend: true });

  // A plain EventTarget doc so a test controls `hidden`.
  const doc = Object.assign(new EventTarget(), { hidden: false });
  if (wire) drafts = installComposerDrafts({ composer, store, timers, win: window, doc });

  const type = (v) => { textarea.value = v; textarea.dispatchEvent(new window.Event('input', { bubbles: true })); };
  const submit = () => form.requestSubmit();
  const tap = async () => {
    sendBtn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await settle();
  };
  const paste = async (files) => {
    const ev = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: { files } });
    textarea.dispatchEvent(ev);
    await settle();
  };
  const chips = () => Array.from(chipsContainer.children).map((c) => ({
    meta: c.querySelector('.cac-meta')?.textContent ?? null,
    src: c.querySelector('img')?.getAttribute('src') ?? null,
    error: c.classList.contains('has-error'),
  }));
  const removeChip = (i) => {
    chipsContainer.children[i].querySelector('.cac-remove')
      .dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  };
  const releaseTranscript = async (text) => {
    if (!releaseFetch) throw new Error('no /api/transcribe request is waiting');
    releaseFetch(text);
    releaseFetch = null;
    await settle();
  };
  return {
    window, doc, textarea, sendBtn, composer, drafts, timers, submits, type, submit, tap, alerts, errors,
    paste, chips, removeChip, releaseTranscript, revoked,
    get chipsHidden() { return chipsContainer.hidden; },
  };
}

export const newStore = (storage, now = () => NOW) => createDraftStore({ storage, now });
export const stored = (storage, sid) => (storage.map.has(keyOf(sid)) ? JSON.parse(storage.map.get(keyOf(sid))) : null);
