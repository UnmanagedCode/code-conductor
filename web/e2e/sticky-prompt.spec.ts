// The sticky prompt's own browser checks: the scrollbar gutter, hiding a
// pushed-off pin after a jump, and real touch swipes. The conversation flows
// are in flows/conversation.spec.ts.
import { test, expect } from './harness/fixtures.ts';
import { createProject } from './harness/api.ts';
import { next } from './flows/ui.ts';
import { bringTo, offsetFromTop, reveal, sendAll, swipe, tallPrompt } from './flows/stickyPin.ts';

// Headless Chromium hides scrollbars; the gutter test needs a classic one.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

async function startIn(page: import('@playwright/test').Page, cc: { url: string }, x: string) {
  const project = `pin-${x}-${test.info().project.name}`;
  await createProject(cc, project);
  await next.open(page);
  await next.startSessionIn(page, project);
}

test("the pin stops short of the transcript's scrollbar", async ({ page, cc }) => {
  test.skip(test.info().project.name !== 'desktop', 'Pixel 7 scrollbars overlay the content and take no gutter');
  await startIn(page, cc, 'gutter');
  await sendAll(page, next, [tallPrompt('PIN-GUTTER')]);
  const transcript = next.transcript(page);
  const pin = next.pin(page);
  expect(await transcript.evaluate((s) => (s as HTMLElement).offsetWidth - s.clientWidth - 2 * s.clientLeft), 'the transcript lays out a scrollbar gutter').toBeGreaterThan(0);
  const contentRight = () => transcript.evaluate((s) => s.getBoundingClientRect().left + s.clientLeft + s.clientWidth);

  await bringTo(transcript, next.userMessages(page).nth(0), -150);
  await reveal(page, next);
  await expect(pin).toBeVisible();
  await expect(pin).toHaveAttribute('role', 'button');
  let box = (await pin.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(await contentRight() + 0.5);

  await transcript.evaluate((s) => { s.scrollTop = 0; });
  await expect(pin).toHaveAttribute('role', 'status');
  await expect(pin).toBeVisible();
  box = (await pin.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(await contentRight() + 0.5);
});

test('after a jump the held prompt is pushed off by the one now at the top, so the pin hides until the transcript scrolls on', async ({ page, cc }) => {
  await startIn(page, cc, 'jump');
  await sendAll(page, next, [tallPrompt('PIN-ALPHA'), tallPrompt('PIN-BRAVO')]);
  const transcript = next.transcript(page);
  const pin = next.pin(page);
  const bravo = next.userMessages(page).nth(1);

  await bringTo(transcript, bravo, -150);
  await reveal(page, next);
  await expect(pin).toContainText('PIN-BRAVO');
  await pin.click();
  await expect.poll(async () => Math.abs(await offsetFromTop(transcript, bravo))).toBeLessThanOrEqual(1);
  await expect(pin).toBeHidden();
  await bringTo(transcript, bravo, 40);
  await expect(pin).toBeVisible();
  await expect(pin).toContainText('PIN-ALPHA');
});

test('a vertical swipe on the session header reveals the pin and a swipe up conceals it; a swipe on the transcript does nothing', async ({ page, cc }) => {
  test.skip(!test.info().project.use.hasTouch, 'touch gestures need a touch device');
  await startIn(page, cc, 'swipe');
  await sendAll(page, next, [tallPrompt('PIN-SWIPE')]);
  const transcript = next.transcript(page);
  const pin = next.pin(page);
  const header = next.sessionHeader(page);

  await swipe(transcript, 80);
  await expect(pin).toBeHidden();
  await swipe(header, 80);
  await expect(pin).toBeVisible();
  await swipe(header, -80);
  await expect(pin).toBeHidden();
});

test("a pin peeking back past the transcript's top edge is clipped to the transcript, so the session header above it still takes taps", async ({ page, cc }) => {
  await startIn(page, cc, 'clip');
  await sendAll(page, next, [tallPrompt('PIN-ALPHA'), tallPrompt('PIN-BRAVO')]);
  const transcript = next.transcript(page);
  const pin = next.pin(page);
  const header = next.sessionHeader(page);
  const bravo = next.userMessages(page).nth(1);

  await bringTo(transcript, bravo, -150);
  await reveal(page, next);
  await pin.click();
  await expect.poll(async () => Math.abs(await offsetFromTop(transcript, bravo))).toBeLessThanOrEqual(1);
  await bringTo(transcript, bravo, 40);
  await expect(pin).toBeVisible();
  await expect(pin).toContainText('PIN-ALPHA');

  // The peeking pin is shifted up past the transcript's top, into the header's box.
  const p = (await pin.boundingBox())!;
  const h = (await header.boundingBox())!;
  const left = Math.max(p.x, h.x);
  const right = Math.min(p.x + p.width, h.x + h.width);
  const top = Math.max(p.y, h.y);
  const bottom = Math.min(p.y + p.height, h.y + h.height);
  expect(right - left > 2 && bottom - top > 2, `the pin (${JSON.stringify(p)}) overlaps the header (${JSON.stringify(h)})`).toBe(true);
  // Where they overlap, a tap lands on the header, not on the pin.
  const hit = await header.evaluate((el, [x, y]) => {
    const at = document.elementFromPoint(x, y);
    return { inHeader: !!at && el.contains(at), at: at ? at.outerHTML.slice(0, 120) : null };
  }, [(left + right) / 2, (top + bottom) / 2] as const);
  expect(hit.inHeader, `the tap lands on ${hit.at}`).toBe(true);
});

// Invariant: the pinned bubble's right edge is the live prompt bubble's, with a real scrollbar gutter on desktop and below the md breakpoint on phone.
test("the pinned bubble's right edge is the live prompt bubble's", async ({ page, cc }) => {
  await startIn(page, cc, 'edge');
  await sendAll(page, next, [tallPrompt('PIN-EDGE')]);
  await bringTo(next.transcript(page), next.userMessages(page).nth(0), -150);
  await reveal(page, next);
  await expect(next.pin(page)).toHaveAttribute('role', 'button');
  const edges = await page.evaluate(() => ({
    pinned: (document.querySelector('[data-pinned-prompt] [data-pin-body]') as HTMLElement).getBoundingClientRect().right,
    live: (document.querySelector('[data-item=user] [data-user-text]') as HTMLElement).getBoundingClientRect().right,
  }));
  expect(Math.abs(edges.pinned - edges.live)).toBeLessThanOrEqual(1);
});
