// The /next/ transcript's assistant-bubble controls and queued ghosts in a real browser,
// on the fake engine's bubble scenario (fixtures/scenario-conversation-bubbles.json): copy,
// raw and read-aloud on a bubble whose turn is still running, the same controls through a
// raw switch, a full-page view and a reload, and queued messages that stay on screen,
// marked delivered, when the usage window resets, and a read-aloud of its own on every
// finished text block of the bubble, which reads that block.
// The bodies are shared by the per-project spec files; this module declares no tests.
import type { Page, WebSocketRoute } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { api, createProject } from './harness/api.ts';
import { next } from './flows/ui.ts';
import { instanceIn } from './flows/questionCard.ts';
import { release } from './conversation-machinery.shared.ts';

type Args = { page: Page; cc: Cc };
type Session = { project: string; id: string; sessionId: string };

/** The scenario turn this prompt text starts: prose, thinking and a Bash call, held while the bubble's second text block streams. */
const HOLD = 'BUBBLE-HOLD';
/** What the held bubble's copy hands the clipboard while its second block streams, and once it has finished. */
const COPY_STREAMING = 'Intro with **one**\n\nStreamed **so';
const COPY_FINISHED = 'Intro with **one**\n\nStreamed **so far** and done.';

const label = (what: string) => `bubbles-${what}-${test.info().project.name}`;
const fakeOnly = (cc: Cc) => test.skip(cc.engine === 'live', "the flows drive the fake engine's bubble scenario");

/** The held turn's bubble, found by its first block's text. */
const bubble = (page: Page) => next.transcript(page).locator('[data-item=assistant]').filter({ hasText: 'Intro with' });
const control = (page: Page, name: string) => bubble(page).getByRole('button', { name, exact: true });
/** The live region beside the bubble's copy button, in the row of its controls. */
const copyAnnouncement = (page: Page) => control(page, 'Copy message').locator('xpath=..').locator('[aria-live]');
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
/**
 * The held bubble's own text blocks, in stream order, never those of a sub-agent bubble inside it. The nesting test runs
 * from the page: inside a locator chain, `:not(…)` with combinators only sees the chain's own subtree.
 */
const textBlocks = (page: Page) =>
  bubble(page).locator('[data-text-block]').and(page.locator('[data-text-block]:not([data-item=assistant] [data-item=assistant] [data-text-block])'));

/** Collects what each read-aloud tap sends to be spoken (the `POST /api/tts` bodies), answered with no audio. */
async function speechSeam(page: Page): Promise<string[]> {
  const bodies: string[] = [];
  await page.route('**/api/tts', (route) => {
    bodies.push(route.request().postData() ?? '');
    return route.fulfill({ status: 200, body: '' });
  });
  return bodies;
}

/** Empties the clipboard, then copies the bubble. */
async function copy(page: Page): Promise<void> {
  await page.evaluate(() => navigator.clipboard.writeText(''));
  expect(await clipboard(page), 'fixture check: the clipboard starts empty').toBe('');
  await bubble(page).hover();
  await control(page, 'Copy message').click();
}

/** Starts a session in a new project and sends the held turn's prompt, with clipboard access and a read-aloud voice. */
async function heldRun(page: Page, cc: Cc, what: string): Promise<Session> {
  const project = label(what);
  await createProject(cc, project);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  // Read-aloud needs a Piper voice installed; the page is told one is.
  await page.route('**/api/tts/status', (route) => route.fulfill({ json: { available: true } }));
  await next.open(page);
  await next.startSessionIn(page, project);
  await next.sendPrompt(page, `${HOLD} ${what}`);
  await expect(bubble(page), 'fixture check: the held bubble streams its second block').toContainText('Streamed');
  return { project, ...(await instanceIn(cc, project)) };
}

// ── a streaming bubble's controls ────────────────────────────────────────

