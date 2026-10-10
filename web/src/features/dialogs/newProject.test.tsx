// The New-project dialog end to end: its request bodies, preview, refusals,
// confirm pane and conventions, and its wiring to the shared placement
// (placement.test.tsx owns the placement's own display logic) and to the path picker.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/app/controller', () => ({
  refreshProjects: vi.fn(async () => {}),
  refreshInstances: vi.fn(async () => {}),
  selectInstance: vi.fn(),
  send: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  performProjectDelete: vi.fn(async () => {}),
  applySessionTitle: vi.fn(async () => 't'),
}));
vi.mock('@/lib/core/capabilities.js', () => ({
  loadCapabilities: vi.fn(async () => ({ remoteSystems: true, voice: true, fuseUnion: true })),
  capabilities: vi.fn(() => null),
}));

import { DialogsHost } from './DialogsHost';
import { closeDialog, dialogStore, openNewProjectDialog } from './api';
import { loadCapabilities } from '@/lib/core/capabilities.js';
import { routeFetch, type Route, type RoutedCall } from '@/test/routeFetch';
import { SYSTEMS, chooseSystem, chooseTarget, findTargetSelect, findTargetText, listed, listedAnswer, pathNote, system, typePath } from '@/test/placementDriver';

const CREATED = { name: 'demo', path: '/x', system: 'local' };
const created = (extra: Record<string, unknown> = {}) => ({ status: 201, json: { ...CREATED, ...extra } });
const dirs = (entries: string[], extra: Record<string, unknown> = {}) => ({ json: { ok: true, entries, links: [], truncated: false, max: 1000, ...extra } });

function stub(extra: Record<string, Route> = {}) {
  return routeFetch({
    'GET /api/settings/systems': () => ({ json: { systems: SYSTEMS } }),
    'GET /api/systems/prod-box/remotes': () => ({ json: { state: 'not-enumerable' } }),
    ...extra,
  });
}

/** Lets pending fetches and their state updates land. */
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0); });

async function openNew() {
  act(() => openNewProjectDialog());
  await system();
  await flush();
}
async function renderNew() {
  const r = render(<DialogsHost />);
  await openNew();
  return r;
}

