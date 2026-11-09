// micromark's parse cost grows with characters × open-container depth (a list nested 400 deep parses in ~1.4 s, one
// 1000 deep in ~24 s), so Markdown measures nesting in one linear pass and shows a document nested past MAX_NESTING
// as raw text without parsing it. At the cap a one-item-per-level list renders in a few ms, and from there cost is
// linear in the document's size; no real document nests this deep.
export const MAX_NESTING = 32;

const isBreak = (text: string, i: number) => i >= text.length || text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r';
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/**
 * The deepest container nesting any line can open: its leading quote (`>`) and list (`-`, `+`, `*`, `1.`, `1)`)
 * markers, several on one line included, plus half the whitespace columns before them (a marker's own following space
 * excluded; tabs to 4-column stops), since each nested list level needs at least two columns of indentation. A line
 * opening no container measures 0, whatever its indentation. An upper bound on the parsed depth; linear in `text`.
 */
export function nestingDepth(text: string): number {
  let max = 0;
  let i = 0;
  while (i < text.length) {
    let col = 0;
    let markers = 0;
    let indent = 0;
    for (;;) {
      let ws = 0;
      while (text[i] === ' ' || text[i] === '\t') {
        const w = text[i] === '\t' ? 4 - (col % 4) : 1;
        col += w;
        ws += w;
        i++;
      }
      if (markers > 0 && ws > 0) ws -= 1;
      let end = -1;
      const c = text[i];
      if (c === '>') end = i + 1;
      else if ((c === '-' || c === '+' || c === '*') && isBreak(text, i + 1)) end = i + 1;
      else if (isDigit(c)) {
        let j = i;
        while (isDigit(text[j]) && j - i < 9) j++;
        if ((text[j] === '.' || text[j] === ')') && isBreak(text, j + 1)) end = j + 1;
      }
      if (end < 0) break;
      markers++;
      indent += ws;
      col += end - i;
      i = end;
    }
    if (markers > 0) max = Math.max(max, markers + Math.floor(indent / 2));
    const nl = text.indexOf('\n', i);
    i = nl < 0 ? text.length : nl + 1;
  }
  return max;
}
