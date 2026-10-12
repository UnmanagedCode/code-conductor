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
import { syncRoute, useRoute } from '@/state/route';
import { modelsSettingsStore } from './models/store';
import type { ModelsPayload } from './models/logic';
import { SettingsView } from './SettingsView';
import { discardOverageDraft } from './AccountSection';

type Committed = Required<Pick<ModelsPayload, 'onOverage' | 'overageThreshold'>>;
type Shown = { action: (string | null)[]; threshold: string | null; value: string | null; applyEnabled: boolean; unsavedHint: boolean };

// Every field away from its default (none, off, 85) and the staged edit away from the server's.
const SERVER_START: Committed = { onOverage: 'stop', overageThreshold: { enabled: false, value: 60 } };
const START: Shown = { action: ['Stop'], threshold: 'false', value: null, applyEnabled: false, unsavedHint: false };
const STAGED: Shown = { action: ['Stop & resume'], threshold: 'true', value: '40', applyEnabled: true, unsavedHint: true };

/** The server's committed overage prefs: every models GET and every prefs answer carries them. */
let server: Partial<Committed>;
let calls: Call[];

const models = (): ModelsPayload => ({
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
  roleBackend: { conductor: { kind: 'tier', tier: 'powerful', model: '' } },
  roleEffort: { conductor: { effort: 'inherit', inheritsTo: 'medium' } },
  customModels: [],
  ollamaCloudModels: [],
  conductorCompactWindow: { enabled: false, value: 200 },
  ...server,
});

/** Routes the Settings reads; `prefs` answers every POST to /api/settings/models/prefs. */
function routes(prefs: (c: Call) => unknown) {
  calls = mockFetch({
    'GET /api/settings/models': () => models(),
    'GET /api/settings/spawn': () => ({}),
    'GET /api/claude-auth/status': () => ({ loggedIn: false, authMethod: 'none' }),
    'POST /api/settings/models/prefs': prefs,
  });
}

/** The server commits an overage Apply with its threshold snapped to 45, and answers the payload. */
const commitSnapped = (c: Call) => {
  server = { onOverage: c.body.onOverage, overageThreshold: { enabled: c.body.overageThreshold.enabled, value: 45 } };
  return models();
};

function Host() {
  const route = useRoute();
  return route.view === 'settings' ? <SettingsView /> : <div data-testid="elsewhere" />;
}

function openAt(hash: string) {
  history.replaceState(null, '', `/${hash}`);
  syncRoute();
  return render(<TooltipProvider><Host /></TooltipProvider>);
}

const SECTION_HEADING = { account: 'Account', models: 'Models' } as const;
type Section = keyof typeof SECTION_HEADING;

/** Switches sections through the nav, without leaving Settings. */
async function switchTo(section: Section) {
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('link', { name: SECTION_HEADING[section] }));
  expect(location.hash).toBe(`#settings/${section}`);
  await screen.findByRole('heading', { level: 2, name: SECTION_HEADING[section] });
}

/** Leaves Settings for a session, then comes back to `section`. */
async function leaveAndReenter(section: Section) {
  act(() => { history.replaceState(null, '', '/#session=x'); syncRoute(); });
  expect(document.querySelector('[data-settings-view]')).toBeNull();
  act(() => { history.replaceState(null, '', `/#settings/${section}`); syncRoute(); });
  await screen.findByRole('heading', { level: 2, name: SECTION_HEADING[section] });
}

const card = () => screen.getByRole('group', { name: 'Action on overage' }).closest('[data-slot="card"]') as HTMLElement;

/** What the overage card shows: the pressed action(s), the threshold switch, the slider (null while hidden), Apply, and the unsaved hint. */
function shown(): Shown {
  const c = card();
  return {
    action: within(c).getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent),
    threshold: within(c).getByRole('switch', { name: 'Also stop at a usage threshold' }).getAttribute('aria-checked'),
    value: (within(c).queryByRole('slider', { name: 'Stop at' }) as HTMLInputElement | null)?.value ?? null,
    applyEnabled: !(within(c).getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled,
    unsavedHint: within(c).queryByText(/unsaved/i) !== null,
  };
}

