import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { mockFetch, type Call } from './test/fetchMock';
import { routeFetch, held, type RouteAnswer } from '@/test/routeFetch';

vi.mock('@/app/sessionActions', () => ({ resumeSession: vi.fn(async () => {}) }));
vi.mock('@/app/controller', () => ({ refreshProjects: vi.fn(async () => {}), refreshInstances: vi.fn(async () => {}) }));
vi.mock('@/app/models', () => ({ applyModels: vi.fn() }));
vi.mock('@/features/sidebar/restart', () => ({ performRestart: vi.fn(async () => {}) }));
vi.mock('@/lib/core/capabilities.js', () => ({ loadCapabilities: vi.fn(), capabilities: vi.fn(() => null) }));

import { loadCapabilities } from '@/lib/core/capabilities.js';
import { syncRoute, useRoute } from '@/state/route';
import { ConfirmHost } from '@/ui/feedback';
import { ConventionsSection, conventionsBlocksStore, conventionsDraftStore, pluginsSeen, type ConventionsPayload } from './ConventionsSection';
import { notifyPluginsChanged, pluginsChangedSignal } from './pluginsSignal';
import { SettingsView } from './SettingsView';

const WS: ConventionsPayload = {
  core: { name: 'Workspace core', description: 'always applies' },
  conventions: [
    { slug: 'git', name: 'Git hygiene', description: 'commits', builtin: true },
    { slug: 'mine', name: 'Mine', description: 'my rule', body: '## Mine' },
    { slug: 'demo/rule', name: 'Demo rule', description: 'from demo', plugin: 'demo' },
  ],
  enabled: ['git', 'demo/rule'],
};
// None of these enforcement levels ships, so a client-side list cannot pass.
const CD: ConventionsPayload = {
  core: { name: 'Conductor core', description: 'role' },
  conventions: [
    { slug: 'lean', name: 'Lean', description: 'l', builtin: true },
    { slug: 'cmine', name: 'C mine', description: 'c', body: 'cb' },
  ],
  enabled: ['lean'],
  playbooks: [{ id: 'solo', name: 'Solo' }, { id: 'relay', name: 'Relay' }],
  playbookErrors: [],
  defaultPlaybook: { mode: 'playbook', id: 'relay' },
  defaultPlaybookFallback: 'freeform',
  playbookEnforcementModes: ['lenient', 'strict', 'paranoid'],
  defaultPlaybookEnforcement: 'strict',
};
// Carries a core and a selection, so "Project shows neither" is not vacuous.
const PJ: ConventionsPayload = {
  core: { name: 'Project core', description: 'p' },
  conventions: [
    { slug: 'tdd', name: 'TDD', description: 't', builtin: true },
    { slug: 'pmine', name: 'P mine', description: 'p', body: 'pb' },
  ],
  enabled: ['tdd'],
};
const R = "preferred playbook 'acme/release' is not loaded — it is contributed by plugin 'acme'.";
const MISSING: ConventionsPayload = {
  ...CD,
  defaultPlaybook: { mode: 'playbook', id: 'acme/release' },
  defaultPlaybookMissing: { id: 'acme/release', reason: R },
  playbookErrors: [{ id: 'mine', message: 'bad' }],
};
const MARKER = { slug: 'reloaded', name: 'Reloaded', description: 'r', builtin: true };

type Scope = 'workspace' | 'conductor' | 'project';
type Title = 'Workspace conventions' | 'Conductor conventions' | 'Project conventions';

let ws: ConventionsPayload;
let cd: ConventionsPayload;
let pj: ConventionsPayload;
let calls: Call[];
const DRAFT0 = conventionsDraftStore.get();
const BLOCKS0 = conventionsBlocksStore.get();
const SEEN0 = { ...pluginsSeen };

/** Routes the three conventions GETs and Archived, plus a test's writes. */
function serve(writes: Parameters<typeof mockFetch>[0] = {}) {
  calls = mockFetch({
    'GET /api/settings/conventions/workspace': () => ws,
    'GET /api/settings/conventions/conductor': () => cd,
    'GET /api/settings/conventions/project': () => pj,
    'GET /api/archived': () => ({ groups: [] }),
    ...writes,
  });
}

const gets = (scope: Scope) => calls.filter((c) => c.method === 'GET' && c.url === `/api/settings/conventions/${scope}`).length;
const writes = () => calls.filter((c) => c.method !== 'GET');

function Host() {
  const route = useRoute();
  return route.view === 'settings' ? <SettingsView /> : <div data-testid="elsewhere" />;
}

function openAt(hash: string) {
  history.replaceState(null, '', `/${hash}`);
  syncRoute();
  return render(<TooltipProvider><Host /><ConfirmHost /></TooltipProvider>);
}

/** A refused Delete in `title`'s block, confirmed, waited for on its list status line. */
async function refuseDelete(title: Title, name: string, slug: string) {
  fireEvent.click(within(block(title)).getByRole('button', { name: `Delete ${name}` }));
  const dialog = await screen.findByRole('dialog', { name: `Delete ${scopeOf(title)} convention “${slug}”?` });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(listStatus(title)).toBe('Delete failed: still in use'));
}

