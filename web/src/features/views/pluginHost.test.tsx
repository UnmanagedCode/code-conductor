// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
// The plugin host as the app mounts it: the plugin view across its hash space,
// the keep-alive routing rules, the hash and the frame kept in step, and what
// reconcile and a re-entry keep or evict. Frames load no document here, so a
// frame's survival is its node, its src and the requests made for it.
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
vi.mock('@/features/dialogs/DialogsHost', () => ({ DialogsHost: () => null }));

import { parseHash, routeStore, syncRoute } from '@/state/route';
import { overlayStore, pluginFrames, residentSignal } from './plugins';
import {
  endHost, go, holdStatus, keepRow, mountApp, navigate, net, plainRow, pluginView, postFrom, postRoute, resetHost, residentFrame,
  settle, sharedFrame, shownFrames, standInWindow, viewOpen, type Answer, type StatusRow,
} from './test/pluginHost';

beforeEach(() => resetHost());
afterEach(() => endHost());

/** Shows each plugin in turn, then leaves the plugin space, so each keep-alive one is resident and hidden. */
async function visit(...ids: string[]) {
  for (const id of ids) await go(`#plugin/${id}/`);
  await go('#');
}

describe('the plugin view and its hash space', () => {
  it('stays open on the same frame while the hash moves within a plugin\'s space, and closes on a hash outside it', async () => {
    net.status = { alpha: plainRow() };
    await mountApp();
    await go('#plugin/alpha/');
    expect(viewOpen(), 'precondition: open on the plugin hash').toBe(true);
    const frame = sharedFrame()!;
    const win = standInWindow(frame);
    await go('#plugin/alpha/deeper/path');
    expect(viewOpen()).toBe(true);
    expect(sharedFrame() === frame, 'the same frame').toBe(true);
    expect(frame.getAttribute('src'), 'not reloaded').toBe('/plugins/alpha/');
    expect(win.posted, 'steered by the bridge').toEqual([navigate('/deeper/path')]);
    expect(document.querySelector('[data-view="session"]'), 'no other main view').toBeNull();
    await go('#session=abc');
    expect(viewOpen()).toBe(false);
    expect(frame.isConnected, 'leaving ends a plain plugin\'s frame').toBe(false);
    expect(document.querySelector('[data-view="session"]')).not.toBeNull();
  });

  it('opens a full-page view only on its exact hash, and the plugin space on every hash under #plugin/', () => {
    expect(parseHash('#costs').view).toBe('costs');
    expect(parseHash('#costs2').view).toBe('session');
    expect(parseHash('#commits').view).toBe('commits');
    expect(parseHash('#commits/x').view).toBe('session');
    expect(parseHash('#review').view).toBe('review');
    expect(parseHash('#reviews').view).toBe('session');
    expect(parseHash('#plugin/a/deeper/path')).toMatchObject({ view: 'plugin', pluginId: 'a', pluginPath: 'deeper/path' });
    expect(parseHash('#plugin/a')).toMatchObject({ view: 'plugin', pluginId: 'a', pluginPath: '' });
    expect(parseHash('#pluginx').view).toBe('session');
  });

  it('opening on a plugin hash loads it into the view, another plugin swaps in a fresh frame, and leaving removes it', async () => {
    net.status = { alpha: plainRow(), beta: plainRow() };
    await mountApp();
    expect(viewOpen(), 'precondition: closed').toBe(false);
    await go('#plugin/alpha/');
    expect(viewOpen()).toBe(true);
    const a = sharedFrame()!;
    expect(a.getAttribute('src')).toBe('/plugins/alpha/');
    expect(net.calls).toContain('GET /api/plugins/alpha/status');
    expect(net.calls.some((c) => c.endsWith('/start')), 'a ready plugin needs no start').toBe(false);
    expect(residentFrame('alpha'), 'a plain plugin gets no resident frame').toBeNull();
    await go('#plugin/beta/');
    const b = sharedFrame()!;
    expect(b === a, 'a fresh frame').toBe(false);
    expect(b.getAttribute('src')).toBe('/plugins/beta/');
    expect(a.isConnected).toBe(false);
    expect(pluginView().querySelectorAll('iframe').length).toBe(1);
    await go('#');
    expect(viewOpen()).toBe(false);
    expect(pluginView().querySelectorAll('iframe').length).toBe(0);
  });

  it('a load event from the page being replaced leaves the entered plugin\'s Starting overlay up, and the entered plugin\'s own page load clears it', async () => {
    net.status = { a: plainRow(), b: plainRow({ state: 'stopped' }) };
    await mountApp();
    await go('#plugin/a/');
    const a = sharedFrame()!;
    let release!: (r: Response) => void;
    net.heldStart = new Promise((r) => { release = r; });
    await go('#plugin/b/');
    expect(overlayStore.get().overlay, 'precondition: b is starting behind the overlay').not.toBeNull();
    expect(sharedFrame() === a, 'fixture check: a\'s page is still in the view').toBe(true);
    act(() => { a.dispatchEvent(new Event('load')); });
    expect(overlayStore.get().overlay, 'a\'s page loading again does not clear b\'s overlay').not.toBeNull();
    await act(async () => { release(new Response(JSON.stringify({ state: 'ready' }))); });
    await settle();
    const b = sharedFrame()!;
    expect(b !== a && b.getAttribute('src') === '/plugins/b/', 'fixture check: b\'s page is mounted').toBe(true);
    expect(overlayStore.get().overlay, 'precondition: the overlay waits for b\'s page').not.toBeNull();
    act(() => { b.dispatchEvent(new Event('load')); });
    expect(overlayStore.get().overlay, 'positive control: b\'s own page load clears it').toBeNull();
  });

  it('a load event from a hidden resident page leaves the entered keep-alive plugin\'s Starting overlay up, and that plugin\'s own page load clears it', async () => {
    net.status = { ka: keepRow({ state: 'stopped' }), kb: keepRow({ state: 'stopped' }) };
    await mountApp();
    let release!: (r: Response) => void;
    net.heldStart = new Promise((r) => { release = r; });
    await go('#plugin/ka/');
    await act(async () => { release(new Response(JSON.stringify({ state: 'ready' }))); });
    await settle();
    const ka = residentFrame('ka')!;
    expect(!!ka, 'fixture check: ka\'s resident frame mounted after its start').toBe(true);
    net.heldStart = new Promise((r) => { release = r; });
    await go('#plugin/kb/');
    expect(overlayStore.get().overlay, 'precondition: kb is starting behind the overlay').not.toBeNull();
    expect(ka.hidden && ka.isConnected, 'fixture check: ka\'s page is resident and hidden').toBe(true);
    act(() => { ka.dispatchEvent(new Event('load')); });
    expect(overlayStore.get().overlay, 'ka\'s page loading does not clear kb\'s overlay').not.toBeNull();
    await act(async () => { release(new Response(JSON.stringify({ state: 'ready' }))); });
    await settle();
    const kb = residentFrame('kb')!;
    expect(!!kb && kb !== ka, 'fixture check: kb\'s resident frame is mounted').toBe(true);
    expect(overlayStore.get().overlay, 'precondition: the overlay waits for kb\'s page').not.toBeNull();
    act(() => { kb.dispatchEvent(new Event('load')); });
    expect(overlayStore.get().overlay, 'positive control: kb\'s own page load clears it').toBeNull();
  });

  it('booting directly on a plugin hash opens the view at that subpath', async () => {
    net.status = { alpha: plainRow() };
    history.replaceState(null, '', '/#plugin/alpha/dashboard');
    syncRoute();
    await mountApp();
    expect(viewOpen()).toBe(true);
    expect(sharedFrame()?.getAttribute('src')).toBe('/plugins/alpha/dashboard');
  });
});

