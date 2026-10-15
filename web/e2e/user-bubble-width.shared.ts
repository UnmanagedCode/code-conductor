// User bubbles span the transcript column's content box as the question and plan cards do, whatever
// their length or variant, at every session width and on a phone, and fill a sub-agent panel's content
// box; their attachments start at their text and their controls end at their right edge. The bodies are shared by the per-project
// spec files.
import type { Locator, Page, WebSocketRoute } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { createProject, spawnSession } from './harness/api.ts';
import { next } from './flows/ui.ts';
import { bringTo, reveal, sendAll, tallPrompt } from './flows/stickyPin.ts';
import { askCard, answerCard, instanceIn } from './flows/questionCard.ts';
import { buildWakeStub } from '../../shared/wakeCallback.ts';
import { queued } from './conversation-bubbles.shared.ts';
import { WIDTH_STATES, setWidth, stateKey, stateLabel } from './session-width.shared.ts';

type Ctx = { page: Page; cc: Cc };

const SHORT = 'UBI';
const LONG = tallPrompt('UBI-LONG');
const list = (page: Page) => page.locator('[data-conversation] [data-session-width]').first();
const filePicker = (page: Page) => page.locator('[data-composer] input[type="file"]');

/** The transcript geometry the user items rest on: the column's content box and each user bubble. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element | null | undefined) => (el as HTMLElement).getBoundingClientRect();
    const listEl = document.querySelector('[data-conversation] [data-session-width]') as HTMLElement;
    const lr = listEl.getBoundingClientRect();
    // The right edge of a row's buttons (CopyButton adds an sr-only span beside its button).
    const rightOfButtons = (row: Element | null) => (row ? Math.max(...[...row.querySelectorAll('button')].map((b) => b.getBoundingClientRect().right)) : null);
    const bubbles = [...document.querySelectorAll('[data-item=user]')].map((item) => {
      const box = rect(item.querySelector('[data-user-text]'));
      const md = item.querySelector('[data-user-text] .md') as HTMLElement;
      const first = document.createTreeWalker(md, NodeFilter.SHOW_TEXT).nextNode() ?? md;
      const range = document.createRange();
      range.selectNodeContents(first);
      return {
        tag: (first.textContent ?? '').trim().split(/\s/)[0],
        left: box.left,
        right: box.right,
        width: box.width,
        // The first text node's own extent: what a shrink-to-fit bubble would wrap (a block's rect is its container's width).
        glyphWidth: range.getBoundingClientRect().width,
        actionsRight: rightOfButtons(item.querySelector('[data-user-actions]')),
      };
    });
    return {
      columnLeft: lr.left + parseFloat(getComputedStyle(listEl).paddingLeft),
      columnRight: lr.right - parseFloat(getComputedStyle(listEl).paddingRight),
      bubbles,
    };
  });
}

type Geometry = Awaited<ReturnType<typeof measure>>;

/** The one-word and the long bubble, after the fixture check that both were measured. */
function pair(m: Geometry, where: string) {
  const [short, long] = [m.bubbles.find((b) => b.tag === SHORT), m.bubbles.find((b) => b.tag === 'UBI-LONG')];
  expect(short && long, `${where}: fixture check: both bubbles are measured`).toBeTruthy();
  return { short: short!, long: long! };
}

function expectAligned(m: Geometry, where: string): void {
  for (const b of m.bubbles) {
    expect(Math.abs(b.left - m.columnLeft), `${where}: ${b.tag} starts at the column's content left edge`).toBeLessThanOrEqual(1);
    expect(Math.abs(b.right - m.columnRight), `${where}: ${b.tag} ends at the column's right edge`).toBeLessThanOrEqual(1);
    expect(b.actionsRight, `${where}: ${b.tag}'s action row is measured`).not.toBeNull();
    expect(Math.abs(b.actionsRight! - b.right), `${where}: ${b.tag}'s controls end at its right edge`).toBeLessThanOrEqual(1);
  }
  const { short, long } = pair(m, where);
  expect(Math.abs(short.width - long.width), `${where}: a one-word bubble is as wide as a long one`).toBeLessThanOrEqual(1);
}

