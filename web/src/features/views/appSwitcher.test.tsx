// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
// The app switcher in the sidebar header, as the app mounts it: there only once
// a plugin contributes a frontend, its entries, which one is current, the mark a
// resident keep-alive plugin carries, and the way back to Conductor.
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, within } from '@testing-library/react';

vi.mock('@/app/controller', () => ({
  selectInstance: vi.fn(), send: vi.fn(), refreshProjects: vi.fn(), refreshInstances: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []), closeSession: vi.fn(), resumeSession: vi.fn(), promoteSession: vi.fn(), removeWorktree: vi.fn(),
}));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));
vi.mock('@/features/session/SessionView', () => ({ SessionView: () => <div data-view="session" /> }));
vi.mock('@/features/views/CommitsView', () => ({ CommitsView: () => <div data-view="commits" /> }));
vi.mock('@/features/dialogs/DialogsHost', () => ({ DialogsHost: () => null }));

import { notifyPluginsChanged } from '@/features/settings/pluginsSignal';
import { openCommits } from './api';
import {
  ACTIVE, checkedApps, closeSwitcher, endHost, entryId, go, keepRow, mountApp, net, openSwitcher, pickApp, plainRow, postRoute, resetHost,
  residentFrame, settle, sharedFrame, sidebar, standInWindow, switcher, switcherEntries, viewOpen,
} from './test/pluginHost';

beforeEach(() => resetHost());
afterEach(() => endHost());

const app = (id: string, name: string, extra: object = {}) => ({ id, name, enabled: true, hasFrontend: true, ...extra });
/** The sidebar's level-1 headings. */
const titles = () => within(sidebar()).queryAllByRole('heading', { level: 1 });
/** Each entry's accessible text, by id. */
async function labels(): Promise<Record<string, string>> {
  const menu = await openSwitcher();
  const out = Object.fromEntries(switcherEntries(menu).map((e) => [entryId(e), e.textContent ?? '']));
  await closeSwitcher();
  return out;
}

