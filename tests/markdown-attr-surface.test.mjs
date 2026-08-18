// Characterization pin for the *attribute surface* of the markdown renderer.
//
// Why this exists: markdown.js builds every node through a private
// `el(tag, ...children)` helper whose signature differs from blocks.js's
// `el(tag, attrs, ...children)`. Consolidating onto the attrs-first form means
// inserting `{}` at each call site, and a missed `{}` fails in one of two
// silent ways:
//   - first child is a string → `Object.entries('text')` sets attributes
//     0="t", 1="e", … (visible corruption, text lost);
//   - first child is an element → `Object.entries(node)` yields nothing and
//     the child is silently DROPPED (e.g. `el('pre', code)`).
//
// tests/markdown.test.mjs cannot catch either: it asserts `getAttribute` only
// for attributes it expects and never asserts the absence of others, and a
// dropped element child leaves the remaining textContent assertions intact in
// most of its fixtures. So this file pins the whole tree — tags, children and
// the exact attribute set of every element — plus a signature guard for
// numeric attribute names.

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
  return window.document;
}

async function loadMarkdown() {
  return import(pathToFileURL(path.resolve(__dirname, '..', 'public', 'markdown.js')).href);
}

// One fixture exercising every `el` call site in markdown.js that a real
// document can reach: heading, paragraph, strong, em (both `*x*` and `_x_`),
// inline code, fenced code (pre > code, an ELEMENT first child), ul/ol items
// (one starting with an element child), blockquote, hr, a table with all three
// alignments, an explicit link, a bare autolink and an image.
const FIXTURE = [
  '# Title',
  '',
  '### Detail',
  '',
  'A **bold** and *italic* and _under_ and `code` paragraph.',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  '- **one** leading bold',
  '- item two',
  '',
  '1. first',
  '2. second',
  '',
  '> quoted **text**',
  '',
  '---',
  '',
  '| L | C | R |',
  '| :--- | :---: | ---: |',
  '| a | b | c |',
  '',
  '[text](https://example.com) and https://example.org and ![alt](https://example.com/i.png)',
].join('\n');

// Depth-first, document order. Attribute pairs sorted by name so the pin is
// insensitive to the order attributes happen to be set in.
function attrSurface(root) {
  const out = [];
  (function walk(node) {
    for (const child of node.children) {
      out.push({
        tag: child.tagName.toLowerCase(),
        attrs: [...child.attributes]
          .map(a => [a.name, a.value])
          .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)),
      });
      walk(child);
    }
  })(root);
  return out;
}

const EXPECTED = [
  { tag: 'h1', attrs: [] },
  { tag: 'h3', attrs: [] },
  { tag: 'p', attrs: [] },
  { tag: 'strong', attrs: [] },
  { tag: 'em', attrs: [] },
  { tag: 'em', attrs: [] },
  { tag: 'code', attrs: [] },
  { tag: 'div', attrs: [['class', 'md-code-wrap']] },
  { tag: 'button', attrs: [['class', 'md-code-copy'], ['type', 'button']] },
  { tag: 'pre', attrs: [] },
  { tag: 'code', attrs: [['data-lang', 'js']] },
  { tag: 'ul', attrs: [] },
  { tag: 'li', attrs: [] },
  { tag: 'strong', attrs: [] },
  { tag: 'li', attrs: [] },
  { tag: 'ol', attrs: [] },
  { tag: 'li', attrs: [] },
  { tag: 'li', attrs: [] },
  { tag: 'blockquote', attrs: [] },
  { tag: 'strong', attrs: [] },
  { tag: 'hr', attrs: [] },
  { tag: 'table', attrs: [] },
  { tag: 'thead', attrs: [] },
  { tag: 'tr', attrs: [] },
  { tag: 'th', attrs: [['style', 'text-align: left;']] },
  { tag: 'th', attrs: [['style', 'text-align: center;']] },
  { tag: 'th', attrs: [['style', 'text-align: right;']] },
  { tag: 'tbody', attrs: [] },
  { tag: 'tr', attrs: [] },
  { tag: 'td', attrs: [['style', 'text-align: left;']] },
  { tag: 'td', attrs: [['style', 'text-align: center;']] },
  { tag: 'td', attrs: [['style', 'text-align: right;']] },
  { tag: 'p', attrs: [] },
  { tag: 'a', attrs: [['href', 'https://example.com'], ['rel', 'noopener noreferrer'], ['target', '_blank']] },
  { tag: 'a', attrs: [['href', 'https://example.org'], ['rel', 'noopener noreferrer'], ['target', '_blank']] },
  { tag: 'img', attrs: [['alt', 'alt'], ['loading', 'lazy'], ['src', 'https://example.com/i.png']] },
];

const EXPECTED_TEXT =
  'TitleDetailA bold and italic and under and code paragraph.Copyconst x = 1;'
  + 'one leading bolditem twofirstsecondquoted textLCRabctext and https://example.org and ';

test('markdown: element tree carries exactly the attributes the renderer intends', async () => {
  const document = setupDOM();
  const md = await loadMarkdown();
  const root = document.createElement('div');
  md.renderMarkdownInto(root, FIXTURE);
  assert.deepEqual(attrSurface(root), EXPECTED);
});

test('markdown: no element carries a numeric attribute name', async () => {
  // The direct signature of `Object.entries(<string>)` being treated as an
  // attribute bag. Survives fixture churn — any future call site is covered.
  const document = setupDOM();
  const md = await loadMarkdown();
  const root = document.createElement('div');
  md.renderMarkdownInto(root, FIXTURE);
  const offenders = [];
  (function walk(node) {
    for (const child of node.children) {
      for (const a of child.attributes) {
        if (/^\d+$/.test(a.name)) offenders.push(`${child.tagName.toLowerCase()}[${a.name}="${a.value}"]`);
      }
      walk(child);
    }
  })(root);
  assert.deepEqual(offenders, []);
});

test('markdown: no text is lost between the source and the rendered tree', async () => {
  // A dropped element child (the second misparse mode) removes its text too,
  // so this catches the `el('pre', code)` shape even if a future tree shape
  // makes the structural pin above coarser.
  const document = setupDOM();
  const md = await loadMarkdown();
  const root = document.createElement('div');
  md.renderMarkdownInto(root, FIXTURE);
  assert.equal(root.textContent, EXPECTED_TEXT);
});

test('markdown: parse failure falls back to one bare <pre> with the raw text', async () => {
  const document = setupDOM();
  const md = await loadMarkdown();
  const root = document.createElement('div');
  // parseMarkdown's `String(text ?? '')` throws on the first call; the catch
  // path's own String() call succeeds and supplies the raw text.
  let calls = 0;
  const throwsOnce = {
    toString() {
      calls++;
      if (calls === 1) throw new Error('parse boom');
      return 'raw *text* here';
    },
  };
  md.renderMarkdownInto(root, throwsOnce);
  assert.deepEqual(attrSurface(root), [{ tag: 'pre', attrs: [] }]);
  assert.equal(root.textContent, 'raw *text* here');
});