async function sendBoth(page: Page, cc: Ctx['cc'], project: string): Promise<void> {
  const { sessionId } = await spawnSession(cc, project);
  await page.goto(`/#session=${sessionId}`);
  await sendAll(page, next, [SHORT, LONG]);
  // The short prompt, its reply's text and action cards on screen together, for the screenshots.
  await bringTo(next.transcript(page), next.userMessages(page).nth(0), 16);
}

/** A computed colour's alpha: `… / a)` (oklch, oklab, color(), modern rgb), legacy `rgba(…, a)`, else opaque. */
function alphaOf(colour: string): number {
  const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(colour);
  if (slash) return Number(slash[1]) / (slash[2] ? 100 : 1);
  const rgba = /^rgba\([^)]*,\s*([\d.]+)\)$/.exec(colour);
  if (rgba) return Number(rgba[1]);
  if (/^[a-z-]+\([^)]*\)$/.test(colour)) return 1;
  throw new Error(`fixture check: an unparsed computed colour: ${colour}`);
}

const isDark = (page: Page) => page.evaluate(() => document.documentElement.classList.contains('dark'));

/** Every prompt bubble's side cue, read from its computed style: a visibly coloured, toned 3px right strip and no left border. */
async function expectStrip(page: Page, where: string): Promise<void> {
  const styles = await next.transcript(page).locator('[data-user-text]').evaluateAll((els) => els.map((el) => {
    const cs = getComputedStyle(el);
    // The top border is 0px but keeps the base border colour every element gets: what the strip falls back to without its tone.
    return { right: cs.borderRightWidth, left: cs.borderLeftWidth, colour: cs.borderRightColor, background: cs.backgroundColor, base: cs.borderTopColor };
  }));
  expect(styles.length, `${where}: fixture check: prompt bubbles are on screen`).toBeGreaterThan(0);
  await test.info().attach(`strip-${where}`, { body: JSON.stringify(styles, null, 2), contentType: 'application/json' });
  for (const [i, st] of styles.entries()) {
    expect(st.right, `${where}: bubble ${i} has a 3px right strip`).toBe('3px');
    expect(st.left, `${where}: bubble ${i} has no left border`).toBe('0px');
    expect(alphaOf(st.colour), `${where}: bubble ${i}'s strip is visible (${st.colour})`).toBeGreaterThan(0);
    expect(st.colour, `${where}: bubble ${i}'s strip differs from its fill`).not.toBe(st.background);
    expect(st.colour, `${where}: bubble ${i}'s strip carries its tone, not the base border colour`).not.toBe(st.base);
  }
}

const shoot = async (page: Page, name: string) => test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' });

// Invariants: in both themes each prompt bubble has a visible 3px right strip and no left border; at every width state each user bubble spans the column's content box (starts at its left edge, ends at its right edge) and is as wide as any other; its controls end at its right edge.
/** Desktop: walks every session width state, then switches theme for the visual pass. */
export async function desktopWidthsFlow({ page, cc }: Ctx): Promise<void> {
  test.skip(test.info().project.name !== 'desktop', 'the width control is a desktop-layout feature');
  await sendBoth(page, cc, 'e2e-user-bubble-width');
  await expectStrip(page, (await isDark(page)) ? 'dark' : 'light');
  for (const state of WIDTH_STATES) {
    const label = stateLabel(state);
    await setWidth(page, state);
    await expect(list(page)).toHaveAttribute('data-session-width', stateKey(state));
    const m = await measure(page);
    if (label === 'Normal') {
      const { short } = pair(m, label);
      expect(short.glyphWidth, "positive control: the one-word text is far narrower than the bubble's span").toBeLessThan((m.columnRight - m.columnLeft) / 2);
    }
    expectAligned(m, label);
    await shoot(page, `user-bubble-${label.toLowerCase().replace(/\W+/g, '-')}`);
  }
  const wasDark = await isDark(page);
  await page.getByRole('button', { name: /^(Dark|Light) theme$/ }).click();
  await expect.poll(() => isDark(page), 'the theme switched').toBe(!wasDark);
  await expectStrip(page, wasDark ? 'light' : 'dark');
  await page.mouse.move(0, 0);
  await bringTo(next.transcript(page), next.userMessages(page).nth(0), 16);
  await shoot(page, `user-bubble-${wasDark ? 'light' : 'dark'}`);
}

