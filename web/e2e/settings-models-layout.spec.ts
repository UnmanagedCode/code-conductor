// Settings → Models layout in the web UI across viewports and the sidebar's
// widths: nothing overflows, the selected model reads, every select is
// captioned, every control is tappable, and the Settings nav changes form with
// its column. The DOM this rests on is
// web/src/features/settings/models/fieldLabels.test.tsx.
import type { Page } from '@playwright/test';
import { test, expect } from './harness/fixtures.ts';
import { api } from './harness/api.ts';

// Single unbreakable tokens: a CUSTOM_ROLE_MAX-length role name and a long model id.
const LONG_ROLE = 'Extremely-Long-Custom-Role-Name-For-Test';
const LONG_MODEL = 'qwen3-coder-480b-a35b-instruct-fp8:cloud-preview-20260101';
const LONG_LABEL = 'MyVeryLongLocalModelLabelForLayoutTesting';
// A user role on a Claude model: a role row whose model select must read.
const READ_ROLE = 'tester';
const EPS = 0.5;

// SIDEBAR_WIDTH_STORAGE_KEY (web/src/features/sidebar/useSidebarWidth.ts) and the
// clamp's min, default and max (derive.ts); `settle` checks each one lands.
const SIDEBAR_KEY = 'code-conductor:sidebar-width';
const SIDEBARS = [220, 288, 560];
// Below md the sidebar is a drawer, so these widths take no sidebar.
const NARROW = [320, 360, 412, 640, 767];
const WIDE = [768, 900, 1024, 1140, 1280, 1440, 1920];
const PHONE = [320, 360, 412];

type Point = { viewport: number; sidebar: number | null };
const at = (p: Point) => `${p.viewport}px${p.sidebar === null ? '' : `, sidebar ${p.sidebar}`}`;
const points = (): Point[] => test.info().project.name === 'desktop'
  ? [...NARROW.map((viewport) => ({ viewport, sidebar: null })), ...SIDEBARS.flatMap((sidebar) => WIDE.map((viewport) => ({ viewport, sidebar })))]
  : PHONE.map((viewport) => ({ viewport, sidebar: null }));

// Counted from the seeded payload.
let TIERS = 0;
let SELECTS = 0;
let CONTROLS = 0;
// The model selects that must read, as row + bound model: every Claude-bound tier and READ_ROLE.
let READ: { row: string; model: string }[] = [];

test.use({ ccOptions: { server: 'settings-models-layout' } });

