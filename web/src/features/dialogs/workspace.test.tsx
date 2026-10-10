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
  capabilities: () => null,
}));

import { DialogsHost } from './DialogsHost';
import { closeDialog, dialogStore, openWorkspaceDialog } from './api';
import { ConfirmHost } from '@/ui/feedback';
import { appStore } from '@/state/app';
import { refreshProjects } from '@/app/controller';
import { held, routeFetch, type Route, type RoutedCall } from '@/test/routeFetch';
import type { Project } from '@/state/types';

const proj = (name: string, workspace: string | null): Project => ({ name, path: `/w/${name}`, workspace, system: 'local', remoteId: null, worktrees: [] });

let calls: RoutedCall[];
let routes: Record<string, Route>;
const writes = () => calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.url, c.body]);
const box = (p: string) => document.querySelector<HTMLElement>(`[data-project="${p}"]`)!;
const nameField = () => screen.getByLabelText('Workspace name') as HTMLInputElement;
const byPath = (a: unknown[], b: unknown[]) => String(a[1]).localeCompare(String(b[1]));

beforeEach(() => {
  routes = {};
  calls = routeFetch(routes);
  appStore.set({ projects: [proj('a', 'Old'), proj('b', 'Old'), proj('c', null), proj('d', 'Other')] });
});
afterEach(() => {
  for (const k of Object.keys(dialogStore.get()) as (keyof ReturnType<typeof dialogStore.get>)[]) closeDialog(k);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const renderHost = () => render(<><DialogsHost /><ConfirmHost /></>);

describe('workspace dialog', () => {
  it('New workspace starts blank and, with nothing ticked, creates it empty, refreshes once and closes', async () => {
    // Invariant: a new workspace opens with a blank name, no member ticked and no Delete, and with nothing ticked saves as exactly one POST /api/workspaces.
    renderHost();
    act(() => openWorkspaceDialog(null));
    expect(screen.getByRole('dialog', { name: 'New workspace' })).toBeTruthy();
    expect(nameField().value).toBe('');
    for (const p of ['a', 'b', 'c', 'd']) expect(box(p).getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Delete workspace' })).toBeNull();
    fireEvent.change(nameField(), { target: { value: 'Fresh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(dialogStore.get().workspace).toBeNull());
    expect(writes()).toEqual([['POST', '/api/workspaces', { name: 'Fresh' }]]);
    expect(refreshProjects).toHaveBeenCalledTimes(1);
  });

  it('New workspace with projects ticked assigns each to it and never posts the workspace', async () => {
    // Invariant: a new workspace with members ticked is made by assigning each ticked project to it, with no POST /api/workspaces.
    renderHost();
    act(() => openWorkspaceDialog(null));
    expect(screen.getByText('in Other')).toBeTruthy();
    fireEvent.click(box('c'));
    fireEvent.click(box('d'));
    fireEvent.change(nameField(), { target: { value: 'Fresh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(dialogStore.get().workspace).toBeNull());
    expect(writes().sort(byPath)).toEqual([
      ['PUT', '/api/projects/c/workspace', { workspace: 'Fresh' }],
      ['PUT', '/api/projects/d/workspace', { workspace: 'Fresh' }],
    ]);
  });

  it('Edit pre-ticks the members, renames first, then moves only the projects whose box changed', async () => {
    // Invariant: edit opens with the workspace's members ticked, awaits the rename before any member move, and moves only the projects whose box changed.
    const hold = held();
    routes['PUT /api/workspaces/Old'] = () => hold.answer;
    renderHost();
    act(() => openWorkspaceDialog('Old'));
    expect(screen.getByRole('dialog', { name: 'Edit workspace Old' })).toBeTruthy();
    expect(nameField().value).toBe('Old');
    expect(['a', 'b', 'c', 'd'].map((p) => box(p).getAttribute('aria-checked'))).toEqual(['true', 'true', 'false', 'false']);
    fireEvent.change(nameField(), { target: { value: 'New' } });
    fireEvent.click(box('a'));
    fireEvent.click(box('c'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => {});
    expect(writes()).toEqual([['PUT', '/api/workspaces/Old', { name: 'New' }]]);
    hold.release({ json: { ok: true } });
    await waitFor(() => expect(writes()).toHaveLength(3));
    expect(writes().slice(1).sort(byPath)).toEqual([
      ['PUT', '/api/projects/a/workspace', { workspace: null }],
      ['PUT', '/api/projects/c/workspace', { workspace: 'New' }],
    ]);
  });

  it('a blank name is refused with a message and sends nothing', async () => {
    // Invariant: a whitespace-only name shows the required-name alert, sends nothing and keeps the dialog; a real name then sends.
    renderHost();
    act(() => openWorkspaceDialog(null));
    fireEvent.change(nameField(), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('A workspace name is required.');
    expect(writes()).toEqual([]);
    expect(dialogStore.get().workspace).not.toBeNull();
    fireEvent.change(nameField(), { target: { value: 'W' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
  });

  it('Delete asks first: declining keeps the workspace and the dialog, confirming deletes it, refreshes and closes', async () => {
    // Invariant: Delete workspace sends DELETE only after the confirm is accepted; a declined confirm sends nothing and keeps the dialog.
    renderHost();
    act(() => openWorkspaceDialog('Old'));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Edit workspace Old' })).getByRole('button', { name: 'Delete workspace' }));
    let ask = await screen.findByRole('dialog', { name: 'Delete workspace Old?' });
    expect(within(ask).getByText(/^Its projects move back/).textContent).toBe('Its projects move back to unassigned. No project data is removed.');
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete workspace Old?' })).toBeNull());
    expect(writes()).toEqual([]);
    expect(dialogStore.get().workspace).not.toBeNull();
    expect(refreshProjects).not.toHaveBeenCalled();

    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Edit workspace Old' })).getByRole('button', { name: 'Delete workspace' }));
    ask = await screen.findByRole('dialog', { name: 'Delete workspace Old?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Delete workspace' }));
    await waitFor(() => expect(dialogStore.get().workspace).toBeNull());
    expect(writes()).toEqual([['DELETE', '/api/workspaces/Old', null]]);
    expect(refreshProjects).toHaveBeenCalledTimes(1);
  });

  it("a refused save shows the server's reason, prefixed with the project for a member move, and keeps the dialog", async () => {
    // Invariant: a refused rename shows the server's reason and stops before any member move or refresh; a refused member move is prefixed with its project.
    routes['PUT /api/workspaces/Old'] = () => ({ status: 409, json: { error: "workspace 'New' already exists" } });
    renderHost();
    act(() => openWorkspaceDialog('Old'));
    fireEvent.change(nameField(), { target: { value: 'New' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    let alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe("workspace 'New' already exists");
    expect(writes()).toHaveLength(1);
    expect(dialogStore.get().workspace).not.toBeNull();
    expect(refreshProjects).not.toHaveBeenCalled();

    act(() => closeDialog('workspace'));
    routes['PUT /api/projects/c/workspace'] = () => ({ status: 500, json: { error: 'disk full' } });
    act(() => openWorkspaceDialog(null));
    fireEvent.change(nameField(), { target: { value: 'W' } });
    fireEvent.click(box('c'));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('c: disk full');
  });
});
