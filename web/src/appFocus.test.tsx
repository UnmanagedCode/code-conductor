// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
// Focus mode (a headless run or `--view` replay) renders no sidebar — neither
// the desktop column nor the drawer — and no control that opens it.
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { setFocus } from '@shared/focus';
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
