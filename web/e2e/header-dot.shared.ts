// The session header's status dot in a real browser: it sits vertically centred on the
// two-line title block and on the bar, with the subline still aligned under the title.
// The body is shared by the per-project spec files; this module declares no tests.
import type { Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { api, createProject, spawnSession } from './harness/api.ts';

type Args = { page: Page; cc: Cc };

export async function dotCentringFlow({ page, cc }: Args): Promise<void> {
  const project = `hdr-dot-${test.info().project.name}`;
  await createProject(cc, project);
  const { id, sessionId } = await spawnSession(cc, project, { temp: false });
  await expect.poll(async () => {
    const row = ((await api(cc, 'GET', '/api/instances')).body as { id: string; status: string; sessionId: string | null }[]).find((r) => r.id === id);
    return row?.status === 'idle' && !!row.sessionId;
  }).toBe(true);
  const r = await api(cc, 'PUT', `/api/sessions/${sessionId}/title`, { title: 't' });
  expect(r.status, `PUT title: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  await page.goto(`/#session=${sessionId}`);
  const header = page.locator('[data-session-header]');
  await expect(header.getByRole('heading', { level: 1 })).toHaveText('t');

  const g = await header.evaluate((h, projectName) => {
    const rect = (el: Element) => el.getBoundingClientRect();
    const dots = h.querySelectorAll('span[aria-label]');
    const title = rect(h.querySelector('h1')!);
    const sub = [...h.querySelectorAll('span')].filter((s) => s.textContent === projectName).at(-1);
    const box = rect(h);
    return {
      dots: dots.length,
      dot: dots.length === 1 ? rect(dots[0]) : null,
      title, sub: sub ? rect(sub) : null, box,
    };
  }, project);
  expect(g.dots, 'exactly one status dot').toBe(1);
  expect(g.sub, 'the subline renders').not.toBeNull();
  expect(g.sub!.top, 'two lines: the subline is below the title').toBeGreaterThanOrEqual(g.title.bottom - 1);
  const dot = g.dot!;
  const dotCentre = dot.top + dot.height / 2;
  const blockCentre = (g.title.top + g.sub!.bottom) / 2;
  expect(Math.abs(dotCentre - blockCentre), 'dot centre vs the two-line title block').toBeLessThanOrEqual(1);
  expect(Math.abs(dotCentre - (g.box.top + g.box.height / 2)), 'dot centre vs the header').toBeLessThanOrEqual(2);
  expect(dot.right, 'the dot sits left of the title').toBeLessThanOrEqual(g.title.left);
  expect(Math.abs(g.sub!.left - g.title.left), 'the subline stays aligned under the title').toBeLessThanOrEqual(1);
}
