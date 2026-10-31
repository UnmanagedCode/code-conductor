// A plugin's row ⋮ button on the mounted App: where the click opens the plugin (the dock beside the session, or the full view) and what scope the frame receives.
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';

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
  DOCK_CATALOG, dockSplit, endHost, keepRow, mountApp, navigate, net, pickApp, plainRow, residentFrame, resetHost, sessionShown,
  settle, sharedFrame, sidebar, standInWindow,
} from './test/pluginHost';
import { appStore } from '@/state/app';
import { uiStore } from '@/app/ui';
import { parseHash } from '@/state/route';
import { proj, wt } from '@/test/sidebarFleet';
import { closeRowMenu, openProjectMenu, pickRowMenuItem, rowMenuItems } from '@/test/rowMenu';
import { sidebarStore } from '@/features/sidebar/state';
import { dockStore, readDockState } from './dock';
import type { PluginRow } from './plugins';

const ANCHOR = '#session=sess-1';

const CATALOG: PluginRow[] = [
  { ...DOCK_CATALOG[0], menuItems: [{ label: 'Board', scope: 'project', path: '/board' }, { label: 'Diff', scope: 'worktree', path: '/diff' }] },
  { ...DOCK_CATALOG[1], menuItems: [{ label: 'Terminal', scope: 'worktree', path: '/term' }] },
  { id: 'off', name: 'Off', enabled: false, hasFrontend: true, menuItems: [{ label: 'Off item', scope: 'project', path: '/x' }] },
];

/** Seeds one project with one worktree, both expanded in the sidebar. */
async function seedRows(project = 'api', worktree = 'wt1') {
  await act(async () => {
    appStore.set({ ...appStore.get(), projects: [proj(project, { isGitRepo: true, worktrees: [wt(worktree)] })] });
    sidebarStore.set({ expandedWorktrees: [project] });
    uiStore.set({ lens: 'projects' });
  });
  await settle();
}
const byAttr = (attr: string, value: string) => [...sidebar().querySelectorAll(`[${attr}]`)].find((e) => e.getAttribute(attr) === value) as HTMLElement;
const projectRow = (name: string) => byAttr('data-project-row', name);
const worktreeRow = (name: string) => byAttr('data-worktree-row', name);

beforeEach(async () => {
  localStorage.clear();
  dockStore.set(readDockState());
  resetHost(`/${ANCHOR}`);
  net.catalog = CATALOG;
  net.status = { alpha: plainRow(), beta: keepRow() };
});
afterEach(async () => {
  vi.restoreAllMocks();
  location.hash = ANCHOR;
  await endHost();
});

describe('a plugin row ⋮ button', () => {
  // Pins: with no dock showing, a project item opens the plugin's full view at its path, scoped to the project on first load, and no dock is set.
  it('with no dock showing, a project item opens the full view at its path, scoped to the project', async () => {
    await mountApp();
    await seedRows();
    const before = history.length;
    await pickRowMenuItem(projectRow('api'), 'Project menu', 'Board');
    expect(location.hash).toBe('#plugin/alpha/board?ccProject=api');
    expect(history.length).toBe(before + 1);
    expect(sharedFrame()!.getAttribute('src')).toBe('/plugins/alpha/board?ccProject=api');
    expect(dockStore.get().id).toBeNull();
  });

  // Pins: with a plugin docked, another plugin's worktree item replaces it in the dock with the worktree scope in the frame's first load, and the route and history stay.
  it('with a plugin docked beside the session, another plugin\'s worktree item replaces it in the dock, scoped to the worktree', async () => {
    await mountApp();
    await seedRows();
    await dockSplit('alpha');
    const before = history.length;
    await pickRowMenuItem(worktreeRow('wt1'), 'Worktree menu', 'Terminal');
    expect(dockStore.get()).toMatchObject({ id: 'beta', subpath: '/term?ccProject=api&ccWorktree=wt1' });
    expect(location.hash).toBe(ANCHOR);
    expect(history.length).toBe(before);
    expect(residentFrame('beta')!.getAttribute('src')).toBe('/plugins/beta/term?ccProject=api&ccWorktree=wt1');
    expect(sessionShown()).toBe(true);
  });

  // Pins: the docked plugin's own item steers its already-open frame with a `navigate` carrying the scope, without reloading it.
  it('the docked plugin\'s own item steers its open frame with navigate, carrying the scope', async () => {
    await mountApp();
    await seedRows();
    await dockSplit('alpha');
    const f = sharedFrame()!;
    const src = f.getAttribute('src');
    const win = standInWindow(f);
    await pickRowMenuItem(worktreeRow('wt1'), 'Worktree menu', 'Diff');
    expect(win.posted.at(-1)).toEqual(navigate('/diff?ccProject=api&ccWorktree=wt1'));
    expect(sharedFrame()).toBe(f);
    expect(f.getAttribute('src')).toBe(src);
    expect(location.hash).toBe(ANCHOR);
  });

  // Pins: inside a plugin's full view, that plugin's item steers the open frame with the scope and replaces the history entry.
  it('in a plugin\'s full view, that plugin\'s item steers the open frame and replaces the entry', async () => {
    await mountApp();
    await seedRows();
    await pickApp('alpha');
    const win = standInWindow(sharedFrame()!);
    const before = history.length;
    await pickRowMenuItem(projectRow('api'), 'Project menu', 'Board');
    expect(location.hash).toBe('#plugin/alpha/board?ccProject=api');
    expect(history.length).toBe(before);
    expect(win.posted.at(-1)).toEqual(navigate('/board?ccProject=api'));
  });

  // Pins: hostile project and worktree names reach the frame as query values and cannot change its path or hash.
  it('hostile project and worktree names reach the frame intact and cannot leave the plugin\'s path', async () => {
    await mountApp();
    const P = 'a/b?c#d&e=%f';
    await seedRows(P, '..');
    await pickRowMenuItem(worktreeRow('..'), 'Worktree menu', 'Diff');
    const u = new URL(sharedFrame()!.getAttribute('src')!, location.origin);
    expect(u.pathname).toBe('/plugins/alpha/diff');
    expect(u.hash).toBe('');
    expect(u.searchParams.get('ccProject')).toBe(P);
    expect(u.searchParams.get('ccWorktree')).toBe('..');
    expect(parseHash(location.hash).pluginId).toBe('alpha');
  });

  // Pins: a disabled plugin contributes no items, while an enabled one does.
  it('a disabled plugin contributes no items', async () => {
    await mountApp();
    await seedRows();
    const texts = rowMenuItems(await openProjectMenu(projectRow('api'))).map((i) => i.textContent);
    expect(texts).toContain('Board');
    expect(texts).not.toContain('Off item');
    await closeRowMenu();
  });
});
