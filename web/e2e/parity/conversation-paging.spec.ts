// Conversation scenarios that need the snapshot tail cut short, so earlier
// events page in through lineage-events: this file boots its own cc with
// ORCH_SNAPSHOT_TAIL=2. Append later paging scenarios here.
import { createProject } from '../harness/api.ts';
import { expect, test } from '../harness/fixtures.ts';
import { parity } from './parity.ts';
import { answerCard, askCard, expectLockedOn, expectQaAnswerRows, instanceIn, QA_NOTE, reselect } from './questionCard.ts';

test.use({ ccOptions: { server: 'conversation-paging', env: { ORCH_SNAPSHOT_TAIL: '2' } } });

type LineagePage = { events: { kind: string; toolUseId?: string; questionAnswer?: unknown }[] };

parity('lineage-scrollback-client/R2', 'a card that pages in from below the snapshot tail locks from the answer the tail already applied', async ({ page, cc, ui, uniq }) => {
  // Invariant: a card served by a lineage page locks from the answer the snapshot tail applied first.
  const project = uniq('qa-paged');
  await createProject(cc, project);
  await ui.open(page);
  await ui.startSessionIn(page, project);
  const inst = await instanceIn(cc, project);
  const asked = await askCard(page, ui);
  await answerCard(page, ui, asked, 2);

  const bodies: Promise<LineagePage>[] = [];
  const route = `/api/instances/${encodeURIComponent(inst.id)}/lineage-events`;
  page.on('response', (r) => { if (r.url().includes(route)) bodies.push(r.json() as Promise<LineagePage>); });
  await reselect(page, ui, project, inst.sessionId);

  const card = ui.questionCard(page);
  await expect(card).toHaveCount(1);
  await expectLockedOn(ui, card, 'Banana', 'Apple', QA_NOTE);
  await expectQaAnswerRows(ui, ui.answerBubble(page));

  const got = await Promise.all(bodies);
  expect(got.length, 'the session paged').toBeGreaterThan(0);
  expect(got.some((p) => p.events.some((e) => e.kind === 'user_question' && e.toolUseId === 'toolu_qa')), 'the card arrived on a lineage page').toBe(true);
  expect(got.some((p) => p.events.some((e) => e.kind === 'user_echo' && !!e.questionAnswer)), 'the stamped answer came in the snapshot tail, not on a page').toBe(false);
});
