// Markdown's nesting cap: micromark's parse cost grows with characters × open-container depth, so a document nested
// past MAX_NESTING (lists or quotes) shows its raw source without ever being parsed, and one at the cap renders.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from './Markdown';
import { MAX_NESTING, nestingDepth } from './markdown/nestingDepth';

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

const list = (depth: number) => Array.from({ length: depth }, (_, i) => `${'  '.repeat(i)}- x`).join('\n');
const quote = (depth: number) => `${'>'.repeat(depth)} x`;
const sameLine = (depth: number) => `${'- '.repeat(depth)}x`;
const mixed = (depth: number) => Array.from({ length: depth }, (_, i) => `${'> '.repeat(i + 1)}x`).join('\n');

function mount(text: string) {
  const { container } = render(<div><p data-sibling>sibling</p><Markdown text={text} /></div>);
  return { host: container.querySelector('.md') as HTMLElement, sibling: container.querySelector('[data-sibling]') };
}

describe('nesting depth measure', () => {
  // Pins: a line's measure is its quote and list markers (several on one line too) plus half the extra indentation
  // columns before them (a marker's own following space excluded; tabs to 4-column stops); the document's is its deepest line.
  it.each([
    { text: 'plain text', depth: 0 },
    { text: '- a', depth: 1 },
    { text: list(5), depth: 5 },
    { text: quote(7), depth: 7 },
    { text: sameLine(4), depth: 4 },
    { text: '> - > 1. x', depth: 4 },
    { text: mixed(6), depth: 6 },
    { text: '\t- x', depth: 3 },
  ])('$text measures $depth', ({ text, depth }) => {
    expect(nestingDepth(text)).toBe(depth);
  });

  // Pins: indentation on a line that opens no container (code, prose) is not nesting.
  it('deep indentation without a marker measures 0', () => {
    expect(nestingDepth(`\`\`\`\n${' '.repeat(8 * MAX_NESTING)}deep();\n\`\`\``)).toBe(0);
  });
});

describe('the nesting cap', () => {
  // Pins: a document nested just past the cap, by list, quote, same-line or mixed markers, shows its raw source in one bare <pre> and is never parsed; siblings stay mounted.
  it.each([
    { kind: 'list', text: list(MAX_NESTING + 1) },
    { kind: 'quote', text: quote(MAX_NESTING + 1) },
    { kind: 'same-line list', text: sameLine(MAX_NESTING + 1) },
    { kind: 'quote and list', text: `intro\n\n${'> - '.repeat(Math.ceil((MAX_NESTING + 1) / 2))}x` },
  ])('a $kind one past the cap falls back to the raw source without parsing', ({ text }) => {
    const { host, sibling } = mount(text);
    expect(sibling?.textContent).toBe('sibling');
    expect([...host.children].map((c) => c.tagName)).toEqual(['PRE']);
    expect(host.firstElementChild!.attributes).toHaveLength(0);
    expect(host.textContent).toBe(text);
    expect(parses.count, 'the markdown pipeline never ran').toBe(0);
  });

  // Pins: a document nested exactly to the cap renders as markdown.
  it('a list at the cap renders as nested lists', () => {
    const { host } = mount(list(MAX_NESTING));
    expect(host.querySelector(':scope > pre'), 'no fallback').toBeNull();
    expect(host.querySelectorAll('ul')).toHaveLength(MAX_NESTING);
    expect(parses.count).toBeGreaterThan(0);
  });

  // Pins: a quote at the cap renders as nested quotes.
  it('a quote at the cap renders as nested quotes', () => {
    const { host } = mount(quote(MAX_NESTING));
    expect(host.querySelector(':scope > pre'), 'no fallback').toBeNull();
    expect(host.querySelectorAll('blockquote')).toHaveLength(MAX_NESTING);
  });

  // Pins: deeply indented code is not nesting: it renders as a code block.
  it('a code block indented far past the cap renders normally', () => {
    const { host } = mount(`\`\`\`\n${' '.repeat(8 * MAX_NESTING)}deep();\n\`\`\``);
    expect(host.querySelector('.md-code-wrap pre code')!.textContent).toBe(`${' '.repeat(8 * MAX_NESTING)}deep();`);
  });
});
