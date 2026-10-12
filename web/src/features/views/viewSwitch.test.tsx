// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
// The full-page views as the app mounts them: one at a time with the URL naming
// it, review over a commit history, Back and the history it steps, a session
// selected from any of them, the plugin view's teardown, and the viewed check
// every exit re-runs.
import '@/test/browserHash';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/core/ws.js', () => ({ bus: new EventTarget(), connect: vi.fn(), send: vi.fn() }));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []), closeSession: vi.fn(), resumeSession: vi.fn(), promoteSession: vi.fn(), removeWorktree: vi.fn(),
  syncWorktree: vi.fn(), mergeWorktree: vi.fn(), setWorktreeLock: vi.fn(),
}));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));
vi.mock('@/features/session/SessionView', () => ({ SessionView: () => <div data-view="session" /> }));
vi.mock('@/features/dialogs/DialogsHost', () => ({ DialogsHost: () => null }));

import { selectInstance } from '@/app/controller';
import { emit } from '@/app/events';
import { startViewedMarker } from '@/app/viewedMarker';
import { appStore } from '@/state/app';
import { parseHash, syncRoute } from '@/state/route';
import { openCommits, openCosts, openPlugin, openReview, openSettings } from './api';
import { exitToConductor } from './AppSwitcher';
import { pluginFrames } from './plugins';
import { ACTIVE, endHost, mountApp, net, plainRow, resetHost, settle, viewOpen } from './test/pluginHost';

type View = 'settings' | 'commits' | 'review' | 'costs' | 'plugin';
const VIEWS: View[] = ['settings', 'commits', 'review', 'costs', 'plugin'];
const HASH: Record<View, string> = { settings: '#settings', commits: '#commits', review: '#review', costs: '#costs', plugin: '#plugin/fake/' };
const OPEN: Record<View, () => void> = {
  settings: () => openSettings(),
  commits: () => openCommits('p', 'wt'),
  review: () => openReview({ title: 'p / wt', url: '/api/projects/p/worktrees/wt/diff' }),
  costs: () => openCosts(),
  plugin: () => openPlugin('fake'),
};
const ANCHOR = '#session=sess-1';
const sha = (c: string) => c.repeat(40);
const LIST = { branch: 'feature', hasUncommitted: false, aheadCount: 0, aheadOf: null, locked: false, commits: [{ sha: sha('a'), shortSha: 'aaaaaaa', subject: 'first', parents: [] }] };

/** The main views on screen: each full-page view's root, and the session pane. */
function shown(): string[] {
  const out: string[] = [];
  if (document.querySelector('[data-settings-view]')) out.push('settings');
  for (const v of ['commits', 'review', 'costs']) if (document.querySelector(`main[data-view="${v}"]`)) out.push(v);
  if (viewOpen()) out.push('plugin');
  if (document.querySelector('div[data-view="session"]')) out.push('session');
  return out;
}
/** Waits until `view` alone is on screen (a lazily loaded view keeps the one it replaces hidden in the DOM meanwhile; its first load is slow under load). */
async function only(view: View | 'session', what: string) {
  await waitFor(() => expect(shown(), what).toEqual([view]), { timeout: 10_000 });
}
async function open(view: View) {
  await act(async () => { OPEN[view](); });
  await only(view, `${view} opened`);
}
/** Escape: every full-page view's Back. */
async function escape() {
  await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
  await settle();
}
const viewedPosts = () => net.calls.filter((c) => c === 'POST /api/sessions/sess-1/viewed').length;

beforeEach(() => {
  resetHost(`/${ANCHOR}`);
  net.status = { fake: plainRow() };
  const inner = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
    const json = (body: unknown) => { net.calls.push(`${init.method ?? 'GET'} ${url}`); return Promise.resolve(new Response(JSON.stringify(body))); };
    if (url === '/api/costs/summary') return json({ row_count: 0 });
    if (url.endsWith('/commits')) return json(LIST);
    return inner(url, init);
  }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await endHost();
});

