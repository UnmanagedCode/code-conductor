import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Import the pure function from blocks.js without booting a real DOM.
// describeToolInput doesn't touch DOM at module-import time, so a plain
// dynamic import works.
const { describeToolInput, ToolResultBlock } = await import(pathToFileURL(path.resolve(__dirname, '..', 'public', 'blocks.js')).href);

function setupDOM() {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
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
  // Wrapped in an anchor so it can be opened full-size.
  const a = block.node.querySelector('a');
  assert.ok(a);
  assert.equal(a.getAttribute('href'), 'data:image/png;base64,AAAA');
  // Summary advertises the image count.
  assert.match(block.node.querySelector('summary').textContent, /1 image/);
  // Auto-open so the user sees the picture without clicking.
  assert.equal(block.node.hasAttribute('open'), true);
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
