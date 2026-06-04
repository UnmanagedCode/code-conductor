import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Stub Web Audio + fetch BEFORE importing tts.js (which blocks.js pulls in).
// The stub AudioContext is created once and cached by tts.js's ensureCtx().
globalThis.AudioContext = class MockAudioContext {
  constructor() { this.currentTime = 0; this.destination = {}; }
  resume() { return Promise.resolve(); }
  createBufferSource() { return { connect() {}, start() {}, onended: null, buffer: null }; }
  decodeAudioData() { return Promise.resolve({ duration: 0.5 }); }
};
globalThis.fetch = async () => ({
  ok: true,
  body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
});

// Import blocks.js (which also imports tts.js as a side-effect) and tts.js
// directly so tests can drive speaking state.
const { describeToolInput, ToolResultBlock, TextBlock } = await import(pathToFileURL(path.resolve(__dirname, '..', 'public', 'blocks.js')).href);
const { setTtsAvailable, getCurrentSpeakToken, stop: ttsStop } = await import(pathToFileURL(path.resolve(__dirname, '..', 'public', 'tts.js')).href);

function setupDOM() {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
}

// Drain all pending microtasks so speak()'s async chain can complete.
function flushMicrotasks() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// setupDOM + expose AudioContext on the happy-dom window so tts.js's
// ensureCtx() (which reads window.AudioContext) finds the mock.
function setupDOMWithAudio() {
  setupDOM();
  globalThis.window.AudioContext = globalThis.AudioContext;
}

// Build a finalized TextBlock and return it + the button element.
function makeSpeakingBlock(text = 'Hello world') {
  const block = new TextBlock();
  block.appendDelta(text);
  block.finalize();
  return { block, btn: block.body.querySelector('.tts-speak') };
}

test('describeToolInput: Bash → command', () => {
  assert.equal(describeToolInput('Bash', { command: 'ls -la' }), 'ls -la');
});

test('describeToolInput: Edit/Write/Read → file_path', () => {
  assert.equal(describeToolInput('Edit',  { file_path: '/x/y.js' }), '/x/y.js');
  assert.equal(describeToolInput('Write', { file_path: '/x/y.js' }), '/x/y.js');
  assert.equal(describeToolInput('Read',  { file_path: '/x/y.js' }), '/x/y.js');
});

test('describeToolInput: Read with offset shows pagination', () => {
  const s = describeToolInput('Read', { file_path: '/a', offset: 100, limit: 50 });
  assert.match(s, /\/a/);
  assert.match(s, /offset=100/);
  assert.match(s, /limit=50/);
});

test('describeToolInput: Glob/Grep show pattern + path', () => {
  assert.match(describeToolInput('Glob', { pattern: '**/*.ts', path: 'src' }), /\*\*\/\*\.ts.*src/);
  assert.match(describeToolInput('Grep', { pattern: 'foo', path: 'tests' }), /foo.*tests/);
});

test('describeToolInput: WebFetch/WebSearch', () => {
  assert.equal(describeToolInput('WebFetch', { url: 'https://example.com' }), 'https://example.com');
  assert.equal(describeToolInput('WebSearch', { query: 'claude code' }), 'claude code');
});

test('describeToolInput: Task includes subagent_type', () => {
  const s = describeToolInput('Task', { subagent_type: 'Explore', description: 'find files' });
  assert.match(s, /\[Explore\]/);
  assert.match(s, /find files/);
});

test('describeToolInput: collapses whitespace and truncates long values', () => {
  const long = 'a'.repeat(300);
  const s = describeToolInput('Bash', { command: `echo\n\n   ${long}` });
  assert.ok(s.length <= 121, `expected ≤121 chars, got ${s.length}`);
  assert.ok(s.endsWith('…'));
});

test('describeToolInput: unknown tool → first stringy field as key=value', () => {
  const s = describeToolInput('CustomThing', { mode: 'auto', count: 5 });
  assert.equal(s, 'mode=auto');
});

test('describeToolInput: TaskCreate shows subject + description', () => {
  const s = describeToolInput('TaskCreate', {
    subject: 'Refactor X',
    description: 'Pull out the hook plumbing into its own module',
  });
  assert.match(s, /Refactor X/);
  assert.match(s, /hook plumbing/);
});

