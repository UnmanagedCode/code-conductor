// The sidebar's lenses: each shows only its own lists and they are reachable; the Projects
// lens's controls fit the column. The bodies are shared by the per-project spec files.
import type { Page } from '@playwright/test';
import { test, expect } from './harness/fixtures.ts';
import { spawnSession } from './harness/api.ts';
import { next, nextSidebar } from './flows/ui.ts';

/** The sidebar's width key (SIDEBAR_WIDTH_STORAGE_KEY, web/src/features/sidebar/derive.ts) and its narrowest clamp (SIDEBAR_MIN_WIDTH). */
const SIDEBAR_KEY = 'code-conductor:sidebar-width';
const SIDEBAR_MIN = 220;
const LONG_OWNER = 'e2e-owner-with-a-very-long-conductor-title-that-cannot-fit-the-row';

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
  await page.goto('/');

  await next.lens(page, 'projects');
  const sb = nextSidebar(page);
  await reachable(page, sb.locator(`[data-project-row="${project}"]`));
  await expect(sb.locator('[data-conductor-list], [data-conductors-empty]')).toHaveCount(0);

  await next.lens(page, 'conductors');
  await reachable(page, sb.locator('[data-conductor-list], [data-conductors-empty]'));
  await expect(sb.locator('[data-project-row]')).toHaveCount(0);
  await expect(sb.locator('[data-filter]')).toHaveCount(0);
  await expect(sb.locator('[data-filter-row]')).toHaveCount(0);
}

// Invariant: both Projects-lens controls are reachable and the column does not overflow sideways.
export async function lensControlsFitFlow({ page, cc }: Ctx): Promise<void> {
  await spawnSession(cc, `e2e-lens-fit-${test.info().project.name}`);
  await page.goto('/');
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

// Invariant: the filter row (input, clear button, scope trigger) stays one line inside the column at the
// narrowest sidebar width, with a typed query and a long conductor scope label, and overlaps nothing.
export async function filterRowFitsFlow({ page, cc }: Ctx): Promise<void> {
  const project = `e2e-lens-row-${test.info().project.name}`;
  const real = await spawnSession(cc, project);
  // An owner with a long label, from clones of the real session in the page's instance list.
  await page.route('**/api/instances', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const list = (await res.json()) as Record<string, unknown>[];
    const base = list.find((i) => i.id === real.id);
    if (base) {
      list.push({ ...base, id: `${real.id}-owner`, sessionId: 'e2e-owner', title: LONG_OWNER, ownerSessionId: null });
      list.push({ ...base, id: `${real.id}-worker`, sessionId: 'e2e-worker', title: 'worker', conducted: true, ownerSessionId: 'e2e-owner' });
    }
    await route.fulfill({ response: res, json: list });
  });
  if (test.info().project.name === 'desktop') {
    await page.addInitScript(([key, width]) => localStorage.setItem(key, width), [SIDEBAR_KEY, String(SIDEBAR_MIN)]);
  }
  await page.goto('/');
  await next.lens(page, 'projects');
  const sb = nextSidebar(page);
  const measure = () => sb.first().evaluate((root) => {
    const rect = (sel: string) => root.querySelector(sel)?.getBoundingClientRect() ?? null;
    const row = root.querySelector('[data-filter-row]') as HTMLElement;
    const body = root.querySelector('[data-sidebar-body]') as HTMLElement;
    const col = root.getBoundingClientRect();
    return {
      col, row: row.getBoundingClientRect(), scroll: row.scrollWidth - row.clientWidth,
      input: rect('[data-filter-input]'), clear: rect('button[aria-label="Clear filter"]'), trigger: rect('[data-filter] [role="combobox"]'),
      bodyOverflow: body.scrollWidth - body.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  const empty = await measure();
  await expect(sb.getByRole('combobox', { name: 'Filter by conductor' })).toBeVisible();
  await next.filterTo(page, 'e2e-owner', LONG_OWNER);
  await sb.getByRole('textbox', { name: 'Filter projects' }).fill('some query');
  // Scoped to the row: the empty state, which this query also shows, has a button of the same name.
  await expect(sb.locator('[data-filter-row]').getByRole('button', { name: 'Clear filter' })).toBeVisible();
  const m = await measure();
  const parts = [m.col, m.row, m.input, m.clear, m.trigger];
  expect(parts.every((r) => r && r.width > 0 && r.height > 0), 'fixture check: every measured rect is real').toBe(true);
  const [col, row, input, clear, trigger] = parts as DOMRect[];
  for (const [name, r] of [['input', input], ['clear', clear], ['trigger', trigger]] as const) {
    expect(r.top, `${name} starts within the row`).toBeGreaterThanOrEqual(row.top - 0.5);
    expect(r.bottom, `${name} ends within the row`).toBeLessThanOrEqual(row.bottom + 0.5);
    expect(r.left, `${name} is inside the column`).toBeGreaterThanOrEqual(col.left - 1);
    expect(r.right, `${name} is inside the column`).toBeLessThanOrEqual(col.right + 1);
  }
  expect(row.height, 'the row stays one line').toBeLessThanOrEqual(empty.row.height + 0.5);
  expect(input.right, 'the input ends before the clear button').toBeLessThanOrEqual(clear.left + 0.5);
  expect(clear.right, 'the clear button ends before the trigger').toBeLessThanOrEqual(trigger.left + 0.5);
  expect(m.scroll, 'the row does not scroll sideways').toBeLessThanOrEqual(0);
  expect(m.bodyOverflow).toBeLessThanOrEqual(0);
  expect(m.pageOverflow).toBeLessThanOrEqual(0);
}
