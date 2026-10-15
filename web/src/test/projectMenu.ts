// Drives a sidebar project row's ⋮ menu (a Radix DropdownMenu) under happy-dom.
// It opens on focus + ArrowDown. While it is open Radix hides the rest of the
// page from role queries, so close it before any getByRole outside it.
import { act, fireEvent, screen, within } from '@testing-library/react';

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

export const projectMenuTrigger = (row: HTMLElement) => within(row).getByRole('button', { name: 'Project menu' });

/** Opens the row's ⋮ menu and returns it. */
export async function openProjectMenu(row: HTMLElement): Promise<HTMLElement> {
  const trigger = projectMenuTrigger(row);
  await act(async () => { trigger.focus(); fireEvent.keyDown(trigger, { key: 'ArrowDown' }); });
  await settle();
  return screen.getByRole('menu');
}

/** The open menu's items, in order. */
export const projectMenuItems = (menu: HTMLElement) => [...menu.querySelectorAll('[role="menuitem"]')] as HTMLElement[];

export async function closeProjectMenu() {
  await act(async () => { fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' }); });
  await settle();
}

/** Opens the row's ⋮ menu and picks the item whose text is `label`. */
export async function pickProjectMenuItem(row: HTMLElement, label: string) {
  const item = projectMenuItems(await openProjectMenu(row)).find((i) => i.textContent === label);
  if (!item) throw new Error(`the project menu has no "${label}" item`);
  await act(async () => { fireEvent.click(item); });
  await settle();
}