test('describeToolInput: TaskUpdate resolves subject + description via ctx, shows status', () => {
  const ctx = {
    resolveTaskSubject: (id) => id === '4' ? 'Refactor X' : null,
    resolveTaskDescription: (id) => id === '4' ? 'Pull out the hook plumbing' : null,
  };
  const s = describeToolInput('TaskUpdate', { taskId: '4', status: 'completed' }, ctx);
  assert.match(s, /#4/);
  assert.match(s, /Refactor X/);
  assert.match(s, /hook plumbing/);
  assert.match(s, /→ completed/);
});

test('describeToolInput: TaskUpdate without resolver falls back to taskId + status', () => {
  const s = describeToolInput('TaskUpdate', { taskId: '7', status: 'in_progress' });
  assert.match(s, /#7/);
  assert.match(s, /→ in_progress/);
});

test('describeToolInput: TaskUpdate prefers its own subject over the resolver', () => {
  // If the model passes subject in the TaskUpdate input itself, that
  // wins over whatever the tracker currently knows — the model is
  // expressing intent to rename right now.
  const s = describeToolInput('TaskUpdate',
    { taskId: '4', subject: 'New name', status: 'completed' },
    { resolveTaskSubject: () => 'Old name' },
  );
  assert.match(s, /New name/);
  assert.equal(s.includes('Old name'), false);
});

test('describeToolInput: empty input → empty string', () => {
  assert.equal(describeToolInput('Bash', {}), '');
  assert.equal(describeToolInput('Bash', null), '');
});

test('ToolResultBlock: renders a base64 image content block as <img>', () => {
  setupDOM();
  const block = new ToolResultBlock({
    toolUseId: 'tu_read',
    isError: false,
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ],
  });
  const img = block.node.querySelector('img.tool-result-img');
  assert.ok(img, 'expected an <img.tool-result-img>');
  assert.equal(img.getAttribute('src'), 'data:image/png;base64,AAAA');
  assert.equal(img.getAttribute('loading'), 'lazy');
  // No anchor wrap — the lightbox handles tap-to-zoom in-page, since
  // Chrome on Android blocks top-level data:-URL navigation.
  assert.equal(block.node.querySelector('a'), null);
  // Summary advertises the image count.
  assert.match(block.node.querySelector('summary').textContent, /1 image/);
  // Auto-open so the user sees the picture without clicking.
  assert.equal(block.node.hasAttribute('open'), true);
  // No empty <pre> when there's no text — it would render as a dark strip
  // above the image.
  assert.equal(block.node.querySelector('pre'), null);
});

test('ToolResultBlock: renders multiple images and mixed text', () => {
  setupDOM();
  const block = new ToolResultBlock({
    toolUseId: 'tu_read',
    isError: false,
    content: [
      { type: 'text', text: 'Here is the screenshot:' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png',  data: 'BBBB' } },
    ],
  });
  const imgs = block.node.querySelectorAll('img.tool-result-img');
  assert.equal(imgs.length, 2);
  assert.equal(imgs[0].getAttribute('src'), 'data:image/jpeg;base64,AAAA');
  assert.equal(imgs[1].getAttribute('src'), 'data:image/png;base64,BBBB');
  assert.match(block.node.querySelector('summary').textContent, /2 images/);
  assert.match(block.node.querySelector('pre').textContent, /Here is the screenshot:/);
});

test('ToolResultBlock: refuses image/svg+xml to block script-bearing SVGs', () => {
  setupDOM();
  const block = new ToolResultBlock({
    toolUseId: 'tu_read',
    isError: false,
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'PHN2Zy8+' } },
    ],
  });
  assert.equal(block.node.querySelector('img'), null);
});

test('ToolResultBlock: url-source image with http(s)/file:// passes through', () => {
  setupDOM();
  const block = new ToolResultBlock({
    toolUseId: 'tu_read',
    isError: false,
    content: [
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
      { type: 'image', source: { type: 'url', url: 'file:///data/data/com.termux/files/home/foo.png' } },
      { type: 'image', source: { type: 'url', url: 'javascript:alert(1)' } },
    ],
  });
  const imgs = block.node.querySelectorAll('img.tool-result-img');
  assert.equal(imgs.length, 2);
  assert.equal(imgs[0].getAttribute('src'), 'https://example.com/a.png');
  assert.equal(imgs[1].getAttribute('src'), 'file:///data/data/com.termux/files/home/foo.png');
});

test('ToolResultBlock: plain string content still renders as text in <pre>', () => {
  setupDOM();
  const block = new ToolResultBlock({
    toolUseId: 'tu_bash',
    isError: false,
    content: 'total 22\nfile1\nfile2\n',
  });
  assert.equal(block.node.querySelectorAll('img').length, 0);
  assert.match(block.node.querySelector('pre').textContent, /file1/);
});

