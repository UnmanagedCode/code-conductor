// The session header's real-browser layout: what happy-dom cannot
// measure (geometry, computed overflow and touch-action, a real resize across md).
import type { Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { api, createProject, mcpCall, spawnSession } from './harness/api.ts';
import { colourOf, spawnConductor, spawnWorker } from './flows/fleet.ts';

test.use({ ccOptions: { server: 'header' } });

// Wide glyphs, so the title overflows even the desktop header once the server
// has cut it to its stored length (src/sessionTitles.ts → MAX_TITLE_LEN); words,
// so a title that lost `nowrap` could wrap.
const LONG_TITLE = 'WWWWWWW '.repeat(25).trim();

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
  await page.goto(`/#session=${sessionId}`);
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
    /** How many distinct line boxes an element's text lays out on. */
    const lines = (el: Element) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
    };
    // Negative control: the same text, allowed to wrap at the title's width, lays out on more than one line, so the probe can read a wrap.
    const probe = t.cloneNode(true) as HTMLElement;
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:normal;width:${t.clientWidth}px`;
    t.after(probe);
    const wrapped = lines(probe);
    probe.remove();
    return {
      buttons, innerWidth, scrollWidth: h.scrollWidth, clientWidth: h.clientWidth, height: box.height,
      title: { scrollWidth: t.scrollWidth, clientWidth: t.clientWidth, textOverflow: getComputedStyle(t).textOverflow, lines: lines(t), wrapped, right: t.getBoundingClientRect().right, headerRight: box.right },
    };
  });
  expect(geometry.buttons.length).toBeGreaterThan(0);
  for (const b of geometry.buttons) {
    expect(b.offCentre, `${b.name}: vertical centre`).toBeLessThanOrEqual(2);
    expect(b.right, `${b.name}: right edge`).toBeLessThanOrEqual(geometry.innerWidth);
  }
  // Invariant: a long title stays on one line, overflowing its own box but not the header, and is cut with an ellipsis.
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.title.scrollWidth).toBeGreaterThan(geometry.title.clientWidth);
  expect(geometry.title.right, 'the title ends inside the header').toBeLessThanOrEqual(geometry.title.headerRight);
  // The ellipsis glyph is drawn by text-overflow and is in no DOM text, so the computed value is its only observable.
  expect(geometry.title.textOverflow).toBe('ellipsis');
  expect(title, 'the stored title has break opportunities').toContain(' ');
  expect(geometry.title.lines, 'the title lays out on one line').toBe(1);
  expect(geometry.title.wrapped, 'the same text allowed to wrap takes several lines').toBeGreaterThan(1);

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

test('the subline\'s project and worktree names, and the model badge on desktop, each clip with an ellipsis inside the header', async ({ page, cc }) => {
  // Invariant: a long project, worktree and (desktop) model name each stay on one line, overflowing a box that clips rather than spills, with an ellipsis, inside a header no taller than a short-named one; a short name does not overflow its box.
  // The header a short project and worktree name give, to compare heights against.
  const short = await seed(cc, 'hdr-short', 't');
  await page.goto(`/#session=${short.sessionId}`);
  const header = sessionHeader(page);
  await expect(header.getByRole('heading', { level: 1 })).toHaveText('t');
  const shortHeight = await header.evaluate((h) => h.getBoundingClientRect().height);
  const shortName = await header.evaluate((h, text) => {
    const el = [...h.querySelectorAll('span')].filter((s) => s.textContent === text).at(-1);
    return el ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth } : null;
  }, short.project);
  expect(shortName, 'the short project name is rendered').not.toBeNull();
  expect(shortName!.scrollWidth, 'a short name fits its box').toBeLessThanOrEqual(shortName!.clientWidth);

  // Wide glyphs, hyphenated so a name that lost `nowrap` could wrap. Project
  // names have no length cap. POST /api/instances takes no worktree name, so the
  // worktree is created by MCP create_worktree, which slugs and cuts the name
  // (src/worktrees.ts → SLUG_MAX_LEN), and the session is spawned into it.
  const project = `${'WWWW-'.repeat(16)}${test.info().project.name}`;
  const model = `claude-opus-${'w'.repeat(60)}`;
  await createProject(cc, project);
  const created = await mcpCall(cc, 'create_worktree', { project, name: 'wwww-'.repeat(40) });
  expect(created.isError, JSON.stringify(created.content)).toBeFalsy();
  const listed = (await api(cc, 'GET', `/api/projects/${project}/worktrees`)).body as { worktreeName: string }[];
  expect(listed).toHaveLength(1);
  const worktreeName = listed[0].worktreeName;
  expect(worktreeName.length, 'the slugged worktree name is long').toBeGreaterThan(30);
  const { id, sessionId } = await spawnSession(cc, project, { worktree: worktreeName, model, temp: false });
  let row: { status: string; model: string | null; worktree: { worktreeName: string } | null } | undefined;
  await expect.poll(async () => {
    row = ((await api(cc, 'GET', '/api/instances')).body as ({ id: string } & NonNullable<typeof row>)[]).find((r) => r.id === id);
    return row?.status;
  }).toBe('idle');
  expect(row!.model, 'the spawn kept the long model id').toBe(model);
  expect(row!.worktree!.worktreeName, 'the session runs in the named worktree').toBe(worktreeName);
  // The subline shows the project only under a custom title.
  expect((await api(cc, 'PUT', `/api/sessions/${sessionId}/title`, { title: 't' })).status).toBeLessThan(300);
  await page.goto(`/#session=${sessionId}`);
  await expect(header.getByRole('heading', { level: 1 })).toHaveText('t');
  await expect(header).toContainText(worktreeName);

  // The model badge is `lg:` only: display: none on a phone, so nothing there to overflow.
  const texts = isDesktop() ? [project, worktreeName, model] : [project, worktreeName];
  const measured = await header.evaluate((h, texts) => {
    const box = h.getBoundingClientRect();
    return {
      scrollWidth: h.scrollWidth, clientWidth: h.clientWidth, height: box.height,
      els: texts.map((text) => {
        // The innermost span holding exactly the text: the model badge's own textContent is the model too.
        const el = [...h.querySelectorAll('span')].filter((s) => s.textContent === text).at(-1);
        if (!el) return { text, found: false };
        const cs = getComputedStyle(el);
        return {
          text, found: true, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, whiteSpace: cs.whiteSpace,
          textOverflow: cs.textOverflow, overflowX: cs.overflowX, right: el.getBoundingClientRect().right, headerRight: box.right,
        };
      }),
    };
  }, texts);
  expect(measured.scrollWidth, 'the header does not overflow sideways').toBeLessThanOrEqual(measured.clientWidth);
  expect(measured.height, 'long names do not make the header taller').toBe(shortHeight);
  for (const el of measured.els) {
    const name = el.text.slice(0, 24);
    expect(el.found, `${name}: rendered`).toBe(true);
    expect(el.clientWidth!, `${name}: shows a clipped part, not squeezed away`).toBeGreaterThan(0);
    expect(el.scrollWidth!, `${name}: overflows its box`).toBeGreaterThan(el.clientWidth!);
    expect(el.whiteSpace, `${name}: one line`).toBe('nowrap');
    expect(el.overflowX, `${name}: clipped, not spilling`).not.toBe('visible');
    expect(el.textOverflow, `${name}: ellipsized`).toBe('ellipsis');
    expect(el.right!, `${name}: inside the header`).toBeLessThanOrEqual(el.headerRight!);
  }
});

