// Drives a sidebar row's ⋮ menu (a Radix DropdownMenu, project or worktree) under happy-dom.
// It opens on focus + ArrowDown. While it is open Radix hides the rest of the
// page from role queries, so close it before any getByRole outside it.
import { act, fireEvent, screen, within } from '@testing-library/react';

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

/** The row's ⋮ trigger, by its accessible name (`Project menu`, `Worktree menu`). */
export const rowMenuTrigger = (row: HTMLElement, name: string) => within(row).getByRole('button', { name });

/** Opens the row's ⋮ menu and returns it. */
export async function openRowMenu(row: HTMLElement, name: string): Promise<HTMLElement> {
  const trigger = rowMenuTrigger(row, name);
  await act(async () => { trigger.focus(); fireEvent.keyDown(trigger, { key: 'ArrowDown' }); });
  await settle();
  return screen.getByRole('menu');
}

/** The open menu's items, in order. */
export const rowMenuItems = (menu: HTMLElement) => [...menu.querySelectorAll('[role="menuitem"]')] as HTMLElement[];

export async function closeRowMenu() {
  await act(async () => { fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' }); });
  await settle();
}

/** An item's text as assistive tech names it: its `aria-hidden` parts (a trailing tag, an attention dot) left out. */
export const rowMenuItemLabel = (i: HTMLElement) => {
  const c = i.cloneNode(true) as HTMLElement;
  c.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  return c.textContent;
};

/** Opens the row's ⋮ menu and picks the item whose accessible name is `label`. */
export async function pickRowMenuItem(row: HTMLElement, name: string, label: string) {
  const item = rowMenuItems(await openRowMenu(row, name)).find((i) => rowMenuItemLabel(i) === label);
  if (!item) throw new Error(`the ${name.toLowerCase()} has no "${label}" item`);
  await act(async () => { fireEvent.click(item); });
  await settle();
}

export const projectMenuTrigger = (row: HTMLElement) => rowMenuTrigger(row, 'Project menu');
export const openProjectMenu = (row: HTMLElement) => openRowMenu(row, 'Project menu');
export const projectMenuItems = rowMenuItems;
export const closeProjectMenu = closeRowMenu;
export const pickProjectMenuItem = (row: HTMLElement, label: string) => pickRowMenuItem(row, 'Project menu', label);

export const worktreeMenuTrigger = (row: HTMLElement) => rowMenuTrigger(row, 'Worktree menu');
export const openWorktreeMenu = (row: HTMLElement) => openRowMenu(row, 'Worktree menu');
export const pickWorktreeMenuItem = (row: HTMLElement, label: string) => pickRowMenuItem(row, 'Worktree menu', label);
