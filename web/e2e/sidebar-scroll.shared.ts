// Which part of the sidebar scrolls, in a real browser: the list alone, with the needs-you strip, the lens
// tabs and the Projects filter row keeping their boxes; and a tall strip bounded, scrolling within itself,
// the list keeping a usable height. The bodies are shared by the per-project spec files.
import type { Locator, Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { api, createProject } from './harness/api.ts';
import { idleInst, liveModel } from './flows/fleet.ts';
import { next, nextSidebar } from './flows/ui.ts';
import { scrollOver } from './bubble-scroll.shared.ts';

type Ctx = { page: Page; cc: Cc };

const P = () => test.info().project.name;
const FILLERS = 30;
/** Clones of the real session appended to the instance list, to make the strip tall. */
const CLONES = 24;
/** A landscape phone's height. */
const SHORT = 420;

const fillers = (p: string, n: number) => Array.from({ length: n }, (_, i) => `ss-fill-${String(i).padStart(2, '0')}-${p}`);

/** Waits out every finite animation and transition; a live dot's endless pulse never finishes, and a cancelled one rejects. */
const settled = (page: Page) => page.locator('body').evaluate((el) => Promise.all(el.getAnimations({ subtree: true })
  .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
/** Two frames, so a scroll has been laid out. */
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

const box = async (loc: Locator, name: string) => {
  const b = await loc.boundingBox();
  expect(b, `${name} has a box`).not.toBeNull();
  expect(b!.height, `${name} has a height`).toBeGreaterThan(0);
  expect(b!.width, `${name} has a width`).toBeGreaterThan(0);
  return b!;
};
const near = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  [a.x - b.x, a.y - b.y, a.width - b.width, a.height - b.height].every((d) => Math.abs(d) <= 0.5);

/** Opens the Projects lens and waits out the drawer's slide-in; returns the visible sidebar. */
async function openProjects(page: Page): Promise<Locator> {
  await next.lens(page, 'projects');
  const root = nextSidebar(page);
  await settled(page);
  return root;
}

/** A real hand session in `project`, idle (it lands in the strip's Finished group). */
async function handSession(cc: Cc, project: string) {
  await createProject(cc, project);
  const r = await api(cc, 'POST', '/api/instances', { project, mode: 'bypassPermissions', temp: false, ...liveModel(cc) });
  expect(r.status, `POST /api/instances (hand): ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return idleInst(cc, (i) => i.id === r.body.id, 'hand-spawned session idle');
}

// Invariant: scrolling the list moves the list only; the strip, the tab bar and the filter row keep their boxes.
export async function onlyListScrollsFlow({ page, cc }: Ctx): Promise<void> {
  test.setTimeout(180_000);
  const p = P();
  const names = fillers(p, FILLERS);
  const sessProject = `ss-sess-${p}`;
  try {
    for (const name of names) await createProject(cc, name);
    await handSession(cc, sessProject);
    await page.goto('/');
    const root = await openProjects(page);
    const body = root.locator('[data-sidebar-body]');
    const strip = root.locator('[data-strip]');
    const tabs = root.getByRole('tablist');
    const filter = root.locator('[data-filter]');
    await expect(strip.locator('[data-strip-entry]'), 'fixture check: the strip has the session').toHaveCount(1);
    const m = await body.evaluate((e) => ({ scroll: e.scrollHeight, client: e.clientHeight, top: e.scrollTop }));
    expect(m.scroll, `fixture check: the list overflows its body ${JSON.stringify(m)}`).toBeGreaterThan(m.client);
    expect(m.top, 'fixture check: the body starts at its top').toBe(0);

    const before = { strip: await box(strip, 'strip'), tabs: await box(tabs, 'tabs'), filter: await box(filter, 'filter') };
    const row = root.locator(`[data-project-row="${names[0]}"]`);
    const rowTop = (await box(row, 'first filler row')).y;
    await scrollOver(page, body, 300);
    await frames(page);

    await expect.poll(() => body.evaluate((e) => e.scrollTop), { message: 'positive control: the body scrolled' }).toBeGreaterThan(0);
    expect((await box(row, 'first filler row')).y, 'positive control: the list moved up').toBeLessThan(rowTop);

    expect(near(await box(strip, 'strip'), before.strip), 'the strip keeps its box').toBe(true);
    expect(near(await box(tabs, 'tabs'), before.tabs), 'the tab bar keeps its box').toBe(true);
    expect(near(await box(filter, 'filter'), before.filter), 'the filter row keeps its box').toBe(true);
    const bodyTop = (await box(body, 'body')).y;
    expect(bodyTop, 'the list starts below the chrome').toBeGreaterThanOrEqual(before.filter.y + before.filter.height - 0.5);
  } finally {
    for (const name of [...names, sessProject]) await api(cc, 'DELETE', `/api/projects/${name}`, { deleteDirectory: true });
  }
}

// Invariant: a tall strip is bounded and scrolls within itself, and the list keeps a usable height, short viewports included.
export async function tallStripFlow({ page, cc }: Ctx): Promise<void> {
  test.setTimeout(180_000);
  const p = P();
  const names = fillers(p, 10);
  const sessProject = `ss-sess-${p}`;
  try {
    for (const name of names) await createProject(cc, name);
    const h = await handSession(cc, sessProject);
    // The strip is made tall with clones of the real session in the page's instance list, not 24 more fake CLIs.
    await page.route('**/api/instances', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const list = (await res.json()) as Record<string, unknown>[];
      const real = list.find((i) => i.id === h.id);
      if (real) {
        for (let n = 0; n < CLONES; n++) {
          const k = String(n).padStart(2, '0');
          list.push({ ...real, id: `${h.id}-clone-${k}`, sessionId: `${h.sessionId}-clone-${k}`, title: `ss clone ${k} ${p}` });
        }
      }
      await route.fulfill({ response: res, json: list });
    });
    await page.goto('/');

    const arms = async () => {
      const root = await openProjects(page);
      const body = root.locator('[data-sidebar-body]');
      const strip = root.locator('[data-strip]');
      const tabs = root.getByRole('tablist');
      const vh = await page.evaluate(() => window.innerHeight);
      await expect(strip.locator('[data-strip-entry]'), 'fixture check: the strip is tall').toHaveCount(CLONES + 1);
      const m = await strip.evaluate((e) => ({ scroll: e.scrollHeight, client: e.clientHeight }));
      expect(m.scroll, `fixture check: the strip needs a cap ${JSON.stringify(m)} at ${vh}`).toBeGreaterThan(0.4 * vh);

      expect((await box(strip, 'strip')).height, `A: the strip is bounded at ${vh}`).toBeLessThanOrEqual(0.4 * vh);
      expect(await body.evaluate((e) => e.clientHeight), `B: the list keeps a usable height at ${vh}`).toBeGreaterThanOrEqual(0.2 * vh);

      const tabsBefore = await box(tabs, 'tabs');
      expect(m.scroll, `C: the strip overflows its box ${JSON.stringify(m)}`).toBeGreaterThan(m.client);
      await scrollOver(page, strip, 200);
      await frames(page);
      await expect.poll(() => strip.evaluate((e) => e.scrollTop), { message: `C: the strip scrolled at ${vh}` }).toBeGreaterThan(0);
      expect(near(await box(tabs, 'tabs'), tabsBefore), 'C: the tab bar keeps its box').toBe(true);
    };
    await arms();
    const { width } = page.viewportSize()!;
    await page.setViewportSize({ width, height: SHORT });
    await arms();
  } finally {
    for (const name of [...names, sessProject]) await api(cc, 'DELETE', `/api/projects/${name}`, { deleteDirectory: true });
  }
}