// Invariants: on a phone each prompt bubble has a visible 3px right strip and no left border, and each user bubble spans the column's content box and is as wide as any other; its controls end at its right edge.
/** Drawer viewports: the same geometry in the stacked layout. */
export async function narrowFlow({ page, cc }: Ctx): Promise<void> {
  test.skip(test.info().project.name === 'desktop', 'the stacked layout is below md');
  await sendBoth(page, cc, `e2e-user-bubble-width-${test.info().project.name}`);
  await expectStrip(page, test.info().project.name);
  expectAligned(await measure(page), test.info().project.name);
  await shoot(page, `user-bubble-${test.info().project.name}`);
}

// Invariant: a sent prompt's attachment chips start at its bubble's text.
/** Every project: a prompt sent with a file attached. */
export async function attachmentsFlow({ page, cc }: Ctx): Promise<void> {
  const { sessionId } = await spawnSession(cc, `e2e-user-bubble-attach-${test.info().project.name}`);
  await page.goto(`/#session=${sessionId}`);
  await expect(page.locator('#composer-input')).toBeEnabled();
  await filePicker(page).setInputFiles([{ name: 'ubi-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') }]);
  await expect(page.getByRole('button', { name: 'Remove ubi-notes.txt', exact: true })).toBeVisible();
  await next.sendPrompt(page, 'UBI-ATTACH');
  const item = next.lastUserMessage(page);
  await expect(item).toContainText('UBI-ATTACH');
  await expect(item, 'fixture check: the sent prompt shows its attachment').toContainText('ubi-notes.txt');
  const chip = await item.locator('span', { hasText: 'ubi-notes.txt' }).first().boundingBox();
  const text = await item.locator('[data-user-text] .md').boundingBox();
  expect(Math.abs(chip!.x - text!.x), "the attachment chip starts at the bubble's text").toBeLessThanOrEqual(1);
}

type Rect = { left: number; right: number; width: number; height: number };

/** Every user-side bubble's border box, the question and plan cards' boxes, and the column's content box, all read from the visible transcript `root`. */
async function measureVariants(root: Locator) {
  return root.evaluate((scroller) => {
    const box = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height }; };
    const listEl = scroller.querySelector('[data-session-width]') as HTMLElement;
    const lr = listEl.getBoundingClientRect();
    const cs = getComputedStyle(listEl);
    const bubbles: { kind: string; text: string; rect: Rect }[] = [];
    for (const item of scroller.querySelectorAll('[data-item=user]')) {
      const head = item.querySelector('[data-answer-head]');
      const folded = item.querySelector('[data-fold], [data-wake-plain]');
      const target = head ? head.parentElement! : (folded ?? item.querySelector('[data-user-text]'));
      if (!target) continue;
      const kind = head ? 'answer' : item.getAttribute('data-variant') === 'wake' ? 'wake' : item.querySelector('[data-user-attachments]') ? 'attachment' : 'text';
      bubbles.push({ kind, text: (item.textContent ?? '').replace(/\s+/g, ' ').trim(), rect: box(target) });
    }
    for (const ghost of scroller.querySelectorAll('[data-item=queued] > div')) bubbles.push({ kind: 'queued', text: ghost.textContent ?? '', rect: box(ghost) });
    const pinBody = scroller.parentElement!.querySelector(':scope > [data-pinned-prompt] [data-pin-body]');
    if (pinBody) bubbles.push({ kind: 'pin', text: pinBody.textContent ?? '', rect: box(pinBody) });
    const boxes = (sel: string) => [...scroller.querySelectorAll(sel)].map(box);
    return {
      column: { left: lr.left + parseFloat(cs.paddingLeft), right: lr.right - parseFloat(cs.paddingRight) },
      question: boxes('[data-item=question] > *'),
      plan: boxes('[data-item=plan] > *'),
      bubbles,
    };
  });
}

