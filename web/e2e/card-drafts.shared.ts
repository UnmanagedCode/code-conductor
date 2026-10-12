// A plan card's feedback and a question card's tab, pick and note in the /next/ transcript,
// in a real browser: leaving a full-page view (Settings) brings each back as the reader left
// it, and typing in the middle of either card's text keeps the caret where the reader typed.
// The bodies are shared by the per-project spec files; this module declares no tests.
import type { Locator, Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { createProject } from './harness/api.ts';
import { next } from './parity/ui.ts';

type Args = { page: Page; cc: Cc };

/** Starts a session in a new project and raises fixtures/scenario.json's plan card (PLAN-ASK), then its two-question card (QA-ASK). */
async function cardsSession(page: Page, cc: Cc, what: string): Promise<{ feedback: Locator; card: Locator }> {
  const project = `drafts-${what}-${test.info().project.name}`;
  await createProject(cc, project);
  await next.open(page);
  await next.startSessionIn(page, project);
  await next.sendPrompt(page, 'PLAN-ASK raise the plan');
  const plan = next.transcript(page).locator('[data-item="plan"]');
  await expect(plan, 'fixture check: the scenario raised one plan card').toHaveCount(1);
  await expect(next.turnEnds(page)).toHaveCount(1);
  await next.sendPrompt(page, 'QA-ASK raise the card');
  const card = next.questionCard(page);
  await expect(card, 'fixture check: the scenario raised one question card').toHaveCount(1);
  await expect(next.turnEnds(page)).toHaveCount(2);
  return { feedback: plan.getByRole('textbox'), card };
}

export async function viewReturnFlow({ page, cc }: Args): Promise<void> {
  // Invariant: leaving a full-page view brings back the plan card's feedback and the question card's tab, pick and note.
  const { feedback, card } = await cardsSession(page, cc, 'return');
  await feedback.fill('DRAFT-FEEDBACK refine step one');
  await next.cardTab(card, 1).click();
  await next.cardOption(card, 'L').click();
  await next.cardField(card).fill('DRAFT-NOTE large please');
  const large = next.cardOption(card, 'L');
  const state = async () => ({
    feedback: await feedback.inputValue(),
    tab: await next.cardTab(card, 1).getAttribute('aria-pressed'),
    picked: (await large.count()) ? await next.cardOptionPicked(large) : null,
    note: await next.cardField(card).inputValue(),
  });
  const set = { feedback: 'DRAFT-FEEDBACK refine step one', tab: 'true', picked: true, note: 'DRAFT-NOTE large please' };
  await expect.poll(state, { message: 'fixture check: every field moved away from where it starts' }).toEqual(set);

  await next.openSettings(page);
  await next.leaveSettings(page);
  await expect(next.turnEnds(page), 'fixture check: the transcript is back').toHaveCount(2);
  await expect(card.getByRole('group', { name: 'Questions' }).getByRole('button'), 'fixture check: the question card is back with its two question buttons').toHaveCount(2);
  expect(await state(), 'the feedback, tab, pick and note as the reader left them').toEqual(set);
}

export async function caretFlow({ page, cc }: Args): Promise<void> {
  // Invariant: typing in the middle of a card's text keeps the caret where the reader typed, in the plan's feedback and in the question's note.
  const { feedback, card } = await cardsSession(page, cc, 'caret');
  const typeMidText = async (field: Locator): Promise<string> => {
    await field.click();
    await page.keyboard.type('abc');
    await expect(field, 'fixture check: the field holds what was typed').toHaveValue('abc');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('XY');
    return field.inputValue();
  };
  expect(await typeMidText(feedback), 'the plan card\'s feedback').toBe('aXYbc');
  expect(await typeMidText(next.cardField(card)), 'the question card\'s note').toBe('aXYbc');
}
