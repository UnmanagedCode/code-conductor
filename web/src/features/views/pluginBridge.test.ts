// The bridge runs inside plugin frames as a classic script; drive it against a scripted fake window.
// Plugin pages load the root /pluginBridge.js, served from this directory's pluginBridge.js.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { observerTurn, runBridge } from './test/bridge';

afterEach(() => { vi.unstubAllGlobals(); });

describe('pluginBridge.js', () => {
  it('is a no-op standalone and outside a /plugins mount, theme included', () => {
    const hostRoot = document.createElement('html');
    hostRoot.classList.add('dark');
    hostRoot.setAttribute('data-cc-session-width', '896px');
    for (const opts of [{ top: true }, { pathname: '/elsewhere' }]) {
      const b = runBridge({ ...opts, hostRoot });
      b.contentLoaded();
      expect(b.posted).toEqual([]);
      expect(b.frameRoot.classList.contains('dark')).toBe(false);
      expect(b.frameRoot.hasAttribute('data-cc-theme')).toBe(false);
      expect(b.frameRoot.style.getPropertyValue('--cc-session-width')).toBe('');
      expect(b.win.ccBridge, 'no ccBridge outside an embed').toBeUndefined();
    }
  });

  it('announces ready and the initial route', () => {
    const b = runBridge();
    expect(b.posted, 'nothing before DOMContentLoaded').toEqual([]);
    b.contentLoaded();
    expect(b.posted).toEqual([[{ cc: 1, type: 'ready' }, 'http://h'], [{ cc: 1, type: 'route', path: '/a?q=1' }, 'http://h']]);
  });

  it('demotes pushState to replaceState and reports the route', () => {
    const { posted, win, hist } = runBridge();
    win.history.pushState(null, '', '/plugins/hub/b');
    expect(hist.replaced.at(-1)).toBe('/plugins/hub/b');
    expect(posted.at(-1)[0]).toEqual({ cc: 1, type: 'route', path: '/b?q=1' });
  });

  it('a navigate message replaces state and synthesises popstate; a foreign origin is ignored', () => {
    const b = runBridge();
    const { listeners, hist } = b;
    const before = hist.replaced.length;
    for (const f of listeners.message) f({ origin: 'http://evil', data: { cc: 1, type: 'navigate', path: '/x' } });
    expect(hist.replaced.length).toBe(before);
    let popped = 0;
    (listeners.popstate ??= []).push(() => popped++);
    for (const f of listeners.message) f({ origin: 'http://h', source: b.win.parent, data: { cc: 1, type: 'navigate', path: '/x' } });
    expect(hist.replaced.at(-1)).toBe('/plugins/hub/x');
    expect(popped).toBeGreaterThan(0);
  });

  describe('theme', () => {
    it("applies the host's theme at script execution, before DOMContentLoaded", () => {
      // Invariant: the frame's theme equals the host's synchronously at execution, in both directions.
      const dark = document.createElement('html');
      dark.classList.add('dark');
      const b = runBridge({ hostRoot: dark });
      expect(b.docListeners.DOMContentLoaded?.length, 'precondition: DOMContentLoaded has not fired').toBe(1);
      expect(b.posted).toEqual([]);
      expect(b.frameRoot.classList.contains('dark')).toBe(true);
      expect(b.frameRoot.getAttribute('data-cc-theme')).toBe('dark');

      const light = runBridge({ hostRoot: document.createElement('html'), frameSetup: (root) => root.classList.add('dark') });
      expect(light.frameRoot.classList.contains('dark'), 'a stale .dark on the frame is removed').toBe(false);
      expect(light.frameRoot.getAttribute('data-cc-theme')).toBe('light');
    });

    it('follows every host theme change', async () => {
      // Invariant: every host class change reaches the frame.
      const b = runBridge();
      expect(b.frameRoot.getAttribute('data-cc-theme')).toBe('light');
      b.hostRoot.classList.add('dark');
      await observerTurn();
      expect(b.frameRoot.classList.contains('dark')).toBe(true);
      expect(b.frameRoot.getAttribute('data-cc-theme')).toBe('dark');
      b.hostRoot.classList.remove('dark');
      await observerTurn();
      expect(b.frameRoot.classList.contains('dark')).toBe(false);
      expect(b.frameRoot.getAttribute('data-cc-theme')).toBe('light');
    });

    it("a 'system' choice follows prefers-color-scheme into the frame", async () => {
      // Invariant: the host's own theme module and the bridge compose — the `.dark`-on-<html> contract holds end to end.
      const changeListeners: (() => void)[] = [];
      const mq = { matches: false, media: '(prefers-color-scheme: dark)', addEventListener: (_t: string, f: () => void) => changeListeners.push(f), removeEventListener() {} };
      vi.stubGlobal('matchMedia', () => mq);
      const root = document.documentElement;
      try {
        vi.resetModules();
        const { setTheme } = await import('@/app/theme');
        setTheme('system');
        const b = runBridge({ hostRoot: root });
        expect(b.frameRoot.getAttribute('data-cc-theme'), 'precondition: system resolves light').toBe('light');
        mq.matches = true;
        for (const f of changeListeners) f();
        await observerTurn();
        expect(b.frameRoot.classList.contains('dark')).toBe(true);
        expect(b.frameRoot.getAttribute('data-cc-theme')).toBe('dark');
        mq.matches = false;
        for (const f of changeListeners) f();
        await observerTurn();
        expect(b.frameRoot.classList.contains('dark')).toBe(false);
        expect(b.frameRoot.getAttribute('data-cc-theme')).toBe('light');
      } finally {
        root.classList.remove('dark');
        localStorage.removeItem('code-conductor:theme');
      }
    });

    it('a parent whose document cannot be read leaves the theme alone, and the rest of the bridge runs', () => {
      // Invariant: a cross-origin parent is ignored, and ready + the initial route are still posted.
      const b = runBridge({ parentThrows: true });
      expect(b.frameRoot.classList.contains('dark')).toBe(false);
      expect(b.frameRoot.hasAttribute('data-cc-theme')).toBe(false);
      expect(b.frameRoot.style.getPropertyValue('--cc-session-width')).toBe('');
      b.contentLoaded();
      expect(b.posted).toEqual([[{ cc: 1, type: 'ready' }, 'http://h'], [{ cc: 1, type: 'route', path: '/a?q=1' }, 'http://h']]);
    });
  });

  describe('session width', () => {
    const WIDTH = '--cc-session-width';
    const hostWith = (w?: string) => {
      const h = document.createElement('html');
      if (w !== undefined) h.setAttribute('data-cc-session-width', w);
      return h;
    };

    it("sets the host's published width at script execution, before DOMContentLoaded", () => {
      // Invariant: the frame carries the host's value synchronously, px and none alike, and an absent attribute clears a stale value.
      for (const w of ['896px', 'none']) {
        const b = runBridge({ hostRoot: hostWith(w) });
        expect(b.docListeners.DOMContentLoaded?.length, 'precondition: DOMContentLoaded has not fired').toBe(1);
        expect(b.frameRoot.style.getPropertyValue(WIDTH)).toBe(w);
      }
      const bare = runBridge({ hostRoot: hostWith(), frameSetup: (r) => r.style.setProperty(WIDTH, '500px') });
      expect(bare.frameRoot.style.getPropertyValue(WIDTH)).toBe('');
    });

    it('follows every host change', async () => {
      // Invariant: each later value the host publishes reaches the frame.
      const host = hostWith('896px');
      const b = runBridge({ hostRoot: host });
      for (const w of ['none', '1024px']) {
        host.setAttribute('data-cc-session-width', w);
        await observerTurn();
        expect(b.frameRoot.style.getPropertyValue(WIDTH)).toBe(w);
      }
    });

    it("the setting composes end to end into the frame, and a live drag is not followed", async () => {
      // Invariant: stored setting -> published attribute -> frame property; only the committed setting is mirrored.
      const root = document.documentElement;
      localStorage.setItem('code-conductor:session-column', JSON.stringify({ width: 896, full: false }));
      try {
        vi.resetModules();
        const { startPluginSessionWidth } = await import('./pluginSessionWidth');
        const { setSessionFull, setSessionWidth, sessionWidthDragStore } = await import('@/app/sessionWidth');
        startPluginSessionWidth();
        const b = runBridge({ hostRoot: root });
        expect(b.frameRoot.style.getPropertyValue(WIDTH)).toBe('896px');
        const step = async (expected: string) => {
          await observerTurn();
          expect(b.frameRoot.style.getPropertyValue(WIDTH)).toBe(expected);
        };
        setSessionFull(true);
        await step('none');
        setSessionWidth(1024);
        await step('none');
        setSessionFull(false);
        await step('1024px');
        sessionWidthDragStore.set({ live: 1500 });
        await step('1024px');
      } finally {
        root.removeAttribute('data-cc-session-width');
        localStorage.clear();
      }
    });
  });
});

