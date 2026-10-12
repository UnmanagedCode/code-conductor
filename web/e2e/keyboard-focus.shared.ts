// Keyboard and focus: Enter/Space on a sidebar row's own actions, and the focus trap and focus return of the
// session dialogs and the navigation drawer, on a real server. The bodies are shared by the per-project spec files.
import type { Locator, Page } from '@playwright/test';
import { api, createProject, spawnSession } from './harness/api.ts';
import { expect, test, type Cc } from './harness/fixtures.ts';
import { seedTranscript } from './harness/transcript.ts';
import { gone, idleInst, spawnConductor } from './flows/fleet.ts';
import { next, nextSidebar } from './flows/ui.ts';

type Ctx = { page: Page; cc: Cc };
type Key = 'Enter' | ' ';

const label = (s: string) => `e2e-kf-${s}-${test.info().project.name}`;
const KEYS: Key[] = ['Enter', ' '];
const keyName = (k: Key) => (k === ' ' ? 'Space' : k);
const hash = (page: Page) => page.evaluate(() => location.hash);

async function idleSession(cc: Cc, project: string, temp: boolean) {
  const { id } = await spawnSession(cc, project, { temp });
  return idleInst(cc, (i) => i.id === id, `session ${id} idle`);
}

/** Presses `key` on `control` with keyboard focus on it. */
async function press(page: Page, control: Locator, key: Key) {
  await control.focus();
  await expect(control).toBeFocused();
  await page.keyboard.press(key);
}

/** The session behind `sid` was not opened: no anchor names it and its row is not the selected one. */
async function notOpened(page: Page, row: Locator, sid: string, what: string) {
  expect(await hash(page), `${what}: the session is not opened`).not.toContain(sid);
  await expect(row, `${what}: the row is not selected`).not.toHaveAttribute('data-active', 'true');
}

/** A confirm dialog the action raised: it is answered with Enter on Cancel, which keeps everything. */
async function confirmShown(page: Page, title: RegExp, what: string) {
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog, `${what}: the action ran and asks to confirm`).toBeVisible();
  // Not Escape: while the action's tooltip is still closing it can take the Escape instead of the dialog.
  await press(page, dialog.getByRole('button', { name: 'Cancel', exact: true }), 'Enter');
  await expect(dialog).toBeHidden();
}

