// The /next/ transcript's machinery in a real browser, on the fake engine's
// machinery scenario (fixtures/scenario-conversation-machinery.json): a run held
// open mid-turn and the run-enders that fold it, tool-card bodies and the Agent
// card's subagent total, the per-call usage lines and the Statistics box that shows
// them, and the context reading a rewind's replay re-sends.
// The bodies are shared by the per-project spec files; this module declares no tests.
import type { Locator, Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { api, createProject, mcpCall } from './harness/api.ts';
import { resumeSeeded, type SeedRecord } from './harness/lineage.ts';
import { next } from './flows/ui.ts';
import { instanceIn } from './flows/questionCard.ts';

type Args = { page: Page; cc: Cc };
type Session = { project: string; id: string; sessionId: string };

/** The scenario turn this prompt text starts: an Agent call whose sub-agent is mid-Read, held until the release. */
const HOLD = 'MACHINERY-HOLD';

const label = (what: string) => `machinery-${what}-${test.info().project.name}`;
const fakeOnly = (cc: Cc) => test.skip(cc.engine === 'live', "the flows drive the fake engine's machinery scenario");

/** Starts a session in a new project and sends the held run's prompt. */
async function heldRun(page: Page, cc: Cc, what: string, opts: { temp?: boolean } = {}): Promise<Session> {
  const project = label(what);
  await createProject(cc, project);
  await next.open(page);
  await next.startSessionIn(page, project, opts);
  await next.sendPrompt(page, `${HOLD} ${what}`);
  await expect(agentTrigger(page), 'fixture check: the held run is on screen').toBeVisible();
  return { project, ...(await instanceIn(cc, project)) };
}

/** Lets a held run finish: its scenario answers the session's first permission-mode change with the rest of the turn. */
export async function release(page: Page, cc: Cc, s: Session): Promise<void> {
  const listed = (await api<{ id: string; mode: string }[]>(cc, 'GET', '/api/instances')).body.find((i) => i.id === s.id);
  await mcpCall(cc, 'set_mode', { sessionId: s.sessionId, mode: listed?.mode ?? 'default' });
  await expect(next.turnEnds(page), 'fixture check: the held run ended its turn').toHaveCount(1);
}

const cardTrigger = (page: Page, name: string) =>
  next.transcript(page).locator('[data-tool-trigger]').filter({ has: page.locator(`[data-tool-name="${name}"]`) });
const agentTrigger = (page: Page) => cardTrigger(page, 'Agent');
/** The Agent card: its trigger, its content and its sub-agent section. */
const agentCard = (page: Page) => agentTrigger(page).locator('xpath=..');
/** The outer run's group: the first group in the transcript (a sub-agent's sits inside it). */
const outerGroup = (page: Page) => next.transcript(page).locator('[data-group-trigger]').first();
const subGroup = (page: Page) => agentCard(page).locator('[data-group-trigger]');
const agentTotal = (page: Page) => agentTrigger(page).locator('[data-agent-usage]');
export const usageLines = (page: Page) => next.transcript(page).locator('[data-call-usage-line]');
const openOf = (details: Locator) => details.evaluate((d) => (d as HTMLDetailsElement).open);

async function openOuterGroup(page: Page): Promise<void> {
  await expect(outerGroup(page), 'fixture check: the run folded as its turn ended').toHaveAttribute('data-state', 'closed');
  await outerGroup(page).click();
  await expect(outerGroup(page)).toHaveAttribute('data-state', 'open');
}

async function expectAgentTotalShown(page: Page, when: string): Promise<void> {
  await expect(agentTotal(page), `fixture check: the Agent card carries its total (${when})`).toHaveCount(1);
  await expect(agentTotal(page), `the Agent card's subagent total is shown (${when})`).toBeVisible();
}

/** The session header's "Show mid-turn statistics" item, read or flipped with its menu closed again. */
export async function statisticsItem(page: Page, flip: boolean): Promise<string | null> {
  await next.sessionHeader(page).getByRole('button', { name: 'Session actions' }).click();
  const item = page.getByRole('menuitemcheckbox', { name: 'Show mid-turn statistics' });
  if (flip) await item.click();
  const checked = await item.getAttribute('aria-checked');
  await page.keyboard.press('Escape');
  await expect(item).toBeHidden();
  return checked;
}

async function expectLines(page: Page, shown: boolean, when: string): Promise<void> {
  const lines = usageLines(page);
  expect(await lines.count(), `fixture check: per-call lines are rendered (${when})`).toBeGreaterThan(0);
  for (const line of await lines.all()) {
    if (shown) await expect(line, `shown: ${when}`).toBeVisible();
    else await expect(line, `hidden: ${when}`).toBeHidden();
  }
}

// ── what folds a run ─────────────────────────────────────────────────────

export async function runEndersFlow({ page, cc }: Args): Promise<void> {
  // Invariant: the reader's clicks inside an open run (a card, its Arguments, the sub-agent section) never pin the run open; the turn's end folds it and the sub-agent's own run; Arguments the reader opened survive the card's re-render by its result.
  fakeOnly(cc);
  const s = await heldRun(page, cc, 'run-enders');
  await expect(outerGroup(page), 'precondition: the run is open while it collects').toHaveAttribute('data-state', 'open');
  await expect(subGroup(page), "precondition: the sub-agent's run is open while it runs").toHaveAttribute('data-state', 'open');

  await agentTrigger(page).click();
  await agentCard(page).locator('[data-tool-args] > summary').click();
  const sub = agentCard(page).locator('[data-sub-trigger]');
  await sub.click();
  await sub.click();
  await expect(agentTrigger(page), 'fixture check: the card opened').toHaveAttribute('data-state', 'open');
  await expect.poll(() => openOf(agentCard(page).locator('[data-tool-args]')), { message: 'fixture check: Arguments opened' }).toBe(true);
  await expect(sub, 'fixture check: the sub-agent section is open again').toHaveAttribute('data-state', 'open');

  await release(page, cc, s);
  await expect(outerGroup(page), "the run's end folds the run the reader clicked inside").toHaveAttribute('data-state', 'closed');
  await outerGroup(page).click();
  await expect(subGroup(page), "the turn's end folds the sub-agent's run too").toHaveAttribute('data-state', 'closed');
  await expect(agentTrigger(page)).toHaveAttribute('data-state', 'open');
  expect(await openOf(agentCard(page).locator('[data-tool-args]')), 'the Arguments the reader opened, through the result').toBe(true);
}

// ── tool cards ───────────────────────────────────────────────────────────

export async function toolCardsFlow({ page, cc }: Args): Promise<void> {
  // Invariant: a system_bash card summarises its description and shows its command; an Agent card shows its subagent total on every viewport, inside the transcript, through closing and reopening the card and a full-page view; each per-call line carries an explaining tooltip.
  fakeOnly(cc);
  const s = await heldRun(page, cc, 'tool-cards');
  await release(page, cc, s);
  await openOuterGroup(page);

  const sbash = cardTrigger(page, 'mcp__code-conductor__system_bash');
  await expect(sbash).toContainText('Check the git version');
  await expect(sbash).not.toContainText('git --version');
  await sbash.click();
  const sbashCard = sbash.locator('xpath=..');
  await expect(sbashCard.getByRole('button', { name: 'Copy command' })).toBeAttached();
  await expect(sbashCard.locator('pre').first()).toHaveText('git --version');
  await expect(sbashCard.locator('[data-tool-args]')).toHaveCount(0);

  await expectAgentTotalShown(page, 'after the result');
  // The total takes room of its own: the call's description stays on screen and the tool's name stays whole.
  await expect(agentTrigger(page).locator('[data-tool-desc]'), "the Agent call's description is still shown beside its total").toBeVisible();
  expect(await agentTrigger(page).locator('[data-tool-name]').evaluate((n) => { const label = n.lastElementChild as HTMLElement; return label.scrollWidth - label.clientWidth; }), "the tool's name is not cut short by its total").toBe(0);
  // Guards: the total lies whole inside its card row, and nothing reaches past the transcript or the page.
  expect(await agentTrigger(page).evaluate((row) => {
    const total = row.querySelector('[data-agent-usage]') as HTMLElement;
    const t = total.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    return t.left >= r.left - 0.5 && t.right <= r.right + 0.5 && total.scrollWidth <= total.clientWidth;
  }), 'guard: the total lies whole inside its card row').toBe(true);
  expect(await next.transcript(page).evaluate((t) => t.scrollWidth - t.clientWidth), 'guard: nothing past the transcript').toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 'guard: nothing past the page').toBe(0);
  await agentTrigger(page).click();
  await agentTrigger(page).click();
  await expect(agentTrigger(page), 'fixture check: closed again').toHaveAttribute('data-state', 'closed');
  await expectAgentTotalShown(page, 'after closing and reopening the card');
  await next.openSettings(page);
  await next.leaveSettings(page);
  await expect(next.turnEnds(page), 'fixture check: the transcript is back').toHaveCount(1);
  await expectAgentTotalShown(page, 'after a full-page view');

  expect(await usageLines(page).count(), 'fixture check: per-call lines are rendered (tooltips)').toBeGreaterThan(0);
  for (const line of await usageLines(page).all()) await expect(line, 'a per-call line explains itself').toHaveAttribute('title', /\S/);
}