describe('window.ccBridge (session awareness)', () => {
  const deliver = (b: ReturnType<typeof runBridge>, data: unknown, origin = 'http://h', source: unknown = b.win.parent) => {
    for (const f of b.listeners.message) f({ origin, source, data });
  };
  const SESSION = { sessionId: 's1', project: 'p', worktree: null };
  const calls = (b: ReturnType<typeof runBridge>, type: string) => b.posted.map(([m]) => m).filter((m) => m.type === type);

  it('exists when embedded, with no session known before the first message', () => {
    // Invariant: a plugin can tell "host never said" (undefined) from "no active session" (null).
    const b = runBridge();
    expect(typeof b.win.ccBridge.openSession).toBe('function');
    expect(typeof b.win.ccBridge.sendPrompt).toBe('function');
    expect(b.win.ccBridge.session).toBeUndefined();
    deliver(b, { cc: 1, type: 'session', session: SESSION });
    expect(b.win.ccBridge.session).toEqual(SESSION);
    deliver(b, { cc: 1, type: 'session', session: null });
    expect(b.win.ccBridge.session).toBeNull();
  });

  it('onSession fires per message, at once when one is known, and stops on unsubscribe', () => {
    // Invariant: a subscriber sees every host session message, a late one sees the current value, and an unsubscribed one sees nothing.
    const b = runBridge();
    const seen: unknown[] = [];
    const off = b.win.ccBridge.onSession((s: unknown) => seen.push(s));
    expect(seen).toEqual([]);
    deliver(b, { cc: 1, type: 'session', session: SESSION });
    deliver(b, { cc: 1, type: 'session', session: null });
    expect(seen).toEqual([SESSION, null]);
    const late: unknown[] = [];
    b.win.ccBridge.onSession((s: unknown) => late.push(s));
    expect(late, 'the current value, immediately').toEqual([null]);
    off();
    deliver(b, { cc: 1, type: 'session', session: SESSION });
    expect(seen).toEqual([SESSION, null]);
  });

  it('ignores a session message from a foreign origin', () => {
    // Invariant: only the host origin can set the session a plugin acts on.
    const b = runBridge();
    deliver(b, { cc: 1, type: 'session', session: SESSION }, 'http://evil');
    expect(b.win.ccBridge.session).toBeUndefined();
  });

  it('openSession and sendPrompt post their envelopes to the host origin under distinct string ids', () => {
    // Invariant: the wire shape of both calls, and that every call carries its own id.
    const b = runBridge();
    void b.win.ccBridge.openSession('s1');
    void b.win.ccBridge.sendPrompt('s1', 'hi');
    void b.win.ccBridge.sendPrompt('s1', 'again');
    const [o] = calls(b, 'openSession');
    const [p, q] = calls(b, 'sendPrompt');
    expect(o).toEqual({ cc: 1, type: 'openSession', id: o.id, sessionId: 's1' });
    expect(p).toEqual({ cc: 1, type: 'sendPrompt', id: p.id, sessionId: 's1', text: 'hi' });
    expect(new Set([o.id, p.id, q.id]).size).toBe(3);
    expect([o.id, p.id].every((i) => typeof i === 'string')).toBe(true);
    expect(b.posted.filter(([m]) => m.type !== 'route' && m.type !== 'ready').every(([, origin]) => origin === 'http://h')).toBe(true);
  });

  it('a result resolves the call with its id only, in any order; unknown ids and foreign origins resolve nothing', async () => {
    // Invariant: replies are matched by id, never by order, and only a host-origin reply counts.
    const b = runBridge();
    const settled: Record<string, unknown> = {};
    const a = b.win.ccBridge.openSession('s1').then((r: unknown) => { settled.a = r; });
    const c = b.win.ccBridge.sendPrompt('s2', 'x').then((r: unknown) => { settled.c = r; });
    const [oa] = calls(b, 'openSession');
    const [oc] = calls(b, 'sendPrompt');
    deliver(b, { cc: 1, type: 'result', id: oa.id, ok: true }, 'http://evil');
    deliver(b, { cc: 1, type: 'result', id: 'nope', ok: true });
    await observerTurn();
    expect(settled, 'nothing resolved yet').toEqual({});
    deliver(b, { cc: 1, type: 'result', id: oc.id, ok: false, code: 'SESSION_NOT_LIVE' });
    await c;
    expect(settled).toEqual({ c: { ok: false, code: 'SESSION_NOT_LIVE' } });
    deliver(b, { cc: 1, type: 'result', id: oa.id, ok: true });
    await a;
    expect(settled.a).toEqual({ ok: true });
  });

  it('ignores a same-origin session, result or navigate from a source that is not the parent', async () => {
    // Invariant: the child attributes by sender — only window.parent can set the session, answer a call or steer the page.
    const b = runBridge();
    let settled = false;
    void b.win.ccBridge.openSession('s1').then(() => { settled = true; });
    const [o] = calls(b, 'openSession');
    const before = b.hist.replaced.length;
    const sibling = {};
    deliver(b, { cc: 1, type: 'session', session: SESSION }, 'http://h', sibling);
    deliver(b, { cc: 1, type: 'result', id: o.id, ok: true }, 'http://h', sibling);
    deliver(b, { cc: 1, type: 'navigate', path: '/x' }, 'http://h', sibling);
    deliver(b, { cc: 1, type: 'session', session: SESSION }, 'http://h', null);
    await observerTurn();
    expect(b.win.ccBridge.session).toBeUndefined();
    expect(settled).toBe(false);
    expect(b.hist.replaced.length).toBe(before);
  });

  it('a result whose id is an Object.prototype key neither throws nor resolves anything', async () => {
    // Invariant: pending calls are looked up by own id only, never through the prototype chain.
    const b = runBridge();
    let settled = false;
    void b.win.ccBridge.sendPrompt('s1', 'x').then(() => { settled = true; });
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(() => deliver(b, { cc: 1, type: 'result', id, ok: true }), id).not.toThrow();
    }
    await observerTurn();
    expect(settled).toBe(false);
  });
});

