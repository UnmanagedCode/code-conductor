// A text field on a touch screen is at least 16px, or iOS zooms the page into it on focus. Chromium never zooms,
// so the check is the computed font-size, at the project's viewport and at a landscape width past the md
// breakpoint (where a bare `md:text-sm` would win over `text-base`). The shell follows the visual viewport only
// under a soft keyboard, which Chromium has none of: without one the follower stays idle, and under a faked one
// (a scripted visualViewport plus a shrunken innerHeight) it follows. This module declares no tests.
import type { Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { createProject, spawnSession, LIVE_WORKER_MODEL } from './harness/api.ts';
import { next } from './flows/ui.ts';

// App.tsx's root element (TooltipProvider renders no DOM of its own); page-scroll.shared.ts measures the same box.
const SHELL = '#root > div:first-child';
const MIN_FONT_PX = 16;
const LANDSCAPE = { width: 932, height: 430 };

const fontPx = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

async function expectCoarse(page: Page): Promise<void> {
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  expect(coarse, 'the project emulates a coarse pointer').toBe(true);
}

export async function touchFieldsFlow({ page, cc }: { page: Page; cc: Cc }): Promise<void> {
  const project = `touch-fields-${test.info().project.name}`;
  await createProject(cc, project);
  const { sessionId } = await spawnSession(cc, project, { model: LIVE_WORKER_MODEL });
  const own = page.viewportSize()!;

  await page.goto(`/#session=${sessionId}`);
  await expectCoarse(page);
  await expect(page.locator('#composer-input')).toBeEnabled();

  for (const size of [own, LANDSCAPE]) {
    await page.setViewportSize(size);
    expect(await fontPx(page, '#composer-input'), `composer font at ${size.width}x${size.height}`).toBeGreaterThanOrEqual(MIN_FONT_PX);
  }

  // The drawer helper keys on the project's viewport, so the dialog opens at the device size and is resized while open.
  await page.setViewportSize(own);
  const dialog = await next.openPlacementDialog(page, 'adopt');
  const path = next.placementField(dialog, 'adopt', 'path');
  for (const size of [own, LANDSCAPE]) {
    await page.setViewportSize(size);
    expect(await path.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)), `directory field font at ${size.width}x${size.height}`).toBeGreaterThanOrEqual(MIN_FONT_PX);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.setViewportSize(own);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--app-height'))).toBe('');
}

/** The shell sizes itself from --app-height: App.tsx's root element, the one page-scroll measures. */
export async function shellFollowsAppHeightFlow({ page, cc }: { page: Page; cc: Cc }): Promise<void> {
  const project = `touch-shell-${test.info().project.name}`;
  await createProject(cc, project);
  const { sessionId } = await spawnSession(cc, project, { model: LIVE_WORKER_MODEL });
  await page.goto(`/#session=${sessionId}`);
  await expect(page.locator('#composer-input')).toBeEnabled();
  const shellHeight = () => page.locator(SHELL).evaluate((el) => el.getBoundingClientRect().height);
  const innerHeight = await page.evaluate(() => window.innerHeight);
  await page.evaluate(() => document.documentElement.style.setProperty('--app-height', '400px'));
  await expect.poll(shellHeight).toBeCloseTo(400, 0);
  await page.evaluate(() => document.documentElement.style.removeProperty('--app-height'));
  await expect.poll(shellHeight).toBeCloseTo(innerHeight, 0);
}

/** The viewport follower's variables (app/viewport.ts). */
const VIEWPORT_VARS = ['--app-height', '--app-top', '--app-left'];
const PX = 1;

type KbStep = { height: number | null; inner: number | null; top: number; fire: ('resize' | 'scroll')[] };
type Box = { top: number; bottom: number; height: number };
type KbReading = { vars: string[]; shell: Box; header: Box; composer: Box; scrollTos: number; overflow: number };

/**
 * Replaces window.visualViewport with a scripted one and makes innerHeight scriptable, before main.tsx starts the
 * follower. A null height or inner reads the real layout viewport. Every window.scrollTo call is counted.
 */
async function fakeSoftKeyboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state: { height: number | null; inner: number | null; top: number } = { height: null, inner: null, top: 0 };
    const realInner = Object.getOwnPropertyDescriptor(window, 'innerHeight')!.get!;
    // Getters on a class, read at each access: the document has no element yet when this runs.
    class FakeVisualViewport extends EventTarget {
      readonly scale = 1;
      readonly offsetLeft = 0;
      get width() { return document.documentElement.clientWidth; }
      get height() { return state.height ?? document.documentElement.clientHeight; }
      get offsetTop() { return state.top; }
      get pageTop() { return window.scrollY + state.top; }
      get pageLeft() { return window.scrollX; }
    }
    const vv = new FakeVisualViewport();
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => state.inner ?? realInner.call(window) });
    const w = window as unknown as { __scrollTos: number; __kb: unknown };
    w.__scrollTos = 0;
    const scrollTo = window.scrollTo.bind(window) as (...a: unknown[]) => void;
    window.scrollTo = ((...a: unknown[]) => { w.__scrollTos++; scrollTo(...a); }) as typeof window.scrollTo;
    w.__kb = {
      set(height: number | null, inner: number | null, top: number) { Object.assign(state, { height, inner, top }); },
      fire(type: string) { vv.dispatchEvent(new Event(type)); },
    };
  });
}