// ── per-call statistics ──────────────────────────────────────────────────

export async function statisticsFlow({ page, cc }: Args): Promise<void> {
  // Invariant: the per-call lines are hidden until the session's Statistics box is ticked, per session, through a respawn, whatever debug capture does; the turn footer and the Agent total show either way.
  fakeOnly(cc);
  // B's project exists before the page loads: the sidebar lists the projects it loaded with.
  const b = label('stats-b');
  await createProject(cc, b);
  const a = await heldRun(page, cc, 'stats-a', { temp: false });
  await release(page, cc, a);
  await openOuterGroup(page);
  await expectLines(page, false, 'by default');
  expect(await statisticsItem(page, false), 'the box starts unticked').toBe('false');
  await expect(next.turnEnds(page)).toBeVisible();
  await expectAgentTotalShown(page, 'lines hidden');

  expect(await statisticsItem(page, true), 'ticked').toBe('true');
  await expectLines(page, true, 'ticked from the session menu');
  await expect(next.turnEnds(page)).toBeVisible();
  await expectAgentTotalShown(page, 'lines shown');
  const dialog = await next.openSessionDialog(page, 'stats');
  await expect(dialog.getByRole('checkbox', { name: 'Show mid-turn statistics' }), 'the dialog shows the same tick').toHaveAttribute('aria-checked', 'true');
  await next.closeSessionDialog(dialog);

  await next.startSessionIn(page, b);
  await next.sendPrompt(page, 'a plain prompt');
  await expect(next.turnEnds(page), 'fixture check: B answered').toHaveCount(1);
  await expectLines(page, false, 'B, never ticked');
  expect(await statisticsItem(page, false), 'B is unticked').toBe('false');

  const rowA = await next.sessionRow(page, a.project, a.sessionId);
  await rowA.click();
  await expect(next.turnEnds(page), 'fixture check: A is back').toHaveCount(1);
  await openOuterGroup(page);
  await expectLines(page, true, 'back on A');

  const stats = await next.openSessionDialog(page, 'stats');
  await stats.getByRole('checkbox', { name: 'Show mid-turn statistics' }).click();
  await next.closeSessionDialog(stats);
  await expectLines(page, false, 'unticked in the dialog');
  await next.sessionHeader(page).getByRole('button', { name: 'Session actions' }).click();
  await page.getByRole('menuitem', { name: 'Start debug capture' }).click();
  await expect.poll(async () => (await api<{ id: string; debug?: boolean }[]>(cc, 'GET', '/api/instances')).body.find((i) => i.id === a.id)?.debug, { message: 'fixture check: debug capture is on' }).toBe(true);
  await expectLines(page, false, 'debug capture on');
  expect(await statisticsItem(page, true), 'ticked again').toBe('true');
  await expectLines(page, true, 'ticked with debug capture on');

  await next.terminate(page, true);
  await next.resumeButton(page).click();
  await expect(next.resumeButton(page), 'fixture check: respawned').toBeHidden();
  expect(await statisticsItem(page, false), 'the tick follows the session through the respawn').toBe('true');
  await next.sendPrompt(page, 'a prompt after the respawn');
  await expect(usageLines(page), "fixture check: the respawned session's call").toHaveCount(1);
  await expectLines(page, true, 'after the respawn');
}

