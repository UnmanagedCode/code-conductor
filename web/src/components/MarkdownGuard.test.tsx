// Markdown's parse guard (markdown/guard.ts): a document past MAX_SIZE characters, or nested past MAX_NESTING by a
// blind count of every line's container markers, shows its raw source without ever being parsed; one at either limit renders.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from './Markdown';
import { MAX_NESTING, MAX_SIZE, nestingDepth } from './markdown/guard';

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
  // Pins: a line's measure is its quote and list markers (several on one line too; a marker followed by a space, a tab
  // or the line's end) plus half the extra indentation columns before them (a marker's own following space excluded;
  // a tab advances to the next 4-column stop); the document's is its deepest line.
  it.each([
    { text: 'plain text', depth: 0 },
    { text: '- a', depth: 1 },
    { text: list(5), depth: 5 },
    { text: quote(7), depth: 7 },
    { text: sameLine(4), depth: 4 },
    { text: '> - > 1. x', depth: 4 },
    { text: mixed(6), depth: 6 },
    { text: '\t- x', depth: 3 },
    { text: '  \t- a', depth: 3 },
    { text: '- - - -', depth: 4 },
    { text: '-', depth: 1 },
    { text: '-\n', depth: 1 },
    { text: '1.\n2)', depth: 1 },
  ])('$text measures $depth', ({ text, depth }) => {
    expect(nestingDepth(text)).toBe(depth);
  });

  // Pins: a run of one marker character with no break after it is not a container: a 40-`*` or 40-`-` line is a rule,
  // `**bold**` is emphasis, `1.x` / `1)x` are text.
  it.each(['*'.repeat(40), '-'.repeat(40), '**bold**', '*x*', '1.x', '1)x', '12.x and more'])('%s measures 0', (text) => {
    expect(nestingDepth(text)).toBe(0);
  });

  // Pins: micromark's line endings (\n, \r\n and a lone \r) all end a line, and a leading BOM is not content.
  it.each([
    { kind: 'lone CR', text: `x\r${sameLine(5)}` },
    { kind: 'CRLF', text: `x\r\n${sameLine(5)}` },
    { kind: 'BOM', text: `\uFEFF${sameLine(5)}` },
    { kind: 'CR between nested lines', text: list(5).replaceAll('\n', '\r') },
    { kind: 'CRLF between nested lines', text: list(5).replaceAll('\n', '\r\n') },
  ])('a line after a $kind is measured', ({ text }) => {
    expect(nestingDepth(text)).toBe(5);
  });

  const deep = sameLine(40);
  // Pins: the count is blind to fenced code: a fence's lines count like any others, whatever the fence.
  it.each([
    { kind: 'backtick fence', text: `\`\`\`\n${deep}\n\`\`\``, depth: 40 },
    { kind: 'tilde fence with info', text: `~~~yaml\n${deep}\n~~~`, depth: 40 },
    { kind: 'unclosed fence', text: `intro\n\n\`\`\`\n${deep}`, depth: 40 },
    { kind: 'shorter run does not close', text: `\`\`\`\`\n\`\`\`\n${deep}\n\`\`\`\``, depth: 40 },
    { kind: 'other character does not close', text: `\`\`\`\n~~~\n${deep}`, depth: 40 },
    { kind: 'fence in a list item', text: `- step\n  \`\`\`\n  ${deep}\n  \`\`\``, depth: 41 },
    { kind: 'fence in a quote', text: `> \`\`\`\n> ${deep}\n> \`\`\``, depth: 41 },
    { kind: 'YAML list 17 levels deep', text: `\`\`\`yaml\n${Array.from({ length: 17 }, (_, i) => `${'    '.repeat(i)}- k${i}:`).join('\n')}\n\`\`\``, depth: 33 },
  ])('$kind is counted like any other line', ({ text, depth }) => {
    expect(nestingDepth(text)).toBe(depth);
  });

  // Pins: no fence-like or HTML-like line hides what follows it.
  it.each([
    { kind: 'after a closed fence', text: `\`\`\`\nx\n\`\`\`\n${deep}` },
    { kind: 'backtick info string holding a backtick', text: `\`\`\` a\`b\n${deep}` },
    { kind: 'fence indented 4 spaces (indented code)', text: `    \`\`\`\n${deep}` },
    { kind: 'fence in a quote the next line leaves', text: `> \`\`\`\n${deep}` },
    { kind: 'fence in a list item the next line leaves', text: `- \`\`\`\n${deep}` },
    { kind: 'fence line inside an HTML block', text: `<div>\n\`\`\`\n\n${deep}` },
    { kind: 'fence line inside an HTML comment', text: `<!--\n\n\`\`\`\n-->\n${deep}` },
  ])('$kind: the content is measured', ({ text }) => {
    expect(nestingDepth(text)).toBe(40);
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

  // Pins: a line ending or BOM micromark honours cannot hide nesting from the cap: one past it still falls back unparsed.
  it.each([
    { kind: 'lone CR', text: `x\r${sameLine(MAX_NESTING + 1)}` },
    { kind: 'CRLF', text: `x\r\n${sameLine(MAX_NESTING + 1)}` },
    { kind: 'BOM', text: `\uFEFF${sameLine(MAX_NESTING + 1)}` },
  ])('after a $kind, one past the cap falls back without parsing', ({ text }) => {
    const { host } = mount(text);
    expect([...host.children].map((c) => c.tagName)).toEqual(['PRE']);
    expect(host.textContent).toBe(text);
    expect(parses.count, 'the markdown pipeline never ran').toBe(0);
  });

  // Pins: list markers inside fenced code count too (the accepted trade-off): a fence nesting past the cap falls back unparsed.
  it.each([
    { kind: 'a YAML list 17 levels deep (4-space indents)', code: Array.from({ length: 17 }, (_, i) => `${'    '.repeat(i)}- k${i}:`).join('\n') },
    { kind: '40 same-line list markers', code: sameLine(40) },
  ])('a fence holding $kind falls back without parsing', ({ code }) => {
    const text = `Config:\n\n\`\`\`yaml\n${code}\n\`\`\``;
    const { host } = mount(text);
    expect([...host.children].map((c) => c.tagName)).toEqual(['PRE']);
    expect(host.textContent).toBe(text);
    expect(parses.count, 'the markdown pipeline never ran').toBe(0);
  });

  // Pins: the reviewers' reproducers (a CR or BOM before deep markers; an indented fence closed at a smaller indent, or
  // an HTML block inside a quote, before deep markers) are refused without parsing.
  it.each([
    { kind: 'lone CR', text: `x\r${'- '.repeat(4000)}x` },
    { kind: 'BOM', text: `\uFEFF${'- '.repeat(2000)}x` },
    { kind: 'indented fence', text: `   \`\`\`\n   x\n\`\`\`\n${list(40)}` },
    { kind: 'HTML block in a quote', text: `> <!A\n> x\n> \`\`\`\n> >\n> ${'- '.repeat(4000)}x` },
  ])('the $kind reproducer falls back without parsing', ({ text }) => {
    const { host } = mount(text);
    expect([...host.children].map((c) => c.tagName)).toEqual(['PRE']);
    expect(host.textContent).toBe(text);
    expect(parses.count, 'the markdown pipeline never ran').toBe(0);
  });

  // Pins: a line of 40 `*` is a thematic break, rendered as <hr>, not a fallback.
  it('a 40-`*` line renders a rule', () => {
    const { host } = mount(`above\n\n${'*'.repeat(40)}\n\nbelow`);
    expect(host.querySelector(':scope > pre'), 'no fallback').toBeNull();
    expect(host.querySelectorAll(':scope > hr')).toHaveLength(1);
  });

  // Pins: deeply indented code is not nesting: it renders as a code block.
  it('a code block indented far past the cap renders normally', () => {
    const { host } = mount(`\`\`\`\n${' '.repeat(8 * MAX_NESTING)}deep();\n\`\`\``);
    expect(host.querySelector('.md-code-wrap pre code')!.textContent).toBe(`${' '.repeat(8 * MAX_NESTING)}deep();`);
  });
});

describe('the size limit', () => {
  // Pins: a document of exactly MAX_SIZE characters renders as markdown.
  it('at the limit the document renders', () => {
    const { host } = mount('x'.repeat(MAX_SIZE));
    expect(host.querySelector(':scope > p'), 'no fallback').toBeTruthy();
    expect(parses.count).toBeGreaterThan(0);
  });

  // Pins: one character past MAX_SIZE shows the raw source in one bare <pre> and never reaches react-markdown.
  it('one past the limit falls back without parsing', () => {
    const text = 'x'.repeat(MAX_SIZE + 1);
    const { host, sibling } = mount(text);
    expect(sibling?.textContent).toBe('sibling');
    expect([...host.children].map((c) => c.tagName)).toEqual(['PRE']);
    expect(host.textContent).toBe(text);
    expect(parses.count, 'the markdown pipeline never ran').toBe(0);
  });
});
