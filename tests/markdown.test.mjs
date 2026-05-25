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

test('markdown: fenced code block gets a sibling Copy button inside a wrapper', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, '```\nhello world\n```');
  const wrap = root.querySelector('.md-code-wrap');
  assert.ok(wrap, 'expected .md-code-wrap to exist');
  const pre = wrap.querySelector('pre');
  assert.ok(pre, 'expected <pre> inside wrapper');
  const btn = wrap.querySelector(':scope > .md-code-copy');
  assert.ok(btn, 'expected .md-code-copy as direct child of wrapper');
  assert.equal(btn.tagName, 'BUTTON');
  assert.equal(btn.getAttribute('type'), 'button');
  assert.equal(btn.textContent, 'Copy');
  // Button must NOT live inside <pre> — otherwise pre.textContent would
  // include "Copy" and break copy semantics.
  assert.equal(pre.querySelector('.md-code-copy'), null);
  assert.equal(pre.textContent, 'hello world');
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

test('markdown: GFM pipe table renders thead + tbody with right cell counts', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const src = [
    '| A | B | C |',
    '| --- | --- | --- |',
    '| 1 | 2 | 3 |',
    '| 4 | 5 | 6 |',
  ].join('\n');
  const root = render(md, src);
  const table = root.querySelector('table');
  assert.ok(table, 'expected <table>');
  const ths = table.querySelectorAll('thead th');
  assert.equal(ths.length, 3);
  assert.equal(ths[0].textContent, 'A');
  assert.equal(ths[2].textContent, 'C');
  const rows = table.querySelectorAll('tbody tr');
  assert.equal(rows.length, 2);
  const cells = rows[0].querySelectorAll('td');
  assert.equal(cells.length, 3);
  assert.equal(cells[1].textContent, '2');
  assert.equal(rows[1].querySelectorAll('td')[2].textContent, '6');
});

test('markdown: table alignment markers become text-align styles', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const src = [
    '| L | C | R |',
    '| :--- | :---: | ---: |',
    '| a | b | c |',
  ].join('\n');
  const root = render(md, src);
  const ths = root.querySelectorAll('thead th');
  assert.equal(ths[0].style.textAlign, 'left');
  assert.equal(ths[1].style.textAlign, 'center');
  assert.equal(ths[2].style.textAlign, 'right');
  const tds = root.querySelectorAll('tbody td');
  assert.equal(tds[0].style.textAlign, 'left');
  assert.equal(tds[1].style.textAlign, 'center');
  assert.equal(tds[2].style.textAlign, 'right');
});

test('markdown: inline markdown inside table cells (bold, code, link) is rendered', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const src = [
    '| Name | Value |',
    '| --- | --- |',
    '| **bold** | `code` |',
    '| [docs](https://example.com) | plain |',
  ].join('\n');
  const root = render(md, src);
  assert.ok(root.querySelector('tbody td strong'));
  assert.equal(root.querySelector('tbody td strong').textContent, 'bold');
  assert.ok(root.querySelector('tbody td code'));
  const a = root.querySelector('tbody td a');
  assert.ok(a);
  assert.equal(a.getAttribute('href'), 'https://example.com');
  assert.equal(a.textContent, 'docs');
});

test('markdown: pipe row without a separator row stays a paragraph', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, 'this | has | pipes\nbut no separator\n');
  assert.equal(root.querySelector('table'), null);
  assert.ok(root.querySelector('p'));
  assert.match(root.textContent, /this \| has \| pipes/);
});

test('markdown: table parses both with and without edge pipes', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const withEdges = [
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
  ].join('\n');
  const noEdges = [
    'A | B',
    '--- | ---',
    '1 | 2',
  ].join('\n');
  const r1 = render(md, withEdges);
  const r2 = render(md, noEdges);
  for (const root of [r1, r2]) {
    const table = root.querySelector('table');
    assert.ok(table);
    assert.equal(table.querySelectorAll('thead th').length, 2);
    const cells = table.querySelectorAll('tbody td');
    assert.equal(cells.length, 2);
    assert.equal(cells[0].textContent, '1');
    assert.equal(cells[1].textContent, '2');
  }
});

