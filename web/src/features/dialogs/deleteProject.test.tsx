import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/app/controller', () => ({
  refreshProjects: vi.fn(async () => {}),
  refreshInstances: vi.fn(async () => {}),
  selectInstance: vi.fn(),
  send: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []),
  closeSession: vi.fn(),
  resumeSession: vi.fn(),
  promoteSession: vi.fn(),
  removeWorktree: vi.fn(),
  performProjectDelete: vi.fn(async () => {}),
  applySessionTitle: vi.fn(async () => 't'),
}));
vi.mock('@shared/capabilities', () => ({
  loadCapabilities: vi.fn(async () => ({ remoteSystems: true, voice: true, fuseUnion: true })),
  capabilities: () => null,
}));
vi.mock('@/features/views/AppSwitcher', () => ({ AppSwitcher: () => null }));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { DialogsHost } from './DialogsHost';
import { closeDialog, dialogStore, openDeleteProjectDialog } from './api';
import { AppSidebar } from '@/features/sidebar/AppSidebar';
import { sidebarStore } from '@/features/sidebar/state';
import { appStore } from '@/state/app';
import { uiStore } from '@/app/ui';
import { performProjectDelete } from '@/app/sessionActions';
import type { Instance, Project } from '@/state/types';
import { pickProjectMenuItem } from '@/test/projectMenu';

const local = (over: Partial<Project> = {}) =>
  ({ name: 'demo', path: '/w/demo', system: 'local', remoteId: null, worktrees: [], ...over }) as unknown as Project;
const inst = (o: Record<string, any>) => ({ id: `i-${o.sessionId}`, status: 'idle', mode: 'plan', ...o }) as unknown as Instance;

function seed(over: Partial<ReturnType<typeof appStore.get>> = {}) {
  appStore.set({
    connection: 'open', everDropped: false, activeId: null, sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [],
    ...over,
  });
}