const renderSection = () => render(<TooltipProvider><ConventionsSection /><ConfirmHost /></TooltipProvider>);

const heading = (name: string) => screen.findByRole('heading', { level: 2, name });
const SECTION_HEADING = { conventions: 'Conventions', archived: 'Archived', plugins: 'Plugins' } as const;
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

const scopeOf = (title: Title) => title.split(' ')[0].toLowerCase() as Scope;
const trigger = (title: Title) => screen.getByRole('button', { name: title });
const block = (title: Title) => trigger(title).closest('[data-slot="collapsible"]') as HTMLElement;
const expanded = () => (['Workspace conventions', 'Conductor conventions', 'Project conventions'] as const).map((t) => trigger(t).getAttribute('aria-expanded'));

/** Opens a block if it is closed, then waits for its list to load. */
async function expand(title: Title) {
  if (trigger(title).getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger(title));
  return screen.findByTestId(`conventions-${scopeOf(title)}`);
}

const field = (blockEl: HTMLElement, label: string) => within(blockEl).getByLabelText(label) as HTMLInputElement;
const type = (blockEl: HTMLElement, label: string, value: string) => fireEvent.change(field(blockEl, label), { target: { value } });
const statusText = (el: HTMLElement) => within(el).queryAllByRole('status').map((s) => s.textContent).join('');
/** A block's list status line; only meaningful while the block has no form open. */
const listStatus = (title: Title) => statusText(block(title));
const pickerStatus = (label: 'Preferred playbook' | 'Playbook enforcement') => statusText(screen.getByText(label, { selector: 'label' }).parentElement as HTMLElement);
const select = (id: 'dp-select' | 'dpe-select') => document.getElementById(id) as HTMLSelectElement;
const pick = (id: 'dp-select' | 'dpe-select', value: string) => fireEvent.change(select(id), { target: { value } });
const optionValues = (id: 'dp-select' | 'dpe-select') => [...select(id).options].map((o) => o.value);

/** A plugin change reloads every mounted panel; resolves once the Conductor reload has landed. */
async function reloadConductor() {
  cd = { ...cd, conventions: [...(cd.conventions ?? []), MARKER] };
  const before = gets('conductor');
  act(() => notifyPluginsChanged(undefined));
  await waitFor(() => expect(gets('conductor')).toBe(before + 1));
  await waitFor(() => expect(screen.getByTestId('conventions-conductor').querySelector('[data-slug="reloaded"]')).not.toBeNull());
}

beforeEach(() => {
  ws = WS;
  cd = CD;
  pj = PJ;
  conventionsDraftStore.set(DRAFT0);
  conventionsBlocksStore.set(BLOCKS0);
  for (const k of Object.keys(pluginsSeen) as Scope[]) delete pluginsSeen[k];
  Object.assign(pluginsSeen, SEEN0);
  vi.mocked(loadCapabilities).mockReset().mockResolvedValue({ remoteSystems: false, voice: false });
  serve();
});
afterEach(() => vi.unstubAllGlobals());

