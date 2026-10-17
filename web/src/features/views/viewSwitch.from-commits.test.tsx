// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
// The full-page views as the app mounts them: from commits to every other view and back (pairs in test/viewSwitch.ts).
import '@/test/browserHash';
import { vi } from 'vitest';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: vi.fn(), send: vi.fn() }));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []), closeSession: vi.fn(), resumeSession: vi.fn(), promoteSession: vi.fn(), removeWorktree: vi.fn(),
  syncWorktree: vi.fn(), mergeWorktree: vi.fn(), setWorktreeLock: vi.fn(),
}));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));
vi.mock('@/features/session/SessionView', () => ({ SessionView: () => <div data-view="session" /> }));
vi.mock('@/features/dialogs/DialogsHost', () => ({ DialogsHost: () => null }));

import { pairsFrom, useViewSwitchHost } from './test/viewSwitch';

useViewSwitchHost();
pairsFrom('commits');
