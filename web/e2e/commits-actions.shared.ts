// The web UI's commit history on a real cc: Sync, Merge and Lock are named at
// every width, Lock round-trips through the server and gates Merge, each
// worktree shows its own lock, an action in flight disables all three and an
// ok Sync reloads the list, and Merge asks before it sends anything. The body
// is shared by the per-project spec files; this module declares no tests.
import type { Locator, Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { api, createProject, mcpCall } from './harness/api.ts';
import { next, nextSidebar } from './flows/ui.ts';

type Args = { page: Page; cc: Cc };

export const commitsView = (page: Page): Locator => page.locator('main[data-view="commits"]');

/** Opens `project`'s history, or its `worktree`'s, with the sidebar's Commit history button. */
export async function openHistory(page: Page, project: string, worktree: string | null): Promise<void> {
  const row = worktree
    ? await next.worktreeHead(page, project, worktree)
    : (await next.lens(page, 'projects'), nextSidebar(page).locator(`[data-project-row="${project}"]`));
  await row.getByRole('button', { name: 'Commit history', exact: true }).click();
  await expect(page).toHaveURL(/#commits$/);
  await expect(commitsView(page).getByRole('heading', { level: 1 }), 'the history opened').toContainText(worktree ?? project);
}

/** Clicks the visible Back of whichever full-page view is showing. */
export async function back(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Back', exact: true }).filter({ visible: true }).first().click();
}

/** Creates worktree `name` in `project` and returns its worktree name. */
export async function createWorktree(cc: Cc, project: string, name: string): Promise<string> {
  const list = async () => ((await api(cc, 'GET', `/api/projects/${project}/worktrees`)).body as { worktreeName: string }[]).map((w) => w.worktreeName);
  const before = await list();
  await mcpCall(cc, 'create_worktree', { project, name });
  const added = (await list()).filter((w) => !before.includes(w));
  expect(added, `create_worktree ${name}`).toHaveLength(1);
  return added[0];
}

const lockedOnServer = async (cc: Cc, project: string, worktree: string) =>
  (await api(cc, 'GET', `/api/projects/${project}/worktrees/${worktree}/commits`)).body.locked;

export async function commitsActionsFlow({ page, cc }: Args): Promise<void> {
  const project = `commits-${test.info().project.name}`;
  await createProject(cc, project);
  const one = await createWorktree(cc, project, 'one');
  const two = await createWorktree(cc, project, 'two');
  expect((await api(cc, 'PUT', `/api/projects/${project}/worktrees/${two}/lock`, { locked: true })).status, 'lock two').toBe(200);
  await next.open(page);
  await openHistory(page, project, one);
  const view = commitsView(page);
  const named = (name: string) => view.getByRole('button', { name, exact: true });

  // Invariant: Sync, Merge and Lock are named at every width.
  await expect(named('Sync'), 'Sync is named').toBeVisible();
  await expect(named('Merge'), 'Merge is named').toBeVisible();
  await expect(named('Lock'), 'Lock is named').toBeEnabled();

  // Invariant: Lock asks the server, shows its answer, and gates Merge, both ways.
  await expect(named('Lock')).toHaveAttribute('aria-pressed', 'false');
  await expect(named('Merge')).toBeEnabled();
  await named('Lock').click();
  await expect(named('Locked')).toHaveAttribute('aria-pressed', 'true');
  await expect(named('Merge')).toBeDisabled();
  expect(await lockedOnServer(cc, project, one), 'locked on the server').toBe(true);
  await named('Locked').click();
  await expect(named('Lock')).toHaveAttribute('aria-pressed', 'false');
  await expect(named('Merge')).toBeEnabled();
  expect(await lockedOnServer(cc, project, one), 'unlocked on the server').toBe(false);

  // Invariant: another worktree's history shows that worktree's own lock.
  await openHistory(page, project, two);
  await expect(named('Locked')).toHaveAttribute('aria-pressed', 'true');
  await expect(named('Merge')).toBeDisabled();

  // Invariant: a Sync in flight disables all three; an ok one reloads the list, and Merge stays locked after it.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const syncRoute = `**/api/projects/${project}/worktrees/${two}/sync`;
  await page.route(syncRoute, async (route) => { await gate; await route.continue(); });
  const synced = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/worktrees/${two}/sync`));
  await named('Sync').click();
  await expect(named('Sync'), 'Sync in flight').toBeDisabled();
  await expect(named('Merge')).toBeDisabled();
  await expect(named('Locked'), 'Lock in flight').toBeDisabled();
  const reload = page.waitForRequest((r) => r.method() === 'GET' && r.url().endsWith(`/worktrees/${two}/commits`));
  release();
  expect((await (await synced).json()).ok, 'the Sync answered ok').toBe(true);
  await reload;
  await expect(named('Sync'), 'settled').toBeEnabled();
  await expect(named('Locked')).toBeEnabled();
  await expect(named('Merge'), 'still locked after the Sync').toBeDisabled();
  await page.unroute(syncRoute);

  // Invariant: Merge asks first, and declining sends nothing.
  await openHistory(page, project, one);
  const merges: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/merge')) merges.push(r.url()); });
  await named('Merge').click();
  const dialog = page.getByRole('dialog', { name: 'Merge into the parent branch?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(named('Merge'), 'settled after declining').toBeEnabled();
  expect(merges, 'declining sends no merge').toEqual([]);
}
