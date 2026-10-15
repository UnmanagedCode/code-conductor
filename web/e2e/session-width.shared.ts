// The session width control (popover slider + Full width switch) in a real browser. The bodies are
// shared by the per-project spec files.
import type { Page } from '@playwright/test';
import { test, expect } from './harness/fixtures.ts';
import { spawnSession } from './harness/api.ts';
import { next } from './flows/ui.ts';
import { bringTo, reveal, sendAll, tallPrompt } from './flows/stickyPin.ts';
import {
  SESSION_WIDTH_MAX, SESSION_WIDTH_MIN, SESSION_WIDTH_SNAPS, SESSION_WIDTH_STEP, sessionWidthKey, sessionWidthLabel,
} from '../src/app/sessionWidthScale.ts';

type Ctx = { page: Page; cc: Parameters<typeof spawnSession>[0] };
type Setting = { width?: number; full?: boolean };

export const widthTrigger = (page: Page) => page.locator('[data-sidebar-footer]').getByRole('button', { name: /^Session width:/ });
const popover = (page: Page) => page.locator('[data-session-width-popover]');
const sliderRoot = (page: Page) => popover(page).locator('[data-slot=slider]');
const thumb = (page: Page) => popover(page).getByRole('slider');
const fullSwitch = (page: Page) => popover(page).getByRole('switch', { name: 'Full width' });

export async function openWidthPopover(page: Page) {
  if (!(await popover(page).isVisible())) await widthTrigger(page).click();
  await expect(popover(page)).toBeVisible();
}

/** Move the pointer to a spot with no interactive element under it, so no tooltip trigger holds a tooltip open. */
export async function parkPointer(page: Page) {
  const spot = await page.evaluate(() => {
    for (let y = window.innerHeight - 8; y > 0; y -= 24) {
      for (let x = window.innerWidth - 8; x > 0; x -= 24) {
        const el = document.elementFromPoint(x, y);
        if (el && !el.closest('button, a, input, textarea, select, iframe, [role], [tabindex], [data-slot*="trigger"]')) return { x, y };
      }
    }
    return null;
  });
  if (!spot) throw new Error('no spot clear of interactive elements to park the pointer');
  await page.mouse.move(spot.x, spot.y);
}

/** Escape with the pointer clear of every tooltip (a closing tooltip takes the Escape). */
async function closeWidthPopover(page: Page) {
  await parkPointer(page);
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(popover(page)).toBeHidden();
}

/** Reach a setting through the real controls: a snap by its tick, any other width by Home then arrow steps. */
export async function setWidth(page: Page, s: Setting) {
  await openWidthPopover(page);
  // A bare width means Full off. The slider is disabled under Full: leave Full before moving it, and enter Full after.
  const full = s.full ?? (s.width === undefined ? undefined : false);
  const toggleFull = async () => {
    if ((await fullSwitch(page).getAttribute('aria-checked')) !== String(full)) await fullSwitch(page).click();
  };
  if (full === false) await toggleFull();
  if (s.width !== undefined) {
    const snap = SESSION_WIDTH_SNAPS.find((n) => n.px === s.width);
    if (snap) await popover(page).getByRole('button', { name: snap.label }).click();
    else {
      await thumb(page).focus();
      await page.keyboard.press('Home');
      for (let i = 0; i < (s.width - SESSION_WIDTH_MIN) / SESSION_WIDTH_STEP; i++) await page.keyboard.press('ArrowRight');
    }
    await expect(thumb(page)).toHaveAttribute('aria-valuenow', String(s.width));
  }
  if (full === true) await toggleFull();
  await closeWidthPopover(page);
}

