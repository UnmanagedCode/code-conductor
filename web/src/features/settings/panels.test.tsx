import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { mockFetch } from './test/fetchMock';

vi.mock('@/app/sessionActions', () => ({ resumeSession: vi.fn(async () => {}) }));
vi.mock('@/app/controller', () => ({ refreshProjects: vi.fn(async () => {}), refreshInstances: vi.fn(async () => {}) }));
vi.mock('@/app/models', () => ({ applyModels: vi.fn() }));
vi.mock('@/features/sidebar/restart', () => ({ performRestart: vi.fn(async () => {}) }));

import { resumeSession } from '@/app/sessionActions';
import { applyModels } from '@/app/models';
import { modelsSettingsStore, loadModelsSettings } from './models/store';
import { OverageCard } from './AccountSection';
import { ClaudeLogin } from './ClaudeLogin';
import { BackendsSection } from './BackendsSection';
import { SystemsSection } from './SystemsSection';
import { ModelsSection, EffortPicker } from './models/ModelsSection';
import { ArchivedSection } from './ArchivedSection';
import { PluginsSection } from './PluginsSection';
import { pluginsChangeStore, pluginsChangedSignal } from './pluginsSignal';
import { on } from '@/app/events';
import { ConfirmHost } from '@/ui/feedback';

const wrap = (ui: React.ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>);

const models = (over: object = {}) => ({
  backends: [
    { id: 'claude', label: 'Claude', template: '', env: [], managed: true },
    { id: 'ollama', label: 'Ollama', template: 'ollama launch claude --model {model} --yes --', env: [], managed: true },
    { id: 'mine', label: 'Mine', template: 'mine run {model}', env: [{ key: 'A', value: '1' }] },
  ],
  claudeFamilies: [{ family: 'sonnet', label: 'Sonnet', default: 'claude-sonnet-5-5', versions: [{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }] }],
  tiers: [{ tier: 'fast', label: 'Fast' }, { tier: 'powerful', label: 'Powerful' }],
  tierBackend: { fast: { backend: 'claude', model: 'claude-sonnet-5-5' }, powerful: { backend: 'claude', model: 'claude-sonnet-5-5' } },
  tierEffort: { fast: 'low' },
  efforts: ['low', 'medium', 'high', 'max'],
  defaultEffort: 'medium',
  enabledTiers: { fast: true, powerful: true },
  defaultSpawnTier: 'powerful',
  roles: [{ role: 'conductor', label: 'Conductor', builtin: true }],
  roleBackend: { conductor: { kind: 'tier', tier: 'powerful' } },
  roleEffort: { conductor: { effort: 'inherit', inheritsTo: 'high' } },
  customModels: [{ label: 'Mine 1', model: 'm1', backend: 'mine', contextWindow: 200000 }],
  ollamaCloudModels: [],
  onOverage: 'stop',
  overageThreshold: { enabled: true, value: 70 },
  conductorCompactWindow: { enabled: false, value: 200 },
  ...over,
});

