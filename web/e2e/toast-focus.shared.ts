// Keyboard focus around a toast, on a real cc. With a toast showing, forward Tab
// moves through it and on in page order, never back to the page element it came
// from; Shift+Tab walks back out to that element; closing the toast, by keyboard
// or pointer, returns focus there; and Alt+T still focuses the toast list inside
// the polite Notifications region, and leaving that visit returns focus to where
// Alt+T was pressed. The toast is a refused restore's, routed page-locally, so the
// shared cc takes no write. The body is shared by the per-project spec files;
// this module declares no tests.
import type { JSHandle, Locator, Page } from '@playwright/test';
import { test, expect } from './harness/fixtures.ts';
import { next } from './parity/ui.ts';

type Args = { page: Page };

const toasts = (page: Page): Locator => page.locator('[data-sonner-toast]');
const closeButton = (page: Page): Locator => toasts(page).getByRole('button', { name: 'Close toast', exact: true });

/** Opens Settings → Archived on one archived session whose restore the server refuses; returns its Restore button. */
async function openArchived(page: Page): Promise<Locator> {
  const project = `toast-focus-${test.info().project.name}`;
  const sessionId = '00000000-0000-4000-8000-000000000002';
  await page.route('**/api/archived', (r) => r.fulfill({ json: { groups: [{ project, sessions: [{ sessionId, title: 'archived', lastActivity: 0 }] }] } }));
  await page.route(`**/api/projects/${project}/sessions/${sessionId}/restore`, (r) => r.fulfill({ status: 500, json: { error: 'refused' } }));
  await next.open(page);
  await next.openSettingsSection(page, 'archived');
  await next.expandArchivedGroup(page, project);
  return page.locator('[data-settings-view]').locator(`[data-session="${sessionId}"]`).getByRole('button', { name: 'Restore', exact: true });
}

/**
 * Raises one toast from the keyboard and rests the pointer on it, which holds its timer. The positive
 * control for every step after: the toast shows, alone, inside the polite Notifications live region.
 */
async function raise(page: Page, restore: Locator): Promise<void> {
  await expect(toasts(page), 'no toast is left from the step before').toHaveCount(0);
  await restore.focus();
  await page.keyboard.press('Enter');
  await expect(toasts(page), 'the refused restore raised a toast').toHaveCount(1);
  const region = page.getByRole('region', { name: /^Notifications/ });
  await expect(region, 'the toasts are announced politely').toHaveAttribute('aria-live', 'polite');
  await expect(region.locator('[data-sonner-toast]'), 'the toast is inside that live region').toHaveCount(1);
  await toasts(page).hover();
}

const active = (page: Page): Promise<JSHandle<Element | null>> => page.evaluateHandle(() => document.activeElement);
const isActive = (page: Page, el: JSHandle<Element | null>): Promise<boolean> => page.evaluate((e) => e === document.activeElement, el);
const inToaster = (page: Page): Promise<boolean> => page.evaluate(() => !!document.activeElement?.closest('[data-sonner-toaster]'));

/**
 * Tabs forward from the focused element until focus enters the toast; returns the page element
 * focus entered it from: the last page element before the toast in Tab order.
 */
async function tabIntoToast(page: Page): Promise<JSHandle<Element | null>> {
  for (let i = 0; i < 60; i++) {
    const prev = await active(page);
    await page.keyboard.press('Tab');
    if (await inToaster(page)) {
      expect(await page.evaluate((e) => !!e && e !== document.body && !e.closest('[data-sonner-toaster]'), prev), 'fixture: focus entered the toast from a page element').toBe(true);
      expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-sonner-toast')), 'the first stop in the toast is the toast itself').toBe(true);
      return prev;
    }
  }
  throw new Error('Tab never reached the toast');
}

