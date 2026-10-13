// Pointer focus: every dialog and the navigation drawer opened by a mouse click or a tap takes focus as it opens,
// keeps it through the closing menu and drawer, and keeps Tab and Shift+Tab inside; on touch a dialog whose opening
// target is a text field opens on the dialog itself. The bodies are shared by the per-project spec files and reuse
// the keyboard-focus table, so both suites open the same dialogs from the same controls.
import type { Locator, Page } from '@playwright/test';
import { expect, test, type Cc } from './harness/fixtures.ts';
import { next } from './flows/ui.ts';
import { byKey, escape, openedBy, opens, RETURNS, trapHolds, type Act } from './keyboard-focus.shared.ts';

type Ctx = { page: Page; cc: Cc };
export type How = 'mouse' | 'tap';

export const ACTS: Record<How, Act> = { mouse: (_page, control) => control.click(), tap: (_page, control) => control.tap() };
/** `flow` opened by `how`: a tap needs a touch screen, which the desktop project has not. */
export const by = (how: How, flow: (ctx: Ctx) => Promise<void>) => async ({ page, cc }: Ctx): Promise<void> => {
  if (how === 'tap') test.skip(test.info().project.name === 'desktop', 'desktop has no touch screen');
  await flow({ page, cc });
};
const row = (name: string) => RETURNS.find((r) => r.name === name)!;
const isActive = (scope: Locator) => scope.evaluate((el) => document.activeElement === el);

// Invariant: a dialog opened by a click or a tap has focus inside from the moment it opens and still once the menu or
// drawer the opening closed has gone, Tab and Shift+Tab never leave it, and closing it returns focus to its opener.
export function pointerFlow(r: (typeof RETURNS)[number], how: How) {
  return by(how, async ({ page, cc }) => {
    test.setTimeout(90_000);
    const { dialog, returnsTo } = await openedBy(page, cc, r, ACTS[how], `ptr-${how}`);
    await trapHolds(page, dialog, r.name);
    await escape(page);
    await expect(dialog).toBeHidden();
    await expect(returnsTo, `${r.name}: closing returns focus to the control that opened it`).toBeFocused();
  });
}

/** The dialogs a sidebar Project actions item opens: in the drawer, the opening also closes the drawer. */
export const DRAWER_MENU = ['New project', 'Add existing directory', 'New workspace'];

// Invariant: in a desktop window narrow enough for the drawer, a dialog a mouse click opened from the drawer's
// Project actions menu keeps focus inside after the drawer finishes closing, and closing returns it to Open sidebar.
export function narrowWindowFlow(name: string) {
  return async ({ page }: Ctx): Promise<void> => {
    test.skip(test.info().project.name !== 'desktop', 'a desktop window; the phone projects are touch');
    await page.setViewportSize({ width: 700, height: 900 });
    await next.open(page);
    const { dialog, returnsTo } = await opens(page, row(name), ACTS.mouse, { page, project: '', session: { id: '', sessionId: '' } });
    await trapHolds(page, dialog, name);
    await escape(page);
    await expect(dialog).toBeHidden();
    await expect(returnsTo, `${name}: closing returns focus to Open sidebar`).toBeFocused();
  };
}

/** The text field each dialog's own markup focuses as it opens. */
export const TEXT_TARGETS: Record<string, string> = { 'New project': '#np-name', Rename: '#rename-title', 'Delete project': '#dpd-confirm' };

// Invariant: on touch, a dialog whose opening target is a text field opens focused on the dialog itself, so no soft
// keyboard pops, and Tab from there enters it.
export function touchTextTargetFlow(name: string) {
  return async ({ page, cc }: Ctx): Promise<void> => {
    test.skip(test.info().project.name === 'desktop', 'desktop has no touch screen');
    test.setTimeout(90_000);
    const { dialog } = await openedBy(page, cc, row(name), ACTS.tap, 'touch-text');
    expect(await isActive(dialog), `${name}: focus is on the dialog itself`).toBe(true);
    await expect(dialog.locator(TEXT_TARGETS[name]), `${name}: its text field is not focused`).not.toBeFocused();
    await trapHolds(page, dialog, name);
  };
}

// Invariant: on touch, a dialog whose opening target is not a text field keeps that target: a confirm opens on its
// confirm button.
export async function touchButtonTargetFlow({ page, cc }: Ctx): Promise<void> {
  test.skip(test.info().project.name === 'desktop', 'desktop has no touch screen');
  test.setTimeout(90_000);
  const { dialog } = await openedBy(page, cc, row('a row action confirm'), ACTS.tap, 'touch-button');
  await expect(dialog.locator('[data-slot="dialog-footer"] button').last(), 'the confirm button keeps focus').toBeFocused();
}

// Invariant: with a mouse or a keyboard, a dialog opens on the text field its markup focuses.
export function pointerTextTargetFlow(name: string, how: 'mouse' | 'keyboard') {
  return async ({ page, cc }: Ctx): Promise<void> => {
    test.skip(test.info().project.name !== 'desktop', 'a desktop window; the phone projects are touch');
    test.setTimeout(90_000);
    const { dialog } = await openedBy(page, cc, row(name), how === 'mouse' ? ACTS.mouse : byKey, `text-${how}`);
    await expect(dialog.locator(TEXT_TARGETS[name]), `${name}: its text field has focus`).toBeFocused();
  };
}
