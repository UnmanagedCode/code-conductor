// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
// Focus mode (a headless run, a `--replay`, or a `?focus=<sid>` page) renders no sidebar — neither
// the desktop column nor the drawer — and no control that opens it.
import '@/test/browserHash';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { setFocus, setPageFocus } from '@shared/focus';
import { appStore } from '@/state/app';
import { uiStore } from '@/app/ui';
import { syncRoute } from '@/state/route';
import { settle } from '@/test/settle';
import { routeFetch } from '@/test/routeFetch';

vi.mock('@/app/controller', () => ({
  selectInstance: vi.fn(), send: vi.fn(), refreshProjects: vi.fn(), refreshInstances: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []), closeSession: vi.fn(), resumeSession: vi.fn(), persistSession: vi.fn(), removeWorktree: vi.fn(),
}));

vi.mock('@/conversation/ConversationView', () => ({ ConversationView: () => <div data-conversation-stub /> }));

const { App } = await import('@/App');
const { ViewShell } = await import('@/features/views/ViewShell');
const { PluginView } = await import('@/features/views/PluginView');
const { SettingsView } = await import('@/features/settings/SettingsView');
const { SessionView } = await import('@/features/session/SessionView');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { pluginFrames } = await import('@/features/views/plugins');

const sidebars = () => [...document.querySelectorAll('[data-sidebar]')];
const desktopSidebar = () => sidebars().filter((e) => !e.closest('[data-slot="sheet-content"]'));
const drawerSidebar = () => sidebars().filter((e) => e.closest('[data-slot="sheet-content"]'));
const openSidebarButtons = () => screen.queryAllByRole('button', { name: 'Open sidebar', hidden: true });

beforeEach(() => {
  history.replaceState(null, '', '/');
  syncRoute();
  uiStore.set({ sidebarOpen: false });
  routeFetch({ 'GET /api/plugins': () => ({ json: { rows: [] } }) });
  appStore.set({
    connection: 'open', everDropped: false, activeId: 'i1', sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {},
    instances: [{ id: 'i1', project: 'p', status: 'idle', sessionId: 's1', mode: 'default' }] as any,
  });
});
afterEach(() => {
  cleanup();
  setFocus(null);
  setPageFocus(null);
  pluginFrames.leave();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('focus mode', () => {
  it('renders no sidebar, drawer or Open sidebar button', async () => {
    // Invariant: a focused client has one session and no navigation to another.
    setFocus({ sessionId: 's1' });
    render(<App />);
    await settle();
    await act(async () => { uiStore.set({ sidebarOpen: true }); });
    await settle();
    expect(desktopSidebar()).toHaveLength(0);
    expect(drawerSidebar()).toHaveLength(0);
    expect(openSidebarButtons()).toHaveLength(0);
    expect(document.querySelector('[data-session-header]'), 'control: the session still renders').not.toBeNull();
  });

  it('control: without focus the column, the drawer and the button are there', async () => {
    // Invariant: the sidebar is removed by focus mode alone.
    render(<App />);
    await settle();
    await act(async () => { uiStore.set({ sidebarOpen: true }); });
    await settle();
    expect(desktopSidebar()).toHaveLength(1);
    expect(drawerSidebar()).toHaveLength(1);
    expect(openSidebarButtons().length).toBeGreaterThan(0);
  });

  it('turning focus on removes a sidebar already mounted', async () => {
    // Invariant: the focus read lands after first paint, and the sidebar goes when it does.
    render(<App />);
    await settle();
    expect(desktopSidebar()).toHaveLength(1);
    await act(async () => { setFocus({ sessionId: null }); });
    await settle();
    expect(desktopSidebar()).toHaveLength(0);
  });
});

// Each surface that carries its own "Open sidebar" button hides it in focus mode,
// each against a non-focus control so the absence is not vacuous. Components are
// mounted directly: some are unreachable in a focused client by construction
// (Settings under `--ui view` / `interact`), but their own guard is the invariant.
// Invariant: no surface renders an Open sidebar button in focus mode.
describe('every Open sidebar button is gone in focus mode', () => {
  const surfaces: [string, () => React.ReactElement, () => void][] = [
    ['the session view\'s empty state', () => <SessionView />, () => appStore.set({ activeId: null, instances: [] })],
    ['a full-page view (ViewShell)', () => <ViewShell title="A view">body</ViewShell>, () => {}],
    ['Settings', () => <SettingsView />, () => { routeFetch({ 'GET /api/health': () => ({ json: { capabilities: { git: true }, uiMode: 'full' } }), 'GET /api/plugins': () => ({ json: { rows: [] } }) }); }],
    ['the plugin column\'s bar', () => <PluginView />, () => (window as any).happyDOM.setViewport({ width: 400, height: 800 })],
  ];
  afterEach(() => { (window as any).happyDOM.setViewport({ width: 1024, height: 768 }); });
  for (const [name, element, prepare] of surfaces) {
    it(`${name}: present without focus, absent with it`, async () => {
      // Invariant: the control shows the button is there; focus mode removes it.
      prepare();
      const view = render(<TooltipProvider>{element()}</TooltipProvider>);
      await settle();
      expect(openSidebarButtons().length, 'control: the button is rendered without focus').toBeGreaterThan(0);
      view.unmount();
      setFocus({ sessionId: 's1' });
      render(<TooltipProvider>{element()}</TooltipProvider>);
      await settle();
      expect(openSidebarButtons()).toHaveLength(0);
    });
    it(`${name}: a page focus removes the button too`, async () => {
      // Invariant: the URL marker alone removes every Open sidebar surface, as the server's focus does.
      prepare();
      const view = render(<TooltipProvider>{element()}</TooltipProvider>);
      await settle();
      expect(openSidebarButtons().length, 'control: the button is rendered without focus').toBeGreaterThan(0);
      view.unmount();
      setPageFocus({ sessionId: 's1' });
      render(<TooltipProvider>{element()}</TooltipProvider>);
      await settle();
      expect(openSidebarButtons()).toHaveLength(0);
    });
  }
});

describe('URL marker', () => {
  it('the page focus alone hides the column, the drawer and the Open sidebar button', async () => {
    // Invariant: the page marker alone hides every sidebar path while the session still renders.
    setPageFocus({ sessionId: 's1' });
    render(<App />);
    await settle();
    await act(async () => { uiStore.set({ sidebarOpen: true }); });
    await settle();
    expect(desktopSidebar()).toHaveLength(0);
    expect(drawerSidebar()).toHaveLength(0);
    expect(openSidebarButtons()).toHaveLength(0);
    expect(document.querySelector('[data-session-header]'), 'control: the session still renders').not.toBeNull();
  });

  it('with no session the empty state reads the focus copy and offers no start buttons', async () => {
    // Invariant: an unknown id shows focus mode's empty state, with no way to start a session.
    appStore.set({ activeId: null, instances: [] });
    setPageFocus({ sessionId: 'nope' });
    render(<TooltipProvider><SessionView /></TooltipProvider>);
    await settle();
    expect(screen.getByText('Waiting for the session to start.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Start conducting/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /New project/ })).toBeNull();
  });
});
