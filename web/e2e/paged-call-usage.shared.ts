// A per-call usage line whose call_usage opens the snapshot tail while its message sits on
// the older page below, in a real browser: the line shows once that page loads, as it does
// live. The cc runs a three-event tail, so a reselected plain turn's tail starts on its
// call_usage, between the reply's last block and the turn's end.
// The bodies are shared by the per-project spec files; this module declares no tests.
import type { Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { createProject } from './harness/api.ts';
import { next } from './flows/ui.ts';
import { instanceIn, reselect } from './flows/questionCard.ts';
import { statisticsItem, usageLines } from './conversation-machinery.shared.ts';

type Args = { page: Page; cc: Cc };
type SnapshotFrame = { t?: string; id?: string; events?: { kind?: string }[] };

export async function tailFirstUsageFlow({ page, cc }: Args): Promise<void> {
  // Invariant: a call_usage at the head of the snapshot tail shows its usage line once the page holding its message loads, the one line the live turn showed.
  test.skip(cc.engine === 'live', "the flow drives the fake engine's bubble scenario");
  const snapshots: SnapshotFrame[] = [];
  page.on('websocket', (ws) => ws.on('framereceived', (f) => {
    const frame = JSON.parse(String(f.payload)) as SnapshotFrame;
    if (frame.t === 'snapshot') snapshots.push(frame);
  }));
  const project = `paged-usage-${test.info().project.name}`;
  await createProject(cc, project);
  await next.open(page);
  await next.startSessionIn(page, project);
  const inst = await instanceIn(cc, project);
  await next.sendPrompt(page, 'a plain prompt');
  await expect(next.turnEnds(page), 'fixture check: the plain turn ended').toHaveCount(1);
  expect(await statisticsItem(page, true), 'fixture check: the Statistics box is ticked').toBe('true');
  await expect(usageLines(page), 'live control: the reply\'s call shows one line').toHaveCount(1);
  await expect(usageLines(page)).toBeVisible();

  snapshots.length = 0;
  await reselect(page, next, project, inst.sessionId);
  await expect.poll(() => snapshots.filter((s) => s.id === inst.id).at(-1)?.events?.map((e) => e.kind), {
    message: 'fixture check: the reselected tail starts on the reply\'s call_usage',
  }).toEqual(['call_usage', 'assistant_message', 'turn_end']);
  await expect(next.transcript(page).getByText('Plain reply.'), 'fixture check: the reply paged in').toBeVisible();
  await expect(usageLines(page), 'the line is back, once').toHaveCount(1);
  await expect(usageLines(page)).toBeVisible();
}