/** Asserts the fixture, then that every user-side bubble's edges are the question card's and the plan card's, which are the column's content edges. */
function expectVariantsFullWidth(m: Awaited<ReturnType<typeof measureVariants>>, where: string): void {
  const has = (kind: string, text?: string) => m.bubbles.some((b) => b.kind === kind && (!text || b.text.includes(text)));
  for (const [kind, text] of [['answer'], ['wake'], ['attachment', 'UBW-ATTACH'], ['text', 'UBW-REJECT'], ['text', 'UBW-TALL'], ['queued', 'UBW-QUEUED'], ['pin']] as const) {
    expect(has(kind, text), `${where}: fixture check: a ${kind} bubble${text ? ` with ${text}` : ''} is measured`).toBe(true);
  }
  expect(m.question.length && m.plan.length, `${where}: fixture check: the question and plan cards are measured`).toBeTruthy();
  for (const r of [...m.question, ...m.plan, ...m.bubbles.map((b) => b.rect)]) {
    expect(r.width > 0 && r.height > 0, `${where}: fixture check: a measured box is visible (${JSON.stringify(r)})`).toBe(true);
  }
  for (const [name, cards] of [['question', m.question], ['plan', m.plan]] as const) {
    for (const c of cards) {
      expect(Math.abs(c.left - m.column.left), `${where}: positive control: the ${name} card starts at the column's content left edge`).toBeLessThanOrEqual(1);
      expect(Math.abs(c.right - m.column.right), `${where}: positive control: the ${name} card ends at the column's content right edge`).toBeLessThanOrEqual(1);
    }
  }
  const [q] = m.question;
  const [p] = m.plan;
  for (const b of m.bubbles) {
    for (const [name, card] of [['question', q], ['plan', p]] as const) {
      expect(Math.abs(b.rect.left - card.left), `${where}: ${b.kind} bubble "${b.text.slice(0, 30)}" starts at the ${name} card's left edge`).toBeLessThanOrEqual(1);
      expect(Math.abs(b.rect.right - card.right), `${where}: ${b.kind} bubble "${b.text.slice(0, 30)}" ends at the ${name} card's right edge`).toBeLessThanOrEqual(1);
    }
  }
}

// Invariant: every user-side bubble (typed prompt, attachment prompt, wake stub, question answer, plan reject echo, queued ghost, sticky pin) has the left and right edges of the AskUserQuestion and plan cards, which are the column's content edges; on desktop at every session width state.
/** Every project: one session carrying every user-side variant on screen, measured against the question and plan cards. */
export async function variantsFlow({ page, cc }: Ctx): Promise<void> {
  test.skip(cc.engine === 'live', "the flow drives the fake engine's QA-ASK and PLAN-ASK scenario");
  const project = `e2e-user-bubble-variants-${test.info().project.name}`;
  // The server's queued-message frame is sent into the page's own socket, as queuedGhostsFlow does.
  const socket: { route: WebSocketRoute | null } = { route: null };
  await page.routeWebSocket(/\/ws$/, (ws) => { ws.connectToServer(); socket.route = ws; });
  await createProject(cc, project);
  await next.open(page);
  await next.startSessionIn(page, project);
  const inst = await instanceIn(cc, project);
  const root = page.locator('[data-conversation]:visible');
  await expect(root, 'fixture check: one visible transcript').toHaveCount(1);

  await answerCard(page, next, await askCard(page, next), 2);
  await next.sendPrompt(page, 'PLAN-ASK raise the plan');
  const plan = root.locator('[data-item=plan]');
  await expect(plan, 'fixture check: the plan card is raised').toHaveCount(1);
  await expect(next.turnEnds(page)).toHaveCount(3);
  await plan.getByRole('textbox').fill('UBW-REJECT refine');
  await plan.getByRole('button', { name: /Reject/ }).click();
  await expect(next.turnEnds(page)).toHaveCount(4);
  let turns = 4;
  const send = async (text: string) => {
    await next.sendPrompt(page, text);
    await expect(next.turnEnds(page), `fixture check: the turn for ${text.slice(0, 12)} ended`).toHaveCount(++turns);
  };
  await send(tallPrompt('UBW-TALL'));
  await send(buildWakeStub({ targetSessionId: 'ubw', payloadText: '{"sessionId":"ubw"}\nUBW-WAKE' }));
  await filePicker(page).setInputFiles([{ name: 'ubw-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') }]);
  await expect(page.getByRole('button', { name: 'Remove ubw-notes.txt', exact: true })).toBeVisible();
  await send('UBW-ATTACH');
  if (!socket.route) throw new Error("fixture check: the page's socket was routed");
  socket.route.send(JSON.stringify({ t: 'event', id: inst.id, ev: queued('UBW-QUEUED') }));
  await expect(root.locator('[data-item=queued]'), 'fixture check: the queued ghost shows').toContainText('UBW-QUEUED');

  const showPin = async () => {
    await bringTo(next.transcript(page), next.userMessages(page).filter({ hasText: 'UBW-TALL' }), -150);
    await reveal(page, next);
    await expect(next.pin(page)).toHaveAttribute('role', 'button');
  };
  if (test.info().project.name !== 'desktop') {
    await showPin();
    expectVariantsFullWidth(await measureVariants(root), test.info().project.name);
    return;
  }
  for (const state of WIDTH_STATES) {
    await setWidth(page, state);
    await showPin();
    expectVariantsFullWidth(await measureVariants(root), stateLabel(state));
  }
}

