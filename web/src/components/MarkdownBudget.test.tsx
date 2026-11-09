// Markdown's complexity budget: each measure in COMPLEXITY_LIMITS bounds one of micromark's superlinear paths, and a
// document one past any limit shows its raw source without ever being parsed, while one at every limit renders.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from './Markdown';
import { COMPLEXITY_LIMITS, measureComplexity } from './markdown/complexity';

// Counts the renders that reach the markdown pipeline; otherwise the real module.
const parses = vi.hoisted(() => ({ count: 0 }));
vi.mock('react-markdown', async (importOriginal) => {
  const real = await importOriginal<typeof import('react-markdown')>();
  const Counted = (props: Parameters<typeof real.default>[0]) => {
    parses.count++;
    return real.default(props);
  };
  return { ...real, default: Counted };
});

afterEach(() => { parses.count = 0; });

function mount(text: string) {
  const { container } = render(<div><p data-sibling>sibling</p><Markdown text={text} /></div>);
  return { host: container.querySelector('.md') as HTMLElement, sibling: container.querySelector('[data-sibling]') };
}

const fence = (body: string) => `\`\`\`\n${body}\n\`\`\``;

describe('complexity measures', () => {
  // Pins: delimiters is the most `*`/`_` characters in one paragraph (a run of non-blank lines); fenced code holds none.
  it.each([
    { text: 'a *b* and _c_', value: 4 },
    { text: '***x\n\n**y** **z**', value: 8 },
    { text: 'one *a*\ntwo *b*', value: 4 },
    { text: fence('*'.repeat(2000)), value: 0 },
  ])('delimiters of $text is $value', ({ text, value }) => {
    expect(measureComplexity(text).delimiters).toBe(value);
  });

  // Pins: brackets is the most `]` in one paragraph; fenced code holds none.
  it.each([
    { text: '[a] [b](c) ![d](e)', value: 3 },
    { text: '[a]\n\n[b] [c]', value: 2 },
    { text: fence(']'.repeat(2000)), value: 0 },
  ])('brackets of $text is $value', ({ text, value }) => {
    expect(measureComplexity(text).brackets).toBe(value);
  });

  // Pins: definitions counts `]:` across the document (footnote definitions included); fenced code holds none.
  it.each([
    { text: '[a]: /u\n[b]: /v\n\n[a] [b]', value: 2 },
    { text: 'x[^1]\n\n[^1]: note', value: 1 },
    { text: '[a]: /u\n\ntext\n\n[b]: /v', value: 2 },
    { text: fence('[a]: /u'), value: 0 },
  ])('definitions of $text is $value', ({ text, value }) => {
    expect(measureComplexity(text).definitions).toBe(value);
  });

  // Pins: restarts counts each time the container markers change (a new list, quote, nesting level or bullet), a quote
  // resumed after a blank line, and each setext underline; one list's items, tight or loose, are one restart.
  it.each([
    { kind: 'one tight list', text: '- a\n- b\n- c', value: 1 },
    { kind: 'one loose list', text: '- a\n\n- b\n\n- c', value: 1 },
    { kind: 'items with continuation lines', text: '- a\n  more\n- b\n  more', value: 1 },
    { kind: 'separate quotes', text: '> a\n\n> b\n\n> c', value: 3 },
    { kind: 'lists split by a paragraph', text: '- a\n\nb\n\n- c', value: 2 },
    { kind: 'nesting toggles', text: '- a\n  - b\n- c\n  - d', value: 4 },
    { kind: 'a bullet change', text: '- a\n* b', value: 2 },
    { kind: 'setext underlines', text: 'A\n===\n\nB\n---', value: 2 },
    { kind: 'a rule after a blank line', text: 'a\n\n---', value: 0 },
    { kind: 'fenced markers', text: fence('> a\n\n> b\n\n- c'), value: 0 },
  ])('restarts of $kind is $value', ({ text, value }) => {
    expect(measureComplexity(text).restarts).toBe(value);
  });
});

describe('restarts bound what micromark parses', () => {
  // Pins: restarts is never below the lists, quotes and setext headings the render holds (each closes in micromark's event list).
  it.each([
    '- a\n  - b\n - c\n- d',
    '1. a\n   - b\n  - c\n3. d',
    '> a\n> - b\n> > c\n>\n> d',
    '- a\n<hr>\n- b',
    '- a\n***\n- b',
    '> a\nlazy\n> b',
    '- a\n\n      code\n\n- b\n> q',
    '* a\n+ b\n- c\n1. d\n1) e',
    'A\n=\nB\n-\n- C',
    '> A\n> ---\n> B\n> ===',
    '- a\n  > b\n- c\n  > d',
    '- a\r  - b\r- c\r\n  - d',
    '```\nx\n```\n> a\n\n> b',
    '- ```\n> a\n\n- b',
    '- - - - x\n      ***\n    ***\n  ***\n***',
    '- a\n  - b\n    - c\n      d\n    e\n  f\ng',
  ])('%j', (text) => {
    const { host } = mount(text);
    expect(host.querySelector(':scope > pre'), 'fixture check: the text renders').toBeNull();
    const containers = host.querySelectorAll('ul, ol, blockquote').length;
    const headings = host.querySelectorAll('h1, h2').length;
    expect(measureComplexity(text).restarts).toBeGreaterThanOrEqual(containers + headings);
  });
});

describe('the complexity budget', () => {
  const L = COMPLEXITY_LIMITS;
  const definitions = (k: number) => `${Array.from({ length: k }, (_, i) => `[d${i}]: /u${i}`).join('\n')}\n\n[d0]`;
  // Each case: a document whose measure sits exactly at `limit` (`at`), and the same shape one past it.
  const CASES = [
    { measure: 'delimiters', build: (k: number) => 'a* '.repeat(k), limit: L.delimiters },
    { measure: 'brackets', build: (k: number) => '[x]'.repeat(k), limit: L.brackets },
    { measure: 'definitions', build: definitions, limit: L.definitions },
    { measure: 'restarts (quotes)', build: (k: number) => '> a\n\n'.repeat(k), limit: L.restarts },
    { measure: 'restarts (setext)', build: (k: number) => 'a\n---\n'.repeat(k), limit: L.restarts },
  ] as const;

  // Pins: each case's builder sits exactly at its measure's limit, so the pins below are one past and at it.
  it.each(CASES)('fixture check: $measure builds to the limit', ({ measure, build, limit }) => {
    const key = measure.split(' ')[0] as keyof typeof L;
    expect(measureComplexity(build(limit))[key]).toBe(limit);
  });

  // Pins: a document one past any limit shows its raw source in one bare <pre> and never reaches react-markdown; siblings stay mounted.
  it.each(CASES)('one past the $measure limit falls back without parsing', ({ build, limit }) => {
    const text = build(limit + 1);
    const { host, sibling } = mount(text);
    expect(sibling?.textContent).toBe('sibling');
    expect([...host.children].map((c) => c.tagName)).toEqual(['PRE']);
    expect(host.textContent).toBe(text);
    expect(parses.count, 'the markdown pipeline never ran').toBe(0);
  });

  // Pins: a document exactly at a limit renders as markdown.
  it.each(CASES)('at the $measure limit the document renders', ({ build, limit }) => {
    const { host } = mount(build(limit));
    expect(host.querySelector(':scope > pre'), 'no fallback').toBeNull();
    expect(parses.count).toBeGreaterThan(0);
  });
});
