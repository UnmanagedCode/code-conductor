// User bubbles start one avatar gutter right of where assistant text starts and fill to the column's
// right edge, whatever their length, at every session width and on a phone; their attachments and
// controls start at their text. The bodies are shared by the per-project spec files.
import type { Page } from '@playwright/test';
import { test, expect } from './harness/fixtures.ts';
import { spawnSession } from './harness/api.ts';
import { next } from './flows/ui.ts';
import { bringTo, sendAll, tallPrompt } from './flows/stickyPin.ts';
import { LABELS, widthButton } from './session-width.shared.ts';

type Ctx = { page: Page; cc: Parameters<typeof spawnSession>[0] };

const SHORT = 'UBI';
const LONG = tallPrompt('UBI-LONG');
const list = (page: Page) => page.locator('[data-conversation] [data-session-width]').first();
const filePicker = (page: Page) => page.locator('[data-composer] input[type="file"]');

/**
 * The transcript geometry the inset rests on. `gutter` is derived from the assistant avatar: beside the
 * body (md and up) it is the avatar plus its gap; stacked above it (phone) it is the avatar's width.
 */
async function measure(page: Page, stacked: boolean) {
  return page.evaluate((stacked) => {
    const rect = (el: Element | null | undefined) => (el as HTMLElement).getBoundingClientRect();
    const listEl = document.querySelector('[data-conversation] [data-session-width]') as HTMLElement;
    const avatar = rect(document.querySelector('[data-item=assistant] [data-assistant-avatar]'));
    const body = rect(document.querySelector('[data-item=assistant] [data-assistant-body]'));
    const lr = listEl.getBoundingClientRect();
    const leftOf = (el: Element | null) => (el ? el.getBoundingClientRect().left : null);
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
        textLeft: md.getBoundingClientRect().left,
        // The first text node's own extent: what a shrink-to-fit bubble would wrap (a block's rect is its container's width).
        glyphWidth: range.getBoundingClientRect().width,
        actionsLeft: leftOf(item.querySelector('[data-user-actions] > *')),
      };
    });
    return {
      textStart: rect(document.querySelector('[data-item=assistant] [data-text-block] .md')).left,
      gutter: stacked ? avatar.width : body.left - avatar.left,
      columnRight: lr.right - parseFloat(getComputedStyle(listEl).paddingRight),
      bubbles,
    };
  }, stacked);
}

type Geometry = Awaited<ReturnType<typeof measure>>;

/** The one-word and the long bubble, after the fixture check that both were measured. */
function pair(m: Geometry, where: string) {
  const [short, long] = [m.bubbles.find((b) => b.tag === SHORT), m.bubbles.find((b) => b.tag === 'UBI-LONG')];
  expect(short && long, `${where}: fixture check: both bubbles are measured`).toBeTruthy();
  return { short: short!, long: long! };
}

function expectInset(m: Geometry, where: string): void {
  expect(m.gutter, `${where}: fixture check: the avatar gutter is measured`).toBeGreaterThan(0);
  for (const b of m.bubbles) {
    expect(Math.abs(b.left - (m.textStart + m.gutter)), `${where}: ${b.tag} starts one gutter right of the assistant text`).toBeLessThanOrEqual(1);
    expect(Math.abs(b.right - m.columnRight), `${where}: ${b.tag} ends at the column's right edge`).toBeLessThanOrEqual(1);
    expect(b.actionsLeft, `${where}: ${b.tag}'s action row is measured`).not.toBeNull();
    expect(Math.abs(b.actionsLeft! - b.textLeft), `${where}: ${b.tag}'s controls start at its text`).toBeLessThanOrEqual(1);
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

const shoot = async (page: Page, name: string) => test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' });

// Invariants: at every preset each user bubble starts one avatar gutter right of the assistant text, ends at the column's right edge and is as wide as any other; its controls start at its text.
/** Desktop: cycles every session width preset, then switches theme for the visual pass. */
export async function desktopPresetsFlow({ page, cc }: Ctx): Promise<void> {
  test.skip(test.info().project.name !== 'desktop', 'the width presets are a desktop-layout feature');
  await sendBoth(page, cc, 'e2e-user-bubble-inset');
  for (const label of LABELS) {
    await expect(widthButton(page, label)).toBeVisible();
    await expect(list(page)).toHaveAttribute('data-session-width', label.toLowerCase());
    const m = await measure(page, false);
    if (label === 'Normal') {
      const { short } = pair(m, label);
      expect(short.glyphWidth, 'positive control: the one-word text is far narrower than the inset span').toBeLessThan((m.columnRight - m.textStart - m.gutter) / 2);
    }
    expectInset(m, label);
    await shoot(page, `user-bubble-${label.toLowerCase()}`);
    await widthButton(page, label).click();
  }
  const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'));
  const wasDark = await isDark();
  await page.getByRole('button', { name: /^(Dark|Light) theme$/ }).click();
  await expect.poll(isDark, 'the theme switched').toBe(!wasDark);
  await page.mouse.move(0, 0);
  await bringTo(next.transcript(page), next.userMessages(page).nth(0), 16);
  await shoot(page, `user-bubble-${wasDark ? 'light' : 'dark'}`);
}

// Invariants: on a phone each user bubble starts one avatar width right of the assistant text, ends at the column's right edge and is as wide as any other; its controls start at its text.
/** Drawer viewports: the same geometry at the stacked layout's inset. */
export async function narrowFlow({ page, cc }: Ctx): Promise<void> {
  test.skip(test.info().project.name === 'desktop', 'the stacked layout is below md');
  await sendBoth(page, cc, `e2e-user-bubble-inset-${test.info().project.name}`);
  expectInset(await measure(page, true), test.info().project.name);
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

// Invariant: a user item inside a sub-agent panel starts one avatar gutter right of that panel's own assistant text (its bubbles have no avatar) and ends at the panel's content right edge.
/** Every project, on the nested scenario: an Agent call whose sub-agent has a prompt and a text reply. */
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

  const m = await page.evaluate((stacked) => {
    const rect = (sel: string, from: ParentNode = document) => (from.querySelector(sel) as HTMLElement).getBoundingClientRect();
    const panel = (document.querySelector('[data-sub-trigger]') as HTMLElement).nextElementSibling as HTMLElement;
    // The root bubble's avatar: a sub-agent's bubbles have none.
    const avatar = rect('[data-item=assistant] [data-assistant-avatar]');
    const body = rect('[data-item=assistant] [data-assistant-body]');
    const bubble = rect('[data-item=user] [data-user-text]', panel);
    return {
      gutter: stacked ? avatar.width : body.left - avatar.left,
      subTextStart: rect('[data-text-block] .md', panel).left,
      panelRight: panel.getBoundingClientRect().right - parseFloat(getComputedStyle(panel).paddingRight),
      left: bubble.left,
      right: bubble.right,
    };
  }, project !== 'desktop');
  expect(m.gutter, 'fixture check: the avatar gutter is measured').toBeGreaterThan(0);
  expect(Math.abs(m.left - (m.subTextStart + m.gutter)), "the nested prompt starts one gutter right of the sub-agent's text").toBeLessThanOrEqual(1);
  expect(Math.abs(m.right - m.panelRight), "the nested prompt ends at the panel's content right edge").toBeLessThanOrEqual(1);
  await nested.scrollIntoViewIfNeeded();
  await shoot(page, `user-bubble-nested-${project}`);
}