test('nothing in the session header is a scroll container, so the header keeps vertical swipes to itself', async ({ page, cc }) => {
  const { sessionId, title } = await seed(cc, 'hdr-scroll', LONG_TITLE);
  await page.goto(`/#session=${sessionId}`);
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
  await page.goto(`/#session=${sessionId}`);
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
  // md is 768px: the header's Open sidebar button (the drawer's opener) shows
  // below it, so Sync must leave the bar at exactly the same width.
  const NARROW = 767;
  const WIDE = 768;
  const { sessionId } = await seed(cc, 'hdr-resize', 'resize');
  const height = page.viewportSize()!.height;
  const drawerOpener = sessionHeader(page).getByRole('button', { name: 'Open sidebar' });
  const expectWide = async () => {
    await expect(drawerOpener).toBeHidden();
    await expect(barSync(page)).toBeVisible();
  };
  const expectNarrow = async () => {
    await expect(drawerOpener).toBeVisible();
    await expect(barSync(page)).toHaveCount(0);
  };
  await page.setViewportSize({ width: WIDE, height });
  await page.goto(`/#session=${sessionId}`);
  await expect(sessionHeader(page).getByRole('heading', { level: 1 })).toHaveText('resize');
  await expectWide();
  expect(await menuItems(page)).not.toContain('Sync worktree');
  await page.setViewportSize({ width: NARROW, height });
  await expectNarrow();
  expect(await menuItems(page)).toContain('Sync worktree');
  await page.setViewportSize({ width: WIDE, height });
  await expectWide();
  expect(await menuItems(page)).not.toContain('Sync worktree');

  await terminate(page);
  await page.setViewportSize({ width: NARROW, height });
  await expectNarrow();
  await trigger(page).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.setViewportSize({ width: WIDE, height });
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(trigger(page)).toHaveCount(0);
  await expect(barSync(page)).toBeVisible();
});

