import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { mdToSpeech } = await import(pathToFileURL(path.resolve(__dirname, '..', 'public', 'md-to-speech.js')).href);

// ── Fenced code blocks ────────────────────────────────────────────────────────

test('fenced code block replaced with "(code block)"', () => {
  const input = 'Here is a snippet:\n```js\nconst x = 1;\n```\nDone.';
  const result = mdToSpeech(input);
  assert.ok(!result.includes('const x'), 'code content must not appear');
  assert.ok(result.includes('(code block)'), 'placeholder must appear');
  assert.ok(result.includes('Here is a snippet'), 'surrounding text preserved');
  assert.ok(result.includes('Done'), 'surrounding text preserved');
});

test('fenced code block with no language tag', () => {
  const result = mdToSpeech('Text\n```\ncode\n```\nMore');
  assert.ok(!result.includes('code\n'), 'code content removed');
  assert.ok(result.includes('(code block)'), 'placeholder present');
});

test('message that is only a code block normalizes to "(code block)"', () => {
  const result = mdToSpeech('```\nrm -rf /\n```');
  assert.equal(result, '(code block)');
});

// ── Indented code blocks ──────────────────────────────────────────────────────

test('indented code block (4 spaces) replaced with placeholder', () => {
  const result = mdToSpeech('Intro:\n\n    some_code()\n\nEnd.');
  assert.ok(!result.includes('some_code'), 'indented code content removed');
  assert.ok(result.includes('(code block)'));
});

test('indented code block (tab) replaced with placeholder', () => {
  const result = mdToSpeech('Intro:\n\n\tsome_code()\n\nEnd.');
  assert.ok(!result.includes('some_code'));
  assert.ok(result.includes('(code block)'));
});

// ── Inline code ───────────────────────────────────────────────────────────────

test('inline code: backticks stripped, content kept', () => {
  assert.equal(mdToSpeech('Run `npm install` first.'), 'Run npm install first.');
});

test('inline code: multiple occurrences', () => {
  const result = mdToSpeech('Use `foo()` and `bar()` together.');
  assert.equal(result, 'Use foo() and bar() together.');
});

// ── Headings ──────────────────────────────────────────────────────────────────

test('h1 heading: # stripped', () => {
  assert.equal(mdToSpeech('# Hello World'), 'Hello World');
});

test('h2 heading: ## stripped', () => {
  assert.equal(mdToSpeech('## Section Title'), 'Section Title');
});

test('h3–h6 headings stripped', () => {
  assert.equal(mdToSpeech('### Sub'), 'Sub');
  assert.equal(mdToSpeech('###### Deep'), 'Deep');
});

// ── Bold / strong ─────────────────────────────────────────────────────────────

test('bold with **', () => {
  assert.equal(mdToSpeech('This is **important** text.'), 'This is important text.');
});

test('bold with __', () => {
  assert.equal(mdToSpeech('This is __important__ text.'), 'This is important text.');
});

// ── Italic / emphasis ─────────────────────────────────────────────────────────

test('italic with *', () => {
  assert.equal(mdToSpeech('This is *emphasized* text.'), 'This is emphasized text.');
});

test('italic with _: standalone word', () => {
  assert.equal(mdToSpeech('This is _emphasized_ text.'), 'This is emphasized text.');
});

test('italic with _: does not mangle snake_case variable names', () => {
  const result = mdToSpeech('Use the `snake_case_var` pattern.');
  // Backticks stripped (inline code rule), underscores in name untouched
  assert.equal(result, 'Use the snake_case_var pattern.');
});

// ── Strikethrough ─────────────────────────────────────────────────────────────

test('strikethrough: markers dropped, content kept', () => {
  assert.equal(mdToSpeech('This is ~~wrong~~ right.'), 'This is wrong right.');
});

// ── Images ────────────────────────────────────────────────────────────────────

test('image with alt text: alt text spoken', () => {
  assert.equal(mdToSpeech('See ![a diagram](img.png) here.'), 'See a diagram here.');
});

test('image with empty alt text: dropped entirely', () => {
  const result = mdToSpeech('See ![](img.png) for details.');
  assert.ok(!result.includes('img.png'), 'URL must not appear');
});

// ── Links ─────────────────────────────────────────────────────────────────────

test('link: only the link text is spoken', () => {
  assert.equal(
    mdToSpeech('Visit [Google](https://google.com) today.'),
    'Visit Google today.',
  );
});

test('link: URL not spoken even when long', () => {
  const result = mdToSpeech('[docs](https://very-long-domain.example.com/path?q=1)');
  assert.equal(result, 'docs');
  assert.ok(!result.includes('http'));
});

// ── Lists ─────────────────────────────────────────────────────────────────────

