// The session width presets (Normal / Wide / Full) in a real browser. The bodies are shared by the
// per-project spec files.
import type { Page } from '@playwright/test';
import { test, expect } from './harness/fixtures.ts';
import { spawnSession } from './harness/api.ts';
import { next } from './flows/ui.ts';
import { bringTo, reveal, sendAll, tallPrompt } from './flows/stickyPin.ts';

type Ctx = { page: Page; cc: Parameters<typeof spawnSession>[0] };

const LABELS = ['Normal', 'Wide', 'Full'] as const;
const widthButton = (page: Page, label: string) => page.locator('[data-sidebar-footer]').getByRole('button', { name: `Session width: ${label}` });
const list = (page: Page) => page.locator('[data-conversation] [data-session-width]').first();
const bottom = (page: Page) => page.locator('main > div[data-session-width]');

/** The pin column carries the cap without the list's own side padding: the cap itself while capped, the padded container's content box at Full. */
const pinExpected = (m: { listWidth: number; listContentWidth: number }, label: string) => (label === 'Full' ? m.listContentWidth : m.listWidth);

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
    return {
      listWidth: lr.width,
      listContentWidth: lr.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
      listLeft: lr.left,
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

// Invariants: list width Normal < Wide < Full and Full fills the area; the transcript and bottom
// columns stay aligned; the pin column is as wide as the list; the last assistant body tracks the list's content edge; the choice survives a reload.
/** Desktop: cycles every preset on a rendered turn and measures the column. */
export async function presetsFlow({ page, cc }: Ctx): Promise<void> {
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

  const widths: number[] = [];
  for (const label of LABELS) {
    await expect(widthButton(page, label)).toBeVisible();
    await expect(list(page)).toHaveAttribute('data-session-width', label.toLowerCase());
    await showPin();
    const m = await measure(page);
    expect(m.pinWidth, `${label}: the pin is rendered`).toBeGreaterThan(0);
    widths.push(m.listWidth);
    const tol = m.gutter / 2 + 0.5;
    expect(Math.abs(m.listLeft - m.bottomLeft), `${label}: columns aligned`).toBeLessThanOrEqual(tol);
    expect(Math.abs(m.pinWidth - pinExpected(m, label)), `${label}: the pin column has the list's cap`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(m.bodyRight - m.listContentRight), `${label}: assistant content tracks the column edge`).toBeLessThanOrEqual(1);
    if (label !== 'Full') expect(m.listWidth, `${label} is below the available width`).toBeLessThan(m.scrollerClient - 1);
    else {
      expect(Math.abs(m.listWidth - m.scrollerClient), 'Full: the list fills the scroller').toBeLessThanOrEqual(0.5);
      expect(Math.abs(m.bottomWidth - m.mainWidth), 'Full: the bottom column fills main').toBeLessThanOrEqual(0.5);
    }
    await test.info().attach(`width-${label.toLowerCase()}`, { body: await page.screenshot(), contentType: 'image/png' });
    await widthButton(page, label).click();
  }
  expect(widths[0], 'Normal < Wide').toBeLessThan(widths[1]);
  expect(widths[1], 'Wide < Full').toBeLessThan(widths[2]);

  // The loop's last click returned to Normal; go to Full again and reload.
  await widthButton(page, 'Normal').click();
  await widthButton(page, 'Wide').click();
  await expect(widthButton(page, 'Full')).toBeVisible();
  await page.reload();
  await expect(widthButton(page, 'Full')).toBeVisible();
  await expect(list(page)).toHaveAttribute('data-session-width', 'full');
  await showPin();
  const after = await measure(page);
  expect(Math.abs(after.listWidth - after.scrollerClient), 'Full after reload: the list fills').toBeLessThanOrEqual(0.5);
  expect(Math.abs(after.pinWidth - pinExpected(after, 'Full')), 'Full after reload: the pin column fills').toBeLessThanOrEqual(0.5);
  await expect(bottom(page)).toHaveAttribute('data-session-width', 'full');
}

// Invariant: the phone drawer offers no width control.
/** Drawer viewports: the open drawer has the theme toggle but no width button. */
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
