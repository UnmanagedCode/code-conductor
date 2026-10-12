// The Android shell's history behaviours, in both UIs: Back from a worker the
// workers panel opened, and a notification click delivered the way the
// installed app receives it (its service worker posts to the page). A file of
// its own with its own cc: the live conductors it seeds would otherwise leak
// into the other parity files' Conductors-lens scenarios.
import type { Page } from '@playwright/test';
import { api, createProject, spawnSession } from '../harness/api.ts';
import { expect, test, type Cc } from '../harness/fixtures.ts';
import { spawnConductor, spawnWorker, type FleetInst } from './fleet.ts';
import { parity } from './parity.ts';
import type { Ui } from './ui.ts';

test.use({ ccOptions: { server: 'android-shell' } });

/** A live conductor, titled, with one worker titled `title`. */
async function conductorWithWorker(cc: Cc, project: string, title: string): Promise<{ conductor: FleetInst; worker: FleetInst }> {
  await api(cc, 'POST', '/api/projects/.conduct/ensure');
  const conductor = await spawnConductor(cc, true);
  await createProject(cc, project);
  const worker = await spawnWorker(cc, conductor.id, { project });
  await api(cc, 'PUT', `/api/sessions/${worker.sessionId}/title`, { title });
  return { conductor, worker };
}

/** The page's history length: one entry per push. */
const entries = (page: Page) => page.evaluate(() => history.length);

/** Waits until the main pane shows session `sid` and the URL names it. */
async function showing(page: Page, ui: Ui, sid: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`#session=${sid}$`));
  await expect(ui.sessionHeader(page).locator(`[title="session ${sid}"]`)).toBeVisible();
}

type ClientList = { clients: { matchAll(o: { type: 'window'; includeUncontrolled: boolean }): Promise<{ postMessage(m: unknown): void }[]> } };

/** A notification click as the installed app gets it: the page's service worker posts `cc-notification-click` to it. */
async function notificationClick(page: Page, data: { instanceId: string; sessionId: string }): Promise<void> {
  await expect.poll(async () => {
    let posted = 0;
    for (const sw of page.context().serviceWorkers()) {
      posted += await sw.evaluate(async (d) => {
        const windows = await (self as unknown as ClientList).clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const w of windows) w.postMessage({ type: 'cc-notification-click', ...d });
        return windows.length;
      }, data);
    }
    return posted;
  }, { message: 'a service worker posted the click to the page' }).toBe(1);
}

parity('doc/back-button', 'Back from a worker opened from the workers panel returns to its conductor, and Forward to the worker again', async ({ page, cc, ui, uniq }) => {
  const title = uniq('Fix the parser');
  const { conductor, worker } = await conductorWithWorker(cc, uniq('bk'), title);
  await ui.open(page);
  await ui.openConductor(page, conductor.sessionId);
  await showing(page, ui, conductor.sessionId);
  const before = await entries(page);
  await ui.openWorker(page, title);
  await showing(page, ui, worker.sessionId);
  // The workers panel leaves the conductor's entry behind.
  expect(await entries(page)).toBe(before + 1);
  await page.goBack();
  await showing(page, ui, conductor.sessionId);
  await expect(ui.workersPanel(page)).toBeVisible();
  await page.goForward();
  await showing(page, ui, worker.sessionId);
});

parity('notification-click/R2', 'a notification click opens its session in place, adding no history entry: Back then returns past it to the conductor', async ({ page, cc, ui, uniq }) => {
  const title = uniq('Fix the lexer');
  const { conductor, worker } = await conductorWithWorker(cc, uniq('nc'), title);
  const pinged = await spawnSession(cc, uniq('nc'));
  await ui.open(page);
  await ui.openConductor(page, conductor.sessionId);
  await showing(page, ui, conductor.sessionId);
  const before = await entries(page);
  await ui.openWorker(page, title);
  await showing(page, ui, worker.sessionId);
  // Positive control: this page's history does count a push.
  expect(await entries(page)).toBe(before + 1);
  await notificationClick(page, { instanceId: pinged.id, sessionId: pinged.sessionId });
  await showing(page, ui, pinged.sessionId);
  expect(await entries(page)).toBe(before + 1);
  // The click replaced the worker's entry, so Back skips the worker.
  await page.goBack();
  await showing(page, ui, conductor.sessionId);
});
