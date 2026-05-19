import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function setupDOM() {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  return { window, document: window.document };
}

async function loadMarkdown() {
  return import(pathToFileURL(path.resolve(__dirname, '..', 'public', 'markdown.js')).href);
}

function render(md, text) {
  const root = document.createElement('div');
  md.renderMarkdownInto(root, text);
  return root;
}

test('markdown: headings parse to h1..h6 with the right text', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, '# Title\n## Sub\n### Detail');
  const hs = root.querySelectorAll('h1, h2, h3');
  assert.equal(hs.length, 3);
  assert.equal(hs[0].tagName, 'H1');
  assert.equal(hs[0].textContent, 'Title');
  assert.equal(hs[1].tagName, 'H2');
  assert.equal(hs[2].tagName, 'H3');
});

test('markdown: paragraphs separated by blank lines', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, 'First paragraph.\n\nSecond paragraph.');
  const ps = root.querySelectorAll('p');
  assert.equal(ps.length, 2);
  assert.match(ps[0].textContent, /First paragraph/);
  assert.match(ps[1].textContent, /Second paragraph/);
});

test('markdown: unordered list with mixed bullet chars', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, '- one\n* two\n+ three');
  const lis = root.querySelectorAll('ul li');
  assert.equal(lis.length, 3);
  assert.equal(lis[0].textContent, 'one');
  assert.equal(lis[2].textContent, 'three');
});

test('markdown: ordered list', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, '1. first\n2. second\n3. third');
  const lis = root.querySelectorAll('ol li');
  assert.equal(lis.length, 3);
  assert.equal(lis[1].textContent, 'second');
});

test('markdown: fenced code block preserves whitespace + language data attr', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const src = '```js\nconst x = 1;\nconst y = 2;\n```';
  const root = render(md, src);
  const pre = root.querySelector('pre');
  const code = pre.querySelector('code');
  assert.equal(code.dataset.lang, 'js');
  assert.equal(code.textContent, 'const x = 1;\nconst y = 2;');
});

test('markdown: inline bold / italic / code', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, 'Use **bold** and *italic* and `code` here.');
  const p = root.querySelector('p');
  assert.ok(p.querySelector('strong'));
  assert.equal(p.querySelector('strong').textContent, 'bold');
  assert.ok(p.querySelector('em'));
  assert.equal(p.querySelector('em').textContent, 'italic');
  assert.ok(p.querySelector('code'));
  assert.equal(p.querySelector('code').textContent, 'code');
});

test('markdown: safe links open in new tab with noopener', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, 'See [docs](https://example.com/x) for more.');
  const a = root.querySelector('a');
  assert.ok(a);
  assert.equal(a.getAttribute('href'), 'https://example.com/x');
  assert.equal(a.getAttribute('target'), '_blank');
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(a.textContent, 'docs');
});

test('markdown: unsafe link schemes render as literal text', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, 'click [here](javascript:alert(1)) please');
  assert.equal(root.querySelector('a'), null, 'no anchor for javascript: url');
  assert.match(root.textContent, /\[here\]\(javascript:alert\(1\)\)/);
});

test('markdown: never injects raw HTML', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, '<script>alert(1)</script>\n\n**bold**');
  // The literal angle brackets should be present as text, not as a real
  // <script> tag.
  assert.equal(root.querySelector('script'), null);
  assert.match(root.textContent, /<script>alert\(1\)<\/script>/);
  // Bold should still render after.
  assert.ok(root.querySelector('strong'));
});

test('markdown: blockquote', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, '> remember to verify\n> the migration');
  const bq = root.querySelector('blockquote');
  assert.ok(bq);
  assert.match(bq.textContent, /remember to verify/);
  assert.match(bq.textContent, /the migration/);
});

test('markdown: horizontal rule', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, 'before\n\n---\n\nafter');
  assert.ok(root.querySelector('hr'));
  const ps = root.querySelectorAll('p');
  assert.equal(ps.length, 2);
});