/** A real pointer drag of the thumb to the track position of `px`; the popover must be open. Releases only on request. */
export async function dragThumbTo(page: Page, px: number, { release }: { release: boolean }) {
  const root = await sliderRoot(page).boundingBox();
  const t = await thumb(page).boundingBox();
  if (!root || !t) throw new Error('the slider is not rendered');
  const y = root.y + root.height / 2;
  await page.mouse.move(t.x + t.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(root.x + (root.width * (px - SESSION_WIDTH_MIN)) / (SESSION_WIDTH_MAX - SESSION_WIDTH_MIN), y, { steps: 4 });
  if (release) await page.mouse.up();
}

/** The states the flows walk, in ascending list width. */
export const WIDTH_STATES: Setting[] = [{ width: 768, full: false }, { width: 896, full: false }, { width: 1024, full: false }, { full: true }];
/** A state's `data-session-width` value. */
export const stateKey = (s: Setting) => sessionWidthKey({ width: s.width ?? 768, full: s.full ?? false });
/** A state's name in the trigger label and in assertion messages. */
export const stateLabel = (s: Setting) => sessionWidthLabel({ width: s.width ?? 768, full: s.full ?? false });

const list = (page: Page) => page.locator('[data-conversation] [data-session-width]').first();
const bottom = (page: Page) => page.locator('main > div[data-session-width]');

async function measure(page: Page) {
  return page.evaluate(() => {
    const scroller = document.querySelector('[data-conversation]') as HTMLElement;
    const listEl = scroller.querySelector('[data-session-width]') as HTMLElement;
    const bottomEl = document.querySelector('main > div[data-session-width]') as HTMLElement;
    const main = document.querySelector('main') as HTMLElement;
    const bodies = document.querySelectorAll('[data-item=assistant] [data-assistant-body]');
    const body = bodies[bodies.length - 1] as HTMLElement;
    const pinColumn = document.querySelector('[data-pinned-prompt] > [data-session-width]') as HTMLElement;
    const lr = listEl.getBoundingClientRect();
    const cs = getComputedStyle(listEl);
    const pr = pinColumn.getBoundingClientRect();
    const pcs = getComputedStyle(pinColumn);
    const pinBubble = document.querySelector('[data-pinned-prompt] [data-pin-body]') as HTMLElement;
    const liveBubble = document.querySelector('[data-item=user] [data-user-text]') as HTMLElement;
    const pb = pinBubble.getBoundingClientRect();
    const lb = liveBubble.getBoundingClientRect();
    return {
      listWidth: lr.width,
      listLeft: lr.left,
      listContentLeft: lr.left + parseFloat(cs.paddingLeft),
      pinContentLeft: pr.left + parseFloat(pcs.paddingLeft),
      pinContentRight: pr.right - parseFloat(pcs.paddingRight),
      pinBubbleLeft: pb.left,
      pinBubbleRight: pb.right,
      liveBubbleLeft: lb.left,
      liveBubbleRight: lb.right,
      listContentRight: lr.right - parseFloat(cs.paddingRight),
      bottomLeft: bottomEl.getBoundingClientRect().left,
      bottomWidth: bottomEl.getBoundingClientRect().width,
      mainWidth: main.getBoundingClientRect().width,
      scrollerClient: scroller.clientWidth,
      gutter: scroller.offsetWidth - scroller.clientWidth,
      bodyRight: body.getBoundingClientRect().right,
      pinWidth: pinColumn.getBoundingClientRect().width,
    };
  });
}

// Invariants: list width ascends Normal < 896 < Wide < Full; a fixed width is the list's width, clamped by the room (the maximum fills the scroller); Full fills the area and keeps the slider's value; the transcript and bottom
// columns stay aligned; the pin column has the list's box and content box; the pinned bubble's edges are the live prompt bubble's; the last assistant body tracks the list's content edge; a drag snaps near a snap point and applies live; the setting survives a reload.
/** Desktop: walks the width states on a rendered turn through the real controls and measures the column. */
export async function widthsFlow({ page, cc }: Ctx): Promise<void> {
  test.skip(test.info().project.name !== 'desktop', 'the width control is a desktop-layout feature');
  const { sessionId } = await spawnSession(cc, 'e2e-session-width');
  await page.goto(`/#session=${sessionId}`);
  // A tall prompt, so the turn overflows and its prompt can be scrolled under the header and pinned.
  await sendAll(page, next, [tallPrompt('WIDTH-PIN')]);
  const showPin = async () => {
    await bringTo(next.transcript(page), next.userMessages(page).nth(0), -150);
    await reveal(page, next);
    await expect(next.pin(page)).toHaveAttribute('role', 'button');
  };
  const expectColumnFollows = async (where: string, expected: { width?: number; full?: boolean }) => {
    await expect(widthTrigger(page)).toHaveAccessibleName(`Session width: ${stateLabel(expected)}`);
    await expect(list(page)).toHaveAttribute('data-session-width', stateKey(expected));
    await expect(bottom(page)).toHaveAttribute('data-session-width', stateKey(expected));
    await showPin();
    const m = await measure(page);
    expect(m.pinWidth, `${where}: the pin is rendered`).toBeGreaterThan(0);
    const tol = m.gutter / 2 + 0.5;
    expect(Math.abs(m.listLeft - m.bottomLeft), `${where}: columns aligned`).toBeLessThanOrEqual(tol);
    expect(Math.abs(m.pinWidth - m.listWidth), `${where}: the pin column has the list's box`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(m.pinContentLeft - m.listContentLeft), `${where}: the pin column's content box is the list's`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(m.pinContentRight - m.listContentRight), `${where}: the pin column's content box is the list's`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(m.pinBubbleRight - m.liveBubbleRight), `${where}: the pinned bubble's right edge is the live prompt's`).toBeLessThanOrEqual(1);
    // Both bubbles span the column from its content left edge to its right edge, whatever the prompt's length.
    expect(Math.abs(m.pinBubbleLeft - m.liveBubbleLeft), `${where}: no horizontal shift into the pinned state`).toBeLessThanOrEqual(1);
    expect(Math.abs(m.bodyRight - m.listContentRight), `${where}: assistant content tracks the column edge`).toBeLessThanOrEqual(1);
    return m;
  };
  const expectFills = (where: string, m: Awaited<ReturnType<typeof measure>>) => {
    expect(Math.abs(m.listWidth - m.scrollerClient), `${where}: the list fills the scroller`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(m.bottomWidth - m.mainWidth), `${where}: the bottom column fills main`).toBeLessThanOrEqual(0.5);
  };

  const widths: number[] = [];
  for (const state of WIDTH_STATES) {
    const where = stateLabel(state);
    await setWidth(page, state);
    const m = await expectColumnFollows(where, state);
    widths.push(m.listWidth);
    if (state.full) expectFills(where, m);
    else {
      expect(Math.abs(m.listWidth - state.width!), `${where}: the list is the setting's width`).toBeLessThanOrEqual(0.5);
      expect(m.listWidth, `${where} is below the available width`).toBeLessThan(m.scrollerClient - 1);
    }
    await test.info().attach(`width-${where.toLowerCase().replace(/\W+/g, '-')}`, { body: await page.screenshot(), contentType: 'image/png' });
  }
  expect(widths[0], 'Normal < 896').toBeLessThan(widths[1]);
  expect(widths[1], '896 < Wide').toBeLessThan(widths[2]);
  expect(widths[2], 'Wide < Full').toBeLessThan(widths[3]);

  // (a) The maximum is wider than the room, so CSS clamps it to the scroller.
  await setWidth(page, { full: false });
  await openWidthPopover(page);
  await thumb(page).focus();
  await page.keyboard.press('End');
  await closeWidthPopover(page);
  const clamped = await expectColumnFollows('maximum', { width: SESSION_WIDTH_MAX });
  expect(clamped.scrollerClient, 'fixture check: the room is narrower than the maximum').toBeLessThan(SESSION_WIDTH_MAX);
  expectFills('maximum', clamped);

  // (b) Full greys the slider and keeps its value; turning it off restores the width.
  await setWidth(page, { width: 896 });
  await openWidthPopover(page);
  await fullSwitch(page).click();
  await expect(sliderRoot(page)).toHaveAttribute('data-disabled', '');
  await expect(thumb(page)).toHaveAttribute('aria-valuenow', '896');
  await fullSwitch(page).click();
  await expect(sliderRoot(page)).not.toHaveAttribute('data-disabled', '');
  await closeWidthPopover(page);
  const restored = await expectColumnFollows('Full off again', { width: 896 });
  expect(Math.abs(restored.listWidth - 896), 'Full off: the list is the kept width again').toBeLessThanOrEqual(0.5);

  // (c) A drag snaps near Wide and applies live, before the pointer is released.
  await openWidthPopover(page);
  await dragThumbTo(page, 1040, { release: false });
  await expect(list(page), 'mid-drag: snapped to Wide, live').toHaveAttribute('data-session-width', '1024');
  expect(Math.abs((await measure(page)).listWidth - 1024), 'mid-drag: the list is Wide').toBeLessThanOrEqual(0.5);
  await page.mouse.up();
  await expect(list(page), 'released: still Wide').toHaveAttribute('data-session-width', '1024');
  await closeWidthPopover(page);

  // (d) Both the width and Full survive a reload.
  await setWidth(page, { width: 896, full: true });
  await page.reload();
  await expect(widthTrigger(page)).toHaveAccessibleName('Session width: Full');
  await expectFills('Full after reload', await expectColumnFollows('Full after reload', { full: true }));
  await setWidth(page, { full: false });
  const after = await expectColumnFollows('reload then Full off', { width: 896 });
  expect(Math.abs(after.listWidth - 896), 'the width survived the reload').toBeLessThanOrEqual(0.5);
}

// Invariant: the phone drawer offers no width control.
/** Drawer viewports: the open drawer has the theme toggle but no width control. */
export async function drawerHasNoControlFlow({ page, cc }: Ctx): Promise<void> {
  test.skip(test.info().project.name === 'desktop', 'a desktop has the column, not the drawer');
  const { sessionId } = await spawnSession(cc, `e2e-session-width-${test.info().project.name}`);
  await page.goto(`/#session=${sessionId}`);
  await expect(page.locator('#composer-input')).toBeEnabled();
  await next.openSidebar(page);
  // Must-match query first: while the drawer closes the page is aria-hidden and an absence check passes vacuously.
  await expect(page.getByRole('button', { name: /^(Dark|Light) theme$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Session width/ })).toHaveCount(0);
}
