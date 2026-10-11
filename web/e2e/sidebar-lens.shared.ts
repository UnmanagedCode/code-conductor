// The sidebar's lenses under /next/: each shows only its own lists and they are reachable; the Projects
// lens's controls fit the column. The bodies are shared by the per-project spec files.
import type { Page } from '@playwright/test';
import { test, expect } from './harness/fixtures.ts';
import { spawnSession } from './harness/api.ts';
import { next, nextSidebar } from './parity/ui.ts';

type Ctx = { page: Page; cc: Parameters<typeof spawnSession>[0] };

async function reachable(page: Page, target: ReturnType<Page['locator']>) {
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeVisible();
  await expect(target).toBeInViewport();
}

// Invariant: only the chosen lens's lists are present, and they are reachable.
export async function lensListsFlow({ page, cc }: Ctx): Promise<void> {
  const project = `e2e-lens-${test.info().project.name}`;
  await spawnSession(cc, project);
  await page.goto('/next/');

  await next.lens(page, 'projects');
  const sb = nextSidebar(page);
  await reachable(page, sb.locator(`[data-project-row="${project}"]`));
  await expect(sb.locator('[data-conductor-list], [data-conductors-empty]')).toHaveCount(0);

  await next.lens(page, 'conductors');
  await reachable(page, sb.locator('[data-conductor-list], [data-conductors-empty]'));
  await expect(sb.locator('[data-project-row]')).toHaveCount(0);
  await expect(sb.locator('[data-filter]')).toHaveCount(0);
}

// Invariant: both Projects-lens controls are reachable and the column does not overflow sideways.
export async function lensControlsFitFlow({ page, cc }: Ctx): Promise<void> {
  await spawnSession(cc, `e2e-lens-fit-${test.info().project.name}`);
  await page.goto('/next/');
  await next.lens(page, 'projects');
  const sb = nextSidebar(page);
  const filter = sb.getByRole('combobox', { name: 'Filter by conductor' });
  const menu = sb.getByRole('button', { name: 'Project actions' });
  await reachable(page, filter);
  await reachable(page, menu);

  // Neither control pushes the column sideways, and both sit inside it. Every element is resolved from the
  // visible sidebar: on a drawer viewport the desktop column is also in the DOM, with all-zero rects.
  const fit = await sb.first().evaluate((root) => {
    const col = root.getBoundingClientRect();
    const body = root.querySelector('[data-sidebar-body]') as HTMLElement;
    const rectOf = (sel: string) => root.querySelector(sel)!.getBoundingClientRect();
    const filter = rectOf('[data-filter] [role="combobox"]');
    const menu = rectOf('button[aria-label="Project actions"]');
    const inside = (r: DOMRect) => r.left >= col.left - 1 && r.right <= col.right + 1;
    return {
      measured: [col, filter, menu].every((r) => r.width > 0 && r.height > 0),
      bodyOverflow: body.scrollWidth - body.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      filterInside: inside(filter),
      menuInside: inside(menu),
    };
  });
  expect(fit.measured, 'the measured rects are real, not a hidden copy\'s zeros').toBe(true);
  expect(fit.bodyOverflow).toBeLessThanOrEqual(0);
  expect(fit.pageOverflow).toBeLessThanOrEqual(0);
  expect(fit.filterInside).toBe(true);
  expect(fit.menuInside).toBe(true);
}
