// The transcript's scroll position in a real browser: stuck to the bottom
// for live output, left alone once scrolled up, the bottom again after a rewind,
// the reader's place again after a full-page view, an older page spliced above
// without moving what the reader sees, a real multi-segment lineage walk, and a
// reply streaming under a reader who holds or drags the transcript
// (dragWhileStreamingFlow, on fixtures/scenario-conversation-stream-scroll.json), and a view
// that shortens with no frame (viewShrinkFollowedFlow, viewShrinkScrolledUpFlow).
// The bodies are shared by the per-project spec files; this module declares no tests.
import type { Locator, Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { api, createProject, mcpCall } from './harness/api.ts';
import { resumeSeeded, seedTurns, type SeedSegment } from './harness/lineage.ts';
import { next } from './flows/ui.ts';
import { bringTo, offsetFromTop, sendAll, tallPrompt } from './flows/stickyPin.ts';
import { instanceIn, reselect } from './flows/questionCard.ts';

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

// ── sticking to the bottom ───────────────────────────────────────────────

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

// ── returning from a full-page view ──────────────────────────────────────

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

// ── rewind from a scrolled-up prompt ─────────────────────────────────────

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

// ── the lineage walk ─────────────────────────────────────────────────────

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

// ── holding and dragging while output streams ────────────────────────────

/** ConversationView's NEAR_BOTTOM_PX: further than this from the bottom, Jump to latest shows. */
const NEAR_BOTTOM_PX = 50;
/** ConversationView's AT_BOTTOM_PX: within this of the bottom, following resumes. */
const AT_BOTTOM_PX = 2;

/** The transcript's scrollTop once it has held still for three animation frames. */
const settledTop = (transcript: Locator) => transcript.evaluate((s) => new Promise<number>((resolve) => {
  let last = s.scrollTop;
  let still = 0;
  const tick = () => {
    const now = s.scrollTop;
    still = now === last ? still + 1 : 0;
    last = now;
    if (still >= 3) resolve(now); else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}));

/**
 * A real finger over the transcript, clear of the pin at its top and Jump to latest at its bottom.
 * CDP touch points stay down between Input.dispatchTouchEvent calls, so a frame can land while it is held.
 */
async function fingerOn(page: Page, transcript: Locator) {
  const box = await transcript.boundingBox();
  if (!box) throw new Error('fingerOn: the transcript has no box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height * 0.55;
  const cdp = await page.context().newCDPSession(page);
  const send = (type: string, at?: number) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: at === undefined ? [] : [{ x, y: at }] } as never);
  return {
    down: () => send('touchStart', y),
    /** Moves the finger down by `dy` px in `steps` moves: the content scrolls up. */
    drag: async (dy: number, steps: number) => { for (let i = 1; i <= steps; i++) await send('touchMove', y + (dy * i) / steps); },
    up: () => send('touchEnd'),
    detach: () => cdp.detach(),
  };
}

export async function dragWhileStreamingFlow({ page, cc }: Args): Promise<void> {
  // Invariant: while a reply streams, a reader holding or dragging the transcript is never moved: a finger held still
  // at the bottom catches up once on lifting, a drag up of any size stops following, and Jump to latest resumes it.
  test.skip(cc.engine === 'live', "the flow drives the fake engine's stream-scroll scenario");
  const project = label('stream');
  await createProject(cc, project);
  await next.open(page);
  await next.startSessionIn(page, project);
  const inst = await instanceIn(cc, project);
  const transcript = next.transcript(page);
  await next.sendPrompt(page, 'SCROLL-STREAM drag me');
  await expect(transcript.getByText('stream line 59'), 'fixture check: the held reply streamed its opening').toBeAttached();
  await expectAtBottom(page, transcript, 'as the reply streams');

  /** Releases the scenario's next held frame: it answers each permission-mode change with the next part of the turn. */
  const release = async () => {
    const listed = (await api<{ id: string; mode: string }[]>(cc, 'GET', '/api/instances')).body.find((i) => i.id === inst.id);
    await mcpCall(cc, 'set_mode', { sessionId: inst.sessionId, mode: listed?.mode ?? 'default' });
  };
  /** Releases frame `k` and waits for it to render: the view's layout effect ran in the same commit. */
  const frame = async (k: number) => {
    await release();
    await expect(transcript.getByText(`STREAM-FRAME-${k}`)).toBeAttached();
  };
  /** The transcript settles within 1px of `top`. */
  const stays = async (top: number, what: string) => expect(Math.abs(await settledTop(transcript) - top), what).toBeLessThanOrEqual(1);

  if (test.info().project.use.hasTouch) {
    const finger = await fingerOn(page, transcript);
    try {
      // Held still at the bottom.
      const before = await settledTop(transcript);
      await finger.down();
      await frame(1);
      await stays(before, 'a frame landing under a resting finger moves nothing');
      await expect(jumpToLatest(page)).toBeVisible();
      await finger.up();
      await expect.poll(() => fromBottom(transcript), { message: 'lifting catches up to the bottom' }).toBeLessThanOrEqual(1);
      await expect(jumpToLatest(page)).toBeHidden();

      // A slow drag up, inside the affordance band.
      await finger.down();
      await finger.drag(40, 8);
      const dragged = await settledTop(transcript);
      const off = await fromBottom(transcript);
      expect(off > AT_BOTTOM_PX && off < NEAR_BOTTOM_PX, `fixture check: the drag ended inside the affordance band (${off}px from the bottom); retune its travel`).toBe(true);
      await frame(2);
      await stays(dragged, 'a frame landing under a finger that dragged up moves nothing');
      await expect(jumpToLatest(page)).toBeVisible();
      await finger.up();
      await frame(3);
      await stays(dragged, 'after lifting, a reader who dragged up stays where they dragged to');
    } finally {
      await finger.detach();
    }

    await jumpToLatest(page).tap();
    await expect.poll(() => fromBottom(transcript), { message: 'Jump to latest lands on the bottom' }).toBeLessThanOrEqual(1);
    await frame(4);
    await expect.poll(() => fromBottom(transcript), { message: 'and keeps following' }).toBeLessThanOrEqual(1);
    await expect(jumpToLatest(page)).toBeHidden();
  } else {
    const box = await transcript.boundingBox();
    if (!box) throw new Error('dragWhileStreamingFlow: the transcript has no box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.55);
    await page.mouse.wheel(0, -30);
    const nudged = await settledTop(transcript);
    const off = await fromBottom(transcript);
    expect(off > AT_BOTTOM_PX && off < NEAR_BOTTOM_PX, `fixture check: the wheel ended inside the affordance band (${off}px from the bottom)`).toBe(true);
    await frame(1);
    await stays(nudged, 'a frame after a small wheel up moves nothing');
    await expect(jumpToLatest(page)).toBeVisible();
    await jumpToLatest(page).click();
    await expect.poll(() => fromBottom(transcript), { message: 'Jump to latest lands on the bottom' }).toBeLessThanOrEqual(1);
    for (const k of [2, 3, 4]) {
      await frame(k);
      await expect.poll(() => fromBottom(transcript), { message: `following after frame ${k}` }).toBeLessThanOrEqual(1);
    }
    await expect(jumpToLatest(page)).toBeHidden();
  }

  await release();
  await expect(next.turnEnds(page), 'fixture check: the last release ends the turn').toHaveCount(1);
}

// ── the view shortening with no frame ────────────────────────────────────

/** Two tall prompts sent in a new project, the transcript at its bottom. */
async function shrinkFixture(page: Page, cc: Cc, what: string): Promise<{ transcript: Locator; clientHeight: () => Promise<number> }> {
  const project = label(what);
  await createProject(cc, project);
  await next.open(page);
  await next.startSessionIn(page, project);
  const transcript = next.transcript(page);
  await sendAll(page, next, [tallPrompt('SHRINK-ALPHA'), tallPrompt('SHRINK-BRAVO')]);
  await expectAtBottom(page, transcript, 'before the view shortens');
  return { transcript, clientHeight: () => transcript.evaluate((s) => s.clientHeight) };
}

/** Shortens the page's viewport by 120px, as the soft keyboard or a growing composer shortens the transcript's view. */
async function shortenView(page: Page, clientHeight: () => Promise<number>): Promise<void> {
  const before = await clientHeight();
  const size = page.viewportSize();
  if (!size) throw new Error('shortenView: the page has no viewport size');
  await page.setViewportSize({ width: size.width, height: size.height - 120 });
  await expect.poll(clientHeight, { message: 'fixture check: the transcript view shortened' }).toBeLessThan(before - 100);
}

export async function viewShrinkScrolledUpFlow({ page, cc }: Args): Promise<void> {
  // Invariant: a reader scrolled up is not moved when the transcript's view shortens.
  const { transcript, clientHeight } = await shrinkFixture(page, cc, 'shrink-up');
  await bringTo(transcript, next.userMessages(page).first(), 40);
  await expect(jumpToLatest(page), 'precondition: scrolled up').toBeVisible();
  const before = await settledTop(transcript);
  await shortenView(page, clientHeight);
  expect(Math.abs(await settledTop(transcript) - before), 'a reader scrolled up stays where they were as the view shortens').toBeLessThanOrEqual(1);
  await expect(jumpToLatest(page)).toBeVisible();
}

export async function viewShrinkFollowedFlow({ page, cc }: Args): Promise<void> {
  // Invariant: a followed transcript keeps its bottom as the view shortens (the soft keyboard, the composer growing).
  const { transcript, clientHeight } = await shrinkFixture(page, cc, 'shrink-follow');
  await shortenView(page, clientHeight);
  await expect.poll(() => fromBottom(transcript), { message: 'a followed transcript keeps its bottom as the view shortens' }).toBeLessThanOrEqual(1);
  await expect(jumpToLatest(page)).toBeHidden();
}
