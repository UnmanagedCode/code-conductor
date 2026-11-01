// The transcript's horizontal layout in a real browser, on every project: no avatar, and the user
// bubble, action cards, prose, assistant body and turn footer's status icon share one left edge and
// one width; the footer carries the bubble's controls at its right end, clear of the figures, also
// as the viewport narrows. The body is shared by the per-project spec files.
import type { Locator, Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { createProject } from './harness/api.ts';
import { next } from './flows/ui.ts';

export async function layoutFlow({ page, cc }: { page: Page; cc: Cc }): Promise<void> {
  // Invariant: on desktop, phone and android the user bubble, the first action card, the first prose paragraph, the assistant body and the footer icon start at one non-zero left edge, the card and body end where the user bubble ends, the avatar is gone, the bubble is named Code Conductor, and the footer controls end at the body's right edge without overlapping a figure.
  const name = test.info().project.name;
  const project = `tl-${name}`;
  await createProject(cc, project);
  await next.open(page);
  await next.startSessionIn(page, project);
  await next.sendPrompt(page, 'Please read the file, edit it and run the tests. Then summarise what changed, keep it brief but include a list, and tell me whether the limits should be configurable through environment variables or a settings file.');
  await expect(next.turnEnds(page)).toHaveCount(1);

  const bubble = next.lastAssistantMessage(page);
  const m = await page.evaluate(() => {
    const box = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right }; };
    const column = document.querySelector('[data-conversation] [data-session-width]') as HTMLElement;
    const cr = column.getBoundingClientRect();
    const cs = getComputedStyle(column);
    const bubbles = [...document.querySelectorAll('[data-item=assistant]')].filter((b) => !b.parentElement!.closest('[data-item=assistant]'));
    const last = bubbles[bubbles.length - 1];
    return {
      column: { left: cr.left + parseFloat(cs.paddingLeft), right: cr.right - parseFloat(cs.paddingRight) },
      user: box(document.querySelector('[data-item=user] [data-user-text]')!),
      card: box(last.querySelector('[data-group-trigger]')!.parentElement!),
      prose: box(last.querySelector('[data-text-block] p')!),
      body: box(last.querySelector(':scope > [data-assistant-body]')!),
      icon: box(document.querySelector('[data-item=turn-end] [data-turn-icon]')!),
    };
  });
  const near = (a: number, b: number, msg: string) => expect(Math.abs(a - b), `${msg}: ${a} vs ${b}`).toBeLessThanOrEqual(0.5);
  expect(m.user.left, 'the column has a non-zero left edge').toBeGreaterThan(0);
  near(m.user.left, m.column.left, 'the user bubble starts at the column edge');
  for (const k of ['card', 'prose', 'body', 'icon'] as const) near(m[k].left, m.user.left, `${k} starts at the user bubble's edge`);
  near(m.body.right, m.user.right, 'the body ends where the user bubble ends');
  near(m.card.right, m.user.right, 'the card ends where the user bubble ends');
  await expect(page.locator('[data-assistant-avatar]')).toHaveCount(0);
  await expect(bubble).toHaveAttribute('role', 'group');
  await expect(bubble).toHaveAccessibleName('Code Conductor');

  const box = async (l: Locator) => (await l.boundingBox())!;
  // The turn footer carries the bubble's controls at its right end, clear of the figures.
  const row = next.turnEnds(page).first();
  const checkControls = async () => {
    const rowBox = await box(row);
    const ctl = await box(row.getByRole('button', { name: 'Copy message', exact: true }).locator('xpath=..'));
    const bodyNow = await box(bubble.locator('[data-assistant-body]'));
    expect(Math.abs(ctl.x + ctl.width - (bodyNow.x + bodyNow.width)), 'controls end at the body\'s right edge').toBeLessThanOrEqual(1);
    expect(ctl.x, 'inside the row').toBeGreaterThanOrEqual(rowBox.x - 0.5);
    expect(ctl.x + ctl.width, 'inside the row').toBeLessThanOrEqual(rowBox.x + rowBox.width + 0.5);
    const spans = row.locator('[data-turn-stats] span');
    for (let i = 0; i < await spans.count(); i++) {
      const sp = await box(spans.nth(i));
      expect(sp.x + sp.width, `figure ${i} ends before the controls`).toBeLessThanOrEqual(ctl.x + 0.5);
    }
    return spans;
  };
  await checkControls();
  if (name !== 'desktop') {
    const tops = async (spans: Locator) => new Set(await spans.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top))));
    let wrapped = false;
    for (const width of [300, 260, 230, 200]) {
      await page.setViewportSize({ width, height: 800 });
      const spans = await checkControls();
      if ((await tops(spans)).size > 1) { wrapped = true; break; }
    }
    expect(wrapped, 'fixture check: the figures wrap at some narrow width').toBe(true);
  }
  await next.userMessages(page).last().scrollIntoViewIfNeeded();
  await test.info().attach('transcript', { body: await page.screenshot(), contentType: 'image/png' });
}
