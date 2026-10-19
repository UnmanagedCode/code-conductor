// The session ⋮ menu's submenus in a real browser: on a phone Change model and Change effort drill in place
// inside the menu (every row on screen, uncut and tappable); from md up they open beside it.
import type { Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { api, createProject, spawnSession } from './harness/api.ts';

type Which = 'Change model' | 'Change effort';
type Ctx = { page: Page; cc: Cc };

// Long labels, wider than a phone's menu, and enough of them that the list is taller than the room under ⋮.
const SEEDED = 14;
const label = (n: number) => `Gemini 2.5 Flash Preview (OpenCode) #${String(n).padStart(2, '0')}`;
const LABELS = Array.from({ length: SEEDED }, (_, i) => label(i + 1));

let sessionId = '';

export async function seedSession(cc: Cc): Promise<void> {
  for (let i = 1; i <= SEEDED; i++) {
    const r = await api(cc, 'POST', '/api/settings/models/custom', { label: label(i), model: `gemini-2.5-flash-preview-${i}`, backend: 'ollama', contextWindow: 128000 });
    expect(r.status, `POST custom model ${i} → ${r.status} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  }
  // Positive control: the catalog the header reads offers every seeded label.
  const listed = ((await api(cc, 'GET', '/api/settings/models')).body.backendModels.ollama as { label: string }[]).map((m) => m.label);
  for (const l of LABELS) expect(listed, `seeded ${l}`).toContain(l);
  const project = `submenus-${test.info().project.name}`;
  await createProject(cc, project);
  const spawned = await spawnSession(cc, project, { temp: false });
  await expect.poll(async () => {
    const row = ((await api(cc, 'GET', '/api/instances')).body as { id: string; status: string; sessionId: string | null }[]).find((r) => r.id === spawned.id);
    return row?.status === 'idle' && !!row.sessionId;
  }).toBe(true);
  sessionId = spawned.sessionId;
}

const isDesktop = () => test.info().project.name === 'desktop';
const menus = (page: Page) => page.locator('[role="menu"]:visible');
const subItems = (page: Page) => page.locator('[data-slot="dropdown-menu-sub-content"]:visible [role^="menuitem"]');
const subTrigger = (page: Page, which: Which) => page.getByRole('menuitem', { name: which });

async function openMenu(page: Page) {
  await page.goto(`/#session=${sessionId}`);
  await page.locator('[data-session-header]').getByRole('button', { name: 'Session actions' }).click();
  await expect(menus(page)).toHaveCount(1);
}

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

/** Every geometry violation of the open menus and the submenu rows, as text. */
async function violations(page: Page): Promise<string[]> {
  const out: string[] = [];
  const found = await page.evaluate(() => {
    const vis = (el: Element) => el.getClientRects().length > 0;
    const rect = (el: Element): Rect => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const bad: string[] = [];
    const inside = (r: Rect) => r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    for (const menu of [...document.querySelectorAll('[role="menu"]')].filter(vis)) {
      const mr = rect(menu);
      if (mr.width <= 0 || mr.height <= 0) bad.push('menu has no size');
      if (mr.left < 0 || mr.right > innerWidth) bad.push(`menu runs off the sides: ${JSON.stringify(mr)}`);
      if (mr.height > innerHeight) bad.push(`menu is taller than the viewport: ${mr.height} > ${innerHeight}`);
    }
    for (const item of [...document.querySelectorAll('[data-slot="dropdown-menu-sub-content"] [role^="menuitem"]')].filter(vis)) {
      const name = item.textContent!.trim();
      item.scrollIntoView({ block: 'nearest' }); // each row is measured where scrolling puts it
      const r = rect(item);
      const menu = item.closest('[role="menu"]')!;
      const mr = rect(menu);
      if (r.width <= 0 || r.height <= 0) { bad.push(`${name}: no size`); continue; }
      if (!inside(r)) bad.push(`${name}: outside the viewport ${JSON.stringify(r)}`);
      if (r.left < mr.left - 0.5 || r.right > mr.right + 0.5 || r.top < mr.top - 0.5 || r.bottom > mr.bottom + 0.5) bad.push(`${name}: outside its menu ${JSON.stringify({ r, mr })}`);
      const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
      if (!hit || !(hit === item || item.contains(hit))) bad.push(`${name}: not hit at its centre`);
      const span = item.querySelector('span');
      if (span) {
        if (span.scrollWidth > span.clientWidth) bad.push(`${name}: label cut (${span.scrollWidth} > ${span.clientWidth})`);
        for (const c of span.getClientRects()) if (c.left < 0 || c.right > innerWidth) bad.push(`${name}: label outside the viewport`);
      }
    }
    return bad;
  });
  out.push(...found);
  return out;
}

// Invariant: whatever the width, a submenu's every row is inside the viewport and its own menu, has a size, is hit at
// its centre and shows its label uncut; on desktop the submenu floats beside the parent menu, on a phone it replaces
// the parent's rows inside the one menu and its row is the way back.
export function submenusFlow(which: Which) {
  return async ({ page }: Ctx) => {
    test.setTimeout(90_000);
    await openMenu(page);
    const trigger = subTrigger(page, which);
    await trigger.click();
    if (which === 'Change model') {
      // Positive control: the claude tiers and every seeded label are rows, so the list is the long one.
      await expect(subItems(page)).not.toHaveCount(0);
      expect(await subItems(page).count()).toBeGreaterThanOrEqual(SEEDED + 2);
      await expect(subItems(page).filter({ hasText: LABELS[SEEDED - 1] }).first()).toBeAttached();
    } else {
      expect(await subItems(page).count()).toBeGreaterThan(0);
    }
    if (isDesktop()) {
      await expect(menus(page)).toHaveCount(2);
      await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
      await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
      const [parent, sub] = await menus(page).evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right }; }));
      // Radix tucks a cascading submenu a few px under its parent's edge.
      const TUCK = 8;
      if (which === 'Change model') {
        // Fixture check: the floating list overflowed its capped height, so the last row is reached by scrolling.
        const overflow = await menus(page).last().evaluate((m) => m.scrollHeight - m.clientHeight);
        expect(overflow, 'the floating model list is taller than its capped menu').toBeGreaterThan(0);
      }
      expect(sub.left >= parent.right - TUCK || sub.right <= parent.left + TUCK, `the submenu sits beside the parent: ${JSON.stringify({ parent, sub })}`).toBe(true);
    } else {
      await expect(menus(page)).toHaveCount(1);
      await expect(page.getByRole('menuitem', { name: 'Rename' })).toHaveCount(0);
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      if (which === 'Change model') {
        // Fixture check: the drilled list overflows the menu, so the scrolling arm really ran.
        const overflow = await menus(page).evaluate((m) => m.scrollHeight - m.clientHeight);
        expect(overflow, 'the drilled model list is taller than its menu').toBeGreaterThan(0);
        await test.info().attach('drilled-change-model', { body: await page.screenshot(), contentType: 'image/png' });
      }
    }
    const bad = await violations(page);
    expect(bad, bad.join('\n')).toEqual([]);
    if (which === 'Change model') {
      // The violations pass ended on the last row. A user can scroll the list only if its overflow is auto/scroll
      // (scrollIntoView also moves an overflow:hidden box), and the last row was reached by scrolling.
      const { overflowY, scrollTop } = await menus(page).last().evaluate((m) => ({ overflowY: getComputedStyle(m).overflowY, scrollTop: m.scrollTop }));
      expect(['auto', 'scroll'], 'the capped model list is user-scrollable').toContain(overflowY);
      expect(scrollTop, 'reaching the last row scrolled the list').toBeGreaterThan(0);
    }
    if (!isDesktop()) {
      await trigger.click();
      await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    }
  };
}

// Invariant: on a phone, after Change model drills and returns, Change effort drills and fits the same way.
export async function drillThenEffortFlow({ page }: Ctx) {
  test.skip(isDesktop(), 'the cascade has no back row');
  await openMenu(page);
  await subTrigger(page, 'Change model').click();
  await subTrigger(page, 'Change model').click();
  await subTrigger(page, 'Change effort').click();
  await expect(menus(page)).toHaveCount(1);
  await expect(page.getByRole('menuitem', { name: 'Change model' })).toHaveCount(0);
  const bad = await violations(page);
  expect(bad, bad.join('\n')).toEqual([]);
}