test('markdown: short and long rows are normalized to header width', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const src = [
    '| A | B | C |',
    '| --- | --- | --- |',
    '| only-one |',
    '| 1 | 2 | 3 | 4 | 5 |',
  ].join('\n');
  const root = render(md, src);
  const rows = root.querySelectorAll('tbody tr');
  assert.equal(rows.length, 2);
  const row1 = rows[0].querySelectorAll('td');
  assert.equal(row1.length, 3);
  assert.equal(row1[0].textContent, 'only-one');
  assert.equal(row1[1].textContent, '');
  assert.equal(row1[2].textContent, '');
  const row2 = rows[1].querySelectorAll('td');
  assert.equal(row2.length, 3);
  assert.equal(row2[2].textContent, '3');
});

test('markdown: image with http(s) src renders <img>', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, '![a screenshot](https://example.com/a.png)');
  const img = root.querySelector('img');
  assert.ok(img);
  assert.equal(img.getAttribute('src'), 'https://example.com/a.png');
  assert.equal(img.getAttribute('alt'), 'a screenshot');
  assert.equal(img.getAttribute('loading'), 'lazy');
});

test('markdown: image with file:// src renders <img> and empty alt', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, '![](file:///data/data/com.termux/files/home/foo.png)');
  const img = root.querySelector('img');
  assert.ok(img);
  assert.equal(img.getAttribute('src'), 'file:///data/data/com.termux/files/home/foo.png');
  assert.equal(img.getAttribute('alt'), '');
});

test('markdown: image with absolute /path src renders <img>', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, '![x](/static/a.png)');
  const img = root.querySelector('img');
  assert.ok(img);
  assert.equal(img.getAttribute('src'), '/static/a.png');
  assert.equal(img.getAttribute('alt'), 'x');
});

test('markdown: image with javascript: src renders as literal text', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, 'see ![x](javascript:alert(1)) here');
  assert.equal(root.querySelector('img'), null);
  assert.match(root.textContent, /!\[x\]\(javascript:alert\(1\)\)/);
});

test('markdown: image with data: src renders as literal text', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, '![x](data:image/svg+xml,<script>alert(1)</script>)');
  assert.equal(root.querySelector('img'), null);
  assert.equal(root.querySelector('script'), null);
  assert.match(root.textContent, /data:image\/svg\+xml/);
});

test('markdown: image inside a table cell renders via renderInline', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const src = [
    '| Name | Preview |',
    '| --- | --- |',
    '| logo | ![logo](https://example.com/logo.png) |',
  ].join('\n');
  const root = render(md, src);
  const img = root.querySelector('tbody td img');
  assert.ok(img);
  assert.equal(img.getAttribute('src'), 'https://example.com/logo.png');
  assert.equal(img.getAttribute('alt'), 'logo');
});

test('markdown: ![alt](url) image does not collide with [text](url) link in same paragraph', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const root = render(md, 'See ![pic](https://example.com/p.png) and [docs](https://example.com/d) please.');
  const imgs = root.querySelectorAll('img');
  const anchors = root.querySelectorAll('a');
  assert.equal(imgs.length, 1);
  assert.equal(anchors.length, 1);
  assert.equal(imgs[0].getAttribute('src'), 'https://example.com/p.png');
  assert.equal(imgs[0].getAttribute('alt'), 'pic');
  assert.equal(anchors[0].getAttribute('href'), 'https://example.com/d');
  assert.equal(anchors[0].textContent, 'docs');
});

test('markdown: table terminates cleanly when followed by a heading', async () => {
  setupDOM();
  const md = await loadMarkdown();
  const src = [
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '## After',
    '',
    'tail paragraph',
  ].join('\n');
  const root = render(md, src);
  const table = root.querySelector('table');
  assert.ok(table);
  assert.equal(table.querySelectorAll('tbody tr').length, 1);
  const h2 = root.querySelector('h2');
  assert.ok(h2);
  assert.equal(h2.textContent, 'After');
  const ps = root.querySelectorAll('p');
  assert.equal(ps.length, 1);
  assert.match(ps[0].textContent, /tail paragraph/);
});
