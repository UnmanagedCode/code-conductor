// The composer's per-session drafts under /next/: a draft follows its session through sidebar
// switches byte for byte and survives a reload, and text typed just before leaving the session view
// survives the page closing before its debounced save was due. The body is shared by the
// per-project spec files.
import type { Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { spawnSession } from './harness/api.ts';
import { next } from './flows/ui.ts';

type Session = { project: string; sessionId: string };

const label = (what: string) => `drafts-${what}-${test.info().project.name}`;

async function startSession(cc: Cc, what: string): Promise<Session> {
  const project = label(what);
  const { sessionId } = await spawnSession(cc, project);
  return { project, sessionId };
}

/** Selects a session from the sidebar once its row is live, then waits for its composer. */
async function select(page: Page, s: Session): Promise<void> {
  const row = await next.sessionRow(page, s.project, s.sessionId);
  await expect.poll(() => next.sessionRowLive(row), { message: `${s.project}: the row is live` }).toBe(true);
  await row.click();
  await expect(next.composer(page)).toBeEnabled();
}

/**
 * Stops the page's clock (installed before the page loaded), so a draft typed next keeps its
 * debounced save pending until the page goes away. A reload installs a paused clock again; resume
 * it once the new page has loaded.
 */
async function freezeTimers(page: Page): Promise<void> {
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
}

export async function draftsFollowSessionFlow({ page, cc }: { page: Page; cc: Cc }): Promise<void> {
  const a = await startSession(cc, 'follow-a');
  const b = await startSession(cc, 'follow-b');
  await page.clock.install();
  await next.open(page);
  const box = next.composer(page);

  await select(page, a);
  await box.fill('alpha draft\n  two lines  ');
  await select(page, b);
  await expect(box, "B does not show A's draft").toHaveValue('');
  await box.fill('bravo');
  await select(page, a);
  await expect(box, "A's draft is back, byte for byte").toHaveValue('alpha draft\n  two lines  ');
  await select(page, b);
  await expect(box, "B's draft is back").toHaveValue('bravo');

  // A reload while the save is still pending: the page going away writes it.
  await freezeTimers(page);
  await box.fill('bravo, edited');
  await page.reload();
  await page.clock.resume();
  await expect(box, 'the reload restores the draft typed just before it').toHaveValue('bravo, edited');
  await select(page, a);
  await expect(box, "A's draft survived the reload too").toHaveValue('alpha draft\n  two lines  ');
}

export async function leaveSessionViewFlow({ page, cc }: { page: Page; cc: Cc }): Promise<void> {
  const a = await startSession(cc, 'leave-a');
  await page.clock.install();
  await next.open(page);
  const box = next.composer(page);
  await select(page, a);

  await freezeTimers(page);
  await box.fill('older text');
  await page.reload();
  await page.clock.resume();
  await expect(box, 'positive control: a reload in the session keeps a draft whose save was pending').toHaveValue('older text');

  await freezeTimers(page);
  await box.fill('typed, then left');
  await next.openSettings(page);
  await page.reload();
  await page.clock.resume();
  await next.leaveSettings(page);
  await select(page, a);
  await expect(box, 'text typed just before leaving the session view survives the page closing').toHaveValue('typed, then left');
}
