// The real capabilities module, in its own file: it memoises its first
// successful answer for the life of the module instance.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { routeFetch } from '@/test/routeFetch';

vi.mock('@/app/sessionActions', () => ({ resumeSession: vi.fn(async () => {}) }));
vi.mock('@/app/controller', () => ({ refreshProjects: vi.fn(async () => {}), refreshInstances: vi.fn(async () => {}) }));
vi.mock('@/app/models', () => ({ applyModels: vi.fn() }));
vi.mock('@/features/sidebar/restart', () => ({ performRestart: vi.fn(async () => {}) }));

import { capabilities } from '@shared/capabilities';
import { SERVER_UNREACHABLE_MESSAGE } from '@shared/http';
import { syncRoute } from '@/state/route';
import { SettingsView } from './SettingsView';

const ALL = ['Models', 'Conventions', 'Plugins', 'Backends', 'Systems', 'Account', 'Voice', 'Archived', 'About'];
const nav = () => within(screen.getByRole('navigation', { name: 'Settings sections' }));
const navLabels = () => nav().getAllByRole('link').map((a) => a.textContent?.trim());

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Settings with unknown capabilities', () => {
  // A failed capabilities read is not remembered: every section is offered and mountable, and the next open re-reads and applies the answer.
  it('an unreadable capabilities answer offers every section and mounts a gated one; the next open retries and applies the answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let health = 0;
    const calls = routeFetch({
      'GET /api/health': () => (++health === 1 ? new Error('transient') : { json: { capabilities: { remoteSystems: true, voice: false, fuseUnion: true } } }),
      'GET /api/settings/systems': () => ({ json: { systems: [] } }),
    });
    history.replaceState(null, '', '/#settings/voice');
    syncRoute();
    const first = render(<TooltipProvider><SettingsView /></TooltipProvider>);
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/settings/transcribe'))).toBe(true));
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/settings/tts'))).toBe(true));
    expect(navLabels()).toEqual(ALL);
    expect(capabilities()).toBeNull();
    fireEvent.click(nav().getByRole('link', { name: 'Systems' }));
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/settings/systems'))).toBe(true));
    first.unmount();

    render(<TooltipProvider><SettingsView /></TooltipProvider>);
    await waitFor(() => expect(nav().queryByRole('link', { name: 'Voice' })).toBeNull());
    expect(calls.filter((c) => c.url === '/api/health')).toHaveLength(2);
    expect(nav().getByRole('link', { name: 'Systems' })).toBeTruthy();
    expect(capabilities()?.remoteSystems).toBe(true);
    expect(warn).toHaveBeenCalledExactlyOnceWith('capabilities: could not read /api/health, will retry on next use:', expect.objectContaining({ message: SERVER_UNREACHABLE_MESSAGE }));
  });
});