describe('keep-alive routing', () => {
  describe('a keep-alive plugin entered cold at a non-root subpath mounts its frame there', () => {
    it('booting directly on the hash', async () => {
      net.status = { ka: keepRow() };
      history.replaceState(null, '', '/#plugin/ka/call/7');
      syncRoute();
      await mountApp();
      expect(residentFrame('ka')?.getAttribute('src')).toBe('/plugins/ka/call/7');
      expect(sharedFrame()).toBeNull();
    });

    it('entering by hash', async () => {
      net.status = { ka: keepRow() };
      await mountApp();
      await go('#plugin/ka/call/7');
      expect(residentFrame('ka')?.getAttribute('src')).toBe('/plugins/ka/call/7');
      expect(sharedFrame()).toBeNull();
    });
  });

  it('re-entry at the bare plugin hash keeps the frame on its own route, rewrites the hash to it, and starts nothing', async () => {
    net.status = { ka: keepRow() };
    await mountApp();
    await go('#plugin/ka/');
    const frame = residentFrame('ka')!;
    const win = standInWindow(frame);
    postRoute(win, '/call/42');
    expect(location.hash, 'precondition: the showing frame\'s route mirrors into the hash').toBe('#plugin/ka/call/42');
    await go('#');
    // A crashed row keeps the frame; a fresh load would POST /start for it.
    net.status.ka = keepRow({ state: 'crashed' });
    const before = net.calls.length;
    await go('#plugin/ka/');
    expect(location.hash).toBe('#plugin/ka/call/42');
    expect(win.posted, 'no navigate').toEqual([]);
    expect(net.calls.slice(before), 'one background status read, no /start').toEqual(['GET /api/plugins/ka/status']);
    expect(residentFrame('ka') === frame && !frame.hidden, 'the same frame, shown').toBe(true);
    expect(frame.getAttribute('src')).toBe('/plugins/ka/');
    expect(overlayStore.get().overlay, 'no Starting overlay').toBeNull();
  });

  it('re-entry at a different non-root subpath steers the resident frame there with a navigate', async () => {
    net.status = { ka: keepRow() };
    await mountApp();
    await go('#plugin/ka/');
    const frame = residentFrame('ka')!;
    const win = standInWindow(frame);
    postRoute(win, '/call/42');
    await go('#');
    await go('#plugin/ka/settings');
    expect(win.posted).toEqual([navigate('/settings')]);
    expect(location.hash).toBe('#plugin/ka/settings');
    expect(residentFrame('ka') === frame, 'the same frame').toBe(true);
    expect(frame.getAttribute('src'), 'steered, not reloaded').toBe('/plugins/ka/');
    await go('#');
    await go('#plugin/ka/');
    expect(location.hash, 'the steered route is the one tracked').toBe('#plugin/ka/settings');
  });

  it('re-entry at the frame\'s own tracked route posts no navigate', async () => {
    net.status = { ka: keepRow() };
    await mountApp();
    await go('#plugin/ka/');
    const win = standInWindow(residentFrame('ka')!);
    postRoute(win, '/call/42');
    await go('#');
    await go('#plugin/ka/call/42');
    expect(win.posted, 'the frame is already there').toEqual([]);
    expect(location.hash).toBe('#plugin/ka/call/42');
  });

  describe('a route message whose path lacks a leading slash is ignored', () => {
    it('from a hidden frame', async () => {
      net.status = { ka: keepRow() };
      await mountApp();
      await go('#plugin/ka/');
      const win = standInWindow(residentFrame('ka')!);
      postRoute(win, '/call/1');
      await go('#session=abc');
      postRoute(win, 'evil');
      expect(location.hash, 'the hash is untouched while hidden').toBe('#session=abc');
      await go('#plugin/ka/');
      expect(location.hash, 're-entry lands on the tracked route, not on #plugin/kaevil').toBe('#plugin/ka/call/1');
    });

    it('from the showing frame', async () => {
      net.status = { ka: keepRow() };
      await mountApp();
      await go('#plugin/ka/');
      const win = standInWindow(residentFrame('ka')!);
      postRoute(win, '/call/1');
      expect(location.hash, 'precondition: a route with its slash mirrors').toBe('#plugin/ka/call/1');
      postRoute(win, 'evil');
      expect(location.hash, 'not mirrored into the hash').toBe('#plugin/ka/call/1');
      await go('#');
      await go('#plugin/ka/');
      expect(location.hash, 'not tracked either').toBe('#plugin/ka/call/1');
    });
  });

  it('a route-shaped message without the bridge\'s {cc:1} envelope moves neither the hash nor the route store, nor is it tracked', async () => {
    net.status = { ka: keepRow() };
    await mountApp();
    await go('#plugin/ka/');
    const win = standInWindow(residentFrame('ka')!);
    postRoute(win, '/call/1');
    expect(location.hash, 'positive control: an enveloped route mirrors into the hash').toBe('#plugin/ka/call/1');
    expect(routeStore.get().route.pluginPath, 'and into the route store').toBe('call/1');
    postFrom(win, { type: 'route', path: '/bare' });
    postFrom(win, { cc: 2, type: 'route', path: '/other' });
    expect(location.hash, 'not mirrored into the hash').toBe('#plugin/ka/call/1');
    expect(routeStore.get().route.pluginPath, 'nor into the route store').toBe('call/1');
    await go('#');
    await go('#plugin/ka/');
    expect(location.hash, 'nor tracked').toBe('#plugin/ka/call/1');
  });

  it('A (keep-alive) → B (plain) → A keeps A\'s frame and removes B\'s', async () => {
    net.status = { a: keepRow(), b: plainRow() };
    await mountApp();
    await go('#plugin/a/');
    const a = residentFrame('a')!;
    await go('#plugin/b/');
    const shared = sharedFrame()!;
    expect(shared.getAttribute('src')).toBe('/plugins/b/');
    expect(residentFrame('b'), 'a plain plugin gets no resident frame').toBeNull();
    expect(a.hidden).toBe(true);
    expect(shownFrames().length === 1 && shownFrames()[0] === shared, 'only B shows').toBe(true);
    await go('#plugin/a/');
    expect(residentFrame('a') === a, 'one resident node for A throughout').toBe(true);
    expect(a.getAttribute('src')).toBe('/plugins/a/');
    expect(shared.isConnected, 'B\'s frame is removed').toBe(false);
    expect(sharedFrame()).toBeNull();
    expect(shownFrames().length === 1 && shownFrames()[0] === a, 'only A shows').toBe(true);
    await go('#plugin/b/');
    const fresh = sharedFrame();
    expect(!!fresh && fresh !== shared, 'returning to B loads a fresh frame').toBe(true);
    expect(fresh?.getAttribute('src')).toBe('/plugins/b/');
    expect(a.hidden).toBe(true);
  });

  it('two keep-alive plugins get one resident frame each, and each keeps its own route', async () => {
    net.status = { one: keepRow(), two: keepRow() };
    await mountApp();
    await go('#plugin/one/');
    const one = residentFrame('one')!;
    postRoute(standInWindow(one), '/a');
    await go('#plugin/two/');
    const two = residentFrame('two')!;
    postRoute(standInWindow(two), '/b');
    await go('#plugin/one/');
    expect(pluginView().querySelectorAll('iframe[data-plugin-frame="resident"]').length, 'a revisit adds no frame').toBe(2);
    expect(residentFrame('one') === one && residentFrame('two') === two).toBe(true);
    expect(one.hidden).toBe(false);
    expect(two.hidden).toBe(true);
    expect(two.getAttribute('src'), 'the hidden one is not blanked').toBe('/plugins/two/');
    expect(location.hash, 'one is back on its own route').toBe('#plugin/one/a');
    expect([...pluginFrames.residentIds()].sort()).toEqual(['one', 'two']);
    await go('#plugin/two/');
    expect(one.hidden).toBe(true);
    expect(two.hidden).toBe(false);
    expect(location.hash, 'two is back on its own route').toBe('#plugin/two/b');
  });

  it('a hidden resident frame\'s route message updates its record but never the hash', async () => {
    net.status = { ka: keepRow(), b: plainRow() };
    await mountApp();
    await go('#plugin/ka/');
    const win = standInWindow(residentFrame('ka')!);
    await go('#session=abc');
    postRoute(win, '/call/1');
    expect(location.hash, 'the view closed').toBe('#session=abc');
    await go('#plugin/b/');
    postRoute(win, '/call/2');
    expect(location.hash, 'another plugin showing').toBe('#plugin/b/');
    await go('#plugin/ka/');
    expect(location.hash, 're-entry lands on the route the hidden frame reported last').toBe('#plugin/ka/call/2');
  });
});

