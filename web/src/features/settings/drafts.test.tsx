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
import { modelsDraftStore } from './models/ModelsSection';
import { backendsDraftStore } from './BackendsSection';
import { systemsDraftStore } from './SystemsSection';
import type { ModelsPayload } from './models/logic';
import { SettingsView } from './SettingsView';

type Custom = NonNullable<ModelsPayload['customModels']>[number];

const MINE: Custom = { label: 'Mine', model: 'mine:v1', backend: 'ollama', contextWindow: 131072, midTurnSteering: false };
const OTHER: Custom = { label: 'Other', model: 'other:v2', backend: 'px', contextWindow: 300000, midTurnSteering: true };
const LOCAL = { id: 'local', label: 'This machine', managed: true, projects: [] };
const PROD = { id: 'prod-box', label: 'Prod box', launch: ['ssh', 'prod', 'cc-provider'], projects: [{ name: 'shipping', remoteId: 'ctr-7' }] };

let customs: Custom[];

const models = (): ModelsPayload => ({
  backends: [
    { id: 'claude', label: 'Claude', template: '', env: [], managed: true },
    { id: 'ollama', label: 'Ollama', template: 'ollama launch claude --model {model} --yes --', env: [], managed: true },
    { id: 'px', label: 'My Proxy', template: 'px {model}', env: [] },
  ],
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
  customModels: customs,
  ollamaCloudModels: [],
  conductorCompactWindow: { enabled: false, value: 200 },
});

let calls: Call[];
const DRAFTS = [modelsDraftStore.get(), backendsDraftStore.get(), systemsDraftStore.get()] as const;

function Host() {
  const route = useRoute();
  return route.view === 'settings' ? <SettingsView /> : <div data-testid="elsewhere" />;
}

function openAt(hash: string) {
  history.replaceState(null, '', `/${hash}`);
  syncRoute();
  return render(<TooltipProvider><Host /></TooltipProvider>);
}

const heading = (name: string) => screen.findByRole('heading', { level: 2, name });
const SECTION_HEADING = { models: 'Models', backends: 'Backends', systems: 'Systems' } as const;
type Section = keyof typeof SECTION_HEADING;

/** Switches sections through the nav, without leaving Settings. */
async function switchTo(section: Section) {
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('link', { name: SECTION_HEADING[section] }));
  expect(location.hash).toBe(`#settings/${section}`);
  await heading(SECTION_HEADING[section]);
}

/** Leaves Settings for a session, then comes back to `section`. */
async function leaveAndReenter(section: Section) {
  act(() => { history.replaceState(null, '', '/#session=x'); syncRoute(); });
  expect(document.querySelector('[data-settings-view]')).toBeNull();
  act(() => { history.replaceState(null, '', `/#settings/${section}`); syncRoute(); });
  await heading(SECTION_HEADING[section]);
}

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const steer = () => document.getElementById('cm-steer') as HTMLElement;
const hasButton = (name: string) => screen.queryByRole('button', { name }) !== null;
const writes = () => calls.filter((c) => c.method !== 'GET');
const gets = (url: string) => calls.filter((c) => c.method === 'GET' && c.url === url).length;
const customStatus = () => {
  const card = screen.getByText('Custom models', { selector: '[data-slot="card-title"]' }).closest('[data-slot="card"]') as HTMLElement;
  return within(card).queryAllByRole('status').map((s) => s.textContent).join('');
};

