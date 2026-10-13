import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { mockFetch, type Call } from '../test/fetchMock';

vi.mock('@/app/sessionActions', () => ({ resumeSession: vi.fn(async () => {}) }));
vi.mock('@/app/controller', () => ({ refreshProjects: vi.fn(async () => {}), refreshInstances: vi.fn(async () => {}) }));
vi.mock('@/app/models', () => ({ applyModels: vi.fn() }));
vi.mock('@/features/sidebar/restart', () => ({ performRestart: vi.fn(async () => {}) }));

import { applyModels } from '@/app/models';
import { modelsSettingsStore } from './store';
import { ModelsSection, modelsDraftStore } from './ModelsSection';
import { backendsDraftStore } from '../BackendsSection';
import { systemsDraftStore } from '../SystemsSection';
import type { ModelsPayload } from './logic';

type Custom = NonNullable<ModelsPayload['customModels']>[number];

const PICK: ModelsPayload = {
  backends: [
    { id: 'claude', label: 'Claude', template: '', env: [], managed: true },
    { id: 'ollama', label: 'Ollama', template: 'ollama launch claude --model {model} --yes --', env: [], managed: true },
    { id: 'px', label: 'My Proxy', template: 'px {model}', env: [] },
  ],
  claudeFamilies: [
    { family: 'sonnet', label: 'Sonnet', default: 'claude-sonnet-5-5', versions: [{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }] },
    { family: 'haiku', label: 'Haiku', default: 'claude-haiku-4-5', versions: [{ id: 'claude-haiku-4-5', label: 'Haiku 4.5' }] },
  ],
  tiers: [{ tier: 'fast', label: 'Fast' }, { tier: 'powerful', label: 'Powerful' }, { tier: 'frontier', label: 'Frontier' }],
  tierBackend: {
    fast: { backend: 'claude', model: 'claude-haiku-4-5' },
    powerful: { backend: 'px', model: 'mine:v1' },
    frontier: { backend: 'ollama', model: 'gemma4:cloud' },
  },
  tierEffort: {},
  customModels: [
    { label: 'Local', model: 'gemma4:cloud', backend: 'ollama', contextWindow: 128000 },
    { label: 'Mine', model: 'mine:v1', backend: 'px', contextWindow: 300000 },
    { label: 'Mine two', model: 'mine:v2', backend: 'px', contextWindow: 300000 },
  ],
  ollamaCloudModels: [{ label: 'GLM 5.2', model: 'glm-5.2:cloud' }],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultEffort: 'medium',
  enabledTiers: { fast: true, powerful: true, frontier: true },
  defaultSpawnTier: 'powerful',
  roles: [{ role: 'conductor', label: 'Conductor', builtin: true }],
  roleBackend: { conductor: { kind: 'tier', tier: 'powerful', model: '' } },
  roleEffort: { conductor: { effort: 'inherit', inheritsTo: 'medium' } },
  conductorCompactWindow: { enabled: false, value: 300 },
};

const DRAFTS = [modelsDraftStore.get(), backendsDraftStore.get(), systemsDraftStore.get()] as const;

