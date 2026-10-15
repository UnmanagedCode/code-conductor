// The Projects lens's workspace tier in a real browser: what happy-dom cannot
// measure (a sticky band's position in the sidebar's scrolling body, its width,
// where its project rows start, a selected row revealed clear of it). The bodies are
// shared by the per-project spec files.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './harness/fixtures.ts';
import { api, createProject, spawnSession } from './harness/api.ts';
import { next, nextSidebar } from './flows/ui.ts';

type Ctx = { page: Page; cc: Parameters<typeof spawnSession>[0] };

const P = () => test.info().project.name;
const tall = (p: string) => `Tall-${p}`;
const tallz = (p: string) => `Tallz-${p}`;
const member = (p: string, n: number) => `st-${p}-${String(n).padStart(2, '0')}`;
const zmember = (p: string, n: number) => `stz-${p}-${String(n).padStart(2, '0')}`;
/** Members per workspace: more than a desktop body's height of rows, so Tallz can reach the top and Tall's last rows scroll above it. */
const MEMBERS = 24;
/** The project holding the session, near the end of `Tall`. */
const SESSION_AT = 20;

/** A workspace's header, the band: the section's first child, as before the band existed, so the geometry checks read red on the old header. */
const band = (root: Locator, name: string) => root.locator(`section[data-workspace="${name}"] > div:first-child`);

/** The session id per Playwright project, set by `seedTiers`. */
const sids = new Map<string, string>();

/**
 * The spec's beforeAll, per Playwright project: workspaces `Tall-<p>` and `Tallz-<p>`
 * with `MEMBERS` projects each, two unassigned projects and one session in `st-<p>-20`.
 */
export async function seedTiers({ cc }: Pick<Ctx, 'cc'>, info: { project: { name: string } }): Promise<void> {
  const p = info.project.name;
  const ok = (r: { status: number; body: unknown }, what: string) => expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  for (let n = 1; n <= MEMBERS; n++) {
    await createProject(cc, member(p, n));
    ok(await api(cc, 'PUT', `/api/projects/${member(p, n)}/workspace`, { workspace: tall(p) }), 'PUT Tall member');
    await createProject(cc, zmember(p, n));
    ok(await api(cc, 'PUT', `/api/projects/${zmember(p, n)}/workspace`, { workspace: tallz(p) }), 'PUT Tallz member');
  }
  await createProject(cc, `su-${p}-a`);
  await createProject(cc, `su-${p}-b`);
  sids.set(p, (await spawnSession(cc, member(p, SESSION_AT))).sessionId);
}

/** Waits out every finite animation and transition; a live dot's endless pulse never finishes, and a cancelled one rejects. */
const settled = (page: Page) => page.locator('body').evaluate((el) => Promise.all(el.getAnimations({ subtree: true })
  .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));

/** Opens both workspaces in the Projects lens and waits out the drawer's slide-in; returns the sidebar and its scrolling body. */
async function openTiers(page: Page): Promise<{ root: Locator; body: Locator }> {
  await next.lens(page, 'projects');
  const root = nextSidebar(page);
  for (const name of [tall(P()), tallz(P())]) {
    const toggle = band(root, name).locator('button[aria-expanded]');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }
  // Measure after the drawer's slide-in and the carets' turn.
  await settled(page);
  return { root, body: root.locator('[data-sidebar-body]') };
}

const box = async (loc: Locator, name: string) => {
  const b = await loc.boundingBox();
  expect(b, `${name} has a box`).not.toBeNull();
  expect(b!.height, `${name} has a height`).toBeGreaterThan(0);
  expect(b!.width, `${name} has a width`).toBeGreaterThan(0);
  return b!;
};
/** Two frames, so a scroll has been laid out. */
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

