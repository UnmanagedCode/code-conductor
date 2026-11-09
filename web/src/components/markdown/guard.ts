// What Markdown refuses to parse, shown as raw text instead: a document past MAX_SIZE characters, or one whose lines
// could open more than MAX_NESTING containers (micromark's cost grows with lines × open depth). The nesting count is
// blind to fences and HTML, so it only over-counts: deep markers inside a code block fall back too.
export const MAX_SIZE = 256 * 1024;
export const MAX_NESTING = 32;

/** A quote marker, or a list marker followed by a space, a tab or the line's end. */
const MARKER = /[>]|[-+*](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$)/y;

/** The most containers any line could open: its markers, plus half the indentation before them (a tab to the next 4-column stop). */
export function nestingDepth(text: string): number {
  let max = 0;
  for (const line of text.replace(/^﻿/, '').split(/\r\n?|\n/)) {
    let i = 0, col = 0, markers = 0, indent = 0;
    for (;;) {
      let ws = 0;
      for (; line[i] === ' ' || line[i] === '\t'; i++) { const w = line[i] === '\t' ? 4 - (col % 4) : 1; col += w; ws += w; }
      MARKER.lastIndex = i;
      const m = MARKER.exec(line);
      if (!m) break;
      indent += markers && ws ? ws - 1 : ws; // a marker's own following space is not indentation
      markers++;
      col += m[0].length;
      i += m[0].length;
    }
    if (markers) max = Math.max(max, markers + Math.floor(indent / 2));
  }
  return max;
}

/** Whether Markdown may parse `text`. */
export const parseable = (text: string) => text.length <= MAX_SIZE && nestingDepth(text) <= MAX_NESTING;