describe('switching full-page views', () => {
  it('opening any full-page view from any other shows only the one opened, with the URL naming it, and Back returns to the one it replaced, then to the session', async () => {
    await mountApp();
    for (const from of VIEWS) {
      for (const to of VIEWS) {
        if (from === to) continue;
        await open(from);
        await open(to);
        expect(location.hash, `${from} → ${to}: the URL`).toBe(HASH[to]);
        await escape();
        await only(from, `${from} → ${to}: Back returns to ${from}`);
        expect(location.hash, `${from} → ${to}: the URL after Back`).toBe(HASH[from]);
        await escape();
        await only('session', `${from} → ${to}: Back again reaches the session`);
        expect(location.hash).toBe(ANCHOR);
      }
    }
  }, 30_000);

  it('a commit row opens its review over the commit history, and Back returns to that same history', async () => {
    await mountApp();
    await open('commits');
    await act(async () => { fireEvent.click(document.querySelector(`[data-commit-row="${sha('a')}"]`)!); });
    await only('review', 'the row\'s review');
    expect(location.hash).toBe('#review');
    expect(net.calls, 'the review asks for that commit\'s diff on the worktree').toContain(`GET /api/projects/p/worktrees/wt/commits/${sha('a')}/diff`);
    const lists = () => net.calls.filter((c) => c === 'GET /api/projects/p/worktrees/wt/commits').length;
    expect(lists(), 'precondition: the history loaded once').toBe(1);
    await escape();
    await only('commits', 'Back returns to the history');
    expect(location.hash).toBe('#commits');
    expect(lists(), 'the same worktree\'s history').toBe(2);
    expect(screen.getByRole('button', { name: 'Sync' }), 'still the worktree\'s history, with its actions').toBeTruthy();
    await escape();
    await only('session', 'Back again reaches the session');
  });

  it('leaving each full-page view for the session steps back exactly once by Back, never by a session hash, and leaves none of it behind', async () => {
    await mountApp();
    const back = vi.spyOn(history, 'back');
    for (const view of VIEWS) {
      await open(view);
      if (view === 'commits') expect(screen.getByRole('button', { name: 'Sync' }), 'precondition: the worktree\'s actions').toBeTruthy();
      back.mockClear();
      await escape();
      await only('session', `${view}: Back`);
      expect(back, `${view}: Back steps back once`).toHaveBeenCalledTimes(1);
      expect(location.hash).toBe(ANCHOR);
      if (view === 'commits') expect(screen.queryByRole('button', { name: 'Sync' }), 'the worktree\'s actions are gone').toBeNull();
      await open(view);
      back.mockClear();
      await act(async () => { location.hash = '#session=other'; });
      await only('session', `${view}: a session hash`);
      expect(back, `${view}: a session hash steps nothing back`).not.toHaveBeenCalled();
      await act(async () => { history.replaceState(null, '', `/${ANCHOR}`); syncRoute(); });
    }
  });

  it('selecting a session from any full-page view shows that session and writes its anchor, stepping nothing back', async () => {
    await mountApp();
    const back = vi.spyOn(history, 'back');
    for (const stack of [...VIEWS.map((v) => [v]), ['commits', 'review']] as View[][]) {
      for (const v of stack) await open(v);
      back.mockClear();
      await act(async () => { selectInstance(ACTIVE.id); });
      await only('session', `${stack.join(' + ')}: selected`);
      expect(location.hash, `${stack.join(' + ')}: the anchor`).toBe(ANCHOR);
      expect(back, `${stack.join(' + ')}: nothing stepped back`).not.toHaveBeenCalled();
    }
  });

  it('the plugin view tears down once per leave: never for switches it took no part in, and not again after it was left', async () => {
    await mountApp();
    const leave = vi.spyOn(pluginFrames, 'leave');
    const switchAround = async () => {
      await open('settings');
      await open('commits');
      await act(async () => { selectInstance(ACTIVE.id); });
      await only('session', 'selected');
      await open('review');
      await open('settings');
    };
    await switchAround();
    expect(leave, 'never opened: no teardown').not.toHaveBeenCalled();
    await open('plugin');
    expect(leave, 'precondition: opening tears nothing down').not.toHaveBeenCalled();
    await open('commits');
    expect(leave, 'leaving the plugin view tears it down once').toHaveBeenCalledTimes(1);
    await switchAround();
    expect(leave, 'not again after it was left').toHaveBeenCalledTimes(1);
  });

  it('every full-page view hash names its view, and a session anchor or an empty hash names the session', () => {
    expect(['#settings', '#settings/account', '#commits', '#review', '#costs', '#plugin/fake/', '#session=x', '#', ''].map((h) => parseHash(h).view))
      .toEqual(['settings', 'settings', 'commits', 'review', 'costs', 'plugin', 'session', 'session', 'session']);
  });

  it('Back from a view the app did not open itself lands on the session anchor, even after a browser Back', async () => {
    await mountApp();
    const back = vi.spyOn(history, 'back');
    await open('settings');
    await escape();
    await only('session', 'control: Back from a view the app opened');
    expect(back, 'control: it steps back once').toHaveBeenCalledTimes(1);
    await act(async () => { history.replaceState(null, '', '/#settings'); syncRoute(); });
    await only('settings', 'a deep link to Settings');
    await open('commits');
    await act(async () => { history.back(); });
    await only('settings', 'precondition: the browser\'s Back returned to Settings');
    back.mockClear();
    await escape();
    expect(back, 'Back steps no history from an entry the app did not push').not.toHaveBeenCalled();
    await only('session', 'Back lands on the session');
    expect(location.hash).toBe(ANCHOR);
  });

  it('Back from an entry carrying some other state, as a plugin page\'s own history call can leave, writes the session anchor and steps nothing back', async () => {
    await mountApp();
    const back = vi.spyOn(history, 'back');
    await open('costs');
    await escape();
    await only('session', 'control: Back from a view the app opened');
    expect(back, 'control: it steps back once').toHaveBeenCalledTimes(1);
    back.mockClear();
    await act(async () => { history.replaceState({ foo: 1 }, '', '/#settings'); syncRoute(); });
    await only('settings', 'precondition: Settings on an entry another state marks');
    await escape();
    expect(back, 'Back steps no history from an entry the app did not mark').not.toHaveBeenCalled();
    await only('session', 'Back lands on the session');
    expect(location.hash).toBe(ANCHOR);
  });

  it('a Settings section switch keeps Back stepping back to where Settings was opened from', async () => {
    await mountApp();
    const back = vi.spyOn(history, 'back');
    await open('settings');
    await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'Account' })); });
    await settle();
    expect(location.hash, 'precondition: the section is in the URL').toBe('#settings/account');
    await escape();
    await only('session', 'Back');
    expect(back, 'Back steps back to where Settings was opened from').toHaveBeenCalledTimes(1);
    expect(location.hash).toBe(ANCHOR);
  });
});