describe('the hash and the frame stay in step', () => {
  it('the route store follows the hash a showing frame\'s route writes', async () => {
    net.status = { p: plainRow() };
    await mountApp();
    await go('#plugin/p/');
    const win = standInWindow(sharedFrame()!);
    postRoute(win, '/inner');
    expect(location.hash, 'precondition: the route mirrors into the hash').toBe('#plugin/p/inner');
    expect(routeStore.get().route.hash).toBe('#plugin/p/inner');
    expect(routeStore.get().route.pluginPath).toBe('inner');
  });

  it('after the plugin page moves itself, an outside change back to the subpath the hash named before reaches the frame', async () => {
    net.status = { p: plainRow() };
    await mountApp();
    await go('#plugin/p/');
    const win = standInWindow(sharedFrame()!);
    await go('#plugin/p/sub/a');
    expect(win.posted, 'precondition: an outside subpath change steers the frame').toEqual([navigate('/sub/a')]);
    postRoute(win, '/inner');
    await settle();
    await go('#plugin/p/sub/a');
    expect(win.posted).toEqual([navigate('/sub/a'), navigate('/sub/a')]);
    expect(location.hash).toBe('#plugin/p/sub/a');
  });

  it('after a keep-alive re-entry rewrote the hash to the frame\'s route, an outside change to the bare plugin hash reaches the frame', async () => {
    net.status = { ka: keepRow() };
    await mountApp();
    await go('#plugin/ka/');
    const win = standInWindow(residentFrame('ka')!);
    postRoute(win, '/call/42');
    await go('#');
    await go('#plugin/ka/');
    expect(location.hash, 'precondition: re-entry rewrote the hash to the frame\'s route').toBe('#plugin/ka/call/42');
    expect(win.posted, 'precondition: and posted nothing').toEqual([]);
    await go('#plugin/ka/');
    expect(win.posted).toEqual([navigate('/')]);
    expect(routeStore.get().route.pluginPath).toBe('');
  });

  it('a route message from the page being replaced while another plugin loads moves neither the hash nor the route store, and the entered plugin loads where it was asked', async () => {
    net.status = { a: plainRow(), b: plainRow({ state: 'stopped' }) };
    await mountApp();
    await go('#plugin/a/');
    const a = sharedFrame()!;
    const win = standInWindow(a);
    postRoute(win, '/at-a');
    expect(location.hash, 'positive control: the showing page\'s route mirrors into the hash').toBe('#plugin/a/at-a');
    let release!: (r: Response) => void;
    net.heldStart = new Promise((r) => { release = r; });
    await go('#plugin/b/');
    expect(overlayStore.get().overlay, 'precondition: b is starting').not.toBeNull();
    expect(sharedFrame() === a, 'fixture check: a\'s page is still in the view').toBe(true);
    postRoute(win, '/from-a');
    expect(location.hash).toBe('#plugin/b/');
    expect(routeStore.get().route).toMatchObject({ pluginId: 'b', pluginPath: '' });
    await act(async () => { release(new Response(JSON.stringify({ state: 'ready' }))); });
    await settle();
    expect(sharedFrame()?.getAttribute('src'), 'b loads where it was asked').toBe('/plugins/b/');
    expect(location.hash).toBe('#plugin/b/');
  });

  it('an outside subpath change while another plugin loads steers only the plugin being entered, never the page being replaced', async () => {
    net.status = { a: plainRow(), b: plainRow({ state: 'stopped' }) };
    await mountApp();
    await go('#plugin/a/');
    const a = sharedFrame()!;
    const win = standInWindow(a);
    await go('#plugin/a/sub');
    expect(win.posted, 'positive control: a subpath change steers the showing page').toEqual([navigate('/sub')]);
    let release!: (r: Response) => void;
    net.heldStart = new Promise((r) => { release = r; });
    await go('#plugin/b/');
    expect(sharedFrame() === a, 'fixture check: a\'s page is still in the view').toBe(true);
    await go('#plugin/b/x');
    expect(win.posted, 'a\'s page is not steered').toEqual([navigate('/sub')]);
    await act(async () => { release(new Response(JSON.stringify({ state: 'ready' }))); });
    await settle();
    expect(sharedFrame()?.getAttribute('src'), 'b loads at the subpath').toBe('/plugins/b/x');
  });
});

