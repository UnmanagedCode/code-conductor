// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
// A fresh load on a plugin's full view with a split stored (a bookmark, a second
// tab): the dock module evaluates on that URL, and full and split never coexist.
import { vi } from 'vitest';

// Before any import: the URL and the stored dock the modules boot on.
vi.hoisted(() => {
  history.replaceState(null, '', '/#plugin/alpha/');
  localStorage.setItem('code-conductor:plugin-dock', JSON.stringify({ id: 'alpha', subpath: '/', mode: 'split' }));
});

import '@/test/browserHash';
import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent } from '@testing-library/react';

vi.mock('@/app/controller', () => ({
  selectInstance: vi.fn(), send: vi.fn(), refreshProjects: vi.fn(), refreshInstances: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []), closeSession: vi.fn(), resumeSession: vi.fn(), promoteSession: vi.fn(), removeWorktree: vi.fn(),
}));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));
vi.mock('@/features/session/SessionView', () => ({ SessionView: () => <div data-view="session" /> }));
vi.mock('@/features/dialogs/DialogsHost', () => ({ DialogsHost: () => null }));

import { DOCK_STORAGE_KEY, dockStore } from './dock';
import {
  ACTIVE, checkedNow, column, DOCK_CATALOG, endHost, keepRow, mountApp, net, plainRow, resetHost, sessionShown, settle, viewOpen,
} from './test/pluginHost';

afterEach(() => endHost());

describe('a boot on a plugin\'s full view with a split stored', () => {
  it('drops the stored split, so Escape from the full view lands on Conductor', async () => {
    // Invariant: the full view the page boots on ends the stored split before anything reads it.
    expect(JSON.parse(localStorage.getItem(DOCK_STORAGE_KEY) ?? 'null')?.mode, 'fixture check: split stored').toBe('split');
    expect(dockStore.get().id, 'the split selection cleared at load').toBeNull();
    expect(dockStore.get().mode, 'the remembered mode kept').toBe('split');
    resetHost('/#plugin/alpha/');
    net.catalog = DOCK_CATALOG;
    net.status = { alpha: plainRow(), beta: keepRow() };
    await mountApp();
    expect(viewOpen() && !sessionShown(), 'fixture check: Alpha in full').toBe(true);
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
    await settle();
    expect(location.hash).toBe(`#session=${ACTIVE.sessionId}`);
    expect(column()!.dataset.dockMode).toBe('hidden');
    expect(sessionShown()).toBe(true);
    expect(await checkedNow()).toEqual(['conductor']);
  });
});