export async function liveControlsFlow({ page, cc }: Args): Promise<void> {
  // Invariant: while the turn runs and the bubble's second block streams, its controls are enabled and work: copy hands the clipboard the source streamed so far without the thinking or the call, and announces it; raw switched on mid-stream holds as the block finishes; copy then takes the whole text.
  fakeOnly(cc);
  const s = await heldRun(page, cc, 'live');
  const status = async () => (await api<{ id: string; status: string }[]>(cc, 'GET', '/api/instances')).body.find((i) => i.id === s.id)?.status;
  await expect.poll(status, { message: 'fixture check: the turn is still running' }).toBe('turn');
  for (const name of ['Show raw text', 'Copy message', 'Read aloud']) await expect(control(page, name), `${name}, during the running turn`).toBeEnabled();

  await copy(page);
  // The announcement lasts only the flash, so it is read first; the clipboard keeps its value.
  await expect(copyAnnouncement(page), 'the copy is announced').toHaveText(/copied/i);
  await expect.poll(() => clipboard(page), { message: 'copy hands over the source streamed so far' }).toBe(COPY_STREAMING);
  await expect(control(page, 'Copy message'), 'the button keeps its name').toHaveCount(1);

  await control(page, 'Show raw text').click();
  await expect(control(page, 'Show rendered markdown'), 'the toggle now offers the rendered view').toHaveCount(1);
  await expect(bubble(page), 'the finished block shows its source').toContainText('Intro with **one**');
  await release(page, cc, s);
  await expect(bubble(page), 'the block that was streaming finishes raw').toContainText('Streamed **so far** and done.');
  await copy(page);
  await expect.poll(() => clipboard(page), { message: 'copy takes the whole text once the block has finished' }).toBe(COPY_FINISHED);
}

export async function controlsReturnFlow({ page, cc }: Args): Promise<void> {
  // Invariant: read-aloud stays through switching the bubble to raw and back; the raw view the reader set survives a full-page view; a reload's replay gives the same controls, copy and raw view as the live stream.
  fakeOnly(cc);
  const s = await heldRun(page, cc, 'return');
  await release(page, cc, s);
  await expect(bubble(page), 'precondition: the bubble renders its markdown').not.toContainText('**');
  await expect(control(page, 'Read aloud'), 'each of its two finished blocks offers read-aloud').toHaveCount(2);

  await control(page, 'Show raw text').click();
  await expect(bubble(page), 'fixture check: the bubble shows its source').toContainText('Streamed **so far** and done.');
  await expect(control(page, 'Read aloud'), 'read-aloud on each block, after switching to raw').toHaveCount(2);
  await next.openSettings(page);
  await next.leaveSettings(page);
  await expect(next.turnEnds(page), 'fixture check: the transcript is back').toHaveCount(1);
  await expect(control(page, 'Show rendered markdown'), 'the raw view, through a full-page view').toHaveCount(1);
  await expect(bubble(page)).toContainText('Streamed **so far** and done.');
  await control(page, 'Show rendered markdown').click();
  await expect(bubble(page), 'back to the rendered view').not.toContainText('**');
  await expect(control(page, 'Read aloud'), 'read-aloud on each block, after switching back').toHaveCount(2);

  await page.reload();
  await expect(next.turnEnds(page), 'fixture check: the replayed transcript').toHaveCount(1);
  await copy(page);
  await expect.poll(() => clipboard(page), { message: "the replay's copy is the live stream's" }).toBe(COPY_FINISHED);
  await control(page, 'Show raw text').click();
  await expect(bubble(page), "the replay's raw view").toContainText('Intro with **one**');
  await expect(bubble(page)).toContainText('Streamed **so far** and done.');
}

// ── read-aloud per text block ────────────────────────────────────────────