describe('reconcile and the keep-alive edge cases', () => {
  it('reconcile evicts a resident frame whose row no longer qualifies, and only that one: stopped, disabled, invalid, keep-alive dropped, a 404', async () => {
    const cases: [string, Answer][] = [
      ['stopped', keepRow({ state: 'stopped' })],
      ['disabled', keepRow({ enabled: false, state: 'disabled' })],
      ['invalid', keepRow({ state: 'invalid' })],
      ['keep-alive dropped', keepRow({ frontendKeepAlive: false })],
      ['404', 404],
    ];
    await mountApp();
    for (const [label, row] of cases) {
      net.status = { ka: keepRow(), kb: keepRow() };
      await visit('ka', 'kb');
      const ka = residentFrame('ka')!;
      const kb = residentFrame('kb')!;
      let changes = 0;
      const stop = residentSignal.subscribe(() => { changes++; });
      net.status.ka = row;
      await act(async () => { await pluginFrames.reconcile(undefined); });
      stop();
      expect(ka.isConnected, `${label}: the frame is removed`).toBe(false);
      expect(pluginFrames.residentIds(), `${label}: only that plugin's`).toEqual(['kb']);
      expect(residentFrame('kb') === kb && kb.isConnected, `${label}: the qualifying one stays`).toBe(true);
      expect(changes, `${label}: one resident-set change`).toBe(1);
      net.status.ka = keepRow();
      const before = net.calls.length;
      await go('#plugin/ka/');
      expect(net.calls.slice(before), `${label}: re-entry loads afresh`).toContain('GET /api/plugins/ka/status');
      const fresh = residentFrame('ka');
      expect(!!fresh && fresh !== ka, `${label}: a new resident frame`).toBe(true);
      expect(fresh?.getAttribute('src')).toBe('/plugins/ka/');
      await go('#');
      await act(async () => { await pluginFrames.reconcile({ action: 'restart', ids: ['ka', 'kb'] }); });
    }
  });

  it('reconcile keeps a resident frame on crashed, failed, starting, a 5xx, a network error and an unreadable body, while a 404 in the same pass evicts', async () => {
    const cases: [string, Answer][] = [
      ['crashed', keepRow({ state: 'crashed' })],
      ['failed', keepRow({ state: 'failed' })],
      ['starting', keepRow({ state: 'starting' })],
      ['500', 500],
      ['network error', 'network'],
      ['a 200 whose body does not parse', 'unreadable'],
    ];
    await mountApp();
    for (const [label, row] of cases) {
      net.status = { ka: keepRow(), kz: keepRow() };
      await visit('ka', 'kz');
      const ka = residentFrame('ka')!;
      const kz = residentFrame('kz')!;
      net.status.ka = row;
      net.status.kz = 404;
      await act(async () => { await pluginFrames.reconcile(undefined); });
      expect(kz.isConnected, `${label}: positive control: the 404 evicts`).toBe(false);
      expect(residentFrame('ka') === ka && ka.isConnected, `${label}: kept`).toBe(true);
      expect(ka.getAttribute('src'), `${label}: not reloaded`).toBe('/plugins/ka/');
      expect(pluginFrames.residentIds(), label).toEqual(['ka']);
      await act(async () => { await pluginFrames.reconcile({ action: 'restart', ids: ['ka'] }); });
    }
  });

  it('reconcile evicts the frames a Settings action put new code under — restart, update, version — and only the plugins it names', async () => {
    await mountApp();
    for (const action of ['restart', 'update', 'version']) {
      net.status = { ka: keepRow(), kb: keepRow() };
      await visit('ka', 'kb');
      const ka = residentFrame('ka')!;
      const kb = residentFrame('kb')!;
      // Both rows still qualify (a restarted backend reads ready): only the action evicts.
      await act(async () => { await pluginFrames.reconcile({ action, ids: ['ka'] }); });
      expect(ka.isConnected, `${action}: the named plugin's frame is removed`).toBe(false);
      expect(residentFrame('kb') === kb && kb.isConnected, `${action}: the other one stays`).toBe(true);
      expect(pluginFrames.residentIds(), action).toEqual(['kb']);
      await act(async () => { await pluginFrames.reconcile({ action: 'restart', ids: ['kb'] }); });
    }
  });

  it('reconcile keeps a frame through a crash, a lazy restart, an evicting action naming another plugin, and a non-evicting action naming it', async () => {
    const cases: [string, Answer, { action: string; ids: string[] } | undefined][] = [
      ['crash', keepRow({ state: 'crashed' }), undefined],
      ['lazy restart', keepRow({ state: 'starting' }), undefined],
      ['restart of another plugin', keepRow(), { action: 'restart', ids: ['kz'] }],
      ['a non-evicting action naming it', keepRow(), { action: 'start', ids: ['ka'] }],
    ];
    await mountApp();
    for (const [label, row, change] of cases) {
      net.status = { ka: keepRow(), kz: keepRow() };
      await visit('ka', 'kz');
      const ka = residentFrame('ka')!;
      const kz = residentFrame('kz')!;
      net.status.ka = row;
      net.status.kz = 404;
      await act(async () => { await pluginFrames.reconcile(change); });
      expect(kz.isConnected, `${label}: positive control: the other plugin is evicted`).toBe(false);
      expect(residentFrame('ka') === ka && ka.isConnected, `${label}: kept`).toBe(true);
      expect(ka.getAttribute('src'), `${label}: not reloaded`).toBe('/plugins/ka/');
      await act(async () => { await pluginFrames.reconcile({ action: 'restart', ids: ['ka'] }); });
    }
  });

  it('reconcile evicting the showing frame neither starts it nor loads it again, and the next move in the open view loads the plugin afresh', async () => {
    net.status = { ka: keepRow() };
    await mountApp();
    await go('#plugin/ka/');
    const ka = residentFrame('ka')!;
    net.status.ka = keepRow({ state: 'stopped' });
    const before = net.calls.length;
    await act(async () => { await pluginFrames.reconcile(undefined); });
    await settle();
    expect(ka.isConnected, 'evicted').toBe(false);
    expect(net.calls.slice(before), 'its own status read only').toEqual(['GET /api/plugins/ka/status']);
    expect(pluginView().querySelectorAll('iframe').length, 'no replacement frame').toBe(0);
    expect(pluginFrames.residentIds()).toEqual([]);
    net.status.ka = keepRow();
    await go('#plugin/ka/x');
    const fresh = residentFrame('ka');
    expect(!!fresh && fresh !== ka, 'a fresh frame, not a navigate to the removed one').toBe(true);
    expect(fresh?.getAttribute('src')).toBe('/plugins/ka/x');
  });

  it('re-entry\'s background check keeps a qualifying frame, and evicts it and loads afresh once the row is disabled', async () => {
    net.status = { ka: keepRow() };
    net.refuseStart = true;
    await mountApp();
    await visit('ka');
    const ka = residentFrame('ka')!;
    let before = net.calls.length;
    await go('#plugin/ka/');
    expect(net.calls.slice(before), 'the check ran').toEqual(['GET /api/plugins/ka/status']);
    expect(residentFrame('ka') === ka && !ka.hidden, 'positive control: a qualifying row keeps the frame').toBe(true);
    await go('#');
    net.status.ka = keepRow({ enabled: false, state: 'disabled' });
    before = net.calls.length;
    await go('#plugin/ka/');
    expect(ka.isConnected).toBe(false);
    expect(pluginFrames.residentIds()).toEqual([]);
    expect(net.calls.slice(before), 'reloaded the plain way').toContain('POST /api/plugins/ka/start');
    expect(overlayStore.get().overlay?.message).toContain('plugin is disabled');
    expect(within(pluginView()).getByRole('button', { name: /Retry/ })).toBeTruthy();
  });

  it('leaving a keep-alive plugin mid-start creates no resident frame, while a start left to finish does', async () => {
    net.status = { ka: keepRow({ state: 'stopped' }), kb: keepRow({ state: 'stopped' }) };
    await mountApp();
    await go('#plugin/kb/');
    expect(residentFrame('kb'), 'positive control: a start left to finish mounts the frame').not.toBeNull();
    let release!: (r: Response) => void;
    net.heldStart = new Promise((r) => { release = r; });
    await go('#plugin/ka/');
    expect(overlayStore.get().overlay, 'precondition: starting behind the overlay').not.toBeNull();
    await go('#');
    await act(async () => { release(new Response(JSON.stringify({ state: 'ready' }))); });
    await settle();
    expect(residentFrame('ka')).toBeNull();
    expect(pluginFrames.residentIds()).toEqual(['kb']);
  });

  it('leaving a plugin while its status read is pending mounts no frame and starts nothing, while a read left to finish loads it', async () => {
    net.status = { ka: keepRow(), pl: plainRow(), st: keepRow({ state: 'stopped' }) };
    await mountApp();
    let release = holdStatus('pl');
    await go('#plugin/pl/');
    expect(sharedFrame(), 'precondition: nothing mounts while the read is pending').toBeNull();
    await release(plainRow());
    expect(sharedFrame()?.getAttribute('src'), 'positive control: a read left to finish loads the plugin').toBe('/plugins/pl/');
    await go('#');
    const cases: [string, StatusRow][] = [['ka', keepRow()], ['pl', plainRow()], ['st', keepRow({ state: 'stopped' })]];
    for (const [id, row] of cases) {
      release = holdStatus(id);
      await go(`#plugin/${id}/`);
      await go('#');
      const before = net.calls.length;
      await release(row);
      expect(pluginView().querySelectorAll('iframe').length, `${id}: no frame`).toBe(0);
      expect(pluginFrames.residentIds(), id).toEqual([]);
      expect(net.calls.slice(before), `${id}: no /start`).toEqual([]);
      expect(overlayStore.get().overlay, `${id}: no overlay`).toBeNull();
    }
  });

  it('a re-entry left before its background check answers neither evicts the frame nor reloads it, even once the row reads disabled', async () => {
    const disabled = keepRow({ enabled: false, state: 'disabled' });
    net.status = { ka: keepRow(), pl: plainRow() };
    net.refuseStart = true;
    await mountApp();
    await visit('ka');
    const ka = residentFrame('ka')!;
    for (const [how, away] of [['leaving the view', '#'], ['entering another plugin', '#plugin/pl/']]) {
      const release = holdStatus('ka');
      await go('#plugin/ka/');
      expect(ka.hidden, `${how}: precondition: re-entry revealed the frame`).toBe(false);
      await go(away);
      net.status.ka = disabled;
      const before = net.calls.length;
      await release(disabled);
      expect(residentFrame('ka') === ka && ka.isConnected, `${how}: not evicted`).toBe(true);
      expect(ka.hidden, `${how}: still hidden`).toBe(true);
      expect(pluginFrames.residentIds(), how).toEqual(['ka']);
      expect(net.calls.slice(before), `${how}: no reload, no /start`).toEqual([]);
      expect(overlayStore.get().overlay, `${how}: no overlay`).toBeNull();
      net.status.ka = keepRow();
      await go('#');
    }
    const release = holdStatus('ka');
    await go('#plugin/ka/');
    net.status.ka = disabled;
    const before = net.calls.length;
    await release(disabled);
    expect(ka.isConnected, 'positive control: a re-entry still showing evicts on the same answer').toBe(false);
    expect(net.calls.slice(before), 'and reloads the plain way').toContain('POST /api/plugins/ka/start');
  });

  it('a reconcile whose answer arrives after its frame was replaced leaves the replacement resident', async () => {
    net.status = { ka: keepRow() };
    await mountApp();
    await visit('ka');
    const first = residentFrame('ka')!;
    let release = holdStatus('ka');
    let pending!: Promise<void>;
    act(() => { pending = pluginFrames.reconcile(undefined); });
    await release(keepRow({ state: 'stopped' }));
    await act(async () => { await pending; });
    expect(first.isConnected, 'positive control: the held answer evicts the frame it was asked about').toBe(false);
    await go('#plugin/ka/');
    const old = residentFrame('ka')!;
    await go('#');
    release = holdStatus('ka');
    act(() => { pending = pluginFrames.reconcile(undefined); });
    await act(async () => { await pluginFrames.reconcile({ action: 'restart', ids: ['ka'] }); });
    expect(old.isConnected, 'fixture check: an evicting action ended the old frame').toBe(false);
    await go('#plugin/ka/');
    const replacement = residentFrame('ka');
    expect(!!replacement && replacement !== old, 'fixture check: a new frame for the same plugin').toBe(true);
    let changes = 0;
    const stop = residentSignal.subscribe(() => { changes++; });
    await release(keepRow({ state: 'stopped' }));
    await act(async () => { await pending; });
    stop();
    expect(pluginFrames.residentIds(), 'the replacement stays resident').toEqual(['ka']);
    expect(replacement!.isConnected && !replacement!.hidden, 'and shown').toBe(true);
    expect(changes, 'the resident set did not change').toBe(0);
  });
});

describe('test harness', () => {
  it('a history call fires no hashchange here, and setting location.hash does', async () => {
    let heard = 0;
    const count = () => { heard++; };
    addEventListener('hashchange', count);
    try {
      history.replaceState(null, '', '#harness-a');
      history.pushState(null, '', '#harness-b');
      await settle();
      expect(heard, 'history calls').toBe(0);
      location.hash = '#harness-c';
      await settle();
      expect(heard, 'location.hash').toBe(1);
    } finally {
      removeEventListener('hashchange', count);
    }
  });
});
