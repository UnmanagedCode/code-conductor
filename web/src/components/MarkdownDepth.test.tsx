// Markdown's nesting cap (COMPLEXITY_LIMITS.nesting): micromark's parse cost grows with characters × open-container
// depth, so a document nested past it (lists or quotes) shows its raw source without ever being parsed, and one at the cap renders.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from './Markdown';
import { COMPLEXITY_LIMITS, measureComplexity } from './markdown/complexity';

const MAX_NESTING = COMPLEXITY_LIMITS.nesting;
const nestingDepth = (text: string) => measureComplexity(text).nesting;

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
  ])('a line after a $kind is measured', ({ text }) => {
    expect(nestingDepth(text)).toBe(5);
  });

  const deep = sameLine(40);
  // Pins: fenced code content is not nesting: a backtick or tilde fence, closed or running to the end, hides its lines;
  // a fence in a list item or quote measures only that container's own level.
  it.each([
    { kind: 'backtick fence', text: `\`\`\`\n${deep}\n\`\`\`` },
    { kind: 'tilde fence with info', text: `~~~yaml\n${deep}\n~~~` },
    { kind: 'unclosed fence', text: `intro\n\n\`\`\`\n${deep}` },
    { kind: 'shorter run does not close', text: `\`\`\`\`\n\`\`\`\n${deep}\n\`\`\`\`` },
    { kind: 'other character does not close', text: `\`\`\`\n~~~\n${deep}` },
    { kind: 'fence in a list item', text: `- step\n  \`\`\`\n  ${deep}\n  \`\`\``, depth: 1 },
    { kind: 'fence in a quote', text: `> \`\`\`\n> ${deep}\n> \`\`\``, depth: 1 },
    { kind: 'YAML list 17 levels deep', text: `\`\`\`yaml\n${Array.from({ length: 17 }, (_, i) => `${'    '.repeat(i)}- k${i}:`).join('\n')}\n\`\`\`` },
  ])('$kind measures only its container', ({ text, depth = 0 }) => {
    expect(nestingDepth(text)).toBe(depth);
  });

  // Pins: a line micromark does not read as a fence, or a fence micromark has already ended, hides nothing.
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

  // Pins: list markers inside fenced code never trip the cap: the fence renders as a code block holding its exact text.
  it.each([
    { kind: 'a YAML list 17 levels deep (4-space indents)', code: Array.from({ length: 17 }, (_, i) => `${'    '.repeat(i)}- k${i}:`).join('\n') },
    { kind: '40 same-line list markers', code: sameLine(40) },
  ])('a fence holding $kind renders as code', ({ code }) => {
    const { host } = mount(`Config:\n\n\`\`\`yaml\n${code}\n\`\`\``);
    expect(host.querySelector(':scope > pre'), 'no fallback').toBeNull();
    expect(host.querySelector('.md-code-wrap > pre > code')!.textContent).toBe(code);
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

describe('the measure bounds the parsed nesting', () => {
  /** The deepest chain of nested lists and quotes the render holds. */
  const parsedDepth = (host: Element) => Math.max(0, ...[...host.querySelectorAll('li, blockquote')].map((el) => {
    let d = 0;
    for (let e: Element | null = el; e && e !== host; e = e.parentElement) if (e.matches('ul, ol, blockquote')) d++;
    return d;
  }));
  const nested = '- a\n  - b\n    - c';
  // Pins: for tabs, every line ending, a BOM, and every way a fence-looking line is not (or no longer) a fence, the measure is never below the depth micromark parses.
  it.each([
    ' \t- a\n\t\t- b\n\t\t\t- c',
    '-\t- a\n \t  - b',
    '>\t> a\n>\t>\t- b',
    nested.replaceAll('\n', '\r'),
    nested.replaceAll('\n', '\r\n'),
    `\uFEFF${nested}`,
    `\`\`\`\nx\n\`\`\`\n${nested}`,
    `> \`\`\`\n${nested}`,
    `- \`\`\`\n${nested}`,
    `1. \`\`\`\n  ${nested}`,
    `<div>\n\`\`\`\n\n${nested}`,
    `<!--\n\n\`\`\`\n-->\n${nested}`,
    `<script>\n\n\`\`\`\n</script>\n${nested}`,
    `[a]: /u "\n\`\`\`\n"\n${nested}`,
    `\`\`\`\` x\n\`\`\`\n\`\`\`\`\n${nested}`,
    `\`\`\` a\`b\n${nested}`,
  ])('%j', (text) => {
    const { host } = mount(text);
    expect(host.querySelector(':scope > pre'), 'fixture check: the text renders').toBeNull();
    expect(nestingDepth(text)).toBeGreaterThanOrEqual(parsedDepth(host));
  });
});