test('unordered list: bullet markers stripped', () => {
  const input = '- First item\n- Second item\n- Third item';
  const result = mdToSpeech(input);
  assert.ok(result.includes('First item'));
  assert.ok(result.includes('Second item'));
  assert.ok(!result.includes('- '));
});

test('unordered list: * and + bullets also stripped', () => {
  assert.ok(!mdToSpeech('* item').includes('* '));
  assert.ok(!mdToSpeech('+ item').includes('+ '));
});

test('ordered list: numbers stripped', () => {
  const input = '1. First\n2. Second\n3. Third';
  const result = mdToSpeech(input);
  assert.ok(result.includes('First'));
  assert.ok(!result.includes('1.'));
  assert.ok(!result.includes('2.'));
});

// ── Blockquotes ───────────────────────────────────────────────────────────────

test('blockquote: > stripped', () => {
  assert.equal(mdToSpeech('> This is a quote.'), 'This is a quote.');
});

test('nested blockquote: >> stripped', () => {
  assert.equal(mdToSpeech('>> Nested quote.'), 'Nested quote.');
});

// ── Horizontal rules ──────────────────────────────────────────────────────────

test('horizontal rule --- removed', () => {
  const result = mdToSpeech('Before\n\n---\n\nAfter');
  assert.ok(!result.includes('---'));
  assert.ok(result.includes('Before'));
  assert.ok(result.includes('After'));
});

test('horizontal rule *** and ___ also removed', () => {
  assert.ok(!mdToSpeech('***').includes('***'));
  assert.ok(!mdToSpeech('___').includes('___'));
});

// ── Tables ────────────────────────────────────────────────────────────────────

test('table: cell content preserved, pipes removed', () => {
  const input = '| Name | Value |\n|------|-------|\n| foo  | 42    |';
  const result = mdToSpeech(input);
  assert.ok(result.includes('Name'), 'header cell present');
  assert.ok(result.includes('foo'), 'data cell present');
  assert.ok(result.includes('42'), 'data cell present');
  assert.ok(!result.includes('|'), 'pipe characters removed');
  assert.ok(!result.includes('------'), 'separator row removed');
});

// ── HTML tags ─────────────────────────────────────────────────────────────────

test('HTML tags stripped, text content kept', () => {
  assert.equal(mdToSpeech('<b>bold</b> text'), 'bold text');
  assert.equal(mdToSpeech('<br/>'), '');
});

// ── Edge cases ────────────────────────────────────────────────────────────────

test('plain text unchanged', () => {
  assert.equal(mdToSpeech('Hello, world!'), 'Hello, world!');
});

test('empty string returns empty string', () => {
  assert.equal(mdToSpeech(''), '');
});

test('non-string input returns empty string', () => {
  assert.equal(mdToSpeech(null), '');
  assert.equal(mdToSpeech(undefined), '');
});

test('plain emoji preserved', () => {
  assert.equal(mdToSpeech('Great job 🎉'), 'Great job 🎉');
});

test('multiple blank lines collapsed to two', () => {
  const result = mdToSpeech('A\n\n\n\n\nB');
  assert.ok(!result.includes('\n\n\n'), 'no 3+ consecutive newlines');
  assert.ok(result.includes('A'));
  assert.ok(result.includes('B'));
});

// ── Nested constructs ─────────────────────────────────────────────────────────

test('bold inside list item', () => {
  const result = mdToSpeech('- **Important** step');
  assert.ok(result.includes('Important'));
  assert.ok(!result.includes('**'));
  assert.ok(!result.includes('- '));
});

test('link inside bold', () => {
  const result = mdToSpeech('**See [docs](https://example.com) for details**');
  assert.ok(result.includes('docs'));
  assert.ok(!result.includes('**'));
  assert.ok(!result.includes('http'));
});

// ── Mixed real-world assistant output ─────────────────────────────────────────

test('mixed assistant reply normalizes correctly', () => {
  const input = [
    '## Summary',
    '',
    'The function **`run()`** does three things:',
    '',
    '1. Loads the config',
    '2. Calls `process()` with the *active* dataset',
    '3. Returns the result',
    '',
    'See [the docs](https://example.com) for more.',
  ].join('\n');

  const result = mdToSpeech(input);

  assert.ok(result.includes('Summary'), 'heading text kept');
  assert.ok(!result.includes('## '), 'heading marker gone');
  assert.ok(result.includes('run()'), 'inline code content kept');
  assert.ok(!result.includes('**'), 'bold markers gone');
  assert.ok(!result.includes('`'), 'backtick markers gone');
  assert.ok(result.includes('Loads the config'), 'list item text kept');
  assert.ok(!result.includes('1.'), 'ordered list marker gone');
  assert.ok(result.includes('active'), 'italic content kept');
  assert.ok(!result.includes('*active*'), 'italic markers gone');
  assert.ok(result.includes('the docs'), 'link text kept');
  assert.ok(!result.includes('https://'), 'URL gone');
});
