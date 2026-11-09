// <Markdown> is total: whatever its text, a render-time throw anywhere in the markdown pipeline (parser, plugins,
// component overrides, a stack overflow on deep nesting) leaves the rest of the page mounted and shows the raw
// source instead of a blank block.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from './Markdown';

// The mock passes through to the real module unless a test arms it; vi.mock is file-wide.
const inject = vi.hoisted(() => ({ throws: false }));
vi.mock('react-markdown', async (importOriginal) => {
  const real = await importOriginal<typeof import('react-markdown')>();
  const Wrapped = (props: Parameters<typeof real.default>[0]) => {
    if (inject.throws) throw new Error('injected markdown failure');
    return real.default(props);
  };
  return { ...real, default: Wrapped };
});

afterEach(() => {
  inject.throws = false;
  vi.restoreAllMocks();
});

/** Renders `text` beside a sibling; returns both. */
function mountBeside(text: string) {
  const { container } = render(<div><p data-sibling>sibling</p><Markdown text={text} /></div>);
  return { host: container.querySelector('.md') as HTMLElement, sibling: () => container.querySelector('[data-sibling]') };
}

describe('a markdown pipeline that throws', () => {
  // Pins: a throw inside the markdown render is contained by Markdown: siblings stay mounted and the host holds exactly one bare <pre> of the raw source.
  it('falls back to one <pre> holding the raw text and leaves siblings mounted', () => {
    inject.throws = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { host, sibling } = mountBeside('raw *text*');
    expect(sibling()?.textContent, 'the sibling is still mounted').toBe('sibling');
    expect(host, 'the markdown host is still mounted').toBeTruthy();
    expect([...host.children].map((c) => c.tagName)).toEqual(['PRE']);
    expect(host.firstElementChild!.attributes).toHaveLength(0);
    expect(host.textContent).toBe('raw *text*');
    expect(error, 'React reports the caught error').toHaveBeenCalled();
  });

  // Pins: the fallback is per text: once the text changes, the renderer tries again.
  it('retries when the text changes', () => {
    inject.throws = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container, rerender } = render(<Markdown text="first *one*" />);
    expect(container.querySelector('.md > pre')?.textContent).toBe('first *one*');
    inject.throws = false;
    rerender(<Markdown text="second *two*" />);
    expect(container.querySelector('.md > pre'), 'no fallback once rendering succeeds').toBeNull();
    expect(container.querySelector('.md em')?.textContent).toBe('two');
  });
});

describe('deeply nested input through the real pipeline', () => {
  // The quote, list and emphasis cases are past the complexity budget (MarkdownBudget.test.tsx), so they show the raw
  // source without parsing; the brackets parse. A line of only `*` would be a rule, hence the `x`.
  const CASES = [
    { kind: 'blockquote', text: `${'>'.repeat(10_000)} x` },
    { kind: 'list', text: Array.from({ length: 200 }, (_, i) => `${'  '.repeat(i)}- x`).join('\n') },
    { kind: 'brackets', text: '['.repeat(50_000) },
    { kind: 'emphasis', text: `${'*'.repeat(5_000)}x${'*'.repeat(5_000)}` },
  ];
  // Pins: deep nesting never unmounts the page or blanks the block: the host shows the render or, on a throw, the raw-source <pre>.
  it.each(CASES)('$kind nesting leaves siblings mounted and the host non-empty', ({ text }) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { host, sibling } = mountBeside(text);
    expect(sibling()?.textContent, 'the sibling is still mounted').toBe('sibling');
    expect(host, 'the markdown host is still mounted').toBeTruthy();
    expect(host.textContent!.trim().length, 'the host is not blank').toBeGreaterThan(0);
    const fellBack = host.children.length === 1 && host.firstElementChild!.tagName === 'PRE' && host.textContent === text;
    // A fallback comes from the boundary (an error reported) or from the nesting cap (nothing parsed, nothing reported).
    if (error.mock.calls.length > 0) expect(fellBack, 'a reported error leaves the raw-source fallback').toBe(true);
  });
});