describe('the viewed check', () => {
  beforeAll(() => startViewedMarker());
  let seq = 0;
  /** Gives the active session an unseen turn end the check has not posted yet. */
  async function turnEnds() {
    seq += 1;
    await act(async () => { appStore.set({ instances: [{ ...ACTIVE, turnEndSeq: seq, viewedSeq: 0 }] }); emit('instances'); });
    await settle();
  }

  it('every exit from a full-page view to the session re-runs the viewed check, and nothing posts while a view covers the pane', async () => {
    await mountApp();
    const exits: [string, () => void | Promise<void>][] = [
      ['Back', () => escape()],
      ['a session hash', async () => { await act(async () => { location.hash = ANCHOR; }); await settle(); }],
      ['selecting the session', async () => { await act(async () => { selectInstance(ACTIVE.id); }); await settle(); }],
    ];
    let posts = viewedPosts();
    for (const view of VIEWS) {
      for (const [how, exit] of [...exits, ...(view === 'plugin' ? [['Conductor', async () => { await act(async () => { exitToConductor(); }); await settle(); }] as [string, () => Promise<void>]] : [])]) {
        await open(view);
        await turnEnds();
        expect(viewedPosts(), `${view}, ${how}: nothing posts while the view covers the pane`).toBe(posts);
        await exit();
        await only('session', `${view}, ${how}: the session`);
        expect(viewedPosts(), `${view}, ${how}: the exit posts once`).toBe(posts + 1);
        posts += 1;
      }
    }
  }, 15_000);

  it('Settings handing the pane to Costs never marks the session viewed, nor does Back to Settings; Back to the session does', async () => {
    await mountApp();
    const posts = viewedPosts();
    await open('settings');
    await turnEnds();
    await open('costs');
    expect(viewedPosts(), 'Settings → Costs').toBe(posts);
    await escape();
    await only('settings', 'Back to Settings');
    expect(viewedPosts(), 'Back to Settings').toBe(posts);
    await escape();
    await only('session', 'Back to the session');
    expect(viewedPosts(), 'Back to the session posts once').toBe(posts + 1);
  });
});
