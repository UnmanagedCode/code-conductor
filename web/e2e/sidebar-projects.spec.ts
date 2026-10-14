// The Projects lens's real-browser layout: what happy-dom cannot
// measure (the Other projects band, row geometry in and out of a
// workspace, a caret beside an overflowing workspace name).
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './harness/fixtures.ts';
import { api, createProject, mcpCall } from './harness/api.ts';
import { next, nextSidebar } from './flows/ui.ts';

test.use({ ccOptions: { server: 'sidebar-projects' } });

const P = () => test.info().project.name;
// `LONG` starts with A and `ZED` with Z, and they are this cc's only workspaces:
// `ZED` sorts last under any collation, directly before the unassigned section.
const zed = (p: string) => `Zed-${p}`;
/** 40 characters, the registry's maximum workspace name (src/projects.ts). */
const long = (p: string) => `A${'W'.repeat(38 - p.length)}-${p}`;

const wsSection = (sb: Locator, name: string) => sb.locator(`section[data-workspace="${name}"]`);
const wsToggle = (sb: Locator, name: string) => wsSection(sb, name).locator('button[aria-expanded]');

async function setOpen(sb: Locator, name: string, open: boolean) {
  const toggle = wsToggle(sb, name);
  if ((await toggle.getAttribute('aria-expanded')) !== String(open)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', String(open));
}

async function projectsLens(page: Page) {
  await page.goto('/');
  await next.lens(page, 'projects');
  return nextSidebar(page);
}

test.beforeAll(async ({ cc }, info) => {
  const p = info.project.name;
  const ok = (r: { status: number; body: unknown }, what: string) => expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  await createProject(cc, `sp-member-${p}`);
  ok(await api(cc, 'PUT', `/api/projects/sp-member-${p}/workspace`, { workspace: zed(p) }), 'PUT member workspace');
  await createProject(cc, `sp-long-${p}`);
  ok(await api(cc, 'PUT', `/api/projects/sp-long-${p}/workspace`, { workspace: long(p) }), 'PUT long workspace');
  await createProject(cc, `sp-git-${p}`);
  const plain = path.join(cc.dirs.projects, `sp-plain-${p}`);
  fs.mkdirSync(plain);
  const adopt = await api(cc, 'POST', '/api/projects/external', { name: `sp-plain-${p}`, path: plain });
  ok(adopt, 'adopt plain directory');
  expect(adopt.body?.ok, JSON.stringify(adopt.body)).toBe(true);
});

test('the Other projects band is drawn once after the workspaces, with the last workspace open or closed', async ({ page }) => {
  // Invariant: the unassigned run opens with one visible band right after the last workspace, whatever that workspace's state.
  const sb = await projectsLens(page);
  const header = sb.locator('[data-unassigned-header]');
  const check = async () => {
    await expect(header).toHaveCount(1);
    await expect(header).toHaveAttribute('data-workspace-band', '');
    const b = (await header.boundingBox())!;
    expect(b.width).toBeGreaterThan(0);
    expect(b.height).toBeGreaterThan(0);
    expect(await sb.locator('section[data-workspace=""]').evaluate((e) => e.previousElementSibling?.getAttribute('data-workspace'))).toBe(zed(P()));
  };
  await check();
  await setOpen(sb, zed(P()), true);
  await check();
  await setOpen(sb, zed(P()), false);
  await check();
});

test('a git project under Other projects offers Commit history and a non-git one does not', async ({ page }) => {
  // Invariant: under Other projects the Commit history button is on the git project's row and absent from the non-git one's.
  const sb = await projectsLens(page);
  const p = P();
  await expect(sb.locator(`[data-project-row="sp-git-${p}"]`).getByRole('button', { name: 'Commit history', exact: true })).toBeVisible();
  await expect(sb.locator(`[data-project-row="sp-plain-${p}"]`).getByRole('button', { name: 'Commit history', exact: true })).toHaveCount(0);
});

test('an unassigned git project shows its commit history button without hover, and it opens that project history', async ({ page }) => {
  // Invariant: the commit-history control of a top-level git row is always shown and opens that project's history.
  const sb = await projectsLens(page);
  const p = P();
  const btn = sb.locator(`[data-project-row="sp-git-${p}"]`).getByRole('button', { name: 'Commit history', exact: true });
  await expect(btn).toBeVisible();
  expect(await btn.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
  expect(await btn.evaluate((e) => getComputedStyle(e).pointerEvents)).not.toBe('none');
  await btn.click();
  await expect(page).toHaveURL(/#commits/);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('code-conductor:view-params') ?? 'null')?.commits))
    .toEqual({ project: `sp-git-${p}`, worktree: null });
});

test('a workspace caret stays visible while a long workspace name overflows', async ({ page }) => {
  // Invariant: an overflowing name never collapses the caret.
  const sb = await projectsLens(page);
  const p = P();
  const section = wsSection(sb, long(p));
  const caret = section.locator('button[aria-expanded] svg').first();
  const label = section.locator('button[aria-expanded] span').first();
  expect(await label.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  expect((await caret.boundingBox())!.width).toBeGreaterThan(0);
});

test('a Conductors-lens tree project row offers the same Commit history button as the Projects lens', async ({ page, cc }) => {
  // Invariant: a Conductors tree project row shows its Commit history button, as the Projects-lens row of the same project does.
  const p = P();
  const project = `sp-tree-${p}`;
  await createProject(cc, project);
  await api(cc, 'POST', '/api/projects/.conduct/ensure');
  // `warn`, so the conductor may spawn an unbound worker.
  const spawned = await api(cc, 'POST', '/api/instances', { project: '.conduct', mode: 'bypassPermissions', temp: true, playbookEnforcement: 'warn' });
  expect(spawned.status, JSON.stringify(spawned.body)).toBeLessThan(300);
  const id: string = spawned.body.id;
  type Row = { id: string; status: string; sessionId: string | null; callerInstanceId?: string | null };
  const instances = async () => (await api<Row[]>(cc, 'GET', '/api/instances')).body;
  let sid: string | null = null;
  await expect.poll(async () => {
    const row = (await instances()).find((i) => i.id === id);
    sid = row?.status === 'idle' ? row.sessionId : null;
    return sid;
  }).not.toBeNull();
  // The MCP caller is the conductor's instance id, as a worker's MCP client sends it.
  const r = await mcpCall(cc, 'spawn_instance', { project, mode: 'bypassPermissions' }, id);
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  await expect.poll(async () => (await instances()).some((i) => i.callerInstanceId === id && i.status === 'idle')).toBe(true);

  await page.goto('/');
  await next.lens(page, 'conductors');
  const sb = nextSidebar(page);
  await sb.locator(`[data-conductor="${sid}"] button[aria-label="Show workers"]`).click();
  await expect(sb.locator(`[data-conductor="${sid}"] [data-project-row="${project}"]`)
    .getByRole('button', { name: 'Commit history', exact: true })).toBeVisible();
  await next.lens(page, 'projects');
  await expect(nextSidebar(page).locator(`[data-project-list] [data-project-row="${project}"]`)
    .getByRole('button', { name: 'Commit history', exact: true })).toBeVisible();
});
