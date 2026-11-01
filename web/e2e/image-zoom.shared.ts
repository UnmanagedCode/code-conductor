// The image viewer overlay: a tap on a conversation image opens it, a tap on the big image zooms to
// 1:1. These flows measure where the zoomed image sits, where its scrollbar sits and where the view
// starts, on an image that fits, one that overflows only vertically, one that overflows both ways
// and a wide one whose viewer's top moves on zoom. The body is shared by the per-project spec files; this module declares no tests.
import type { Locator, Page } from '@playwright/test';
import { test, expect, type Cc } from './harness/fixtures.ts';
import { spawnSession } from './harness/api.ts';
import { next } from './flows/ui.ts';

type Args = { page: Page; cc: Cc };
const EPS = 1;
/** How far the wrapper's right edge may sit beyond the image's: a classic scrollbar's width. */
const SCROLLBAR_ALLOWANCE = 20;

type Size = { name: string; width: number; height: number };
const SMALL: Size = { name: 'small.png', width: 200, height: 140 };
const TALL: Size = { name: 'tall.png', width: 300, height: 2400 };
const LARGE: Size = { name: 'large.png', width: 3000, height: 2000 };
/** Its fit box is shorter than its 1:1 viewer, which the 90dvh cap makes taller, so the viewer's top moves on zoom. */
const WIDE: Size = { name: 'wide.png', width: 3000, height: 1000 };

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type Zoomed = {
  img: Rect; wrapper: Rect; dialog: Rect;
  scroll: { left: number; top: number; scrollWidth: number; scrollHeight: number; clientWidth: number; clientHeight: number };
  page: { overX: number; overY: number }; dialogOver: { x: number; y: number };
};

const dialogOf = (page: Page) => page.locator('[data-slot="dialog-content"]');
const bigImage = (page: Page) => page.locator('[data-image-overlay] img');
const wrapperOf = (page: Page) => page.locator('[data-image-overlay]');

/** Waits until a locator's box stops moving: the dialog's open animation and the zoom's reflow are done. */
async function settled(loc: Locator): Promise<void> {
  let prev = '';
  await expect.poll(async () => {
    const now = JSON.stringify(await loc.boundingBox());
    const same = now === prev;
    prev = now;
    return same;
  }, { message: 'the box settles' }).toBe(true);
}

const rectOf = (loc: Locator): Promise<Rect> => loc.evaluate((e) => {
  const r = e.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
});

async function pngBuffer(page: Page, size: Size): Promise<Buffer> {
  const b64 = await page.evaluate(({ width, height }) => {
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, '#2b6cb0'); grad.addColorStop(1, '#c05621');
    g.fillStyle = grad; g.fillRect(0, 0, width, height);
    g.fillStyle = '#fff'; g.font = `${Math.max(16, Math.min(width, height) / 10)}px sans-serif`;
    g.fillText(`${width}x${height}`, 10, Math.max(30, Math.min(width, height) / 8));
    return c.toDataURL('image/png').split(',')[1];
  }, size);
  return Buffer.from(b64, 'base64');
}

async function sendImages(page: Page, cc: Cc, sizes: Size[]): Promise<void> {
  const { sessionId } = await spawnSession(cc, `e2e-image-zoom-${test.info().project.name}`);
  await page.goto(`/#session=${sessionId}`);
  await expect(page.locator('#composer-input')).toBeEnabled();
  const files = [];
  for (const s of sizes) files.push({ name: s.name, mimeType: 'image/png', buffer: await pngBuffer(page, s) });
  await page.locator('[data-composer] input[type="file"]').setInputFiles(files);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  for (const s of sizes) {
    await expect(next.lastUserMessage(page).getByRole('button', { name: `Enlarge ${s.name}`, exact: true })).toBeVisible();
  }
}