describe('Conventions → blocks', () => {
  // Each scope's list renders the core row with an always-on badge, built-ins and plugin rows read-only with their badge, and Edit/Delete only on customs.
  it('each block lists its core row as always on, built-ins read-only, plugin conventions badged with their plugin, and custom conventions with Edit and Delete', async () => {
    renderSection();
    const list = await screen.findByTestId('conventions-workspace');
    const core = list.querySelector('li') as HTMLElement;
    expect(core.textContent).toContain('Workspace core');
    expect(core.textContent).toContain('always on');
    const git = list.querySelector('[data-slug="git"]') as HTMLElement;
    expect(git.textContent).toContain('built-in');
    expect(within(git).queryAllByRole('button')).toHaveLength(0);
    const demo = list.querySelector('[data-slug="demo/rule"]') as HTMLElement;
    expect(demo.textContent).toContain('plugin: demo');
    expect(demo.textContent).not.toContain('built-in');
    expect(within(demo).queryAllByRole('button')).toHaveLength(0);
    const mine = list.querySelector('[data-slug="mine"]') as HTMLElement;
    expect(within(mine).getByRole('button', { name: 'Edit Mine' })).toBeTruthy();
    expect(within(mine).getByRole('button', { name: 'Delete Mine' })).toBeTruthy();
    expect(mine.textContent).not.toMatch(/built-in|plugin:/);

    const cdList = await expand('Conductor conventions');
    const cdCore = cdList.querySelector('li') as HTMLElement;
    expect(cdCore.textContent).toContain('Conductor core');
    expect(cdCore.textContent).toContain('always on');
    const lean = cdList.querySelector('[data-slug="lean"]') as HTMLElement;
    expect(lean.textContent).toContain('built-in');
    expect(within(lean).queryAllByRole('button')).toHaveLength(0);
    expect(within(cdList).getByRole('button', { name: 'Edit C mine' })).toBeTruthy();
  });

  // Workspace and Conductor give every convention a switch mirroring the selection and a flip PUTs the whole new selection; Project shows no core row and no switches even when its payload carries both.
  it('the Workspace and Conductor scopes give each convention a switch showing the selection, a flip PUTs the whole selection, and Project has neither a core row nor switches', async () => {
    serve({ 'PUT /api/settings/conventions/workspace/selection': () => ({}) });
    renderSection();
    const list = await screen.findByTestId('conventions-workspace');
    expect(within(list).getAllByRole('switch').map((s) => [s.getAttribute('aria-label'), s.getAttribute('aria-checked')])).toEqual([
      ['Enable Git hygiene', 'true'],
      ['Enable Mine', 'false'],
      ['Enable Demo rule', 'true'],
    ]);
    fireEvent.click(within(list).getByRole('switch', { name: 'Enable Mine' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()).toEqual([{ method: 'PUT', url: '/api/settings/conventions/workspace/selection', body: { enabled: ['git', 'demo/rule', 'mine'] } }]);

    const cdList = await expand('Conductor conventions');
    expect(within(cdList).getAllByRole('switch')).toHaveLength(2);

    const pjList = await expand('Project conventions');
    expect(pjList.textContent).not.toContain('Project core');
    expect(within(pjList).queryAllByRole('switch')).toHaveLength(0);
    expect(within(pjList.querySelector('[data-slug="pmine"]') as HTMLElement).getByRole('button', { name: 'Edit P mine' })).toBeTruthy();
  });

  // Add opens an empty, unlocked form; Save POSTs slug/name/description trimmed and the body untouched, then closes the form and reloads the list once.
  it('Add custom convention opens an empty form; Save POSTs the trimmed fields with the body as typed, closes the form and reloads the list', async () => {
    serve({ 'POST /api/settings/conventions/workspace': () => ({}) });
    renderSection();
    await screen.findByTestId('conventions-workspace');
    const b = block('Workspace conventions');
    fireEvent.click(within(b).getByRole('button', { name: 'Add custom convention' }));
    expect(['Slug', 'Name', 'Description', 'Body (Markdown)'].map((l) => field(b, l).value)).toEqual(['', '', '', '']);
    expect(field(b, 'Slug').disabled).toBe(false);
    type(b, 'Slug', '  new  ');
    type(b, 'Name', ' New ');
    type(b, 'Description', ' D ');
    type(b, 'Body (Markdown)', '  raw\n');
    const loads = gets('workspace');
    fireEvent.click(within(b).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()).toEqual([{ method: 'POST', url: '/api/settings/conventions/workspace', body: { slug: 'new', name: 'New', description: 'D', body: '  raw\n' } }]);
    await waitFor(() => expect(within(b).queryByLabelText('Slug')).toBeNull());
    expect(within(b).getByRole('button', { name: 'Add custom convention' })).toBeTruthy();
    await waitFor(() => expect(gets('workspace')).toBe(loads + 1));
  });

  // Edit fills the form from the row with the slug locked and PUTs name/description/body to that slug; a refused save keeps the form showing the server's error, and a later good save closes it.
  it("Edit locks the slug and PUTs the name, description and body to that convention; a refused save keeps the form with the server's message", async () => {
    let n = 0;
    serve({ 'PUT /api/settings/conventions/workspace/mine': () => (++n === 1 ? { status: 409, json: { error: 'name already used' } } : {}) });
    renderSection();
    await screen.findByTestId('conventions-workspace');
    const b = block('Workspace conventions');
    fireEvent.click(within(b).getByRole('button', { name: 'Edit Mine' }));
    expect(field(b, 'Slug').value).toBe('mine');
    expect(field(b, 'Slug').disabled).toBe(true);
    expect(field(b, 'Name').value).toBe('Mine');
    expect(field(b, 'Body (Markdown)').value).toBe('## Mine');
    const form = within(b).getByRole('form', { name: 'Edit workspace convention' });
    type(b, 'Name', 'Mine 2');
    fireEvent.click(within(b).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(statusText(form)).toBe('name already used'));
    expect(within(b).getByRole('form', { name: 'Edit workspace convention' })).toBe(form);
    fireEvent.click(within(b).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(b).queryByRole('form')).toBeNull());
    const body = { name: 'Mine 2', description: 'my rule', body: '## Mine' };
    expect(writes()).toEqual([
      { method: 'PUT', url: '/api/settings/conventions/workspace/mine', body },
      { method: 'PUT', url: '/api/settings/conventions/workspace/mine', body },
    ]);
  });

  // Delete confirms first: Cancel sends nothing, Delete sends exactly one DELETE for that slug and then reloads the list.
  it('Delete asks first: declining sends nothing, confirming DELETEs that convention and reloads the list', async () => {
    serve({ 'DELETE /api/settings/conventions/workspace/mine': () => ({}) });
    renderSection();
    await screen.findByTestId('conventions-workspace');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Mine' }));
    let dialog = await screen.findByRole('dialog', { name: 'Delete workspace convention “mine”?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes()).toEqual([]);
    const loads = gets('workspace');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Mine' }));
    dialog = await screen.findByRole('dialog', { name: 'Delete workspace convention “mine”?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].method).toBe('DELETE');
    expect(writes()[0].url).toBe('/api/settings/conventions/workspace/mine');
    await waitFor(() => expect(gets('workspace')).toBe(loads + 1));
  });
});

describe('Conventions → conductor pickers', () => {
  // The enforcement options are the payload's modes in payload order, labelled from ENFORCEMENT_LABELS where known and by bare id otherwise, with the stored mode selected.
  it("the enforcement picker lists the payload's levels in order, labelling the known ones and naming the rest by id, with the stored level selected", async () => {
    cd = { ...CD, playbookEnforcementModes: ['lenient', 'warn', 'paranoid'], defaultPlaybookEnforcement: 'paranoid' };
    renderSection();
    await expand('Conductor conventions');
    expect([...select('dpe-select').options].map((o) => [o.value, o.textContent])).toEqual([
      ['lenient', 'lenient'],
      ['warn', 'Warn — off-graph calls are ledgered and proceed'],
      ['paranoid', 'paranoid'],
    ]);
    expect(select('dpe-select').value).toBe('paranoid');
  });

  // A reload re-renders both pickers from the new payload without accumulating options.
  it('a reload repaints both pickers without duplicating an option', async () => {
    renderSection();
    await expand('Conductor conventions');
    await reloadConductor();
    expect(optionValues('dpe-select')).toEqual(['lenient', 'strict', 'paranoid']);
    expect(optionValues('dp-select')).toEqual(['unset', 'none', 'playbook:solo', 'playbook:relay']);
  });

  // An enforcement pick PUTs {mode} to the enforcement endpoint only; a refusal shows "Save failed: <server error>" and the next accepted pick blanks it.
  it('picking a level PUTs it to the enforcement endpoint; a refused save says so and the next good pick clears it', async () => {
    const url = '/api/settings/conventions/conductor/default-playbook-enforcement';
    serve({ [`PUT ${url}`]: (c: Call) => (c.body.mode === 'paranoid' ? { status: 400, json: { error: 'mode must be one of warn | enforce' } } : {}) });
    renderSection();
    await expand('Conductor conventions');
    pick('dpe-select', 'lenient');
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()).toEqual([{ method: 'PUT', url, body: { mode: 'lenient' } }]);
    expect(pickerStatus('Playbook enforcement')).toBe('');
    pick('dpe-select', 'paranoid');
    await waitFor(() => expect(pickerStatus('Playbook enforcement')).toBe('Save failed: mode must be one of warn | enforce'));
    pick('dpe-select', 'lenient');
    await waitFor(() => expect(writes()).toHaveLength(3));
    await waitFor(() => expect(pickerStatus('Playbook enforcement')).toBe(''));
    expect(writes().map((w) => w.url)).toEqual([url, url, url]);
  });

  // Each playbook row PUTs its own tagged {defaultPlaybook} (playbook+id, none and unset distinct) to the playbook endpoint; a refusal shows "Save failed: <server error>".
  it('each playbook row PUTs its own tagged selection, and a refused save says so', async () => {
    let refuse = false;
    const url = '/api/settings/conventions/conductor/default-playbook';
    serve({ [`PUT ${url}`]: () => (refuse ? { status: 400, json: { error: 'unknown playbook id' } } : {}) });
    renderSection();
    await expand('Conductor conventions');
    pick('dp-select', 'playbook:solo');
    await waitFor(() => expect(writes()).toHaveLength(1));
    pick('dp-select', 'none');
    await waitFor(() => expect(writes()).toHaveLength(2));
    pick('dp-select', 'unset');
    await waitFor(() => expect(writes()).toHaveLength(3));
    expect(writes()).toEqual([
      { method: 'PUT', url, body: { defaultPlaybook: { mode: 'playbook', id: 'solo' } } },
      { method: 'PUT', url, body: { defaultPlaybook: { mode: 'none' } } },
      { method: 'PUT', url, body: { defaultPlaybook: { mode: 'unset' } } },
    ]);
    refuse = true;
    pick('dp-select', 'playbook:relay');
    await waitFor(() => expect(pickerStatus('Preferred playbook')).toBe('Save failed: unknown playbook id'));
  });

  // A stored playbook absent from the payload renders as the selected, disabled "<id> — not loaded" option, and the status line leads with its reason before the load errors.
  it('a stored playbook that is not loaded is the selected, disabled row, and its reason leads the status line', async () => {
    cd = MISSING;
    renderSection();
    await expand('Conductor conventions');
    expect(select('dp-select').value).toBe('playbook:acme/release');
    const opt = select('dp-select').querySelector('option[value="playbook:acme/release"]') as HTMLOptionElement;
    expect(opt.textContent).toBe('acme/release — not loaded');
    expect(opt.disabled).toBe(true);
    expect(pickerStatus('Preferred playbook').startsWith(R)).toBe(true);
    expect(pickerStatus('Preferred playbook')).toContain('mine: bad');
  });

  // One conductor GET feeds both pickers and the list; no picker fetches on its own.
  it('one conductor load fills both pickers and the conventions list', async () => {
    renderSection();
    const list = await expand('Conductor conventions');
    expect(gets('conductor')).toBe(1);
    expect(calls.filter((c) => c.url.startsWith('/api/settings/conventions/conductor/'))).toEqual([]);
    expect(select('dpe-select').value).toBe('strict');
    expect(select('dp-select').value).toBe('playbook:relay');
    expect(select('dp-select').options).toHaveLength(4);
    expect(list.querySelector('[data-slug="lean"]')).not.toBeNull();
    expect(list.querySelector('[data-slug="cmine"]')).not.toBeNull();
  });

  // An accepted playbook pick blanks the playbook status line (no stale payload notes), and the next load re-selects the stored playbook and repaints the notes.
  it('a successful playbook pick blanks the status line, and the next load repaints it from the payload', async () => {
    cd = MISSING;
    serve({ 'PUT /api/settings/conventions/conductor/default-playbook': () => ({}) });
    renderSection();
    await expand('Conductor conventions');
    const notes = `${R} 1 playbook definition(s) rejected at load: mine: bad`;
    expect(pickerStatus('Preferred playbook')).toBe(notes);
    pick('dp-select', 'playbook:solo');
    await waitFor(() => expect(writes()).toHaveLength(1));
    await waitFor(() => expect(pickerStatus('Preferred playbook')).toBe(''));
    await reloadConductor();
    expect(pickerStatus('Preferred playbook')).toBe(notes);
    expect(select('dp-select').value).toBe('playbook:acme/release');
  });

  // A load after refused picks re-selects both stored values even though they did not change; the playbook line repaints from the payload while the enforcement error survives the load.
  it("a load after refused picks re-selects the stored playbook and level; the playbook line repaints from the payload and the level's error stays", async () => {
    cd = { ...CD, playbookErrors: [{ id: 'mine', message: 'bad' }] };
    serve({
      'PUT /api/settings/conventions/conductor/default-playbook-enforcement': () => ({ status: 400, json: { error: 'mode must be one of warn | enforce' } }),
      'PUT /api/settings/conventions/conductor/default-playbook': () => ({ status: 400, json: { error: 'unknown playbook id' } }),
    });
    renderSection();
    await expand('Conductor conventions');
    pick('dpe-select', 'lenient');
    pick('dp-select', 'playbook:solo');
    await waitFor(() => expect(pickerStatus('Playbook enforcement')).toBe('Save failed: mode must be one of warn | enforce'));
    await waitFor(() => expect(pickerStatus('Preferred playbook')).toBe('Save failed: unknown playbook id'));
    expect(select('dpe-select').value).toBe('lenient');
    expect(select('dp-select').value).toBe('playbook:solo');
    await reloadConductor();
    expect(select('dpe-select').value).toBe('strict');
    expect(pickerStatus('Playbook enforcement')).toBe('Save failed: mode must be one of warn | enforce');
    expect(select('dp-select').value).toBe('playbook:relay');
    expect(pickerStatus('Preferred playbook')).toBe('1 playbook definition(s) rejected at load: mine: bad');
  });
});

describe('Conventions → plugin changes', () => {
  // A plugin action still in flight when Conventions mounts reloads all three panels once it finishes, so a plugin-contributed convention appears without reopening Settings.
  it("a plugin action that finishes after the switch to Conventions reloads every open block, and the Conductor block then lists the plugin's convention", async () => {
    let enabled = false;
    const enable = held<RouteAnswer>();
    const DEMO = { id: 'demo', name: 'Demo', project: 'demoproj', state: 'stopped', enabled: false, hasBackend: false };
    const rc = routeFetch({
      'GET /api/plugins/library': () => ({ json: { entries: [] } }),
      'GET /api/plugins': () => ({ json: { rows: [{ ...DEMO, enabled }] } }),
      'GET /api/projects': () => ({ json: [] }),
      'POST /api/plugins/demo/enable': () => enable.answer,
      'GET /api/settings/conventions/workspace': () => ({ json: WS }),
      'GET /api/settings/conventions/conductor': () => ({ json: { ...CD, conventions: [...(CD.conventions ?? []), ...(enabled ? [{ slug: 'demo/rule', name: 'Demo rule', description: 'd', plugin: 'demo' }] : [])] } }),
      'GET /api/settings/conventions/project': () => ({ json: PJ }),
    });
    const loads = (scope: Scope) => rc.filter((c) => c.method === 'GET' && c.url === `/api/settings/conventions/${scope}`).length;
    openAt('#settings/plugins');
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(rc.some((c) => c.method === 'POST' && c.url === '/api/plugins/demo/enable')).toBe(true));
    await switchTo('conventions');
    await screen.findByTestId('conventions-workspace');
    const cdList = await expand('Conductor conventions');
    await expand('Project conventions');
    expect([loads('workspace'), loads('conductor'), loads('project')]).toEqual([1, 1, 1]);
    expect(cdList.querySelector('[data-slug="lean"]')).not.toBeNull();
    expect(cdList.querySelector('[data-slug="demo/rule"]')).toBeNull();
    enabled = true;
    await act(async () => enable.release({ json: {} }));
    await waitFor(() => expect([loads('workspace'), loads('conductor'), loads('project')]).toEqual([2, 2, 2]));
    await waitFor(() => expect(screen.getByTestId('conventions-conductor').querySelector('[data-slug="demo/rule"]')?.textContent).toContain('plugin: demo'));
  });
});

describe('Conventions → drafts', () => {
  // A typed Add form, held per block, survives the panel unmounting on collapse, a section remount and a Settings remount, and Save POSTs exactly the typed fields.
  it('a Conductor add form survives collapsing its block, a section switch and leaving Settings, and Save POSTs the typed fields', async () => {
    serve({ 'POST /api/settings/conventions/conductor': () => ({}) });
    openAt('#settings/conventions');
    await expand('Conductor conventions');
    fireEvent.click(within(block('Conductor conventions')).getByRole('button', { name: 'Add custom convention' }));
    const b = () => block('Conductor conventions');
    type(b(), 'Slug', 'draft');
    type(b(), 'Name', 'Draft');
    type(b(), 'Description', 'D');
    type(b(), 'Body (Markdown)', 'B');
    const expectDraft = () => expect(['Slug', 'Name', 'Description', 'Body (Markdown)'].map((l) => field(b(), l).value)).toEqual(['draft', 'Draft', 'D', 'B']);

    fireEvent.click(trigger('Conductor conventions'));
    expect(trigger('Conductor conventions').getAttribute('aria-expanded')).toBe('false');
    expect(within(b()).queryByLabelText('Slug')).toBeNull();
    await expand('Conductor conventions');
    expectDraft();

    await switchTo('archived');
    await switchTo('conventions');
    await expand('Conductor conventions');
    expectDraft();

    await leaveAndReenter('conventions');
    await expand('Conductor conventions');
    expectDraft();

    fireEvent.click(within(b()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()).toEqual([{ method: 'POST', url: '/api/settings/conventions/conductor', body: { slug: 'draft', name: 'Draft', description: 'D', body: 'B' } }]);
  });

  // An Edit keeps its locked slug and typed name across a section remount; Cancel and a successful Save each end only their own block's form, durably.
  it('an edit keeps its locked slug across a section switch; Cancel and a successful Save each clear only their own block', async () => {
    serve({ 'POST /api/settings/conventions/conductor': () => ({}) });
    openAt('#settings/conventions');
    await screen.findByRole('button', { name: 'Edit Mine' });
    const wsB = () => block('Workspace conventions');
    const cdB = () => block('Conductor conventions');
    fireEvent.click(within(wsB()).getByRole('button', { name: 'Edit Mine' }));
    type(wsB(), 'Name', 'Typed');
    await expand('Conductor conventions');
    fireEvent.click(within(cdB()).getByRole('button', { name: 'Add custom convention' }));
    type(cdB(), 'Slug', 'keep');
    const away = async () => {
      await switchTo('archived');
      await switchTo('conventions');
      await expand('Workspace conventions');
      await expand('Conductor conventions');
    };

    await away();
    expect(field(wsB(), 'Slug').value).toBe('mine');
    expect(field(wsB(), 'Slug').disabled).toBe(true);
    expect(field(wsB(), 'Name').value).toBe('Typed');
    expect(within(wsB()).getByRole('form', { name: 'Edit workspace convention' })).toBeTruthy();
    expect(field(cdB(), 'Slug').value).toBe('keep');

    fireEvent.click(within(wsB()).getByRole('button', { name: 'Cancel' }));
    await away();
    expect(within(wsB()).queryByLabelText('Slug')).toBeNull();
    expect(within(wsB()).getByRole('button', { name: 'Add custom convention' })).toBeTruthy();
    expect(field(cdB(), 'Slug').value).toBe('keep');

    type(cdB(), 'Name', 'K');
    fireEvent.click(within(cdB()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(cdB()).queryByLabelText('Slug')).toBeNull());
    await away();
    expect(within(cdB()).queryByLabelText('Slug')).toBeNull();
    expect(within(cdB()).getByRole('button', { name: 'Add custom convention' })).toBeTruthy();
    expect(writes()).toEqual([{ method: 'POST', url: '/api/settings/conventions/conductor', body: { slug: 'keep', name: 'K', description: '', body: '' } }]);
  });

  // A refused save keeps both the typed fields and the server's message in the form across a section remount.
  it("a refused save keeps the typed form and the server's message across a section switch", async () => {
    serve({ 'POST /api/settings/conventions/workspace': () => ({ status: 409, json: { error: "convention 'dup' already exists" } }) });
    openAt('#settings/conventions');
    await screen.findByTestId('conventions-workspace');
    const b = () => block('Workspace conventions');
    fireEvent.click(within(b()).getByRole('button', { name: 'Add custom convention' }));
    type(b(), 'Slug', 'dup');
    type(b(), 'Name', 'Dup');
    fireEvent.click(within(b()).getByRole('button', { name: 'Save' }));
    const formStatus = () => statusText(within(b()).getByRole('form', { name: 'Add workspace convention' }));
    await waitFor(() => expect(formStatus()).toBe("convention 'dup' already exists"));
    await switchTo('archived');
    await switchTo('conventions');
    await expand('Workspace conventions');
    expect(field(b(), 'Slug').value).toBe('dup');
    expect(field(b(), 'Name').value).toBe('Dup');
    expect(formStatus()).toBe("convention 'dup' already exists");
  });

  // A refused Delete's message stays on the list status line through remount loads (collapse, section switch); an action-driven load (a plugin change) or reopening Settings clears it.
  it("a refused Delete's message survives collapsing its block and a section switch; a plugin change or reopening Settings replaces it", async () => {
    serve({ 'DELETE /api/settings/conventions/workspace/mine': () => ({ status: 409, json: { error: 'still in use' } }) });
    openAt('#settings/conventions');
    await screen.findByRole('button', { name: 'Delete Mine' });
    const refuse = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete Mine' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete workspace convention “mine”?' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(listStatus('Workspace conventions')).toBe('Delete failed: still in use'));
    };
    await refuse();

    let g = gets('workspace');
    fireEvent.click(trigger('Workspace conventions'));
    expect(trigger('Workspace conventions').getAttribute('aria-expanded')).toBe('false');
    await expand('Workspace conventions');
    expect(gets('workspace')).toBe(g + 1);
    expect(listStatus('Workspace conventions')).toBe('Delete failed: still in use');

    g = gets('workspace');
    await switchTo('archived');
    await switchTo('conventions');
    await waitFor(() => expect(gets('workspace')).toBe(g + 1));
    await screen.findByTestId('conventions-workspace');
    expect(listStatus('Workspace conventions')).toBe('Delete failed: still in use');

    g = gets('workspace');
    act(() => notifyPluginsChanged(undefined));
    await waitFor(() => expect(gets('workspace')).toBe(g + 1));
    await waitFor(() => expect(listStatus('Workspace conventions')).toBe(''));

    await refuse();
    g = gets('workspace');
    await leaveAndReenter('conventions');
    await waitFor(() => expect(gets('workspace')).toBe(g + 1));
    await screen.findByTestId('conventions-workspace');
    await waitFor(() => expect(listStatus('Workspace conventions')).toBe(''));
    expect(writes().filter((w) => w.method === 'DELETE')).toHaveLength(2);
  });

  // Each block's open/closed state starts Workspace open, Conductor and Project closed, and then keeps what the user set across a section remount and a Settings remount.
  it("each block's open or closed state survives a section switch and leaving Settings", async () => {
    openAt('#settings/conventions');
    await screen.findByTestId('conventions-workspace');
    expect(expanded()).toEqual(['true', 'false', 'false']);
    fireEvent.click(trigger('Workspace conventions'));
    await expand('Project conventions');
    expect(expanded()).toEqual(['false', 'false', 'true']);
    await switchTo('archived');
    await switchTo('conventions');
    expect(expanded()).toEqual(['false', 'false', 'true']);
    await leaveAndReenter('conventions');
    expect(expanded()).toEqual(['false', 'false', 'true']);
  });

  // A plugin change clears every block's list refusal even when it lands while Conventions is unmounted (another section shown).
  it("every block's refused Delete clears after a plugin change made while another section was shown", async () => {
    let enabled = false;
    const refused = () => ({ status: 409, json: { error: 'still in use' } });
    serve({
      'DELETE /api/settings/conventions/workspace/mine': refused,
      'DELETE /api/settings/conventions/conductor/cmine': refused,
      'GET /api/plugins': () => ({ rows: [{ id: 'demo', name: 'Demo', project: 'demoproj', state: 'stopped', enabled, hasBackend: false }] }),
      'GET /api/plugins/library': () => ({ entries: [] }),
      'GET /api/projects': () => [],
      'POST /api/plugins/demo/enable': () => { enabled = true; return {}; },
    });
    openAt('#settings/conventions');
    await screen.findByRole('button', { name: 'Delete Mine' });
    await refuseDelete('Workspace conventions', 'Mine', 'mine');
    await expand('Conductor conventions');
    await refuseDelete('Conductor conventions', 'C mine', 'cmine');

    await switchTo('plugins');
    const v = pluginsChangedSignal.version();
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(pluginsChangedSignal.version()).toBe(v + 1));
    expect(screen.queryByTestId('conventions-workspace')).toBeNull();

    const g = [gets('workspace'), gets('conductor')];
    await switchTo('conventions');
    await waitFor(() => expect([gets('workspace'), gets('conductor')]).toEqual([g[0] + 1, g[1] + 1]));
    await screen.findByTestId('conventions-workspace');
    await screen.findByTestId('conventions-conductor');
    await waitFor(() => expect([listStatus('Workspace conventions'), listStatus('Conductor conventions')]).toEqual(['', '']));
    expect(writes().map((w) => `${w.method} ${w.url}`)).toEqual([
      'DELETE /api/settings/conventions/workspace/mine',
      'DELETE /api/settings/conventions/conductor/cmine',
      'POST /api/plugins/demo/enable',
    ]);
  });

  // A plugin change clears a block's list refusal even when it lands while that block is collapsed (its panel unmounted).
  it("a refused Delete's message clears after a plugin change made while its block was collapsed", async () => {
    serve({ 'DELETE /api/settings/conventions/workspace/mine': () => ({ status: 409, json: { error: 'still in use' } }) });
    openAt('#settings/conventions');
    await screen.findByRole('button', { name: 'Delete Mine' });
    await refuseDelete('Workspace conventions', 'Mine', 'mine');
    fireEvent.click(trigger('Workspace conventions'));
    expect(screen.queryByTestId('conventions-workspace')).toBeNull();
    const g = gets('workspace');
    act(() => notifyPluginsChanged(undefined));
    expect(gets('workspace')).toBe(g);
    await expand('Workspace conventions');
    expect(gets('workspace')).toBe(g + 1);
    await waitFor(() => expect(listStatus('Workspace conventions')).toBe(''));
  });

  // Under StrictMode's doubled mount effects a remount (collapse, section switch) still keeps a list refusal, and a plugin change still clears it.
  it("under StrictMode a refused Delete's message survives a collapse and a section switch, and a plugin change clears it", async () => {
    serve({ 'DELETE /api/settings/conventions/workspace/mine': () => ({ status: 409, json: { error: 'still in use' } }) });
    history.replaceState(null, '', '/#settings/conventions');
    syncRoute();
    render(<StrictMode><TooltipProvider><Host /><ConfirmHost /></TooltipProvider></StrictMode>);
    await screen.findByRole('button', { name: 'Delete Mine' });
    await refuseDelete('Workspace conventions', 'Mine', 'mine');

    let g = gets('workspace');
    fireEvent.click(trigger('Workspace conventions'));
    await expand('Workspace conventions');
    expect(gets('workspace')).toBeGreaterThan(g);
    expect(listStatus('Workspace conventions')).toBe('Delete failed: still in use');

    g = gets('workspace');
    await switchTo('archived');
    await switchTo('conventions');
    await waitFor(() => expect(gets('workspace')).toBeGreaterThan(g));
    await screen.findByTestId('conventions-workspace');
    expect(listStatus('Workspace conventions')).toBe('Delete failed: still in use');

    g = gets('workspace');
    act(() => notifyPluginsChanged(undefined));
    await waitFor(() => expect(gets('workspace')).toBeGreaterThan(g));
    await waitFor(() => expect(listStatus('Workspace conventions')).toBe(''));
  });

  // Only a delete, a successful save, a failed toggle, a plugin change, reopening Settings or a page reload replaces a list refusal: a successful switch flip and a refused save leave it on the list's own status line, with no reload.
  it("a successful switch flip and a refused save leave a refused Delete's message on the list status line", async () => {
    serve({
      'DELETE /api/settings/conventions/workspace/mine': () => ({ status: 409, json: { error: 'still in use' } }),
      'PUT /api/settings/conventions/workspace/selection': () => ({}),
      'POST /api/settings/conventions/workspace': () => ({ status: 409, json: { error: "convention 'dup' already exists" } }),
    });
    openAt('#settings/conventions');
    await screen.findByRole('button', { name: 'Delete Mine' });
    await refuseDelete('Workspace conventions', 'Mine', 'mine');
    // The list's own status line is a direct child of the panel; the form's sits inside the form.
    const listLine = () => [...(screen.getByTestId('conventions-workspace').parentElement as HTMLElement).children]
      .filter((el) => el.getAttribute('role') === 'status').map((el) => el.textContent).join('');
    const loads = gets('workspace');

    fireEvent.click(screen.getByRole('switch', { name: 'Enable Mine' }));
    await waitFor(() => expect(writes().map((w) => w.method)).toEqual(['DELETE', 'PUT']));

    const b = block('Workspace conventions');
    fireEvent.click(within(b).getByRole('button', { name: 'Add custom convention' }));
    type(b, 'Slug', 'dup');
    fireEvent.click(within(b).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(statusText(within(b).getByRole('form', { name: 'Add workspace convention' }))).toBe("convention 'dup' already exists"));

    expect(listLine()).toBe('Delete failed: still in use');
    expect(gets('workspace')).toBe(loads);
    expect(writes().map((w) => w.method)).toEqual(['DELETE', 'PUT', 'POST']);
  });
});