test("a conducted worker's owner chip fits line 2: the header keeps its height, nothing overflows sideways, and the chip and the worktree name both ellipsize", async ({ page, cc }) => {
  // Invariant: with a long owner label and a long worktree name, line 2 stays one row inside the viewport and a header no taller than a hand-spawned one's; the chip and the worktree clip with an ellipsis, and the chip's bar is the owner's colour.
  const short = await seed(cc, 'hdr-own-short', 't');
  await page.goto(`/#session=${short.sessionId}`);
  const header = sessionHeader(page);
  await expect(header.getByRole('heading', { level: 1 })).toHaveText('t');
  const shortHeight = await header.evaluate((h) => h.getBoundingClientRect().height);

  const project = `hdr-own-${test.info().project.name}`;
  await createProject(cc, project);
  await api(cc, 'POST', '/api/projects/.conduct/ensure');
  const conductor = await spawnConductor(cc, true);
  const title = (await api(cc, 'PUT', `/api/sessions/${conductor.sessionId}/title`, { title: LONG_TITLE })).body.title as string;
  const created = await mcpCall(cc, 'create_worktree', { project, name: 'wwww-'.repeat(40) });
  expect(created.isError, JSON.stringify(created.content)).toBeFalsy();
  const worktreeName = ((await api(cc, 'GET', `/api/projects/${project}/worktrees`)).body as { worktreeName: string }[])[0].worktreeName;
  const worker = await spawnWorker(cc, conductor.id, { project, worktree: worktreeName });
  expect((await api(cc, 'PUT', `/api/sessions/${worker.sessionId}/title`, { title: 't' })).status).toBeLessThan(300);

  await page.goto(`/#session=${worker.sessionId}`);
  const chip = header.getByRole('button', { name: `Back to ${title}` });
  await expect(chip).toBeVisible();
  await expect(header).toContainText(worktreeName);
  const measured = await header.evaluate((h, worktreeName) => {
    const box = h.getBoundingClientRect();
    const chipEl = h.querySelector('[data-owner-chip]') as HTMLElement;
    const wt = [...h.querySelectorAll('span')].filter((s) => s.textContent === worktreeName).at(-1)!;
    const clip = (el: Element) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, textOverflow: cs.textOverflow, right: r.right };
    };
    const label = chipEl.querySelector('span')!;
    const probe = document.createElement('i');
    probe.style.color = chipEl.style.getPropertyValue('--owner-color');
    document.body.appendChild(probe);
    const bar = getComputedStyle(probe).color;
    probe.remove();
    return { height: box.height, scrollWidth: h.scrollWidth, clientWidth: h.clientWidth, headerRight: box.right, label: clip(label), chipRight: chipEl.getBoundingClientRect().right, wt: clip(wt), bar };
  }, worktreeName);
  expect(measured.height, 'the chip does not make the header taller').toBe(shortHeight);
  expect(measured.scrollWidth, 'the header does not overflow sideways').toBeLessThanOrEqual(measured.clientWidth);
  expect(measured.label.scrollWidth, 'the chip label overflows its box').toBeGreaterThan(measured.label.clientWidth);
  expect(measured.label.textOverflow).toBe('ellipsis');
  expect(measured.wt.scrollWidth, 'the worktree name overflows its box').toBeGreaterThan(measured.wt.clientWidth);
  expect(measured.wt.textOverflow).toBe('ellipsis');
  expect(measured.chipRight, 'the chip ends inside the header').toBeLessThanOrEqual(measured.headerRight);
  expect(measured.bar, "the chip carries the owner's colour").toBe(await colourOf(page, conductor.sessionId));
});
