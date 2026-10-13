// What the reader opened in the transcript, in a real browser: a tool card
// keeps its Arguments and Result through closing and reopening it, and leaving a
// full-page view (Settings) brings back the tool card, thinking block, fold and raw
// views the reader set, with the reader still on the prompt they were reading.
// The bodies are shared by the per-project spec files; this module declares no tests.
import type { Locator, Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { createProject } from './harness/api.ts';
import { next } from './flows/ui.ts';
import { bringTo, offsetFromTop, sendAll, tallPrompt } from './flows/stickyPin.ts';
import { sendWake } from './flows/foldedBubbles.ts';

type Args = { page: Page; cc: Cc };

const label = (what: string) => `collapse-${what}-${test.info().project.name}`;
const jumpToLatest = (page: Page) => page.getByRole('button', { name: 'Jump to latest' });
/** A native fold's open property; null while it is not rendered. */
const openOf = async (details: Locator) => ((await details.count()) ? details.evaluate((d) => (d as HTMLDetailsElement).open) : null);

/** The fake scenario's tool turn: its action group, its Read card and what that card holds, and its thinking block. */
function toolTurn(page: Page) {
  const transcript = next.transcript(page);
  const card = transcript.locator('[data-tool-trigger]').filter({ has: page.locator('[data-tool-name="Read"]') });
  const content = card.locator('xpath=..');
  return {
    group: transcript.locator('[data-group-trigger]'),
    card,
    args: content.locator('[data-tool-args]'),
    result: content.locator('[data-tool-result]'),
    thinking: transcript.locator('[data-thinking="summary"]'),
  };
}

/** Starts a session in a new project and sends `prompts`; the first gets the fake scenario's tool turn. */
async function session(page: Page, cc: Cc, what: string, prompts: string[]): Promise<void> {
  const project = label(what);
  await createProject(cc, project);
  await next.open(page);
  await next.startSessionIn(page, project);
  await sendAll(page, next, prompts);
}

/** Opens the tool turn's group: it folded as its turn ended. */
async function openGroup(page: Page): Promise<void> {
  const { group } = toolTurn(page);
  await expect(group, 'fixture check: the tool turn folded its group as it ended').toHaveAttribute('data-state', 'closed');
  await group.click();
  await expect(group).toHaveAttribute('data-state', 'open');
}

/** Leaves the transcript for Settings and comes back, with `turns` turns rendered again. */
async function settingsRoundTrip(page: Page, turns: number): Promise<void> {
  await next.openSettings(page);
  await next.leaveSettings(page);
  await expect(next.turnEnds(page), 'fixture check: the transcript is back').toHaveCount(turns);
}

// ── reopening a tool card ────────────────────────────────────────────────

export async function cardReopenFlow({ page, cc }: Args): Promise<void> {
  // Invariant: closing and reopening a tool card keeps the Arguments the reader opened and the Result they collapsed.
  await session(page, cc, 'reopen', ['COLLAPSE-REOPEN read the server']);
  const t = toolTurn(page);
  await openGroup(page);
  await t.card.click();
  await expect(t.card).toHaveAttribute('data-state', 'open');
  expect([await openOf(t.args), await openOf(t.result)], 'fixture check: Arguments start closed, the Result open').toEqual([false, true]);
  await t.args.locator(':scope > summary').click();
  await t.result.locator(':scope > summary').click();
  await expect.poll(async () => [await openOf(t.args), await openOf(t.result)], { message: 'precondition: Arguments opened, the Result collapsed' }).toEqual([true, false]);

  await t.card.click();
  await expect(t.card).toHaveAttribute('data-state', 'closed');
  await expect(t.args, 'fixture check: a closed card renders none of its content').toHaveCount(0);
  await t.card.click();
  await expect(t.card).toHaveAttribute('data-state', 'open');
  expect([await openOf(t.args), await openOf(t.result)], 'reopened, the card keeps Arguments open and the Result collapsed').toEqual([true, false]);
}

// ── tool cards across a view return ──────────────────────────────────────

export async function toolsReturnFlow({ page, cc }: Args): Promise<void> {
  // Invariant: leaving a full-page view brings back the tool card (its Arguments and Result) and thinking block the reader set above the prompt being read, and the reader stays on that prompt.
  await session(page, cc, 'tools', ['COLLAPSE-TOOLS read the server', tallPrompt('COLLAPSE-ALPHA'), tallPrompt('COLLAPSE-BRAVO')]);
  const t = toolTurn(page);
  await openGroup(page);
  await t.card.click();
  await t.args.locator(':scope > summary').click();
  await t.result.locator(':scope > summary').click();
  await t.thinking.click();
  const state = async () => ({
    card: await t.card.getAttribute('data-state'),
    args: await openOf(t.args),
    result: await openOf(t.result),
    thinking: await t.thinking.getAttribute('data-state'),
  });
  const set = { card: 'open', args: true, result: false, thinking: 'open' };
  await expect.poll(state, { message: 'fixture check: every surface moved away from where it starts' }).toEqual(set);

  const transcript = next.transcript(page);
  const alpha = next.userMessages(page).nth(1);
  await bringTo(transcript, alpha, 40);
  await expect(jumpToLatest(page), 'precondition: scrolled up, below the opened tool turn').toBeVisible();
  const left = await offsetFromTop(transcript, alpha);
  await settingsRoundTrip(page, 3);
  await expect(t.group, 'the action group, kept on its node').toHaveAttribute('data-state', 'open');
  expect(await state(), 'the tool card and thinking block as the reader set them').toEqual(set);
  expect(Math.abs(await offsetFromTop(transcript, alpha) - left), 'back on the prompt being read').toBeLessThanOrEqual(1);
}

// ── folds across a view return ───────────────────────────────────────────

export async function foldsReturnFlow({ page, cc }: Args): Promise<void> {
  // Invariant: leaving a full-page view brings back the fold and raw views the reader set above the prompt being read, and the reader stays on that prompt.
  const project = label('folds');
  await createProject(cc, project);
  await next.open(page);
  await next.startSessionIn(page, project);
  await sendWake(page, next, 1);
  for (const [i, prompt] of ['COLLAPSE-RAW **plain**', tallPrompt('COLLAPSE-ALPHA'), tallPrompt('COLLAPSE-BRAVO')].entries()) {
    await next.sendPrompt(page, prompt);
    await expect(next.turnEnds(page)).toHaveCount(i + 2);
  }
  await openGroup(page);
  const fold = next.wakeFold(page);
  const raw = next.userMessages(page).filter({ hasText: 'COLLAPSE-RAW' });
  await next.foldToggle(fold).click();
  await next.toggleFoldView(fold);
  await raw.hover();
  await raw.getByRole('button', { name: 'Show raw text' }).click();
  const state = async () => ({
    fold: await next.foldToggle(fold).getAttribute('data-state'),
    foldRaw: await next.foldRaw(fold).count(),
    prompt: await raw.locator('[data-user-text] [data-view="raw"]').count(),
  });
  const set = { fold: 'open', foldRaw: 1, prompt: 1 };
  await expect.poll(state, { message: 'fixture check: every surface moved away from where it starts' }).toEqual(set);

  const transcript = next.transcript(page);
  const alpha = next.userMessages(page).filter({ hasText: 'COLLAPSE-ALPHA' });
  await bringTo(transcript, alpha, 40);
  await expect(jumpToLatest(page), 'precondition: scrolled up, below the fold').toBeVisible();
  const left = await offsetFromTop(transcript, alpha);
  await settingsRoundTrip(page, 4);
  await expect(toolTurn(page).group, 'the action group, kept on its node').toHaveAttribute('data-state', 'open');
  expect(await state(), 'the fold and raw views as the reader set them').toEqual(set);
  expect(Math.abs(await offsetFromTop(transcript, alpha) - left), 'back on the prompt being read').toBeLessThanOrEqual(1);
}
