// Helpers the question-card parity scenarios share: the card fixtures/scenario.json
// raises on a QA-ASK prompt, answering it through the card, and re-selecting a
// session so its snapshot replays. Declares no tests.
import { readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { api } from '../harness/api.ts';
import { DEFAULT_SCENARIO } from '../harness/boot.ts';
import { expect, type Cc } from '../harness/fixtures.ts';
import type { Question } from '../../../public/userQuestionAnswers.ts';
import type { Ui } from './ui.ts';

type ScenarioTurn = { on?: { text?: string }; emit: { type: string; request?: { input?: { questions?: Question[] } } }[] };

function readQaQuestions(): Question[] {
  const scenario = JSON.parse(readFileSync(DEFAULT_SCENARIO, 'utf8')) as { turns: ScenarioTurn[] };
  const ask = scenario.turns.find((t) => t.on?.text === 'QA-ASK');
  const questions = ask?.emit.find((e) => e.type === 'control_request')?.request?.input?.questions;
  if (!questions) throw new Error('scenario.json has no QA-ASK card');
  return questions;
}

/** The two-question card fixtures/scenario.json raises on a QA-ASK prompt. */
export const QA_QUESTIONS: Question[] = readQaQuestions();
export const QA_NOTE = 'QA-NOTE ripe ones';

type ListedInstance = { id: string; project: string; sessionId: string | null; status: string };

/** The one instance of `project`, once it has a session id. */
export async function instanceIn(cc: Cc, project: string): Promise<{ id: string; sessionId: string }> {
  const out: { inst: { id: string; sessionId: string } | null } = { inst: null };
  await expect.poll(async () => {
    const mine = (await api<ListedInstance[]>(cc, 'GET', '/api/instances')).body
      .filter((i) => i.project === project && i.sessionId);
    out.inst = mine.length === 1 ? { id: mine[0].id, sessionId: mine[0].sessionId as string } : null;
    return out.inst !== null;
  }, { message: `one instance of ${project} with a session id` }).toBe(true);
  if (!out.inst) throw new Error(`no instance of ${project}`);
  return out.inst;
}

/** Sends the QA-ASK prompt and returns the card it raises, once its turn has ended. */
export async function askCard(page: Page, ui: Ui): Promise<Locator> {
  await ui.sendPrompt(page, 'QA-ASK raise the card');
  const card = ui.questionCard(page);
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(QA_QUESTIONS[0].question ?? '');
  await expect(ui.turnEnds(page)).toHaveCount(1);
  return card;
}

/** Answers Banana with QA_NOTE, then L, sends, and waits for the stamped echo and the turn end. */
export async function answerCard(page: Page, ui: Ui, card: Locator, turns: number): Promise<void> {
  await ui.cardOption(card, 'Banana').click();
  await ui.cardField(card).fill(QA_NOTE);
  await ui.cardTab(card, 1).click();
  await ui.cardOption(card, 'L').click();
  await ui.cardSend(card).click();
  await expect(ui.cardStatus(card)).toHaveText(/^answered$/i);
  await expect(ui.turnEnds(page)).toHaveCount(turns);
}

/** Leaves `sessionId` for a new session in `project`, then selects it again, so its snapshot replays. */
export async function reselect(page: Page, ui: Ui, project: string, sessionId: string): Promise<void> {
  const chip = ui.sessionHeader(page).locator(`[title="session ${sessionId}"]`);
  await ui.startSessionIn(page, project);
  await expect(chip).toHaveCount(0);
  const row = await ui.sessionRow(page, project, sessionId);
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(chip).toBeVisible();
}

/** The answer bubble's rows as answerCard leaves them; the note is matched by containing QA_NOTE, its separator being the UI's own. */
export async function expectQaAnswerRows(ui: Ui, bubble: Locator): Promise<void> {
  const rows = await ui.answerRows(bubble);
  // Invariant: one row per question with its pick; only the first carries the note, and neither has custom text.
  expect(rows.map((r) => ({ ...r, note: r.note === null ? null : r.note.includes(QA_NOTE) }))).toEqual([
    { kind: 'option', choices: ['Banana'], note: true, custom: null },
    { kind: 'option', choices: ['L'], note: null, custom: null },
  ]);
}

/** The card reads answered, `picked` is picked and `notPicked` is not, and every control is disabled. */
export async function expectLockedOn(ui: Ui, card: Locator, picked: string, notPicked: string, field: string): Promise<void> {
  await expect(ui.cardStatus(card)).toHaveText(/^answered$/i);
  await expect.poll(() => ui.cardOptionPicked(ui.cardOption(card, picked))).toBe(true);
  expect(await ui.cardOptionPicked(ui.cardOption(card, notPicked))).toBe(false);
  await expect(ui.cardOption(card, picked)).toBeDisabled();
  await expect(ui.cardOption(card, notPicked)).toBeDisabled();
  await expect(ui.cardField(card)).toBeDisabled();
  await expect(ui.cardField(card)).toHaveValue(field);
  await expect(ui.cardSend(card)).toBeDisabled();
}
