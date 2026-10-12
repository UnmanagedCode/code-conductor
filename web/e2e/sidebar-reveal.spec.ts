// Reveal on select in the real layout: a reveal the needs-you strip starts
// opens the sidebar onto the revealed row, the phone drawer's re-open included.
import { test, expect } from './harness/fixtures.ts';
import { api, createProject, spawnSession } from './harness/api.ts';
import { insts } from './flows/fleet.ts';
import { next, nextSidebar } from './flows/ui.ts';

test.use({ ccOptions: { server: 'sidebar-reveal' } });

/** Unassigned projects sorting before the session's, enough to push its row below the fold. */
const FILLERS = 30;

test('a reveal from the needs-you strip opens the sidebar onto the revealed row deep in the list, the phone drawer re-opening included', async ({ page, cc }) => {
  // Invariant: a selection whose row the reveal had to open shows that row in view, without the user scrolling.
  test.setTimeout(180_000);
  const p = test.info().project.name;
  const P = `rv-strip-${p}`;
  // `rv-fill-…` sorts before `rv-strip-…`, so every filler lists above P.
  const fillers = Array.from({ length: FILLERS }, (_, n) => `rv-fill-${String(n).padStart(2, '0')}-${p}`);
  try {
    for (const name of fillers) await createProject(cc, name);
    const s = await spawnSession(cc, P, { temp: false });
    await expect.poll(async () => (await insts(cc)).find((i) => i.id === s.id)?.status, { message: 'the session is idle' }).toBe('idle');
    await page.goto('/');
    await next.lens(page, 'projects');
    const sb = nextSidebar(page);
    const row = sb.locator(`[data-project="${P}"] [data-session-row="${s.sessionId}"] > [data-row]`);
    await expect(row).toHaveCount(1);
    await expect(row, 'fixture: the row starts below the fold').not.toBeInViewport();
    // The user collapses P's Sessions subnode: the row leaves the tree, so only the reveal brings it back.
    const chevron = sb.locator(`[data-project-row="${P}"] > button[aria-label="Sessions"]`);
    await chevron.click();
    await expect(chevron).toHaveAttribute('aria-expanded', 'false');
    await expect(row).toHaveCount(0);
    await sb.locator('[data-sidebar-body]').evaluate((e) => { e.scrollTop = 0; });
    const entry = await next.stripEntry(page, s.sessionId);
    await expect(entry).toHaveCount(1);
    await entry.click();
    await expect(next.sessionHeader(page).locator(`[title="session ${s.sessionId}"]`)).toBeVisible();
    const selected = await next.selectedProjectsRow(page);
    await expect(selected).toHaveCount(1);
    expect(await selected.locator('[data-row-open]').getAttribute('title')).toMatch(new RegExp(`^${s.sessionId}`));
    await expect(selected).toBeInViewport();
  } finally {
    for (const name of [...fillers, P]) await api(cc, 'DELETE', `/api/projects/${name}`, { deleteDirectory: true });
  }
});