// ── the replayed context reading ─────────────────────────────────────────

/** `n` prompt/reply turns whose replies carry usage: reply i's prompt is 46,398 + 1,000·i tokens. */
function readingTurns(n: number): SeedRecord[] {
  const out: SeedRecord[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ type: 'user', uuid: `ctx-u${i}`, message: { role: 'user', content: `ctx prompt ${i}` } });
    out.push({ type: 'assistant', uuid: `ctx-a${i}`, message: {
      id: `ctx-m${i}`, role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: `ctx reply ${i}` }],
      usage: { input_tokens: 2, cache_read_input_tokens: 46_396 + i * 1_000, cache_creation_input_tokens: 0, output_tokens: 50 },
    } });
  }
  return out;
}

export async function replayedReadingFlow({ page, cc }: Args): Promise<void> {
  // Invariant: the reading a rewind's replay re-sends (a message_start reusing the newest replayed message id) moves the header's context reading and adds nothing to the transcript.
  fakeOnly(cc);
  const project = label('reading');
  await createProject(cc, project);
  const starts: { msgId?: string; replayed?: boolean }[] = [];
  page.on('websocket', (ws) => ws.on('framereceived', (f) => {
    const frame = JSON.parse(String(f.payload)) as { t?: string; ev?: { kind?: string; msgId?: string; replayed?: boolean } };
    if (frame.t === 'event' && frame.ev?.kind === 'message_start') starts.push(frame.ev);
  }));
  const publicId = 'c7a00001';
  const inst = await resumeSeeded(cc, project, publicId, [
    { id: `${publicId}-0000-4000-8000-000000000001`, reason: 'initial', records: readingTurns(3) },
  ]);
  await next.open(page);
  const row = await next.sessionRow(page, project, inst.sessionId);
  await expect(row).toHaveCount(1);
  await row.click();
  const prompts = next.userMessages(page);
  await expect(prompts).toHaveCount(3);
  const chip = page.locator('[data-usage-chip]');
  await expect(chip, "precondition: the header reads the newest reply's reading").toHaveAttribute('title', /48,398/);

  const target = prompts.filter({ hasText: /^ctx prompt 2$/ });
  await target.hover();
  await next.bubbleAction(target, 'rewind').click();
  const dialog = page.getByRole('dialog', { name: 'Rewind to here?' });
  await dialog.getByRole('button', { name: 'Rewind', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(prompts, 'fixture check: the rewind cut the transcript at that prompt').toHaveCount(2);
  await expect.poll(() => starts.filter((e) => e.replayed === true && e.msgId === 'ctx-m1').length, { message: "fixture check: the replay re-sent reply 1's reading on its message id" }).toBe(1);
  await expect(chip, 'positive control: the header took the re-sent reading').toHaveAttribute('title', /47,398/);
  await expect(next.transcript(page).locator('[data-item=assistant]')).toHaveText([/ctx reply 0/, /ctx reply 1/]);
}
