import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Import the pure function from blocks.js without booting a real DOM.
// describeToolInput doesn't touch DOM at module-import time, so a plain
// dynamic import works.
const { describeToolInput } = await import(pathToFileURL(path.resolve(__dirname, '..', 'public', 'blocks.js')).href);

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

test('describeToolInput: empty input → empty string', () => {
  assert.equal(describeToolInput('Bash', {}), '');
  assert.equal(describeToolInput('Bash', null), '');
});