// Invariant: a workspace band stays at the top of [data-sidebar-body], its scroll container, while its own projects scroll past, and is carried off when its section ends.
/** A workspace band sticks to the sidebar body's top while its projects scroll, and the next band takes over. */
export async function stickyBandFlow({ page }: Ctx): Promise<void> {
  await page.goto('/');
  const { root, body } = await openTiers(page);
  const p = P();
  await root.locator(`[data-project-row="${member(p, 12)}"]`).evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await frames(page);
  const bodyBox = await box(body, 'sidebar body');
  expect(await body.evaluate((e) => e.scrollTop), 'fixture check: the body scrolled').toBeGreaterThan(0);
  const pinned = await box(band(root, tall(p)), 'Tall band');
  expect(Math.abs(pinned.y - bodyBox.y), 'the Tall band sits at the body top').toBeLessThanOrEqual(1);

  await band(root, tallz(p)).evaluate((e) => e.closest('section')!.scrollIntoView({ block: 'start' }));
  await frames(page);
  const next = await box(band(root, tallz(p)), 'Tallz band');
  expect(Math.abs(next.y - bodyBox.y), 'the Tallz band sits at the body top').toBeLessThanOrEqual(1);
  const gone = await band(root, tall(p)).boundingBox();
  expect(gone!.y, 'the Tall band has been carried above the body top').toBeLessThan(bodyBox.y);
  await shoot(page, `sidebar-tiers-sticky-${p}`);
}

// Invariant: a band spans the sidebar body's width, every project row under a band, workspace or Other projects, starts at [data-project-list]'s own left edge, and carries no caret: its folder sits about under the band's caret, left of the layers icon, aligned across rows with and without sessions, and the sessions group nests deeper.
/** A workspace band spans the body; its project rows, and the unassigned ones, start at the project list's left edge. */
export async function bandGeometryFlow({ page }: Ctx): Promise<void> {
  await page.goto('/');
  const { root, body } = await openTiers(page);
  const p = P();
  const bodyBox = await box(body, 'sidebar body');
  const clientWidth = await body.evaluate((e) => e.clientWidth);
  const b = await box(band(root, tall(p)), 'Tall band');
  expect(b.width, 'the band spans the body').toBeGreaterThanOrEqual(clientWidth - 1);
  expect(b.x, 'the band starts at the body left edge').toBeLessThanOrEqual(bodyBox.x + 1);
  const list = await box(root.locator('[data-project-list]'), 'project list');
  const first = await box(root.locator(`[data-project-row="${member(p, 1)}"]`), 'first member row');
  expect(Math.abs(first.x - list.x), 'a member row starts at the list left edge').toBeLessThanOrEqual(0.5);
  const unassigned = await box(root.locator(`[data-project-row="su-${p}-a"]`), 'unassigned row');
  expect(Math.abs(unassigned.x - list.x), 'an unassigned row starts at the list left edge').toBeLessThanOrEqual(0.5);
  const caret = await box(band(root, tall(p)).locator('button[aria-expanded] svg').first(), 'band caret');
  const layers = await box(band(root, tall(p)).locator('[data-workspace-icon]'), 'layers icon');
  const folder = (n: number) => root.locator(`[data-project-row="${member(p, n)}"] svg`).first();
  const bare = await box(folder(1), 'folder of a project without sessions');
  const withSessions = await box(folder(SESSION_AT), 'folder of the project with a session');
  expect(Math.abs(bare.x - withSessions.x), 'folders align with and without sessions').toBeLessThanOrEqual(0.5);
  expect(bare.x - caret.x, 'the folder sits about under the band caret').toBeGreaterThanOrEqual(0);
  expect(bare.x - caret.x, 'the folder sits about under the band caret').toBeLessThanOrEqual(6);
  expect(bare.x, 'the folder is left of the layers icon').toBeLessThan(layers.x);
  await expect(root.locator(`[data-project-row="${member(p, SESSION_AT)}"] > button[aria-expanded]:not([aria-haspopup])`), 'no caret on the row').toHaveCount(0);
  const toggle = root.locator(`[data-project-sessions="${member(p, SESSION_AT)}"] > button`);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect((await box(toggle.locator('svg').first(), 'sessions group caret')).x, 'the sessions group nests under the folder').toBeGreaterThan(withSessions.x);
}

