// Under prefers-reduced-motion the working indicator stays visible but nothing in it keeps animating.
// getAnimations() is the observable: a looping animation is `running`, a suppressed one has finished.
// The body is shared by the per-project spec files.
import type { Page } from '@playwright/test';
import { test, expect } from './harness/fixtures.ts';
import { api, spawnSession } from './harness/api.ts';
import { next } from './parity/ui.ts';

const running = (page: Page) => page.evaluate(() => {
  const el = document.querySelector('[data-turn-indicator="working"]');
  return (el?.getAnimations({ subtree: true }) ?? []).filter((a) => a.playState === 'running').length;
});

// Invariant: reduced motion stops the indicator animating (against a no-preference control) while it stays visible.
export async function reducedMotionFlow({ page, cc }: { page: Page; cc: Parameters<typeof spawnSession>[0] }): Promise<void> {
  const { id, sessionId } = await spawnSession(cc, `e2e-motion-${test.info().project.name}`);
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(`/next/#session=${sessionId}`);
    await expect(page.locator('#composer-input')).toBeEnabled();
    await next.sendPrompt(page, 'MIDTURN-HOLD keep the turn running');
    const indicator = page.locator('[data-turn-indicator="working"]');
    await expect(indicator).toBeVisible();
    // Control: with no preference the indicator animates, so a zero below is the preference's doing.
    await expect.poll(() => running(page), { message: 'control: the indicator animates' }).toBeGreaterThan(0);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => running(page), { message: 'reduced motion stops it' }).toBe(0);
    await expect(indicator).toBeVisible();
    expect(await indicator.textContent()).toBeTruthy();

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect.poll(() => running(page), { message: 'motion returns' }).toBeGreaterThan(0);
  } finally {
    await api(cc, 'DELETE', `/api/instances/${id}`);
  }
}
