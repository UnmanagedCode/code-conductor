// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { appStore } from '@/state/app';
import { uiStore } from '@/app/ui';
import { syncRoute } from '@/state/route';

vi.mock('@/app/controller', () => ({
  selectInstance: vi.fn(), send: vi.fn(), refreshProjects: vi.fn(), refreshInstances: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []), closeSession: vi.fn(), resumeSession: vi.fn(), promoteSession: vi.fn(), removeWorktree: vi.fn(),
}));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));
vi.mock('@/features/session/SessionView', () => ({ SessionView: () => <div data-view="session" /> }));
vi.mock('@/features/dialogs/DialogsHost', () => ({ DialogsHost: () => null }));

const { App } = await import('@/App');
const { pluginFrames, catalogStore } = await import('./plugins');

const APPS = [
  { id: 'alpha', name: 'Alpha', enabled: true, hasFrontend: true },
  { id: 'beta', name: 'Beta', enabled: true, hasFrontend: true },
  { id: 'gamma', name: 'Gamma Plugin', navLabel: 'Gamma', enabled: true, hasFrontend: true },
];
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const drawer = () => document.querySelector('[data-slot="sheet-content"]') as HTMLElement | null;
/** The desktop column: the sidebar that is not inside the phone drawer. */
const desktopColumn = () => [...document.querySelectorAll('[data-sidebar]')].filter((e) => !e.closest('[data-slot="sheet-content"]'));

async function openDrawer() {
  await act(async () => { uiStore.set({ sidebarOpen: true }); });
  await settle();
  expect(drawer(), 'drawer opened').not.toBeNull();
}
/** Picks an entry of the switcher that lives in `scope`. */
async function pickApp(scope: HTMLElement, name: string | RegExp) {
  const trigger = within(scope).getByRole('button', { name: 'Switch app' });
  await act(async () => { trigger.focus(); fireEvent.keyDown(trigger, { key: 'ArrowDown' }); });
  await settle();
  await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name })); });
  await settle();
}

beforeEach(() => {
  history.replaceState(null, '', '/');
  syncRoute();
  uiStore.set({ sidebarOpen: false });
  catalogStore.set({ apps: APPS });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (
    url === '/api/plugins' ? new Response(JSON.stringify({ rows: APPS })) : new Response(JSON.stringify({ state: 'ready', frontendKeepAlive: false }))
  )));
  appStore.set({
    connection: 'open', everDropped: false, activeId: null, sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [],
  });
});

afterEach(() => {
  cleanup();
  pluginFrames.leave();
  vi.unstubAllGlobals();
});

describe('plugin navigation and the sidebar', () => {
  it('collapses the phone drawer when entering a plugin, switching plugin to plugin, and returning to Conductor', async () => {
    // Invariant: each of the three app-switcher moves closes an open drawer.
    render(<App />);
    await settle();

    await openDrawer();
    await pickApp(drawer()!, /Alpha/);
    expect(location.hash, 'entered a plugin').toBe('#plugin/alpha/');
    expect(uiStore.get().sidebarOpen, 'entering').toBe(false);

    await openDrawer();
    await pickApp(drawer()!, /Beta/);
    expect(location.hash, 'switched').toBe('#plugin/beta/');
    expect(uiStore.get().sidebarOpen, 'switching').toBe(false);

    await openDrawer();
    await pickApp(drawer()!, /Conductor/);
    expect(location.hash, 'returned').not.toMatch(/^#plugin/);
    expect(uiStore.get().sidebarOpen, 'returning').toBe(false);
  });

  it('leaves the desktop sidebar in place when entering a plugin or switching plugin to plugin', async () => {
    // Invariant: plugin navigation never removes the desktop column, and it never needs the drawer.
    render(<App />);
    await settle();
    expect(desktopColumn()).toHaveLength(1);

    await pickApp(desktopColumn()[0] as HTMLElement, /Alpha/);
    expect(location.hash).toBe('#plugin/alpha/');
    expect(desktopColumn(), 'after entering').toHaveLength(1);
    expect(drawer(), 'drawer never opened').toBeNull();

    await pickApp(desktopColumn()[0] as HTMLElement, /Beta/);
    expect(location.hash).toBe('#plugin/beta/');
    expect(desktopColumn(), 'after switching').toHaveLength(1);
    expect(drawer(), 'drawer never opened').toBeNull();
  });
});

describe('the plugin view on a drawer viewport', () => {
  const view = () => document.querySelector('[data-view="plugin"]') as HTMLElement;
  const happyDOM = () => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM;
  let prev = { width: 0, height: 0 };
  beforeEach(() => {
    prev = { width: window.innerWidth, height: window.innerHeight };
    happyDOM().setViewport({ width: 412, height: 915 });
  });
  afterEach(() => { happyDOM().setViewport(prev); });

  it("shows the top bar with the drawer button and the plugin's switcher name, ahead of the frame", async () => {
    // Invariant: the view has a bar holding the only Open sidebar button and the plugin's name, before the frame.
    history.replaceState(null, '', '/#plugin/gamma/');
    syncRoute();
    render(<App />);
    await settle();

    const heading = within(view()).getByRole('heading', { name: 'Gamma' });
    const bar = heading.closest('header');
    expect(bar, 'the title sits in a header bar').not.toBeNull();
    const buttons = within(view()).getAllByRole('button', { name: 'Open sidebar' });
    expect(buttons, 'one drawer button, no floating leftover').toHaveLength(1);
    expect(bar!.contains(buttons[0]!), 'the button is in the bar').toBe(true);

    const frame = view().querySelector('iframe');
    expect(frame, 'the plugin frame mounted').not.toBeNull();
    expect(bar!.contains(frame), 'the frame is outside the bar').toBe(false);
    expect(bar!.compareDocumentPosition(frame!) & Node.DOCUMENT_POSITION_FOLLOWING, 'the bar comes before the frame').toBeTruthy();

    await act(async () => { fireEvent.click(buttons[0]!); });
    expect(uiStore.get().sidebarOpen).toBe(true);
  });

  it('follows a plugin switch, and names an uncatalogued plugin by its id', async () => {
    // Invariant: the bar's title tracks the route's plugin: its switcher name, else its id.
    history.replaceState(null, '', '/#plugin/alpha/');
    syncRoute();
    render(<App />);
    await settle();
    expect(within(view()).getByRole('heading', { name: 'Alpha' })).toBeTruthy();

    await openDrawer();
    await pickApp(drawer()!, /Beta/);
    expect(within(view()).getByRole('heading', { name: 'Beta' })).toBeTruthy();

    await act(async () => { history.replaceState(null, '', '/#plugin/zeta/'); syncRoute(); });
    await settle();
    expect(within(view()).getByRole('heading', { name: 'zeta' })).toBeTruthy();
  });
});
