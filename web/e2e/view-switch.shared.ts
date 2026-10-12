// The web UI's full-page views on a real cc: a commit row's review opens over
// its history and Back retraces review → history → where it was opened from;
// one view at a time with the URL naming it; Back from a view the app did
// not push itself — a deep link the browser's Back returned to — stays in the
// app; and Forward onto a full-page view keeps the selected session. The
// bodies are shared by the per-project spec files; this module declares no
// tests.
import type { Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { createProject, spawnSession } from './harness/api.ts';
import { next } from './flows/ui.ts';
import { back, commitsView, openHistory } from './commits-actions.shared.ts';

type Args = { page: Page; cc: Cc };

const reviewView = (page: Page) => page.locator('main[data-view="review"]');
const costsView = (page: Page) => page.locator('main[data-view="costs"]');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Every full-page view's root, the plugin view's only while it shows; the session pane is none of them. */
const fullPageViews = (page: Page) => page.locator('main[data-view], main[data-settings-view], section[data-view="plugin"][aria-hidden="false"]');

/** Asserts the page sits on the app's session pane: still inside /next/, with no full-page view showing. */
async function onSession(page: Page, cc: Cc, what: string): Promise<void> {
  await expect(page, `${what}: still in the app`).toHaveURL(new RegExp(`^${escapeRe(cc.url)}/next/`));
  await expect(page.locator('main:not([data-view]):not([data-settings-view])'), `${what}: the session pane`).toBeVisible();
  await expect(fullPageViews(page), `${what}: no full-page view`).toHaveCount(0);
}

export async function viewOrderFlow({ page, cc }: Args): Promise<void> {
  const project = `views-${test.info().project.name}`;
  await createProject(cc, project);
  await next.open(page);

  // Invariant: a commit row's review opens over the history, and Back retraces review → history → the session.
  await openHistory(page, project, null);
  await commitsView(page).locator('[data-commit-row]:not([data-commit-row="uncommitted"])').first().click();
  await expect(page).toHaveURL(/#review$/);
  await expect(reviewView(page)).toBeVisible();
  await expect(commitsView(page), 'one view at a time').toHaveCount(0);
  await back(page);
  await expect(page).toHaveURL(/#commits$/);
  await expect(commitsView(page).getByRole('heading', { level: 1 }), 'Back returns to the same history').toContainText(project);
  await expect(reviewView(page)).toHaveCount(0);
  await back(page);
  await expect(page).not.toHaveURL(/#(commits|review)$/);
  await onSession(page, cc, 'Back from the history');

  // Invariant: a view opened from another replaces it, and Back returns to the one it replaced.
  await next.openSettings(page);
  await expect(next.settingsView(page)).toBeVisible();
  await openHistory(page, project, null);
  await expect(next.settingsView(page), 'the history replaced Settings').toHaveCount(0);
  await back(page);
  await expect(page).toHaveURL(/#settings$/);
  await expect(next.settingsView(page)).toBeVisible();
  await expect(commitsView(page)).toHaveCount(0);
  await next.leaveSettings(page);
  await onSession(page, cc, 'Back from Settings');
}

export async function backAfterBrowserBackFlow({ page, cc }: Args): Promise<void> {
  const project = `deep-${test.info().project.name}`;
  await createProject(cc, project);
  await page.goto('/next/#settings');
  await expect(next.settingsView(page)).toBeVisible();
  await openHistory(page, project, null);
  await page.goBack();
  await expect(next.settingsView(page), 'positive control: the browser\'s Back returned to Settings').toBeVisible();
  await expect(page).toHaveURL(/\/next\/#settings$/);

  // Invariant: Back from an entry the app did not push lands on the app's session anchor, never off the app.
  await back(page);
  await expect(page, 'Back stays in the app').toHaveURL(new RegExp(`^${escapeRe(cc.url)}/next/`));
  await expect(page).not.toHaveURL(/#settings$/);
  await expect(next.settingsView(page)).toHaveCount(0);
}

export async function costsForwardFlow({ page, cc }: Args): Promise<void> {
  const { sessionId } = await spawnSession(cc, `costs-${test.info().project.name}`);
  const anchored = new RegExp(`#session=${sessionId}$`);
  await page.goto(`/next/#session=${sessionId}`);
  await expect(next.sessionHeader(page), 'fixture check: the session opened').toBeVisible();
  await expect(page).toHaveURL(anchored);

  await next.openSidebar(page);
  await page.getByRole('button', { name: 'Project actions' }).filter({ visible: true }).first().click();
  await page.getByRole('menuitem', { name: /Costs/ }).click();
  await expect(page).toHaveURL(/#costs$/);
  await expect(costsView(page)).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(anchored);
  await expect(next.sessionHeader(page), 'Back returns to the session').toBeVisible();
  await expect(costsView(page)).toHaveCount(0);

  // Invariant: a popstate onto a full-page view shows it and leaves the URL naming it.
  await page.goForward();
  await expect(page).toHaveURL(/#costs$/);
  await expect(costsView(page), 'Forward shows the cost dashboard again').toBeVisible();
  await expect(page, 'the URL still names the dashboard').toHaveURL(/#costs$/);

  // Invariant: it never deselected the session.
  await page.goBack();
  await expect(page).toHaveURL(anchored);
  await expect(next.sessionHeader(page), 'the session is still selected').toBeVisible();
  await expect(next.resumeButton(page), 'the session was never dropped').toHaveCount(0);
}
