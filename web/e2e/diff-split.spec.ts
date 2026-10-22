// The review view's split (side-by-side) diff on a real cc: rows stay aligned while long lines wrap
// inside their half, and below md the toggle is gone and a stored split renders unified.
import type { Page } from '@playwright/test';
import { test, expect } from './harness/fixtures.ts';
import { createProject } from './harness/api.ts';
import { next } from './flows/ui.ts';
import { openHistory, commitsView } from './commits-actions.shared.ts';

// Its own cc: the spec seeds projects.
test.use({ ccOptions: { server: 'diff-split' } });

const ln = (type: string, content: string) => ({ type, content });
const LONG = 'x'.repeat(600);
const HUNKS = [{
  header: '@@ -10,7 +20,5 @@',
  lines: [ln('ctx', 'before'), ln('del', LONG), ln('add', 'short'), ln('del', 'p'), ln('del', 'q'), ln('del', 'r'), ln('add', 'P'), ln('ctx', 'after')],
}];

/** Opens the first commit's review with every diff answered from the fixture (the network boundary; the real module runs). */
async function openReviewWithFixture(page: Page, project: string): Promise<void> {
  await next.open(page);
  await openHistory(page, project, null);
  await page.route(/\/diff(\?|$)/, (route) => {
    const body = route.request().url().includes('path=')
      ? { file: { hunks: HUNKS, adds: 2, dels: 4 } }
      : { files: [{ path: 'long.ts', status: 'modified', adds: 2, dels: 4 }], totalFiles: 1 };
    return route.fulfill({ json: body });
  });
  await commitsView(page).locator('[data-commit-row]:not([data-commit-row="uncommitted"])').first().click();
  await expect(page).toHaveURL(/#review$/);
  await page.locator('[data-review-file="long.ts"] button').first().click();
  await expect(page.locator('[data-hunk-header]')).toBeVisible();
}

test('split columns stay aligned row for row, wrap long lines inside their half, and the hunk header spans both', async ({ page, cc }) => {
  // Invariant: in split mode the old and new cells of a row share a top and a height however a line wraps, the halves are equal, nothing scrolls sideways, and the header spans both columns.
  test.skip(test.info().project.name !== 'desktop', 'the alignment sweep needs the wide layout');
  const project = `diff-split-${test.info().project.name}`;
  await createProject(cc, project);
  await openReviewWithFixture(page, project);
  await page.getByRole('button', { name: 'Split view' }).click();
  const split = page.locator('[data-diff-mode="split"]');
  await expect(split).toBeVisible();

  const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
  const rows = page.locator('[data-split-row]');
  const count = await rows.count();
  expect(count).toBe(6);
  const heights: number[] = [];
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const o = (await row.locator('[data-split-cell="old"]').boundingBox())!;
    const n = (await row.locator('[data-split-cell="new"]').boundingBox())!;
    const nn = (await row.locator('[data-line-num="new"]').boundingBox())!;
    expect(Math.abs(o.y - n.y), `row ${i}: same top`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(o.height - n.height), `row ${i}: same height`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(o.width - n.width), `row ${i}: equal halves`).toBeLessThanOrEqual(1);
    expect(o.x + o.width, `row ${i}: old text ends before the new numbers`).toBeLessThanOrEqual(nn.x + 0.5);
    heights.push(o.height);
  }
  expect(heights[1], 'the 600-char line wraps').toBeGreaterThan(heights[0] * 2);

  const overflow = await split.evaluate((el) => {
    let pane: HTMLElement | null = el.parentElement;
    while (pane && !/(auto|scroll)/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement;
    return { split: el.scrollWidth - el.clientWidth, pane: pane ? pane.scrollWidth - pane.clientWidth : null };
  });
  expect(overflow.split, 'the split block does not scroll sideways').toBeLessThanOrEqual(0);
  expect(overflow.pane, 'the view pane does not scroll sideways').not.toBeNull();
  expect(overflow.pane!, 'the view pane does not scroll sideways').toBeLessThanOrEqual(0);

  const header = await box('[data-hunk-header]');
  const left = (await box('[data-line-num="old"]')).x;
  const newText = await box('[data-split-cell="new"]');
  expect(Math.abs(header.x - left), 'header starts at the old numbers').toBeLessThanOrEqual(1);
  expect(Math.abs(header.x + header.width - (newText.x + newText.width)), 'header ends at the new text').toBeLessThanOrEqual(1);
});

test('below md the review has no Split view toggle and a stored split renders the unified, horizontally scrolling diff', async ({ page, cc }) => {
  // Invariant: a phone-width viewport never offers or renders split, whatever is stored.
  test.skip(test.info().project.name === 'desktop', 'the narrow rule is for the phone viewport');
  const project = `diff-split-${test.info().project.name}`;
  await createProject(cc, project);
  await page.addInitScript(() => localStorage.setItem('code-conductor:diff-mode', 'split'));
  await openReviewWithFixture(page, project);
  await expect(page.getByRole('button', { name: 'Split view' })).toHaveCount(0);
  const unified = page.locator('[data-diff-mode="unified"]');
  await expect(unified).toBeVisible();
  await expect(page.locator('[data-diff-mode="split"]')).toHaveCount(0);
  expect(await unified.evaluate((el) => el.scrollWidth - el.clientWidth), 'the unified block scrolls sideways').toBeGreaterThan(0);
});
