// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
// A fresh load with a collapsed split stored: the rail shows from storage alone.
import { vi } from 'vitest';

// Before any import: the URL and the stored dock the modules boot on.
vi.hoisted(() => {
  history.replaceState(null, '', '/#session=sess-1');
  localStorage.setItem('code-conductor:plugin-dock', JSON.stringify({ id: 'alpha', subpath: '/x', mode: 'split' }));
  localStorage.setItem('code-conductor:plugin-dock-width', '520');
  localStorage.setItem('code-conductor:plugin-dock-collapsed', 'true');
});

import '@/test/browserHash';
import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, within } from '@testing-library/react';

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
  column, DOCK_CATALOG, dockHandle, endHost, keepRow, mountApp, net, plainRow, resetHost, settle, sharedFrame,
} from './test/pluginHost';

afterEach(() => endHost());

describe('a boot with a collapsed split stored', () => {
  it('a reload with a collapse stored boots on the rail with the plugin loaded, and Expand restores the split at its stored width', async () => {
    // Invariant: the read side of persistence — the rail shows from storage alone, the page stays mounted, Expand returns the stored width.
    resetHost('/#session=sess-1');
    net.catalog = DOCK_CATALOG;
    net.status = { alpha: plainRow(), beta: keepRow() };
    await mountApp();
    expect(column()!.dataset.dockMode).toBe('rail');
    expect(sharedFrame()?.getAttribute('src')).toBe('/plugins/alpha/x');
    await act(async () => { fireEvent.click(within(column()!).getByRole('button', { name: 'Expand plugin dock' })); });
    await settle();
    expect(column()!.dataset.dockMode).toBe('split');
    expect(dockHandle()!.getAttribute('aria-valuenow')).toBe('520');
  });
});
