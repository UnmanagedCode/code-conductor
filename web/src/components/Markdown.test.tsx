// The markdown contract of <Markdown>: CommonMark + GFM structure (nested blocks included), the inline set, tables and
// images, the attribute surface, the link and image scheme allow-lists, raw HTML as literal text, the code-block Copy
// button, and the whitespace the `whitespace-pre-wrap` callers rely on. cc's own view-link policy is viewLinks.test.tsx's.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { Markdown } from './Markdown';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Renders `text` and returns the markdown host (the `.md` element). */
function mount(text: string): HTMLElement {
  const { container } = render(<Markdown text={text} />);
  return container.querySelector('.md') as HTMLElement;
}

/** Depth-first, document order; attribute pairs sorted by name. */
function attrSurface(root: Element) {
  const out: { tag: string; attrs: [string, string][] }[] = [];
  const walk = (node: Element) => {
    for (const child of node.children) {
      out.push({
        tag: child.tagName.toLowerCase(),
        attrs: [...child.attributes].map((a): [string, string] => [a.name, a.value]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)),
      });
      walk(child);
    }
  };
  walk(root);
  return out;
}

const allElements = (root: Element) => [...root.querySelectorAll('*')];

describe('markdown structure', () => {
  // Pins: ATX headings map to h1..h6 by level with their text.
  it('headings parse to h1..h6 with the right text', () => {
    const root = mount('# Title\n## Sub\n### Detail');
    const hs = root.querySelectorAll('h1, h2, h3');
    expect(hs).toHaveLength(3);
    expect(hs[0].tagName).toBe('H1');
    expect(hs[0].textContent).toBe('Title');
    expect(hs[1].tagName).toBe('H2');
    expect(hs[2].tagName).toBe('H3');
  });

  // Pins: a blank line separates paragraphs.
  it('paragraphs separated by blank lines', () => {
    const ps = mount('First paragraph.\n\nSecond paragraph.').querySelectorAll('p');
    expect(ps).toHaveLength(2);
    expect(ps[0].textContent).toMatch(/First paragraph/);
    expect(ps[1].textContent).toMatch(/Second paragraph/);
  });

  // Pins: -, * and + all make unordered list items, each holding its own text.
  it('unordered list with mixed bullet chars', () => {
    const lis = mount('- one\n* two\n+ three').querySelectorAll('ul li');
    expect(lis).toHaveLength(3);
    expect(lis[0].textContent).toBe('one');
    expect(lis[2].textContent).toBe('three');
  });

  // Pins: `1.` lines make ordered list items.
  it('ordered list', () => {
    const lis = mount('1. first\n2. second\n3. third').querySelectorAll('ol li');
    expect(lis).toHaveLength(3);
    expect(lis[1].textContent).toBe('second');
  });

  // Pins: a fenced block keeps its lines verbatim (no trailing newline) and its info string as data-lang.
  it('fenced code block preserves whitespace + language data attr', () => {
    const code = mount('```js\nconst x = 1;\nconst y = 2;\n```').querySelector('pre code') as HTMLElement;
    expect(code.dataset.lang).toBe('js');
    expect(code.textContent).toBe('const x = 1;\nconst y = 2;');
  });

  // Pins: a code block sits in .md-code-wrap with a type=button Copy button beside, never inside, its <pre>.
  it('fenced code block gets a sibling Copy button inside a wrapper', () => {
    const wrap = mount('```\nhello world\n```').querySelector('.md-code-wrap')!;
    expect(wrap, 'expected .md-code-wrap to exist').toBeTruthy();
    const pre = wrap.querySelector('pre')!;
    expect(pre, 'expected <pre> inside wrapper').toBeTruthy();
    const btn = wrap.querySelector(':scope > .md-code-copy')!;
    expect(btn, 'expected .md-code-copy as direct child of wrapper').toBeTruthy();
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.textContent).toBe('Copy');
    expect(pre.querySelector('.md-code-copy'), 'copy button must not be inside <pre>').toBeNull();
    expect(pre.textContent).toBe('hello world');
    expect(wrap.querySelector('code')!.hasAttribute('data-lang'), 'no info string, no data-lang').toBe(false);
  });

  // Pins: **bold**, *italic* and `code` render as strong, em and code with their inner text.
  it('inline bold / italic / code', () => {
    const p = mount('Use **bold** and *italic* and `code` here.').querySelector('p')!;
    expect(p.querySelector('strong')!.textContent).toBe('bold');
    expect(p.querySelector('em')!.textContent).toBe('italic');
    expect(p.querySelector('code')!.textContent).toBe('code');
  });

  // Pins: a blockquote holds its lines.
  it('blockquote', () => {
    const bq = mount('> remember to verify\n> the migration').querySelector('blockquote')!;
    expect(bq.textContent).toMatch(/remember to verify/);
    expect(bq.textContent).toMatch(/the migration/);
  });

  // Pins: --- between blank lines is a rule between two paragraphs.
  it('horizontal rule', () => {
    const root = mount('before\n\n---\n\nafter');
    expect(root.querySelector('hr')).toBeTruthy();
    expect(root.querySelectorAll('p')).toHaveLength(2);
  });

  // Pins: empty or whitespace-only input renders no element.
  it('empty / whitespace input renders nothing', () => {
    expect(mount('').children).toHaveLength(0);
    cleanup();
    expect(mount('   \n\n  \n').children).toHaveLength(0);
  });

  // Pins: a list's first number other than 1 becomes its start attribute.
  it('ordered list keeps a non-1 start number', () => {
    const ol = mount('3. a\n4. b').querySelector('ol')!;
    expect(ol.getAttribute('start')).toBe('3');
    expect(ol.querySelectorAll('li')).toHaveLength(2);
  });

  // Pins: a list starting at 1 carries no start attribute.
  it('ordered list starting at 1 carries no start attribute', () => {
    expect(mount('1. a\n2. b').querySelector('ol')!.hasAttribute('start')).toBe(false);
  });

  // Pins: an indented `-` line under an ordered item nests a list in that item, so the outer list is one list; a
  // `---` line with words is a paragraph, not a rule.
  it('an indented line under an ordered item nests a list in it, and the outer list continues', () => {
    const root = mount('--- questions ---\n1. Q one\n   - opt\n2. Q two');
    const ols = root.querySelectorAll('ol');
    expect(ols).toHaveLength(1);
    expect(ols[0].hasAttribute('start')).toBe(false);
    const items = ols[0].querySelectorAll(':scope > li');
    expect(items).toHaveLength(2);
    expect(items[0].querySelector(':scope > ul > li')!.textContent).toBe('opt');
    expect(items[1].textContent).toBe('Q two');
    expect(root.querySelector('hr'), 'the --- questions --- line is not a horizontal rule').toBeNull();
    expect(root.querySelector(':scope > p')!.textContent).toMatch(/--- questions ---/);
  });

  // Pins: a plan-shaped document keeps every block kind, inline code in list items and the fence's language.
  it('real plan-shaped input — headings, lists, code, bold', () => {
    const src = [
      '# Implementation Plan', '', '## Context', '',
      'We need to **migrate** the auth middleware because it stores session tokens insecurely.', '',
      '## Steps', '', '1. Audit the current middleware', '2. Write a replacement', '3. Roll out behind a flag', '',
      '## Files to touch', '', '- `src/auth/middleware.ts`', '- `src/auth/migration.ts`', '',
      '```ts', 'export function authMiddleware(req) { /* ... */ }', '```',
    ].join('\n');
    const root = mount(src);
    expect(root.querySelectorAll('h1')).toHaveLength(1);
    expect(root.querySelectorAll('h2')).toHaveLength(3);
    expect(root.querySelector('strong')).toBeTruthy();
    expect(root.querySelectorAll('ol li')).toHaveLength(3);
    expect(root.querySelectorAll('ul li')).toHaveLength(2);
    expect(root.querySelector('ul li code')).toBeTruthy();
    const pre = root.querySelector('pre')!;
    expect((pre.querySelector('code') as HTMLElement).dataset.lang).toBe('ts');
    expect(pre.textContent).toMatch(/authMiddleware/);
  });
});

