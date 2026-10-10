import { afterEach, describe, expect, it, vi } from 'vitest';
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
  capabilities: () => null,
}));

import { DialogsHost } from './DialogsHost';
import { closeDialog, dialogStore, openProjectRemoteDialog } from './api';
import { refreshProjects } from '@/app/controller';
import { routeFetch } from '@/test/routeFetch';
import type { Project } from '@/state/types';

const project = { name: 'shipping', path: '/app', system: 'prod-box', remoteId: 'ctr-7', worktrees: [] } as unknown as Project;
const REFUSAL = "remote 'typo' of system 'prod-box', which does not serve it";

afterEach(() => {
  for (const k of Object.keys(dialogStore.get()) as (keyof ReturnType<typeof dialogStore.get>)[]) closeDialog(k);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const target = () => screen.getByLabelText('Target') as HTMLInputElement;

describe('change-target saving', () => {
  it('saving PUTs the trimmed target to the project\'s remote route, refreshes the projects once and closes', async () => {
    // Save sends one PUT of the trimmed target to this project's remote route, then refreshes once and closes.
    const calls = routeFetch({ 'PUT /api/projects/shipping/remote': () => ({ json: { ok: true } }) });
    render(<DialogsHost />);
    act(() => openProjectRemoteDialog(project));
    expect((await screen.findByLabelText('Target') as HTMLInputElement).value).toBe('ctr-7');
    fireEvent.change(target(), { target: { value: '  ctr-9  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(dialogStore.get().projectRemote).toBeNull());
    expect(calls.filter((c) => c.method !== 'GET').map(({ method, url, body }) => ({ method, url, body })))
      .toEqual([{ method: 'PUT', url: '/api/projects/shipping/remote', body: { remoteId: 'ctr-9' } }]);
    expect(refreshProjects).toHaveBeenCalledTimes(1);
  });

  it('any other refusal shows the server message verbatim, lists no blockers, keeps the dialog and refreshes nothing', async () => {
    // A refusal without the placement-in-use code shows body.error as-is, no blocker list, and neither closes nor refreshes.
    routeFetch({ 'PUT /api/projects/shipping/remote': () => ({ status: 502, json: { error: REFUSAL } }) });
    render(<DialogsHost />);
    act(() => openProjectRemoteDialog(project));
    fireEvent.change(await screen.findByLabelText('Target'), { target: { value: 'typo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe(REFUSAL);
    expect(document.querySelector('[data-blockers]')).toBeNull();
    expect(dialogStore.get().projectRemote).not.toBeNull();
    expect(refreshProjects).not.toHaveBeenCalled();
  });

  it('Cancel sends nothing and closes', async () => {
    // Cancel closes the dialog without any request.
    const calls = routeFetch({});
    render(<DialogsHost />);
    act(() => openProjectRemoteDialog(project));
    fireEvent.change(await screen.findByLabelText('Target'), { target: { value: 'ctr-9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(dialogStore.get().projectRemote).toBeNull();
    expect(calls).toEqual([]);
  });

  it('reopening after a refusal starts clean: no message, no blockers, the project\'s own target', async () => {
    // A reopen drops the previous open's message, blockers and typed target.
    routeFetch({
      'PUT /api/projects/shipping/remote': () => ({ status: 409, json: { error: 'in use', code: 'PROJECT_PLACEMENT_IN_USE', instances: ['a1b2c3d4'] } }),
    });
    render(<DialogsHost />);
    act(() => openProjectRemoteDialog(project));
    fireEvent.change(await screen.findByLabelText('Target'), { target: { value: 'ctr-9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(document.querySelector('[data-blockers]')).not.toBeNull());
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    act(() => openProjectRemoteDialog(project));
    expect((await screen.findByLabelText('Target') as HTMLInputElement).value).toBe('ctr-7');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('[data-blockers]')).toBeNull();
  });
});