/** Where focus is relative to the toaster and to `before`, the page element it entered the toast from. */
function placeOf(page: Page, before: JSHandle<Element | null>) {
  return page.evaluate((b) => {
    const a = document.activeElement;
    const toaster = document.querySelector('[data-sonner-toaster]');
    const follows = (x: Node, y: Node) => !!(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
    return {
      body: !a || a === document.body,
      isBefore: a === b,
      inToaster: !!a?.closest('[data-sonner-toaster]'),
      afterToaster: !!a && !!toaster && follows(toaster, a),
      wrapped: !!a && !!b && follows(a, b),
    };
  }, before);
}

export async function forwardTabFlow({ page }: Args): Promise<void> {
  const restore = await openArchived(page);
  await raise(page, restore);
  const before = await tabIntoToast(page);
  await page.keyboard.press('Tab');
  await expect(closeButton(page), 'Tab moves on to the toast\'s Close toast').toBeFocused();

  // Invariant: forward Tab out of the toast moves on in DOM order (past the toaster, or wrapped to the
  // page start through the document's own stop), never back to the page element it came from.
  await page.keyboard.press('Tab');
  let place = await placeOf(page, before);
  expect(place.isBefore, 'forward Tab out of the toast does not return to the element it came from').toBe(false);
  expect(place.inToaster, 'forward Tab leaves the toast').toBe(false);
  if (place.body) {
    await page.keyboard.press('Tab');
    place = await placeOf(page, before);
    expect(place.isBefore, 'the Tab after the document stop does not return to the element it came from').toBe(false);
    expect(place.inToaster, 'the Tab after the document stop does not re-enter the toast').toBe(false);
  }
  expect(place.afterToaster || place.wrapped, 'focus moved on past the toaster or wrapped to an element before the one it came from').toBe(true);

  // Invariant: Shift+Tab out of the toast walks back to the page element focus entered it from.
  await page.evaluate((e) => (e as HTMLElement).focus(), before);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(closeButton(page), 'Tab reached Close toast again').toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-sonner-toast')), 'Shift+Tab from Close toast lands on the toast').toBe(true);
  await page.keyboard.press('Shift+Tab');
  expect(await isActive(page, before), 'Shift+Tab out of the toast lands on the element focus came from').toBe(true);
}

export async function closeReturnsFocusFlow({ page }: Args): Promise<void> {
  const restore = await openArchived(page);

  // Invariant: Close toast from the keyboard returns focus to the page element focus entered the toast from.
  await raise(page, restore);
  const before = await tabIntoToast(page);
  await page.keyboard.press('Tab');
  await expect(closeButton(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(toasts(page), 'Close toast removed the toast').toHaveCount(0);
  await expect.poll(() => isActive(page, before), 'focus is back on the element it came from').toBe(true);

  // Invariant: a pointer Close returns focus to the element that held it before the click.
  await raise(page, restore);
  await expect(restore, 'fixture: the raise left focus on Restore').toBeFocused();
  await closeButton(page).click();
  await expect(toasts(page), 'the clicked Close toast removed the toast').toHaveCount(0);
  await expect(restore, 'focus is back on Restore').toBeFocused();
}

export async function altTFlow({ page }: Args): Promise<void> {
  const restore = await openArchived(page);
  await raise(page, restore);
  await expect(restore, 'fixture: the raise left focus on Restore').toBeFocused();

  // Invariant: Alt+T focuses the toast list, inside the polite Notifications region.
  await page.keyboard.press('Alt+KeyT');
  const list = page.getByRole('region', { name: /^Notifications/ }).locator('[data-sonner-toaster]');
  await expect(list, 'Alt+T focused the toast list').toBeFocused();

  // Invariant: Tab moves through a toast visited with Alt+T, and leaving it (Shift+Tab, which stays
  // in the document: the toaster is the page's last Tab stop) returns focus to where Alt+T was pressed.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(closeButton(page), 'Tab moved through the toast to Close toast').toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(restore, 'leaving the toast returned focus to where Alt+T was pressed').toBeFocused();
}
