// The bridge runs inside plugin frames as a classic script; drive it against a scripted fake window.
// Plugin pages load the root /pluginBridge.js, served from this directory's pluginBridge.js.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { observerTurn, runBridge } from './test/bridge';

afterEach(() => { vi.unstubAllGlobals(); });

describe('pluginBridge.js', () => {
  it('is a no-op standalone and outside a /plugins mount, theme included', () => {
    const hostRoot = document.createElement('html');
    hostRoot.classList.add('dark');
    for (const opts of [{ top: true }, { pathname: '/elsewhere' }]) {
      const b = runBridge({ ...opts, hostRoot });
      b.contentLoaded();
      expect(b.posted).toEqual([]);
      expect(b.frameRoot.classList.contains('dark')).toBe(false);
      expect(b.frameRoot.hasAttribute('data-cc-theme')).toBe(false);
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
    const { listeners, hist } = runBridge();
    const before = hist.replaced.length;
    for (const f of listeners.message) f({ origin: 'http://evil', data: { cc: 1, type: 'navigate', path: '/x' } });
    expect(hist.replaced.length).toBe(before);
    let popped = 0;
    (listeners.popstate ??= []).push(() => popped++);
    for (const f of listeners.message) f({ origin: 'http://h', data: { cc: 1, type: 'navigate', path: '/x' } });
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
      b.contentLoaded();
      expect(b.posted).toEqual([[{ cc: 1, type: 'ready' }, 'http://h'], [{ cc: 1, type: 'route', path: '/a?q=1' }, 'http://h']]);
    });
  });
});