// Invariant: a user item inside a sub-agent panel starts at the left edge of that panel's own collapsed action card and ends at the panel's content right edge.
/** Every project, on the nested scenario: an Agent call whose sub-agent has a prompt, a Read and a text reply. */
export async function nestedFlow({ page, cc }: Ctx): Promise<void> {
  const project = test.info().project.name;
  const { sessionId } = await spawnSession(cc, `e2e-user-bubble-nested-${project}`);
  await page.goto(`/#session=${sessionId}`);
  await next.sendPrompt(page, 'SUB-INSET');
  await expect(next.turnEnds(page), 'fixture check: the turn ended').toHaveCount(1);
  const run = next.transcript(page).locator('[data-group-trigger]').first();
  if ((await run.getAttribute('data-state')) !== 'open') await run.click();
  await expect(run).toHaveAttribute('data-state', 'open');
  const subTrigger = next.transcript(page).locator('[data-sub-trigger]');
  if ((await subTrigger.getAttribute('data-state')) !== 'open') await subTrigger.click();
  await expect(subTrigger).toHaveAttribute('data-state', 'open');
  const nested = next.transcript(page).locator('[data-item=assistant] [data-item=user]');
  await expect(nested, 'fixture check: the sub-agent prompt shows in its panel').toContainText('SUB-PROMPT');
  await expect(next.transcript(page).locator('[data-sub-trigger] + * [data-text-block]'), "fixture check: the sub-agent's text shows").toContainText('SUB-TEXT');
  const subCard = next.transcript(page).locator('[data-sub-trigger] + * [data-group-trigger]');
  await expect(subCard, "fixture check: the sub-agent's run is one collapsed action card").toHaveAttribute('data-state', 'closed');

  const m = await page.evaluate(() => {
    const rect = (sel: string, from: ParentNode) => (from.querySelector(sel) as HTMLElement).getBoundingClientRect();
    const panel = (document.querySelector('[data-sub-trigger]') as HTMLElement).nextElementSibling as HTMLElement;
    const bubble = rect('[data-item=user] [data-user-text]', panel);
    return {
      cardLeft: ((panel.querySelector('[data-group-trigger]') as HTMLElement).parentElement as HTMLElement).getBoundingClientRect().left,
      panelRight: panel.getBoundingClientRect().right - parseFloat(getComputedStyle(panel).paddingRight),
      left: bubble.left,
      right: bubble.right,
    };
  });
  expect(Math.abs(m.left - m.cardLeft), "the nested prompt starts at the left edge of the sub-agent's action card").toBeLessThanOrEqual(1);
  expect(Math.abs(m.right - m.panelRight), "the nested prompt ends at the panel's content right edge").toBeLessThanOrEqual(1);
  await nested.scrollIntoViewIfNeeded();
  await shoot(page, `user-bubble-nested-${project}`);
}
