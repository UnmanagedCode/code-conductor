// The composer's context chip: a chip a plugin backend puts on a session through
// `PUT /api/sessions/:sid/chip` shows live on every page viewing that session, the data is one hover
// (desktop) or tap (phone, android) away, × clears it on every page, and Send carries it into the
// message — a chip row in the sent bubble — and consumes it. The body is shared by the per-project
// spec files.
import type { Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { spawnSession, setChip } from './harness/api.ts';
import { next } from './flows/ui.ts';

const chipOn = (page: Page) => page.locator('[data-context-chip]');
const remove = (page: Page) => page.locator('[data-context-chip-remove]');

async function openSession(page: Page, sessionId: string): Promise<void> {
  await page.goto(`/#session=${sessionId}`);
  await expect(next.composer(page)).toBeEnabled();
}

export async function chipFlow({ page, cc }: { page: Page; cc: Cc }): Promise<void> {
  const { sessionId } = await spawnSession(cc, `e2e-chip-${test.info().project.name}`);
  await openSession(page, sessionId);
  const second = await page.context().newPage();
  try {
    await openSession(second, sessionId);

    // Set through the API: both pages show it live.
    const put = await setChip(cc, sessionId, 'main.ts · 3 lines', 'const a = 1;\nconst b = 2;\nconst c = 3;');
    expect(put.status).toBe(200);
    await expect(chipOn(page)).toContainText('main.ts · 3 lines');
    await expect(chipOn(second)).toContainText('main.ts · 3 lines');

    // The data: a hover on desktop, a tap on a touch project.
    const trigger = chipOn(page).locator('button').first();
    if (test.info().project.name === 'desktop') await trigger.hover(); else await trigger.tap();
    await expect(page.getByRole('tooltip')).toContainText('const b = 2;');
    await test.info().attach('chip-composer', { body: await page.screenshot(), contentType: 'image/png' });

    // × clears it on both pages.
    await remove(page).click();
    await expect(chipOn(page)).toHaveCount(0);
    await expect(chipOn(second)).toHaveCount(0);

    // A new chip, then Send with text: the bubble leads with a chip row, the typed text follows, and the chip is consumed everywhere.
    await setChip(cc, sessionId, 'selection', 'SELECTED-DATA');
    await expect(chipOn(page)).toContainText('selection');
    await expect(chipOn(second)).toContainText('selection');
    await next.sendPrompt(page, 'explain this');
    const bubble = next.lastUserMessage(page);
    await expect(bubble.locator('[data-user-context-chip]')).toContainText('selection');
    await expect(bubble.locator('[data-user-text]')).toContainText('explain this');
    await expect(bubble.locator('[data-user-text]')).not.toContainText('SELECTED-DATA');
    await expect(chipOn(page)).toHaveCount(0);
    await expect(chipOn(second)).toHaveCount(0);
    await bubble.locator('[data-user-context-chip] [data-fold-trigger]').click();
    await expect(bubble.locator('[data-context-chip-data]')).toHaveText('SELECTED-DATA');
    await test.info().attach('chip-bubble', { body: await page.screenshot(), contentType: 'image/png' });
  } finally {
    await second.close();
  }
}

export async function longTitleFlow({ page, cc }: { page: Page; cc: Cc }): Promise<void> {
  const { sessionId } = await spawnSession(cc, `e2e-chip-long-${test.info().project.name}`);
  await openSession(page, sessionId);
  // Long, but within the title cap the route enforces.
  expect((await setChip(cc, sessionId, 'a very long selection title '.repeat(6).trim(), 'data')).status).toBe(200);
  const chip = chipOn(page);
  await expect(chip).toBeVisible();
  const composer = page.locator('[data-composer]');
  const [c, box] = await Promise.all([chip.boundingBox(), composer.boundingBox()]);
  // Truncated: the chip stays inside the composer rather than pushing it wider.
  expect(c!.x).toBeGreaterThanOrEqual(box!.x);
  expect(c!.x + c!.width).toBeLessThanOrEqual(box!.x + box!.width + 0.5);
  // The × sits inside the chip and is the element hit at its centre.
  const x = await remove(page).boundingBox();
  expect(x!.x + x!.width).toBeLessThanOrEqual(c!.x + c!.width + 0.5);
  const hit = await page.evaluate(({ px, py }) => !!document.elementFromPoint(px, py)?.closest('[data-context-chip-remove]'), { px: x!.x + x!.width / 2, py: x!.y + x!.height / 2 });
  expect(hit, 'the × is hit at its centre').toBe(true);
  await test.info().attach('chip-long-title', { body: await page.screenshot(), contentType: 'image/png' });
}
