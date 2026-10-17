// Shared by viewSwitch.test.tsx and the viewSwitch.from-<view>.test.tsx files: the
// full-page views' fixtures, what is on screen, and the per-file host hooks. The
// vi.mock calls stay in each test file (their hoisting is per file).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, waitFor } from '@testing-library/react';
import { openCommits, openCosts, openPlugin, openReview, openSettings } from '../api';
import { endHost, mountApp, net, plainRow, resetHost, settle, viewOpen } from './pluginHost';

export type View = 'settings' | 'commits' | 'review' | 'costs' | 'plugin';
export const VIEWS: View[] = ['settings', 'commits', 'review', 'costs', 'plugin'];
export const HASH: Record<View, string> = { settings: '#settings', commits: '#commits', review: '#review', costs: '#costs', plugin: '#plugin/fake/' };
export const OPEN: Record<View, () => void> = {
  settings: () => openSettings(),
  commits: () => openCommits('p', 'wt'),
  review: () => openReview({ title: 'p / wt', url: '/api/projects/p/worktrees/wt/diff' }),
  costs: () => openCosts(),
  plugin: () => openPlugin('fake'),
};
export const ANCHOR = '#session=sess-1';
export const sha = (c: string) => c.repeat(40);
export const LIST = { branch: 'feature', hasUncommitted: false, aheadCount: 0, aheadOf: null, locked: false, commits: [{ sha: sha('a'), shortSha: 'aaaaaaa', subject: 'first', parents: [] }] };

/** The main views on screen: each full-page view's root, and the session pane. */
export function shown(): string[] {
  const out: string[] = [];
  if (document.querySelector('[data-settings-view]')) out.push('settings');
  for (const v of ['commits', 'review', 'costs']) if (document.querySelector(`main[data-view="${v}"]`)) out.push(v);
  if (viewOpen()) out.push('plugin');
  if (document.querySelector('div[data-view="session"]')) out.push('session');
  return out;
}
/** Waits until `view` alone is on screen (a lazily loaded view keeps the one it replaces hidden in the DOM meanwhile; its first load is slow under load). */
export async function only(view: View | 'session', what: string) {
  await waitFor(() => expect(shown(), what).toEqual([view]), { timeout: 10_000 });
}
export async function open(view: View) {
  await act(async () => { OPEN[view](); });
  await only(view, `${view} opened`);
}
/** Escape: every full-page view's Back. */
export async function escape() {
  await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
  await settle();
}
export const viewedPosts = () => net.calls.filter((c) => c === 'POST /api/sessions/sess-1/viewed').length;

/** Registers the host reset, the fetch stub and their teardown on the calling file's suite. */
export function useViewSwitchHost() {
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
}

/** Every ordered pair from `from`: opening `to` shows only it with its URL, Back returns to `from`, then to the session. */
export function pairsFrom(from: View) {
  describe('switching full-page views', () => {
    it(`opening any other full-page view from ${from} shows only the one opened, with the URL naming it, and Back returns to ${from}, then to the session`, async () => {
      await mountApp();
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
    }, 30_000);
  });
}
