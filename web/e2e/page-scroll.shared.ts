// The web UI never scrolls the page: on every Settings section and every
// full-page view the app shell fills the viewport exactly and only a view's own
// pane scrolls. An absolutely positioned box with no positioned ancestor (the
// hidden <input> Radix renders beside a Checkbox, Switch, RadioGroup, Select or
// Slider inside a <form>) escapes every clip that is not its containing block,
// so each view's pane, or a wrapper around it, must be one. The bodies are
// shared by the per-project spec files; this module declares no tests.
import type { Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { api, createProject, installFakePlugin, spawnSession, LIVE_WORKER_MODEL } from './harness/api.ts';
import { next } from './flows/ui.ts';
import { commitsView, openHistory } from './commits-actions.shared.ts';
import { SECTION_CATALOG, offeredSections, type SectionCaps } from '../src/features/settings/sections.ts';

type Args = { page: Page; cc: Cc };
const EPS = 0.5;
const PLUGIN_ID = 'fake-plugin';

// The app shell: App.tsx's root element (TooltipProvider renders no DOM of its own).
const SHELL = '#root > div:first-child';
const SETTINGS_PANE = '[data-settings-view] > .overflow-y-auto';
const viewShellPane = (view: string) => `main[data-view="${view}"] > .overflow-y-auto`;

/** Where a probe goes: the pane that scrolls the view's content, and the element whose end it is appended to. */
type Pane = { pane: string; target: string };
type View = { label: string; open: (page: Page) => Promise<void>; pane: Pane | null };

/** Desktop measures the project's viewport and the width the defect was reported at; the phone projects their device's. */
function viewports(page: Page): { width: number; height: number }[] {
  const own = page.viewportSize()!;
  return test.info().project.name === 'desktop' ? [own, { width: 2000, height: 1100 }] : [own];
}

/** Counts requests in flight, so a view is measured once its data has landed. */
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
  await expect(page.getByRole('dialog'), 'no drawer or dialog open').toHaveCount(0);
}

/** A project with a commit (Commits, Review), the fixture plugin, and a live session on Haiku. */
async function seed(cc: Cc, tag: string): Promise<{ project: string; sessionId: string }> {
  const project = `${tag}-${test.info().project.name}`;
  await createProject(cc, project);
  await installFakePlugin(cc, 'page-scroll-plugin');
  const { sessionId } = await spawnSession(cc, project, { model: LIVE_WORKER_MODEL });
  return { project, sessionId };
}

/** The sections the nav must offer on this cc: the catalog SettingsView renders, offered by this platform's capabilities. */
async function expectedSections(cc: Cc): Promise<string[]> {
  const caps = (await api<{ capabilities: SectionCaps }>(cc, 'GET', '/api/health')).body.capabilities;
  return offeredSections(SECTION_CATALOG, caps).map((s) => s.id);
}

/** Every Settings section the nav offers, read from the nav once capabilities have pruned it, and checked against the catalog. */
async function settingsSections(page: Page, cc: Cc): Promise<string[]> {
  const expected = await expectedSections(cc);
  await page.goto('/next/#settings');
  const links = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link');
  // The nav lists every section until capabilities land: wait for the pruned list before reading it.
  await expect(links, 'the nav once capabilities have pruned it').toHaveCount(expected.length);
  const ids = await links.evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href')!.replace('#settings/', '')));
  expect(ids, 'the nav offers the catalog sections this platform supports').toEqual(expected);
  return ids;
}

// Archived renders a control only with an archived session, which a scratch cc has none of: one is served page-locally.
const ARCHIVED = { groups: [{ project: 'page-scroll-archived', sessions: [{ sessionId: 'aaaaaaaa-1111', title: 'An archived session', lastActivity: 1 }] }] };

/** Fails unless Settings section `id` shows a control (a hidden form input does not count). */
async function expectControl(page: Page, id: string): Promise<void> {
  const controls = page.locator(`[data-section="${id}"]`).locator(':is(button, input, select, textarea, a[href]):not([aria-hidden="true"])');
  await expect(controls.filter({ visible: true }).first(), `settings/${id} shows a control`).toBeVisible();
}

const sessionPane = (page: Page) => page.locator('main:not([data-view]):not([data-settings-view])');