beforeEach(() => {
  localStorage.clear();
  sidebarStore.set({ collapsedSessions: [], expandedWorktrees: [], expandedWorkspaces: [], expandedConductors: [], inactiveOpen: false, filter: '' });
  seed();
});
afterEach(() => {
  for (const k of Object.keys(dialogStore.get()) as (keyof ReturnType<typeof dialogStore.get>)[]) closeDialog(k);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const renderHost = () => render(<TooltipProvider><DialogsHost /></TooltipProvider>);
const optInLabel = () => document.querySelector('label[for="dpd-delete-dir"]') as HTMLLabelElement;
const effects = () => Array.from(document.querySelectorAll('[data-effects] li')).map((li) => li.textContent);

async function reopen(project: Project, n: number) {
  act(() => closeDialog('deleteProject'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  act(() => openDeleteProjectDialog(project, n));
  await screen.findByRole('dialog');
}

describe('delete-project confirmation', () => {
  it('a mismatched name keeps the submit disabled, and a forced submit says so and deletes nothing', async () => {
    // Only the exact project name enables Delete; a submit with any other name reports the mismatch and deletes nothing.
    // Invariant: no alert shows until a mismatched submit, and that submit raises an alert naming the mismatch.
    renderHost();
    act(() => openDeleteProjectDialog(local(), 0));
    const input = await screen.findByLabelText(/Type the project name/);
    fireEvent.change(input, { target: { value: 'wrong' } });
    const submit = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.submit(input.closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toMatch(/does not match/i);
    expect(performProjectDelete).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'demo' } });
    expect(submit.disabled).toBe(false);
  });

  it('a local project\'s directory opt-in starts unticked, and confirming sends deleteDirectory:false', async () => {
    // The directory opt-in is off on open, so an untouched confirm deletes the project but not its directory.
    renderHost();
    act(() => openDeleteProjectDialog(local(), 0));
    const box = await screen.findByRole('checkbox', { name: /Also delete the directory/ });
    expect(box.getAttribute('aria-checked')).toBe('false');
    fireEvent.change(screen.getByLabelText(/Type the project name/), { target: { value: 'demo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(performProjectDelete).toHaveBeenCalledWith({ name: 'demo', deleteDirectory: false }));
  });

  it('the opt-in label names the project\'s own directory, and follows the project on a reopen', async () => {
    // Invariant: the directory opt-in's label, and so the checkbox's accessible name, carries the open project's own path and no other project's.
    renderHost();
    act(() => openDeleteProjectDialog(local({ path: '/home/me/myrepo' }), 0));
    await screen.findByRole('dialog');
    expect(optInLabel().textContent).toContain('/home/me/myrepo');
    expect(screen.getByRole('checkbox', { name: /\/home\/me\/myrepo/ })).toBeTruthy();
    await reopen(local({ path: '/w/other' }), 0);
    expect(optInLabel().textContent).toContain('/w/other');
    expect(optInLabel().textContent).not.toContain('myrepo');
  });

  it('a project on a system names its path, target and system, and only path and system with no target', async () => {
    // A system project's description names the target only when the project has one.
    // Invariant: the description names the path and the system, and the target exactly when the project has one.
    renderHost();
    const description = () => document.querySelector('[data-slot="dialog-description"]')!.textContent ?? '';
    const onSystem = { name: 'shipping', path: '/app', system: 'prod-box' };
    act(() => openDeleteProjectDialog(local({ ...onSystem, remoteId: 'c1' }), 0));
    await screen.findByRole('dialog');
    expect(description()).toContain('/app');
    expect(description()).toContain('c1');
    expect(description()).toContain('prod-box');
    await reopen(local({ ...onSystem, remoteId: null }), 0);
    expect(description()).toContain('/app');
    expect(description()).toContain('prod-box');
    expect(description()).not.toContain('c1');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByText(/target/i)).toBeNull();
  });

  it('the worktree effect counts the project\'s worktrees: 0 with none, 2 with two', async () => {
    // Invariant: the effect naming worktrees, found by content and not by position, carries the project's worktree count, zero included, and no other count.
    renderHost();
    const wt = () => effects().find((t) => /worktree/.test(t ?? '')) ?? '';
    const says = (re: RegExp) => effects().some((t) => re.test(t ?? ''));
    act(() => openDeleteProjectDialog(local(), 0));
    await screen.findByRole('dialog');
    expect(wt()).toMatch(/\b0 worktrees\b/);
    expect(says(/\b2 worktrees\b/)).toBe(false);
    await reopen(local({ worktrees: [{ name: 'a' }, { name: 'b' }] as any }), 0);
    expect(wt()).toMatch(/\b2 worktrees\b/);
    expect(says(/\b0 worktrees\b/)).toBe(false);
  });

  it('the sidebar\'s ⋮ → Delete… hands the dialog this project\'s live instance count', async () => {
    // The row's Delete… counts the live instances of that project only.
    // Invariant: the kill effect counts this project's 2 live instances, not all 3 in the list.
    seed({
      projects: [{ name: 'far', path: '/p/far', workspace: null, system: 'local', remoteId: null, systemUnreachable: null, isGitRepo: true, worktrees: [] }] as any,
      instances: [inst({ sessionId: 'a', project: 'far' }), inst({ sessionId: 'b', project: 'far' }), inst({ sessionId: 'c', project: 'other' })],
    });
    uiStore.set({ lens: 'projects' });
    render(<TooltipProvider><AppSidebar /><DialogsHost /></TooltipProvider>);
    const farRow = document.querySelector('[data-project-row="far"]') as HTMLElement;
    await pickProjectMenuItem(farRow, 'Delete…');
    await screen.findByRole('dialog');
    expect(effects().some((t) => /\b2 running sessions\b/.test(t ?? ''))).toBe(true);
    expect(effects().some((t) => /\b3 running/.test(t ?? ''))).toBe(false);
    expect(dialogStore.get().deleteProject?.instanceCount).toBe(2);
  });
});
