// The Add-project dialog end to end: its requests, panes and refusals, and its
// wiring to the shared placement (placement.test.tsx owns the placement's own
// display logic) and to the path picker.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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
import { closeDialog, dialogStore, openAdoptProjectDialog } from './api';
import { refreshProjects } from '@/app/controller';
import { loadCapabilities } from '@/lib/core/capabilities.js';
import { routeFetch, type Route, type RoutedCall } from '@/test/routeFetch';
import { SYSTEMS, chooseSystem, chooseTarget, findTargetSelect, findTargetText, listed, listedAnswer, pathNote, system, typePath } from '@/test/placementDriver';

const SCAN = {
  root: '/root',
  maxDepth: 3,
  candidates: [
    { path: '/root/api', relPath: 'api', suggestedName: 'api', isGitRepo: true },
    { path: '/root/plain', relPath: 'plain', suggestedName: 'plain', isGitRepo: false },
  ],
};
const STALE = { json: { ok: false, code: 'PROJECT_EXISTS_STALE', heldPath: '/old/api', discards: { attachments: 0, debug: 0, worktrees: 0 } } };
const OK = { json: { ok: true } };
const dirs = (entries: string[], extra: Record<string, unknown> = {}) => ({ json: { ok: true, entries, links: [], truncated: false, max: 1000, ...extra } });

function stub(extra: Record<string, Route> = {}) {
  return routeFetch({
    'GET /api/settings/systems': () => ({ json: { systems: SYSTEMS } }),
    'GET /api/projects/suggestions': () => ({ json: SCAN }),
    'GET /api/systems/prod-box/remotes': () => ({ json: { state: 'not-enumerable' } }),
    ...extra,
  });
}

/** Lets pending fetches and their state updates land. */
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0); });

async function openAdopt() {
  act(() => openAdoptProjectDialog());
  await system();
  await flush();
}
async function renderAdopt() {
  const r = render(<DialogsHost />);
  await openAdopt();
  return r;
}

const nameField = () => screen.getByLabelText('Name') as HTMLInputElement;
const pathField = () => screen.getByRole('combobox', { name: 'Directory' }) as HTMLInputElement;
const scanNote = () => document.querySelector('[data-scan-note]')!.textContent;
const suggestions = () => document.querySelector('[data-suggestions]');
const typeName = (v: string) => fireEvent.change(nameField(), { target: { value: v } });
const typeTarget = async (v: string) => fireEvent.change(await findTargetText(), { target: { value: v } });
const setPath = (v: string) => fireEvent.change(pathField(), { target: { value: v } });
const add = () => fireEvent.click(screen.getByRole('button', { name: 'Add project' }));
const posts = (calls: RoutedCall[]) => calls.filter((c) => c.method === 'POST' && c.url === '/api/projects/external');
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

