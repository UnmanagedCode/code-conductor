// A text field on a touch screen is at least 16px, or iOS zooms the page into it on focus. Chromium never zooms,
// so the check is the computed font-size, at the project's viewport and at a landscape width past the md
// breakpoint (where a bare `md:text-sm` would win over `text-base`). The shell follows the visual viewport only
// under a soft keyboard, which Chromium has none of: the follower must stay idle. This module declares no tests.
import type { Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { createProject, spawnSession, LIVE_WORKER_MODEL } from './harness/api.ts';
import { next } from './flows/ui.ts';

// App.tsx's root element (TooltipProvider renders no DOM of its own); page-scroll.shared.ts measures the same box.
const SHELL = '#root > div:first-child';
const MIN_FONT_PX = 16;
const LANDSCAPE = { width: 932, height: 430 };

const fontPx = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

async function expectCoarse(page: Page): Promise<void> {
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  expect(coarse, 'the project emulates a coarse pointer').toBe(true);
}

export async function touchFieldsFlow({ page, cc }: { page: Page; cc: Cc }): Promise<void> {
  const project = `touch-fields-${test.info().project.name}`;
  await createProject(cc, project);
  const { sessionId } = await spawnSession(cc, project, { model: LIVE_WORKER_MODEL });
  const own = page.viewportSize()!;

  await page.goto(`/#session=${sessionId}`);
  await expectCoarse(page);
  await expect(page.locator('#composer-input')).toBeEnabled();

  for (const size of [own, LANDSCAPE]) {
    await page.setViewportSize(size);
    expect(await fontPx(page, '#composer-input'), `composer font at ${size.width}x${size.height}`).toBeGreaterThanOrEqual(MIN_FONT_PX);
  }

  // The drawer helper keys on the project's viewport, so the dialog opens at the device size and is resized while open.
  await page.setViewportSize(own);
  const dialog = await next.openPlacementDialog(page, 'adopt');
  const path = next.placementField(dialog, 'adopt', 'path');
  for (const size of [own, LANDSCAPE]) {
    await page.setViewportSize(size);
    expect(await path.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)), `directory field font at ${size.width}x${size.height}`).toBeGreaterThanOrEqual(MIN_FONT_PX);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.setViewportSize(own);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--app-height'))).toBe('');
}

/** The shell sizes itself from --app-height: App.tsx's root element, the one page-scroll measures. */
export async function shellFollowsAppHeightFlow({ page, cc }: { page: Page; cc: Cc }): Promise<void> {
  const project = `touch-shell-${test.info().project.name}`;
  await createProject(cc, project);
  const { sessionId } = await spawnSession(cc, project, { model: LIVE_WORKER_MODEL });
  await page.goto(`/#session=${sessionId}`);
  await expect(page.locator('#composer-input')).toBeEnabled();
  const shellHeight = () => page.locator(SHELL).evaluate((el) => el.getBoundingClientRect().height);
  const innerHeight = await page.evaluate(() => window.innerHeight);
  await page.evaluate(() => document.documentElement.style.setProperty('--app-height', '400px'));
  await expect.poll(shellHeight).toBeCloseTo(400, 0);
  await page.evaluate(() => document.documentElement.style.removeProperty('--app-height'));
  await expect.poll(shellHeight).toBeCloseTo(innerHeight, 0);
}
