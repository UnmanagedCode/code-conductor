// The landing mark's assembly in a real browser, with getAnimations() as the observable (happy-dom runs no
// CSS animation): it plays once per page load on the landing, each knockout's mask moves with its part, it hands
// over on the real animationend, reduced motion never assembles, and the settled mark is pixel-identical to the
// one a reduced-motion load draws.
import type { Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { spawnSession } from './harness/api.ts';
import { next } from './flows/ui.ts';

test.use({ ccOptions: { server: 'landing-mark' } });

type PartAnimations = { part: string; mask: boolean; names: string[] };
type Record_ = { appeared: number; gone: number; live: boolean; parts: PartAnimations[] };

/** Records every time [data-logo-assemble] appears and disappears, and each part element's animation names when it appears; a MutationObserver, so page-load speed cannot race it. */
async function recordAssembly(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = { appeared: 0, gone: 0, live: false, parts: [] as PartAnimations[] };
    (window as any).__assembly = state;
    const check = () => {
      const svg = document.querySelector('[data-logo-assemble]');
      if (svg && !state.live) {
        state.live = true;
        state.appeared++;
        state.parts = [...svg.querySelectorAll('[data-logo-part]')].map((el) => ({
          part: el.getAttribute('data-logo-part')!,
          mask: el.closest('mask') !== null,
          names: el.getAnimations().map((a) => (a as CSSAnimation).animationName),
        }));
      } else if (!svg && state.live) {
        state.live = false;
        state.gone++;
      }
    };
    new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-logo-assemble'] });
  });
}
const assembly = (page: Page) => page.evaluate(() => (window as any).__assembly as Record_);
const mark = (page: Page) => page.locator('[data-empty-state] svg[data-logo="mark"]');
const markAnimations = (page: Page) => page.evaluate(() => {
  const svg = document.querySelector('[data-empty-state] svg[data-logo="mark"]')!;
  return svg.getAnimations({ subtree: true }).map((a) => ({ name: (a as CSSAnimation).animationName, infinite: a.effect!.getComputedTiming().iterations === Infinity }));
});

/** Waits for the first landing's assembly to start and hand over. */
async function awaitHandOver(page: Page): Promise<void> {
  await expect.poll(async () => (await assembly(page)).appeared, { message: 'fixture check: the assembly started' }).toBe(1);
  await expect.poll(async () => (await assembly(page)).gone, { message: 'the real animationend handed over', timeout: 15_000 }).toBe(1);
}

test('the first landing assembles once, every part and mask animating, and hands over to the blink', async ({ page }) => {
  // Invariant: the assembly appears once; every part element, mask shapes included, animates, and a mask shape runs the same animations as its part's painted shape (the cuts follow their parts); it ends through the real animationend, leaving only the cursor's infinite blink.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await recordAssembly(page);
  await page.goto('/');
  await awaitHandOver(page);
  const rec = await assembly(page);
  expect(rec.appeared).toBe(1);
  expect(rec.parts.some((p) => p.mask), 'fixture check: masks were recorded').toBe(true);
  for (const p of rec.parts) expect(p.names.length, `${p.part}${p.mask ? ' (mask)' : ''} animates`).toBeGreaterThan(0);
  for (const m of rec.parts.filter((p) => p.mask)) {
    const painted = rec.parts.find((p) => !p.mask && p.part === m.part)!;
    expect(m.names, `the ${m.part} cut runs its part's animations`).toEqual(painted.names);
  }
  await expect(mark(page)).toBeVisible();
  await expect.poll(() => markAnimations(page), { message: 'only the cursor blink is left running' }).toEqual([{ name: 'cursor-blink', infinite: true }]);
});

test('a later landing in the same page load does not replay the assembly', async ({ page, cc }) => {
  // Invariant: after the first landing played, leaving it for a session and coming back shows the mark settled; the assembly count stays 1.
  const project = `landing-${test.info().project.name}`;
  const { sessionId } = await spawnSession(cc, project, { persistent: true });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await recordAssembly(page);
  await page.goto('/');
  await awaitHandOver(page);
  await (await next.sessionRow(page, project, sessionId)).click();
  await expect(next.sessionHeader(page), 'fixture check: the session opened').toBeVisible();
  await expect(page.locator('[data-empty-state]')).toHaveCount(0);
  // Selecting a session pushes no history entry (Back would leave the app), so the session's close action returns to the landing.
  await next.sessionClose(await next.sessionRow(page, project, sessionId)).click();
  await expect(page.locator('[data-empty-state]')).toBeVisible();
  expect((await assembly(page)).appeared).toBe(1);
});