describe('Add project dialog', () => {
  // Typing the path a suggestion would fill sends a byte-identical request to clicking that suggestion.
  it('a hand-typed path posts the same request as a clicked suggestion', async () => {
    const calls = stub({ 'POST /api/projects/external': () => OK });
    const first = await renderAdopt();
    fireEvent.click(within(suggestions() as HTMLElement).getByRole('button', { name: /api/ }));
    add();
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    first.unmount();
    await renderAdopt();
    typeName('api');
    setPath('/root/api');
    add();
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    const [clicked, typed] = posts(calls).map(({ method, url, body }) => ({ method, url, body }));
    expect(clicked.body).toEqual({ name: 'api', path: '/root/api' });
    expect(typed).toEqual(clicked);
  });

  // A live-project name clash is a form refusal: its reason on the form, no stale pane, nothing refreshed.
  it('a name held by a live project is refused on the form, with no Relocate / Replace', async () => {
    stub({ 'POST /api/projects/external': () => ({ json: { ok: false, code: 'PROJECT_EXISTS', reason: "A project named 'api' is already registered." } }) });
    await renderAdopt();
    typeName('api');
    setPath('/root/api');
    add();
    await waitFor(() => expect(alertText()).toBe("A project named 'api' is already registered."));
    expect(screen.queryByRole('button', { name: 'Relocate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add project' })).toBeTruthy();
    expect(refreshProjects).not.toHaveBeenCalled();
  });

  // Each stale-pane action re-POSTs the first target plus its own onStaleRecord, and a success refreshes the projects exactly once.
  it('Relocate and Replace each re-POST the same target with their onStaleRecord, and the adopt refreshes the projects once', async () => {
    for (const [button, action] of [['Relocate', 'relocate'], ['Replace', 'replace']] as const) {
      vi.mocked(refreshProjects).mockClear();
      let n = 0;
      const calls = stub({ 'POST /api/projects/external': () => (++n === 1 ? STALE : OK) });
      const r = await renderAdopt();
      typeName('api');
      setPath('/root/api');
      add();
      fireEvent.click(await screen.findByRole('button', { name: button }));
      await waitFor(() => expect(dialogStore.get().adoptProject).toBe(false));
      expect(posts(calls).map((c) => c.body)).toEqual([
        { name: 'api', path: '/root/api' },
        { name: 'api', path: '/root/api', onStaleRecord: action },
      ]);
      expect(refreshProjects).toHaveBeenCalledTimes(1);
      r.unmount();
      vi.unstubAllGlobals();
    }
  });

  // A placement-in-use refusal of a Relocate keeps the stale pane, in the dialog's remedy wording, never the protocol flag.
  it("a placement-in-use refusal of a Relocate stays on the stale pane in the dialog's own words, with Replace still offered", async () => {
    let n = 0;
    stub({
      'POST /api/projects/external': () => (++n === 1 ? STALE : {
        json: { ok: false, code: 'PROJECT_PLACEMENT_IN_USE', reason: "Project 'api' is still in use by worktree wt-1 — delete them first, or pass onStaleRecord:'replace' to discard them along with the rest of its stored state." },
      }),
    });
    await renderAdopt();
    typeName('api');
    setPath('/root/api');
    add();
    fireEvent.click(await screen.findByRole('button', { name: 'Relocate' }));
    await waitFor(() => expect(alertText()).toMatch(/choose Replace below/));
    expect(alertText()).toContain('wt-1');
    expect(alertText()).not.toContain('onStaleRecord');
    expect(document.querySelector('[data-step="stale"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace' })).toBeTruthy();
  });

  // An HTTP error's {error} and a thrown fetch's message each land on the form; neither refreshes the projects.
  it('an error status and a network failure each show their message on the form, and nothing is refreshed', async () => {
    let n = 0;
    stub({ 'POST /api/projects/external': () => (++n === 1 ? { status: 500, json: { error: 'boom' } } : new Error('offline')) });
    await renderAdopt();
    typeName('api');
    setPath('/root/api');
    add();
    await waitFor(() => expect(alertText()).toBe('boom'));
    expect(screen.getByRole('button', { name: 'Add project' })).toBeTruthy();
    add();
    await waitFor(() => expect(alertText()).toBe('offline'));
    expect(screen.getByRole('button', { name: 'Add project' })).toBeTruthy();
    expect(refreshProjects).not.toHaveBeenCalled();
  });

  // Only a candidate that is a git repository carries the git badge; a plain one still lists its relPath.
  it('a git repository candidate wears a git badge and a plain one does not', async () => {
    stub();
    await renderAdopt();
    const [repo, plain] = within(suggestions() as HTMLElement).getAllByRole('button');
    expect(within(repo).queryByText('git')).toBeTruthy();
    expect(within(plain).queryByText('git')).toBeNull();
    expect(plain.textContent).toBe('plain');
  });

  // A failed scan says it did not run (with its status), never "found nothing", lists no candidates, and a typed path still adopts.
  it('a failed scan says the scan did not run, names the status, and a typed path still posts', async () => {
    const calls = stub({
      'GET /api/projects/suggestions': () => ({ status: 500, json: {} }),
      'POST /api/projects/external': () => OK,
    });
    await renderAdopt();
    await waitFor(() => expect(scanNote()).toMatch(/Could not scan for directories \(HTTP 500\)/));
    expect(scanNote()).toMatch(/Type a path below/);
    expect(scanNote()).not.toMatch(/No unregistered/);
    expect(suggestions()).toBeNull();
    typeName('api');
    setPath('/srv/api');
    add();
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toEqual({ name: 'api', path: '/srv/api' });
  });

  // A system hides the local scan and points the note at the system; this machine restores both from the one scan.
  it('choosing a system hides the scanned list and points the note at that system; this machine brings both back with no second scan', async () => {
    const calls = stub();
    await renderAdopt();
    await waitFor(() => expect(suggestions()).toBeTruthy());
    const localNote = scanNote();
    await chooseSystem('Prod box (prod-box)');
    expect(suggestions()).toBeNull();
    expect(scanNote()).toBe("Type an absolute path on system 'prod-box'.");
    await chooseSystem('This machine');
    expect(suggestions()).toBeTruthy();
    expect(scanNote()).toBe(localNote);
    expect(calls.filter((c) => c.url === '/api/projects/suggestions')).toHaveLength(1);
  });

  // The note names the typed target together with its system.
  it('the note names the target once one is typed', async () => {
    stub();
    await renderAdopt();
    await chooseSystem('Prod box (prod-box)');
    await typeTarget('ctr7');
    expect(scanNote()).toBe("Type an absolute path on target 'ctr7' of system 'prod-box'.");
  });

  // A remote adopt sends the chosen system and the trimmed target beside name and path.
  it('a remote adopt posts the system and the trimmed target', async () => {
    const calls = stub({ 'POST /api/projects/external': () => OK });
    await renderAdopt();
    await chooseSystem('Prod box (prod-box)');
    await typeTarget(' ctr_7.a ');
    typeName('api');
    setPath('/srv/api');
    add();
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toEqual({ name: 'api', path: '/srv/api', system: 'prod-box', remoteId: 'ctr_7.a' });
  });

  // A blank target is left out of the body rather than sent empty.
  it('a remote adopt with a blank target posts no remoteId', async () => {
    const calls = stub({ 'POST /api/projects/external': () => OK });
    await renderAdopt();
    await chooseSystem('Prod box (prod-box)');
    await typeTarget('   ');
    typeName('api');
    setPath('/srv/api');
    add();
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toEqual({ name: 'api', path: '/srv/api', system: 'prod-box' });
  });

  // On a system, a relative path is refused in the dialog, naming the system, and nothing is sent.
  it('a relative path on a system is refused before any request, naming the system', async () => {
    const calls = stub({ 'POST /api/projects/external': () => OK });
    await renderAdopt();
    await chooseSystem('Prod box (prod-box)');
    typeName('api');
    setPath('srv/api');
    add();
    await waitFor(() => expect(alertText()).toMatch(/absolute/));
    expect(alertText()).toMatch(/prod-box/);
    expect(posts(calls)).toHaveLength(0);
  });

  // On this machine the dialog does not judge a relative path: the server does, and its reason is shown.
  it('a relative path with no system reaches the server, and its refusal is shown', async () => {
    const calls = stub({ 'POST /api/projects/external': () => ({ json: { ok: false, code: 'INVALID_TARGET_PATH', reason: 'srv/api is not an absolute path.' } }) });
    await renderAdopt();
    typeName('api');
    setPath('srv/api');
    add();
    await waitFor(() => expect(alertText()).toBe('srv/api is not an absolute path.'));
    expect(posts(calls).map((c) => c.body)).toEqual([{ name: 'api', path: 'srv/api' }]);
  });

  // The stale retry sends the first POST's whole placement (system and target) with onStaleRecord.
  it('the stale retry re-sends the placement the first POST carried', async () => {
    let n = 0;
    const calls = stub({ 'POST /api/projects/external': () => (++n === 1 ? STALE : OK) });
    await renderAdopt();
    await chooseSystem('Prod box (prod-box)');
    await typeTarget('ctr7');
    typeName('api');
    setPath('/srv/api');
    add();
    fireEvent.click(await screen.findByRole('button', { name: 'Relocate' }));
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    expect(posts(calls)[1].body).toEqual({ name: 'api', path: '/srv/api', system: 'prod-box', remoteId: 'ctr7', onStaleRecord: 'relocate' });
  });

  // A system change empties the path, whether it was clicked or typed and whichever way the system moves.
  it('choosing another system empties a clicked or typed path, both ways', async () => {
    const calls = stub({ 'POST /api/projects/external': () => OK });
    await renderAdopt();
    fireEvent.click(within(suggestions() as HTMLElement).getByRole('button', { name: /api/ }));
    expect(pathField().value).toBe('/root/api');
    await chooseSystem('Prod box (prod-box)');
    expect(pathField().value).toBe('');
    add();
    await flush();
    expect(posts(calls)).toHaveLength(0);
    setPath('/srv/api');
    await chooseSystem('This machine');
    expect(pathField().value).toBe('');
  });

  // Naming a target moves the note, not the path.
  it('naming a target leaves the path alone', async () => {
    stub();
    await renderAdopt();
    await chooseSystem('Prod box (prod-box)');
    setPath('/srv/api');
    await typeTarget('ctr7');
    expect(pathField().value).toBe('/srv/api');
    expect(scanNote()).toContain("'ctr7'");
  });

  // A system change clears the refusal the previous system raised.
  it('choosing another system clears the error the previous one raised', async () => {
    stub();
    await renderAdopt();
    await chooseSystem('Prod box (prod-box)');
    typeName('api');
    setPath('srv/api');
    add();
    await waitFor(() => expect(alertText()).toMatch(/absolute/));
    await chooseSystem('This machine');
    expect(alertText()).toBeNull();
  });

  // A reopened dialog starts on this machine with no target, so its next adopt carries no placement.
  it('reopening resets the System, the Target and the Remote dropdown, and the next adopt carries none of them', async () => {
    const calls = stub({
      'GET /api/systems/prod-box/remotes': () => listedAnswer('prod-box', ['ctr-a']),
      'POST /api/projects/external': () => OK,
    });
    await renderAdopt();
    await chooseSystem('Prod box (prod-box)');
    await chooseTarget('Other…');
    await typeTarget('ctr-z');
    typeName('x');
    setPath('/srv/x');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(dialogStore.get().adoptProject).toBe(false));
    await openAdopt();
    expect(nameField().value).toBe('');
    expect(pathField().value).toBe('');
    expect(screen.queryByRole('combobox', { name: 'Target' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Target' })).toBeNull();
    typeName('api');
    setPath('/root/api');
    add();
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toEqual({ name: 'api', path: '/root/api' });
  });

  // The listing asks the chosen system and target for the typed directory, Tab fills the field, and the picker adds nothing to the POST.
  it('completion lists the chosen system and target, fills the field, and leaves the POST body unchanged', async () => {
    const calls = stub({
      'GET /api/fs/dirs': () => dirs(['api', 'web']),
      'POST /api/projects/external': () => OK,
    });
    await renderAdopt();
    typeName('api');
    await chooseSystem('Prod box (prod-box)');
    await typeTarget('r1');
    await typePath(pathField(), '/srv/a');
    await waitFor(() => expect(listed()).toEqual(['api']));
    const [q] = listings(calls);
    expect([q.get('system'), q.get('remoteId'), q.get('path')]).toEqual(['prod-box', 'r1', '/srv']);
    fireEvent.keyDown(pathField(), { key: 'Tab' });
    expect(pathField().value).toBe('/srv/api/');
    setPath('/srv/api');
    add();
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toEqual({ name: 'api', path: '/srv/api', system: 'prod-box', remoteId: 'r1' });
  });

  // A new target resets the picker (list, expanded state and note), and the same directory is then listed for the new target.
  it('changing the target closes the open completion list, and the same directory is listed afresh for the new target', async () => {
    const calls = stub({ 'GET /api/fs/dirs': () => dirs(['x1', 'x2'], { truncated: true, max: 9 }) });
    await renderAdopt();
    await chooseSystem('Prod box (prod-box)');
    await typeTarget('r1');
    await typePath(pathField(), '/srv/');
    await waitFor(() => expect(listed()).toEqual(['x1', 'x2']));
    expect(pathField().getAttribute('aria-expanded')).toBe('true');
    expect(pathNote()).toMatch(/more than 9/);
    await typeTarget('r2');
    expect(listed()).toEqual([]);
    expect(pathField().getAttribute('aria-expanded')).toBe('false');
    expect(pathNote()).toBe('');
    await typePath(pathField(), '/srv/x');
    await waitFor(() => expect(listings(calls)).toHaveLength(2));
    expect(listings(calls)[1].get('remoteId')).toBe('r2');
  });

  // A new system resets the picker, and this machine's listing carries no system.
  it('changing the system closes the open completion list, and this machine lists with no system', async () => {
    const calls = stub({ 'GET /api/fs/dirs': () => dirs(['x1', 'x2'], { truncated: true, max: 9 }) });
    await renderAdopt();
    await chooseSystem('Prod box (prod-box)');
    await typePath(pathField(), '/srv/');
    await waitFor(() => expect(listed()).toEqual(['x1', 'x2']));
    expect(pathNote()).toMatch(/more than 9/);
    await chooseSystem('This machine');
    expect(listed()).toEqual([]);
    expect(pathField().getAttribute('aria-expanded')).toBe('false');
    expect(pathNote()).toBe('');
    await typePath(pathField(), '/srv/x');
    await waitFor(() => expect(listings(calls)).toHaveLength(2));
    expect(listings(calls)[0].get('system')).toBe('prod-box');
    expect(listings(calls)[1].has('system')).toBe(false);
  });

  // A refused listing puts its reason under the field, offers nothing, and does not block the adopt.
  it('a refused listing shows its reason under the field, and the adopt still posts', async () => {
    const calls = stub({
      'GET /api/fs/dirs': () => ({ json: { ok: false, code: 'SYSTEM_UNREACHABLE', reason: "System 'prod-box' did not answer." } }),
      'POST /api/projects/external': () => OK,
    });
    await renderAdopt();
    await chooseSystem('Prod box (prod-box)');
    typeName('api');
    await typePath(pathField(), '/srv/api');
    await waitFor(() => expect(pathNote()).toBe("System 'prod-box' did not answer."));
    expect(listed()).toEqual([]);
    add();
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toMatchObject({ name: 'api', path: '/srv/api' });
  });

  // The first Escape belongs to an open completion list; only a later one closes the dialog.
  it('Escape in the path field closes the completion list and leaves the dialog open; the next Escape closes the dialog', async () => {
    stub({ 'GET /api/fs/dirs': () => dirs(['api', 'app']) });
    await renderAdopt();
    await typePath(pathField(), '/srv/');
    await waitFor(() => expect(listed()).toEqual(['api', 'app']));
    fireEvent.keyDown(pathField(), { key: 'Escape' });
    expect(listed()).toEqual([]);
    expect(dialogStore.get().adoptProject).toBe(true);
    fireEvent.keyDown(pathField(), { key: 'Escape' });
    expect(dialogStore.get().adoptProject).toBe(false);
  });

  // A reopened dialog has no list, no note and an empty cache, so the same directory is fetched again.
  it('reopening clears the completion list, its note and its cache', async () => {
    const calls = stub({ 'GET /api/fs/dirs': () => dirs(['x1', 'x2'], { truncated: true, max: 7 }) });
    await renderAdopt();
    await typePath(pathField(), '/srv/');
    await waitFor(() => expect(pathNote()).toMatch(/more than 7/));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(dialogStore.get().adoptProject).toBe(false));
    await openAdopt();
    expect(listed()).toEqual([]);
    expect(pathNote()).toBe('');
    await typePath(pathField(), '/srv/x');
    await waitFor(() => expect(listings(calls)).toHaveLength(2));
  });

  // A target picked from the dropdown is the one the note names and the adopt posts.
  it('a target picked from the list is posted, and the note follows it', async () => {
    const calls = stub({
      'GET /api/systems/prod-box/remotes': () => listedAnswer('prod-box', ['ctr-a', 'ctr-b']),
      'POST /api/projects/external': () => OK,
    });
    await renderAdopt();
    await chooseSystem('Prod box (prod-box)');
    await chooseTarget('ctr-b');
    expect(scanNote()).toContain("target 'ctr-b' of system 'prod-box'");
    typeName('api');
    setPath('/srv/api');
    add();
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toEqual({ name: 'api', path: '/srv/api', system: 'prod-box', remoteId: 'ctr-b' });
  });

  // Under Other…, the typed text, trimmed, is the posted target.
  it('Other… with typed text is posted, trimmed', async () => {
    const calls = stub({
      'GET /api/systems/prod-box/remotes': () => listedAnswer('prod-box', ['ctr-a']),
      'POST /api/projects/external': () => OK,
    });
    await renderAdopt();
    await chooseSystem('Prod box (prod-box)');
    await chooseTarget('Other…');
    await typeTarget(' ctr-z ');
    typeName('api');
    setPath('/srv/api');
    add();
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toMatchObject({ system: 'prod-box', remoteId: 'ctr-z' });
  });

  // The placement's placeholder refusal stops the adopt in the dialog.
  it('with the targets listed, the placeholder is refused before any request', async () => {
    const calls = stub({
      'GET /api/systems/prod-box/remotes': () => listedAnswer('prod-box', ['ctr-a']),
      'POST /api/projects/external': () => OK,
    });
    await renderAdopt();
    await chooseSystem('Prod box (prod-box)');
    await findTargetSelect();
    typeName('api');
    setPath('/srv/api');
    add();
    await waitFor(() => expect(alertText()).toMatch(/Choose a target on 'prod-box'/));
    expect(posts(calls)).toHaveLength(0);
    expect(dialogStore.get().adoptProject).toBe(true);
  });

  // The placement's blank-Other… refusal stops the adopt in the dialog.
  it('with the targets listed, a blank Other… is refused before any request', async () => {
    const calls = stub({
      'GET /api/systems/prod-box/remotes': () => listedAnswer('prod-box', ['ctr-a']),
      'POST /api/projects/external': () => OK,
    });
    await renderAdopt();
    await chooseSystem('Prod box (prod-box)');
    await chooseTarget('Other…');
    typeName('api');
    setPath('/srv/api');
    add();
    await waitFor(() => expect(alertText()).toMatch(/Type a target for 'prod-box', or pick a listed one/));
    expect(posts(calls)).toHaveLength(0);
    expect(dialogStore.get().adoptProject).toBe(true);
  });

  // Picking another listed target resets the path picker: its list and its note.
  it('choosing a listed target resets the path picker', async () => {
    stub({
      'GET /api/systems/prod-box/remotes': () => listedAnswer('prod-box', ['ctr-a', 'ctr-b']),
      'GET /api/fs/dirs': () => dirs(['x1', 'x2'], { truncated: true, max: 9 }),
    });
    await renderAdopt();
    await chooseSystem('Prod box (prod-box)');
    await chooseTarget('ctr-a');
    await typePath(pathField(), '/srv/');
    await waitFor(() => expect(listed()).toEqual(['x1', 'x2']));
    expect(pathNote()).toMatch(/more than 9/);
    await chooseTarget('ctr-b');
    expect(listed()).toEqual([]);
    expect(pathNote()).toBe('');
  });

  // The listing asks for the target picked from the dropdown.
  it('completion asks for the target picked from the list', async () => {
    const calls = stub({
      'GET /api/systems/prod-box/remotes': () => listedAnswer('prod-box', ['ctr-a', 'ctr-b']),
      'GET /api/fs/dirs': () => dirs(['x1']),
    });
    await renderAdopt();
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
    await renderAdopt();
    await chooseSystem('Prod box (prod-box)');
    await chooseTarget('Other…');
    await typeTarget('ctr-z');
    await typePath(pathField(), '/srv/');
    await waitFor(() => expect(listings(calls)).toHaveLength(1));
    expect(listings(calls)[0].get('remoteId')).toBe('ctr-z');
  });

  // Without remote systems the dialog offers no System row, never reads the registry, and posts no system.
  it('without remote systems there is no System row and the adopt posts no system', async () => {
    vi.mocked(loadCapabilities).mockResolvedValueOnce({ remoteSystems: false, voice: true, fuseUnion: true } as any);
    const calls = stub({ 'POST /api/projects/external': () => OK });
    render(<DialogsHost />);
    act(() => openAdoptProjectDialog());
    await screen.findByLabelText('Name');
    await flush();
    expect(loadCapabilities).toHaveBeenCalled();
    expect(screen.queryByRole('combobox', { name: 'System' })).toBeNull();
    expect(calls.some((c) => c.url === '/api/settings/systems')).toBe(false);
    typeName('api');
    setPath('/root/api');
    add();
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).not.toHaveProperty('system');
  });
});
