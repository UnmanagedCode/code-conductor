import { StrictMode } from 'react';
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
vi.mock('@/ui/feedback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui/feedback')>()),
  toast: { error: vi.fn(), success: vi.fn() },
}));

import * as dialogsHost from './DialogsHost';
import { lazyDialogsHost } from './LazyDialogsHost';
import { closeDialog, dialogStore, openRenameDialog, openStatsDialog } from './api';
import { routeFetch } from '@/test/routeFetch';
import { toast } from '@/ui/feedback';

afterEach(() => {
  for (const k of Object.keys(dialogStore.get()) as (keyof ReturnType<typeof dialogStore.get>)[]) closeDialog(k);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/** A loader the test releases or fails by hand. */
function deferred() {
  let release!: () => void;
  let fail!: (e: Error) => void;
  const load = vi.fn(() => new Promise<typeof dialogsHost>((res, rej) => { release = () => res(dialogsHost); fail = rej; }));
  return { load, release: () => act(async () => { release(); }), fail: (e: Error) => act(async () => { fail(e); }) };
}

const input = () => screen.getByRole('textbox', { name: 'Session title' }) as HTMLInputElement;

describe('LazyDialogsHost', () => {
  it('an open made before the dialogs load shows once they land, once, with its arguments', async () => {
    // Invariant: an open() before the chunk lands is held in the store and shows exactly one dialog, with its arguments, after the load; the chunk is requested once.
    routeFetch({});
    const d = deferred();
    const Host = lazyDialogsHost(d.load);
    render(<StrictMode><Host /></StrictMode>);
    act(() => openRenameDialog('s1', 'Old title'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await d.release();
    expect(await screen.findAllByRole('dialog')).toHaveLength(1);
    expect(document.querySelector('[role="dialog"]')?.getAttribute('data-dialog')).toBe('rename');
    expect(input().value).toBe('Old title');
    expect(d.load).toHaveBeenCalledTimes(1);
  });

  it('reopen resets: after load, an edited field reopens at the new slot\'s value', async () => {
    // Invariant: once loaded, each open starts from its own arguments and never from the previous open's edits.
    routeFetch({});
    const d = deferred();
    const Host = lazyDialogsHost(d.load);
    render(<Host />);
    act(() => openRenameDialog('s1', 'Old title'));
    await d.release();
    await screen.findByRole('dialog');
    fireEvent.change(input(), { target: { value: 'Edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(dialogStore.get().rename).toBeNull());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    act(() => openRenameDialog('s2', 'Second'));
    expect((await screen.findByRole('textbox', { name: 'Session title' }) as HTMLInputElement).value).toBe('Second');
    act(() => closeDialog('rename'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    act(() => openRenameDialog('s1', 'Old title'));
    expect((await screen.findByRole('textbox', { name: 'Session title' }) as HTMLInputElement).value).toBe('Old title');
  });

  it('a dialog opened before load returns focus on close to the control it was opened from', async () => {
    // Invariant: a dialog that mounts open because its chunk landed late still hands focus back to the control focused when it was asked to open.
    vi.spyOn(window, 'matchMedia').mockImplementation((q: string) => ({ matches: false, media: q }) as MediaQueryList);
    routeFetch({});
    const d = deferred();
    const Host = lazyDialogsHost(d.load);
    render(<><button>Opener</button><Host /></>);
    const opener = screen.getByRole('button', { name: 'Opener' });
    await act(async () => { opener.focus(); });
    act(() => openRenameDialog('s1', 'Old title'));
    await d.release();
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('a failed load keeps the app up: an open before or after the failure is closed with an error toast', async () => {
    // Invariant: a chunk that fails to load (under StrictMode's double effect) is logged once, leaves the app mounted, closes any open slot (before or after the failure) with exactly one error toast each, and is not retried.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deferred();
    const Host = lazyDialogsHost(d.load);
    render(<StrictMode><p>app</p><Host /></StrictMode>);
    act(() => openRenameDialog('s1', 'Old title'));
    await d.fail(new Error('chunk 404'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(dialogStore.get().rename).toBeNull();
    expect(screen.getByText('app')).toBeTruthy();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('dialogs failed to load'), expect.objectContaining({ message: 'chunk 404' }));
    act(() => openStatsDialog('s1'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2));
    expect(dialogStore.get().stats).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(d.load).toHaveBeenCalledTimes(1);
  });
});