beforeEach(() => {
  modelsSettingsStore.set({ data: null, error: null, status: null });
  vi.mocked(applyModels).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('Account → overage protection', () => {
  it('populates from the models payload, stages edits until Apply, then commits both fields', async () => {
    const calls = mockFetch({ 'POST /api/settings/models/prefs': (c) => models({ onOverage: c.body.onOverage, overageThreshold: c.body.overageThreshold }) });
    modelsSettingsStore.set({ data: models() as any });
    wrap(<OverageCard />);
    expect(screen.getByRole('button', { name: 'Stop', pressed: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Stop & resume' }));
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByText('Overage settings applied');
    expect(calls[0].body).toEqual({ onOverage: 'stop-resume', overageThreshold: { enabled: true, value: 70 } });
  });

  it('a failed Apply keeps the edit staged and shows the error', async () => {
    mockFetch({ 'POST /api/settings/models/prefs': () => ({ status: 400, json: { error: 'bad threshold' } }) });
    modelsSettingsStore.set({ data: models() as any });
    wrap(<OverageCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByText('Update failed: bad threshold');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Off', pressed: true })).toBeTruthy();
  });

  it('a prefs save elsewhere does not clobber a staged, unapplied edit', () => {
    modelsSettingsStore.set({ data: models() as any });
    wrap(<OverageCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    act(() => modelsSettingsStore.set({ data: models({ onOverage: 'stop-resume' }) as any }));
    expect(screen.getByRole('button', { name: 'Off', pressed: true })).toBeTruthy();
  });
});

describe('Account → Claude login', () => {
  const signedIn = { loggedIn: true, authMethod: 'claude.ai', email: 'me@example.com', orgName: null, subscriptionType: 'pro', configDirectory: '/home/x/.claude' };

  it('signed in: identity and plan, a Re-log in button, and no flow panel for an idle flow', async () => {
    mockFetch({ 'GET /api/claude-auth/status': () => signedIn, 'GET /api/claude-auth/login': () => ({ state: 'idle' }) });
    wrap(<ClaudeLogin />);
    await screen.findByText('Signed in');
    expect(screen.getByText(/me@example.com · Pro plan · Claude subscription/)).toBeTruthy();
    expect(screen.queryByText(/null/)).toBeNull();
    expect(screen.getByTestId('ca-login').textContent).toMatch('Re-log in');
    expect(screen.queryByTestId('ca-flow')).toBeNull();
  });

  it('a status failure shows the error, never "Not signed in"', async () => {
    mockFetch({ 'GET /api/claude-auth/status': () => ({ status: 502, json: { error: 'cli broke' } }), 'GET /api/claude-auth/login': () => ({ state: 'idle' }) });
    wrap(<ClaudeLogin />);
    await screen.findByText('Could not read the Claude login state: cli broke');
    expect(screen.queryByText('Not signed in')).toBeNull();
  });

  it('Log in shows the URL and code field; Submit posts the trimmed code; success fires onLoginSuccess once', async () => {
    let state: any = { state: 'idle' };
    const calls = mockFetch({
      'GET /api/claude-auth/status': () => ({ loggedIn: false }),
      'GET /api/claude-auth/login': () => state,
      'POST /api/claude-auth/login': () => (state = { state: 'awaiting_code', url: 'https://claude.ai/oauth?x' }),
      'POST /api/claude-auth/login/code': () => (state = { state: 'verifying', url: 'https://claude.ai/oauth?x' }),
    });
    const onLoginSuccess = vi.fn();
    wrap(<ClaudeLogin onLoginSuccess={onLoginSuccess} pollMs={10} />);
    await screen.findByText('Not signed in');
    fireEvent.click(screen.getByTestId('ca-login'));
    const link = await screen.findByTestId('ca-url');
    expect(link.getAttribute('href')).toBe('https://claude.ai/oauth?x');
    expect(link.getAttribute('target')).toBe('_blank');
    fireEvent.change(screen.getByLabelText('Sign-in code'), { target: { value: '  abc123 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/login/code'))?.body).toEqual({ code: 'abc123' }));
    await waitFor(() => expect((screen.getByLabelText('Sign-in code') as HTMLInputElement).disabled).toBe(true));
    state = { state: 'succeeded' };
    await screen.findByText('Signed in.');
    await new Promise((r) => setTimeout(r, 50));
    expect(onLoginSuccess).toHaveBeenCalledTimes(1);
  });

  it('a flow already ended before the panel opened stays hidden and does not fire onLoginSuccess', async () => {
    mockFetch({ 'GET /api/claude-auth/status': () => signedIn, 'GET /api/claude-auth/login': () => ({ state: 'succeeded' }) });
    const onLoginSuccess = vi.fn();
    wrap(<ClaudeLogin onLoginSuccess={onLoginSuccess} />);
    await screen.findByText('Signed in');
    expect(screen.queryByTestId('ca-flow')).toBeNull();
    expect(onLoginSuccess).not.toHaveBeenCalled();
  });
});

describe('Backends', () => {
  it('built-in rows offer no edit or remove; a row lists the custom models bound to it', () => {
    mockFetch({});
    modelsSettingsStore.set({ data: models() as any });
    wrap(<BackendsSection />);
    expect(screen.queryByRole('button', { name: 'Edit Claude' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Ollama' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit Mine' })).toBeTruthy();
    expect(screen.getByText('models: m1')).toBeTruthy();
  });

  it('the add form posts id / label / template with parsed env, then resets; the payload refreshes the catalog', async () => {
    const calls = mockFetch({ 'POST /api/settings/models/backends': () => models() });
    modelsSettingsStore.set({ data: models() as any });
    wrap(<BackendsSection />);
    fireEvent.change(screen.getByLabelText('Id'), { target: { value: ' px ' } });
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Proxy' } });
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'px {model}' } });
    fireEvent.change(screen.getByLabelText('Env (optional)'), { target: { value: 'K=v\nZ=1=2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add backend' }));
    await waitFor(() => expect(applyModels).toHaveBeenCalled());
    expect(calls[0].body).toEqual({ id: 'px', label: 'Proxy', template: 'px {model}', env: [{ key: 'K', value: 'v' }, { key: 'Z', value: '1=2' }] });
    expect((screen.getByLabelText('Id') as HTMLInputElement).value).toBe('');
  });

  it('editing a user row PATCHes label / template / env together', async () => {
    const calls = mockFetch({ 'PATCH /api/settings/models/backends/mine': () => models() });
    modelsSettingsStore.set({ data: models() as any });
    wrap(<BackendsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mine' }));
    expect((screen.getByLabelText('Id') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Mine 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls[0]?.body).toEqual({ label: 'Mine 2', template: 'mine run {model}', env: [{ key: 'A', value: '1' }] }));
  });

  it('a 409 on Remove shows the server message naming the bound models', async () => {
    mockFetch({ 'DELETE /api/settings/models/backends/mine': () => ({ status: 409, json: { error: 'still used by m1' } }) });
    modelsSettingsStore.set({ data: models() as any });
    wrap(<BackendsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Mine' }));
    await screen.findByText('Remove failed: still used by m1');
  });
});

describe('Systems', () => {
  const list = { systems: [{ id: 'local', label: 'This machine', managed: true, projects: [] }, { id: 'box', label: 'Box', launch: null, projects: [{ name: 'p', remoteId: 'ctr' }] }] };

  it('the built-in row is read-only; a row without a command says it is a name only and lists its projects', async () => {
    mockFetch({ 'GET /api/settings/systems': () => list });
    wrap(<SystemsSection />);
    await screen.findByText('Box');
    expect(screen.queryByRole('button', { name: 'Edit This machine' })).toBeNull();
    expect(screen.getByText(/This system is a name only/)).toBeTruthy();
    expect(screen.getByText('projects: p (ctr)')).toBeTruthy();
  });

  it('adds with the provider command as argv; an empty command is sent as null', async () => {
    const calls = mockFetch({ 'GET /api/settings/systems': () => list, 'POST /api/settings/systems': () => list });
    wrap(<SystemsSection />);
    await screen.findByText('Box');
    fireEvent.change(screen.getByLabelText('Id'), { target: { value: 'b2' } });
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'B2' } });
    fireEvent.change(screen.getByLabelText('Provider command'), { target: { value: 'docker exec -i c p' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add system' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ id: 'b2', label: 'B2', launch: ['docker', 'exec', '-i', 'c', 'p'], worktreesDir: null }));
    fireEvent.change(screen.getByLabelText('Id'), { target: { value: 'b3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add system' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')[1]?.body.launch).toBeNull());
  });

  it('an unreachable system shows the provider\'s error and keeps the typed values', async () => {
    mockFetch({ 'GET /api/settings/systems': () => list, 'POST /api/settings/systems': () => ({ status: 502, json: { error: 'provider did not answer hello' } }) });
    wrap(<SystemsSection />);
    await screen.findByText('Box');
    fireEvent.change(screen.getByLabelText('Id'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add system' }));
    await screen.findByText('Save failed: provider did not answer hello');
    expect((screen.getByLabelText('Id') as HTMLInputElement).value).toBe('x');
  });
});

describe('Models', () => {
  it('a tier whose level is missing shows the server default; a role\'s Inherit names the level it resolves to', () => {
    mockFetch({ 'GET /api/settings/spawn': () => ({ debugByDefault: false }) });
    modelsSettingsStore.set({ data: models() as any });
    wrap(<ModelsSection />);
    expect((screen.getByLabelText('Default effort for the Fast tier') as HTMLSelectElement).value).toBe('low');
    expect((screen.getByLabelText('Default effort for the Powerful tier') as HTMLSelectElement).value).toBe('medium');
    expect(screen.getByRole('option', { name: 'Inherit (high)' })).toBeTruthy();
  });

  it('changing a tier\'s effort posts tierEffort; the last enabled tier cannot be switched off', async () => {
    const calls = mockFetch({ 'GET /api/settings/spawn': () => ({}), 'POST /api/settings/models/prefs': () => models() });
    modelsSettingsStore.set({ data: models({ enabledTiers: { fast: false, powerful: true } }) as any });
    wrap(<ModelsSection />);
    expect(screen.getByRole('switch', { name: 'Enable the Powerful tier' })).toHaveProperty('disabled', true);
    expect((screen.getByLabelText('Default effort for the Fast tier') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Default effort for the Powerful tier'), { target: { value: 'max' } });
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ tierEffort: { tier: 'powerful', effort: 'max' } }));
  });

  it('switching a tier to a backend with no model refuses and names the backend', () => {
    mockFetch({ 'GET /api/settings/spawn': () => ({}) });
    modelsSettingsStore.set({ data: models() as any });
    wrap(<ModelsSection />);
    fireEvent.change(screen.getByLabelText('Backend for the Fast tier'), { target: { value: 'ollama' } });
    expect(screen.getByText('Add a Ollama model under Custom models first.')).toBeTruthy();
  });

  it('editing a custom model locks backend and id and PATCHes its pair URL; Cancel returns to add mode', async () => {
    const calls = mockFetch({ 'GET /api/settings/spawn': () => ({}), 'PATCH /api/settings/models/custom/mine/m1': () => models() });
    modelsSettingsStore.set({ data: models() as any });
    wrap(<ModelsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mine 1' }));
    expect((screen.getByLabelText('Model id') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Backend') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Context'), { target: { value: '1m' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ label: 'Mine 1', contextWindow: 1000000, midTurnSteering: true }));
    await screen.findByText('Saved.');
    expect((screen.getByLabelText('Model id') as HTMLInputElement).disabled).toBe(false);
  });

  it('a custom model needs a parseable context', () => {
    mockFetch({ 'GET /api/settings/spawn': () => ({}) });
    modelsSettingsStore.set({ data: models() as any });
    wrap(<ModelsSection />);
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('Context'), { target: { value: 'big' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
    expect(screen.getByText(/Context is required/)).toBeTruthy();
  });

  it('loadModelsSettings reports a failed load', async () => {
    mockFetch({ 'GET /api/settings/models': () => ({ status: 500, json: { error: 'down' } }) });
    await loadModelsSettings();
    expect(modelsSettingsStore.get().error).toBe('Failed to load models: down');
  });

  it('EffortPicker falls back to the server default for an unknown level', () => {
    wrap(<EffortPicker data={models() as any} value="nonsense" enabled label="e" onPick={() => {}} />);
    expect((screen.getByLabelText('e') as HTMLSelectElement).value).toBe('medium');
  });
});

describe('Archived', () => {
  const groups = { groups: [{ project: 'p', sessions: [{ sessionId: 's1', title: 'T1', lastActivity: Date.now() }] }, { project: '.conduct', sessions: [{ sessionId: 's2' }] }] };

  it('Restore restores, then resumes the session; conductor sessions are listed first', async () => {
    mockFetch({ 'GET /api/archived': () => groups, 'POST /api/projects/p/sessions/s1/restore': () => ({ ok: true }) });
    wrap(<ArchivedSection />);
    await screen.findByText('2 archived sessions across 2 projects.');
    const triggers = screen.getAllByRole('button', { expanded: false });
    expect(triggers[0].textContent).toMatch('Conductor');
    fireEvent.click(screen.getByRole('button', { name: /^p/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(resumeSession).toHaveBeenCalledWith({ projectName: 'p', worktreeName: undefined, sessionId: 's1' }));
  });

  it('a failed restore does not resume', async () => {
    vi.mocked(resumeSession).mockClear();
    mockFetch({ 'GET /api/archived': () => groups, 'POST /api/projects/p/sessions/s1/restore': () => ({ status: 500, json: { error: 'nope' } }) });
    wrap(<ArchivedSection />);
    await screen.findByText(/archived sessions/);
    fireEvent.click(screen.getByRole('button', { name: /^p/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it('an accepted Restore and an accepted Delete each mark every place\'s session list stale, exactly once', async () => {
    vi.mocked(resumeSession).mockClear();
    mockFetch({
      'GET /api/archived': () => groups,
      'POST /api/projects/p/sessions/s1/restore': () => ({ ok: true }),
      'DELETE /api/projects/p/sessions/s1': () => ({ ok: true }),
    });
    const stale: unknown[] = [];
    const off = on('sessionsStale', (p) => stale.push(p));
    try {
      wrap(<><ArchivedSection /><ConfirmHost /></>);
      await screen.findByText(/archived sessions/);
      fireEvent.click(screen.getByRole('button', { name: /^p/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
      await waitFor(() => expect(resumeSession).toHaveBeenCalled());
      expect(stale).toEqual([null]);

      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Delete permanently' }));
      await waitFor(() => expect(stale).toHaveLength(2));
      await new Promise((r) => setTimeout(r, 30));
      expect(stale).toEqual([null, null]);
    } finally {
      off();
    }
  });
});

describe('Plugins', () => {
  const lib = { entries: [] };
  const row = (over: object) => ({ id: 'pl', name: 'Pl', project: 'pl', state: 'stopped', enabled: true, hasBackend: true, ...over });

  it('a plugin whose backend is local-only on a system hides Start and says so', async () => {
    mockFetch({
      'GET /api/plugins': () => ({ rows: [row({ system: 'box', localOnly: ['PLUGIN_BACKEND_LOCAL_ONLY'] })] }),
      'GET /api/projects': () => [], 'GET /api/plugins/library': () => lib,
    });
    wrap(<PluginsSection />);
    await screen.findByText('Pl');
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    expect(screen.getByText("on system 'box': PLUGIN_BACKEND_LOCAL_ONLY")).toBeTruthy();
  });

  it('Restart reports {action, ids}; Stop reports no change', async () => {
    const before = pluginsChangedSignal.version();
    mockFetch({
      'GET /api/plugins': () => ({ rows: [row({ state: 'ready', stale: true })] }),
      'GET /api/projects': () => [], 'GET /api/plugins/library': () => lib,
      'POST /api/plugins/pl/restart': () => ({ ok: true }), 'POST /api/plugins/pl/stop': () => ({ ok: true }),
    });
    wrap(<PluginsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(pluginsChangeStore.get().lastChange).toEqual({ action: 'restart', ids: ['pl'] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(pluginsChangedSignal.version()).toBe(before + 2));
    expect(pluginsChangeStore.get().lastChange).toBeUndefined();
  });

  it('library: Update all is disabled with nothing to update and counts updatable entries otherwise', async () => {
    mockFetch({
      'GET /api/plugins': () => ({ rows: [] }), 'GET /api/projects': () => [],
      'GET /api/plugins/library': () => ({ entries: [
        { id: 'a', name: 'A', repo: 'r', installed: true, installedAs: 'a', updateAvailable: true },
        { id: 'b', name: 'B', repo: 'r', installed: false },
      ] }),
    });
    wrap(<PluginsSection />);
    expect(await screen.findByRole('button', { name: 'Update all (1)' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy();
  });

  it('a corrupt-registry notice is surfaced in the status line', async () => {
    mockFetch({
      'GET /api/plugins': () => ({ rows: [], notices: [{ file: 'plugins.json', reason: 'bad json', backup: 'plugins.json.bak' }] }),
      'GET /api/projects': () => [], 'GET /api/plugins/library': () => lib,
    });
    wrap(<PluginsSection />);
    await screen.findByText(/plugins.json was unreadable \(bad json\) — moved aside to plugins.json.bak/);
  });
});
