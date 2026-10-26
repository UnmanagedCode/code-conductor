// The app's policy for `#…` links in markdown: a link naming a cc view opens it in the same tab with one history
// entry; any other `#…` link renders as literal text; every other link is unchanged.
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Markdown } from './Markdown';
import { routeStore, syncRoute } from '@/state/route';
import { clickLink } from '@/test/linkClick';

const ANCHOR = '#session=sess-1';

beforeEach(() => {
  history.replaceState(null, '', `/${ANCHOR}`);
  syncRoute();
});
afterEach(() => { cleanup(); });

const view = () => routeStore.get().route;
const para = (c: HTMLElement) => c.querySelector('p') as HTMLElement;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

const ROUTED: { href: string; view: string; path?: string }[] = [
  { href: '#plugin/code-review/?review=r-9&thread=t-7', view: 'plugin', path: '?review=r-9&thread=t-7' },
  { href: '#plugin/code-review/files/a.ts', view: 'plugin', path: 'files/a.ts' },
  { href: '#plugin/code-review', view: 'plugin', path: '' },
  { href: '#settings', view: 'settings' },
  { href: '#settings/models', view: 'settings' },
  { href: '#costs', view: 'costs' },
];

describe('view links in markdown', () => {
  for (const { href, view: v, path } of ROUTED) {
    // Pins: a link naming a cc view is a same-tab link whose href is the source, and a primary click opens it with one history entry.
    it(`${href} opens in the same tab and pushes one history entry`, async () => {
      render(<Markdown text={`[Open](${href})`} />);
      const a = screen.getByRole('link', { name: 'Open' });
      expect(a.getAttribute('href')).toBe(href);
      expect(a.hasAttribute('target')).toBe(false);
      expect(a.hasAttribute('rel')).toBe(false);
      const before = history.length;
      expect(clickLink(a), 'the click is handled in-app').toBe(true);
      expect(view().view).toBe(v);
      if (v === 'plugin') {
        expect(view().pluginId).toBe('code-review');
        expect(view().pluginPath).toBe(path);
      }
      expect(history.length).toBe(before + 1);
      history.back();
      await settle();
      expect(location.hash).toBe(ANCHOR);
      expect(view().view).toBe('session');
    });
  }

  // Pins: a click the browser owns (modifier, non-primary button) is left alone.
  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])('a click with %j is not handled in-app', (init) => {
    render(<Markdown text="[Open](#costs)" />);
    expect(clickLink(screen.getByRole('link', { name: 'Open' }), init)).toBe(false);
    expect(view().view).toBe('session');
  });

  const LITERAL = [
    '#foo', '#', '#session=abc', '#review', '#commits', '#plugin/', '#plugin//x', '#plugin/%E0/',
    '#plugin/code-review/../../api/projects', '#plugin/code-review/%2e%2e/%2e%2e/api', '#plugin/code-review/..\\..\\api',
    '#plugin/..%2F..%2Fapi/', '#plugin/a%3Fb/', '#pluginx',
  ];
  for (const href of LITERAL) {
    // Pins: a `#…` link that names no linkable view renders as the renderer's literal-text form, never a live anchor.
    it(`${href} renders as literal text`, () => {
      const { container } = render(<Markdown text={`[x](${href})`} />);
      expect(container.querySelector('a')).toBeNull();
      expect(para(container).textContent).toBe(`[x](${href})`);
    });
  }

  // Pins: schemes the renderer refuses stay literal.
  it.each(['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'vbscript:x'])('%s stays literal', (href) => {
    const { container } = render(<Markdown text={`[x](${href})`} />);
    expect(container.querySelector('a')).toBeNull();
  });

  // Pins: external links keep a new-tab anchor and are not handled in-app.
  it.each([
    { text: '[x](https://example.com/x)', href: 'https://example.com/x' },
    { text: 'https://example.com', href: 'https://example.com' },
    { text: '[m](mailto:a@b.c)', href: 'mailto:a@b.c' },
    { text: '[r](/plugins/code-review/)', href: '/plugins/code-review/' },
  ])('$href keeps its new-tab anchor', ({ text, href }) => {
    const { container } = render(<Markdown text={text} />);
    const a = container.querySelector('a')!;
    expect(a.getAttribute('href')).toBe(href);
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(clickLink(a)).toBe(false);
    expect(view().view).toBe('session');
  });
});
