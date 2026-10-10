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
vi.mock('@/lib/core/capabilities.js', () => ({
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
    renderHost();
    act(() => openDeleteProjectDialog(local(), 0));
    const input = await screen.findByLabelText(/Type the project name/);
    fireEvent.change(input, { target: { value: 'wrong' } });
    const submit = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.submit(input.closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toBe('The name does not match. Nothing was deleted.');
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

  it('the opt-in label is exactly "Also delete the directory" and the literal path', async () => {
    // The opt-in label is the fixed phrase plus the project's path, nothing more.
    renderHost();
    act(() => openDeleteProjectDialog(local({ path: '/home/me/myrepo' }), 0));
    await screen.findByRole('dialog');
    expect(optInLabel().textContent).toBe('Also delete the directory /home/me/myrepo');
  });

  it('the opt-in checkbox comes before its label, in the same row', async () => {
    // The opt-in box and its label share one parent, with the box first in document order.
    renderHost();
    act(() => openDeleteProjectDialog(local(), 0));
    await screen.findByRole('dialog');
    const box = document.getElementById('dpd-delete-dir')!;
    const label = optInLabel();
    expect(box.parentElement).toBe(label.parentElement);
    expect(box.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('a project on a system names its path, target and system, and only path and system with no target', async () => {
    // A system project's description names the target only when the project has one.
    renderHost();
    const onSystem = { name: 'shipping', path: '/app', system: 'prod-box' };
    act(() => openDeleteProjectDialog(local({ ...onSystem, remoteId: 'c1' }), 0));
    expect(await screen.findByText("/app on target 'c1' of system 'prod-box'")).toBeTruthy();
    await reopen(local({ ...onSystem, remoteId: null }), 0);
    expect(screen.getByText("/app on system 'prod-box'")).toBeTruthy();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByText(/target/i)).toBeNull();
  });

  it('a project with no worktrees says Remove 0 worktrees, and one with two says 2', async () => {
    // The worktree effect counts the project's worktrees, zero included.
    renderHost();
    act(() => openDeleteProjectDialog(local(), 0));
    await screen.findByRole('dialog');
    expect(effects()[1]).toBe('Remove 0 worktrees (directory and branch); refused if any is dirty or has dependents');
    await reopen(local({ worktrees: [{ name: 'a' }, { name: 'b' }] as any }), 0);
    expect(effects()[1]).toBe('Remove 2 worktrees (directory and branch); refused if any is dirty or has dependents');
  });

  it('the sidebar\'s Delete project hands the dialog this project\'s live instance count', async () => {
    // The row's Delete project counts the live instances of that project only.
    seed({
      projects: [{ name: 'far', path: '/p/far', workspace: null, system: 'local', remoteId: null, systemUnreachable: null, isGitRepo: true, worktrees: [] }] as any,
      instances: [inst({ sessionId: 'a', project: 'far' }), inst({ sessionId: 'b', project: 'far' }), inst({ sessionId: 'c', project: 'other' })],
    });
    uiStore.set({ lens: 'projects' });
    render(<TooltipProvider><AppSidebar /><DialogsHost /></TooltipProvider>);
    const farRow = document.querySelector('[data-project-row="far"]') as HTMLElement;
    fireEvent.click(within(farRow).getByRole('button', { name: 'Delete project' }));
    await screen.findByRole('dialog');
    expect(effects()[0]).toBe('Kill 2 running sessions');
    expect(dialogStore.get().deleteProject?.instanceCount).toBe(2);
  });
});
