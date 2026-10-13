// The phone transcript layout in a real browser: below `md` the avatar heads the turn and the
// body spans the transcript width, its prose inset from the card border; at `md` and up the avatar sits beside the body, which
// fills the rest of the row. On both the turn footer lines up with the body (a regression
// guard: the footer's avatar-width indent must not return under the stacked layout).
import { test, expect } from './harness/fixtures.ts';
import { createProject } from './harness/api.ts';
import { next } from './flows/ui.ts';

test('phone: the avatar heads the turn and the body spans the transcript width; desktop: the avatar sits beside the body', async ({ page, cc }) => {
  const name = test.info().project.name;
  const project = `tl-${name}`;
  await createProject(cc, project);
  await next.open(page);
  await next.startSessionIn(page, project);
  await next.sendPrompt(page, 'Please read the file, edit it and run the tests. Then summarise what changed, keep it brief but include a list, and tell me whether the limits should be configurable through environment variables or a settings file.');
  await expect(next.turnEnds(page)).toHaveCount(1);

  const bubble = next.lastAssistantMessage(page);
  const box = async (l: ReturnType<typeof page.locator>) => (await l.boundingBox())!;
  const b = await box(bubble);
  const avatar = await box(bubble.locator('[data-assistant-avatar]'));
  const body = await box(bubble.locator('[data-assistant-body]'));
  const footer = await box(next.turnEnds(page).first().locator('span').first());

  if (name === 'phone') {
    expect(avatar.y + avatar.height, 'avatar stacked above body').toBeLessThanOrEqual(body.y + 0.5);
    expect(body.x, 'no avatar gutter').toBeLessThanOrEqual(avatar.x + 0.5);
    expect(body.width).toBeGreaterThanOrEqual(b.width - 0.5);
  } else {
    expect(avatar.x + avatar.width, 'avatar beside body').toBeLessThanOrEqual(body.x);
    expect(body.y, 'same row').toBeLessThan(avatar.y + avatar.height);
    expect(Math.abs(body.x + body.width - (b.x + b.width)), 'body fills the rest of the row').toBeLessThanOrEqual(0.5);
  }
  expect(Math.abs(footer.x - body.x), 'footer lines up with body').toBeLessThan(1);

  if (name === 'phone') {
    // Prose is inset from the action card's border, which stays at the transcript edge.
    const card = await box(bubble.locator('[data-assistant-body] [class*=border]').first());
    const prose = await box(bubble.locator('[data-text-block] p').first());
    expect(prose.x, 'prose inset from the card border').toBeGreaterThan(card.x + 2);
  } else {
    const prose = await box(bubble.locator('[data-text-block] p').first());
    expect(prose.x, 'desktop prose flush with the body').toBeLessThan(body.x + 0.5);
  }
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
  if (name === 'phone') {
    const tops = async (spans: ReturnType<typeof row.locator>) => new Set(await spans.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top))));
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
});
