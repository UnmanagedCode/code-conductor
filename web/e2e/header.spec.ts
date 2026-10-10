// The session header's real-browser layout under /next/: what happy-dom cannot
// measure (geometry, computed overflow and touch-action, a real resize across md).
import type { Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { api, createProject, spawnSession } from './harness/api.ts';

test.use({ ccOptions: { server: 'header' } });

// Wide glyphs, so the title overflows even the desktop header once the server
// has cut it to its stored length (src/sessionTitles.ts → MAX_TITLE_LEN).
const LONG_TITLE = 'W'.repeat(200);

/** A live idle worktree session in a fresh project, titled `title`; returns its ids and the title as stored. */
async function seed(cc: Cc, name: string, title: string) {
  const project = `${name}-${test.info().project.name}`;
  await createProject(cc, project);
  const { id, sessionId } = await spawnSession(cc, project, { worktree: true, temp: false });
  await expect.poll(async () => {
    const row = ((await api(cc, 'GET', '/api/instances')).body as { id: string; status: string; sessionId: string | null }[]).find((r) => r.id === id);
    return row?.status === 'idle' && !!row.sessionId;
  }).toBe(true);
  const r = await api(cc, 'PUT', `/api/sessions/${sessionId}/title`, { title });
  expect(r.status, `PUT title: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return { id, sessionId, project, title: r.body.title as string };
}

const isDesktop = () => test.info().project.name === 'desktop';
const sessionHeader = (page: Page) => page.locator('[data-session-header]');
const trigger = (page: Page) => sessionHeader(page).getByRole('button', { name: 'Session actions' });
const barSync = (page: Page) => sessionHeader(page).getByRole('button', { name: 'Sync', exact: true });

/** Opens ⋮ and returns its item names, then closes it again. */
async function menuItems(page: Page): Promise<string[]> {
  await trigger(page).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const names = (await menu.locator('[role^="menuitem"]').allTextContents()).map((t) => t.trim());
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  return names;
}

/** Stops the session through ⋮ → Terminate and its confirm, and waits for Resume. */
async function terminate(page: Page) {
  await trigger(page).click();
  await page.getByRole('menuitem', { name: 'Terminate' }).click();
  await page.getByRole('dialog', { name: 'Terminate this session?' }).getByRole('button', { name: 'Terminate' }).click();
  await expect(sessionHeader(page).getByRole('button', { name: 'Resume' })).toBeVisible();
}

test('a long-titled worktree session: the controls share one row inside the viewport, the title ends in an ellipsis without growing the header, and Sync is in the bar only from md up', async ({ page, cc }) => {
  const { sessionId, title } = await seed(cc, 'hdr-row', LONG_TITLE);
  await page.goto(`/next/#session=${sessionId}`);
  const header = sessionHeader(page);
  const h1 = header.getByRole('heading', { level: 1 });
  await expect(h1).toHaveText(title);

  const geometry = await header.evaluate((h) => {
    const box = h.getBoundingClientRect();
    const centre = box.top + box.height / 2;
    const buttons = [...h.querySelectorAll('button')].filter((b) => b.getClientRects().length > 0).map((b) => {
      const r = b.getBoundingClientRect();
      return { name: b.getAttribute('aria-label') ?? b.textContent!.trim(), offCentre: Math.abs(r.top + r.height / 2 - centre), right: r.right };
    });
    const t = h.querySelector('h1')!;
    return {
      buttons, innerWidth, scrollWidth: h.scrollWidth, clientWidth: h.clientWidth, height: box.height,
      title: { scrollWidth: t.scrollWidth, clientWidth: t.clientWidth, textOverflow: getComputedStyle(t).textOverflow },
    };
  });
  expect(geometry.buttons.length).toBeGreaterThan(0);
  for (const b of geometry.buttons) {
    expect(b.offCentre, `${b.name}: vertical centre`).toBeLessThanOrEqual(2);
    expect(b.right, `${b.name}: right edge`).toBeLessThanOrEqual(geometry.innerWidth);
  }
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.title.scrollWidth).toBeGreaterThan(geometry.title.clientWidth);
  expect(geometry.title.textOverflow).toBe('ellipsis');

  const r = await api(cc, 'PUT', `/api/sessions/${sessionId}/title`, { title: 't' });
  expect(r.status).toBeLessThan(300);
  await expect(h1).toHaveText('t');
  expect(await header.evaluate((h) => h.getBoundingClientRect().height)).toBe(geometry.height);

  if (isDesktop()) {
    await expect(barSync(page)).toBeVisible();
    expect(await menuItems(page)).not.toContain('Sync worktree');
  } else {
    await expect(barSync(page)).toHaveCount(0);
    expect(await menuItems(page)).toContain('Sync worktree');
  }
});