// Invariant: Enter and Space on a button beside a row's open target run that button — its confirm opens, its caret toggles,
// its stop lands — and never open the row's session; Enter and Space on the row's own button open it; no sidebar control
// sits inside another (a nested control is presentational inside an ARIA button).
export async function rowKeysFlow({ page, cc }: Ctx): Promise<void> {
  test.setTimeout(180_000);
  const P = label('rows');
  await createProject(cc, P);
  const temp = await idleSession(cc, P, true);
  const stops = [await idleSession(cc, P, false), await idleSession(cc, P, false)];
  await api(cc, 'POST', '/api/projects/.conduct/ensure');
  const conductor = await spawnConductor(cc, true);
  const inactive = await spawnConductor(cc, false);
  await seedTranscript(cc, inactive.id, label('inactive'));
  await expect.poll(async () => ((await api<{ sessionId: string }[]>(cc, 'GET', '/api/projects/.conduct/sessions')).body).some((r) => r.sessionId === inactive.sessionId),
    { message: 'fixture: the inactive conductor is listed on disk' }).toBe(true);
  await api(cc, 'DELETE', `/api/instances/${inactive.id}`);
  await gone(cc, inactive.id);

  await next.open(page);
  const sb = nextSidebar(page);

  await test.step('Projects lens: ↑ and × on a live temp row confirm, Stop on a live row stops it, and none opens its session', async () => {
    const row = await next.sessionRow(page, P, temp.sessionId);
    await expect.poll(async () => next.sessionRowLive(row), { message: 'fixture: the temp row is live' }).toBe(true);
    for (const key of KEYS) {
      const what = `${keyName(key)} on Make persistent`;
      await press(page, row.getByRole('button', { name: 'Make persistent' }), key);
      await confirmShown(page, /^Keep this session in /, what);
      await notOpened(page, row, temp.sessionId, what);
    }
    for (const key of KEYS) {
      const what = `${keyName(key)} on Archive`;
      await press(page, row.getByRole('button', { name: 'Archive session (keeps history)' }), key);
      await confirmShown(page, /^Archive session /, what);
      await notOpened(page, row, temp.sessionId, what);
    }
    for (const [i, key] of KEYS.entries()) {
      const s = stops[i];
      const what = `${keyName(key)} on Stop`;
      const stopRow = await next.sessionRow(page, P, s.sessionId);
      await expect.poll(async () => next.sessionRowLive(stopRow), { message: `fixture: ${s.sessionId} is live` }).toBe(true);
      await press(page, stopRow.getByRole('button', { name: 'Stop session' }), key);
      await gone(cc, s.id);
      expect(await hash(page), `${what}: the session is not opened`).not.toContain(s.sessionId);
    }
  });

  await test.step('Conductors lens: the caret toggles, ↑ and × confirm, and none opens its conductor', async () => {
    const row = await next.conductorRow(page, conductor.sessionId);
    const caret = row.getByRole('button', { name: 'Show workers' });
    for (const key of KEYS) {
      const what = `${keyName(key)} on Show workers`;
      const was = await caret.getAttribute('aria-expanded');
      await press(page, caret, key);
      await expect(caret, `${what}: the caret toggles`).toHaveAttribute('aria-expanded', was === 'true' ? 'false' : 'true');
      await notOpened(page, row, conductor.sessionId, what);
    }
    for (const key of KEYS) {
      const what = `${keyName(key)} on a conductor's Make persistent`;
      await press(page, row.getByRole('button', { name: 'Make persistent' }), key);
      await confirmShown(page, /^Make this conductor persistent\?$/, what);
      await notOpened(page, row, conductor.sessionId, what);
    }
    await next.openInactive(page);
    const old = await next.conductorRow(page, inactive.sessionId);
    for (const key of KEYS) {
      const what = `${keyName(key)} on an inactive conductor's Archive`;
      await press(page, old.getByRole('button', { name: 'Archive session (keeps history)' }), key);
      await confirmShown(page, /^Archive session /, what);
      await notOpened(page, old, inactive.sessionId, what);
    }
  });

  await test.step('no sidebar control is nested inside another', async () => {
    await expect(sb.locator('[data-conductor]').first()).toBeVisible();
    await expect(sb.locator('button button, [role="button"] button, button [role="button"], [role="button"] [role="button"]')).toHaveCount(0);
    await next.lens(page, 'projects');
    await expect(sb.locator(`[data-session-row="${temp.sessionId}"]`)).toBeVisible();
    await expect(sb.locator('button button, [role="button"] button, button [role="button"], [role="button"] [role="button"]')).toHaveCount(0);
  });

  await test.step("Enter on a session row's own button opens it, and Space on a conductor row's", async () => {
    const row = await next.sessionRow(page, P, temp.sessionId);
    await press(page, row.locator('[data-row-open]'), 'Enter');
    await expect.poll(() => hash(page), { message: 'Enter on the row opens the session' }).toContain(temp.sessionId);
    const crow = await next.conductorRow(page, conductor.sessionId);
    await press(page, crow.locator('[data-row-open]'), ' ');
    await expect.poll(() => hash(page), { message: 'Space on the conductor row opens it' }).toContain(conductor.sessionId);
  });
}

/** Whether keyboard focus is inside `scope`. */
const focusInside = (scope: Locator) => scope.evaluate((el) => el.contains(document.activeElement));

