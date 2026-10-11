import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('./restart', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./restart')>()),
  performRestart: vi.fn(async () => {}),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import type { Instance } from '@/state/types';
import { RestartButton } from './RestartButton';
import { performRestart, restartStore } from './restart';

const inst = (id: string): Instance => ({ id, project: 'p', status: 'idle', sessionId: `s-${id}`, mode: 'bypassPermissions' });
const button = () => screen.getByRole('button', { name: /^Restart$/ }) as HTMLButtonElement;
const dialog = () => screen.getByRole('dialog', { name: 'Restart the server?' });
const footer = () => [...dialog().querySelectorAll<HTMLButtonElement>('[data-slot="dialog-footer"] button')];
const choice = (label: string) => footer().find((b) => b.textContent === label)!;

beforeEach(() => {
  restartStore.set({ inProgress: false });
  render(<TooltipProvider><RestartButton /></TooltipProvider>);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('restart button', () => {
  it('with no sessions a click restarts at once, plain, and asks nothing', () => {
    // Invariant: an empty instance list restarts immediately with resume:false and opens no dialog.
    act(() => appStore.set({ instances: [] }));
    fireEvent.click(button());
    expect(performRestart).toHaveBeenCalledTimes(1);
    expect(performRestart).toHaveBeenCalledWith({ resume: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('with live sessions a click asks first, counting them, with Cancel, Restart only and Restart & resume in that order', () => {
    // Invariant: with instances the click opens the ask dialog, counting the live instance list, with the three choices in order, and restarts nothing yet.
    act(() => appStore.set({ instances: [inst('a'), inst('b')] }));
    fireEvent.click(button());
    const description = within(dialog()).getByText(/active session/);
    expect(description.textContent).toBe('2 active sessions. Resume them after the restart, or restart only? A plain restart drops them, and temp sessions are archived.');
    expect(footer().map((b) => b.textContent)).toEqual(['Cancel', 'Restart only', 'Restart & resume']);
    expect(performRestart).not.toHaveBeenCalled();
    act(() => appStore.set({ instances: [inst('a')] }));
    expect(within(dialog()).getByText(/active session/).textContent?.startsWith('1 active session. ')).toBe(true);
  });

  it('Cancel closes without restarting, Restart only restarts plain, and Restart & resume restarts with resume', async () => {
    // Invariant: Cancel restarts nothing, Restart only passes resume:false and Restart & resume passes resume:true.
    act(() => appStore.set({ instances: [inst('a'), inst('b')] }));
    fireEvent.click(button());
    fireEvent.click(choice('Cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(performRestart).not.toHaveBeenCalled();
    fireEvent.click(button());
    fireEvent.click(choice('Restart only'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(button());
    fireEvent.click(choice('Restart & resume'));
    expect(vi.mocked(performRestart).mock.calls).toEqual([[{ resume: false }], [{ resume: true }]]);
  });

  it('while a restart is in progress the button is disabled and a click does nothing', () => {
    // Invariant: an in-progress restart disables the button and a click neither asks nor restarts; once it ends the click asks again.
    act(() => appStore.set({ instances: [inst('a'), inst('b')] }));
    act(() => restartStore.set({ inProgress: true }));
    expect(button().disabled).toBe(true);
    fireEvent.click(button());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(performRestart).not.toHaveBeenCalled();
    act(() => restartStore.set({ inProgress: false }));
    expect(button().disabled).toBe(false);
    fireEvent.click(button());
    expect(dialog()).toBeTruthy();
  });
});
