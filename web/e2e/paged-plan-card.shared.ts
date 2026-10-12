// A plan card that paged in from an older page of the transcript, in a real browser:
// when its decision can't reach the CLI the card re-opens with the reader's feedback, as a
// card in the live tail does, and it then sends again. The page's socket runs through the
// test, which refuses the marked prompts the way the server refuses a send it can't deliver.
// The bodies are shared by the per-project spec files; this module declares no tests.
import type { Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { createProject } from './harness/api.ts';
import { next } from './flows/ui.ts';
import { instanceIn, reselect } from './flows/questionCard.ts';

type Args = { page: Page; cc: Cc };
type LineagePage = { events: { kind: string }[] };

/** A prompt whose text carries this is refused; every other frame reaches the server. */
const REFUSED = 'PAGED-FAILS';

/** Routes the page's socket through the test before the app opens it; returns the prompts it refused and those it delivered. */
async function refuseMarkedPrompts(page: Page): Promise<{ refused: string[]; delivered: string[] }> {
  const seen = { refused: [] as string[], delivered: [] as string[] };
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (frame.t === 'prompt') {
        const text = String(frame.text ?? '');
        if (text.includes(REFUSED)) {
          seen.refused.push(text);
          ws.send(JSON.stringify({ t: 'ack', reqId: frame.reqId, ok: false, error: 'refused' }));
          return;
        }
        seen.delivered.push(text);
      }
      server.send(message);
    });
  });
  return seen;
}

export function pagedDecisionFlow(decision: 'Approve' | 'Reject') {
  return async ({ page, cc }: Args): Promise<void> => {
    // Invariant: a plan card that paged in from an older page re-opens with its feedback when its decision can't reach the CLI, then sends again.
    const seen = await refuseMarkedPrompts(page);
    const project = `paged-plan-${decision.toLowerCase()}-${test.info().project.name}`;
    await createProject(cc, project);
    await next.open(page);
    await next.startSessionIn(page, project);
    const inst = await instanceIn(cc, project);
    await next.sendPrompt(page, 'PLAN-ASK raise the plan');
    const card = next.transcript(page).locator('[data-item="plan"]');
    await expect(card, 'fixture check: the scenario raised one plan card').toHaveCount(1);
    await expect(next.turnEnds(page)).toHaveCount(1);
    const feedback = card.getByRole('textbox');
    const decide = card.getByRole('button', { name: new RegExp(decision) });

    await feedback.fill(`${REFUSED} in the tail`);
    await decide.click();
    await expect.poll(() => seen.refused.length, { message: 'fixture check: the tail card\'s decision was sent and refused' }).toBe(1);
    await expect(feedback, 'positive control: the card in the live tail re-opens').toBeEnabled();
    await expect(feedback).toHaveValue(`${REFUSED} in the tail`);

    await next.sendPrompt(page, 'a later turn');
    await expect(next.turnEnds(page), 'fixture check: a later turn ended').toHaveCount(2);
    const pages: Promise<LineagePage>[] = [];
    const route = `/api/instances/${encodeURIComponent(inst.id)}/lineage-events`;
    page.on('response', (r) => { if (r.url().includes(route)) pages.push(r.json() as Promise<LineagePage>); });
    await reselect(page, next, project, inst.sessionId);
    await expect(card, 'the plan card is back').toHaveCount(1);
    await expect(feedback, 'fixture check: the card is back awaiting a decision').toHaveValue('');
    expect((await Promise.all(pages)).some((p) => p.events.some((e) => e.kind === 'plan_request')), 'fixture check: the plan card arrived on a lineage page').toBe(true);

    await feedback.fill(`${REFUSED} older`);
    await decide.click();
    await expect.poll(() => seen.refused.length, { message: 'fixture check: the older card\'s decision was sent and refused' }).toBe(2);
    await expect(feedback, 'the older card re-opens').toBeEnabled();
    await expect(decide).toBeEnabled();
    await expect(feedback, 'with its feedback').toHaveValue(`${REFUSED} older`);

    await feedback.fill('older lands');
    await decide.click();
    await expect.poll(() => seen.delivered.some((t) => t.includes('older lands')), { message: 'the re-opened card sends again' }).toBe(true);
    await expect(feedback, 'and locks on what it sent').toBeDisabled();
  };
}