beforeEach(() => {
  modelsSettingsStore.set({ data: null, error: null, status: null });
  modelsDraftStore.set(DRAFTS[0]);
  backendsDraftStore.set(DRAFTS[1]);
  systemsDraftStore.set(DRAFTS[2]);
  vi.mocked(applyModels).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

function show(data: ModelsPayload) {
  modelsSettingsStore.set({ data });
  return render(<TooltipProvider><ModelsSection /></TooltipProvider>);
}

const select = (label: string, selector = '*') => screen.getByLabelText(label, { selector }) as HTMLSelectElement;
const optionTexts = (s: HTMLSelectElement) => [...s.querySelectorAll('option')].map((o) => o.textContent);
const optionValues = (s: HTMLSelectElement) => [...s.querySelectorAll('option')].map((o) => o.value);
const groupLabels = (s: HTMLSelectElement) => [...s.querySelectorAll('optgroup')].map((g) => g.label);
const nonGets = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');
const prefsBodies = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && c.url === '/api/settings/models/prefs').map((c) => c.body);

describe('Models → backend picker', () => {
  // The backend select is built from the payload's registry, in order, so a user backend is offered beside the built-ins; a substitution row's model select lists only its own backend's models.
  it('the backend select lists every registry row in order, a user-added one included', () => {
    mockFetch({ 'GET /api/settings/spawn': () => ({}) });
    show(PICK);
    expect(optionValues(select('Backend for the Fast tier'))).toEqual(['claude', 'ollama', 'px']);
    expect(optionTexts(select('Backend for the Fast tier'))).toEqual(['Claude', 'Ollama', 'My Proxy']);
    expect(groupLabels(select('Model for the Powerful tier'))).toEqual(['My Models']);
    expect(optionTexts(select('Model for the Powerful tier'))).toEqual(['Mine — mine:v1', 'Mine two — mine:v2']);
  });

  // A switch to a user backend saves that backend with its own first model: not another backend's model listed earlier, not its last.
  it('switching a tier to a user backend saves it with that backend\'s first model', async () => {
    const calls = mockFetch({ 'GET /api/settings/spawn': () => ({}), 'POST /api/settings/models/prefs': () => PICK });
    show(PICK);
    fireEvent.change(select('Backend for the Fast tier'), { target: { value: 'px' } });
    await waitFor(() => expect(nonGets(calls)).toHaveLength(1));
    expect(nonGets(calls)[0]).toMatchObject({ method: 'POST', url: '/api/settings/models/prefs', body: { tierBackend: { tier: 'fast', backend: { backend: 'px', model: 'mine:v1' } } } });
  });

  // A model pick saves the picked model on the row's current backend.
  it('picking a model keeps the row on its current backend', async () => {
    const calls = mockFetch({ 'GET /api/settings/spawn': () => ({}), 'POST /api/settings/models/prefs': () => PICK });
    show(PICK);
    fireEvent.change(select('Model for the Powerful tier'), { target: { value: 'mine:v2' } });
    await waitFor(() => expect(prefsBodies(calls)).toHaveLength(1));
    expect(prefsBodies(calls)[0]).toEqual({ tierBackend: { tier: 'powerful', backend: { backend: 'px', model: 'mine:v2' } } });
  });

  // Claude rows list every Claude version ungrouped; the curated cloud group appears on the ollama row only, before that backend's own models.
  it('a Claude row lists every Claude version with no groups; only the ollama row adds the curated group beside its own models', () => {
    mockFetch({ 'GET /api/settings/spawn': () => ({}) });
    show(PICK);
    expect(groupLabels(select('Model for the Fast tier'))).toEqual([]);
    expect(optionTexts(select('Model for the Fast tier'))).toEqual(['Sonnet 5.5', 'Haiku 4.5']);
    expect(groupLabels(select('Model for the Frontier tier'))).toEqual(['Ollama Cloud', 'My Models']);
    expect(optionTexts(select('Model for the Frontier tier'))).toEqual(['GLM 5.2 — glm-5.2:cloud', 'Local — gemma4:cloud']);
    expect(groupLabels(select('Model for the Powerful tier'))).not.toContain('Ollama Cloud');
  });

  // A substitution backend with no bindable model gets one disabled placeholder; a backend with models stays enabled.
  it('a backend with no bindable model shows one disabled placeholder', () => {
    mockFetch({ 'GET /api/settings/spawn': () => ({}) });
    show({ ...PICK, customModels: PICK.customModels!.filter((c) => c.label === 'Local') });
    expect(select('Model for the Powerful tier').disabled).toBe(true);
    expect(optionTexts(select('Model for the Powerful tier'))).toEqual(['(add a model under Custom models)']);
    expect(select('Model for the Frontier tier').disabled).toBe(false);
  });

  // The custom-model form's backend list is every substitution backend and never Claude; a row's meta line names its model, its backend's label and its window.
  it('the custom-model form offers every substitution backend and never Claude; each row shows its model, backend and window', () => {
    mockFetch({ 'GET /api/settings/spawn': () => ({}) });
    show(PICK);
    expect(optionValues(document.getElementById('cm-backend') as HTMLSelectElement)).toEqual(['ollama', 'px']);
    const rows = [...screen.getByTestId('custom-list').querySelectorAll('li')];
    // Invariant: each row names its model id, its backend's label and its context window.
    for (const part of ['mine:v1', 'My Proxy', '300k']) expect(rows[1].textContent).toContain(part);
    for (const part of ['gemma4:cloud', 'Ollama', '128k']) expect(rows[0].textContent).toContain(part);
  });

  // Remove addresses the clicked row's own backend and model, even when another row shares its label and model id.
  it('Remove on a custom model addresses that row\'s backend and model', async () => {
    const twins: Custom[] = [
      { label: 'Mine', model: 'mine:v1', backend: 'ollama', contextWindow: 300000 },
      { label: 'Mine', model: 'mine:v1', backend: 'px', contextWindow: 300000 },
    ];
    const calls = mockFetch({ 'GET /api/settings/spawn': () => ({}), 'DELETE /api/settings/models/custom/px/mine%3Av1': () => ({ ...PICK, customModels: [twins[0]] }) });
    show({ ...PICK, customModels: twins });
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove Mine' })[1]);
    await waitFor(() => expect(nonGets(calls)).toHaveLength(1));
    expect(nonGets(calls).map((c) => `${c.method} ${c.url}`)).toEqual(['DELETE /api/settings/models/custom/px/mine%3Av1']);
  });
});

describe('Models → editing a custom model', () => {
  const MINE: Custom = { label: 'Mine', model: 'mine:v1', backend: 'ollama', contextWindow: 131072, midTurnSteering: false };
  const SIB: Custom = { label: 'Sibling', model: 'sib:v3', backend: 'ollama', contextWindow: 64000, midTurnSteering: true };
  const OTHER: Custom = { label: 'Other', model: 'other:v2', backend: 'px', contextWindow: 300000, midTurnSteering: true };
  const SAME_ID: Custom = { label: 'Same id', model: 'mine:v1', backend: 'px', contextWindow: 64000, midTurnSteering: true };

  const payload = (customModels: Custom[], seq = 0): ModelsPayload => ({ ...PICK, customModels, seq });
  const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
  const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const steer = () => document.getElementById('cm-steer') as HTMLElement;
  const status = () => {
    const card = screen.getByText('Custom models', { selector: '[data-slot="card-title"]' }).closest('[data-slot="card"]') as HTMLElement;
    return within(card).queryAllByRole('status').map((s) => s.textContent).join('');
  };
  const form = () => ({
    label: input('Label').value,
    backend: select('Backend', '#cm-backend').value,
    backendDisabled: select('Backend', '#cm-backend').disabled,
    model: input('Model id').value,
    modelDisabled: input('Model id').disabled,
    context: input('Context').value,
    steer: steer().getAttribute('aria-checked'),
    save: screen.queryByRole('button', { name: 'Save' }) !== null,
    cancel: screen.queryByRole('button', { name: 'Cancel' }) !== null,
    status: status(),
  });

  let prefsAnswer: ModelsPayload;
  let seq = 0;
  /** A save elsewhere on the page (a tier effort pick) whose answer carries `customModels`; resolves once it is shown. */
  async function saveElsewhere(customModels: Custom[]) {
    seq++;
    prefsAnswer = payload(customModels, seq);
    fireEvent.change(select('Default effort for the Fast tier'), { target: { value: 'max' } });
    await waitFor(() => expect(modelsSettingsStore.get().data?.seq).toBe(seq));
    await act(async () => {});
  }
  function routes(extra: Record<string, (c: Call) => unknown> = {}) {
    return mockFetch({ 'GET /api/settings/spawn': () => ({}), 'POST /api/settings/models/prefs': () => prefsAnswer, ...extra });
  }

  // Edit on a second row overwrites every field the first edit typed or loaded (label, context, steer, backend, model id, status) with that row's values, and Save targets that row's pair.
  it('Edit on another row replaces every field the first Edit left, and Save PATCHes that row with its own values', async () => {
    const calls = routes({ 'PATCH /api/settings/models/custom/px/other%3Av2': () => payload([MINE, OTHER]) });
    show(payload([MINE, OTHER]));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mine' }));
    type('Label', 'scribble');
    type('Context', '1');
    expect(steer().getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Other' }));
    expect(form()).toEqual({
      label: 'Other', backend: 'px', backendDisabled: true, model: 'other:v2', modelDisabled: true, context: '300000', steer: 'true',
      save: true, cancel: true, status: 'Editing Other. Backend and model id are fixed.',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(nonGets(calls)).toHaveLength(1));
    expect(nonGets(calls)[0]).toMatchObject({ method: 'PATCH', url: '/api/settings/models/custom/px/other%3Av2', body: { label: 'Other', contextWindow: 300000, midTurnSteering: true } });
  });

  // Cancel resets label, model id, context, steer (to on) and the status, unlocks backend and model id, and the next submit is an add (POST), not a PATCH of the cancelled pair.
  it('Cancel clears every field and the status, unlocks backend and model id, and the next submit POSTs an add', async () => {
    const calls = routes({ 'POST /api/settings/models/custom': () => payload([MINE, OTHER]) });
    show(payload([MINE, OTHER]));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(form()).toEqual({
      label: '', backend: 'ollama', backendDisabled: false, model: '', modelDisabled: false, context: '', steer: 'true', save: false, cancel: false, status: '',
    });
    expect(screen.getByRole('button', { name: 'Add model' })).toBeTruthy();
    type('Label', 'New');
    fireEvent.change(select('Backend', '#cm-backend'), { target: { value: 'px' } });
    type('Model id', 'new:v1');
    type('Context', '1m');
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
    await waitFor(() => expect(nonGets(calls)).toHaveLength(1));
    expect(nonGets(calls)[0]).toMatchObject({ method: 'POST', url: '/api/settings/models/custom', body: { label: 'New', model: 'new:v1', backend: 'px', contextWindow: 1000000, midTurnSteering: true } });
  });

  // A refused PATCH keeps edit mode, the typed and loaded values and the lock, and shows the server's message.
  it('a failed PATCH stays in edit mode with the typed values and shows the server\'s message', async () => {
    routes({ 'PATCH /api/settings/models/custom/ollama/mine%3Av1': () => ({ status: 400, json: { error: 'contextWindow is required' } }) });
    show(payload([MINE, OTHER]));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mine' }));
    type('Label', 'Mine 2');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(status()).toContain('contextWindow is required'));
    expect(form()).toEqual({
      label: 'Mine 2', backend: 'ollama', backendDisabled: true, model: 'mine:v1', modelDisabled: true, context: '131072', steer: 'false',
      save: true, cancel: true, status: 'Save failed: contextWindow is required',
    });
  });

  // A fresh payload that still holds the edited pair leaves the edit (typed label, lock) alone; removing the edited row itself ends edit mode.
  it('a save elsewhere while editing keeps the form locked on the edited pair; removing the edited row ends edit mode', async () => {
    routes({ 'DELETE /api/settings/models/custom/ollama/mine%3Av1': () => payload([OTHER]) });
    show(payload([MINE, OTHER]));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mine' }));
    type('Label', 'dirty');
    await saveElsewhere([MINE, OTHER]);
    expect(input('Label').value).toBe('dirty');
    expect(select('Backend', '#cm-backend').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Mine' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove Mine' })).toBeNull());
    expect(input('Label').value).toBe('');
    expect(input('Model id').disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(status()).toBe('');
  });

  // Removing a different row (same backend) leaves the edit open on its pair, and Save still PATCHes that pair with the typed label and its loaded values.
  it('removing a different row while editing keeps the form on the edited pair, and Save still PATCHes it', async () => {
    const calls = routes({
      'DELETE /api/settings/models/custom/ollama/sib%3Av3': () => payload([MINE]),
      'PATCH /api/settings/models/custom/ollama/mine%3Av1': () => payload([MINE]),
    });
    show(payload([MINE, SIB]));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mine' }));
    type('Label', 'Mine edited');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sibling' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove Sibling' })).toBeNull());
    await act(async () => {});
    expect(input('Label').value).toBe('Mine edited');
    expect(select('Backend', '#cm-backend').disabled).toBe(true);
    expect(input('Model id').disabled).toBe(true);
    expect(status()).toContain('Mine');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(nonGets(calls)).toHaveLength(2));
    expect(nonGets(calls)[1]).toMatchObject({ method: 'PATCH', url: '/api/settings/models/custom/ollama/mine%3Av1', body: { label: 'Mine edited', contextWindow: 131072, midTurnSteering: false } });
  });

  // A payload missing the edited pair ends edit mode by itself; the only write is the unrelated save, never a Remove.
  it('a save elsewhere whose answer lacks the edited pair ends edit mode without a Remove', async () => {
    const calls = routes();
    show(payload([MINE, OTHER]));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mine' }));
    type('Label', 'dirty');
    await saveElsewhere([OTHER]);
    expect(input('Label').value).toBe('');
    expect(input('Model id').disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(nonGets(calls).map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/settings/models/prefs']);
  });

  // The edited pair is matched on backend AND model: removing the same model id on another backend leaves the edit open.
  it('removing a row with the edited model id on another backend keeps the form open', async () => {
    const calls = routes({ 'DELETE /api/settings/models/custom/px/mine%3Av1': () => payload([MINE]) });
    show(payload([MINE, SAME_ID]));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mine' }));
    type('Label', 'Mine edited');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Same id' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove Same id' })).toBeNull());
    await act(async () => {});
    expect(nonGets(calls).map((c) => `${c.method} ${c.url}`)).toEqual(['DELETE /api/settings/models/custom/px/mine%3Av1']);
    expect(input('Label').value).toBe('Mine edited');
    expect(select('Backend', '#cm-backend').value).toBe('ollama');
    expect(select('Backend', '#cm-backend').disabled).toBe(true);
    expect(input('Model id').value).toBe('mine:v1');
    expect(input('Model id').disabled).toBe(true);
  });

  // Edit mode survives only a payload holding the exact (backend, model) pair; a same-backend row plus a same-model row is not a match.
  it('edit mode survives a payload holding the exact edited pair, but not a same-backend or same-model look-alike', async () => {
    routes();
    show(payload([MINE, OTHER]));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mine' }));
    type('Label', 'dirty');
    await saveElsewhere([MINE, SIB]);
    expect(input('Label').value).toBe('dirty');
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeNull();
    await saveElsewhere([SIB, SAME_ID]);
    expect(input('Label').value).toBe('');
    expect(input('Model id').disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});

describe('Models → role effort', () => {
  // A role's stored level is selected, its Inherit option names the role's own inheritsTo over the payload default, and each pick POSTs roleEffort with the picked level.
  it('a role with an explicit level shows it, its Inherit names the level it falls back to, and each pick POSTs roleEffort', async () => {
    const data: ModelsPayload = { ...PICK, roleEffort: { conductor: { effort: 'xhigh', inheritsTo: 'low' } } };
    const calls = mockFetch({ 'GET /api/settings/spawn': () => ({}), 'POST /api/settings/models/prefs': () => data });
    show(data);
    const role = select('Default effort for the Conductor role');
    expect(role.value).toBe('xhigh');
    expect(role.options[0].textContent).toBe('Inherit (low)');
    fireEvent.change(role, { target: { value: 'inherit' } });
    fireEvent.change(role, { target: { value: 'max' } });
    await waitFor(() => expect(prefsBodies(calls)).toHaveLength(2));
    expect(prefsBodies(calls)).toEqual([{ roleEffort: { role: 'conductor', effort: 'inherit' } }, { roleEffort: { role: 'conductor', effort: 'max' } }]);
  });

  // A tier with no stored level and a role Inherit with no inheritsTo both show the payload's defaultEffort, and fall to high only when it is absent; a stored tier level wins over both.
  it('every effort fallback uses the payload\'s defaultEffort, Inherit label included, and high only when the payload names none', () => {
    mockFetch({ 'GET /api/settings/spawn': () => ({}) });
    const A: ModelsPayload = { ...PICK, defaultEffort: 'medium', tierEffort: { powerful: 'max' }, roleEffort: { conductor: { effort: 'inherit' } } };
    show(A);
    expect(select('Default effort for the Fast tier').value).toBe('medium');
    expect(select('Default effort for the Powerful tier').value).toBe('max');
    expect(select('Default effort for the Conductor role').options[0].textContent).toBe('Inherit (medium)');
    act(() => modelsSettingsStore.set({ data: { ...A, defaultEffort: undefined } }));
    expect(select('Default effort for the Fast tier').value).toBe('high');
    expect(select('Default effort for the Powerful tier').value).toBe('max');
    expect(select('Default effort for the Conductor role').options[0].textContent).toBe('Inherit (high)');
  });
});

describe('Models → Conductor session', () => {
  const sw = () => screen.getByRole('switch', { name: 'Override the compact window for the Conduct session' });
  const slider = () => screen.queryByLabelText('Window') as HTMLInputElement | null;
  const withWindow = (cw: { enabled: boolean; value: number }): ModelsPayload => ({ ...PICK, conductorCompactWindow: cw });

  // Off shows no slider; switching on POSTs the stored window (not the 200 default) without refreshing the model catalog, and the slider then shows that window with its bounds.
  it('the compact-window override starts off with no slider; switching it on saves the stored window and shows the slider at it', async () => {
    const answer = withWindow({ enabled: true, value: 300 });
    const calls = mockFetch({ 'GET /api/settings/spawn': () => ({}), 'POST /api/settings/models/prefs': () => answer });
    show(withWindow({ enabled: false, value: 300 }));
    expect(sw().getAttribute('aria-checked')).toBe('false');
    expect(slider()).toBeNull();
    fireEvent.click(sw());
    await waitFor(() => expect(slider()).not.toBeNull());
    expect(prefsBodies(calls)).toEqual([{ conductorCompactWindow: { enabled: true, value: 300 } }]);
    const s = slider()!;
    expect(s.value).toBe('300');
    expect([s.min, s.max, s.step]).toEqual(['100', '1000', '10']);
    expect(screen.getByText('300k')).toBeTruthy();
    expect(applyModels).not.toHaveBeenCalled();
    expect(modelsSettingsStore.get().data).toEqual(answer);
  });

  // Dragging only moves the readout; a pointer release or key-up commits the slider's value; switching off sends the last window with enabled false and hides the slider.
  it('moving the slider updates the readout without saving; releasing or a key-up saves that window; switching off keeps it and hides the slider', async () => {
    const calls = mockFetch({
      'GET /api/settings/spawn': () => ({}),
      'POST /api/settings/models/prefs': (c) => withWindow(c.body.conductorCompactWindow),
    });
    show(withWindow({ enabled: true, value: 300 }));
    const shownWindow = () => modelsSettingsStore.get().data?.conductorCompactWindow;
    fireEvent.change(slider()!, { target: { value: '450' } });
    expect(screen.getByText('450k')).toBeTruthy();
    expect(prefsBodies(calls)).toHaveLength(0);
    fireEvent.pointerUp(slider()!);
    await waitFor(() => expect(shownWindow()).toEqual({ enabled: true, value: 450 }));
    expect(prefsBodies(calls)).toEqual([{ conductorCompactWindow: { enabled: true, value: 450 } }]);
    fireEvent.change(slider()!, { target: { value: '460' } });
    fireEvent.keyUp(slider()!);
    await waitFor(() => expect(shownWindow()).toEqual({ enabled: true, value: 460 }));
    expect(prefsBodies(calls)[1]).toEqual({ conductorCompactWindow: { enabled: true, value: 460 } });
    fireEvent.click(sw());
    await waitFor(() => expect(slider()).toBeNull());
    expect(prefsBodies(calls)).toHaveLength(3);
    expect(prefsBodies(calls)[2]).toEqual({ conductorCompactWindow: { enabled: false, value: 460 } });
  });

  // A refused compact-window save surfaces as the section's error status and the switch stays as stored.
  it('a failed compact-window save says so', async () => {
    mockFetch({ 'GET /api/settings/spawn': () => ({}), 'POST /api/settings/models/prefs': () => ({ status: 500, json: { error: 'disk' } }) });
    show(withWindow({ enabled: false, value: 300 }));
    fireEvent.click(sw());
    expect(await screen.findByText('Update failed: disk')).toBeTruthy();
    expect(sw().getAttribute('aria-checked')).toBe('false');
  });
});
