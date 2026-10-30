// A plugin link while the dock shows a plugin beside the session: from the transcript and from the plugin's own page (the bridge's
// `openLink`) it shows its target in the dock, with no route change and no history entry; with no dock showing it is today's behaviour.
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('@/app/controller', () => ({
  selectInstance: vi.fn(), send: vi.fn(), refreshProjects: vi.fn(), refreshInstances: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []), closeSession: vi.fn(), resumeSession: vi.fn(), promoteSession: vi.fn(), removeWorktree: vi.fn(),
}));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));
vi.mock('@/features/session/SessionView', () => ({ SessionView: () => <div data-view="session" /> }));
vi.mock('@/features/dialogs/DialogsHost', () => ({ DialogsHost: () => null }));

import {
  checkedNow, column, DOCK_CATALOG, dockSplit, endHost, go, keepRow, mountApp, navigate, net, pickApp, plainRow, postFrom,
  pressColumn, residentFrame, resetHost, sessionShown, settle, sharedFrame, standInWindow, viewOpen, type StandIn,
} from './test/pluginHost';
import { Markdown } from '@/components/Markdown';
import { clickLink } from '@/test/linkClick';
import { DOCK_STORAGE_KEY, dockCollapsedStore, dockStore, readDockState } from './dock';

const ANCHOR = '#session=sess-1';

/** Renders `[Open](href)` beside the app and clicks it; true when the app handled the click. */
async function clickLinkTo(href: string) {
  const { container, unmount } = render(<Markdown text={`[Open](${href})`} />);
  const handled = clickLink(container.querySelector('a')!);
  unmount();
  await settle();
  return handled;
}

/** A plugin page's bridge reports a link it caught, as `win`'s frame posts it. */
async function openLink(win: StandIn, href: unknown) {
  postFrom(win, { cc: 1, type: 'openLink', href });
  await settle();
}

const happyDOM = () => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM;
let viewport = { width: 0, height: 0 };

beforeEach(() => {
  viewport = { width: window.innerWidth, height: window.innerHeight };
  localStorage.clear();
  dockStore.set(readDockState());
  resetHost(`/${ANCHOR}`);
  net.catalog = DOCK_CATALOG;
  net.status = { alpha: plainRow(), beta: keepRow(), gamma: plainRow() };
});
afterEach(async () => {
  vi.restoreAllMocks();
  happyDOM().setViewport(viewport);
  await go(ANCHOR);
  await endHost();
});

describe('a transcript link while the dock shows a plugin', () => {
  // Pins: a link to another listed plugin switches the dock to it at the link's subpath, with no route or history change, in a resident frame.
  it('another plugin\'s link switches the dock to it', async () => {
    await mountApp();
    await dockSplit('alpha');
    const before = history.length;
    expect(await clickLinkTo('#plugin/beta/deep/path')).toBe(true);
    expect(location.hash).toBe(ANCHOR);
    expect(history.length).toBe(before);
    expect(dockStore.get()).toMatchObject({ id: 'beta', subpath: '/deep/path' });
    expect(residentFrame('beta')!.getAttribute('src')).toBe('/plugins/beta/deep/path');
    expect(residentFrame('beta')!.hidden).toBe(false);
    expect(sharedFrame()).toBeNull();
    expect(sessionShown()).toBe(true);
    expect(await checkedNow()).toEqual(['beta']);
  });

  // Pins: a `http://cc.internal/` transcript link opens in the dock while the dock shows, with no route or history change.
  it('a cc.internal link switches the dock to its plugin', async () => {
    await mountApp();
    await dockSplit('alpha');
    const before = history.length;
    expect(await clickLinkTo('http://cc.internal/#plugin/beta/deep/path')).toBe(true);
    expect(location.hash).toBe(ANCHOR);
    expect(history.length).toBe(before);
    expect(dockStore.get()).toMatchObject({ id: 'beta', subpath: '/deep/path' });
    expect(sessionShown()).toBe(true);
  });

  // Pins: a link while the dock is collapsed to a rail expands it and steers the docked plugin.
  it('a link while collapsed expands the rail and shows the target', async () => {
    await mountApp();
    await dockSplit('alpha');
    const win = standInWindow(sharedFrame()!);
    await pressColumn('Collapse plugin dock');
    expect(column()!.getAttribute('data-dock-mode')).toBe('rail');
    expect(await clickLinkTo('#plugin/alpha/x')).toBe(true);
    expect(column()!.getAttribute('data-dock-mode')).toBe('split');
    expect(dockCollapsedStore.get().collapsed).toBe(false);
    expect(location.hash).toBe(ANCHOR);
    expect(win.posted.at(-1)).toEqual(navigate('/x'));
  });

  // Pins: a link to a plugin the switcher does not list is not docked; it opens the full view, ending the split.
  it('a link to an unlisted plugin opens the full view', async () => {
    await mountApp();
    await dockSplit('alpha');
    expect(await clickLinkTo('#plugin/gamma/')).toBe(true);
    expect(location.hash).toBe('#plugin/gamma/');
    expect(viewOpen()).toBe(true);
    expect(sessionShown()).toBe(false);
    expect(dockStore.get().id).toBeNull();
  });

  // Pins: below md there is no dock, so a link opens the full view whatever dock state is stored.
  it('on a phone viewport a link opens the full view', async () => {
    happyDOM().setViewport({ width: 412, height: 915 });
    localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify({ id: 'alpha', subpath: '/', mode: 'split' }));
    dockStore.set(readDockState());
    await mountApp();
    const before = history.length;
    expect(await clickLinkTo('#plugin/alpha/x')).toBe(true);
    expect(location.hash).toBe('#plugin/alpha/x');
    expect(history.length).toBe(before + 1);
  });
});