async function openOverlay(page: Page, s: Size): Promise<void> {
  await next.lastUserMessage(page).getByRole('button', { name: `Enlarge ${s.name}`, exact: true }).click();
  await expect(bigImage(page)).toBeVisible();
  await settled(dialogOf(page));
  await expect.poll(() => bigImage(page).evaluate((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth), { message: 'the big image decodes' }).toBeGreaterThan(0);
  await settled(bigImage(page));
}

async function closeOverlay(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(wrapperOf(page)).toHaveCount(0);
}

/** A whole-pixel point on the painted fit image near fractions (fx, fy) of the image itself, letterboxing accounted for. Whole pixels, because a touch-emulated click reports its position truncated and the 1:1 view magnifies the loss. */
async function paintedPoint(page: Page, s: Size, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const box = await rectOf(bigImage(page));
  const scale = Math.min(box.width / s.width, box.height / s.height);
  const pw = s.width * scale, ph = s.height * scale;
  return { x: Math.round(box.left + (box.width - pw) / 2 + fx * pw), y: Math.round(box.top + (box.height - ph) / 2 + fy * ph) };
}

async function measureZoomed(page: Page): Promise<Zoomed> {
  const w = wrapperOf(page);
  return {
    img: await rectOf(bigImage(page)), wrapper: await rectOf(w), dialog: await rectOf(dialogOf(page)),
    scroll: await w.evaluate((e) => ({ left: e.scrollLeft, top: e.scrollTop, scrollWidth: e.scrollWidth, scrollHeight: e.scrollHeight, clientWidth: e.clientWidth, clientHeight: e.clientHeight })),
    page: await page.evaluate(() => { const s = document.scrollingElement!; return { overX: s.scrollWidth - s.clientWidth, overY: s.scrollHeight - s.clientHeight }; }),
    dialogOver: await dialogOf(page).evaluate((e) => ({ x: e.scrollWidth - e.clientWidth, y: e.scrollHeight - e.clientHeight })),
  };
}

const centerX = (r: Rect) => (r.left + r.right) / 2;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The scroll the tap point calls for, from what the page measured (written here, not imported). */
function expectedScroll(s: Size, f: { fx: number; fy: number }, tap: { x: number; y: number }, z: Zoomed) {
  const px = clamp(tap.x - z.wrapper.left, 0, z.scroll.clientWidth);
  const py = clamp(tap.y - z.wrapper.top, 0, z.scroll.clientHeight);
  return {
    left: clamp(f.fx * s.width - px, 0, Math.max(0, z.scroll.scrollWidth - z.scroll.clientWidth)),
    top: clamp(f.fy * s.height - py, 0, Math.max(0, z.scroll.scrollHeight - z.scroll.clientHeight)),
  };
}

function noPageOrDialogScroll(z: Zoomed, what: string) {
  expect(z.page, `${what}: the page does not scroll`).toEqual({ overX: 0, overY: 0 });
  expect(z.dialogOver, `${what}: the dialog does not scroll`).toEqual({ x: 0, y: 0 });
}

async function attachShot(page: Page, name: string) {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

/** Opens `s`, taps the fit image at (fx, fy) of the painted image, and returns what the zoomed view measures. */
async function zoomAt(page: Page, s: Size, fx: number, fy: number) {
  await openOverlay(page, s);
  const fitDialog = await rectOf(dialogOf(page));
  const fitImg = await rectOf(bigImage(page));
  expect(Math.abs(fitImg.width - fitDialog.width), `${s.name}: the fit image is as wide as the dialog content`).toBeLessThanOrEqual(EPS);
  const closeOffset = async () => {
    const c = await rectOf(dialogOf(page).getByRole('button', { name: 'Close' }));
    const d = await rectOf(dialogOf(page));
    return { right: c.right - d.right, top: c.top - d.top, width: c.width, height: c.height };
  };
  const closeBefore = await closeOffset();
  const wrapperBefore = await rectOf(wrapperOf(page));
  const tap = await paintedPoint(page, s, fx, fy);
  // One CSS pixel of tap precision on the fit image is this many pixels of 1:1 scroll.
  const tolerance = Math.ceil(1 / Math.min(fitImg.width / s.width, fitImg.height / s.height)) + 1;
  await page.mouse.click(tap.x, tap.y);
  await expect(bigImage(page)).toHaveAttribute('title', 'Fit to screen');
  await settled(wrapperOf(page));
  await settled(bigImage(page));
  const z = await measureZoomed(page);
  noPageOrDialogScroll(z, s.name);
  // The dialog box shrinks around a small image, so the button is compared at its offset from the dialog's top-right corner.
  expect(await closeOffset(), `${s.name}: the Close button keeps its place in the dialog's corner on zoom`).toEqual(closeBefore);
  return { z, tap, fitDialog, tolerance, wrapperBefore };
}

export async function smallFitsCenteredFlow({ page, cc }: Args): Promise<void> {
  await sendImages(page, cc, [SMALL, TALL, LARGE]);
  const { z, fitDialog } = await zoomAt(page, SMALL, 0.5, 0.5);
  expect(fitDialog.width - z.img.width, 'positive control: the 1:1 image is much narrower than the dialog content').toBeGreaterThan(100);
  expect(Math.abs(centerX(z.img) - centerX(z.dialog)), 'the zoomed image is centred in the dialog').toBeLessThanOrEqual(EPS);
  expect(Math.abs(z.wrapper.width - z.img.width), 'the viewer is as wide as the image').toBeLessThanOrEqual(EPS);
  expect(z.scroll.scrollWidth).toBe(z.scroll.clientWidth);
  expect(z.scroll.scrollHeight).toBe(z.scroll.clientHeight);
  await attachShot(page, 'small-zoomed');

  // Zooming back out restores the fit image; a backdrop tap still closes.
  await bigImage(page).click();
  await expect(bigImage(page)).toHaveAttribute('title', 'Actual size');
  await settled(bigImage(page));
  const fit = await rectOf(bigImage(page));
  expect(Math.abs(fit.width - z.dialog.width), 'back at fit, the image is as wide as the dialog content').toBeLessThanOrEqual(EPS);
  await page.mouse.click(2, 2);
  await expect(wrapperOf(page)).toHaveCount(0);
}

export async function tallScrollsBesideImageFlow({ page, cc }: Args): Promise<void> {
  await sendImages(page, cc, [TALL]);
  const { z, tap, tolerance } = await zoomAt(page, TALL, 0.5, 0.75);
  expect(z.scroll.scrollHeight, 'positive control: the image overflows vertically').toBeGreaterThan(z.scroll.clientHeight);
  expect(z.scroll.scrollWidth, 'no horizontal scrollbar').toBe(z.scroll.clientWidth);
  expect(Math.abs(centerX(z.wrapper) - centerX(z.dialog)), 'the viewer is centred in the dialog').toBeLessThanOrEqual(EPS);
  expect(z.img.left, 'the image sits inside the viewer').toBeGreaterThanOrEqual(z.wrapper.left - EPS);
  expect(z.wrapper.right, 'the scrollbar hugs the image').toBeLessThanOrEqual(z.img.right + SCROLLBAR_ALLOWANCE);
  const want = expectedScroll(TALL, { fx: 0.5, fy: 0.75 }, tap, z);
  expect(z.scroll.top, 'the view starts at the tapped spot').toBeGreaterThan(0);
  expect(Math.abs(z.scroll.top - want.top)).toBeLessThanOrEqual(tolerance);
  expect(z.scroll.left).toBe(0);
  await attachShot(page, 'tall-zoomed');
}

export async function largeStartsAtTapFlow({ page, cc }: Args): Promise<void> {
  await sendImages(page, cc, [LARGE]);
  const { z, tap, tolerance } = await zoomAt(page, LARGE, 0.75, 0.75);
  expect(z.scroll.scrollWidth, 'positive control: overflows horizontally').toBeGreaterThan(z.scroll.clientWidth);
  expect(z.scroll.scrollHeight, 'positive control: overflows vertically').toBeGreaterThan(z.scroll.clientHeight);
  const want = expectedScroll(LARGE, { fx: 0.75, fy: 0.75 }, tap, z);
  expect(want.left, 'positive control: not top-left').toBeGreaterThan(0);
  expect(want.top, 'positive control: not top-left').toBeGreaterThan(0);
  const centred = { left: (z.scroll.scrollWidth - z.scroll.clientWidth) / 2, top: (z.scroll.scrollHeight - z.scroll.clientHeight) / 2 };
  expect(Math.abs(want.left - centred.left) + Math.abs(want.top - centred.top), 'positive control: not centred').toBeGreaterThan(50);
  expect(Math.abs(z.scroll.left - want.left)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(z.scroll.top - want.top)).toBeLessThanOrEqual(tolerance);
  await attachShot(page, 'large-zoomed');
  await closeOverlay(page);
}

export async function wideReanchorsOnZoomFlow({ page, cc }: Args): Promise<void> {
  await sendImages(page, cc, [WIDE]);
  const f = { fx: 0.5, fy: 0.25 };
  const { z, tap, tolerance, wrapperBefore } = await zoomAt(page, WIDE, f.fx, f.fy);
  expect(z.wrapper.top, 'positive control: the viewer grew, so its top moved on zoom').toBeLessThan(wrapperBefore.top - 50);
  const want = expectedScroll(WIDE, f, tap, z);
  const fromFitOrigin = expectedScroll(WIDE, f, tap, { ...z, wrapper: wrapperBefore });
  expect(fromFitOrigin.top - want.top, 'positive control: the fit-mode origin would scroll well away from the right answer').toBeGreaterThan(3 * tolerance + 50);
  expect(Math.abs(z.scroll.top - want.top), 'the vertical start comes from the zoomed viewer\'s origin').toBeLessThanOrEqual(tolerance);
  expect(Math.abs(z.scroll.left - want.left)).toBeLessThanOrEqual(tolerance);
  await attachShot(page, 'wide-zoomed');
}
