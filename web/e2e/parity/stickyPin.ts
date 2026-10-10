// Helpers the sticky-prompt specs share: prompts tall enough to scroll and to
// overflow the pin's clamp, geometry read in the page, and touch swipes.
// Declares no tests.
import type { Locator, Page } from '@playwright/test';
import { expect } from '../harness/fixtures.ts';
import type { Ui } from './ui.ts';

const WORDS = 'the quick brown fox jumps over a lazy dog while seven bright lanterns hang above an old stone bridge near the quiet river bank at dusk tonight again'.split(' ');

/** `tag` plus 16 paragraphs of 30 plain words: tall in the transcript, more than five lines in the pin at every viewport. */
export function tallPrompt(tag: string): string {
  const paragraph = Array.from({ length: 30 }, (_, i) => WORDS[i % WORDS.length]).join(' ');
  return [tag, ...Array.from({ length: 16 }, () => paragraph)].join('\n\n');
}

/** Sends each prompt and waits for its echo and its turn's end. */
export async function sendAll(page: Page, ui: Ui, prompts: string[]): Promise<void> {
  for (let i = 0; i < prompts.length; i++) {
    const tag = prompts[i].split(/\s/)[0];
    await ui.sendPrompt(page, prompts[i]);
    await expect(ui.lastUserMessage(page), `prompt ${i} (${tag}) is echoed`).toContainText(tag);
    await expect(ui.turnEnds(page), `prompt ${i} (${tag}) ends its turn`).toHaveCount(i + 1);
  }
}

/** `el`'s top relative to the top of the scroll root's content box. */
export async function offsetFromTop(transcript: Locator, el: Locator): Promise<number> {
  const top0 = await transcript.evaluate((s) => s.getBoundingClientRect().top + s.clientTop);
  const top = await el.evaluate((e) => e.getBoundingClientRect().top);
  return top - top0;
}

/** Scrolls the transcript so `el`'s top sits at `y`. */
export async function bringTo(transcript: Locator, el: Locator, y: number): Promise<void> {
  await transcript.evaluate((s, d) => { s.scrollTop += d; }, (await offsetFromTop(transcript, el)) - y);
}

/** Down in the empty composer: reveals the pin. Sends no prompt. */
export async function reveal(page: Page, ui: Ui): Promise<void> {
  await ui.composer(page).focus();
  await page.keyboard.press('ArrowDown');
}

/** Up in the empty composer: conceals the pin. Sends no prompt. */
export async function conceal(page: Page, ui: Ui): Promise<void> {
  await ui.composer(page).focus();
  await page.keyboard.press('ArrowUp');
}

export function cssOf(loc: Locator, prop: string): Promise<string> {
  return loc.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);
}

export type ShadowLayer = { inset: boolean; y: number; blur: number; spread: number };

/** A computed `box-shadow`, one entry per layer. */
export function shadowLayers(css: string): ShadowLayer[] {
  const layers: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '(') depth++;
    else if (css[i] === ')') depth--;
    else if (css[i] === ',' && depth === 0) { layers.push(css.slice(start, i)); start = i + 1; }
  }
  layers.push(css.slice(start));
  return layers.map((layer) => {
    const inset = /\binset\b/.test(layer);
    const lengths = (layer.replace(/[a-z-]+\((?:[^()]|\([^()]*\))*\)/g, '').match(/-?[\d.]+px/g) ?? []).map(parseFloat);
    const [, y = 0, blur = 0, spread = 0] = lengths;
    return { inset, y, blur, spread };
  });
}

/** A one-finger vertical swipe of `dy` px from the zone's centre, as touch events. */
export async function swipe(zone: Locator, dy: number): Promise<void> {
  const box = await zone.boundingBox();
  if (!box) throw new Error('swipe: the zone has no box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const t = (y: number) => [{ identifier: 0, clientX: cx, clientY: y }];
  await zone.dispatchEvent('touchstart', { touches: t(cy), changedTouches: t(cy), targetTouches: t(cy) });
  for (const f of [0.25, 0.5, 1]) {
    const y = cy + dy * f;
    await zone.dispatchEvent('touchmove', { touches: t(y), changedTouches: t(y), targetTouches: t(y) });
  }
  await zone.dispatchEvent('touchend', { touches: [], changedTouches: t(cy + dy), targetTouches: [] });
}
