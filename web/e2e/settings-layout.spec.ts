// Every Settings section in the web UI stays inside its column across the
// viewport sweep and the sidebar's widths, with each control on screen,
// uncovered and clear of its neighbours. The Models section's own, deeper
// sweep is settings-models-layout.spec.ts; this one loops every section the
// nav offers and reports every violation at once.
import type { Page } from '@playwright/test';
import { test, expect } from './harness/fixtures.ts';
import { api, installFakePlugin } from './harness/api.ts';

// Underscores and dots, not hyphens: CSS breaks a word at a hyphen, so only this form is unbreakable.
const LONG = 'Extremely_Long_Unbreakable_Token_For_Layout_Testing.v2';
const LONG_SLUG = 'extremely-long-slug-for-layout-test-ab';
const EPS = 0.5;

// SIDEBAR_WIDTH_STORAGE_KEY (web/src/features/sidebar/useSidebarWidth.ts) and the
// clamp's min, default and max (derive.ts); `settle` checks each one lands.
const SIDEBAR_KEY = 'code-conductor:sidebar-width';
const SIDEBARS = [220, 288, 560];
// Below md the sidebar is a drawer, so these widths take no sidebar.
const NARROW = [320, 360, 412, 640, 767];
const WIDE = [768, 900, 1024, 1140, 1280, 1440, 1920];
const PHONE = [320, 360, 412];
// The sections whose overflow was measured before this sweep existed.
const MEASURED = ['conventions', 'backends', 'account', 'voice', 'about'];

type Point = { viewport: number; sidebar: number | null };
const at = (p: Point) => `${p.viewport}px${p.sidebar === null ? '' : `, sidebar ${p.sidebar}`}`;
const points = (): Point[] => test.info().project.name === 'desktop'
  ? [...NARROW.map((viewport) => ({ viewport, sidebar: null })), ...SIDEBARS.flatMap((sidebar) => WIDE.map((viewport) => ({ viewport, sidebar })))]
  : PHONE.map((viewport) => ({ viewport, sidebar: null }));

test.use({ ccOptions: { server: 'settings-layout' } });

test.beforeAll(async ({ cc }) => {
  const ok = async (route: string, body: unknown) => {
    const r = await api(cc, 'POST', route, body);
    expect(r.status, `${route} → ${r.status} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  };
  // Worst-case content: unbreakable ids, labels, templates and env values.
  await ok('/api/settings/models/backends', { id: LONG_SLUG, label: LONG, template: `${LONG} run claude --model {model} --${LONG}`, env: [{ key: `KEY_${LONG.replaceAll('.', '_').toUpperCase()}`, value: LONG }] });
  await ok('/api/settings/models/custom', { label: LONG, model: `${LONG}:cloud`, backend: LONG_SLUG, contextWindow: 256000 });
  for (const scope of ['workspace', 'conductor', 'project']) {
    await ok(`/api/settings/conventions/${scope}`, { slug: LONG_SLUG, name: LONG, description: `${LONG} ${LONG}`, body: 'x' });
  }
  await installFakePlugin(cc, 'layout-plugin');
  // An ordinary user-added system (a realistic, longish label and a worktrees dir), beside the built-in one.
  await ok('/api/settings/systems', { id: 'prod-box', label: 'Production build box (eu-west)', worktreesDir: `/srv/worktrees/${LONG}` });
});

// Rows the server cannot be made to hold in a scratch cc are served page-locally, worst-case: an archived group, an installed plugin that carries every optional line, and library entries.
const ARCHIVED = { groups: [
  { project: LONG, sessions: [{ sessionId: 'aaaaaaaa-1111', title: `${LONG} ${LONG}`, worktreeName: LONG, lastActivity: 1 }, { sessionId: 'bbbbbbbb-2222', firstPrompt: LONG, lastActivity: 1 }] },
  { project: '.conduct', sessions: [{ sessionId: 'cccccccc-3333', title: 'A conductor session', lastActivity: 1 }] },
] };
const LIBRARY = { entries: [
  { id: 'lib-long', name: LONG, description: `${LONG} ${LONG}`, repo: `https://example.test/${LONG}/${LONG}`, installed: true, installedAs: LONG, updateAvailable: true },
  { id: 'lib-plain', name: 'Plain entry', description: 'A short description.', repo: 'https://example.test/plain', installed: false },
], skipped: [] };

async function serveWorstCaseRows(page: Page): Promise<void> {
  await page.route('**/api/archived', (r) => r.fulfill({ json: ARCHIVED }));
  await page.route('**/api/plugins/library', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: LIBRARY }) : r.fallback()));
  await page.route('**/api/plugins', async (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    const res = await r.fetch();
    const body = await res.json() as { rows: Record<string, unknown>[] };
    const base = body.rows[0] ?? {};
    const long = { ...base, id: 'long-plugin', name: LONG, project: LONG, errors: [`${LONG} ${LONG}`], conventions: [{ name: LONG, description: `${LONG} ${LONG}` }] };
    return r.fulfill({ response: res, json: { ...body, rows: [...body.rows, long] } });
  });
}