describe('nested blocks', () => {
  /** Asserts `wrap` is a full code block holding exactly `code` with language `lang`. */
  function expectCodeBlock(wrap: Element | null, code: string, lang: string | null) {
    expect(wrap, 'a .md-code-wrap exists where expected').toBeTruthy();
    const c = wrap!.querySelector(':scope > pre > code') as HTMLElement;
    expect(c, 'the wrap holds pre > code').toBeTruthy();
    expect(c.textContent).toBe(code);
    expect(c.getAttribute('data-lang')).toBe(lang);
    expect(wrap!.querySelector(':scope > button.md-code-copy')!.textContent).toBe('Copy');
  }
  /** No inline <code> outside a <pre> holds a fence's backticks. */
  function expectNoFenceAsInline(root: Element) {
    for (const c of root.querySelectorAll('code')) {
      if (c.closest('pre')) continue;
      expect(c.textContent, 'an inline code span holds no fence').not.toMatch(/```|^js$/);
    }
    expect(root.textContent, 'no fence backticks leak into the text').not.toContain('```');
  }

  // Pins: the SKILL.md shape — a fence indented under an ordered item after a blank line — is a code block inside the item.
  it('a fence indented under a `1.` item after a blank line renders as a code block in that item', () => {
    const root = mount('1. Install it:\n\n   ```js\n   const x = 1;\n     indented();\n   ```\n2. Next');
    expectCodeBlock(root.querySelector('ol > li .md-code-wrap'), 'const x = 1;\n  indented();', 'js');
    expect(root.querySelector('ol > li .md-code-wrap')!.closest('li')!.parentElement!.children).toHaveLength(2);
    expectNoFenceAsInline(root);
  });

  // Pins: play-arc's SKILL.md shape — a 2-space fence right after a nested list — belongs to the outer `-` item, after its nested list.
  it('a 2-space fence after a nested list belongs to the outer `-` item', () => {
    const root = mount('- For scripted play:\n  - Call note first.\n  - Step with act.\n  ```js\n  await cc.x();\n  ```\n- Done');
    const outer = root.querySelectorAll(':scope > ul > li');
    expect(outer).toHaveLength(2);
    const wrap = outer[0].querySelector(':scope > .md-code-wrap');
    expectCodeBlock(wrap, 'await cc.x();', 'js');
    expect(wrap!.previousElementSibling!.matches('ul'), 'the code block follows the nested list').toBe(true);
    expect(outer[0].querySelectorAll(':scope > ul > li')).toHaveLength(2);
    expectNoFenceAsInline(root);
  });

  // Pins: a fence inside a blockquote is a code block inside the quote.
  it('a fence inside > renders as a code block in the quote', () => {
    const root = mount('> Run:\n>\n> ```sh\n> npm test\n> ```');
    expectCodeBlock(root.querySelector('blockquote .md-code-wrap'), 'npm test', 'sh');
    expectNoFenceAsInline(root);
  });

  // Pins: a fence after a blank line in a `-` item, indented to the item's content, stays in the item.
  it('a fence after a blank line in a `-` item renders as a code block in that item', () => {
    const root = mount('- step one\n\n  ```\n  echo hi\n  ```\n- step two');
    const items = root.querySelectorAll(':scope > ul > li');
    expect(items).toHaveLength(2);
    expectCodeBlock(items[0].querySelector('.md-code-wrap'), 'echo hi', null);
    expectNoFenceAsInline(root);
  });

  // Pins: lists nest three levels deep across ul/ol with exact item counts per level, and a nested list keeps its start.
  it('nested lists three levels deep, mixed ul/ol', () => {
    const root = mount([
      '- a',
      '',
      '  3. a1',
      '     - a1x',
      '     - a1y',
      '  4. a2',
      '- b',
    ].join('\n'));
    const l1 = root.querySelectorAll(':scope > ul > li');
    expect(l1).toHaveLength(2);
    const ol = l1[0].querySelector(':scope > ol')!;
    expect(ol, 'the ordered list nests in the first item').toBeTruthy();
    expect(ol.getAttribute('start')).toBe('3');
    const l2 = ol.querySelectorAll(':scope > li');
    expect(l2).toHaveLength(2);
    const l3 = l2[0].querySelectorAll(':scope > ul > li');
    expect(l3).toHaveLength(2);
    expect([...l3].map((li) => li.textContent)).toEqual(['a1x', 'a1y']);
    expect(root.querySelectorAll('ul > li > ol > li > ul > li')).toHaveLength(2);
    expect(l1[1].textContent).toBe('b');
  });
});

describe('links and autolinks', () => {
  // Pins: a safe explicit link opens in a new tab with noopener and keeps its label.
  it('safe links open in new tab with noopener', () => {
    const a = mount('See [docs](https://example.com/x) for more.').querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/x');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.textContent).toBe('docs');
  });

  // Pins: a link with a refused scheme renders as its literal source.
  it('unsafe link schemes render as literal text', () => {
    const root = mount('click [here](javascript:alert(1)) please');
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toMatch(/\[here\]\(javascript:alert\(1\)\)/);
  });

  // Pins: a bare http(s) URL becomes a new-tab anchor whose text is the URL.
  it('bare URL becomes a safe anchor', () => {
    const anchors = mount('Check https://example.com/x for more info.').querySelectorAll('a');
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute('href')).toBe('https://example.com/x');
    expect(anchors[0].getAttribute('target')).toBe('_blank');
    expect(anchors[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(anchors[0].textContent).toBe('https://example.com/x');
  });

  // Pins: trailing sentence punctuation is text after the autolink, not part of it.
  it('trailing sentence punctuation stays outside the autolink', () => {
    const root = mount('see https://example.com.');
    const a = root.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com');
    expect(a.textContent).toBe('https://example.com');
    expect(root.textContent).toMatch(/https:\/\/example\.com\.$/);
  });

  // Pins: an autolink inside **bold** is an anchor inside the strong.
  it('URL inside **bold** gets wrapped by <strong> and is clickable', () => {
    const a = mount('**https://example.com**').querySelector('strong a')!;
    expect(a, 'expected anchor inside <strong>').toBeTruthy();
    expect(a.getAttribute('href')).toBe('https://example.com');
  });

  // Pins: an explicit link is one anchor, never a nested autolink.
  it('explicit [label](url) link wins over bare-URL autolink', () => {
    const anchors = mount('[docs](https://example.com/x)').querySelectorAll('a');
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute('href')).toBe('https://example.com/x');
    expect(anchors[0].textContent).toBe('docs');
  });

  // Pins: every bare URL in a paragraph autolinks.
  it('multiple bare URLs in one paragraph all autolink', () => {
    const anchors = mount('Compare http://a.example.com and https://b.example.com here.').querySelectorAll('a');
    expect(anchors).toHaveLength(2);
    expect(anchors[0].getAttribute('href')).toBe('http://a.example.com');
    expect(anchors[1].getAttribute('href')).toBe('https://b.example.com');
  });

  // Pins: a bare non-http scheme is not autolinked and stays in the text.
  it('non-http schemes are not autolinked', () => {
    const root = mount('try javascript:alert(1) or ftp://files.example.com');
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toMatch(/javascript:alert\(1\)/);
    expect(root.textContent).toMatch(/ftp:\/\/files\.example\.com/);
  });

  // Pins: GFM's www. and email autolinks become new-tab anchors on http:// and mailto:.
  it('www. and email addresses autolink with target=_blank', () => {
    const anchors = mount('Visit www.example.com or write a@b.co today.').querySelectorAll('a');
    expect([...anchors].map((a) => [a.getAttribute('href'), a.textContent, a.getAttribute('target'), a.getAttribute('rel')])).toEqual([
      ['http://www.example.com', 'www.example.com', '_blank', 'noopener noreferrer'],
      ['mailto:a@b.co', 'a@b.co', '_blank', 'noopener noreferrer'],
    ]);
  });
});

describe('tables', () => {
  // Pins: a GFM table has a thead row and tbody rows with the right cell counts and text.
  it('GFM pipe table renders thead + tbody with right cell counts', () => {
    const table = mount('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |').querySelector('table')!;
    const ths = table.querySelectorAll('thead th');
    expect(ths).toHaveLength(3);
    expect(ths[0].textContent).toBe('A');
    expect(ths[2].textContent).toBe('C');
    const rows = table.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelectorAll('td')).toHaveLength(3);
    expect(rows[0].querySelectorAll('td')[1].textContent).toBe('2');
    expect(rows[1].querySelectorAll('td')[2].textContent).toBe('6');
  });

  // Pins: alignment markers become text-align on header and body cells.
  it('table alignment markers become text-align styles', () => {
    const root = mount('| L | C | R |\n| :--- | :---: | ---: |\n| a | b | c |');
    const ths = root.querySelectorAll<HTMLElement>('thead th');
    expect([...ths].map((c) => c.style.textAlign)).toEqual(['left', 'center', 'right']);
    const tds = root.querySelectorAll<HTMLElement>('tbody td');
    expect([...tds].map((c) => c.style.textAlign)).toEqual(['left', 'center', 'right']);
  });

  // Pins: cells render inline markdown (bold, code, link).
  it('inline markdown inside table cells (bold, code, link) is rendered', () => {
    const root = mount('| Name | Value |\n| --- | --- |\n| **bold** | `code` |\n| [docs](https://example.com) | plain |');
    expect(root.querySelector('tbody td strong')!.textContent).toBe('bold');
    expect(root.querySelector('tbody td code')).toBeTruthy();
    const a = root.querySelector('tbody td a')!;
    expect(a.getAttribute('href')).toBe('https://example.com');
    expect(a.textContent).toBe('docs');
  });

  // Pins: a pipe row with no separator row is a paragraph.
  it('pipe row without a separator row stays a paragraph', () => {
    const root = mount('this | has | pipes\nbut no separator\n');
    expect(root.querySelector('table')).toBeNull();
    expect(root.querySelector('p')).toBeTruthy();
    expect(root.textContent).toMatch(/this \| has \| pipes/);
  });

  // Pins: edge pipes are optional.
  it('table parses both with and without edge pipes', () => {
    for (const src of ['| A | B |\n| --- | --- |\n| 1 | 2 |', 'A | B\n--- | ---\n1 | 2']) {
      const table = mount(src).querySelector('table')!;
      expect(table, src).toBeTruthy();
      expect(table.querySelectorAll('thead th')).toHaveLength(2);
      const cells = table.querySelectorAll('tbody td');
      expect([...cells].map((c) => c.textContent)).toEqual(['1', '2']);
      cleanup();
    }
  });

  // Pins: short rows pad to the header width with empty cells; long rows are cut to it.
  it('short and long rows are normalized to header width', () => {
    const rows = mount('| A | B | C |\n| --- | --- | --- |\n| only-one |\n| 1 | 2 | 3 | 4 | 5 |').querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect([...rows[0].querySelectorAll('td')].map((c) => c.textContent)).toEqual(['only-one', '', '']);
    expect([...rows[1].querySelectorAll('td')].map((c) => c.textContent)).toEqual(['1', '2', '3']);
  });

  // Pins: a heading ends a table; the paragraph after it is its own.
  it('table terminates cleanly when followed by a heading', () => {
    const root = mount('| A | B |\n| --- | --- |\n| 1 | 2 |\n## After\n\ntail paragraph');
    expect(root.querySelector('table')!.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(root.querySelector('h2')!.textContent).toBe('After');
    const ps = root.querySelectorAll('p');
    expect(ps).toHaveLength(1);
    expect(ps[0].textContent).toMatch(/tail paragraph/);
  });
});

describe('images', () => {
  // Pins: an http(s) image renders a lazy <img> with its alt.
  it('image with http(s) src renders <img>', () => {
    const img = mount('![a screenshot](https://example.com/a.png)').querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://example.com/a.png');
    expect(img.getAttribute('alt')).toBe('a screenshot');
    expect(img.getAttribute('loading')).toBe('lazy');
  });

  // Pins: a file:// image renders with an empty alt.
  it('image with file:// src renders <img> and empty alt', () => {
    const img = mount('![](file:///data/data/com.termux/files/home/foo.png)').querySelector('img')!;
    expect(img.getAttribute('src')).toBe('file:///data/data/com.termux/files/home/foo.png');
    expect(img.getAttribute('alt')).toBe('');
  });

  // Pins: an absolute-path image renders.
  it('image with absolute /path src renders <img>', () => {
    const img = mount('![x](/static/a.png)').querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/static/a.png');
    expect(img.getAttribute('alt')).toBe('x');
  });

  // Pins: a javascript: image renders as its literal source.
  it('image with javascript: src renders as literal text', () => {
    const root = mount('see ![x](javascript:alert(1)) here');
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toMatch(/!\[x\]\(javascript:alert\(1\)\)/);
  });

  // Pins: a data: image renders as text, and its payload never becomes an element.
  it('image with data: src renders as literal text', () => {
    const root = mount('![x](data:image/svg+xml,<script>alert(1)</script>)');
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('script')).toBeNull();
    expect(root.textContent).toMatch(/data:image\/svg\+xml/);
  });

  // Pins: an image renders inside a table cell.
  it('image inside a table cell renders', () => {
    const img = mount('| Name | Preview |\n| --- | --- |\n| logo | ![logo](https://example.com/logo.png) |').querySelector('tbody td img')!;
    expect(img.getAttribute('src')).toBe('https://example.com/logo.png');
    expect(img.getAttribute('alt')).toBe('logo');
  });

  // Pins: an image and a link in one paragraph each render once.
  it('![alt](url) image does not collide with [text](url) link in same paragraph', () => {
    const root = mount('See ![pic](https://example.com/p.png) and [docs](https://example.com/d) please.');
    const imgs = root.querySelectorAll('img');
    const anchors = root.querySelectorAll('a');
    expect(imgs).toHaveLength(1);
    expect(anchors).toHaveLength(1);
    expect(imgs[0].getAttribute('src')).toBe('https://example.com/p.png');
    expect(imgs[0].getAttribute('alt')).toBe('pic');
    expect(anchors[0].getAttribute('href')).toBe('https://example.com/d');
    expect(anchors[0].textContent).toBe('docs');
  });
});

describe('attribute surface', () => {
  // One fixture exercising every element kind the renderer emits for the common subset.
  const FIXTURE = [
    '# Title', '', '### Detail', '',
    'A **bold** and *italic* and _under_ and `code` paragraph.', '',
    '```js', 'const x = 1;', '```', '',
    '- **one** leading bold', '- item two', '',
    '1. first', '2. second', '',
    '> quoted **text**', '',
    '---', '',
    '| L | C | R |', '| :--- | :---: | ---: |', '| a | b | c |', '',
    '[text](https://example.com) and https://example.org and ![alt](https://example.com/i.png)',
  ].join('\n');

  // Pins: the whole element tree — tags, nesting order and the exact attribute set of every element (a quote holds a paragraph).
  it('element tree carries exactly the attributes the renderer intends', () => {
    expect(attrSurface(mount(FIXTURE))).toEqual([
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
      { tag: 'p', attrs: [] },
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
    ]);
  });

  // Pins: no text is lost or added between the source and the rendered tree (a dropped child drops its text).
  it('no text is lost between the source and the rendered tree', () => {
    expect(mount(FIXTURE).textContent).toBe(
      'TitleDetailA bold and italic and under and code paragraph.Copyconst x = 1;'
      + 'one leading bolditem twofirstsecondquoted textLCRabctext and https://example.org and ',
    );
  });
});

describe('safety', () => {
  // Pins: a link whose final, decoded URL has a refused scheme renders no anchor and shows its own source text.
  it.each([
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](javascript&#58;alert(1))',
    '<javascript:alert(1)>',
    '[x](data:text/html,x)',
    '[x](vbscript:x)',
    '[x](ftp://h)',
  ])('link %s renders as its literal source', (src) => {
    const root = mount(`before ${src} after`);
    expect(root.querySelector('a')).toBeNull();
    expect(root.querySelector('a[href]')).toBeNull();
    expect(root.textContent).toBe(`before ${src} after`);
  });

  // Pins: an image whose decoded src has a refused scheme renders no <img> and shows its own source text; mailto: is a link scheme, not an image one.
  it.each([
    '![x](javascript:alert(1))',
    '![x](data:image/svg+xml,<script>alert(1)</script>)',
    '![x](mailto:a@b)',
  ])('image %s renders as its literal source', (src) => {
    const root = mount(`before ${src} after`);
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toBe(`before ${src} after`);
  });

  /** Every tag the renderer may emit. */
  const ALLOWED = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'code', 'pre', 'div', 'button', 'ul', 'ol', 'li',
    'blockquote', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'img', 'input']);

  // Pins: raw HTML, block or inline, never becomes an element or an attribute; it shows as its literal source.
  it.each([
    { src: '<script>alert(1)</script>\n\n**bold**', literal: '<script>alert(1)</script>' },
    { src: '<iframe src="https://evil.example"></iframe>', literal: '<iframe src="https://evil.example"></iframe>' },
    { src: '<iframe srcdoc="<script>x</script>">', literal: '<iframe srcdoc="<script>x</script>">' },
    { src: '<pasted_content>\nhello\n</pasted_content>', literal: '<pasted_content>' },
    { src: '<div style="color:red" onclick="x()">\nhi\n</div>', literal: '<div style="color:red" onclick="x()">' },
    { src: 'a <b onclick=x>b</b> <img src=x onerror=alert(1)>', literal: 'a <b onclick=x>b</b> <img src=x onerror=alert(1)>' },
    { src: '- item <span style="x">s</span>\n> quote <a href="javascript:x">l</a>', literal: '<a href="javascript:x">l</a>' },
  ])('raw HTML $literal renders as literal text', ({ src, literal }) => {
    const root = mount(src);
    for (const el of allElements(root)) {
      const tag = el.tagName.toLowerCase();
      expect(ALLOWED.has(tag), `<${tag}> is not a renderer tag`).toBe(true);
      for (const a of el.attributes) {
        expect(/^on/i.test(a.name), `${tag}[${a.name}]`).toBe(false);
        expect(a.name === 'srcdoc', `${tag}[srcdoc]`).toBe(false);
        if (a.name === 'style') expect(['th', 'td'].includes(tag), `a style only on a table cell, not on <${tag}>`).toBe(true);
      }
    }
    expect(root.querySelector('script, iframe, span, b, img')).toBeNull();
    expect(root.textContent).toContain(literal);
  });
});