test('nothing in the session header is a scroll container, so the header keeps vertical swipes to itself', async ({ page, cc }) => {
  const { sessionId, title } = await seed(cc, 'hdr-scroll', LONG_TITLE);
  await page.goto(`/next/#session=${sessionId}`);
  const header = sessionHeader(page);
  await expect(header.getByRole('heading', { level: 1 })).toHaveText(title);
  // A scroll container (overflow hidden/auto/scroll) between a touch and the
  // header re-enables the panning the header's touch-action withholds.
  // SVG roots clip by UA style and never scroll.
  const offenders = await header.evaluate((h) => [...h.querySelectorAll('*')]
    .filter((el) => !(el instanceof SVGElement))
    .map((el) => ({ el, cs: getComputedStyle(el) }))
    .filter(({ cs }) => ![cs.overflowX, cs.overflowY].every((o) => o === 'visible' || o === 'clip'))
    .map(({ el, cs }) => `<${el.tagName.toLowerCase()} class="${el.getAttribute('class')}"> "${(el.textContent ?? '').slice(0, 24)}" ${cs.overflowX}/${cs.overflowY}`));
  expect(offenders).toEqual([]);
  expect(await header.evaluate((h) => getComputedStyle(h).touchAction)).toBe('pan-x pinch-zoom');
});

test('a stopped worktree session: ⋮ holds only Sync worktree on a phone and is absent on desktop', async ({ page, cc }) => {
  const { sessionId } = await seed(cc, 'hdr-stopped', 'stopped');
  await page.goto(`/next/#session=${sessionId}`);
  await expect(sessionHeader(page).getByRole('heading', { level: 1 })).toHaveText('stopped');
  await terminate(page);
  if (isDesktop()) {
    await expect(trigger(page)).toHaveCount(0);
    await expect(barSync(page)).toBeVisible();
  } else {
    expect(await menuItems(page)).toEqual(['Sync worktree']);
  }
});

test('resizing across md moves Sync between the bar and ⋮ and closes a stopped worktree session\'s open ⋮', async ({ page, cc }) => {
  test.skip(!isDesktop(), 'resizes a desktop window');
  const { sessionId } = await seed(cc, 'hdr-resize', 'resize');
  const height = page.viewportSize()!.height;
  await page.setViewportSize({ width: 1000, height });
  await page.goto(`/next/#session=${sessionId}`);
  await expect(sessionHeader(page).getByRole('heading', { level: 1 })).toHaveText('resize');
  await expect(barSync(page)).toBeVisible();
  await page.setViewportSize({ width: 700, height });
  await expect(barSync(page)).toHaveCount(0);
  expect(await menuItems(page)).toContain('Sync worktree');
  await page.setViewportSize({ width: 1000, height });
  await expect(barSync(page)).toBeVisible();
  expect(await menuItems(page)).not.toContain('Sync worktree');

  await terminate(page);
  await page.setViewportSize({ width: 700, height });
  await trigger(page).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.setViewportSize({ width: 1000, height });
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(trigger(page)).toHaveCount(0);
});
