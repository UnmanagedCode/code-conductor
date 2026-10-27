// A transcript link to a plugin view, in the real App's plugin host: it opens the view with one history entry and
// steers a page that is already up (docked, kept alive, or hidden behind the conversation) with `navigate`, never a reload.
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

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
  column, DOCK_CATALOG, dockSplit, endHost, go, keepRow, mountApp, navigate, net, plainRow, postRoute, residentFrame, resetHost,
  sessionShown, settle, sharedFrame, standInWindow, viewOpen,
} from './test/pluginHost';
import { Markdown } from '@/components/Markdown';
import { clickLink } from '@/test/linkClick';
import { dockStore, readDockState } from './dock';

const ANCHOR = '#session=sess-1';
const starts = () => net.calls.filter((c) => c.endsWith('/start')).length;
const statusReads = (id: string) => net.calls.filter((c) => c === `GET /api/plugins/${id}/status`).length;

/** Renders `[Open](href)` beside the app and clicks it; true when the app handled the click. */
async function clickLinkTo(href: string) {
  const { container, unmount } = render(<Markdown text={`[Open](${href})`} />);
  const handled = clickLink(container.querySelector('a')!);
  unmount();
  await settle();
  return handled;
}

beforeEach(() => {
  localStorage.clear();
  dockStore.set(readDockState());
  resetHost(`/${ANCHOR}`);
  net.catalog = DOCK_CATALOG;
  net.status = { alpha: plainRow(), beta: keepRow() };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await go(ANCHOR);
  await endHost();
});

describe('a plugin link in the transcript', () => {
  // Pins: from the conversation, a link opens the plugin view at its subpath with one history entry, and Back returns to the session.
  it('opens the view at the subpath and Back returns to the conversation', async () => {
    await mountApp();
    const before = history.length;
    expect(await clickLinkTo('#plugin/alpha/?review=r-9&thread=t-7')).toBe(true);
    expect(viewOpen()).toBe(true);
    expect(sharedFrame()!.getAttribute('src')).toBe('/plugins/alpha/?review=r-9&thread=t-7');
    expect(history.length).toBe(before + 1);
    act(() => { history.back(); });
    await settle();
    expect(viewOpen()).toBe(false);
    expect(sessionShown()).toBe(true);
    expect(location.hash).toBe(ANCHOR);
  });

  // Pins: a link while a plain plugin is docked steers its frame in the dock after the page moved itself: no route change, no history entry, split kept.
  it('steers a docked plain plugin\'s frame in the dock after the page moved itself', async () => {
    await mountApp();
    await dockSplit('alpha');
    const frame = sharedFrame()!;
    const src = frame.getAttribute('src');
    const win = standInWindow(frame);
    postRoute(win, '/?review=r-1');
    const reads = statusReads('alpha');
    const before = history.length;
    expect(await clickLinkTo('#plugin/alpha/?review=r-9&thread=t-7')).toBe(true);
    expect(sharedFrame()).toBe(frame);
    expect(frame.getAttribute('src')).toBe(src);
    expect(win.posted.at(-1)).toEqual(navigate('/?review=r-9&thread=t-7'));
    expect(statusReads('alpha')).toBe(reads);
    expect(location.hash).toBe(ANCHOR);
    expect(history.length).toBe(before);
    expect(sessionShown()).toBe(true);
    expect(viewOpen()).toBe(true);
    expect(column()!.getAttribute('data-dock-mode')).toBe('split');
    expect(dockStore.get()).toMatchObject({ id: 'alpha', subpath: '/?review=r-9&thread=t-7' });
  });

  // Pins: a link while a keep-alive plugin is docked steers its resident frame by path, with the dock kept.
  it('steers a docked keep-alive plugin\'s resident frame by path', async () => {
    await mountApp();
    await dockSplit('beta');
    const frame = residentFrame('beta')!;
    const win = standInWindow(frame);
    expect(await clickLinkTo('#plugin/beta/deep/path')).toBe(true);
    expect(residentFrame('beta')).toBe(frame);
    expect(win.posted.at(-1)).toEqual(navigate('/deep/path'));
    expect(starts()).toBe(0);
    expect(location.hash).toBe(ANCHOR);
    expect(sessionShown()).toBe(true);
  });

  // Pins: a keep-alive page hidden behind the conversation is revealed at the link's subpath after it moved itself.
  it('steers a hidden keep-alive page back to the link\'s subpath', async () => {
    await mountApp();
    expect(await clickLinkTo('#plugin/beta/?review=r-9&thread=t-7')).toBe(true);
    const frame = residentFrame('beta')!;
    const src = frame.getAttribute('src');
    const win = standInWindow(frame);
    postRoute(win, '/?review=r-9&thread=t-8');
    act(() => { history.back(); });
    await settle();
    expect(sessionShown()).toBe(true);
    expect(frame.hidden).toBe(true);
    expect(await clickLinkTo('#plugin/beta/?review=r-9&thread=t-7')).toBe(true);
    expect(residentFrame('beta')).toBe(frame);
    expect(frame.getAttribute('src')).toBe(src);
    expect(win.posted.at(-1)).toEqual(navigate('/?review=r-9&thread=t-7'));
    expect(starts()).toBe(0);
  });

  // Pins (green on arrival): the full view re-steers to an earlier query subpath after the page moved itself.
  it('the full view steers back to a query subpath after the page moved', async () => {
    await mountApp();
    await go('#plugin/alpha/?review=r-9&thread=t-7');
    const win = standInWindow(sharedFrame()!);
    postRoute(win, '/?review=r-9&thread=t-8');
    await go('#plugin/alpha/?review=r-9&thread=t-7');
    expect(win.posted.filter((m) => (m as { type?: string }).type === 'navigate')).toEqual([navigate('/?review=r-9&thread=t-7')]);
  });
});