async function views(page: Page, cc: Cc, s: { project: string; sessionId: string }): Promise<View[]> {
  await page.route('**/api/archived', (r) => r.fulfill({ json: ARCHIVED }));
  const sections = await settingsSections(page, cc);
  // Positive control: the reported section is in this cc's nav.
  expect(sections, 'the nav lists Models').toContain('models');
  const settings: View[] = sections.map((id) => ({
    label: `settings/${id}`,
    open: async (p) => {
      await p.goto(`/next/#settings/${id}`);
      await expect(p.locator(`[data-section="${id}"]`)).toBeVisible();
      await expectControl(p, id);
    },
    pane: { pane: SETTINGS_PANE, target: `[data-section="${id}"]` },
  }));
  const shellView = (view: string): Pane => ({ pane: viewShellPane(view), target: `${viewShellPane(view)} > div` });
  return [
    ...settings,
    { label: 'session (landing)', open: async (p) => { await next.open(p); await expect(sessionPane(p)).toBeVisible(); }, pane: null },
    { label: 'session (live)', open: async (p) => { await p.goto(`/next/#session=${s.sessionId}`); await expect(sessionPane(p)).toBeVisible(); }, pane: null },
    { label: 'costs', open: async (p) => { await p.goto('/next/#costs'); await expect(p.locator('main[data-view="costs"]')).toBeVisible(); }, pane: shellView('costs') },
    { label: 'commits', open: async (p) => { await next.open(p); await openHistory(p, s.project, null); }, pane: shellView('commits') },
    {
      label: 'review',
      open: async (p) => {
        await next.open(p);
        await openHistory(p, s.project, null);
        await commitsView(p).locator('[data-commit-row]:not([data-commit-row="uncommitted"])').first().click();
        await expect(p.locator('main[data-view="review"]')).toBeVisible();
      },
      pane: shellView('review'),
    },
    {
      label: 'plugin',
      open: async (p) => { await p.goto(`/next/#plugin/${PLUGIN_ID}/`); await expect(p.locator('section[data-view="plugin"][aria-hidden="false"]')).toBeVisible(); },
      pane: null,
    },
  ];
}

type PageBox = { docOverY: number; docOverX: number; docTop: number; shellTop: number; shellHeight: number; innerHeight: number; shellOver: number };

/** Runs in the page: how far the document and the shell overflow, and where the shell sits. */
function pageBox(shellSel: string): PageBox {
  const se = document.scrollingElement!;
  const shell = document.querySelector(shellSel)!;
  const r = shell.getBoundingClientRect();
  return {
    docOverY: se.scrollHeight - se.clientHeight,
    docOverX: se.scrollWidth - se.clientWidth,
    docTop: se.scrollTop,
    shellTop: r.top,
    shellHeight: r.height,
    innerHeight,
    shellOver: shell.scrollHeight - shell.clientHeight,
  };
}

function pageViolations(b: PageBox): string[] {
  const v: string[] = [];
  if (b.docOverY > 0) v.push(`the page scrolls down by ${b.docOverY}px`);
  if (b.docOverX > 0) v.push(`the page scrolls sideways by ${b.docOverX}px`);
  if (b.docTop !== 0) v.push(`the page is scrolled to ${b.docTop}px`);
  if (Math.abs(b.shellTop) > EPS || Math.abs(b.shellHeight - b.innerHeight) > EPS) v.push(`the shell is [${b.shellTop}, +${b.shellHeight}] in a ${b.innerHeight}px viewport`);
  if (b.shellOver > 0) v.push(`the shell overflows by ${b.shellOver}px`);
  return v;
}

export async function pageNeverScrollsFlow({ page, cc }: Args): Promise<void> {
  const inFlight = trackRequests(page);
  const s = await seed(cc, 'never-scrolls');
  const all = await views(page, cc, s);
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const vp of viewports(page)) {
    await page.setViewportSize(vp);
    for (const v of all) {
      await v.open(page);
      await settle(page, inFlight);
      // Positive control: the shell selector names the app's frame.
      await expect(page.locator(SHELL).locator('main, section[data-view="plugin"][aria-hidden="false"]').first(), `${v.label}: the shell holds the view`).toBeVisible();
      for (const m of pageViolations(await page.evaluate(pageBox, SHELL))) violations.push(`${v.label} @ ${vp.width}x${vp.height}: ${m}`);
      seen.add(v.label);
    }
  }
  expect([...seen].sort(), 'every view was measured').toEqual(all.map((v) => v.label).sort());
  expect(violations, `${violations.length} violation(s)`).toEqual([]);
}

type ProbeReport = { containedBy: string; inPane: boolean; withinScroll: boolean; shownAtEnd: boolean; page: PageBox };

/**
 * Runs in the page: appends Radix's hidden-input shape at the end of `target`
 * (after a spacer taller than the viewport when `spacer`), reads where it lands
 * and removes it before returning, so React never renders over it.
 */
