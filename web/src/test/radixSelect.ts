// Drives a Radix Select under happy-dom. A click on the trigger opens it (a
// non-mouse click); its options are portalled to document.body, so they are
// read from `screen`. Fails loudly when the menu does not open.
import { expect } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';

export function selectOptions(trigger: HTMLElement): string[] {
  act(() => { fireEvent.click(trigger); });
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getAllByRole('listbox').length).toBeGreaterThan(0);
  return screen.getAllByRole('option').map((o) => o.textContent ?? '');
}

/** Opens the menu, picks `name`, and returns the options the menu offered. */
export function chooseOption(trigger: HTMLElement, name: string): string[] {
  const offered = selectOptions(trigger);
  const option = screen.getAllByRole('option').find((o) => o.textContent === name);
  expect(option, `option '${name}'`).toBeTruthy();
  act(() => { fireEvent.click(option!); });
  return offered;
}