type Report = { violations: string[]; width: number; controls: number };

// Runs in the page. Every box is read in one frame, before the hit tests scroll anything.
function measure(a: { id: string; eps: number }): Report {
  const { id, eps } = a;
  const shown = (e: Element) => {
    const cs = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && r.width > 0 && r.height > 0 && !e.closest('[aria-hidden="true"]');
  };
  const name = (e: Element) => {
    const lab = e.getAttribute('aria-label') ?? (e.id ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.textContent : null) ?? e.closest('label')?.textContent ?? e.textContent ?? e.getAttribute('title') ?? '';
    return `${e.tagName.toLowerCase()} "${lab.trim().slice(0, 40)}"`;
  };
  const v: string[] = [];
  const de = document.documentElement;
  const column = document.querySelector('[data-settings-view] > .overflow-y-auto')!;
  const section = document.querySelector(`[data-section="${id}"]`)!;
  const s = section.getBoundingClientRect();
  const px = (n: number) => Math.round(n * 10) / 10;

  const colOver = column.scrollWidth - column.clientWidth;
  if (colOver > 0) v.push(`the Settings column scrolls sideways by ${colOver}px`);
  const docOver = de.scrollWidth - de.clientWidth;
  if (docOver > 0) v.push(`the page scrolls sideways by ${docOver}px`);

  // A descendant clipped by a scroll container inside the section is reached by scrolling that container.
  const clipped = (e: Element) => {
    for (let p = e.parentElement; p && p !== section; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox !== 'visible') return true;
    }
    return false;
  };
  let worst = 0;
  let worstTag = '';
  for (const e of section.querySelectorAll('*')) {
    if (!shown(e) || clipped(e)) continue;
    const r = e.getBoundingClientRect();
    const over = Math.max(r.right - s.right, s.left - r.left);
    if (over > eps && over > worst) { worst = over; worstTag = name(e); }
  }
  if (worst > 0) v.push(`content overflows the section by ${px(worst)}px (widest: ${worstTag})`);

  const controls = [...section.querySelectorAll('button, a[href], input, select, textarea, [role="switch"], [role="option"]')].filter(shown);
  const boxes = controls.map((c) => c.getBoundingClientRect());
  controls.forEach((c, i) => {
    const b = boxes[i];
    if (b.left < s.left - eps || b.right > s.right + eps || b.left < -eps || b.right > innerWidth + eps) {
      v.push(`control ${name(c)} [${Math.round(b.left)}..${Math.round(b.right)}] is off screen or outside the section [${Math.round(s.left)}..${Math.round(s.right)}]`);
    }
    for (let j = i + 1; j < controls.length; j++) {
      const o = boxes[j];
      if (c.contains(controls[j]) || controls[j].contains(c)) continue;
      if (Math.min(b.right, o.right) - Math.max(b.left, o.left) > eps && Math.min(b.bottom, o.bottom) - Math.max(b.top, o.top) > eps) {
        v.push(`control ${name(c)} overlaps ${name(controls[j])}`);
      }
    }
  });
  controls.forEach((c) => {
    c.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = c.getBoundingClientRect();
    const h = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    if (!h || !(h === c || c.contains(h) || h.contains(c))) v.push(`control ${name(c)} is covered at its centre`);
  });
  // The sweep relies on seeded rows to make every section non-empty; a section with none renders no control here.
  if (controls.length === 0) v.push('rendered no control with the seeded rows');
  return { violations: v, width: s.width, controls: controls.length };
}

