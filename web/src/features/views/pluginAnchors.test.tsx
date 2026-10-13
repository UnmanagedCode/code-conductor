// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { uiStore } from '@/app/ui';
import { syncRoute } from '@/state/route';
import { mockFetch } from '@/features/settings/test/fetchMock';

vi.mock('@/app/controller', () => ({
  selectInstance: vi.fn(), send: vi.fn(), refreshProjects: vi.fn(async () => {}), refreshInstances: vi.fn(async () => {}),
}));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []), closeSession: vi.fn(), resumeSession: vi.fn(), promoteSession: vi.fn(), removeWorktree: vi.fn(),
}));
vi.mock('@/app/models', () => ({ applyModels: vi.fn() }));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));
vi.mock('@/features/session/SessionView', () => ({ SessionView: () => <div data-view="session" /> }));
vi.mock('@/features/dialogs/DialogsHost', () => ({ DialogsHost: () => null }));
vi.mock('@shared/capabilities', () => ({ loadCapabilities: vi.fn(async () => ({ remoteSystems: true, voice: true })), capabilities: vi.fn(() => null) }));

const { App } = await import('@/App');
const { catalogStore, pluginFrames } = await import('./plugins');
const { SettingsView } = await import('@/features/settings/SettingsView');

const APPS = [{ id: 'alpha', name: 'Alpha', enabled: true, hasFrontend: true }];
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

beforeEach(() => {
  history.replaceState(null, '', '/');
  syncRoute();
  uiStore.set({ sidebarOpen: false });
  appStore.set({
    connection: 'open', everDropped: false, activeId: null, sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [],
  });
});
afterEach(() => { cleanup(); pluginFrames.leave(); vi.unstubAllGlobals(); });

describe('where the plugin surfaces live', () => {
  it('puts the app switcher in the sidebar and the plugin view in the main area, not in the sidebar', async () => {
    // Invariant: the switcher is reachable from the sidebar header; the plugin view is a sibling of the sidebar in the main region.
    catalogStore.set({ apps: APPS });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ rows: APPS }))));
    render(<App />);
    await settle();
    const sidebar = document.querySelector('[data-sidebar]') as HTMLElement;
    expect(within(sidebar).getByRole('button', { name: 'Switch app' })).toBeTruthy();
    const view = document.querySelector('[data-view="plugin"]') as HTMLElement;
    expect(view).not.toBeNull();
    expect(sidebar.contains(view)).toBe(false);
    expect(view.closest('[data-sidebar]')).toBeNull();
  });

  it('offers a Plugins section in Settings', async () => {
    // Invariant: Settings lists Plugins as a section, and choosing it routes to that section's body.
    mockFetch({ 'GET /api/plugins': () => ({ rows: [] }) });
    history.replaceState(null, '', '/#settings');
    syncRoute();
    render(<TooltipProvider><SettingsView /></TooltipProvider>);
    const link = await screen.findByRole('link', { name: 'Plugins' });
    expect(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('link', { name: 'Plugins' })).toBe(link);
    fireEvent.click(link);
    await waitFor(() => expect(document.querySelector('[data-section="plugins"]')).toBeTruthy());
    expect(location.hash).toBe('#settings/plugins');
  });
});
