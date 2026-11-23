// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
// View-only: the #settings route renders the session view and never loads the
// settings chunk. Flag off: SettingsView renders.
import '@/test/browserHash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const chunk = vi.hoisted(() => ({ loaded: 0 }));
vi.mock('@/features/settings/SettingsView', () => {
  chunk.loaded++;
  return { SettingsView: () => <div data-testid="settings-view" /> };
});
vi.mock('@/features/session/SessionView', () => ({ SessionView: () => <div data-testid="session-view" /> }));
vi.mock('@/app/controller', () => ({ selectInstance: vi.fn(), send: vi.fn(), refreshProjects: vi.fn(), refreshInstances: vi.fn() }));
vi.mock('@/features/sidebar/AppSidebar', () => ({ AppSidebar: () => null }));
vi.mock('@/features/views/PluginView', () => ({ PluginView: () => null }));
vi.mock('@/features/dialogs/LazyDialogsHost', () => ({ LazyDialogsHost: () => null }));
vi.mock('@/features/resume/ResumeBanner', () => ({ ResumeBanner: () => null }));

import { setViewOnly } from '@shared/viewOnly';
import { syncRoute } from '@/state/route';
import { App } from './App';

beforeEach(() => { chunk.loaded = 0; history.replaceState(null, '', '/#settings'); syncRoute(); });
afterEach(() => { cleanup(); setViewOnly(false); history.replaceState(null, '', '/'); });

describe('#settings route', () => {
  it('renders no SettingsView in view-only, and never loads its chunk', async () => {
    // Invariant: a spectator on #settings sees the session view; the settings module is not imported.
    setViewOnly(true);
    render(<App />);
    expect(await screen.findByTestId('session-view')).toBeTruthy();
    expect(screen.queryByTestId('settings-view')).toBeNull();
    expect(chunk.loaded).toBe(0);
  });

  it('renders SettingsView with the flag off', async () => {
    // Invariant (control): the same route shows the settings page in normal mode.
    render(<App />);
    expect(await screen.findByTestId('settings-view')).toBeTruthy();
    expect(screen.queryByTestId('session-view')).toBeNull();
  });
});