/** Focuses `scope`'s first or last tabbable control (in tab order, visible, enabled). */
function focusEdge(scope: Locator, edge: 'first' | 'last') {
  return scope.evaluate((el, edge) => {
    const all = [...el.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')]
      .filter((c) => c.tabIndex >= 0 && !(c as HTMLButtonElement).disabled && c.getClientRects().length > 0 && getComputedStyle(c).visibility !== 'hidden');
    const target = edge === 'first' ? all[0] : all[all.length - 1];
    target?.focus();
    return target ? (target.getAttribute('aria-label') || target.textContent || target.tagName).trim() : null;
  }, edge);
}

/** Escape, once no tooltip is left mounted: a tooltip Tab opened and is still closing takes the Escape first. */
async function escape(page: Page) {
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
}

/** Tab and Shift+Tab stay inside `scope` from where focus opened, and wrap at both ends. */
async function trapHolds(page: Page, scope: Locator, what: string) {
  expect(await focusInside(scope), `${what}: focus is inside on open`).toBe(true);
  await page.keyboard.press('Tab');
  expect(await focusInside(scope), `${what}: Tab from the opening focus stays inside`).toBe(true);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  expect(await focusInside(scope), `${what}: Shift+Tab stays inside`).toBe(true);
  const last = await focusEdge(scope, 'last');
  expect(last, `${what}: has a tabbable control`).not.toBeNull();
  await page.keyboard.press('Tab');
  expect(await focusInside(scope), `${what}: Tab past the last control (${last}) wraps inside`).toBe(true);
  await focusEdge(scope, 'first');
  await page.keyboard.press('Shift+Tab');
  expect(await focusInside(scope), `${what}: Shift+Tab before the first control wraps inside`).toBe(true);
}

const DIALOGS = [
  { which: 'summary', item: 'Summarize session' },
  { which: 'stats', item: 'Statistics' },
  { which: 'prune', item: 'Prune context…' },
] as const;

// Invariant: each ⋮ dialog takes focus as it opens, Tab and Shift+Tab never leave it, and closing it puts focus back on
// the ⋮ button it was opened from.
export async function sessionDialogsFlow({ page, cc }: Ctx): Promise<void> {
  test.setTimeout(120_000);
  const P = label('dialogs');
  await createProject(cc, P);
  const s = await idleSession(cc, P, false);
  await seedTranscript(cc, s.id, label('dialogs'));
  await next.open(page);
  const row = await next.sessionRow(page, P, s.sessionId);
  await expect.poll(async () => next.sessionRowLive(row)).toBe(true);
  await row.click();
  await expect(next.sessionHeader(page).locator(`[title="session ${s.sessionId}"]`)).toBeVisible();
  const actions = next.sessionHeader(page).getByRole('button', { name: 'Session actions' });

  for (const { which, item } of DIALOGS) {
    await test.step(`${item}`, async () => {
      await press(page, actions, 'Enter');
      const entry = page.getByRole('menuitem', { name: item, exact: true });
      await expect(entry).toBeVisible();
      await press(page, entry, 'Enter');
      const dialog = page.locator(`[role="dialog"][data-dialog="${which}"]`);
      await expect(dialog).toBeVisible();
      await expect.poll(() => focusInside(dialog), { message: `${item}: focus moves inside as it opens` }).toBe(true);
      await trapHolds(page, dialog, item);
      await escape(page);
      await expect(dialog).toBeHidden();
      await expect(actions, `${item}: closing returns focus to Session actions`).toBeFocused();
    });
  }
}

// Invariant: the phone navigation drawer takes focus as it opens, Tab and Shift+Tab never leave it, and Escape puts
// focus back on the Open sidebar button.
export async function drawerFlow({ page }: Ctx): Promise<void> {
  test.skip(test.info().project.name === 'desktop', 'the drawer is md:hidden; desktop has the sidebar column');
  await next.open(page);
  const opener = page.getByRole('button', { name: 'Open sidebar' }).filter({ visible: true }).first();
  await press(page, opener, 'Enter');
  const drawer = page.locator('[data-slot="sheet-content"][data-state="open"]');
  await expect(drawer).toBeVisible();
  await expect.poll(() => focusInside(drawer), { message: 'focus moves inside as the drawer opens' }).toBe(true);
  await trapHolds(page, drawer, 'drawer');
  await escape(page);
  await expect(drawer).toHaveCount(0);
  await expect(opener, 'Escape returns focus to Open sidebar').toBeFocused();
}
