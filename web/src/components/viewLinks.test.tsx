// The app's policy for links to cc in markdown (`http://cc.internal/#<view>`, cc's own page, a bare `#…`): a link
// naming a cc view opens it in the same tab with one history entry; any other link cc owns renders as literal text;
// every other link is unchanged.
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
  const FORMS = ROUTED.flatMap((r) => [{ ...r, source: r.href }, { ...r, source: `http://cc.internal/${r.href}` }]);
  for (const { href, source, view: v, path } of FORMS) {
    // Pins: a link to cc naming a view (bare or `http://cc.internal/`) is a same-tab link whose href is the in-app hash, and a primary click opens it with one history entry.
    it(`${source} opens in the same tab and pushes one history entry`, async () => {
      render(<Markdown text={`[Open](${source})`} />);
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

  // Pins: a modified or non-primary click on an adopted cc.internal link stays the browser's (which opens the rewritten in-app hash).
  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])('a click with %j on a cc.internal link is not handled in-app', (init) => {
    render(<Markdown text="[Open](http://cc.internal/#costs)" />);
    const a = screen.getByRole('link', { name: 'Open' });
    expect(a.getAttribute('href'), 'adopted').toBe('#costs');
    expect(clickLink(a, init)).toBe(false);
    expect(view().view).toBe('session');
  });

  // Pins: the scheme may be http or https and the host is compared after URL normalization (case, default port, empty path); a URL on cc's own page is in-app too.
  it.each([
    () => 'https://cc.internal/#costs',
    () => 'http://cc.internal#costs',
    () => 'HTTP://CC.INTERNAL/#costs',
    () => 'http://cc.internal:80/#costs',
    () => `${location.origin}/#costs`,
  ])('accepted spelling %#', (spelling) => {
    const source = spelling();
    render(<Markdown text={`[Open](${source})`} />);
    const a = screen.getByRole('link', { name: 'Open' });
    expect(a.getAttribute('href'), source).toBe('#costs');
    expect(a.hasAttribute('target')).toBe(false);
    expect(a.hasAttribute('rel')).toBe(false);
    expect(clickLink(a), 'the click is handled in-app').toBe(true);
    expect(view().view).toBe('costs');
  });

  // Pins: a bare autolinked cc.internal URL is handled like the explicit link, trailing punctuation left as text.
  it('an autolinked cc.internal URL opens its view in-app', () => {
    const { container } = render(<Markdown text="see http://CC.Internal/#plugin/code-review/?review=r-9." />);
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('#plugin/code-review/?review=r-9');
    expect(para(container).textContent).toBe('see http://CC.Internal/#plugin/code-review/?review=r-9.');
    expect(clickLink(links[0]), 'the click is handled in-app').toBe(true);
    expect(view()).toMatchObject({ view: 'plugin', pluginId: 'code-review', pluginPath: '?review=r-9' });
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

  const CC_LITERAL = [
    'http://cc.internal/', 'http://cc.internal/#foo', 'http://cc.internal/#session=s', 'http://cc.internal/#review',
    'http://cc.internal/#commits', 'http://cc.internal/x#costs', 'http://cc.internal/?a=1#costs', 'http://u@cc.internal/#costs',
    'http://u:p@cc.internal/#costs', 'http://cc.internal/#plugin/code-review/../../api/projects',
    '//cc.internal/#nope', '//cc.internal/x#costs',
  ];
  for (const href of CC_LITERAL) {
    // Pins: a cc.internal link that names no view, has a non-root path or a search, or carries userinfo is literal text, never a live
    // anchor, however it is spelled (protocol-relative included).
    it(`${href} renders as literal text`, () => {
      const { container } = render(<Markdown text={`[x](${href})`} />);
      expect(container.querySelector('a')).toBeNull();
      expect(para(container).textContent).toBe(`[x](${href})`);
    });
  }

  // Pins: the literal form of a rejected autolinked cc.internal URL is the bare URL, not `[url](url)`.
  it('an autolinked rejected cc.internal URL renders as its bare text', () => {
    const { container } = render(<Markdown text="go http://cc.internal/x#costs now" />);
    expect(container.querySelector('a')).toBeNull();
    expect(para(container).textContent).toBe('go http://cc.internal/x#costs now');
  });

  // Pins: schemes the renderer refuses stay literal.
  it.each(['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'vbscript:x'])('%s stays literal', (href) => {
    const { container } = render(<Markdown text={`[x](${href})`} />);
    expect(container.querySelector('a')).toBeNull();
  });

  // Pins: external links keep a new-tab anchor and are not handled in-app; only an exact cc.internal host, or cc's own page without
  // userinfo, is cc's — a suffix, prefix, userinfo, query, trailing-dot or port lookalike is not.
  it.each([
    { text: '[x](https://example.com/x)', href: 'https://example.com/x' },
    { text: 'https://example.com', href: 'https://example.com' },
    { text: '[m](mailto:a@b.c)', href: 'mailto:a@b.c' },
    { text: '[r](/plugins/code-review/)', href: '/plugins/code-review/' },
    { text: '[x](http://cc.internal.evil.com/#costs)', href: 'http://cc.internal.evil.com/#costs' },
    { text: '[x](http://evil.com/#costs)', href: 'http://evil.com/#costs' },
    { text: '[x](http://cc.internal@evil.com/#costs)', href: 'http://cc.internal@evil.com/#costs' },
    { text: '[x](http://evil.com/?h=cc.internal#costs)', href: 'http://evil.com/?h=cc.internal#costs' },
    { text: '[x](http://cc.internal./#costs)', href: 'http://cc.internal./#costs' },
    { text: '[x](http://cc.internal:8080/#costs)', href: 'http://cc.internal:8080/#costs' },
    { text: '[x](http://evilcc.internal/#costs)', href: 'http://evilcc.internal/#costs' },
    { text: '[x](http://xcc.internal/#costs)', href: 'http://xcc.internal/#costs' },
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

describe('links on cc\'s own origin that are not its page', () => {
  // Pins: another path on cc's origin, or cc's page with userinfo, is not cc's page and keeps its new-tab anchor; the own-page rule
  // compares the full origin, so the other scheme on cc's host, or cc's hostname on another port, is not cc's page either.
  it.each([
    () => `${location.origin}/plugins/code-review/#costs`,
    () => `http://u@${location.host}/#costs`,
    () => `${location.protocol === 'http:' ? 'https:' : 'http:'}//${location.host}/#costs`,
    () => `${location.protocol}//${location.hostname}:${location.port === '1' ? '2' : '1'}/#costs`,
  ])('own-origin lookalike %# keeps its new-tab anchor', (build) => {
    const href = build();
    const { container } = render(<Markdown text={`[x](${href})`} />);
    const a = container.querySelector('a')!;
    expect(a.getAttribute('href'), href).toBe(href);
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(clickLink(a)).toBe(false);
    expect(view().view).toBe('session');
  });
});
