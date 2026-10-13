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
/** How a person activates a control: Enter with keyboard focus on it, a mouse click, or a tap. */
export type Act = (page: Page, control: Locator) => Promise<void>;

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

export const byKey: Act = (page, control) => press(page, control, 'Enter');

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
export const focusInside = (scope: Locator) => scope.evaluate((el) => el.contains(document.activeElement));

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
export async function escape(page: Page) {
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
}

/** Tab and Shift+Tab stay inside `scope` from where focus opened, and wrap at both ends. */
export async function trapHolds(page: Page, scope: Locator, what: string) {
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
export const sessionDialogsFlow = (act: Act, slug = 'dialogs') => async ({ page, cc }: Ctx): Promise<void> => {
  test.setTimeout(120_000);
  const P = label(slug);
  await createProject(cc, P);
  const s = await idleSession(cc, P, false);
  await seedTranscript(cc, s.id, label(slug));
  await next.open(page);
  const row = await next.sessionRow(page, P, s.sessionId);
  await expect.poll(async () => next.sessionRowLive(row)).toBe(true);
  await row.click();
  await expect(next.sessionHeader(page).locator(`[title="session ${s.sessionId}"]`)).toBeVisible();
  const actions = next.sessionHeader(page).getByRole('button', { name: 'Session actions' });

  for (const { which, item } of DIALOGS) {
    await test.step(`${item}`, async () => {
      await act(page, actions);
      const entry = page.getByRole('menuitem', { name: item, exact: true });
      await expect(entry).toBeVisible();
      await act(page, entry);
      const dialog = page.locator(`[role="dialog"][data-dialog="${which}"]`);
      await expect(dialog).toBeVisible();
      await expect.poll(() => focusInside(dialog), { message: `${item}: focus moves inside as it opens` }).toBe(true);
      await settled(page);
      expect(await focusInside(dialog), `${item}: focus is still inside once the menu has gone`).toBe(true);
      await trapHolds(page, dialog, item);
      await escape(page);
      await expect(dialog).toBeHidden();
      await expect(actions, `${item}: closing returns focus to Session actions`).toBeFocused();
    });
  }
};

// Invariant: the phone navigation drawer takes focus as it opens, Tab and Shift+Tab never leave it, and Escape puts
// focus back on the Open sidebar button.
export const drawerFlow = (act: Act) => async ({ page }: Ctx): Promise<void> => {
  test.skip(test.info().project.name === 'desktop', 'the drawer is md:hidden; desktop has the sidebar column');
  await next.open(page);
  const opener = page.getByRole('button', { name: 'Open sidebar' }).filter({ visible: true }).first();
  await act(page, opener);
  const drawer = page.locator('[data-slot="sheet-content"][data-state="open"]');
  await expect(drawer).toBeVisible();
  await expect.poll(() => focusInside(drawer), { message: 'focus moves inside as the drawer opens' }).toBe(true);
  await trapHolds(page, drawer, 'drawer');
  await escape(page);
  await expect(drawer).toHaveCount(0);
  await expect(opener, 'Escape returns focus to Open sidebar').toBeFocused();
};

type Opened = { dialog: Locator; returnsTo: Locator };
export type ReturnCtx = { page: Page; project: string; session: { id: string; sessionId: string } };

/** The sidebar is the phone drawer below the md breakpoint: Pixel 7, or a narrow desktop window. */
const drawerViewport = (page: Page) => (page.viewportSize()?.width ?? 0) < 768;
const sidebarOpener = (page: Page) => page.getByRole('button', { name: 'Open sidebar' }).filter({ visible: true }).first();
const openDrawer = (page: Page) => page.locator('[data-slot="sheet-content"][data-state="open"]');

/** The sidebar, shown by `act` on Open sidebar where it is the drawer. */
async function sidebarBy(page: Page, act: Act) {
  if (drawerViewport(page) && !(await openDrawer(page).count())) {
    await act(page, sidebarOpener(page));
    await expect(openDrawer(page)).toBeVisible();
  }
  return drawerViewport(page) ? openDrawer(page).locator('[data-sidebar]') : nextSidebar(page);
}

/** A sidebar project-menu item: in the drawer the menu closes the drawer first, so focus returns to Open sidebar. */
async function projectMenuItem(page: Page, act: Act, item: string, dialog: Locator): Promise<Opened> {
  const sb = await sidebarBy(page, act);
  const trigger = sb.getByRole('button', { name: 'Project actions' });
  const returnsTo = drawerViewport(page) ? sidebarOpener(page) : trigger;
  await act(page, trigger);
  await act(page, page.getByRole('menuitem', { name: item, exact: true }));
  return { dialog, returnsTo };
}

async function rowButton(page: Page, act: Act, row: string, name: string, dialog: Locator): Promise<Opened> {
  const sb = await sidebarBy(page, act);
  const button = sb.locator(row).getByRole('button', { name, exact: true });
  await act(page, button);
  return { dialog, returnsTo: button };
}

/** Every dialog the web UI opens, by the control a person opens it from. */
export const RETURNS: { name: string; open: (c: ReturnCtx, act: Act) => Promise<Opened> }[] = [
  {
    name: 'Rename',
    open: async ({ page, project, session }, act) => {
      const row = await next.sessionRow(page, project, session.sessionId);
      await row.click();
      await expect(next.sessionHeader(page).locator(`[title="session ${session.sessionId}"]`)).toBeVisible();
      const actions = next.sessionHeader(page).getByRole('button', { name: 'Session actions' });
      await act(page, actions);
      await act(page, page.getByRole('menuitem', { name: 'Rename', exact: true }));
      return { dialog: page.locator('[role="dialog"][data-dialog="rename"]'), returnsTo: actions };
    },
  },
  { name: 'Spawn', open: ({ page, project }, act) => rowButton(page, act, `[data-project-row="${project}"]`, 'New session', page.locator('[role="dialog"][data-dialog="spawn"]')) },
  { name: 'Delete project', open: ({ page, project }, act) => rowButton(page, act, `[data-project-row="${project}"]`, 'Delete project', page.locator('[role="dialog"][data-dialog="delete-project"]')) },
  {
    name: 'a row action confirm',
    open: ({ page, session }, act) => rowButton(page, act, `[data-session-row="${session.sessionId}"] > [data-row]`, 'Archive session (keeps history)', page.getByRole('dialog', { name: /^Archive session / })),
  },
  { name: 'New project', open: ({ page }, act) => projectMenuItem(page, act, 'New project', page.locator('[role="dialog"][data-dialog="new-project"]')) },
  { name: 'Add existing directory', open: ({ page }, act) => projectMenuItem(page, act, 'Add existing directory', page.locator('[role="dialog"][data-dialog="adopt-project"]')) },
  { name: 'New workspace', open: ({ page }, act) => projectMenuItem(page, act, 'New workspace', page.locator('[role="dialog"][data-dialog="workspace"]')) },
  {
    name: 'Restart',
    open: async ({ page }, act) => {
      const sb = await sidebarBy(page, act);
      const button = sb.locator('[data-restart]');
      await act(page, button);
      return { dialog: page.locator('[role="dialog"][data-restart-dialog]'), returnsTo: button };
    },
  },
];

/** Past every closing menu and drawer, and a frame more: where a person's next key lands. */
export async function settled(page: Page) {
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="sheet-content"][data-state="closed"]')).toHaveCount(0);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50))));
}