describe('extras', () => {
  /** Stubs the clipboard; returns the texts written. */
  function stubClipboard(outcome: 'resolve' | 'reject') {
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t: string) => { writes.push(t); return outcome === 'resolve' ? Promise.resolve() : Promise.reject(new Error('denied')); } },
    });
    return writes;
  }
  const NESTED_FENCE = '- step\n\n  ```sh\n  npm ci\n  npm test\n  ```';

  // Pins: Copy on a nested code block writes exactly its code (no trailing newline), flashes Copied/copied, resets to Copy after 1200 ms, and the click stays in the button.
  it.each([
    { outcome: 'resolve' as const, label: 'Copied', cls: 'copied' },
    { outcome: 'reject' as const, label: 'Copy failed', cls: 'failed' },
  ])('Copy on a nested fence: $label, then back to Copy', async ({ outcome, label, cls }) => {
    vi.useFakeTimers();
    const writes = stubClipboard(outcome);
    const outer = vi.fn();
    const { container } = render(<div onClick={outer}><Markdown text={NESTED_FENCE} /></div>);
    const btn = container.querySelector('ul > li .md-code-wrap > button.md-code-copy') as HTMLButtonElement;
    expect(btn, 'fixture check: the nested fence has a Copy button').toBeTruthy();
    await act(async () => { fireEvent.click(btn); });
    expect(writes).toEqual(['npm ci\nnpm test']);
    expect(outer, 'the click does not reach the markdown\'s ancestors').not.toHaveBeenCalled();
    expect(btn.textContent).toBe(label);
    expect(btn.classList.contains(cls)).toBe(true);
    expect(btn.classList.contains(cls === 'copied' ? 'failed' : 'copied')).toBe(false);
    act(() => { vi.advanceTimersByTime(1199); });
    expect(btn.textContent, 'still flashing just before 1200 ms').toBe(label);
    act(() => { vi.advanceTimersByTime(1); });
    expect(btn.textContent).toBe('Copy');
    expect(btn.classList.contains('copied') || btn.classList.contains('failed')).toBe(false);
  });

  // Pins: a single ~ is literal (agents write ~ for "about"); ~~double~~ strikes through.
  it('single tildes stay literal; double tildes strike through', () => {
    const root = mount('~5 min to ~10 min, range 1~5 and 3~7, ~~gone~~');
    const dels = root.querySelectorAll('del');
    expect([...dels].map((d) => d.textContent)).toEqual(['gone']);
    expect(root.textContent).toBe('~5 min to ~10 min, range 1~5 and 3~7, gone');
  });

  describe('whitespace under whitespace-pre-wrap', () => {
    const DOC = [
      'Intro line one', 'line two', '',
      '> quoted', '>', '> - in quote', '',
      '- tight **a** **b**', '  1. nested', '     - deeper', '- next', '',
      '* loose', '', '  second para', '', '* loose two', '',
      '| a | b |', '| - | - |', '| 1 | 2 |', '',
      '```', 'code', '```',
    ].join('\n');
    const isWs = (n: Node) => n.nodeType === Node.TEXT_NODE && !/\S/.test(n.textContent ?? '');
    const BLOCK = 'p, ul, ol, pre, blockquote, table, hr, h1, h2, h3, h4, h5, h6, div';

    // Pins: no whitespace-only text node sits between block containers (root, quote, list, table parts) or beside a block in an item.
    it('no whitespace-only text node between blocks', () => {
      const root = mount(DOC);
      expect(root.querySelector('blockquote ul'), 'fixture check: a list nests in the quote').toBeTruthy();
      expect(root.querySelector('ul > li > ol > li > ul'), 'fixture check: three nested list levels').toBeTruthy();
      expect(root.querySelector('li > p + p'), 'fixture check: a loose item holds two paragraphs').toBeTruthy();
      for (const host of [root, ...root.querySelectorAll('blockquote, ul, ol, table, thead, tbody, tr')]) {
        const ws = [...host.childNodes].filter(isWs);
        expect(ws.map((n) => JSON.stringify(n.textContent)), `whitespace text in <${host.tagName.toLowerCase()}>`).toEqual([]);
      }
      for (const li of root.querySelectorAll('li')) {
        const kids = [...li.childNodes];
        kids.forEach((n, i) => {
          if (!isWs(n)) return;
          const nb = [kids[i - 1], kids[i + 1]].filter((x): x is Element => x instanceof Element);
          expect(nb.some((x) => x.matches(BLOCK)), `whitespace beside a block in <li>${li.textContent}`).toBe(false);
        });
      }
    });

    // Pins: a soft break inside a paragraph stays a newline, and the space between two inline runs in a tight item stays.
    it('a soft break stays \\n and an inline space stays', () => {
      const root = mount(DOC);
      expect(root.querySelector(':scope > p')!.textContent).toBe('Intro line one\nline two');
      const tight = root.querySelector(':scope > ul > li')!;
      expect(tight.querySelectorAll(':scope > strong')).toHaveLength(2);
      expect(tight.firstChild!.textContent).toBe('tight ');
      expect([...tight.childNodes].slice(0, 4).map((n) => n.textContent).join('')).toBe('tight a b');
    });
  });
});