const statuses = () => within(card()).queryAllByRole('status').map((s) => ({ tone: s.getAttribute('data-tone'), text: s.textContent ?? '' }));
const APPLIED_STATUS = [{ tone: 'ok', text: expect.stringMatching(/applied/i) }];
const REFUSED_STATUS = [{ tone: 'error', text: expect.stringContaining('disk full') }];

/** Stages Stop & resume, the threshold switched on, and 40. */
function stage() {
  const c = card();
  fireEvent.click(within(c).getByRole('button', { name: 'Stop & resume' }));
  fireEvent.click(within(c).getByRole('switch', { name: 'Also stop at a usage threshold' }));
  fireEvent.change(within(c).getByRole('slider', { name: 'Stop at' }), { target: { value: '40' } });
}

const prefsPosts = () => calls.filter((c) => c.method === 'POST' && c.url === '/api/settings/models/prefs').map((c) => c.body);
const apply = () => fireEvent.click(within(card()).getByRole('button', { name: 'Apply' }));

beforeEach(() => {
  server = SERVER_START;
  modelsSettingsStore.set({ data: null, error: null, status: null });
  discardOverageDraft();
  vi.mocked(loadCapabilities).mockReset();
  vi.mocked(loadCapabilities).mockResolvedValue({ remoteSystems: true, voice: true });
});
afterEach(() => vi.unstubAllGlobals());