test.beforeAll(async ({ cc }) => {
  const post = async (route: string, body: unknown) => {
    const r = await api(cc, 'POST', route, body);
    expect(r.status, `${route} → ${r.status} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  };
  await post('/api/settings/models/custom', { label: LONG_LABEL, model: LONG_MODEL, backend: 'ollama', contextWindow: 256000 });
  await post('/api/settings/models/prefs', { tierBackend: { tier: 'frontier', backend: { backend: 'ollama', model: LONG_MODEL } } });
  await post('/api/settings/models/roles', { role: LONG_ROLE });
  await post('/api/settings/models/prefs', { roleBackend: { role: LONG_ROLE, backend: { backend: 'ollama', model: LONG_MODEL } } });
  await post('/api/settings/models/roles', { role: READ_ROLE });
  await post('/api/settings/models/prefs', { roleBackend: { role: READ_ROLE, backend: { backend: 'claude', model: 'claude-sonnet-5-5' } } });
  type Bound = { kind?: string; backend?: string; model?: string };
  const m = (await api<{ tiers: { tier: string }[]; tierBackend: Record<string, Bound>; roles: { role: string; builtin?: boolean; plugin?: string }[]; roleBackend: Record<string, Bound> }>(cc, 'GET', '/api/settings/models')).body;
  const custom = (role: string) => m.roleBackend[role]?.kind !== 'tier';
  TIERS = m.tiers.length;
  SELECTS = TIERS * 3 + m.roles.reduce((n, r) => n + (custom(r.role) ? 4 : 2), 0);
  CONTROLS = SELECTS + TIERS * 2 + m.roles.filter((r) => !r.builtin && !r.plugin).length;
  READ = [
    ...m.tiers.flatMap((t) => (m.tierBackend[t.tier]?.backend === 'claude' ? [{ row: t.tier, model: m.tierBackend[t.tier].model ?? '' }] : [])),
    { row: READ_ROLE, model: m.roleBackend[READ_ROLE]?.model ?? '' },
  ];
  // Positive control on the seeds: three Claude tiers (Frontier is on the long id) and the Claude-bound role.
  expect(READ.map((r) => r.row).sort()).toEqual(['balanced', 'fast', 'powerful', READ_ROLE].sort());
});

type Box = { left: number; right: number; top: number; bottom: number };
type Control = { name: string; row: string; kind: 'select' | 'radio' | 'other'; value: string; box: Box; caption: string | null; text: string; room: number; textWidth: number; hit: boolean };
type Layout = { docOver: number; columnOver: number; section: Box & { width: number }; nav: Box; tierHeader: boolean; escapes: string[]; overlaps: string[]; controls: Control[] };

// Runs in the page. Every box (the section, the nav, each control) is read in one frame, before the hit tests scroll anything.
function layout(eps: number): Layout {
  const box = (e: Element): Box => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
  const shown = (e: Element | null | undefined): e is Element => {
    if (!e) return false;
    const cs = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const tag = (e: Element) => `${e.tagName.toLowerCase()}${e.getAttribute('aria-label') ? ` "${e.getAttribute('aria-label')}"` : ''}`;
  const de = document.documentElement;
  const column = document.querySelector('[data-settings-view] > .overflow-y-auto')!;
  const section = document.querySelector('[data-section="models"]')!;
  const s = section.getBoundingClientRect();
  const sectionBox = { ...box(section), width: s.width };
  const navBox = box(document.querySelector('nav[aria-label="Settings sections"]')!);
  const header = document.querySelector('[data-testid="tier-list"]')?.previousElementSibling ?? null;
  const escapes = [...section.querySelectorAll('*')].flatMap((e) => {
    const r = e.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return [];
    return r.left < s.left - eps || r.right > s.right + eps
      ? [`${tag(e)} [${Math.round(r.left)}..${Math.round(r.right)}] outside [${Math.round(s.left)}..${Math.round(s.right)}]`]
      : [];
  });
  const ctx = document.createElement('canvas').getContext('2d')!;
  const rows = [...document.querySelectorAll('[data-testid="tier-list"] > li, [data-testid="role-list"] > li')];
  const own = (li: Element) => [...li.querySelectorAll('select, button, input')].filter((c) => shown(c));
  const overlaps: string[] = [];
  const controls: Control[] = [];
  for (const li of rows) {
    const row = li.getAttribute('data-tier') ?? li.getAttribute('data-role') ?? '?';
    const cs = own(li);
    const boxes = cs.map(box);
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > eps && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > eps) {
          overlaps.push(`${row}: ${tag(cs[i])} overlaps ${tag(cs[j])}`);
        }
      }
    }
    cs.forEach((c, i) => {
      const isSelect = c instanceof HTMLSelectElement;
      const isRadio = c instanceof HTMLInputElement && c.type === 'radio';
      const cap = isRadio ? c.closest('label')?.querySelector('span') : c.id ? document.querySelector(`label[for="${CSS.escape(c.id)}"]`) : null;
      let caption = shown(cap) ? (cap.textContent ?? '').trim() || null : null;
      if (caption === null && shown(header)) {
        const x = (boxes[i].left + boxes[i].right) / 2;
        const cell = [...header.children].find((h) => { const r = h.getBoundingClientRect(); return r.left <= x && x <= r.right; });
        caption = (cell?.textContent ?? '').trim() || null;
      }
      let text = '';
      let room = 0;
      let textWidth = 0;
      if (c instanceof HTMLSelectElement) {
        const st = getComputedStyle(c);
        text = (c.selectedOptions[0]?.textContent ?? '').split(' — ')[0];
        room = c.clientWidth - parseFloat(st.paddingLeft) - parseFloat(st.paddingRight);
        ctx.font = `${st.fontStyle} ${st.fontWeight} ${st.fontSize} ${st.fontFamily}`;
        textWidth = ctx.measureText(text).width;
      }
      const value = c instanceof HTMLSelectElement ? c.value : '';
      controls.push({ name: c.getAttribute('aria-label') ?? '', row, kind: isSelect ? 'select' : isRadio ? 'radio' : 'other', value, box: boxes[i], caption, text, room, textWidth, hit: false });
    });
  }
  rows.flatMap(own).forEach((c, i) => {
    c.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = c.getBoundingClientRect();
    const h = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    controls[i].hit = !!h && (h === c || c.contains(h));
  });
  return {
    docOver: de.scrollWidth - de.clientWidth,
    columnOver: column.scrollWidth - column.clientWidth,
    section: sectionBox,
    nav: navBox,
    tierHeader: shown(header),
    escapes,
    overlaps,
    controls,
  };
}

/** Waits for the rows, the web font and two frames; checks the sidebar is the width the point names. */
async function settle(page: Page, p: Point): Promise<void> {
  await expect(page.locator(`[data-role="${LONG_ROLE}"] select[aria-label^="Model for"]`)).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))));
  if (p.sidebar !== null) {
    expect(await page.locator('aside[data-sidebar]').evaluate((e) => Math.round(e.getBoundingClientRect().width)), `${at(p)}: the sidebar's width`).toBe(p.sidebar);
  }
}

async function seedSidebar(page: Page, width: number): Promise<void> {
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [SIDEBAR_KEY, String(width)] as const);
  await page.reload();
}

/** Lays Settings → Models out at each swept point and hands each to `visit`. */
async function sweep(page: Page, visit: (p: Point) => Promise<void>): Promise<void> {
  const height = page.viewportSize()!.height;
  await page.goto('/next/#settings/models');
  let seeded: number | null = null;
  for (const p of points()) {
    await page.setViewportSize({ width: p.viewport, height });
    if (p.sidebar !== null && p.sidebar !== seeded) {
      await seedSidebar(page, p.sidebar);
      seeded = p.sidebar;
    }
    await settle(page, p);
    await visit(p);
  }
}

test.describe('Settings → Models layout', () => {
  test.describe.configure({ timeout: 120_000 });

  // No swept width or sidebar makes the page, the Settings column or the Models section overflow.
  test('nothing overflows the page, the Settings column or the Models section at any swept viewport and sidebar width', async ({ page }) => {
    await sweep(page, async (p) => {
      const m = await page.evaluate(layout, EPS);
      expect(m.section.width, `${at(p)}: the Models section's width`).toBeGreaterThan(0);
      expect(m.controls.filter((c) => c.kind === 'select'), `${at(p)}: selects`).toHaveLength(SELECTS);
      expect(m.docOver, `${at(p)}: the page scrolls sideways`).toBeLessThanOrEqual(0);
      expect(m.columnOver, `${at(p)}: the Settings column scrolls sideways`).toBeLessThanOrEqual(0);
      expect(m.escapes, `${at(p)}: boxes outside the Models section`).toEqual([]);
    });
  });

  // Wherever the column is at least a 320px phone's, each Claude model's name fits its select's text room.
  test("the selected model's name fits its select wherever the Models column is at least as wide as on a 320px phone", async ({ page }) => {
    let floor: number | null = null;
    await sweep(page, async (p) => {
      const m = await page.evaluate(layout, EPS);
      if (p.viewport === 320) floor = m.section.width;
      const targets = m.controls.filter((c) => c.kind === 'select' && READ.some((r) => r.row === c.row && r.model === c.value));
      expect(targets.map((c) => c.row).sort(), `${at(p)}: the model selects that must read`).toEqual(READ.map((r) => r.row).sort());
      for (const c of targets) expect(c.text, `${at(p)}: ${c.name} shows a model`).not.toBe('');
      expect(floor, 'the sweep starts at 320px').not.toBeNull();
      if (m.section.width < floor! - EPS) return;
      for (const c of targets) {
        expect(c.textWidth, `${at(p)}: '${c.text}' needs ${Math.ceil(c.textWidth)}px in ${c.name}, which has ${Math.floor(c.room)}px`).toBeLessThanOrEqual(c.room + EPS);
      }
    });
  });

  // Each tier and role select and each default radio shows a caption its name contains; the one-line tier form exists.
  test('every tier and role select and every default radio shows a caption its name contains: its own when the row stacks, the column header when it is one line', async ({ page }) => {
    let oneLine = false;
    await sweep(page, async (p) => {
      const m = await page.evaluate(layout, EPS);
      const named = m.controls.filter((c) => c.kind !== 'other');
      expect(named, `${at(p)}: selects and radios`).toHaveLength(SELECTS + TIERS);
      for (const c of named) {
        expect(c.caption, `${at(p)}: ${c.name} shows no caption`).not.toBeNull();
        expect(c.name.toLowerCase(), `${at(p)}: ${c.name} vs its caption`).toContain(c.caption!.toLowerCase());
      }
      if (m.tierHeader) oneLine = true;
    });
    if (test.info().project.name === 'desktop') expect(oneLine, 'no swept width laid the tiers out on one line').toBe(true);
  });

  // Every control is on screen, inside the section, the topmost element at its centre, and overlaps no sibling control.
  test("every control is on screen, inside the Models section, uncovered at its centre and clear of its row's other controls", async ({ page }) => {
    await sweep(page, async (p) => {
      const m = await page.evaluate(layout, EPS);
      expect(m.controls, `${at(p)}: controls`).toHaveLength(CONTROLS);
      for (const c of m.controls) {
        const inside = c.box.left >= m.section.left - EPS && c.box.right <= m.section.right + EPS && c.box.left >= -EPS && c.box.right <= p.viewport + EPS;
        expect(inside, `${at(p)}: ${c.row} ${c.name} [${Math.round(c.box.left)}..${Math.round(c.box.right)}] is off screen or outside the section`).toBe(true);
        expect(c.hit, `${at(p)}: ${c.row} ${c.name} is covered at its centre`).toBe(true);
      }
      expect(m.overlaps, `${at(p)}: overlapping controls`).toEqual([]);
    });
  });

  // The nav is beside the content at the widest column and above it at the narrowest; every link is hit-testable and navigates.
  test('the Settings nav sits beside the content where the column has room and above it where it has not, and every section link is reachable in both forms', async ({ page }) => {
    const cases: (Point & { form: 'beside' | 'above' })[] = test.info().project.name === 'desktop'
      ? [{ viewport: 1920, sidebar: 220, form: 'beside' }, { viewport: 768, sidebar: 560, form: 'above' }]
      : [{ viewport: 412, sidebar: null, form: 'above' }];
    const height = page.viewportSize()!.height;
    await page.goto('/next/#settings/models');
    for (const c of cases) {
      await page.setViewportSize({ width: c.viewport, height });
      if (c.sidebar !== null) await seedSidebar(page, c.sidebar);
      await settle(page, c);
      const { nav, section } = await page.evaluate(layout, EPS);
      if (c.form === 'beside') expect(nav.right, `${at(c)}: the nav's right edge vs the section's left`).toBeLessThanOrEqual(section.left + EPS);
      else expect(nav.bottom, `${at(c)}: the nav's bottom vs the section's top`).toBeLessThanOrEqual(section.top + EPS);
      const navLocator = page.getByRole('navigation', { name: 'Settings sections' });
      const links = navLocator.getByRole('link');
      const n = await links.count();
      expect(n, `${at(c)}: section links`).toBeGreaterThan(1);
      for (let i = 0; i < n; i++) {
        const hit = await links.nth(i).evaluate((a) => {
          a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          const r = a.getBoundingClientRect();
          const h = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
          return !!h && (h === a || a.contains(h));
        });
        expect(hit, `${at(c)}: section link ${i} is covered or off screen`).toBe(true);
      }
      await navLocator.getByRole('link', { name: 'Archived', exact: true }).click();
      await expect(page.locator('[data-section="archived"]')).toBeVisible();
      await navLocator.getByRole('link', { name: 'Models', exact: true }).click();
      await expect(page.locator('[data-section="models"]')).toBeVisible();
    }
  });
});