/** A project with a live temp session, and `row`'s dialog opened in it by `act` (see `opens`). */
export async function openedBy(page: Page, cc: Cc, row: (typeof RETURNS)[number], act: Act, slug: string): Promise<Opened> {
  const project = label(`${slug}-${row.name.replace(/\W+/g, '-').toLowerCase()}`);
  await createProject(cc, project);
  // A live temp session: the row confirm's Archive, Rename's session, and the Restart dialog (asked only with live sessions).
  const session = await idleSession(cc, project, true);
  await next.open(page);
  await expect.poll(async () => next.sessionRowLive(await next.sessionRow(page, project, session.sessionId))).toBe(true);
  if (drawerViewport(page)) {
    await escape(page);
    await expect(openDrawer(page)).toHaveCount(0);
  }
  return opens(page, row, act, { page, project, session });
}

/** `row`'s dialog opened by `act`: focus is inside as it opens, and still inside once the opening has settled. */
export async function opens(page: Page, row: (typeof RETURNS)[number], act: Act, ctx: ReturnCtx): Promise<Opened> {
  const opened = await row.open(ctx, act);
  await expect(opened.dialog).toBeVisible();
  await expect.poll(() => focusInside(opened.dialog), { message: `${row.name}: focus moves inside as it opens` }).toBe(true);
  // A menu or drawer the opening closed finishes leaving first, as it would before any person's next key.
  await settled(page);
  expect(await focusInside(opened.dialog), `${row.name}: focus is still inside once the menu and drawer have gone`).toBe(true);
  return opened;
}

// Invariant: a dialog opened from a control hands focus back to that control when it closes — to a menu's trigger for a
// menu item, and to Open sidebar when the control sat in the phone drawer the dialog's opening closed.
export function returnFlow(row: (typeof RETURNS)[number]) {
  return async ({ page, cc }: Ctx): Promise<void> => {
    test.setTimeout(90_000);
    const { dialog, returnsTo } = await openedBy(page, cc, row, byKey, 'ret');
    await escape(page);
    await expect(dialog).toBeHidden();
    await expect(returnsTo, `${row.name}: closing returns focus to the control that opened it`).toBeFocused();
  };
}

// Invariant: a dialog's close leaves focus where its own action put it. Start session focuses the prompt bar in an animation
// frame that can run before or after the closing dialog's focus return; either way the prompt bar keeps focus.
export async function keepsActionFocusFlow({ page, cc }: Ctx): Promise<void> {
  test.skip(test.info().project.name !== 'desktop', 'a touch device never focuses the prompt bar on select');
  const project = label('keep');
  await createProject(cc, project);
  await next.open(page);
  await next.lens(page, 'projects');
  const sb = await sidebarBy(page, byKey);
  await press(page, sb.locator(`[data-project-row="${project}"]`).getByRole('button', { name: 'New session', exact: true }), 'Enter');
  const dialog = page.locator('[role="dialog"][data-dialog="spawn"]');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Start session' }).click();
  await expect(dialog).toBeHidden();
  const prompt = page.locator('#composer-input');
  await expect(prompt, 'Start session focuses the prompt bar').toBeFocused();
  // Past the closing dialog's focus return (a timer after its unmount) and another frame.
  await page.evaluate(() => new Promise((r) => setTimeout(() => requestAnimationFrame(() => setTimeout(r, 50)), 0)));
  await expect(prompt, 'the dialog closing does not take focus back to New session').toBeFocused();
}
