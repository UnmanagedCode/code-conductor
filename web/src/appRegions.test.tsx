// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, within } from '@testing-library/react';
import { appStore } from '@/state/app';
import { uiStore } from '@/app/ui';
import { syncRoute } from '@/state/route';
import { settle } from '@/test/settle';
import { routeFetch } from '@/test/routeFetch';
import { toast } from '@/ui/feedback';
import { dialogStore, openNewProjectDialog } from '@/features/dialogs/api';
import { openCosts } from '@/features/views/api';

// A crash switch per region: each stand-in below throws its own Error while its flag is on.
const boom = vi.hoisted(() => {
  const ls = new Set<() => void>();
  const s = { main: false, sidebar: false, dialogs: false, banner: false };
  const errors = {
    main: new Error('main pane exploded'),
    sidebar: new Error('sidebar exploded'),
    dialogs: new Error('dialog exploded'),
    banner: new Error('banner exploded'),
  };
  return {
    s, errors,
    sub: (l: () => void) => { ls.add(l); return () => { ls.delete(l); }; },
    set(k: keyof typeof s, v: boolean) { s[k] = v; ls.forEach((l) => l()); },
  };
});

vi.mock('@/app/controller', () => ({
  selectInstance: vi.fn(), send: vi.fn(), refreshProjects: vi.fn(), refreshInstances: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []), closeSession: vi.fn(), resumeSession: vi.fn(), persistSession: vi.fn(), removeWorktree: vi.fn(),
}));
vi.mock('@/features/session/SessionView', async () => {
  const React = await import('react');
  return {
    SessionView: () => {
      const on = React.useSyncExternalStore(boom.sub, () => boom.s.main);
      if (on) throw boom.errors.main;
      return <div data-view="session" />;
    },
  };
});
vi.mock('@/features/notifications/NotifyToggle', async () => {
  const React = await import('react');
  return {
    NotifyToggle: () => {
      const on = React.useSyncExternalStore(boom.sub, () => boom.s.sidebar);
      if (on) throw boom.errors.sidebar;
      return null;
    },
  };
});
vi.mock('@/features/dialogs/DialogsHost', async () => {
  const React = await import('react');
  const { useStore } = await import('@/state/createStore');
  const { dialogStore: store } = await import('@/features/dialogs/api');
  return {
    DialogsHost: () => {
      const open = useStore(store, (s) => Object.values(s).some(Boolean));
      const on = React.useSyncExternalStore(boom.sub, () => boom.s.dialogs);
      if (on && open) throw boom.errors.dialogs;
      return null;
    },
  };
});
vi.mock('@/features/resume/ResumeBanner', async () => {
  const React = await import('react');
  return {
    ResumeBanner: () => {
      const on = React.useSyncExternalStore(boom.sub, () => boom.s.banner);
      if (on) throw boom.errors.banner;
      return null;
    },
  };
});
vi.mock('@/features/views/CostsView', () => ({ CostsView: () => <div data-view="costs" /> }));

const { App } = await import('@/App');
const { pluginFrames } = await import('@/features/views/plugins');

const desktopSidebar = () => [...document.querySelectorAll('[data-sidebar]')].filter((e) => !e.closest('[data-slot="sheet-content"]'));
const region = (name: string) => document.querySelector<HTMLElement>(`[data-error-region="${name}"]`);
const sessionView = () => document.querySelector('[data-view="session"]');

/** Runs `fn` in act; returns what act rethrew, or null (React 19 rethrows an error no boundary caught). */
async function actCatching(fn: () => void): Promise<unknown> {
  let thrown: unknown = null;
  try { await act(async () => { fn(); }); } catch (e) { thrown = e; }
  await settle();
  return thrown;
}
const crash = (k: keyof typeof boom.s) => actCatching(() => boom.set(k, true));
/** Every muted console.error call carries the thrown Error: React's caught-error log. */
function expectLogged(spy: { mock: { calls: unknown[][] } }, error: Error) {
  const calls = spy.mock.calls;
  expect(calls.length, 'React logged the caught error').toBeGreaterThan(0);
  expect(calls.every((c) => c.includes(error)), 'every logged call carries the thrown error').toBe(true);
}
async function mountApp() {
  const view = render(<App />);
  await settle();
  expect(desktopSidebar(), 'control: the sidebar column').toHaveLength(1);
  expect(sessionView(), 'control: the session view').not.toBeNull();
  return view;
}

beforeEach(() => {
  for (const k of Object.keys(boom.s) as (keyof typeof boom.s)[]) boom.s[k] = false;
  history.replaceState(null, '', '/');
  syncRoute();
  uiStore.set({ sidebarOpen: false });
  dialogStore.set({ newProject: false });
  routeFetch({ 'GET /api/plugins': () => ({ json: { rows: [] } }) });
  appStore.set({
    connection: 'open', everDropped: false, activeId: 'i1', sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {},
    instances: [{ id: 'i1', project: 'p', status: 'idle', sessionId: 's1', mode: 'default' }] as any,
  });
});