test('markdown: empty / whitespace input renders nothing', async () => {
  setupDOM();
  const md = await loadMarkdown();
  assert.equal(render(md, '').children.length, 0);
  assert.equal(render(md, '   \n\n  \n').children.length, 0);
});

test('markdown: bare URL becomes a safe anchor', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, 'Check https://example.com/x for more info.');
  const anchors = root.querySelectorAll('a');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].getAttribute('href'), 'https://example.com/x');
  assert.equal(anchors[0].getAttribute('target'), '_blank');
  assert.equal(anchors[0].getAttribute('rel'), 'noopener noreferrer');
  assert.equal(anchors[0].textContent, 'https://example.com/x');
});

test('markdown: trailing sentence punctuation stays outside the autolink', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, 'see https://example.com.');
  const a = root.querySelector('a');
  assert.ok(a);
  assert.equal(a.getAttribute('href'), 'https://example.com');
  assert.equal(a.textContent, 'https://example.com');
  // The period must be rendered as text, not inside the anchor.
  assert.match(root.textContent, /https:\/\/example\.com\.$/);
});

test('markdown: URL inside **bold** gets wrapped by <strong> and is clickable', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, '**https://example.com**');
  const strong = root.querySelector('strong');
  assert.ok(strong, 'expected <strong>');
  const a = strong.querySelector('a');
  assert.ok(a, 'expected anchor inside <strong>');
  assert.equal(a.getAttribute('href'), 'https://example.com');
});

test('markdown: explicit [label](url) link wins over bare-URL autolink', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, '[docs](https://example.com/x)');
  const anchors = root.querySelectorAll('a');
  assert.equal(anchors.length, 1, 'only one anchor, no nested autolink');
  assert.equal(anchors[0].getAttribute('href'), 'https://example.com/x');
  assert.equal(anchors[0].textContent, 'docs');
});

test('markdown: multiple bare URLs in one paragraph all autolink', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, 'Compare http://a.example.com and https://b.example.com here.');
  const anchors = root.querySelectorAll('a');
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].getAttribute('href'), 'http://a.example.com');
  assert.equal(anchors[1].getAttribute('href'), 'https://b.example.com');
});

test('markdown: non-http schemes are not autolinked', async () => {
  setupDOM();
  const md = await loadMarkdown();
  // The bare-URL alternative only matches http(s); other schemes stay literal.
  const root = render(md, 'try javascript:alert(1) or ftp://files.example.com');
  assert.equal(root.querySelector('a'), null);
  assert.match(root.textContent, /javascript:alert\(1\)/);
  assert.match(root.textContent, /ftp:\/\/files\.example\.com/);
});

test('markdown: real plan-shaped input — headings, lists, code, bold', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const src = [
    '# Implementation Plan',
    '',
    '## Context',
    '',
    'We need to **migrate** the auth middleware because it stores session tokens insecurely.',
    '',
    '## Steps',
    '',
    '1. Audit the current middleware',
    '2. Write a replacement',
    '3. Roll out behind a flag',
    '',
    '## Files to touch',
    '',
    '- `src/auth/middleware.ts`',
    '- `src/auth/migration.ts`',
    '',
    '```ts',
    'export function authMiddleware(req) { /* ... */ }',
    '```',
  ].join('\n');
  const root = render(md, src);
  assert.equal(root.querySelectorAll('h1').length, 1);
  assert.equal(root.querySelectorAll('h2').length, 3);
  assert.ok(root.querySelector('strong'));
  assert.equal(root.querySelectorAll('ol li').length, 3);
  assert.equal(root.querySelectorAll('ul li').length, 2);
  // Inline code inside the list items.
  assert.ok(root.querySelector('ul li code'));
  const pre = root.querySelector('pre');
  assert.ok(pre);
  assert.equal(pre.querySelector('code').dataset.lang, 'ts');
  assert.match(pre.textContent, /authMiddleware/);
});
