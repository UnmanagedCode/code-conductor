// The ended pane in a real browser: a conducted worker the user is watching is
// killed by MCP, and its pane stays — transcript, a disabled composer holding
// the draft, and the ended banner laid out between them — then the worktree is
// deleted and the pane still stands, without Resume.
import type { Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { api, createProject, mcpCall } from './harness/api.ts';

test.use({ ccOptions: { server: 'ended-session' } });

const json = (result: any) => JSON.parse(result.content[0].text);
const messageBox = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const banner = (page: Page) => page.locator('[data-session-ended]');

/** A conducted worker in a fresh worktree, idle after one prompt; returns its full session id and the worktree. */
async function worker(cc: Cc) {
  const project = `ended-${test.info().project.name}`;
  await createProject(cc, project);
  const created = await mcpCall(cc, 'create_worktree', { project, name: 'job' });
  expect(created.isError, JSON.stringify(created.content)).toBeFalsy();
  const worktree = ((await api(cc, 'GET', `/api/projects/${project}/worktrees`)).body as { worktreeName: string }[])[0].worktreeName;
  const spawned = json(await mcpCall(cc, 'spawn_instance', { project, worktree, mode: 'bypassPermissions' }));
  expect(spawned.sessionId, JSON.stringify(spawned)).toBeTruthy();
  const row = async () => ((await api(cc, 'GET', '/api/instances')).body as { status: string; sessionId: string | null }[])
    .find((r) => r.sessionId?.startsWith(spawned.sessionId));
  await expect.poll(async () => (await row())?.status).toBe('idle');
  const sent = await mcpCall(cc, 'send_prompt', { sessionId: spawned.sessionId, text: 'ENDED-PROMPT' });
  expect(sent.isError, JSON.stringify(sent.content)).toBeFalsy();
  await expect.poll(async () => (await row())?.status).toBe('idle');
  return { project, worktree, handle: spawned.sessionId as string, sessionId: (await row())!.sessionId as string };
}

test('a killed worker\'s pane stays read-only with its draft and the ended banner, and survives delete_worktree without Resume', async ({ page, cc }) => {
  const w = await worker(cc);
  await page.goto(`/#session=${w.sessionId}`);
  await expect(page.getByText('ENDED-PROMPT')).toBeVisible();
  await expect(messageBox(page)).toBeEnabled();
  await messageBox(page).fill('a draft I never sent');

  const killed = await mcpCall(cc, 'kill_instance', { sessionId: w.handle });
  expect(killed.isError, JSON.stringify(killed.content)).toBeFalsy();

  await expect(banner(page)).toBeVisible();
  await expect(page.getByText('ENDED-PROMPT')).toBeVisible();
  await expect(messageBox(page)).toBeDisabled();
  await expect(messageBox(page)).toHaveValue('a draft I never sent');
  await expect(page.locator('[data-empty-state]')).toHaveCount(0);
  await expect(banner(page).getByRole('button', { name: 'Resume' })).toBeVisible();

  // Layout: the banner sits inside the session body, wholly above the composer, within the column.
  const geo = await page.evaluate(() => {
    const b = document.querySelector('[data-session-ended]')!;
    const c = document.querySelector('[data-composer]')!;
    const body = document.querySelector('[data-session-body]')!;
    const r = (e: Element) => e.getBoundingClientRect();
    return {
      inBody: body.contains(b), bannerBottom: r(b).bottom, composerTop: r(c).top,
      bannerLeft: r(b).left, bannerRight: r(b).right, composerLeft: r(c).left, composerRight: r(c).right,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(geo.inBody).toBe(true);
  expect(geo.bannerBottom, 'the banner ends above the composer').toBeLessThanOrEqual(geo.composerTop);
  expect(geo.bannerLeft).toBeGreaterThanOrEqual(geo.composerLeft - 1);
  expect(geo.bannerRight).toBeLessThanOrEqual(geo.composerRight + 1);
  expect(geo.overflow, 'no sideways page overflow').toBeLessThanOrEqual(0);

  const deleted = await mcpCall(cc, 'delete_worktree', { project: w.project, worktree: w.worktree });
  expect(deleted.isError, JSON.stringify(deleted.content)).toBeFalsy();
  expect(json(deleted).ok, JSON.stringify(json(deleted))).not.toBe(false);

  await expect(banner(page).getByRole('button', { name: 'Resume' })).toHaveCount(0);
  await expect(banner(page)).toBeVisible();
  await expect(page.getByText('ENDED-PROMPT')).toBeVisible();
  await expect(messageBox(page)).toHaveValue('a draft I never sent');
});