afterEach(() => {
  cleanup();
  pluginFrames.leave();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a render crash stays in its region', () => {
  it('a main-pane render crash shows a fallback in the main pane only; the sidebar stays', async () => {
    // Invariant: the main-pane boundary contains a MainView throw — nothing escapes to the root, the sidebar stays, the fallback shows the message and React logs the caught error.
    const { container } = await mountApp();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const thrown = await crash('main');
    expect(container.childElementCount, 'the app is still mounted').toBeGreaterThan(0);
    expect(desktopSidebar(), 'the sidebar stays').toHaveLength(1);
    const main = region('main');
    expect(main, 'the main fallback').not.toBeNull();
    expect(main!.getAttribute('role')).toBe('alert');
    expect(main!.textContent).toContain(boom.errors.main.message);
    expect(region('app'), 'no root fallback').toBeNull();
    expect(thrown, 'nothing escaped to the root').toBeNull();
    expectLogged(logged, boom.errors.main);
  });

  it('the main-pane fallback clears when another session is selected', async () => {
    // Invariant: the selected session (activeId) is part of the main pane's reset key.
    const { container } = await mountApp();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await crash('main');
    expect(container.childElementCount, 'the app is still mounted').toBeGreaterThan(0);
    expect(region('main'), 'the main fallback is up').not.toBeNull();
    boom.s.main = false;
    await act(async () => { appStore.set({ activeId: 'i2' }); });
    await settle();
    expect(region('main'), 'cleared by the selection').toBeNull();
    expect(sessionView()).not.toBeNull();
    expectLogged(logged, boom.errors.main);
  });

  it('the main-pane fallback clears when the view changes', async () => {
    // Invariant: the route's view is part of the main pane's reset key.
    const { container } = await mountApp();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await crash('main');
    expect(container.childElementCount, 'the app is still mounted').toBeGreaterThan(0);
    expect(region('main'), 'the main fallback is up').not.toBeNull();
    boom.s.main = false;
    await act(async () => { openCosts(); });
    await settle();
    expect(region('main'), 'cleared by the view change').toBeNull();
    expect(document.querySelector('[data-view="costs"]')).not.toBeNull();
    expectLogged(logged, boom.errors.main);
  });

  it('a sidebar crash shows a sidebar fallback, keeps the main pane, and Try again remounts it', async () => {
    // Invariant: the sidebar boundary isolates a sidebar throw, and its Try again resets the boundary.
    const { container } = await mountApp();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const thrown = await crash('sidebar');
    expect(container.childElementCount, 'the app is still mounted').toBeGreaterThan(0);
    const side = region('sidebar');
    expect(side, 'the sidebar fallback').not.toBeNull();
    expect(desktopSidebar(), 'the sidebar is replaced').toHaveLength(0);
    expect(sessionView(), 'the main pane stays').not.toBeNull();
    expect(thrown, 'nothing escaped to the root').toBeNull();
    boom.s.sidebar = false;
    await act(async () => { within(side!).getByRole('button', { name: 'Try again' }).click(); });
    await settle();
    expect(desktopSidebar(), 'the sidebar is back').toHaveLength(1);
    expect(region('sidebar')).toBeNull();
    expectLogged(logged, boom.errors.sidebar);
  });

  it('a dialog that crashes is closed with an error toast, the page stays, and the next open renders', async () => {
    // Invariant: a dialog crash closes the open slot with the crash toast and leaves the page up; the next open renders fresh.
    const toastError = vi.spyOn(toast, 'error');
    const { container } = await mountApp();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    boom.set('dialogs', true);
    const thrown = await actCatching(openNewProjectDialog);
    expect(container.childElementCount, 'the app is still mounted').toBeGreaterThan(0);
    expect(desktopSidebar()).toHaveLength(1);
    expect(sessionView()).not.toBeNull();
    expect(dialogStore.get().newProject, 'the crashed dialog is closed').toBe(false);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('The dialog closed after an error', 'Reload the page and try again.');
    expect(thrown, 'nothing escaped to the root').toBeNull();
    boom.set('dialogs', false);
    await act(async () => openNewProjectDialog());
    await settle();
    expect(dialogStore.get().newProject, 'the next open stays open').toBe(true);
    expect(toastError, 'no second toast').toHaveBeenCalledTimes(1);
    expectLogged(logged, boom.errors.dialogs);
  });

  it('a crash outside every region shows the app fallback, not a blank page', async () => {
    // Invariant: the root boundary replaces the blank-page failure with a fallback offering Reload page.
    await mountApp();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const thrown = await crash('banner');
    const root = region('app');
    expect(root, 'the app fallback is shown').not.toBeNull();
    expect(desktopSidebar()).toHaveLength(0);
    expect(within(root!).getByRole('button', { name: 'Reload page' })).not.toBeNull();
    expect(thrown, 'nothing escaped past the root boundary').toBeNull();
    expectLogged(logged, boom.errors.banner);
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    await act(async () => { within(root!).getByRole('button', { name: 'Reload page' }).click(); });
    expect(reload, 'Reload page reloads').toHaveBeenCalledTimes(1);
  });
});
