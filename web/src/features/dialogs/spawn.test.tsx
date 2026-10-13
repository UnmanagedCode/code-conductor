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
vi.mock('@shared/capabilities', () => ({
  loadCapabilities: vi.fn(async () => ({ remoteSystems: true, voice: true, fuseUnion: true })),
  capabilities: () => null,
}));

import { DialogsHost } from './DialogsHost';
import { closeDialog, dialogStore, openSpawnDialog } from './api';
import { appStore } from '@/state/app';
import { modelsSignal } from '@/app/models';
import { setActiveDefaultSpawnTier, setActiveTierEffort, setActiveTierEnabled } from '@shared/models';
import { held, routeFetch, type RouteAnswer, type RoutedCall } from '@/test/routeFetch';
import { chooseOption, selectOptions } from '@/test/radixSelect';

beforeEach(() => {
  setActiveTierEffort({ fast: 'low', balanced: 'medium', powerful: 'xhigh', frontier: 'max' });
  setActiveTierEnabled({ fast: true, balanced: true, powerful: true, frontier: true });
  setActiveDefaultSpawnTier('powerful');
  appStore.set({
    projects: [
      { name: 'p', path: '/w/p', system: 'local', remoteId: null, worktrees: [], isGitRepo: true, unbornHead: false },
      { name: 'u', path: '/w/u', system: 'local', remoteId: null, worktrees: [], isGitRepo: true, unbornHead: true },
      { name: 'n', path: '/w/n', system: 'local', remoteId: null, worktrees: [], isGitRepo: false, unbornHead: false },
    ] as any,
  });
});
afterEach(() => {
  for (const k of Object.keys(dialogStore.get()) as (keyof ReturnType<typeof dialogStore.get>)[]) closeDialog(k);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function routes(spawnSettings: () => RouteAnswer | Promise<RouteAnswer> = () => ({ json: { debugByDefault: false } })) {
  return routeFetch({
    'POST /api/instances': () => ({ json: { id: 'i1' } }),
    'GET /api/settings/spawn': spawnSettings,
  });
}

const spawnBodies = (calls: RoutedCall[]) => calls.filter((c) => c.method === 'POST' && c.url === '/api/instances').map((c) => c.body);

async function openAdvanced() {
  fireEvent.click(await screen.findByRole('button', { name: 'Advanced options' }));
}

/** Clicks Start and returns the body of the spawn it sent. */
async function start(calls: RoutedCall[]) {
  const before = spawnBodies(calls).length;
  fireEvent.click(screen.getByRole('button', { name: /Start session/ }));
  await waitFor(() => expect(spawnBodies(calls)).toHaveLength(before + 1));
  return spawnBodies(calls)[before];
}

/** Waits until the spawn dialog has closed after a successful spawn. */
async function closed() {
  await waitFor(() => expect(dialogStore.get().spawn).toBeNull());
}

/** Waits for the open's debug-default GET (the `n`th so far) to land. */
async function settingsLanded(calls: RoutedCall[], n: number) {
  await waitFor(() => expect(calls.filter((c) => c.url === '/api/settings/spawn')).toHaveLength(n));
  await act(async () => {});
}

const combo = (name: 'Effort' | 'Thinking') => screen.getByRole('combobox', { name });
const box = (name: string) => screen.getByRole('checkbox', { name });
const tierRadios = () => Array.from(document.querySelectorAll<HTMLElement>('[role="radio"][data-tier]'));

function closeMenu() {
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
}

describe('spawn dialog options', () => {
  it('a Debug tick made before the default arrives is kept and sent', async () => {
    // A user tick on Debug wins over a debug default that lands after it.
    const settings = held<RouteAnswer>();
    const calls = routes(() => settings.answer);
    render(<DialogsHost />);
    act(() => openSpawnDialog('p'));
    await openAdvanced();
    await waitFor(() => expect(calls.some((c) => c.url === '/api/settings/spawn')).toBe(true));
    fireEvent.click(box('Debug mode'));
    expect(box('Debug mode').getAttribute('aria-checked')).toBe('true');
    settings.release({ json: { debugByDefault: false } });
    await act(async () => {});
    expect(box('Debug mode').getAttribute('aria-checked')).toBe('true');
    expect(await start(calls)).toHaveProperty('debug', true);
  });

  it('opening labels Default with the default tier\'s own effort', async () => {
    // The Default option names the effort of the tier the dialog opened on, not the global default.
    routes();
    render(<DialogsHost />);
    act(() => openSpawnDialog('p'));
    await openAdvanced();
    expect(chooseOption(combo('Effort'), 'Default (xhigh)')[0]).toBe('Default (xhigh)');
  });

  it('picking a tier card re-labels the Default option to that tier\'s effort', async () => {
    // The Default option follows the currently picked tier's effort.
    routes();
    render(<DialogsHost />);
    act(() => openSpawnDialog('p'));
    await openAdvanced();
    fireEvent.click(screen.getByRole('radio', { name: /Frontier/ }));
    expect(chooseOption(combo('Effort'), 'Default (max)')[0]).toBe('Default (max)');
    fireEvent.click(screen.getByRole('radio', { name: /Fast/ }));
    expect(chooseOption(combo('Effort'), 'Default (low)')[0]).toBe('Default (low)');
    fireEvent.click(screen.getByRole('radio', { name: /Balanced/ }));
    expect(chooseOption(combo('Effort'), 'Default (medium)')[0]).toBe('Default (medium)');
  });

  it('an explicit level is sent as the override, and the tier still rides along', async () => {
    // A picked level is sent as `effort`, alongside the picked tier.
    const calls = routes();
    render(<DialogsHost />);
    act(() => openSpawnDialog('p'));
    await openAdvanced();
    chooseOption(combo('Effort'), 'low');
    const body = await start(calls);
    expect(body.effort).toBe('low');
    expect(body.tier).toBe('powerful');
  });

  it('Default is the first option and the only one of its kind, followed by every level in order, and it is the one selected until another is picked', async () => {
    // The menu is the Default sentinel then the level catalog in order; the sentinel is selected until a level is picked.
    routes();
    render(<DialogsHost />);
    act(() => openSpawnDialog('p'));
    await openAdvanced();
    expect(selectOptions(combo('Effort'))).toEqual(['Default (xhigh)', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('data-state'))).toEqual(['checked', 'unchecked', 'unchecked', 'unchecked', 'unchecked', 'unchecked']);
    closeMenu();
    chooseOption(combo('Effort'), 'low');
    selectOptions(combo('Effort'));
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('data-state'))).toEqual(['unchecked', 'checked', 'unchecked', 'unchecked', 'unchecked', 'unchecked']);
    closeMenu();
  });

  it('Thinking offers adaptive, enabled and disabled, starts on adaptive, and sends the one picked', async () => {
    // Thinking offers exactly adaptive/enabled/disabled, starts on adaptive, and the picked value is sent.
    const calls = routes();
    render(<DialogsHost />);
    act(() => openSpawnDialog('p'));
    await openAdvanced();
    expect(selectOptions(combo('Thinking'))).toEqual(['Adaptive (Claude decides)', 'Enabled', 'Disabled']);
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('data-state'))).toEqual(['checked', 'unchecked', 'unchecked']);
    closeMenu();
    chooseOption(combo('Thinking'), 'Enabled');
    expect((await start(calls)).thinking).toBe('enabled');
    await closed();
    act(() => openSpawnDialog('p'));
    await openAdvanced();
    chooseOption(combo('Thinking'), 'Disabled');
    expect((await start(calls)).thinking).toBe('disabled');
  });

  it('tiers disabled in Settings are not offered, and a disabled default tier falls back to the first enabled one in fallback order', async () => {
    // Only enabled tiers get a card, and a disabled default tier starts the dialog on the first enabled one in fallback order.
    setActiveTierEnabled({ balanced: false, powerful: false });
    const calls = routes();
    render(<DialogsHost />);
    act(() => openSpawnDialog('p'));
    await screen.findByRole('button', { name: 'Advanced options' });
    expect(tierRadios().map((r) => r.dataset.tier)).toEqual(['fast', 'frontier']);
    expect(tierRadios().find((r) => r.dataset.tier === 'fast')?.getAttribute('aria-checked')).toBe('true');
    expect((await start(calls)).tier).toBe('fast');
  });

  it('a tier disabled while the dialog is open disappears and the selection falls back', async () => {
    // Disabling the picked tier while open removes its card and moves the selection to the fallback tier.
    routes();
    render(<DialogsHost />);
    act(() => openSpawnDialog('p'));
    await screen.findByRole('button', { name: 'Advanced options' });
    expect(tierRadios().find((r) => r.dataset.tier === 'powerful')?.getAttribute('aria-checked')).toBe('true');
    act(() => { setActiveTierEnabled({ powerful: false }); modelsSignal.bump(); });
    expect(tierRadios().some((r) => r.dataset.tier === 'powerful')).toBe(false);
    expect(tierRadios().find((r) => r.dataset.tier === 'balanced')?.getAttribute('aria-checked')).toBe('true');
  });

  it('with every tier disabled, the fallback tier alone is offered', async () => {
    // With no tier enabled, exactly one card is offered: the fallback tier.
    setActiveTierEnabled({ fast: false, balanced: false, powerful: false, frontier: false });
    routes();
    render(<DialogsHost />);
    act(() => openSpawnDialog('p'));
    await screen.findByRole('button', { name: 'Advanced options' });
    expect(tierRadios().map((r) => r.dataset.tier)).toEqual(['balanced']);
  });

  it('the Debug box starts from the debug-by-default setting and sends its literal state either way', async () => {
    // The box takes the setting's value, and `debug` is always sent as the box's boolean, never omitted.
    let debugByDefault = true;
    const calls = routes(() => ({ json: { debugByDefault } }));
    render(<DialogsHost />);
    act(() => openSpawnDialog('p'));
    await openAdvanced();
    await waitFor(() => expect(box('Debug mode').getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(box('Debug mode'));
    expect(await start(calls)).toHaveProperty('debug', false);
    await closed();
    debugByDefault = false;
    act(() => openSpawnDialog('p'));
    await openAdvanced();
    await settingsLanded(calls, 2);
    expect(box('Debug mode').getAttribute('aria-checked')).toBe('false');
    expect(await start(calls)).toHaveProperty('debug', false);
  });

  it('a Debug tick on one open does not stop the next open from taking the debug default', async () => {
    // The "user ticked Debug" mark belongs to one open: a fresh open applies the debug default again.
    const late = held<RouteAnswer>();
    let gets = 0;
    const calls = routes(() => (++gets === 1 ? late.answer : { json: { debugByDefault: true } }));
    render(<DialogsHost />);
    act(() => openSpawnDialog('p'));
    await openAdvanced();
    await waitFor(() => expect(gets).toBe(1));
    fireEvent.click(box('Debug mode'));
    expect(box('Debug mode').getAttribute('aria-checked')).toBe('true');
    act(() => closeDialog('spawn'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    late.release({ json: { debugByDefault: false } });
    act(() => openSpawnDialog('p'));
    await openAdvanced();
    await settingsLanded(calls, 2);
    expect(box('Debug mode').getAttribute('aria-checked')).toBe('true');
  });

  it('a repo with a commit leaves the worktree box enabled and unticked, with the branched-off-HEAD hint', async () => {
    // A born git repo offers the worktree box enabled, unticked, with the branched-off-HEAD hint.
    routes();
    render(<DialogsHost />);
    act(() => openSpawnDialog('p'));
    await openAdvanced();
    const wt = box('Run in an isolated git worktree') as HTMLButtonElement;
    expect(wt.disabled).toBe(false);
    expect(wt.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Creates a sibling worktree branched off the current HEAD.')).toBeTruthy();
  });

  it('a non-git project disables the worktree box, unticked, with the git-init hint', async () => {
    // A non-git project disables the worktree box, unticked, and says to run git init.
    routes();
    render(<DialogsHost />);
    act(() => openSpawnDialog('n'));
    await openAdvanced();
    const wt = box('Run in an isolated git worktree') as HTMLButtonElement;
    expect(wt.disabled).toBe(true);
    expect(wt.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('The project is not a git repo. Run git init first to use worktrees.')).toBeTruthy();
  });

  it('an unborn-HEAD project disables the worktree box, unticked, with the no-commits hint', async () => {
    // A git repo with no commit disables the worktree box, unticked, and says to make a first commit.
    routes();
    render(<DialogsHost />);
    act(() => openSpawnDialog('u'));
    await openAdvanced();
    const wt = box('Run in an isolated git worktree') as HTMLButtonElement;
    expect(wt.disabled).toBe(true);
    expect(wt.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('The project has no commits yet. Make a first commit to use worktrees.')).toBeTruthy();
  });

  it('a click cannot tick the worktree box on an unborn-HEAD project, so no worktree is sent', async () => {
    // On an unborn HEAD a click leaves the box unticked and the spawn carries no `worktree` key.
    const calls = routes();
    render(<DialogsHost />);
    act(() => openSpawnDialog('u'));
    await openAdvanced();
    fireEvent.click(box('Run in an isolated git worktree'));
    expect(box('Run in an isolated git worktree').getAttribute('aria-checked')).toBe('false');
    expect(await start(calls)).not.toHaveProperty('worktree');
  });

  it('a click ticks the worktree box on a repo with a commit, and the spawn asks for a fresh worktree', async () => {
    // On a born repo a click ticks the box and the spawn sends `worktree: true`.
    const calls = routes();
    render(<DialogsHost />);
    act(() => openSpawnDialog('p'));
    await openAdvanced();
    fireEvent.click(box('Run in an isolated git worktree'));
    expect(box('Run in an isolated git worktree').getAttribute('aria-checked')).toBe('true');
    expect((await start(calls)).worktree).toBe(true);
  });

  it('a worktree named by the caller force-ticks and locks the box, on a born or an unborn repo', async () => {
    // A caller-named worktree ticks and disables the box and names it in the hint, whatever the repo state.
    routes();
    render(<DialogsHost />);
    for (const project of ['p', 'u']) {
      act(() => openSpawnDialog(project, { worktree: 'w' }));
      await openAdvanced();
      const wt = box('Run in an isolated git worktree') as HTMLButtonElement;
      expect(wt.getAttribute('aria-checked'), project).toBe('true');
      expect(wt.disabled, project).toBe(true);
      expect(screen.getByText('Spawns into the existing worktree w.')).toBeTruthy();
      act(() => closeDialog('spawn'));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
  });
});