describe('the app switcher', () => {
  it('is absent while no enabled plugin contributes a frontend, appears once one does, and goes again once none does', async () => {
    net.catalog = [{ id: 'x', name: 'X', enabled: true, hasFrontend: false }, { id: 'y', name: 'Y', enabled: false, hasFrontend: true }];
    await mountApp();
    expect(net.calls, 'fixture check: the catalog was read').toContain('GET /api/plugins');
    expect(switcher()).toBeNull();
    expect(titles().length, 'a plain title in its place').toBe(1);
    net.catalog = [app('y', 'Y')];
    await act(async () => { notifyPluginsChanged(undefined); });
    await settle();
    expect(switcher(), 'a plugin with a frontend brings the switcher').not.toBeNull();
    net.catalog = [];
    await act(async () => { notifyPluginsChanged(undefined); });
    await settle();
    expect(switcher(), 'gone once none does').toBeNull();
    expect(titles().length, 'and the plain title is back').toBe(1);
  });

  it('offers Conductor and each enabled plugin with a frontend, and marks exactly one entry current, following every switch both ways', async () => {
    net.catalog = [app('ka', 'Keep', { navLabel: 'Keep nav' }), app('pl', 'Plain'), { id: 'off', name: 'Off', enabled: false, hasFrontend: true }, { id: 'nf', name: 'No frontend', enabled: true, hasFrontend: false }];
    net.status = { ka: keepRow(), pl: plainRow() };
    await mountApp();
    let menu = await openSwitcher();
    const items = switcherEntries(menu);
    expect(items.map(entryId), 'fixture check: Conductor, then each enabled plugin with a frontend').toEqual(['conductor', 'ka', 'pl']);
    expect(items[1].textContent, 'a plugin by its nav label').toContain('Keep nav');
    expect(items[2].textContent, 'or by its name without one').toContain('Plain');
    expect(within(menu).queryAllByRole('menuitemradio').length, 'each entry is a radio item').toBe(3);
    expect(checkedApps(menu), 'at the start').toEqual(['conductor']);
    await closeSwitcher();

    await pickApp('pl');
    expect(location.hash, 'picking a plugin opens it').toBe('#plugin/pl/');
    expect(viewOpen()).toBe(true);
    menu = await openSwitcher();
    expect(checkedApps(menu), 'Conductor → plugin').toEqual(['pl']);
    await closeSwitcher();

    await pickApp('ka');
    expect(location.hash).toBe('#plugin/ka/');
    menu = await openSwitcher();
    expect(checkedApps(menu), 'plugin → plugin').toEqual(['ka']);
    await closeSwitcher();

    await pickApp('conductor');
    expect(location.hash, 'Conductor returns to the active session\'s anchor').toBe(`#session=${ACTIVE.sessionId}`);
    expect(viewOpen()).toBe(false);
    menu = await openSwitcher();
    expect(checkedApps(menu), 'plugin → Conductor').toEqual(['conductor']);
    await closeSwitcher();

    await pickApp('pl');
    menu = await openSwitcher();
    expect(checkedApps(menu), 'precondition: the plugin is current again').toEqual(['pl']);
    await closeSwitcher();
    await go('#session=abc');
    expect(viewOpen(), 'an outside hash change closes the plugin view').toBe(false);
    menu = await openSwitcher();
    expect(checkedApps(menu), 'an outside hash change away from the plugin').toEqual(['conductor']);
    await closeSwitcher();
  });

  it('shows the open plugin\'s nav label, not its name, on the trigger itself', async () => {
    // Invariant: while a plugin whose navLabel differs from its name is current, the switcher trigger shows the navLabel.
    net.catalog = [app('ka', 'Keep Plugin', { navLabel: 'Keeper' }), app('pl', 'Plain')];
    net.status = { ka: keepRow(), pl: plainRow() };
    await mountApp();
    expect(switcher()!.textContent, 'fixture check: on Conductor the trigger reads the sidebar title, so its text renders').toBeTruthy();
    await go('#plugin/ka/');
    expect(location.hash, 'fixture check: the plugin is open').toBe('#plugin/ka/');
    const text = switcher()!.textContent ?? '';
    expect(text, 'the trigger reads the nav label').toContain('Keeper');
    expect(text, 'and not the name').not.toContain('Keep Plugin');
  });

  it('shows the open plugin\'s name on the trigger when it has no nav label', async () => {
    // Invariant: while a plugin with no navLabel is current, the switcher trigger shows its name, never blank.
    net.catalog = [app('ka', 'Keep Plugin', { navLabel: 'Keeper' }), app('pl', 'Plain')];
    net.status = { ka: keepRow(), pl: plainRow() };
    await mountApp();
    await go('#plugin/pl/');
    expect(location.hash, 'fixture check: the plugin is open').toBe('#plugin/pl/');
    expect(switcher()!.textContent, 'the trigger reads the name').toContain('Plain');
  });

  it('a plugin dropped from the switcher while its view is open leaves Conductor as the one current entry', async () => {
    net.catalog = [app('ka', 'Keep'), app('pl', 'Plain')];
    net.status = { ka: keepRow(), pl: plainRow() };
    await mountApp();
    await pickApp('ka');
    let menu = await openSwitcher();
    expect(checkedApps(menu), 'precondition: the open plugin is current').toEqual(['ka']);
    await closeSwitcher();
    // Settings → Plugins → disable: the catalog drops the plugin and the change is announced, naming no action.
    net.catalog = [app('pl', 'Plain')];
    net.status.ka = keepRow({ enabled: false, state: 'disabled' });
    await act(async () => { notifyPluginsChanged(undefined); });
    await settle();
    expect(location.hash, 'fixture check: the route still names the plugin').toBe('#plugin/ka/');
    menu = await openSwitcher();
    expect(switcherEntries(menu).map(entryId), 'fixture check: the plugin left the switcher').toEqual(['conductor', 'pl']);
    expect(checkedApps(menu)).toEqual(['conductor']);
  });

  it('picking Conductor while the route still names a plugin the switcher no longer lists leaves that plugin\'s view', async () => {
    net.catalog = [app('ka', 'Keep'), app('pl', 'Plain')];
    net.status = { ka: keepRow(), pl: plainRow() };
    await mountApp();
    await pickApp('ka');
    net.catalog = [app('pl', 'Plain')];
    net.status.ka = keepRow({ enabled: false, state: 'disabled' });
    await act(async () => { notifyPluginsChanged(undefined); });
    await settle();
    expect(location.hash, 'fixture check: the route still names the plugin').toBe('#plugin/ka/');
    const menu = await openSwitcher();
    expect(checkedApps(menu), 'precondition: Conductor is the one current entry').toEqual(['conductor']);
    await closeSwitcher();
    await pickApp('conductor');
    expect(location.hash, 'back at the active session\'s anchor').toBe(`#session=${ACTIVE.sessionId}`);
    expect(viewOpen(), 'the plugin view closed').toBe(false);
  });

  it('another view taking the hash from a plugin closes the plugin view and makes Conductor current', async () => {
    net.catalog = [app('pl', 'Plain')];
    net.status = { pl: plainRow() };
    await mountApp();
    await pickApp('pl');
    expect(viewOpen(), 'precondition: in the plugin').toBe(true);
    await act(async () => { openCommits('p'); });
    await settle();
    expect(document.querySelector('[data-view="commits"]'), 'fixture check: Commits took the main area').not.toBeNull();
    expect(viewOpen()).toBe(false);
    expect(sharedFrame(), 'the plain plugin\'s frame ended').toBeNull();
    const menu = await openSwitcher();
    expect(checkedApps(menu)).toEqual(['conductor']);
  });

  it('a plugin whose frame stays resident reads differently in the menu from its first entry until it is evicted, and no other entry changes', async () => {
    net.catalog = [app('ka', 'Keep'), app('pl', 'Plain')];
    net.status = { ka: keepRow(), pl: plainRow() };
    await mountApp();
    const plain = await labels();
    await pickApp('ka');
    let now = await labels();
    expect(now.ka, 'marked once resident').not.toBe(plain.ka);
    expect(now.ka.startsWith(plain.ka), 'still named first').toBe(true);
    expect(now.pl, 'other entries unchanged').toBe(plain.pl);
    expect(now.conductor).toBe(plain.conductor);
    await pickApp('pl');
    now = await labels();
    expect(now.ka, 'still marked while another plugin shows').not.toBe(plain.ka);
    expect(now.pl, 'a plain plugin is never marked').toBe(plain.pl);
    await pickApp('conductor');
    now = await labels();
    expect(now.ka, 'still marked while hidden').not.toBe(plain.ka);
    await act(async () => { notifyPluginsChanged({ action: 'restart', ids: ['ka'] }); });
    await settle();
    expect(residentFrame('ka'), 'fixture check: evicted').toBeNull();
    now = await labels();
    expect(now.ka, 'eviction clears the mark').toBe(plain.ka);
  });

  it('a Settings → Plugins action evicts the resident frames of exactly the plugins it names', async () => {
    net.catalog = [app('ka', 'Keep A'), app('kb', 'Keep B')];
    net.status = { ka: keepRow(), kb: keepRow() };
    await mountApp();
    await pickApp('ka');
    await pickApp('kb');
    await pickApp('conductor');
    const ka = residentFrame('ka')!;
    const kb = residentFrame('kb')!;
    expect(ka.isConnected && kb.isConnected, 'precondition: both resident').toBe(true);
    await act(async () => { notifyPluginsChanged({ action: 'restart', ids: ['kb'] }); });
    await settle();
    expect(kb.isConnected, 'the named one').toBe(false);
    expect(residentFrame('ka') === ka && ka.isConnected, 'the other one stays').toBe(true);
    await act(async () => { notifyPluginsChanged({ action: 'version', ids: ['ka'] }); });
    await settle();
    expect(ka.isConnected).toBe(false);
  });

  it('picking the app that is already current changes nothing: Conductor from Conductor, and a plugin from itself after its page moved', async () => {
    net.catalog = [app('ka', 'Keep')];
    net.status = { ka: keepRow() };
    await mountApp();
    const startLength = history.length;
    const startHash = location.hash;
    await pickApp('conductor');
    expect(location.hash, 'Conductor from Conductor').toBe(startHash);
    expect(history.length).toBe(startLength);
    await pickApp('ka');
    const win = standInWindow(residentFrame('ka')!);
    postRoute(win, '/call/42');
    expect(location.hash, 'precondition: the page\'s own route is in the hash').toBe('#plugin/ka/call/42');
    const inPlugin = history.length;
    await pickApp('ka');
    expect(location.hash).toBe('#plugin/ka/call/42');
    expect(history.length).toBe(inPlugin);
    expect(win.posted, 'the page is not moved').toEqual([]);
  });
});