/** Counts requests in flight, so a section is measured once its data has landed. */
function trackRequests(page: Page): () => number {
  let open = 0;
  page.on('request', () => { open++; });
  page.on('requestfinished', () => { open--; });
  page.on('requestfailed', () => { open--; });
  return () => open;
}

async function settle(page: Page, inFlight: () => number): Promise<void> {
  await expect.poll(inFlight, { message: 'requests in flight' }).toBe(0);
  await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))));
  await expect.poll(inFlight, { message: 'requests in flight after render' }).toBe(0);
}

/** Opens what Archived and Conventions keep folded or behind an Add button, so its widest content is on screen. */
async function expand(page: Page, id: string): Promise<void> {
  if (id === 'archived') {
    const groups = page.locator('[data-section="archived"] button[aria-expanded="false"][data-state="closed"]');
    while (await groups.count()) await groups.first().click();
  }
  if (id !== 'conventions') return;
  const folded = page.locator('[data-section="conventions"] button[aria-expanded="false"][data-state="closed"]');
  while (await folded.count()) await folded.first().click();
  const add = page.locator('[data-section="conventions"]').getByRole('button', { name: /^Add custom convention/ });
  while (await add.count()) await add.first().click();
}

test.describe('Settings layout', () => {
  test.describe.configure({ timeout: 900_000 });

  // The invariant: no section overflows its column and every control stays reachable, at every swept viewport and sidebar width.
  test('no Settings section overflows its column, and every control in it stays on screen, uncovered and clear of its siblings, at every swept viewport and sidebar width', async ({ page }) => {
    const inFlight = trackRequests(page);
    await serveWorstCaseRows(page);
    const height = page.viewportSize()!.height;
    await page.goto('/#settings');
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(nav.getByRole('link').first()).toBeVisible();
    const sections = (await nav.getByRole('link').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href')!.replace('#settings/', ''))));
    // Positive control: the sections measured before this sweep exist in this cc's nav.
    for (const id of MEASURED) expect(sections, `the nav lists ${id}`).toContain(id);

    const violations: string[] = [];
    const seen = new Set<string>();
    let seeded: number | null = null;
    for (const p of points()) {
      await page.setViewportSize({ width: p.viewport, height });
      if (p.sidebar !== null && p.sidebar !== seeded) {
        await page.evaluate(([k, w]) => localStorage.setItem(k, w), [SIDEBAR_KEY, String(p.sidebar)] as const);
        await page.reload();
        seeded = p.sidebar;
      }
      for (const id of sections) {
        await nav.getByRole('link', { name: new RegExp(`^${id}$`, 'i') }).click();
        await expect(page.locator(`[data-section="${id}"]`)).toBeVisible();
        await settle(page, inFlight);
        await expand(page, id);
        await settle(page, inFlight);
        if (p.sidebar !== null) {
          expect(await page.locator('aside[data-sidebar]').evaluate((e) => Math.round(e.getBoundingClientRect().width)), `${at(p)}: the sidebar's width`).toBe(p.sidebar);
        }
        const r = await page.evaluate(measure, { id, eps: EPS });
        expect(r.width, `${id} at ${at(p)}: the section's width`).toBeGreaterThan(0);
        seen.add(id);
        for (const m of r.violations) violations.push(`${id} @ ${at(p)}: ${m}`);
      }
    }
    expect([...seen].sort(), 'every nav section was measured').toEqual([...sections].sort());
    expect(violations, `${violations.length} violation(s)`).toEqual([]);
  });
});