test('under reduced motion the assembly never appears and the mark has no animations', async ({ page }) => {
  // Invariant: with prefers-reduced-motion: reduce the landing renders the settled mark at once: no assembly attribute was ever recorded and the mark runs no animation (the blink is switched off too).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await recordAssembly(page);
  await page.goto('/');
  await expect(mark(page)).toBeVisible();
  expect((await assembly(page)).appeared).toBe(0);
  expect(await markAnimations(page)).toEqual([]);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the settled mark is pixel-identical to the reduced-motion mark in ${scheme} mode`, async ({ page, cc }) => {
    // Invariant: after the hand-over (its blink cancelled, the cursor shown) the mark is byte-for-byte the screenshot a reduced-motion load takes, in either theme.
    // Both pages must run no animation when shot: a running or paused animation makes Chromium rasterise the whole mark
    // differently (a one-pixel-edge difference, no visible one), so cancelling the blink is the normalisation, not a pause.
    const shot = async (p: Page) => mark(p).screenshot();
    const open = async (p: Page, cc_: Cc, reducedMotion: 'reduce' | 'no-preference') => {
      await p.emulateMedia({ colorScheme: scheme, reducedMotion });
      await p.goto(cc_.url + '/');
      expect(await p.evaluate(() => document.documentElement.classList.contains('dark')), 'control: the theme follows the scheme').toBe(scheme === 'dark');
      await expect(mark(p)).toBeVisible();
    };
    await recordAssembly(page);
    await open(page, cc, 'no-preference');
    await awaitHandOver(page);
    await page.evaluate(() => document.getAnimations().forEach((a) => a.cancel()));
    const settled = await shot(page);

    const other = await page.context().newPage();
    await open(other, cc, 'reduce');
    await other.evaluate(() => document.getAnimations().forEach((a) => a.cancel()));
    const reduced = await shot(other);
    expect(Buffer.compare(settled, reduced)).toBe(0);
  });
}

test('the legs grow downward from their tops', async ({ page }) => {
  // Invariant: frozen mid-grow, each leg's top edge is where its settled top is (within 0.5px) and its height is smaller than settled: the grow pivots on the leg's top, not its middle.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await recordAssembly(page);
  // Every painted shape's box in document order, with its part while assembling (the hand-over drops the attribute, the order stays).
  const boxes = () => page.evaluate(() => [...document.querySelectorAll('[data-empty-state] svg[data-logo="mark"] path')]
    .filter((el) => !el.closest('mask')).map((el) => { const r = el.getBoundingClientRect(); return { part: el.getAttribute('data-logo-part'), top: r.top, height: r.height }; }));
  await page.goto('/');
  await awaitHandOver(page);
  const settled = await boxes();

  await page.reload();
  await page.waitForSelector('[data-logo-assemble]');
  // Each leg's grow, paused a third of the way through its own duration.
  await page.evaluate(() => document.getAnimations().forEach((a) => {
    a.pause();
    const t = a.effect!.getTiming();
    a.currentTime = (a as CSSAnimation).animationName === 'logo-grow' ? Number(t.delay) + Number(t.duration) / 3 : Number(t.delay) + Number(t.duration);
  }));
  const mid = await boxes();
  expect(mid.length, 'the same shapes before and after the hand-over').toBe(settled.length);
  const legs = mid.flatMap((m, i) => (m.part?.startsWith('leg') ? [{ ...m, i }] : []));
  expect(legs.length, 'fixture check: seven legs').toBe(7);
  for (const leg of legs) {
    expect(Math.abs(leg.top - settled[leg.i].top), `${leg.part} keeps its top`).toBeLessThanOrEqual(0.5);
    expect(leg.height, `${leg.part} is still growing`).toBeLessThan(settled[leg.i].height);
  }
});
