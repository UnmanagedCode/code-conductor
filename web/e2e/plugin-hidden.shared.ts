// A plugin view that is not the current view must not be visible and must not catch the pointer, whichever
// way it was left. The body is shared by the per-project spec files.
import type { Page } from '@playwright/test';
import { test, expect } from './harness/fixtures.ts';
import { installFakePlugin, spawnSession } from './harness/api.ts';
import { next } from './flows/ui.ts';

type Ctx = { page: Page; cc: Parameters<typeof installFakePlugin>[0] & Parameters<typeof spawnSession>[0] };

// Invariant: a plugin view that is not current is not visible and nothing in it sits under the pointer.
export async function hiddenPluginFlow({ page, cc }: Ctx): Promise<void> {
  await installFakePlugin(cc, 'fake-plugin');
  const { sessionId } = await spawnSession(cc, `e2e-hidden-${test.info().project.name}`);
  await page.goto(`/next/#session=${sessionId}`);
  await expect(page.locator('#composer-input')).toBeEnabled();
  const view = page.locator('[data-view="plugin"]');
  await expect(view).toBeHidden();

  await next.openPlugin(page, 'fake-plugin');
  await expect(view).toBeVisible();

  await next.leavePlugin(page);
  await expect(view).toBeHidden();
  expect(await view.boundingBox()).toBeNull();
  // Nothing at the centre of the page belongs to the hidden plugin view, so a press there reaches the session.
  const owner = await page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return { inPlugin: !!el?.closest('[data-view="plugin"]'), tag: el?.tagName ?? null };
  });
  expect(owner.inPlugin).toBe(false);
  expect(owner.tag).not.toBeNull();
  await expect(page.locator('#composer-input')).toBeEnabled();
}