describe('Account → overage draft', () => {
  // The action, the threshold switch, its value and the staged state each outlive the section's remount, and Apply then commits exactly the staged values.
  it('a staged overage edit survives a section switch with every field, and Apply still commits it', async () => {
    routes(commitSnapped);
    openAt('#settings/account');
    await waitFor(() => expect(shown()).toEqual(START));
    stage();
    expect(shown(), 'positive control: the edit is staged').toEqual(STAGED);
    await switchTo('models');
    await switchTo('account');
    expect(shown(), 'the staged edit survives the section switch').toEqual(STAGED);
    expect(prefsPosts()).toEqual([]);
    apply();
    await waitFor(() => expect(prefsPosts()).toEqual([{ onOverage: 'stop-resume', overageThreshold: { enabled: true, value: 40 } }]));
  });

  // A newer payload that lands while the edit is staged and Account is not shown reaches the store but not the staged controls.
  it('a save elsewhere while Account is not shown leaves the staged edit in place on return', async () => {
    routes((c) => {
      if (c.body.tierEnabled) server = { onOverage: 'none', overageThreshold: { enabled: true, value: 20 } };
      return models();
    });
    openAt('#settings/account');
    await waitFor(() => expect(shown()).toEqual(START));
    stage();
    await switchTo('models');
    fireEvent.click(screen.getByRole('switch', { name: 'Enable the Fast tier' }));
    await waitFor(() => expect(modelsSettingsStore.get().data?.onOverage, 'positive control: the save elsewhere answered newer overage prefs').toBe('none'));
    await switchTo('account');
    expect(shown(), 'the staged edit outlives the newer payload').toEqual(STAGED);
    expect(prefsPosts()).toEqual([{ tierEnabled: { tier: 'fast', enabled: false } }]);
  });

  // Apply leaves no draft behind: a remount shows the server's answer (45, not the typed 40) with nothing staged and the applied status; a new edit clears that status, and reopening Settings discards the edit.
  it('Apply clears the draft: a section switch then shows what the server committed with the applied status, a new edit clears that status, and reopening Settings discards the edit', async () => {
    routes(commitSnapped);
    openAt('#settings/account');
    await waitFor(() => expect(shown()).toEqual(START));
    stage();
    apply();
    const APPLIED: Shown = { action: ['Stop & resume'], threshold: 'true', value: '45', applyEnabled: false, unsavedHint: false };
    await waitFor(() => {
      expect(statuses()).toEqual(APPLIED_STATUS);
      expect(shown()).toEqual(APPLIED);
    });
    await switchTo('models');
    await switchTo('account');
    expect(shown(), 'no draft is left: the server answer shows with nothing staged').toEqual(APPLIED);
    expect(statuses(), 'the applied status survives the section switch').toEqual(APPLIED_STATUS);
    fireEvent.click(within(card()).getByRole('button', { name: 'Off' }));
    expect(shown(), 'positive control: a new edit is staged').toEqual({ ...APPLIED, action: ['Off'], applyEnabled: true, unsavedHint: true });
    expect(statuses(), 'a new edit clears the applied status').toEqual([]);
    await leaveAndReenter('account');
    await waitFor(() => expect(shown(), 'reopening Settings discards the new edit').toEqual(APPLIED));
    expect(statuses()).toEqual([]);
  });

  // A refused Apply keeps every staged field, the staged state and the error through a remount; reopening Settings discards them for the reloaded server values.
  it('a refused Apply keeps the edit and its error across a section switch, and reopening Settings discards both for the server values', async () => {
    routes(() => ({ status: 500, json: { error: 'disk full' } }));
    openAt('#settings/account');
    await waitFor(() => expect(shown()).toEqual(START));
    stage();
    apply();
    await waitFor(() => expect(statuses()).toEqual(REFUSED_STATUS));
    expect(shown(), 'positive control: the refused edit stays staged').toEqual(STAGED);
    await switchTo('models');
    await switchTo('account');
    expect(shown(), 'the refused edit survives the section switch').toEqual(STAGED);
    expect(statuses(), 'its error survives the section switch').toEqual(REFUSED_STATUS);
    server = { onOverage: 'none', overageThreshold: { enabled: true, value: 20 } };
    await leaveAndReenter('account');
    await waitFor(() => expect(shown(), 'reopening Settings shows the reloaded server values with nothing staged').toEqual({ action: ['Off'], threshold: 'true', value: '20', applyEnabled: false, unsavedHint: false }));
    expect(statuses(), 'reopening Settings clears the error').toEqual([]);
  });

  // Reopening Settings drops the draft before the card first renders: no DOM change on the way in carries the old error, the unsaved hint, or an Apply that starts enabled.
  it('reopening Settings at Account never renders the discarded edit, its error or an enabled Apply, even for a moment', async () => {
    routes(() => ({ status: 500, json: { error: 'disk full' } }));
    openAt('#settings/account');
    await waitFor(() => expect(shown()).toEqual(START));
    stage();
    apply();
    await waitFor(() => expect(statuses()).toEqual(REFUSED_STATUS));
    act(() => { history.replaceState(null, '', '/#session=x'); syncRoute(); });
    expect(document.querySelector('[data-settings-view]')).toBeNull();
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((r) => { records.push(...r); });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
    act(() => { history.replaceState(null, '', '/#settings/account'); syncRoute(); });
    await waitFor(() => expect(shown()).toEqual(START));
    records.push(...observer.takeRecords());
    observer.disconnect();
    const touched = records.flatMap((r) => [...r.addedNodes, ...r.removedNodes]).filter((n): n is Element => n instanceof Element);
    const texts = touched.map((n) => n.textContent ?? '');
    expect(touched.some((n) => n.querySelector('[role="group"][aria-label="Action on overage"]') !== null), 'positive control: the observer saw the card mount').toBe(true);
    expect(texts.filter((t) => t.includes('disk full')), 'the discarded error never reaches the DOM').toEqual([]);
    expect(texts.filter((t) => /unsaved/i.test(t)), 'nor does the unsaved hint').toEqual([]);
    expect(records.filter((r) => r.type === 'attributes' && (r.target as Element).textContent === 'Apply').map((r) => r.oldValue), 'Apply mounts disabled and stays so').toEqual([]);
  });

  // Settings' default entry (bare #settings) opens another section; the draft is already gone when Account is then picked from the nav.
  it('reopening Settings at its default section and then picking Account never renders the discarded edit or its error, and shows the server values', async () => {
    routes(() => ({ status: 500, json: { error: 'disk full' } }));
    openAt('#settings/account');
    await waitFor(() => expect(shown()).toEqual(START));
    stage();
    apply();
    await waitFor(() => expect(statuses()).toEqual(REFUSED_STATUS));
    act(() => { history.replaceState(null, '', '/#session=x'); syncRoute(); });
    expect(document.querySelector('[data-settings-view]')).toBeNull();
    server = { onOverage: 'none', overageThreshold: { enabled: true, value: 20 } };
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((r) => { records.push(...r); });
    observer.observe(document.body, { subtree: true, childList: true });
    act(() => { history.replaceState(null, '', '/#settings'); syncRoute(); });
    await screen.findByRole('heading', { level: 2, name: SECTION_HEADING.models });
    expect(screen.queryByRole('group', { name: 'Action on overage' }), 'positive control: Settings opened at another section').toBeNull();
    await switchTo('account');
    await waitFor(() => expect(shown(), 'Account shows the reloaded server values with nothing staged').toEqual({ action: ['Off'], threshold: 'true', value: '20', applyEnabled: false, unsavedHint: false }));
    records.push(...observer.takeRecords());
    observer.disconnect();
    const touched = records.flatMap((r) => [...r.addedNodes, ...r.removedNodes]).filter((n): n is Element => n instanceof Element);
    const texts = touched.map((n) => n.textContent ?? '');
    expect(touched.some((n) => n.querySelector('[role="group"][aria-label="Action on overage"]') !== null), 'positive control: the observer saw the card mount').toBe(true);
    expect(texts.filter((t) => t.includes('disk full')), 'the discarded error never reaches the DOM').toEqual([]);
    expect(texts.filter((t) => /unsaved/i.test(t)), 'nor does the unsaved hint').toEqual([]);
    expect(statuses(), 'no status on Account').toEqual([]);
  });

  // With no overage prefs in the payload the card falls back to Off with the threshold off, and switching the threshold on starts it at 85.
  it('a payload without overage prefs shows Off with no threshold, and switching the threshold on starts it at 85', async () => {
    server = {};
    routes(commitSnapped);
    openAt('#settings/account');
    await screen.findByRole('heading', { level: 2, name: 'Account' });
    await waitFor(() => expect(modelsSettingsStore.get().data, 'positive control: the payload landed').not.toBeNull());
    expect(shown()).toEqual({ action: ['Off'], threshold: 'false', value: null, applyEnabled: false, unsavedHint: false });
    fireEvent.click(within(card()).getByRole('switch', { name: 'Also stop at a usage threshold' }));
    expect(shown()).toEqual({ action: ['Off'], threshold: 'true', value: '85', applyEnabled: true, unsavedHint: true });
  });

  // The DOM commit that first shows the applied status already shows the server's answer, never the typed values beside it.
  it('the applied status first appears together with the values the server committed', async () => {
    routes(commitSnapped);
    openAt('#settings/account');
    await waitFor(() => expect(shown()).toEqual(START));
    stage();
    const first: Shown[] = [];
    const observer = new MutationObserver(() => {
      if (first.length === 0 && statuses().some((s) => s.tone === 'ok')) first.push(shown());
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    apply();
    await waitFor(() => expect(first, 'positive control: the applied status appeared').toHaveLength(1));
    observer.disconnect();
    expect(first[0], 'the first DOM state with the applied status shows the committed values').toEqual({ action: ['Stop & resume'], threshold: 'true', value: '45', applyEnabled: false, unsavedHint: false });
  });
});