function probe(a: { pane: string; target: string; spacer: boolean; shell: string; eps: number }): ProbeReport {
  const pane = document.querySelector(a.pane) as HTMLElement;
  const target = document.querySelector(a.target)!;
  const wrap = document.createElement('div');
  if (a.spacer) {
    const s = document.createElement('div');
    s.style.height = `${3 * innerHeight}px`;
    wrap.append(s);
  }
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  Object.assign(input.style, { position: 'absolute', pointerEvents: 'none', opacity: '0', margin: '0' });
  wrap.append(input);
  target.append(wrap);
  try {
    const cb = input.offsetParent;
    const containedBy = cb ? `${cb.tagName.toLowerCase()}${cb === pane ? ' (the pane)' : ''}` : 'none';
    const se = document.scrollingElement!;
    const shell = document.querySelector(a.shell)!;
    const sr = shell.getBoundingClientRect();
    const page = {
      docOverY: se.scrollHeight - se.clientHeight, docOverX: se.scrollWidth - se.clientWidth, docTop: se.scrollTop,
      shellTop: sr.top, shellHeight: sr.height, innerHeight, shellOver: shell.scrollHeight - shell.clientHeight,
    };
    const p = pane.getBoundingClientRect();
    const i = input.getBoundingClientRect();
    const withinScroll = i.bottom - p.top + pane.scrollTop <= pane.scrollHeight + a.eps;
    const top = pane.scrollTop;
    pane.scrollTop = pane.scrollHeight;
    const p2 = pane.getBoundingClientRect();
    const i2 = input.getBoundingClientRect();
    const shownAtEnd = i2.top >= p2.top - a.eps && i2.bottom <= p2.bottom + a.eps;
    pane.scrollTop = top;
    return { containedBy, inPane: !!cb && pane.contains(cb), withinScroll, shownAtEnd, page };
  } finally {
    wrap.remove();
  }
}

export async function paneHoldsHiddenInputFlow({ page, cc }: Args): Promise<void> {
  const inFlight = trackRequests(page);
  const s = await seed(cc, 'pane-probe');
  const scrolling = (await views(page, cc, s)).filter((v) => v.pane !== null);
  // Positive control: Settings and the ViewShell views are all probed.
  expect(scrolling.map((v) => v.label), 'probed views').toEqual(expect.arrayContaining(['settings/models', 'costs', 'commits', 'review']));
  const violations: string[] = [];
  for (const vp of viewports(page)) {
    await page.setViewportSize(vp);
    for (const v of scrolling) {
      await v.open(page);
      await settle(page, inFlight);
      const r = await page.evaluate(probe, { ...v.pane!, spacer: true, shell: SHELL, eps: EPS });
      const at = `${v.label} @ ${vp.width}x${vp.height}`;
      if (!r.inPane) violations.push(`${at}: the probe's containing block is ${r.containedBy}, outside the pane`);
      if (!r.withinScroll) violations.push(`${at}: the probe lies past the pane's scroll height`);
      if (!r.shownAtEnd) violations.push(`${at}: the probe is not in view with the pane scrolled to its end`);
      for (const m of pageViolations(r.page)) violations.push(`${at}: ${m}`);
    }
  }
  expect(violations, `${violations.length} violation(s)`).toEqual([]);
}

export async function pluginHoldsHiddenInputFlow({ page, cc }: Args): Promise<void> {
  const inFlight = trackRequests(page);
  await installFakePlugin(cc, 'page-scroll-plugin');
  const section = 'section[data-view="plugin"]';
  const violations: string[] = [];
  for (const vp of viewports(page)) {
    await page.setViewportSize(vp);
    await page.goto(`/next/#plugin/${PLUGIN_ID}/`);
    await expect(page.locator(`${section}[aria-hidden="false"]`)).toBeVisible();
    await settle(page, inFlight);
    // The plugin view scrolls inside its frame, so the section holds the probe with no spacer.
    const r = await page.evaluate(probe, { pane: section, target: section, spacer: false, shell: SHELL, eps: EPS });
    const at = `plugin @ ${vp.width}x${vp.height}`;
    if (!r.inPane) violations.push(`${at}: the probe's containing block is ${r.containedBy}, outside the plugin view`);
    for (const m of pageViolations(r.page)) violations.push(`${at}: ${m}`);
  }
  expect(violations, `${violations.length} violation(s)`).toEqual([]);
}

/**
 * Runs in the page: appends a small absolutely positioned box straight to the
 * shell, outside every pane, at `top: 200vh`, reads how far the document then
 * scrolls, and removes it before returning.
 */
