// Toasts never block a view's top bar, on a real cc. With a toast showing and
// the pointer resting on it (which holds its timer), every control of the commit
// history's header, the session header and the phone Settings bar still takes a
// real click. The toast stays in the Notifications live region, its Close toast
// button removes it, and it leaves on its own once the pointer is off it. The
// body is shared by the per-project spec files; this module declares no tests.
import type { Locator, Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { api, createProject, spawnSession } from './harness/api.ts';
import { commitsView, createWorktree, openHistory } from './commits-actions.shared.ts';
import { next } from './parity/ui.ts';

type Args = { page: Page; cc: Cc };

const drawer = () => test.info().project.name !== 'desktop';
const toasts = (page: Page): Locator => page.locator('[data-sonner-toast]');
const navigation = (page: Page): Locator => page.getByRole('dialog', { name: 'Navigation' });

/**
 * Raises one toast with `raise`, a request's answer, and rests the pointer on it. The positive
 * control for the click that follows: the toast shows, alone, inside the polite Notifications region,
 * hovered, in the top band where it could collide with the bar: its top edge above the bar's bottom
 * plus one bar height.
 */
async function showToast(page: Page, header: Locator, raise: () => Promise<void>): Promise<Locator> {
  await expect(toasts(page), 'no toast is left from the step before').toHaveCount(0);
  await raise();
  const toast = toasts(page);
  await expect(toast, 'the action raised a toast').toHaveCount(1);
  const region = page.getByRole('region', { name: /^Notifications/ });
  await expect(region, 'the toasts are announced politely').toHaveAttribute('aria-live', 'polite');
  await expect(region.locator('[data-sonner-toast]'), 'the toast is inside that live region').toHaveCount(1);
  await toast.hover();
  await expect(toast, 'the hovered toast still shows').toBeVisible();
  const [t, h] = [await toast.boundingBox(), await header.boundingBox()];
  expect(t && h, 'the toast and the header are laid out').toBeTruthy();
  expect(t!.y, 'fixture: the toast shows in the top band, within one header height of the bar').toBeLessThan(h!.y + 2 * h!.height);
  return toast;
}

/** With a toast showing and hovered, `control` takes a real click; `landed` proves the click's effect. */
async function clickPastToast(page: Page, header: Locator, raise: () => Promise<void>, control: Locator, landed: () => Promise<void>): Promise<void> {
  await showToast(page, header, raise);
  await control.click({ timeout: 10_000 });
  await landed();
  // A toast a header control raises slides in through the header, so it can pass under the resting pointer: move it clear.
  await page.mouse.move(1, page.viewportSize()!.height - 1);
  // An error toast outlives the expect default.
  await expect(toasts(page), 'the toast leaves on its own once the pointer is off it').toHaveCount(0, { timeout: 15_000 });
}

/** Opens the drawer with Open sidebar and closes it again with Escape, leaving `stays` on screen. */
async function drawerOpened(page: Page, stays: Locator): Promise<void> {
  await expect(navigation(page), 'Open sidebar opened the drawer').toBeVisible();
  await page.keyboard.press('Escape');
  await expect(stays).toBeVisible();
  await expect(navigation(page)).toHaveCount(0);
}

export async function commitsHeaderFlow({ page, cc }: Args): Promise<void> {
  test.setTimeout(120_000);
  const project = `toast-commits-${test.info().project.name}`;
  await createProject(cc, project);
  const one = await createWorktree(cc, project, 'one');
  await next.open(page);
  await openHistory(page, project, one);
  const view = commitsView(page);
  const header = view.locator('header');
  const named = (name: string) => header.getByRole('button', { name, exact: true });
  const heading = view.getByRole('heading', { level: 1 });
  const syncs: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith(`/worktrees/${one}/sync`)) syncs.push(r.url()); });
  // The worktree matches its parent, so every Sync answers ok and toasts that it is up to date.
  const sync = async () => {
    const answered = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/worktrees/${one}/sync`));
    await named('Sync').click();
    expect((await (await answered).json()).ok, 'the Sync answered ok').toBe(true);
  };

  // Invariant: the toast is dismissable: Close toast removes it while the pointer rests on it.
  const toast = await showToast(page, header, sync);
  await toast.getByRole('button', { name: 'Close toast' }).click();
  await expect(toasts(page), 'Close toast removed it').toHaveCount(0);

  // Invariant: each header control takes a real click while a hovered toast shows.
  if (drawer()) await clickPastToast(page, header, sync, named('Open sidebar'), () => drawerOpened(page, heading));
  const before = syncs.length;
  await clickPastToast(page, header, sync, named('Sync'), async () => {
    // One request from the raise, one from the click.
    await expect.poll(() => syncs.length, 'Sync sent its request').toBe(before + 2);
    await expect(named('Sync'), 'the Sync settled').toBeEnabled();
  });
  await clickPastToast(page, header, sync, named('Merge'), async () => {
    const dialog = page.getByRole('dialog', { name: 'Merge into the parent branch?' });
    await expect(dialog, 'Merge asked first').toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });
  await clickPastToast(page, header, sync, named('Lock'), async () => {
    await expect(named('Locked'), 'Lock round-tripped').toHaveAttribute('aria-pressed', 'true');
    expect((await api(cc, 'GET', `/api/projects/${project}/worktrees/${one}/commits`)).body.locked, 'locked on the server').toBe(true);
  });
  await clickPastToast(page, header, sync, named('Back'), async () => {
    await expect(page, 'Back left the history').not.toHaveURL(/#commits$/);
    await expect(view).toHaveCount(0);
  });
}

export async function sessionHeaderFlow({ page, cc }: Args): Promise<void> {
  test.setTimeout(120_000);
  const project = `toast-session-${test.info().project.name}`;
  const { id, sessionId } = await spawnSession(cc, project, { worktree: true, temp: false });
  await expect.poll(async () => {
    const row = ((await api(cc, 'GET', '/api/instances')).body as { id: string; status: string; sessionId: string | null }[]).find((r) => r.id === id);
    return row?.status === 'idle' && !!row.sessionId;
  }).toBe(true);
  await page.goto(`/next/#session=${sessionId}`);
  const header = page.locator('[data-session-header]');
  const heading = header.getByRole('heading', { level: 1 });
  await expect(heading).toBeVisible();
  const named = (name: string) => header.getByRole('button', { name, exact: true });
  const syncs: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith(`/api/instances/${id}/sync`)) syncs.push(r.url()); });
  // Sync is in the bar on desktop and in ⋮ on a drawer viewport; the worktree matches its parent.
  const sync = async () => {
    const answered = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/instances/${id}/sync`));
    if (drawer()) {
      await named('Session actions').click();
      await page.getByRole('menuitem', { name: 'Sync worktree' }).click();
    } else await named('Sync').click();
    expect((await (await answered).json()).ok, 'the Sync answered ok').toBe(true);
  };

  // Invariant: each header control takes a real click while a hovered toast shows.
  if (drawer()) await clickPastToast(page, header, sync, named('Open sidebar'), () => drawerOpened(page, heading));
  else {
    const before = syncs.length;
    // One request from the raise, one from the click.
    await clickPastToast(page, header, sync, named('Sync'), () => expect.poll(() => syncs.length, 'Sync sent its request').toBe(before + 2));
  }
  await clickPastToast(page, header, sync, named('Plan'), () => expect(named('Plan'), 'the server switched to Plan').toHaveAttribute('aria-pressed', 'true'));
  await clickPastToast(page, header, sync, named('Code'), () => expect(named('Code'), 'the server switched back to Code').toHaveAttribute('aria-pressed', 'true'));
  await clickPastToast(page, header, sync, named('Session actions'), async () => {
    const menu = page.getByRole('menu');
    await expect(menu, 'the session menu opened').toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });
}

export async function settingsHeaderFlow({ page }: Args): Promise<void> {
  test.skip(!drawer(), 'from md up Settings has no top bar: its Back sits in the section column, clear of the top-right toast');
  test.setTimeout(120_000);
  const project = `toast-settings-${test.info().project.name}`;
  const sessionId = '00000000-0000-4000-8000-000000000001';
  // One archived session, routed at the network boundary, whose restore the server refuses: the refusal toasts.
  await page.route('**/api/archived', (r) => r.fulfill({ json: { groups: [{ project, sessions: [{ sessionId, title: 'archived', lastActivity: 0 }] }] } }));
  const restores: string[] = [];
  await page.route(`**/api/projects/${project}/sessions/${sessionId}/restore`, (r) => {
    restores.push(r.request().url());
    return r.fulfill({ status: 500, json: { error: 'refused' } });
  });
  await next.open(page);
  await next.openSettingsSection(page, 'archived');
  await next.expandArchivedGroup(page, project);
  const view = page.locator('[data-settings-view]');
  const header = view.locator('header');
  const named = (name: string) => header.getByRole('button', { name, exact: true });
  const restore = async () => {
    const before = restores.length;
    await view.locator(`[data-session="${sessionId}"]`).getByRole('button', { name: 'Restore', exact: true }).click();
    await expect.poll(() => restores.length, 'Restore sent its request').toBe(before + 1);
  };

  // Invariant: each control of the phone Settings bar takes a real click while a hovered toast shows.
  await clickPastToast(page, header, restore, named('Open sidebar'), () => drawerOpened(page, header.getByRole('heading', { level: 1 })));
  await clickPastToast(page, header, restore, named('Back'), async () => {
    await expect(page, 'Back left Settings').not.toHaveURL(/#settings/);
    await expect(view).toHaveCount(0);
  });
}
