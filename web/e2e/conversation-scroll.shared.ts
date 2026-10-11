// The /next/ transcript's scroll position in a real browser: stuck to the bottom
// for live output, left alone once scrolled up, the bottom again after a rewind,
// the reader's place again after a full-page view, an older page spliced above
// without moving what the reader sees, and a real multi-segment lineage walk.
// The bodies are shared by the per-project spec files; this module declares no tests.
import type { Locator, Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { createProject, mcpCall } from './harness/api.ts';
import { resumeSeeded, seedTurns, type SeedSegment } from './harness/lineage.ts';
import { next } from './parity/ui.ts';
import { bringTo, offsetFromTop, sendAll, tallPrompt } from './parity/stickyPin.ts';
import { instanceIn, reselect } from './parity/questionCard.ts';

type Args = { page: Page; cc: Cc };
type LineagePage = { hasMore: boolean; events: { kind: string; text?: string }[] };

const label = (what: string) => `scroll-${what}-${test.info().project.name}`;
const jumpToLatest = (page: Page) => page.getByRole('button', { name: 'Jump to latest' });
/** How far the transcript sits above its bottom, in px. */
const fromBottom = (transcript: Locator) => transcript.evaluate((s) => s.scrollHeight - s.clientHeight - s.scrollTop);

async function expectAtBottom(page: Page, transcript: Locator, what: string): Promise<void> {
  expect(await transcript.evaluate((s) => s.scrollHeight - s.clientHeight), `fixture check: the transcript overflows (${what})`).toBeGreaterThan(0);
  await expect.poll(() => fromBottom(transcript), { message: `at the bottom: ${what}` }).toBeLessThanOrEqual(1);
  await expect(jumpToLatest(page)).toBeHidden();
}

/** A four-segment lineage for `publicId`: initial, a tombstoned renew, its prune, and the current renew. */
function chain(publicId: string): SeedSegment[] {
  const id = (n: number) => `${publicId}-0000-4000-8000-00000000000${n}`;
  return [
    { id: id(1), reason: 'initial', records: seedTurns('alpha', 25) },
    { id: id(2), reason: 'renew', records: seedTurns('bravo', 25), dropped: true },
    { id: id(3), reason: 'prune', records: seedTurns('charlie', 25) },
    { id: id(4), reason: 'renew', records: seedTurns('delta', 60) },
  ];
}

/** Opens `project`'s seeded session `sessionId` from its sidebar row. */
async function openSeeded(page: Page, project: string, sessionId: string): Promise<void> {
  await next.open(page);
  const row = await next.sessionRow(page, project, sessionId);
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(next.userMessages(page).first()).toBeVisible();
}

/** Collects every lineage page the session's transcript fetches, in order. */
function lineagePages(page: Page, instanceId: string): Promise<LineagePage>[] {
  const bodies: Promise<LineagePage>[] = [];
  const route = `/api/instances/${encodeURIComponent(instanceId)}/lineage-events`;
  page.on('response', (r) => { if (r.url().includes(route)) bodies.push(r.json() as Promise<LineagePage>); });
  return bodies;
}

// ── conversation-scroll-batch/R1 ─────────────────────────────────────────

export async function stickFlow({ page, cc }: Args): Promise<void> {
  // Invariant: live output keeps a reader at the bottom there; a reader scrolled up stays put through it; re-opening the session lands at the bottom.
  const project = label('stick');
  await createProject(cc, project);
  await next.open(page);
  await next.startSessionIn(page, project);
  const inst = await instanceIn(cc, project);
  const transcript = next.transcript(page);
  await sendAll(page, next, [tallPrompt('STICK-ALPHA'), tallPrompt('STICK-BRAVO')]);
  await expectAtBottom(page, transcript, 'after the reader\'s own prompts');

  await mcpCall(cc, 'send_prompt', { sessionId: inst.sessionId, text: tallPrompt('STICK-CHARLIE') });
  await expect(next.turnEnds(page)).toHaveCount(3);
  await expectAtBottom(page, transcript, 'after a prompt from outside the composer');

  const bravo = next.userMessages(page).nth(1);
  await bringTo(transcript, bravo, 40);
  await expect(jumpToLatest(page), 'precondition: scrolled up').toBeVisible();
  const before = await offsetFromTop(transcript, bravo);
  await mcpCall(cc, 'send_prompt', { sessionId: inst.sessionId, text: tallPrompt('STICK-DELTA') });
  await expect(next.turnEnds(page)).toHaveCount(4);
  expect(Math.abs(await offsetFromTop(transcript, bravo) - before), 'the prompt being read stays where it was').toBeLessThanOrEqual(1);
  await expect(jumpToLatest(page)).toBeVisible();

  await reselect(page, next, project, inst.sessionId);
  await expectAtBottom(page, transcript, 'after the session is opened again from its snapshot');
}

// ── conversation-view-return/R1 ──────────────────────────────────────────

export async function viewReturnFlow({ page, cc }: Args): Promise<void> {
  // Invariant: leaving a full-page view puts the transcript back where the reader left it — scrolled up stays on the prompt being read, at the bottom stays at the (new) bottom.
  const project = label('return');
  await createProject(cc, project);
  await next.open(page);
  await next.startSessionIn(page, project);
  const inst = await instanceIn(cc, project);
  const transcript = next.transcript(page);
  await sendAll(page, next, [tallPrompt('RETURN-ALPHA'), tallPrompt('RETURN-BRAVO')]);

  const bravo = next.userMessages(page).nth(1);
  await bringTo(transcript, bravo, 40);
  await expect(jumpToLatest(page), 'precondition: scrolled up').toBeVisible();
  const left = await offsetFromTop(transcript, bravo);
  await next.openSettings(page);
  await mcpCall(cc, 'send_prompt', { sessionId: inst.sessionId, text: tallPrompt('RETURN-AWAY') });
  await next.leaveSettings(page);
  await expect(next.turnEnds(page)).toHaveCount(3);
  expect(Math.abs(await offsetFromTop(transcript, bravo) - left), 'back on the prompt being read').toBeLessThanOrEqual(1);
  await expect(jumpToLatest(page)).toBeVisible();

  await transcript.evaluate((s) => { s.scrollTop = s.scrollHeight; });
  await expect(jumpToLatest(page), 'precondition: back at the bottom').toBeHidden();
  await next.openSettings(page);
  await mcpCall(cc, 'send_prompt', { sessionId: inst.sessionId, text: tallPrompt('RETURN-BOTTOM') });
  await next.leaveSettings(page);
  await expect(next.turnEnds(page)).toHaveCount(4);
  await expectAtBottom(page, transcript, 'a reader who left at the bottom');
}

// ── scroll-anchor/R2 ─────────────────────────────────────────────────────

export async function rewindFlow({ page, cc }: Args): Promise<void> {
  // Invariant: a rewind from a prompt the reader scrolled up to lands them at the bottom of the rewound transcript, following it.
  const project = label('rewind');
  await createProject(cc, project);
  const publicId = '5c0e0001';
  const inst = await resumeSeeded(cc, project, publicId, [
    { id: `${publicId}-0000-4000-8000-000000000001`, reason: 'initial', records: seedTurns('echo', 40) },
  ]);
  await openSeeded(page, project, inst.sessionId);
  const prompts = next.userMessages(page);
  await expect(prompts).toHaveCount(40);
  const transcript = next.transcript(page);
  const target = prompts.filter({ hasText: /^echo prompt 30$/ });
  await bringTo(transcript, target, 100);
  await expect(jumpToLatest(page), 'precondition: scrolled up').toBeVisible();

  await target.hover();
  await next.bubbleAction(target, 'rewind').click();
  const dialog = page.getByRole('dialog', { name: 'Rewind to here?' });
  await dialog.getByRole('button', { name: 'Rewind', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(prompts, 'fixture check: the rewind cut the transcript at that prompt').toHaveCount(30);
  await expectAtBottom(page, transcript, 'after the rewind');
}

export async function anchorFlow({ page, cc }: Args): Promise<void> {
  // Invariant: each older page spliced above leaves the prompt the reader was looking at where it was on screen.
  const project = label('anchor');
  await createProject(cc, project);
  const publicId = 'a2c00001';
  const inst = await resumeSeeded(cc, project, publicId, chain(publicId));
  const bodies = lineagePages(page, inst.id);
  await openSeeded(page, project, inst.sessionId);
  await expect.poll(() => bodies.length, { message: 'the snapshot\'s own page' }).toBe(1);
  await Promise.all(bodies);
  const transcript = next.transcript(page);
  const prompts = next.userMessages(page);

  // Hold each page until the reader's place is measured.
  let release: (() => void) | null = null;
  await page.route('**/lineage-events*', async (route) => {
    await new Promise<void>((r) => { release = r; });
    await route.continue();
  });
  for (const tag of ['charlie', 'alpha']) {
    const before = await prompts.count();
    const anchor = prompts.first();
    const text = (await anchor.innerText()).trim();
    await transcript.evaluate((s) => { s.scrollTop = 0; });
    await expect.poll(() => release !== null, { message: `scrolling up asked for the ${tag} page` }).toBe(true);
    const at = await offsetFromTop(transcript, anchor);
    (release as (() => void) | null)?.();
    release = null;
    await expect.poll(() => prompts.count(), { message: `the ${tag} page landed` }).toBeGreaterThan(before);
    await expect(prompts.filter({ hasText: new RegExp(`^${tag} prompt`) }).first()).toBeAttached();
    const same = prompts.filter({ hasText: new RegExp(`^${text}$`) });
    await expect.poll(async () => Math.abs(await offsetFromTop(transcript, same) - at), { message: `"${text}" stays put as the ${tag} page lands` }).toBeLessThanOrEqual(1);
  }
}

// ── lineage-pager/R1 ─────────────────────────────────────────────────────

export async function lineageFlow({ page, cc }: Args): Promise<void> {
  // Invariant: a real lineage walk renders its renew dividers and its gap in order, and only the current segment's prompts offer Rewind and Fork — those paged in from the archive included.
  const project = label('lineage');
  await createProject(cc, project);
  const publicId = '11e00001';
  const inst = await resumeSeeded(cc, project, publicId, chain(publicId));
  const bodies = lineagePages(page, inst.id);
  await openSeeded(page, project, inst.sessionId);
  const transcript = next.transcript(page);
  await expect(async () => {
    await transcript.evaluate((s) => { s.scrollTop = 0; });
    const got = await Promise.all(bodies);
    expect(got.at(-1)?.hasMore, 'paged to the start of the lineage').toBe(false);
  }).toPass({ timeout: 20_000 });

  const walk = await transcript.evaluate((root) => {
    const out: string[] = [];
    for (const n of root.querySelectorAll('[data-divider="seam"], [data-divider="gap"], [data-item="user"] [data-user-text]')) {
      const div = (n as HTMLElement).dataset.divider;
      const tok = div === 'seam' ? '‖' : div === 'gap' ? '⋯' : `[${/^(\w+) prompt \d+$/.exec(n.textContent ?? '')?.[1] ?? '?'}]`;
      if (tok !== out[out.length - 1]) out.push(tok);
    }
    return out.join(' ');
  });
  expect(walk).toBe('[alpha] ‖ ⋯ [charlie] ‖ [delta]');

  const prompts = next.userMessages(page);
  for (const tag of ['alpha', 'charlie']) {
    const older = prompts.filter({ hasText: new RegExp(`^${tag} prompt`) });
    await expect(older).toHaveCount(25);
    await expect(older.getByRole('button', { name: 'Rewind to before this message' }), `${tag}: an earlier segment offers no rewind`).toHaveCount(0);
    await expect(older.getByRole('button', { name: 'Fork a new session from here' }), `${tag}: an earlier segment offers no fork`).toHaveCount(0);
  }
  const current = prompts.filter({ hasText: /^delta prompt/ });
  await expect(current).toHaveCount(60);
  await expect(current.getByRole('button', { name: 'Rewind to before this message' })).toHaveCount(60);
  await expect(current.getByRole('button', { name: 'Fork a new session from here' })).toHaveCount(60);

  const paged = await Promise.all(bodies);
  expect(paged.some((p) => p.events.some((e) => e.kind === 'user_echo' && e.text === 'delta prompt 0')), 'fixture check: the first current prompt came from the archive on a lineage page').toBe(true);
  const first = prompts.filter({ hasText: /^delta prompt 0$/ });
  await expect(next.bubbleAction(first, 'rewind')).toBeEnabled();
  await expect(next.bubbleAction(first, 'fork')).toBeEnabled();
}
