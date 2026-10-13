import { describe, expect, it } from 'vitest';
import { installExternalLinkOpener, toIntentUrl } from './externalLinks';

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

/** A fresh document plus a fake window: display mode, user agent, window.open and location writes recorded. */
function setup({ standalone, android = false }: { standalone: boolean; android?: boolean }) {
  const doc = document.implementation.createHTMLDocument('t');
  const opened: unknown[][] = [];
  const navigations: string[] = [];
  const win = {
    matchMedia: (q: string) => ({ matches: q === '(display-mode: standalone)' ? standalone : false }),
    navigator: { userAgent: android ? ANDROID_UA : DESKTOP_UA },
    open: (...args: unknown[]) => { opened.push(args); return {}; },
    location: { get href() { return 'http://localhost/'; }, set href(v: string) { navigations.push(v); } },
  } as unknown as Window;
  return { doc, win, opened, navigations };
}

function click(doc: Document, href: string, { target = '_blank', ctrlKey = false } = {}) {
  const a = doc.createElement('a');
  a.setAttribute('href', href);
  if (target) a.setAttribute('target', target);
  doc.body.appendChild(a);
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey });
  a.dispatchEvent(ev);
  return ev;
}

describe('external links in the installed PWA', () => {
  it('routes target=_blank through an intent: URL on Android, after beforeNavigate', () => {
    const { doc, win, navigations } = setup({ standalone: true, android: true });
    const seen: string[] = [];
    installExternalLinkOpener({ doc, win, beforeNavigate: (u) => { expect(navigations).toHaveLength(0); seen.push(u.href); } });
    const ev = click(doc, 'https://example.com/p?q=1');
    expect(ev.defaultPrevented).toBe(true);
    expect(seen).toEqual(['https://example.com/p?q=1']);
    expect(navigations).toHaveLength(1);
    expect(navigations[0]).toMatch(/^intent:\/\/example\.com\/p\?q=1#Intent;scheme=https;package=com\.android\.chrome;end$/);
  });

  it('uses window.open off Android, and for mailto: on Android', () => {
    const a = setup({ standalone: true });
    installExternalLinkOpener({ doc: a.doc, win: a.win });
    click(a.doc, 'https://example.com/');
    expect(a.opened[0]).toEqual(['https://example.com/', '_blank', 'noopener,noreferrer']);
    const b = setup({ standalone: true, android: true });
    installExternalLinkOpener({ doc: b.doc, win: b.win });
    click(b.doc, 'mailto:x@example.com');
    expect(b.opened).toHaveLength(1);
    expect(b.navigations).toHaveLength(0);
  });

  it('leaves the browser tab, modifier clicks, non-_blank links and unsafe schemes alone', () => {
    const tab = setup({ standalone: false, android: true });
    let hooked = 0;
    installExternalLinkOpener({ doc: tab.doc, win: tab.win, beforeNavigate: () => hooked++ });
    expect(click(tab.doc, 'https://example.com/').defaultPrevented).toBe(false);
    expect(hooked).toBe(0);

    const pwa = setup({ standalone: true, android: true });
    installExternalLinkOpener({ doc: pwa.doc, win: pwa.win });
    expect(click(pwa.doc, 'https://example.com/', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(click(pwa.doc, 'https://example.com/', { target: '' }).defaultPrevented).toBe(false);
    expect(click(pwa.doc, 'javascript:alert(1)').defaultPrevented).toBe(false);
    expect(pwa.navigations).toEqual([]);
  });

  it('still navigates when beforeNavigate throws', () => {
    const { doc, win, navigations } = setup({ standalone: true, android: true });
    installExternalLinkOpener({ doc, win, beforeNavigate: () => { throw new Error('boom'); } });
    expect(click(doc, 'https://example.com/').defaultPrevented).toBe(true);
    expect(navigations).toHaveLength(1);
  });

  it('toIntentUrl keeps host, port, path, query and hash', () => {
    expect(toIntentUrl(new URL('http://127.0.0.1:8765/r/path?x=1#f')))
      .toBe('intent://127.0.0.1:8765/r/path?x=1#f#Intent;scheme=http;package=com.android.chrome;end');
  });
});
