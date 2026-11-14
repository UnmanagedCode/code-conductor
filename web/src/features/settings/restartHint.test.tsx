import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { mockFetch } from './test/fetchMock';

vi.mock('@/app/sessionActions', () => ({ resumeSession: vi.fn(async () => {}) }));
vi.mock('@/app/controller', () => ({ refreshProjects: vi.fn(async () => {}), refreshInstances: vi.fn(async () => {}) }));
vi.mock('@/app/models', () => ({ applyModels: vi.fn() }));
vi.mock('@/features/sidebar/restart', () => ({ performRestart: vi.fn(async () => ({ ok: true })) }));

import { performRestart } from '@/features/sidebar/restart';
import { AboutSection, selfUpdateStore } from './AboutSection';
import { pluginsStore } from './PluginsSection';
import { settle } from '@/test/settle';
import type { ServerRestartState } from '@shared/wireRows';

const INITIAL = selfUpdateStore.get();
const PLUGINS0 = pluginsStore.get();

const PLUGIN_ROUTES = {
  'GET /api/plugins': () => ({ rows: [], notices: [] }),
  'GET /api/projects': () => [],
  'GET /api/plugins/library': () => ({ entries: [], skipped: [] }),
};

// Full shas whose 7-char prefixes share no substring.
const BOOT = '0b5e1d9c2f3a4b5c6d7e8f9012345678abcdef01';
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const status = (restart: ServerRestartState) => ({ version: '1.0', canCheck: true, restart });
const versionCard = () => screen.getByText('Version', { selector: '[data-slot="card-title"]' }).closest('[data-slot="card"]') as HTMLElement;
const line = () => within(versionCard()).queryByRole('status')?.textContent ?? '';

beforeEach(() => {
  selfUpdateStore.set(INITIAL);
  pluginsStore.set(PLUGINS0);
  vi.mocked(performRestart).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('About restart hint', () => {
  // Invariant: a needed restart is one note in the Version card that names the target (head) commit by its short sha, never the boot commit or the full sha, and never restarts by itself.
  it('a needed restart shows one note in the Version card naming the target commit by its short sha', async () => {
    mockFetch({ ...PLUGIN_ROUTES, 'GET /api/settings/self-update': () => status({ state: 'needed', boot: BOOT, head: HEAD, reason: 'src/a.ts changed' }) });
    render(<AboutSection />);
    await waitFor(() => expect(line()).toContain('v1.0'));
    const notes = within(versionCard()).getAllByRole('note');
    expect(notes).toHaveLength(1);
    const text = notes[0].textContent ?? '';
    expect(text).toContain(HEAD.slice(0, 7));
    expect(text).not.toContain(HEAD);
    expect(text).not.toContain(BOOT.slice(0, 7));
    await settle();
    expect(performRestart).not.toHaveBeenCalled();
  });

  // Invariant: only `needed` asks for a restart; a HEAD that moved without touching server code (live), the boot commit itself (current) and an unmeasurable boot (unknown) show no note.
  it.each<[string, ServerRestartState]>([
    ['current', { state: 'current', boot: BOOT }],
    ['live', { state: 'live', boot: BOOT, head: HEAD }],
    ['unknown', { state: 'unknown', reason: 'no boot commit' }],
  ])('%s shows no note', async (_name, restart) => {
    mockFetch({ ...PLUGIN_ROUTES, 'GET /api/settings/self-update': () => status(restart) });
    render(<AboutSection />);
    await waitFor(() => expect(line()).toContain('v1.0'));
    await settle();
    expect(within(versionCard()).queryByRole('note')).toBeNull();
  });

  // Invariant: a remount whose check fails shows no hint left over from the previous mount.
  it('a remount whose check fails drops the hint the previous mount showed', async () => {
    mockFetch({ ...PLUGIN_ROUTES, 'GET /api/settings/self-update': () => status({ state: 'needed', boot: BOOT, head: HEAD, reason: 'x' }) });
    const first = render(<AboutSection />);
    await within(versionCard()).findByRole('note');
    first.unmount();
    cleanup();
    mockFetch({ ...PLUGIN_ROUTES, 'GET /api/settings/self-update': () => ({ status: 500, json: { error: 'down' } }) });
    render(<AboutSection />);
    await waitFor(() => expect(line()).toContain('down'));
    expect(within(versionCard()).queryByRole('note')).toBeNull();
  });
});
