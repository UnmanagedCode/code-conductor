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
  capabilities: () => null,
}));

import { DialogsHost } from './DialogsHost';
import { closeDialog, dialogStore, openAdoptProjectDialog, openDeleteProjectDialog, openProjectRemoteDialog, openSpawnDialog, openStatsDialog } from './api';
import { appStore } from '@/state/app';
import { uiStore } from '@/app/ui';
import { performProjectDelete } from '@/app/sessionActions';
import { selectInstance } from '@/app/controller';

type Call = { method: string; url: string; body: any };
let calls: Call[];
let routes: Record<string, (body: any) => { status?: number; json: unknown }>;

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ method, url, body });
    const key = Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
    const r = key ? routes[key](body) : { json: {} };
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }));
  appStore.set({ projects: [{ name: 'p', path: '/w/p', system: 'local', remoteId: null, worktrees: [], isGitRepo: true, unbornHead: false } as any] });
});
afterEach(() => {
  for (const k of Object.keys(dialogStore.get()) as (keyof ReturnType<typeof dialogStore.get>)[]) closeDialog(k);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const posts = (url: string) => calls.filter((c) => c.method !== 'GET' && c.url === url);

describe('spawn dialog', () => {
  it('sends a tier, never a model or backend, and leaves effort to the tier default', async () => {
    routes['POST /api/instances'] = () => ({ json: { id: 'i1' } });
    render(<DialogsHost />);
    act(() => openSpawnDialog('p'));
    fireEvent.click(await screen.findByRole('radio', { name: /Fast/ }));
    fireEvent.click(screen.getByRole('button', { name: /Start session/ }));
    await waitFor(() => expect(posts('/api/instances')).toHaveLength(1));
    const body = posts('/api/instances')[0].body;
    expect(body).toMatchObject({ project: 'p', tier: 'fast', mode: 'bypassPermissions', thinking: 'adaptive', temp: true });
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('backend');
    expect(body.effort).toBeUndefined();
    await waitFor(() => expect(selectInstance).toHaveBeenCalledWith('i1', { userGesture: true }));
    await waitFor(() => expect(dialogStore.get().spawn).toBeNull());
  });

  it('plan mode asks the server to auto-approve the plan', async () => {
    routes['POST /api/instances'] = () => ({ json: { id: 'i1' } });
    render(<DialogsHost />);
    act(() => openSpawnDialog('p'));
    fireEvent.click(await screen.findByRole('radio', { name: /Plan & approve/ }));
    fireEvent.click(screen.getByRole('button', { name: /Start session/ }));
    await waitFor(() => expect(posts('/api/instances')[0]?.body).toMatchObject({ mode: 'plan', autoApprovePlan: true }));
  });

  it('spawning into an existing worktree names it and is not a temp session', async () => {
    routes['POST /api/instances'] = () => ({ json: { id: 'i1' } });
    render(<DialogsHost />);
    act(() => openSpawnDialog('p', { worktree: 'wt1' }));
    fireEvent.click(await screen.findByRole('button', { name: /Start session/ }));
    await waitFor(() => expect(posts('/api/instances')[0]?.body).toMatchObject({ worktree: 'wt1' }));
    expect(posts('/api/instances')[0].body.temp).toBeUndefined();
  });

  it('a refusal shows inline and keeps the dialog open', async () => {
    routes['POST /api/instances'] = () => ({ status: 422, json: { error: 'BACKEND_GONE' } });
    render(<DialogsHost />);
    act(() => openSpawnDialog('p'));
    fireEvent.click(await screen.findByRole('button', { name: /Start session/ }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'BACKEND_GONE');
    expect(dialogStore.get().spawn).not.toBeNull();
  });

  it('a worktree hook that ran is shown in place, with only Done left', async () => {
    routes['POST /api/instances'] = () => ({ json: { id: 'i1', worktree: { postWorktreeCreate: { ran: true, exitCode: 1, durationMs: 12, output: 'boom' } } } });
    render(<DialogsHost />);
    act(() => openSpawnDialog('p'));
    fireEvent.click(await screen.findByRole('button', { name: /Start session/ }));
    expect(await screen.findByText(/Worktree hook: exit 1 \(12ms\)/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Start session/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('the debug default comes from the spawn settings', async () => {
    routes['GET /api/settings/spawn'] = () => ({ json: { debugByDefault: true } });
    routes['POST /api/instances'] = () => ({ json: { id: 'i1' } });
    render(<DialogsHost />);
    act(() => openSpawnDialog('p'));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/settings/spawn')).toBe(true));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /Start session/ }));
    await waitFor(() => expect(posts('/api/instances')[0]?.body.debug).toBe(true));
  });
});

describe('add-project dialog', () => {
  beforeEach(() => {
    routes['GET /api/settings/systems'] = () => ({ json: { systems: [{ id: 'local', label: 'This machine', managed: true }] } });
    routes['GET /api/projects/suggestions'] = () => ({ json: { root: '/w', maxDepth: 3, candidates: [{ path: '/w/legacy', relPath: 'legacy', suggestedName: 'legacy', isGitRepo: true }] } });
  });

  it('clicking a suggestion fills both fields and a local adopt posts exactly {name, path}', async () => {
    routes['POST /api/projects/external'] = () => ({ json: { ok: true } });
    render(<DialogsHost />);
    act(() => openAdoptProjectDialog());
    fireEvent.click(await screen.findByRole('button', { name: /legacy/ }));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('legacy');
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }));
    await waitFor(() => expect(posts('/api/projects/external')).toHaveLength(1));
    expect(posts('/api/projects/external')[0].body).toEqual({ name: 'legacy', path: '/w/legacy' });
    await waitFor(() => expect(dialogStore.get().adoptProject).toBe(false));
  });

  it('a stale record offers Relocate / Replace, names heldPath and every discard, and re-POSTs the same target', async () => {
    let n = 0;
    routes['POST /api/projects/external'] = () => (++n === 1
      ? { json: { ok: false, code: 'PROJECT_EXISTS_STALE', heldPath: '/old/legacy', discards: { attachments: 2, debug: 1, worktrees: 0 } } }
      : { json: { ok: true } });
    render(<DialogsHost />);
    act(() => openAdoptProjectDialog());
    fireEvent.click(await screen.findByRole('button', { name: /legacy/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }));
    expect(await screen.findByText(/registered at \/old\/legacy/)).toBeTruthy();
    expect(screen.getByText('attachments')).toBeTruthy();
    expect(screen.getByText('debug capture')).toBeTruthy();
    expect(screen.getByText('worktree registrations')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Relocate' }));
    await waitFor(() => expect(posts('/api/projects/external')).toHaveLength(2));
    expect(posts('/api/projects/external')[1].body).toEqual({ name: 'legacy', path: '/w/legacy', onStaleRecord: 'relocate' });
  });

  it('a refusal shows its reason on the form', async () => {
    routes['POST /api/projects/external'] = () => ({ json: { ok: false, code: 'NOT_A_DIRECTORY', reason: '/w/legacy is not a directory' } });
    render(<DialogsHost />);
    act(() => openAdoptProjectDialog());
    fireEvent.click(await screen.findByRole('button', { name: /legacy/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }));
    expect((await screen.findByRole('alert')).textContent).toBe('/w/legacy is not a directory');
  });

  it('reopening the dialog resets every field the previous open left behind', async () => {
    routes['POST /api/projects/external'] = () => ({ status: 409, json: { error: 'project exists' } });
    render(<DialogsHost />);
    act(() => openAdoptProjectDialog());
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'x' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Directory' }), { target: { value: '/w/x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }));
    await screen.findByRole('alert');
    act(() => closeDialog('adoptProject'));
    act(() => openAdoptProjectDialog());
    expect((await screen.findByLabelText('Name') as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('combobox', { name: 'Directory' }) as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('change-target dialog', () => {
  const project = { name: 'p', path: '/srv/p', system: 'box', remoteId: 'c1', worktrees: [] } as any;

  it('opens on the project with only the target editable, and clearing it sends null', async () => {
    routes['PUT /api/projects/p/remote'] = () => ({ json: { ok: true } });
    render(<DialogsHost />);
    act(() => openProjectRemoteDialog(project));
    expect((await screen.findByLabelText('System') as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByLabelText('Path on that system') as HTMLInputElement).readOnly).toBe(true);
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ remoteId: null }));
  });

  it('a placement-in-use refusal lists the sessions and worktrees to clear', async () => {
    routes['PUT /api/projects/p/remote'] = () => ({ status: 409, json: { error: 'in use', code: 'PROJECT_PLACEMENT_IN_USE', instances: ['s1'], worktrees: ['w1'] } });
    render(<DialogsHost />);
    act(() => openProjectRemoteDialog(project));
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Session s1: stop it')).toBeTruthy();
    expect(screen.getByText('Worktree w1: delete it')).toBeTruthy();
    expect(dialogStore.get().projectRemote).not.toBeNull();
  });
});

describe('delete-project dialog', () => {
  it('only deletes once the typed name matches, and offers no directory deletion on a system', async () => {
    render(<DialogsHost />);
    act(() => openDeleteProjectDialog({ name: 'p', path: '/srv/p', system: 'box', remoteId: null, worktrees: [] } as any, 0));
    const submit = await screen.findByRole('button', { name: 'Unregister' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText(/Also delete the directory/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Type the project name/), { target: { value: 'p' } });
    fireEvent.click(submit);
    await waitFor(() => expect(performProjectDelete).toHaveBeenCalledWith({ name: 'p', deleteDirectory: false }));
  });

  it('a local project can opt into deleting its directory', async () => {
    render(<DialogsHost />);
    act(() => openDeleteProjectDialog({ name: 'p', path: '/w/p', system: 'local', remoteId: null, worktrees: [] } as any, 1));
    fireEvent.click(await screen.findByLabelText(/Also delete the directory/));
    fireEvent.change(screen.getByLabelText(/Type the project name/), { target: { value: 'p' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(performProjectDelete).toHaveBeenCalledWith({ name: 'p', deleteDirectory: true }));
  });
});

describe('statistics dialog', () => {
  it('shows a worker column only when the session spawned workers, and toggles mid-turn statistics per session', async () => {
    routes['GET /api/costs/session/s1'] = () => ({ json: { own: { cost_usd: 1, duration_ms: 1000, duration_api_ms: 500 }, rolled: { cost_usd: 3 }, workerSessions: 2 } });
    render(<DialogsHost />);
    act(() => openStatsDialog('s1'));
    expect(await screen.findByText('Incl. 2 workers')).toBeTruthy();
    expect(screen.getByText('$1.0000')).toBeTruthy();
    expect(screen.getByText('$3.0000')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Show mid-turn statistics'));
    expect(uiStore.get().callUsageShown.s1).toBe(true);
  });
});