describe('plugin links', () => {
  const anchor = (href: string, target: string | null = '_top') => {
    const a = document.createElement('a');
    a.setAttribute('href', href);
    if (target !== null) a.setAttribute('target', target);
    document.body.appendChild(a);
    return a;
  };
  const opened = (posted: any[]) => posted.filter(([m]) => m.type === 'openLink');
  afterEach(() => { document.body.innerHTML = ''; });

  describe('accepted', () => {
    // Pins: a plain click on a `_top` link to cc's own page with a `#plugin/` hash is claimed and handed to cc as `openLink {hash}`.
    it('a _top link to a #plugin hash on the parent\'s page posts openLink and prevents the navigation', () => {
      const b = runBridge();
      const { prevented } = b.click(anchor('http://h/#plugin/code-git/?project=p'));
      expect(prevented).toBe(true);
      expect(b.posted.at(-1)).toEqual([{ cc: 1, type: 'openLink', hash: '#plugin/code-git/?project=p' }, 'http://h']);
    });

    // Pins: `_parent` is the same claim as `_top`, because a plugin frame's parent is cc's page.
    it('a _parent link is claimed the same way', () => {
      const b = runBridge();
      expect(b.click(anchor('http://h/#plugin/a/x', '_parent')).prevented).toBe(true);
      expect(opened(b.posted)).toEqual([[{ cc: 1, type: 'openLink', hash: '#plugin/a/x' }, 'http://h']]);
    });

    // Pins: the comparison is against the parent's own pathname and search, not a fixed `/`.
    it('a link to the parent\'s own path and search is claimed', () => {
      const b = runBridge({ parentLocation: { pathname: '/app', search: '?x=1' } });
      expect(b.click(anchor('http://h/app?x=1#plugin/a/')).prevented).toBe(true);
      expect(opened(b.posted)).toHaveLength(1);
    });

    // Pins: a click on an element inside the anchor resolves to the anchor.
    it('a click on a child of the anchor is claimed', () => {
      const b = runBridge();
      const span = document.createElement('span');
      anchor('http://h/#plugin/a/').appendChild(span);
      expect(b.click(span).prevented).toBe(true);
      expect(opened(b.posted)).toHaveLength(1);
    });
  });

  describe('left to the browser', () => {
    // Pins: nothing but an unmodified primary click, not already handled, on a `_top`/`_parent` same-page `#plugin/` link is claimed.
    it.each([
      ['ctrl held', 'http://h/#plugin/a/', '_top', { ctrlKey: true }],
      ['meta held', 'http://h/#plugin/a/', '_top', { metaKey: true }],
      ['shift held', 'http://h/#plugin/a/', '_top', { shiftKey: true }],
      ['alt held', 'http://h/#plugin/a/', '_top', { altKey: true }],
      ['a middle button', 'http://h/#plugin/a/', '_top', { button: 1 }],
      ['already default-prevented', 'http://h/#plugin/a/', '_top', { defaultPrevented: true }],
      ['no target', 'http://h/#plugin/a/', null, {}],
      ['_blank', 'http://h/#plugin/a/', '_blank', {}],
      ['_self', 'http://h/#plugin/a/', '_self', {}],
      ['another origin', 'http://evil/#plugin/a/', '_top', {}],
      ['another path', 'http://h/other#plugin/a/', '_top', {}],
      ['another search', 'http://h/?y=2#plugin/a/', '_top', {}],
      ['a #settings hash', 'http://h/#settings', '_top', {}],
      ['a #session hash', 'http://h/#session=s', '_top', {}],
      ['no hash', 'http://h/', '_top', {}],
    ] as const)('%s', (_name, href, target, init) => {
      const b = runBridge();
      expect(b.click(anchor(href, target), init).prevented).toBe(false);
      expect(opened(b.posted)).toEqual([]);
    });

    it('an unreadable parent', () => {
      const b = runBridge({ parentThrows: true });
      expect(b.click(anchor('http://h/#plugin/a/')).prevented).toBe(false);
      expect(opened(b.posted)).toEqual([]);
    });

    it('a click on a non-anchor element', () => {
      const b = runBridge();
      const div = document.createElement('div');
      document.body.appendChild(div);
      expect(b.click(div).prevented).toBe(false);
      expect(opened(b.posted)).toEqual([]);
    });
  });

  // Pins: a standalone page registers no click handler, so its links are never rewritten.
  it('standalone registers no click listener', () => {
    const b = runBridge({ top: true });
    expect(b.docListeners.click).toBeUndefined();
  });
});