export async function blockReadAloudFlow({ page, cc }: Args): Promise<void> {
  // Invariant: every finished text block of the bubble has a read-aloud of its own, placed with that block, that sends that block's text to be spoken; a block still streaming has none.
  fakeOnly(cc);
  const bodies = await speechSeam(page);
  const s = await heldRun(page, cc, 'speak');
  await expect(control(page, 'Read aloud'), 'positive control: while the second block streams, only the finished first one offers read-aloud').toHaveCount(1);
  await bubble(page).hover();
  await control(page, 'Read aloud').click();
  await expect.poll(() => bodies.length, { message: 'positive control: the tap reached the speech seam' }).toBe(1);
  expect(bodies[0], 'it reads the finished block').toMatch(/Intro with/);
  expect(bodies[0], 'and not the one still streaming').not.toMatch(/Streamed/);

  await release(page, cc, s);
  await expect(control(page, 'Read aloud'), 'each finished block has a read-aloud of its own').toHaveCount(2);
  await expect(textBlocks(page), 'fixture check: the bubble holds its two text blocks').toHaveCount(2);
  const reads: [RegExp, RegExp][] = [[/Intro with/, /Streamed/], [/Streamed so far and done/, /Intro with/]];
  for (const [i, [own, other]] of reads.entries()) {
    const button = textBlocks(page).nth(i).getByRole('button', { name: 'Read aloud', exact: true });
    await expect(button, `block ${i + 1} holds its own read-aloud`).toHaveCount(1);
    await bubble(page).hover();
    await button.click();
    await expect.poll(() => bodies.length, { message: `block ${i + 1}'s tap reached the speech seam` }).toBe(i + 2);
    expect(bodies[i + 1], `block ${i + 1}'s control reads that block`).toMatch(own);
    expect(bodies[i + 1], `and not the other`).not.toMatch(other);
  }
}

// ── queued messages across a usage-window reset ──────────────────────────

const queued = (text: string) => ({ kind: 'overage_message_queued', data: { text, attachmentCount: 0, ts: Date.now(), queuedCount: 1 } });

export async function queuedGhostsFlow({ page, cc }: Args): Promise<void> {
  // Invariant: messages queued while the usage window is spent show as ghosts; the window reset keeps each on screen, marked delivered, above the reset line and the delivered turn; a message queued after it is a ghost that is not delivered.
  fakeOnly(cc);
  // A real overage queue needs the account-usage monitor, so the server's frames for one are sent into the page's own socket.
  const socket: { route: WebSocketRoute | null } = { route: null };
  await page.routeWebSocket(/\/ws$/, (ws) => { ws.connectToServer(); socket.route = ws; });
  const project = label('queued');
  await createProject(cc, project);
  await next.open(page);
  await next.startSessionIn(page, project);
  await next.sendPrompt(page, 'a prompt before the window is spent');
  await expect(next.turnEnds(page), 'fixture check: the first turn ended').toHaveCount(1);
  const s = await instanceIn(cc, project);
  const frame = (ev: object) => {
    if (!socket.route) throw new Error("fixture check: the page's socket was routed");
    socket.route.send(JSON.stringify({ t: 'event', id: s.id, ev }));
  };
  const transcript = next.transcript(page);
  const ghosts = transcript.locator('[data-item=queued]');
  const delivered = transcript.locator('[data-item=queued][data-delivered]');

  frame(queued('QUEUED-ONE'));
  frame(queued('QUEUED-TWO'));
  await expect(ghosts, 'precondition: both queued messages show as ghosts').toHaveText([/QUEUED-ONE/, /QUEUED-TWO/]);
  await expect(delivered, 'precondition: neither is delivered').toHaveCount(0);

  frame({ kind: 'system', subtype: 'auto_resume', data: { count: 2 } });
  await expect(transcript.locator('[data-subtype=auto_resume]'), 'positive control: the window-reset line').toBeVisible();
  await expect(ghosts, 'both ghosts stay with their text').toHaveText([/QUEUED-ONE/, /QUEUED-TWO/]);
  for (const ghost of await ghosts.all()) await expect(ghost, 'a delivered ghost stays on screen').toBeVisible();
  await expect(delivered, 'each is marked delivered').toHaveCount(2);

  await next.sendPrompt(page, 'QUEUED-ONE and QUEUED-TWO, delivered');
  await expect(next.turnEnds(page), 'fixture check: the delivered turn ended').toHaveCount(2);
  const kinds = await transcript.locator('[data-item=user], [data-item=queued], [data-subtype=auto_resume]')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.item ?? (el as HTMLElement).dataset.subtype));
  expect(kinds, 'the ghosts sit above the reset line and the delivered turn').toEqual(['user', 'queued', 'queued', 'auto_resume', 'user']);

  frame(queued('QUEUED-THREE'));
  await expect(ghosts).toHaveText([/QUEUED-ONE/, /QUEUED-TWO/, /QUEUED-THREE/]);
  await expect(ghosts.last(), 'a message queued after the reset is not delivered').not.toHaveAttribute('data-delivered');
  await expect(delivered, 'the earlier two stay delivered').toHaveCount(2);
}