describe('a link the plugin page\'s bridge reports (openLink)', () => {
  // Pins: an accepted openLink from the docked frame to another listed plugin switches the dock, with no route or history change.
  it('to another plugin switches the dock', async () => {
    await mountApp();
    await dockSplit('alpha');
    const win = standInWindow(sharedFrame()!);
    const before = history.length;
    await openLink(win, '#plugin/beta/?project=p');
    expect(dockStore.get()).toMatchObject({ id: 'beta', subpath: '/?project=p' });
    expect(location.hash).toBe(ANCHOR);
    expect(history.length).toBe(before);
    expect(residentFrame('beta')!.getAttribute('src')).toBe('/plugins/beta/?project=p');
    expect(sessionShown()).toBe(true);
  });

  // Pins: the parent accepts a bridge `href` in the `http://cc.internal/` form.
  it('a cc.internal href switches the dock', async () => {
    await mountApp();
    await dockSplit('alpha');
    const win = standInWindow(sharedFrame()!);
    const before = history.length;
    await openLink(win, 'http://cc.internal/#plugin/beta/?project=p');
    expect(dockStore.get()).toMatchObject({ id: 'beta', subpath: '/?project=p' });
    expect(location.hash).toBe(ANCHOR);
    expect(history.length).toBe(before);
  });

  // Pins: an accepted openLink to the docked plugin steers its own frame without a reload and keeps the split.
  it('to the docked plugin steers its frame', async () => {
    await mountApp();
    await dockSplit('alpha');
    const frame = sharedFrame()!;
    const win = standInWindow(frame);
    await openLink(win, '#plugin/alpha/inner');
    expect(win.posted.at(-1)).toEqual(navigate('/inner'));
    expect(sharedFrame()).toBe(frame);
    expect(column()!.getAttribute('data-dock-mode')).toBe('split');
  });

  // Pins: with no dock showing, an accepted openLink is the browser's own fragment navigation (`location.hash =`), not `openView`'s history entry.
  it('with no dock showing sets the hash as the browser would', async () => {
    await mountApp();
    await go('#plugin/alpha/');
    const win = standInWindow(sharedFrame()!);
    const before = history.length;
    await openLink(win, '#plugin/beta/x');
    expect(location.hash).toBe('#plugin/beta/x');
    expect(history.length).toBe(before + 1);
    expect(viewOpen()).toBe(true);
    expect(sessionShown()).toBe(false);
    expect(history.state?.ccView).not.toBe(1);
  });

  describe('is ignored', () => {
    // Pins: the parent re-judges every bridge href with the transcript's rule, so a link the bridge prevented but cc does not accept changes nothing.
    it.each([
      '#plugin/alpha/../x', '#plugin/alpha/%2e%2e/x', '#plugin/', '#session=s', '#review', '#commits',
      'https://evil.example/', 'javascript:alert(1)', 42, undefined,
      'http://cc.internal/x#plugin/beta/', 'http://cc.internal/?a#plugin/beta/', 'http://u@cc.internal/#plugin/beta/',
      'http://cc.internal.evil.com/#plugin/beta/', 'http://cc.internal/#review',
    ])('an href of %j', async (href) => {
      await mountApp();
      await dockSplit('alpha');
      const win = standInWindow(sharedFrame()!);
      const before = history.length;
      const posted = win.posted.length;
      await openLink(win, href);
      expect(dockStore.get()).toMatchObject({ id: 'alpha', subpath: '/' });
      expect(location.hash).toBe(ANCHOR);
      expect(history.length).toBe(before);
      expect(win.posted.length).toBe(posted);
    });

    // Pins: the payload field is `href`; a message carrying only the old `hash` field changes nothing.
    it('a message with only a hash field', async () => {
      await mountApp();
      await dockSplit('alpha');
      const win = standInWindow(sharedFrame()!);
      const before = history.length;
      postFrom(win, { cc: 1, type: 'openLink', hash: '#plugin/beta/x' });
      await settle();
      expect(dockStore.get()).toMatchObject({ id: 'alpha', subpath: '/' });
      expect(location.hash).toBe(ANCHOR);
      expect(history.length).toBe(before);
    });

    // Pins: only a frame cc mounted may send it.
    it('from a window that is no mounted frame', async () => {
      await mountApp();
      await dockSplit('alpha');
      await openLink({ posted: [], origins: [], postMessage() {} } as StandIn, '#plugin/beta/x');
      expect(dockStore.get()).toMatchObject({ id: 'alpha' });
      expect(location.hash).toBe(ANCHOR);
    });

    // Pins: a message from another origin is ignored.
    it('from another origin', async () => {
      await mountApp();
      await dockSplit('alpha');
      const win = standInWindow(sharedFrame()!);
      window.dispatchEvent(new MessageEvent('message', { data: { cc: 1, type: 'openLink', href: '#plugin/beta/x' }, origin: 'http://evil.example', source: win as unknown as Window }));
      await settle();
      expect(dockStore.get()).toMatchObject({ id: 'alpha' });
      expect(location.hash).toBe(ANCHOR);
    });

    // Pins: only the shown frame counts; a hidden keep-alive page has no user clicking in it.
    it('from a hidden resident frame', async () => {
      await mountApp();
      await dockSplit('beta');
      const hidden = standInWindow(residentFrame('beta')!);
      await pickApp('alpha');
      expect(residentFrame('beta')!.hidden).toBe(true);
      await openLink(hidden, '#plugin/beta/x');
      expect(dockStore.get()).toMatchObject({ id: 'alpha' });
      expect(location.hash).toBe(ANCHOR);
    });
  });
});
