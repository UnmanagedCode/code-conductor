// The user bubbles' text layout in a real browser, which happy-dom cannot
// lay out: a newline in a prompt or a wake summary stays a line break, and an
// unbroken token wraps inside its bubble instead of widening the transcript.
// The conversation flows are in flows/conversation.spec.ts.
import type { Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { createProject } from './harness/api.ts';
import { next } from './flows/ui.ts';
import { sendAll } from './flows/stickyPin.ts';
import { overflowsX } from './flows/foldedBubbles.ts';
import { buildWakeStub, markPlainStub } from '../../shared/wakeCallback.ts';

const TOKEN = `ub${'w'.repeat(300)}`;
const JOBS = 'Background jobs still running:\n- "npm test" — running 2m5s';

async function startIn(page: Page, cc: Cc, x: string): Promise<void> {
  const project = `ub-${x}-${test.info().project.name}`;
  await createProject(cc, project);
  await next.open(page);
  await next.startSessionIn(page, project);
}

/** Sends `text` and waits for the session's `turns`-th turn end. */
async function send(page: Page, text: string, turns: number): Promise<void> {
  await next.sendPrompt(page, text);
  await expect(next.turnEnds(page)).toHaveCount(turns);
}

test('a prompt and a wake summary show their newlines as line breaks, and a single line stays one line', async ({ page, cc }) => {
  // Invariant: the rendered text (innerText, which applies white-space) keeps a prompt's newline and a job note's lines.
  await startIn(page, cc, 'lines');
  await sendAll(page, next, ['UB-LINES one\nUB-LINES two', 'UB-FLAT one UB-FLAT two']);
  const text = (i: number) => next.userMessages(page).nth(i).locator('[data-user-text] .md').innerText();
  expect(await text(0)).toContain('one\nUB-LINES two');
  // Negative control: a prompt with no newline renders on one line.
  expect(await text(1)).toContain('UB-FLAT one UB-FLAT two');
  expect(await text(1)).not.toContain('\n');

  await send(page, buildWakeStub({ targetSessionId: 'ubjobs', payloadText: '{"sessionId":"ubjobs"}\nbody', jobsNote: JOBS }), 3);
  await send(page, buildWakeStub({ targetSessionId: 'ubplain', payloadText: '{"sessionId":"ubplain"}\nbody' }), 4);
  await expect(next.wakeFold(page)).toHaveCount(2);
  const title = (i: number) => next.wakeFold(page).nth(i).locator('[data-fold-title]');
  expect(await title(0).innerText()).toContain('\n- "npm test"');
  // Negative control: a summary with no job note renders on one line.
  await expect(title(1)).toContainText('ubplain');
  expect(await title(1).innerText()).not.toContain('\n');
});

test('an unbroken token wraps inside a wake summary, a plain wake line and a prompt raw view, so the transcript never scrolls sideways', async ({ page, cc }) => {
  // Invariant: each place an unbroken token shows keeps it inside its own box, and the transcript does not scroll sideways.
  await startIn(page, cc, 'wrap');
  await send(page, buildWakeStub({ targetSessionId: TOKEN, payloadText: `{"sessionId":"${TOKEN}"}\nbody` }), 1);
  await expect(next.wakeFold(page)).toHaveCount(1);
  await send(page, markPlainStub(`Worker \`${TOKEN}\` finished its turn.`), 2);
  const plain = page.locator('[data-wake-plain]');
  await expect(plain, 'the composer-sent plain stub renders as a plain wake line').toHaveCount(1);
  await send(page, TOKEN, 3);
  const typed = next.lastUserMessage(page);
  await typed.getByRole('button', { name: 'Show raw text', exact: true }).click();
  const raw = typed.locator('[data-view="raw"]');

  const places = { summary: next.wakeFold(page).locator('[data-fold-title]'), plain, raw };
  for (const [name, loc] of Object.entries(places)) {
    await expect(loc, `${name} shows the token`).toContainText(TOKEN.slice(0, 50));
    expect(await overflowsX(loc), `${name} overflows sideways`).toBe(false);
  }
  expect(await overflowsX(next.transcript(page)), 'the transcript overflows sideways').toBe(false);

  // Negative control: the same raw view with wrapping turned off overflows, so the probe can fail.
  const handle = await raw.evaluateHandle((e) => {
    const c = e.cloneNode(true) as HTMLElement;
    c.removeAttribute('data-view');
    c.style.cssText += ';white-space:pre;overflow-wrap:normal;word-break:normal';
    e.after(c);
    return c;
  });
  try {
    expect(await handle.evaluate((c) => c.scrollWidth > c.clientWidth + 1), 'a non-wrapping copy overflows').toBe(true);
  } finally {
    await handle.evaluate((c) => c.remove());
    await handle.dispose();
  }
});
