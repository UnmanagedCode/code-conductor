// The read-aloud control's styling where it sits at the inline end of a text block's last line of prose. Where that
// slot goes is Markdown's `inlineEnd` (components/markdown/inlineEnd.ts).

/** Inline after the last word: the 28px button's 20px margin box fits the 15px relaxed line, so the line keeps its height; the hit area stays 28×28. */
export const SPEAK_INLINE = '-my-1 align-middle';

/** Muted at rest; full strength on its own segment's hover, on keyboard focus, while speaking, and always where nothing hovers. */
export const SPEAK_REVEAL = 'opacity-50 transition-opacity group-hover/speak:opacity-100 focus-visible:opacity-100 data-[speaking]:opacity-100 [@media(hover:none)]:opacity-100';