/** Applies one keyboard step, fires its events and measures, in one evaluate: the follower syncs in-call and a rect read forces layout. */
function kbStep(page: Page, step: KbStep): Promise<KbReading> {
  return page.evaluate(({ step, shell, vars }) => {
    const w = window as unknown as { __scrollTos: number; __kb: { set: (h: number | null, i: number | null, t: number) => void; fire: (t: string) => void } };
    w.__kb.set(step.height, step.inner, step.top);
    for (const type of step.fire) w.__kb.fire(type);
    const vv = window.visualViewport!;
    // Chromium never pans, so the on-screen box is the layout-viewport rect minus the scripted pan.
    const onScreen = (selector: string) => {
      const r = document.querySelector(selector)!.getBoundingClientRect();
      return { top: r.top - vv.offsetTop, bottom: r.bottom - vv.offsetTop, height: r.height };
    };
    const root = document.documentElement;
    return {
      vars: vars.map((v) => root.style.getPropertyValue(v)),
      shell: onScreen(shell), header: onScreen('[data-session-header]'), composer: onScreen('#composer-input'),
      scrollTos: w.__scrollTos, overflow: root.scrollHeight - root.clientHeight,
    };
  }, { step, shell: SHELL, vars: VIEWPORT_VARS });
}

/** Under a soft keyboard that shrinks innerHeight and pans the visual viewport, the shell's on-screen box is the visible area. */
export async function softKeyboardShellFlow({ page, cc }: { page: Page; cc: Cc }): Promise<void> {
  const project = `touch-keyboard-${test.info().project.name}`;
  await createProject(cc, project);
  const { sessionId } = await spawnSession(cc, project, { model: LIVE_WORKER_MODEL });
  await fakeSoftKeyboard(page);
  await page.goto(`/#session=${sessionId}`);
  await expect(page.locator('#composer-input')).toBeEnabled();
  await expect(page.locator('[data-session-header]')).toBeVisible();

  const H = await page.evaluate(() => document.documentElement.clientHeight);
  const V = Math.round(H * 0.55);
  const P = H - V - 20;

  const k1 = await kbStep(page, { height: null, inner: null, top: 0, fire: ['resize'] });
  expect.soft(k1.vars, 'K1 keyboard closed: no variable is set').toEqual(['', '', '']);
  expect.soft(k1.shell.top, 'K1 keyboard closed: shell top').toBeCloseTo(0, 0);
  expect.soft(k1.shell.height, 'K1 keyboard closed: shell height').toBeCloseTo(H, 0);

  const k2 = await kbStep(page, { height: V, inner: V, top: 0, fire: ['resize'] });
  expect.soft(k2.shell.top, 'K2 keyboard opens: shell on-screen top').toBeCloseTo(0, 0);
  expect.soft(k2.shell.height, 'K2 keyboard opens: shell height is the visible height, though innerHeight shrank').toBeCloseTo(V, 0);

  for (const [label, top] of [['K3 pan', P], ['K4 re-pan (a keystroke)', Math.round(P / 2)]] as const) {
    const k = await kbStep(page, { height: V, inner: V, top, fire: ['scroll'] });
    expect.soft(k.scrollTos - k2.scrollTos, `${label}: nothing calls scrollTo while covered`).toBe(0);
    expect.soft(k.shell.top, `${label}: shell on-screen top`).toBeCloseTo(0, 0);
    expect.soft(k.shell.height, `${label}: shell height`).toBeCloseTo(V, 0);
    expect.soft(k.header.top, `${label}: the session header is on screen`).toBeGreaterThanOrEqual(-PX);
    expect.soft(k.composer.bottom, `${label}: the composer is above the keyboard`).toBeLessThanOrEqual(V + PX);
    expect.soft(k.overflow, `${label}: the document does not overflow`).toBeLessThanOrEqual(0);
  }

  const k5 = await kbStep(page, { height: H, inner: H, top: 0, fire: ['resize', 'scroll'] });
  expect.soft(k5.vars, 'K5 keyboard closes: every variable is removed').toEqual(['', '', '']);
  expect.soft(k5.shell.top, 'K5 keyboard closes: shell top').toBeCloseTo(0, 0);
  expect.soft(k5.shell.height, 'K5 keyboard closes: shell height').toBeCloseTo(H, 0);
}
