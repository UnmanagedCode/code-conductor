// The placement controls (System, Target) and the path field's completion list,
// as the New-project and Add-project dialog tests reach them. The System row
// renders only once the capabilities answer, so it is always found async.
import { act, fireEvent, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { PATH_PICKER_DEBOUNCE_MS } from '@/features/dialogs/PathInput';
import { chooseOption } from './radixSelect';

export const SYSTEMS = [
  { id: 'local', label: 'This machine', managed: true },
  { id: 'prod-box', label: 'Prod box', managed: false, launch: ['ssh', 'prod', 'p'] },
  { id: 'namedonly', label: 'Named only', managed: false },
];

export const listedAnswer = (system: string, remoteIds: string[]) => ({ json: { system, label: system, state: 'listed', remoteIds } });

export const system = () => screen.findByRole('combobox', { name: 'System' });
export async function chooseSystem(label: string) {
  chooseOption(await system(), label);
}
export const findTargetText = async () => (await screen.findByRole('textbox', { name: 'Target' })) as HTMLInputElement;
export const findTargetSelect = () => screen.findByRole('combobox', { name: 'Target' });
export async function chooseTarget(label: string) {
  chooseOption(await findTargetSelect(), label);
}

/** Types into a path field and lets the debounce fire (fake timers). */
export async function typePath(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
  await act(() => vi.advanceTimersByTimeAsync(PATH_PICKER_DEBOUNCE_MS));
}

/** The open completion list's option texts (the path field's list is the one `ul` listbox; a Radix Select's is not a `ul`). */
export const listed = () => {
  const list = document.querySelector('ul[role="listbox"]');
  return list ? [...list.querySelectorAll('[role="option"]')].map((o) => o.textContent) : [];
};
export const pathNote = () => document.querySelector('[data-path-note]')?.textContent ?? '';
