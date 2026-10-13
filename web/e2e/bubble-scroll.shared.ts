// A plan card's long body in a real browser, on fixtures/scenario-bubble-scroll.json:
// the body scrolls inside its bubble with the header and Approve in view, an inner scroll
// leaves the transcript's own scroll alone, a scroll at either end of the body chains on
// to the transcript, and a short plan reserves no scroll space.
// The bodies are shared by the per-project spec files; this module declares no tests.
import type { Locator, Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { createProject } from './harness/api.ts';
import { next } from './flows/ui.ts';

type Args = { page: Page; cc: Cc };

const label = (what: string) => `bubble-scroll-${what}-${test.info().project.name}`;
const jumpToLatest = (page: Page) => page.getByRole('button', { name: 'Jump to latest' });
const fromBottom = (transcript: Locator) => transcript.evaluate((s) => s.scrollHeight - s.clientHeight - s.scrollTop);
/** How near the bottom still counts as stuck to it: ConversationView's own follow threshold. */
const STUCK_PX = 50;
const scrollTopOf = (el: Locator) => el.evaluate((e) => e.scrollTop);

/** Starts a session in a new project, sends `prompt` and returns the plan card's scroll region. */
async function planRegion(page: Page, cc: Cc, what: string, prompt: string): Promise<{ card: Locator; region: Locator }> {
  await createProject(cc, label(what));
  await next.open(page);
  await next.startSessionIn(page, label(what));
  await next.sendPrompt(page, prompt);
  const card = next.transcript(page).locator('[data-item="plan"]');
  await expect(card, 'fixture check: the scenario raised one plan card').toHaveCount(1);
  await expect(next.turnEnds(page)).toHaveCount(1);
  const region = card.locator('[data-bubble-body]');
  await expect(region).toHaveCount(1);
  return { card, region };
}

/**
 * Scrolls the content under the centre of `over` down by `dy` px (up when negative): a real
 * touch scroll on a touch project, a wheel on desktop. Synthetic TouchEvents from page JS never scroll.
 */
async function scrollOver(page: Page, over: Locator, dy: number): Promise<void> {
  const box = await over.boundingBox();
  if (!box) throw new Error('scrollOver: the target has no box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (test.info().project.name !== 'desktop') {
    // CDP Input.dispatchTouchEvent is real input; Input.synthesizeScrollGesture with gestureSourceType 'touch' does not scroll here.
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: string, at?: number) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: at === undefined ? [] : [{ x, y: at }] } as never);
    const steps = 12;
    await touch('touchStart', y);
    for (let i = 1; i <= steps; i++) await touch('touchMove', y - (dy * i) / steps);
    await touch('touchEnd');
    await cdp.detach();
  } else {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, dy);
  }
}

export async function longPlanFlow({ page, cc }: Args): Promise<void> {
  // Invariant: a long plan's body is bounded to half the viewport and scrolls inside the card; the transcript still ends at its bottom, with the card's header and Approve in view.
  const { card, region } = await planRegion(page, cc, 'long', 'PLAN-LONG raise the plan');
  const transcript = next.transcript(page);
  await expect.poll(() => fromBottom(transcript), { message: 'at the bottom' }).toBeLessThan(STUCK_PX);
  await expect(jumpToLatest(page)).toBeHidden();
  const m = await region.evaluate((e) => ({ scroll: e.scrollHeight, client: e.clientHeight, half: window.innerHeight / 2 }));
  expect(m.scroll, 'fixture check: the plan overflows its region').toBeGreaterThan(m.client);
  expect(m.client).toBeLessThanOrEqual(m.half + 1);
  await expect(card.locator('[data-status]')).toBeInViewport();
  await expect(card.getByRole('button', { name: /Approve/ })).toBeInViewport();
}

export async function innerScrollFlow({ page, cc }: Args): Promise<void> {
  // Invariant: scrolling inside the region moves the region only: the transcript stays at its bottom and Jump to latest stays hidden.
  const { region } = await planRegion(page, cc, 'inner', 'PLAN-LONG raise the plan');
  const transcript = next.transcript(page);
  await expect.poll(() => fromBottom(transcript)).toBeLessThan(STUCK_PX);
  const before = await scrollTopOf(transcript);
  await scrollOver(page, region, 120);
  await expect.poll(() => scrollTopOf(region), { message: 'the region scrolled' }).toBeGreaterThan(0);
  expect(await scrollTopOf(transcript), 'the transcript did not move').toBe(before);
  await expect(jumpToLatest(page)).toBeHidden();
}

export async function chainingFlow({ page, cc }: Args): Promise<void> {
  // Invariant: a scroll at either end of the region carries on into the transcript.
  const { region } = await planRegion(page, cc, 'chain', 'PLAN-LONG raise the plan');
  const transcript = next.transcript(page);
  await expect.poll(() => fromBottom(transcript)).toBeLessThan(STUCK_PX);
  expect(await scrollTopOf(region), 'precondition: the region sits at its top').toBe(0);
  const bottomTop = await scrollTopOf(transcript);
  await scrollOver(page, region, -120);
  await expect.poll(() => scrollTopOf(transcript), { message: 'up at the region start scrolled the transcript' }).toBeLessThan(bottomTop);
  expect(await scrollTopOf(region)).toBe(0);

  await region.evaluate((e) => { e.scrollTop = e.scrollHeight; });
  const midTop = await scrollTopOf(transcript);
  await scrollOver(page, region, 120);
  await expect.poll(() => scrollTopOf(transcript), { message: 'down at the region end scrolled the transcript' }).toBeGreaterThan(midTop);
}

export async function shortPlanFlow({ page, cc }: Args): Promise<void> {
  // Invariant: a short plan's region neither scrolls nor reserves space: its box is its content's.
  const { region } = await planRegion(page, cc, 'short', 'PLAN-ASK raise the plan');
  const m = await region.evaluate((e) => { const h = e as HTMLElement; return { scroll: h.scrollHeight, client: h.clientHeight, offset: h.offsetHeight, offsetW: h.offsetWidth, clientW: h.clientWidth }; });
  expect(m.scroll).toBe(m.client);
  expect(m.offset, 'no space reserved for a scrollbar').toBe(m.scroll);
  expect(m.offsetW).toBe(m.clientW);
}