test('ToolResultBlock: renders tool_reference content blocks (ToolSearch result)', () => {
  setupDOM();
  // ToolSearch returns its result as tool_reference content blocks, not text —
  // the old image/text-only loop dropped them, leaving a blank tool_result.
  const block = new ToolResultBlock({
    toolUseId: 'tu_toolsearch',
    isError: false,
    content: [
      { type: 'tool_reference', tool_name: 'WebFetch' },
      { type: 'tool_reference', tool_name: 'WebSearch' },
    ],
  });
  const pre = block.node.querySelector('pre');
  assert.ok(pre, 'tool_reference result must render a <pre>, not a blank box');
  assert.match(pre.textContent, /WebFetch/);
  assert.match(pre.textContent, /WebSearch/);
  assert.match(pre.textContent, /2 tool schemas/);
});

test('describeToolInput: ToolSearch shows the query', () => {
  assert.equal(
    describeToolInput('ToolSearch', { query: 'select:WebFetch', max_results: 3 }),
    'select:WebFetch',
  );
});

// ── TTS play/stop toggle ──────────────────────────────────────────────────────

test('TTS button: not created when TTS unavailable', () => {
  setupDOM();
  setTtsAvailable(false);
  const { btn } = makeSpeakingBlock();
  assert.equal(btn, null, 'button should not exist when TTS is unavailable');
});

test('TTS button: created in idle state when TTS available', () => {
  setupDOMWithAudio();
  ttsStop(); // ensure clean state
  setTtsAvailable(true);
  const { btn } = makeSpeakingBlock();
  assert.ok(btn, 'button should exist when TTS is available');
  assert.equal(btn.textContent, '🔊');
  assert.equal(btn.title, 'Read aloud');
  assert.equal(btn.classList.contains('speaking'), false);
});

test('TTS button: click starts speaking — gets ⏹ glyph, speaking class, Stop title', () => {
  setupDOMWithAudio();
  ttsStop();
  setTtsAvailable(true);
  const { btn } = makeSpeakingBlock();

  btn.click();
  // speak() fires onSpeakingChange synchronously (before first await), so
  // _activeBtn is updated before this assertion runs.
  assert.equal(btn.textContent, '⏹');
  assert.equal(btn.title, 'Stop');
  assert.equal(btn.classList.contains('speaking'), true);
  assert.notEqual(getCurrentSpeakToken(), null);

  ttsStop(); // clean up for next test
});

test('TTS button: click while playing (toggle-off) stops and reverts to 🔊', () => {
  setupDOMWithAudio();
  ttsStop();
  setTtsAvailable(true);
  const { btn } = makeSpeakingBlock();

  btn.click(); // start
  assert.equal(btn.classList.contains('speaking'), true);

  btn.click(); // stop (toggle-off path)
  assert.equal(btn.textContent, '🔊');
  assert.equal(btn.title, 'Read aloud');
  assert.equal(btn.classList.contains('speaking'), false);
  assert.equal(getCurrentSpeakToken(), null);
});

test('TTS button: clicking a different button stops the first and activates the second', () => {
  setupDOMWithAudio();
  ttsStop();
  setTtsAvailable(true);
  const { btn: btnA } = makeSpeakingBlock('Message A');
  const { btn: btnB } = makeSpeakingBlock('Message B');

  btnA.click(); // start A
  assert.equal(btnA.classList.contains('speaking'), true);
  assert.equal(btnB.classList.contains('speaking'), false);

  btnB.click(); // switch to B
  assert.equal(btnA.classList.contains('speaking'), false, 'A should revert');
  assert.equal(btnA.textContent, '🔊');
  assert.equal(btnB.classList.contains('speaking'), true, 'B should be speaking');
  assert.equal(btnB.textContent, '⏹');
  assert.notEqual(getCurrentSpeakToken(), null);

  ttsStop(); // clean up
});

test('TTS button: natural end (empty stream, no sources) reverts button automatically', async () => {
  setupDOMWithAudio();
  ttsStop();
  setTtsAvailable(true);
  const { btn } = makeSpeakingBlock();

  btn.click(); // starts speak(); fetch stub returns empty body immediately
  assert.equal(btn.classList.contains('speaking'), true);

  // Let speak()'s async chain run to completion:
  // ctx.resume() → fetch() → reader.read() (done=true) → _naturalEnd fires.
  await flushMicrotasks();

  assert.equal(btn.classList.contains('speaking'), false, 'button should revert after natural end');
  assert.equal(btn.textContent, '🔊');
  assert.equal(btn.title, 'Read aloud');
  assert.equal(getCurrentSpeakToken(), null);
});