function shellProbe(shellSel: string): { below: boolean; docOverY: number; docOverX: number } {
  const shell = document.querySelector(shellSel)!;
  const box = document.createElement('div');
  box.setAttribute('aria-hidden', 'true');
  Object.assign(box.style, { position: 'absolute', top: '200vh', left: '0', width: '10px', height: '10px', pointerEvents: 'none' });
  shell.append(box);
  try {
    const se = document.scrollingElement!;
    return { below: box.getBoundingClientRect().top >= innerHeight, docOverY: se.scrollHeight - se.clientHeight, docOverX: se.scrollWidth - se.clientWidth };
  } finally {
    box.remove();
  }
}

export async function shellClipsStrayBoxFlow({ page }: Args): Promise<void> {
  const inFlight = trackRequests(page);
  for (const vp of viewports(page)) {
    await page.setViewportSize(vp);
    await page.goto('/next/#settings/models');
    await expect(page.locator('[data-section="models"]')).toBeVisible();
    await settle(page, inFlight);
    const r = await page.evaluate(shellProbe, SHELL);
    const at = `${vp.width}x${vp.height}`;
    // Positive control: the box lies below the viewport, where an unclipped box would lengthen the page.
    expect(r.below, `${at}: the probe sits below the viewport`).toBe(true);
    expect(r.docOverY, `${at}: the page scrolls down`).toBeLessThanOrEqual(0);
    expect(r.docOverX, `${at}: the page scrolls sideways`).toBeLessThanOrEqual(0);
  }
}

type Fixed = { shell: number[]; sidebar: number[] | null; nav: number[]; header: number[] | null; docTop: number; pane: { top: number; max: number } };

/** Runs in the page: the boxes that must not move, the document's scroll and the Settings pane's. */
function fixedBoxes(a: { shell: string; pane: string }): Fixed {
  const box = (e: Element | null) => {
    if (!e || getComputedStyle(e).display === 'none') return null;
    const r = e.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10) / 10);
  };
  const pane = document.querySelector(a.pane)!;
  const sidebar = document.querySelector('aside[data-sidebar]');
  return {
    shell: box(document.querySelector(a.shell))!,
    sidebar: sidebar && sidebar.getBoundingClientRect().width > 0 ? box(sidebar) : null,
    nav: box(document.querySelector('nav[aria-label="Settings sections"]'))!,
    header: box(document.querySelector('[data-settings-view] > header')),
    docTop: document.scrollingElement!.scrollTop,
    pane: { top: pane.scrollTop, max: pane.scrollHeight - pane.clientHeight },
  };
}

export async function onlyPaneScrollsFlow({ page }: Args): Promise<void> {
  const inFlight = trackRequests(page);
  const desktop = test.info().project.name === 'desktop';
  await page.goto('/next/#settings/models');
  await expect(page.locator('[data-section="models"] select').first()).toBeVisible();
  await settle(page, inFlight);
  const read = () => page.evaluate(fixedBoxes, { shell: SHELL, pane: SETTINGS_PANE });
  const before = await read();
  // Positive controls: there is content to scroll, and the boxes that must stay are on screen.
  expect(before.pane.max, 'the Settings pane has content past its foot').toBeGreaterThan(0);
  if (desktop) expect(before.sidebar, 'the desktop sidebar').not.toBeNull();
  else expect(before.header, 'the phone Settings top bar').not.toBeNull();

  const content = await page.locator(SETTINGS_PANE).boundingBox();
  await page.mouse.move(content!.x + content!.width / 2, content!.y + content!.height / 2);
  // Wheel to the pane's end, then past it: the extra turns are what a page that could scroll takes.
  await expect(async () => {
    await page.mouse.wheel(0, 800);
    const now = await read();
    expect(now.pane.top).toBeGreaterThanOrEqual(now.pane.max - 1);
  }).toPass({ timeout: 20_000 });
  const frames = () => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 800);
    await frames();
  }
  // A smooth wheel scroll lands over frames: read once two reads agree.
  let after = await read();
  await expect(async () => {
    await frames();
    const again = await read();
    const same = JSON.stringify(again) === JSON.stringify(after);
    after = again;
    expect(same, 'scroll positions settled').toBe(true);
  }).toPass({ timeout: 10_000 });
  expect(after.pane.top, 'the Settings pane scrolled').toBeGreaterThan(0);
  expect(after.docTop, 'the page did not scroll').toBe(0);
  expect(after.shell, 'the shell stayed in place').toEqual(before.shell);
  if (desktop) {
    expect(after.sidebar, 'the sidebar stayed in place').toEqual(before.sidebar);
    expect(after.nav, 'the Settings nav stayed in place').toEqual(before.nav);
  } else {
    expect(after.header, 'the Settings top bar stayed in place').toEqual(before.header);
  }
}