// Invariant: a selected row revealed upward with block 'nearest', as scrollActiveIntoView does, lands below the sticky band. Green before the band existed (nothing covered it); it guards the band's scroll margin on selected rows.
/** A selected row revealed upward lands below the sticky band. */
export async function revealBelowBandFlow({ page }: Ctx): Promise<void> {
  const sid = sids.get(P());
  expect(sid, 'fixture check: the session was spawned').toBeTruthy();
  await page.goto(`/#session=${sid}`);
  await expect(page.locator('#composer-input')).toBeEnabled();
  const { root, body } = await openTiers(page);
  const active = body.locator('[data-project-list] [data-session-row] > [data-row][data-active="true"]');
  await expect(active).toHaveCount(1);
  await body.evaluate((e) => { e.scrollTop = e.scrollHeight; });
  await frames(page);
  const bodyBox = await box(body, 'sidebar body');
  expect((await box(active, 'active row')).y, 'fixture check: the active row is above the body at the bottom scroll').toBeLessThan(bodyBox.y);
  await active.evaluate((e) => e.scrollIntoView({ block: 'nearest' }));
  await frames(page);
  const row = await box(active, 'active row');
  const covering = await box(band(root, tall(P())), 'Tall band');
  expect(row.y, 'the revealed row starts below the band').toBeGreaterThanOrEqual(covering.y + covering.height - 0.5);
}

// Invariant: none — screenshots for the visual pass: desktop in light and dark, a drawer once.
/** Screenshots: the bands scrolled mid-workspace, in both themes on desktop. */
export async function screenshotsFlow({ page }: Ctx): Promise<void> {
  await page.goto('/');
  const { root } = await openTiers(page);
  const p = P();
  await root.locator(`[data-project-row="${member(p, 18)}"]`).evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await frames(page);
  await page.mouse.move(0, 0);
  await shoot(page, `sidebar-tiers-${p}`);
  if (p !== 'desktop') return;
  const theme = page.getByRole('button', { name: /^(Dark|Light) theme$/ });
  const wasDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  await theme.click();
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(!wasDark);
  await settled(page);
  await page.mouse.move(0, 0);
  await shoot(page, `sidebar-tiers-${p}-${wasDark ? 'light' : 'dark'}`);
}

/** Saves a screenshot in the test's output dir and attaches it. */
const shoot = async (page: Page, name: string) => {
  const file = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path: file });
  await test.info().attach(name, { path: file, contentType: 'image/png' });
};

/** The flat spec's beforeAll, per Playwright project: two unassigned projects on a cc with no workspace at all. */
export async function seedFlat({ cc }: Pick<Ctx, 'cc'>, info: { project: { name: string } }): Promise<void> {
  await createProject(cc, `sf-${info.project.name}-a`);
  await createProject(cc, `sf-${info.project.name}-b`);
}

// Invariant: with no workspace there is no band (nothing draws `Other projects` either), and an unassigned project row starts at the project list's own left edge.
/** With no workspaces the unassigned rows stay flat. */
export async function flatListFlow({ page }: Ctx): Promise<void> {
  await page.goto('/');
  await next.lens(page, 'projects');
  const root = nextSidebar(page);
  const p = P();
  const row = root.locator(`[data-project-row="sf-${p}-a"]`);
  await expect(row).toBeVisible();
  await expect(root.locator('[data-workspace-band]'), 'fixture check: no workspace, so no band').toHaveCount(0);
  const list = await box(root.locator('[data-project-list]'), 'project list');
  const r = await box(row, 'unassigned row');
  expect(Math.abs(r.x - list.x), 'the unassigned row starts at the list left edge').toBeLessThanOrEqual(0.5);
  const folder = await box(row.locator('svg').first(), 'folder icon');
  expect(folder.x - list.x, 'the folder starts at the list left edge, no caret slot').toBeGreaterThanOrEqual(0);
  expect(folder.x - list.x, 'the folder starts at the list left edge, no caret slot').toBeLessThanOrEqual(6);
}