const nameField = () => screen.getByLabelText('Name') as HTMLInputElement;
const pathField = () => screen.getByRole('combobox', { name: 'Path on that system' }) as HTMLInputElement;
const queryPathField = () => screen.queryByRole('combobox', { name: 'Path on that system' });
const preview = () => document.querySelector('[data-preview]')!.textContent;
const typeName = (v: string) => fireEvent.change(nameField(), { target: { value: v } });
const typeTarget = async (v: string) => fireEvent.change(await findTargetText(), { target: { value: v } });
const setPath = (v: string) => fireEvent.change(pathField(), { target: { value: v } });
const create = () => fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
const posts = (calls: RoutedCall[]) => calls.filter((c) => c.method === 'POST' && c.url === '/api/projects');
const listings = (calls: RoutedCall[]) => calls.filter((c) => c.url.startsWith('/api/fs/dirs?')).map((c) => new URLSearchParams(c.url.split('?')[1]));
const alertText = () => screen.queryByRole('alert')?.textContent ?? null;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  for (const k of Object.keys(dialogStore.get()) as (keyof ReturnType<typeof dialogStore.get>)[]) closeDialog(k);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('New project dialog', () => {
  // A local create sends the name alone, and with nothing to confirm the dialog closes.
  it('a local create posts only the name and closes the dialog', async () => {
    const calls = stub({ 'POST /api/projects': () => created() });
    await renderNew();
    typeName('demo');
    create();
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toEqual({ name: 'demo' });
    await waitFor(() => expect(dialogStore.get().newProject).toBe(false));
  });

  // The path field exists only on a system, and the preview moves from ~/project/<name> to "<path> on <system>".
  it('choosing a system reveals the path field and retargets the preview', async () => {
    stub();
    await renderNew();
    typeName('demo');
    expect(queryPathField()).toBeNull();
    expect(preview()).toBe('~/project/demo');
    await chooseSystem('Prod box (prod-box)');
    setPath('/srv/demo');
    expect(preview()).toContain('/srv/demo');
    expect(preview()).toContain("system 'prod-box'");
  });

  // A remote create sends the system and the trimmed path.
  it('a remote create posts the system and the trimmed path', async () => {
    const calls = stub({ 'POST /api/projects': () => created() });
    await renderNew();
    typeName('demo');
    await chooseSystem('Prod box (prod-box)');
    setPath(' /srv/demo ');
    create();
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toEqual({ name: 'demo', system: 'prod-box', systemPath: '/srv/demo' });
  });

  // The Target field is a system's alone; its trimmed value reaches the preview and the POST.
  it('the Target field appears only on a system, the preview names it, and its trimmed value is posted', async () => {
    const calls = stub({ 'POST /api/projects': () => created() });
    await renderNew();
    expect(screen.queryByText('Target', { selector: 'label' })).toBeNull();
    typeName('demo');
    await chooseSystem('Prod box (prod-box)');
    await typeTarget(' ctr_7.a ');
    setPath('/srv/demo');
    expect(preview()).toContain("target 'ctr_7.a' of system 'prod-box'");
    create();
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toEqual({ name: 'demo', system: 'prod-box', systemPath: '/srv/demo', remoteId: 'ctr_7.a' });
  });

  // A blank target is left out of the body rather than sent empty.
  it('a remote create with a blank target posts no remoteId', async () => {
    const calls = stub({ 'POST /api/projects': () => created() });
    await renderNew();
    typeName('demo');
    await chooseSystem('Prod box (prod-box)');
    await typeTarget('   ');
    setPath('/srv/demo');
    create();
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toEqual({ name: 'demo', system: 'prod-box', systemPath: '/srv/demo' });
  });

  // On a system the path is required, refused in the dialog with nothing sent.
  it('a system with no path is refused before any request', async () => {
    const calls = stub({ 'POST /api/projects': () => created() });
    await renderNew();
    typeName('demo');
    await chooseSystem('Prod box (prod-box)');
    create();
    await waitFor(() => expect(alertText()).toMatch(/A path on 'prod-box' is required/));
    expect(posts(calls)).toHaveLength(0);
    expect(dialogStore.get().newProject).toBe(true);
  });

  // On a system a relative path is refused in the dialog with nothing sent.
  it('a relative path on a system is refused before any request', async () => {
    const calls = stub({ 'POST /api/projects': () => created() });
    await renderNew();
    typeName('demo');
    await chooseSystem('Prod box (prod-box)');
    setPath('srv/demo');
    create();
    await waitFor(() => expect(alertText()).toMatch(/must be absolute/));
    expect(posts(calls)).toHaveLength(0);
  });

  // A create that skipped git stops on the confirm pane with the server's reason, and shows no scaffold.
  it('a create that skipped git shows its reason on the confirm pane, and no scaffold', async () => {
    stub({ 'POST /api/projects': () => created({ gitSkipped: 'git init was skipped: spawn git ENOENT' }) });
    await renderNew();
    typeName('demo');
    create();
    await waitFor(() => expect(document.querySelector('[data-git-skipped]')?.textContent).toContain('spawn git ENOENT'));
    expect(document.querySelector('[data-scaffold]')).toBeNull();
    expect(dialogStore.get().newProject).toBe(true);
  });

  // A scaffold-only create shows the scaffold and no git notice.
  it('a scaffold-only create shows the scaffold and no git notice', async () => {
    stub({ 'POST /api/projects': () => created({ scaffold: 'do the thing' }) });
    await renderNew();
    typeName('demo');
    create();
    await waitFor(() => expect((document.querySelector('[data-scaffold]') as HTMLTextAreaElement | null)?.value).toBe('do the thing'));
    expect(document.querySelector('[data-git-skipped]')).toBeNull();
  });

  // The git notice belongs to one create: the next create's confirm pane does not carry it.
  it("a git notice from one create is gone from the next create's confirm pane", async () => {
    let n = 0;
    stub({ 'POST /api/projects': () => (++n === 1 ? created({ gitSkipped: 'spawn git ENOENT' }) : created({ scaffold: 'do the thing' })) });
    await renderNew();
    typeName('demo');
    create();
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }));
    await waitFor(() => expect(dialogStore.get().newProject).toBe(false));
    await openNew();
    typeName('demo');
    create();
    await waitFor(() => expect(document.querySelector('[data-scaffold]')).toBeTruthy());
    expect(document.querySelector('[data-git-skipped]')).toBeNull();
  });

  // The listing asks the chosen system and target for the typed directory, and a completion reaches the preview.
  it('completing a directory asks the chosen system and target, and updates the preview', async () => {
    const calls = stub({ 'GET /api/fs/dirs': () => dirs(['demo', 'web']) });
    await renderNew();
    typeName('demo');
    await chooseSystem('Prod box (prod-box)');
    await typeTarget('r1');
    await typePath(pathField(), '/srv/d');
    await waitFor(() => expect(listed()).toEqual(['demo']));
    const [q] = listings(calls);
    expect([q.get('system'), q.get('remoteId'), q.get('path')]).toEqual(['prod-box', 'r1', '/srv']);
    fireEvent.keyDown(pathField(), { key: 'Tab' });
    expect(pathField().value).toBe('/srv/demo/');
    expect(preview()).toContain('/srv/demo/');
  });

  // A reopened dialog has no list, note or cache, and its create body keeps the plain placement shape.
  it('reopening clears the completion list and its cache, and the create body keeps the placement shape', async () => {
    const calls = stub({
      'GET /api/fs/dirs': () => dirs(['x1', 'x2'], { truncated: true, max: 7 }),
      'POST /api/projects': () => created(),
    });
    await renderNew();
    await chooseSystem('Prod box (prod-box)');
    await typeTarget('r1');
    await typePath(pathField(), '/srv/');
    await waitFor(() => expect(pathNote()).toMatch(/more than 7/));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(dialogStore.get().newProject).toBe(false));
    await openNew();
    typeName('demo');
    await chooseSystem('Prod box (prod-box)');
    await typeTarget('r1');
    expect(listed()).toEqual([]);
    expect(pathNote()).toBe('');
    await typePath(pathField(), '/srv/x');
    await waitFor(() => expect(listings(calls)).toHaveLength(2));
    setPath('/srv/demo');
    create();
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls).map((c) => c.body)).toEqual([{ name: 'demo', system: 'prod-box', systemPath: '/srv/demo', remoteId: 'r1' }]);
  });

  // A new target resets the picker (list, expanded state and note), and the same directory is then listed for the new target.
  it('changing the target closes the open completion list, and the same directory is listed afresh for the new target', async () => {
    const calls = stub({ 'GET /api/fs/dirs': () => dirs(['x1', 'x2'], { truncated: true, max: 9 }) });
    await renderNew();
    await chooseSystem('Prod box (prod-box)');
    await typeTarget('r1');
    await typePath(pathField(), '/srv/');
    await waitFor(() => expect(listed()).toEqual(['x1', 'x2']));
    expect(pathNote()).toMatch(/more than 9/);
    await typeTarget('r2');
    expect(listed()).toEqual([]);
    expect(pathField().getAttribute('aria-expanded')).toBe('false');
    expect(pathNote()).toBe('');
    await typePath(pathField(), '/srv/x');
    await waitFor(() => expect(listings(calls)).toHaveLength(2));
    expect(listings(calls)[1].get('remoteId')).toBe('r2');
  });

  // Leaving the system removes the path field and its list; coming back shows neither a list nor a note until the user types.
  it('changing the system closes the open completion list', async () => {
    stub({ 'GET /api/fs/dirs': () => dirs(['x1', 'x2'], { truncated: true, max: 9 }) });
    await renderNew();
    await chooseSystem('Prod box (prod-box)');
    await typePath(pathField(), '/srv/');
    await waitFor(() => expect(listed()).toEqual(['x1', 'x2']));
    await chooseSystem('This machine');
    expect(queryPathField()).toBeNull();
    expect(listed()).toEqual([]);
    await chooseSystem('Prod box (prod-box)');
    expect(pathField()).toBeTruthy();
    expect(listed()).toEqual([]);
    expect(pathNote()).toBe('');
  });

  // A target picked from the dropdown is the one the preview names and the create posts.
  it('a target picked from the list is posted, and the preview follows it', async () => {
    const calls = stub({
      'GET /api/systems/prod-box/remotes': () => listedAnswer('prod-box', ['ctr-a', 'ctr-b']),
      'POST /api/projects': () => created(),
    });
    await renderNew();
    typeName('demo');
    await chooseSystem('Prod box (prod-box)');
    await chooseTarget('ctr-b');
    expect(preview()).toContain("target 'ctr-b' of system 'prod-box'");
    setPath('/srv/demo');
    create();
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toEqual({ name: 'demo', system: 'prod-box', systemPath: '/srv/demo', remoteId: 'ctr-b' });
  });

  // Under Other…, the typed text, trimmed, is the posted target.
  it('Other… with typed text is posted, trimmed', async () => {
    const calls = stub({
      'GET /api/systems/prod-box/remotes': () => listedAnswer('prod-box', ['ctr-a']),
      'POST /api/projects': () => created(),
    });
    await renderNew();
    typeName('demo');
    await chooseSystem('Prod box (prod-box)');
    await chooseTarget('Other…');
    await typeTarget(' ctr-z ');
    setPath('/srv/demo');
    create();
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toMatchObject({ system: 'prod-box', remoteId: 'ctr-z' });
  });

  // The placement's placeholder refusal stops the create in the dialog.
  it('with the targets listed, the placeholder is refused before any request', async () => {
    const calls = stub({
      'GET /api/systems/prod-box/remotes': () => listedAnswer('prod-box', ['ctr-a']),
      'POST /api/projects': () => created(),
    });
    await renderNew();
    typeName('demo');
    await chooseSystem('Prod box (prod-box)');
    await findTargetSelect();
    setPath('/srv/demo');
    create();
    await waitFor(() => expect(alertText()).toMatch(/Choose a target on 'prod-box'/));
    expect(posts(calls)).toHaveLength(0);
    expect(dialogStore.get().newProject).toBe(true);
  });

  // The placement's blank-Other… refusal stops the create in the dialog.
  it('with the targets listed, a blank Other… is refused before any request', async () => {
    const calls = stub({
      'GET /api/systems/prod-box/remotes': () => listedAnswer('prod-box', ['ctr-a']),
      'POST /api/projects': () => created(),
    });
    await renderNew();
    typeName('demo');
    await chooseSystem('Prod box (prod-box)');
    await chooseTarget('Other…');
    setPath('/srv/demo');
    create();
    await waitFor(() => expect(alertText()).toMatch(/Type a target for 'prod-box', or pick a listed one/));
    expect(posts(calls)).toHaveLength(0);
  });

  // Picking another listed target resets the path picker: its list and its note.
  it('choosing a listed target resets the path picker', async () => {
    stub({
      'GET /api/systems/prod-box/remotes': () => listedAnswer('prod-box', ['ctr-a', 'ctr-b']),
      'GET /api/fs/dirs': () => dirs(['x1', 'x2'], { truncated: true, max: 9 }),
    });
    await renderNew();
    await chooseSystem('Prod box (prod-box)');
    await chooseTarget('ctr-a');
    await typePath(pathField(), '/srv/');
    await waitFor(() => expect(listed()).toEqual(['x1', 'x2']));
    expect(pathNote()).toMatch(/more than 9/);
    await chooseTarget('ctr-b');
    expect(listed()).toEqual([]);
    expect(pathNote()).toBe('');
  });

  // A reopened dialog starts on this machine with no target and no path field, so its next create sends the name alone.
  it('reopening resets the System, the Target and the Remote dropdown, and the next create carries none of them', async () => {
    const calls = stub({
      'GET /api/systems/prod-box/remotes': () => listedAnswer('prod-box', ['ctr-a']),
      'POST /api/projects': () => created(),
    });
    await renderNew();
    typeName('x');
    await chooseSystem('Prod box (prod-box)');
    await chooseTarget('Other…');
    await typeTarget('ctr-z');
    setPath('/srv/x');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(dialogStore.get().newProject).toBe(false));
    await openNew();
    expect(nameField().value).toBe('');
    expect(screen.queryByRole('combobox', { name: 'Target' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Target' })).toBeNull();
    expect(queryPathField()).toBeNull();
    typeName('demo');
    create();
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toEqual({ name: 'demo' });
  });

  // The listing asks for the target picked from the dropdown.
  it('completion asks for the target picked from the list', async () => {
    const calls = stub({
      'GET /api/systems/prod-box/remotes': () => listedAnswer('prod-box', ['ctr-a', 'ctr-b']),
      'GET /api/fs/dirs': () => dirs(['x1']),
    });
    await renderNew();
    await chooseSystem('Prod box (prod-box)');
    await chooseTarget('ctr-b');
    expect(screen.queryByRole('textbox', { name: 'Target' })).toBeNull();
    await typePath(pathField(), '/srv/');
    await waitFor(() => expect(listings(calls)).toHaveLength(1));
    expect([listings(calls)[0].get('system'), listings(calls)[0].get('remoteId')]).toEqual(['prod-box', 'ctr-b']);
  });

  // The listing asks for the target typed under Other….
  it('completion asks for the target typed under Other…', async () => {
    const calls = stub({
      'GET /api/systems/prod-box/remotes': () => listedAnswer('prod-box', ['ctr-a']),
      'GET /api/fs/dirs': () => dirs(['x1']),
    });
    await renderNew();
    await chooseSystem('Prod box (prod-box)');
    await chooseTarget('Other…');
    await typeTarget('ctr-z');
    await typePath(pathField(), '/srv/');
    await waitFor(() => expect(listings(calls)).toHaveLength(1));
    expect(listings(calls)[0].get('remoteId')).toBe('ctr-z');
  });

  // In document order: System, then the Target block (label, dropdown, free text, note), then the path field.
  it('System comes first, then the Target block with its dropdown, free-text field and note, then the path field', async () => {
    stub({ 'GET /api/systems/prod-box/remotes': () => listedAnswer('prod-box', []) });
    await renderNew();
    await chooseSystem('Prod box (prod-box)');
    await chooseTarget('Other…');
    const label = screen.getByText('Target', { selector: 'label' });
    const order = [
      await system(),
      label,
      await findTargetSelect(),
      await findTargetText(),
      screen.getByText(/lists no configured targets/),
      pathField(),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING, `element ${i - 1} precedes element ${i}`).toBeTruthy();
    }
    expect(label.parentElement!.contains(order[2])).toBe(true);
    expect(label.parentElement!.contains(order[3])).toBe(true);
  });

  // Conventions are offered core-first then per plugin as independent boxes with no master toggle; the picks are posted as conventions only, and the scaffold shows after.
  it('conventions are grouped core first then per plugin, each box picked on its own, and the picks are posted with the scaffold shown after', async () => {
    const calls = stub({
      'GET /api/settings/conventions/project': () => ({ json: { conventions: [
        { slug: 'design-guidelines', name: 'Design guidelines', description: 'core', builtin: true },
        { slug: 'playwright-harness/vis-check', name: 'Visual check', description: 'verify UX', plugin: 'playwright-harness', builtin: false, scaffold: 'Build a harness wrapper' },
        { slug: 'playwright-harness/plain', name: 'Plain', description: 'fragment only', plugin: 'playwright-harness', builtin: false },
      ] } }),
      'POST /api/projects': () => created({ scaffold: 'Build a harness wrapper' }),
    });
    await renderNew();
    await waitFor(() => expect(document.querySelectorAll('legend')).toHaveLength(2));
    expect([...document.querySelectorAll('legend')].map((l) => l.textContent)).toEqual(['Project conventions', 'playwright-harness']);
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    const box = (slug: string) => document.querySelector(`[data-convention="${slug}"]`) as HTMLElement;
    fireEvent.click(box('playwright-harness/vis-check'));
    expect(box('playwright-harness/vis-check').getAttribute('aria-checked')).toBe('true');
    expect(box('playwright-harness/plain').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(box('design-guidelines'));
    typeName('demo');
    create();
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    const body = posts(calls)[0].body;
    expect([...body.conventions].sort()).toEqual(['design-guidelines', 'playwright-harness/vis-check']);
    expect(body).not.toHaveProperty('scaffolds');
    await waitFor(() => expect((document.querySelector('[data-scaffold]') as HTMLTextAreaElement | null)?.value).toBe('Build a harness wrapper'));
  });

  // Without remote systems the dialog offers no System row, never reads the registry, and posts no placement.
  it('without remote systems there is no System row and the create posts no system', async () => {
    vi.mocked(loadCapabilities).mockResolvedValueOnce({ remoteSystems: false, voice: true, fuseUnion: true } as any);
    const calls = stub({ 'POST /api/projects': () => created() });
    render(<DialogsHost />);
    act(() => openNewProjectDialog());
    await screen.findByLabelText('Name');
    await flush();
    expect(loadCapabilities).toHaveBeenCalled();
    expect(screen.queryByRole('combobox', { name: 'System' })).toBeNull();
    expect(calls.some((c) => c.url === '/api/settings/systems')).toBe(false);
    typeName('demo');
    create();
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).not.toHaveProperty('system');
    expect(posts(calls)[0].body).not.toHaveProperty('systemPath');
  });

  // The first Escape belongs to an open completion list; only a later one closes the dialog.
  it('Escape in the path field closes the completion list and leaves the dialog open; the next Escape closes the dialog', async () => {
    stub({ 'GET /api/fs/dirs': () => dirs(['api', 'app']) });
    await renderNew();
    await chooseSystem('Prod box (prod-box)');
    await typePath(pathField(), '/srv/');
    await waitFor(() => expect(listed()).toEqual(['api', 'app']));
    fireEvent.keyDown(pathField(), { key: 'Escape' });
    expect(listed()).toEqual([]);
    expect(dialogStore.get().newProject).toBe(true);
    fireEvent.keyDown(pathField(), { key: 'Escape' });
    expect(dialogStore.get().newProject).toBe(false);
  });
});