beforeEach(() => {
  customs = [MINE, OTHER];
  modelsSettingsStore.set({ data: null, error: null, status: null });
  modelsDraftStore.set(DRAFTS[0]);
  backendsDraftStore.set(DRAFTS[1]);
  systemsDraftStore.set(DRAFTS[2]);
  vi.mocked(loadCapabilities).mockReset();
  vi.mocked(loadCapabilities).mockResolvedValue({ remoteSystems: true, voice: true });
  calls = mockFetch({
    'GET /api/settings/models': () => models(),
    'GET /api/settings/spawn': () => ({}),
    'GET /api/settings/systems': () => ({ systems: [LOCAL, PROD] }),
    'PATCH /api/settings/models/custom/ollama/mine%3Av1': () => models(),
    'PATCH /api/settings/models/backends/px': () => models(),
    'POST /api/settings/models/roles': () => models(),
    'PATCH /api/settings/systems/prod-box': () => ({ systems: [LOCAL, PROD] }),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('Settings edit drafts', () => {
  // Every typed custom-model field, the edited pair's lock and the edit status survive a section remount and a Settings remount, and Save still PATCHes the edited pair with the typed values.
  it('a custom-model edit survives a section switch and leaving Settings, locked on its pair with every typed field', async () => {
    openAt('#settings/models');
    await screen.findByRole('button', { name: 'Edit Mine' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mine' }));
    type('Label', 'Draft');
    type('Context', '64k');
    fireEvent.click(steer());
    expect(steer().getAttribute('aria-checked')).toBe('true');
    const expectDraft = () => {
      expect(input('Label').value).toBe('Draft');
      expect((screen.getByLabelText('Backend', { selector: '#cm-backend' }) as HTMLSelectElement).value).toBe('ollama');
      expect((screen.getByLabelText('Backend', { selector: '#cm-backend' }) as HTMLSelectElement).disabled).toBe(true);
      expect(input('Model id').value).toBe('mine:v1');
      expect(input('Model id').disabled).toBe(true);
      expect(input('Context').value).toBe('64k');
      expect(steer().getAttribute('aria-checked')).toBe('true');
      expect(hasButton('Save')).toBe(true);
      expect(hasButton('Cancel')).toBe(true);
      expect(customStatus()).toContain('Mine');
    };
    await switchTo('backends');
    await switchTo('models');
    expectDraft();
    await leaveAndReenter('models');
    expectDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: 'PATCH', url: '/api/settings/models/custom/ollama/mine%3Av1', body: { label: 'Draft', contextWindow: 64000, midTurnSteering: true } });
  });

  // Cancel and a successful Save each end the draft for good, and a return to a payload that lost the edited pair ends edit mode with no Remove sent.
  it('a custom-model draft clears on Cancel and on a successful Save, and a pair removed while away ends edit mode on return', async () => {
    openAt('#settings/models');
    await screen.findByRole('button', { name: 'Edit Mine' });
    const expectAddMode = () => {
      expect(input('Label').value).toBe('');
      expect(input('Model id').disabled).toBe(false);
      expect(hasButton('Cancel')).toBe(false);
      expect(hasButton('Add model')).toBe(true);
    };
    // (a) Cancel
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mine' }));
    type('Label', 'x');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await switchTo('backends');
    await switchTo('models');
    expectAddMode();
    // (b) a successful Save
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mine' }));
    type('Label', 'y');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    await switchTo('backends');
    await switchTo('models');
    expectAddMode();
    // (c) the edited pair is gone from the payload the return loads
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mine' }));
    type('Label', 'z');
    const before = writes().length;
    act(() => { history.replaceState(null, '', '/#session=x'); syncRoute(); });
    customs = [OTHER];
    const loads = gets('/api/settings/models');
    act(() => { history.replaceState(null, '', '/#settings/models'); syncRoute(); });
    await waitFor(() => expect(gets('/api/settings/models')).toBe(loads + 1));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Mine' })).toBeNull());
    expectAddMode();
    expect(writes().slice(before)).toEqual([]);
  });

  // A backend edit's id lock, template and env survive a section remount and a Settings remount and are what Save PATCHes; Cancel ends the draft.
  it('a backend edit survives a section switch and leaving Settings, and clears on Cancel', async () => {
    openAt('#settings/backends');
    await screen.findByRole('button', { name: 'Edit My Proxy' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit My Proxy' }));
    type('Template', 'draft {model}');
    type('Env (optional)', 'K=v');
    const expectDraft = () => {
      expect(input('Id').value).toBe('px');
      expect(input('Id').disabled).toBe(true);
      expect(input('Template').value).toBe('draft {model}');
      expect(input('Env (optional)').value).toBe('K=v');
      expect(hasButton('Save')).toBe(true);
      expect(screen.getByText('Edit My Proxy', { selector: '[data-slot="card-title"]' })).toBeTruthy();
    };
    await switchTo('models');
    await switchTo('backends');
    expectDraft();
    await leaveAndReenter('backends');
    expectDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: 'PATCH', url: '/api/settings/models/backends/px', body: { label: 'My Proxy', template: 'draft {model}', env: [{ key: 'K', value: 'v' }] } });
    await waitFor(() => expect(hasButton('Add backend')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Edit My Proxy' }));
    type('Label', 'Typed');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await switchTo('models');
    await switchTo('backends');
    expect(input('Id').value).toBe('');
    expect(input('Id').disabled).toBe(false);
    expect(hasButton('Add backend')).toBe(true);
  });

  // Invariant: Cancel resets every backend field, Label included, and the cleared form stays cleared across a section remount.
  it('Cancel on a backend edit clears every typed field, the label included, and it stays cleared after a section switch', async () => {
    openAt('#settings/backends');
    await screen.findByRole('button', { name: 'Edit My Proxy' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit My Proxy' }));
    type('Label', 'Typed');
    type('Template', 'typed {model}');
    type('Env (optional)', 'K=v');
    expect(input('Label').value).toBe('Typed');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const expectCleared = () => {
      expect(input('Label').value).toBe('');
      expect(input('Id').value).toBe('');
      expect(input('Template').value).toBe('');
      expect(input('Env (optional)').value).toBe('');
      expect(hasButton('Add backend')).toBe(true);
    };
    expectCleared();
    await switchTo('models');
    await switchTo('backends');
    expectCleared();
    expect(writes()).toEqual([]);
  });

  // Add-mode typing (a custom model, a backend id, a role name) survives section remounts; a successful Add role clears only the role name, durably.
  it('typed Add forms and a typed role name survive a section switch; a successful add clears the role name', async () => {
    openAt('#settings/models');
    await screen.findByRole('button', { name: 'Edit Mine' });
    type('New role name', 'tester');
    type('Label', 'New');
    type('Model id', 'new:v1');
    await switchTo('backends');
    type('Id', 'newbe');
    await switchTo('models');
    expect(input('New role name').value).toBe('tester');
    expect(input('Label').value).toBe('New');
    expect(input('Model id').value).toBe('new:v1');
    await switchTo('backends');
    expect(input('Id').value).toBe('newbe');
    await switchTo('models');
    await switchTo('backends');
    expect(input('Id').value).toBe('newbe');
    await switchTo('models');
    expect(input('New role name').value).toBe('tester');
    fireEvent.click(screen.getByRole('button', { name: 'Add role' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: 'POST', url: '/api/settings/models/roles', body: { role: 'tester' } });
    await waitFor(() => expect(input('New role name').value).toBe(''));
    await switchTo('backends');
    await switchTo('models');
    expect(input('New role name').value).toBe('');
    expect(input('Label').value).toBe('New');
  });

  // A system edit's id lock, label and provider command survive a section remount (which re-fetches the list) and a Settings remount, are what Save PATCHes, and a successful Save ends the draft.
  it('a system edit survives a section switch and leaving Settings, and a successful Save clears it', async () => {
    openAt('#settings/systems');
    await screen.findByRole('button', { name: 'Edit Prod box' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Prod box' }));
    type('Label', 'Draft');
    type('Provider command', 'ssh prod2 cc-provider');
    const expectDraft = async () => {
      await screen.findByRole('button', { name: 'Edit Prod box' });
      expect(input('Id').value).toBe('prod-box');
      expect(input('Id').disabled).toBe(true);
      expect(input('Label').value).toBe('Draft');
      expect(input('Provider command').value).toBe('ssh prod2 cc-provider');
      expect(hasButton('Save')).toBe(true);
    };
    const listLoads = gets('/api/settings/systems');
    await switchTo('models');
    await switchTo('systems');
    await expectDraft();
    expect(gets('/api/settings/systems')).toBe(listLoads + 1);
    await leaveAndReenter('systems');
    await expectDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: 'PATCH', url: '/api/settings/systems/prod-box', body: { label: 'Draft', launch: ['ssh', 'prod2', 'cc-provider'], worktreesDir: null } });
    await waitFor(() => expect(hasButton('Add system')).toBe(true));
    await switchTo('models');
    await switchTo('systems');
    await screen.findByRole('button', { name: 'Edit Prod box' });
    expect(input('Id').value).toBe('');
    expect(input('Id').disabled).toBe(false);
    expect(hasButton('Add system')).toBe(true);
  });
});
