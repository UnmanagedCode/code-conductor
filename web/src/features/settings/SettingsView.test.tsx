import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { mockFetch, type Call } from './test/fetchMock';

vi.mock('@/app/sessionActions', () => ({ resumeSession: vi.fn(async () => {}) }));
vi.mock('@/app/controller', () => ({ refreshProjects: vi.fn(async () => {}), refreshInstances: vi.fn(async () => {}) }));
vi.mock('@/app/models', () => ({ applyModels: vi.fn() }));
vi.mock('@/features/sidebar/restart', () => ({ performRestart: vi.fn(async () => {}) }));
vi.mock('@/lib/core/capabilities.js', () => ({ loadCapabilities: vi.fn(), capabilities: vi.fn(() => null) }));

import { loadCapabilities } from '@/lib/core/capabilities.js';
import { routeStore, syncRoute, useRoute } from '@/state/route';
import { modelsSettingsStore } from './models/store';
import { SettingsView } from './SettingsView';

const models = () => ({
  backends: [{ id: 'claude', label: 'Claude', template: '', env: [], managed: true }],
  claudeFamilies: [{ family: 'sonnet', label: 'Sonnet', default: 'claude-sonnet-5-5', versions: [{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }] }],
  tiers: [{ tier: 'fast', label: 'Fast' }, { tier: 'powerful', label: 'Powerful' }],
  tierBackend: { fast: { backend: 'claude', model: 'claude-sonnet-5-5' }, powerful: { backend: 'claude', model: 'claude-sonnet-5-5' } },
  tierEffort: {},
  efforts: ['low', 'medium', 'high', 'max'],
  defaultEffort: 'medium',
  enabledTiers: { fast: true, powerful: true },
  defaultSpawnTier: 'powerful',
  roles: [{ role: 'conductor', label: 'Conductor', builtin: true }],
  roleBackend: { conductor: { kind: 'tier', tier: 'powerful' } },
  roleEffort: { conductor: { effort: 'inherit', inheritsTo: 'medium' } },
  customModels: [],
  ollamaCloudModels: [],
  onOverage: 'none',
  overageThreshold: { enabled: false, value: 85 },
  conductorCompactWindow: { enabled: false, value: 200 },
});

let calls: Call[];

function Host() {
  const route = useRoute();
  return route.view === 'settings' ? <SettingsView /> : <div data-testid="elsewhere" />;
}

function openAt(hash: string) {
  history.replaceState(null, '', `/${hash}`);
  syncRoute();
  return render(<TooltipProvider><Host /></TooltipProvider>);
}

const navLabels = () => within(screen.getByRole('navigation', { name: 'Settings sections' })).getAllByRole('link').map((a) => a.textContent?.trim());

beforeEach(() => {
  modelsSettingsStore.set({ data: null, error: null, status: null });
  vi.mocked(loadCapabilities).mockReset();
  calls = mockFetch({
    'GET /api/settings/models': () => models(),
    'GET /api/settings/spawn': () => ({}),
    'GET /api/claude-auth/status': () => ({ loggedIn: false, authMethod: 'none' }),
    'GET /api/claude-auth/login': () => ({ state: 'idle' }),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('Settings view', () => {
  // The nav link switches the routed section: the Account body (with its overage card) replaces the Models body.
  it('picking Account shows the Account section and hides Models', async () => {
    vi.mocked(loadCapabilities).mockResolvedValue({ remoteSystems: true, voice: true });
    openAt('#settings');
    await screen.findByRole('heading', { level: 2, name: 'Models' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('link', { name: 'Account' }));
    expect(location.hash).toBe('#settings/account');
    expect(document.querySelector('[data-section="account"]')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Account' })).toBeTruthy();
    expect(screen.getByText('Overage protection')).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2, name: 'Models' })).toBeNull();
  });

  // A platform without remote systems / voice never lists, mounts or fetches those sections, and a link to one lands on the first section.
  it('without remote systems or voice, Systems and Voice are not offered and never fetched, even from a link', async () => {
    vi.mocked(loadCapabilities).mockResolvedValue({ remoteSystems: false, voice: false });
    openAt('#settings/systems');
    await waitFor(() => expect(location.hash).toBe('#settings/models'));
    expect(navLabels()).toEqual(['Models', 'Conventions', 'Plugins', 'Backends', 'Account', 'Archived', 'About']);
    act(() => { history.replaceState(null, '', '/#settings/voice'); syncRoute(); });
    await waitFor(() => expect(location.hash).toBe('#settings/models'));
    await act(async () => {});
    const gated = calls.filter((c) => ['/api/settings/systems', '/api/settings/transcribe', '/api/settings/tts'].some((p) => c.url.startsWith(p)));
    expect(gated).toEqual([]);
    expect(calls.some((c) => c.method === 'GET' && c.url.startsWith('/api/settings/models'))).toBe(true);
  });

  // Escape on the deep-linked view leaves it for the session view.
  it('Escape leaves Settings', async () => {
    vi.mocked(loadCapabilities).mockResolvedValue({ remoteSystems: true, voice: true });
    openAt('#settings');
    await screen.findByRole('heading', { level: 2, name: 'Models' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('[data-settings-view]')).toBeNull();
    expect(screen.getByTestId('elsewhere')).toBeTruthy();
    expect(routeStore.get().route.view).toBe('session');
  });

  // Escape still leaves when the URL already reads a session the route store never saw.
  it('Escape leaves Settings even after the hash drifted to a session without a route sync', async () => {
    vi.mocked(loadCapabilities).mockResolvedValue({ remoteSystems: true, voice: true });
    openAt('#settings/models');
    await screen.findByRole('heading', { level: 2, name: 'Models' });
    history.replaceState(null, '', '/#session=drifted');
    expect(document.querySelector('[data-settings-view]')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('[data-settings-view]')).toBeNull();
    expect(screen.getByTestId('elsewhere')).toBeTruthy();
  });
});
