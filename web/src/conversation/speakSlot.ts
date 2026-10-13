// Where a text block's read-aloud control goes: a slot at the inline end of the
// rendered markdown's last block, or nowhere when that block has no inline end
// (a code block, table, rule or the renderer's error fallback).
import { renderMarkdownInto } from '@shared/markdown';

/** The element whose inline content ends `root`'s last block; null when that block has no inline end. Lists don't nest in the renderer. */
export function inlineEndHost(root: HTMLElement): HTMLElement | null {
  const last = root.lastElementChild as HTMLElement | null;
  if (!last) return null;
  if (last.matches('p, h1, h2, h3, h4, h5, h6, blockquote')) return last;
  if (last.matches('ul, ol')) return last.lastElementChild as HTMLElement | null;
  return null;
}

/** Renders `text` into `root` and appends an empty slot to its last block's inline end; null when it has none. */
export function renderWithSpeakSlot(root: HTMLElement, text: string): HTMLSpanElement | null {
  renderMarkdownInto(root, text);
  const host = inlineEndHost(root);
  if (!host) return null;
  const slot = document.createElement('span');
  slot.setAttribute('data-speak-slot', '');
  host.appendChild(slot);
  return slot;
}

/** Inline after the last word: the 28px button's 20px margin box fits the 15px relaxed line, so the line keeps its height; the hit area stays 28×28. */
export const SPEAK_INLINE = '-my-1 align-middle';

/**
 * At `md` and up, centred in the avatar column (`size-8` avatar + `gap-3` in AssistantBubble) and on the first line of 15px relaxed prose.
 * Its containing block is the `relative` `[data-text-block]`: the slot never goes inside a positioned markdown element.
 */
export const SPEAK_GUTTER = 'md:absolute md:-top-0.5 md:-left-[2.625rem] md:my-0';

/** Muted at rest; full strength on its own segment's hover, on keyboard focus, while speaking, and always where nothing hovers. */
export const SPEAK_REVEAL = 'opacity-50 transition-opacity group-hover/speak:opacity-100 focus-visible:opacity-100 data-[speaking]:opacity-100 [@media(hover:none)]:opacity-100';
