// micromark's parse cost grows with characters × open-container depth (a list nested 400 deep parses in ~1.4 s, one
// 1000 deep in ~24 s), so Markdown measures nesting in one linear pass and shows a document nested past MAX_NESTING
// as raw text without parsing it. At the cap a one-item-per-level list renders in a few ms, and from there cost is
// linear in the document's size; no real document nests this deep.
//
// The measure must never fall below what micromark parses: lines end where micromark ends them (LF, CRLF, a lone CR),
// a leading BOM is skipped, tabs expand to 4-column stops, and only lines micromark certainly reads as fenced code are
// skipped. Wherever this scan cannot tell, it measures the line.
export const MAX_NESTING = 32;

const SP = 32, TAB = 9, GT = 62, DASH = 45, PLUS = 43, STAR = 42, DOT = 46, PAREN = 41, BACKTICK = 96, TILDE = 126;
const isDigit = (c: number) => c >= 48 && c <= 57;

/** HTML block starts micromark ends at a marker rather than a blank line (CommonMark types 1–5), with that marker. */
const HTML_UNTIL: [RegExp, RegExp][] = [
  [/^<(?:script|pre|style|textarea)(?:[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^<!--/, /-->/],
  [/^<\?/, /\?>/],
  [/^<!\[CDATA\[/, /\]\]>/],
  [/^<![A-Za-z]/, />/],
];

/** A line's container prefix: the quote and list markers it opens and where its content starts. */
type Prefix = {
  /** Quote and list markers, several on one line included. */
  markers: number;
  /** The nesting the line can open: its markers plus half the extra indentation before them. */
  depth: number;
  /** Index and column where the content after the markers starts. */
  content: number;
  col: number;
  /** Columns of whitespace before the content, a marker's own following space excluded. */
  lead: number;
  /** The column of each quote marker, and the column after the last one and its optional space. */
  quoteCols: number[];
  afterQuote: number;
};

function prefixOf(text: string, start: number, end: number): Prefix {
  let i = start;
  let col = 0;
  let markers = 0;
  let indent = 0;
  const quoteCols: number[] = [];
  let afterQuote = 0;
  for (;;) {
    let ws = 0;
    for (; i < end; i++) {
      const c = text.charCodeAt(i);
      if (c === SP) { col++; ws++; } else if (c === TAB) { const w = 4 - (col % 4); col += w; ws += w; } else break;
    }
    const lead = markers > 0 && ws > 0 ? ws - 1 : ws;
    const c = i < end ? text.charCodeAt(i) : -1;
    const brk = (j: number) => j >= end || text.charCodeAt(j) === SP || text.charCodeAt(j) === TAB;
    let next = -1;
    if (c === GT) next = i + 1;
    else if ((c === DASH || c === PLUS || c === STAR) && brk(i + 1)) next = i + 1;
    else if (isDigit(c)) {
      let j = i;
      while (j < end && isDigit(text.charCodeAt(j)) && j - i < 9) j++;
      const d = j < end ? text.charCodeAt(j) : -1;
      if ((d === DOT || d === PAREN) && brk(j + 1)) next = j + 1;
    }
    if (next < 0) return { markers, depth: markers ? markers + Math.floor(indent / 2) : 0, content: i, col, lead, quoteCols, afterQuote };
    markers++;
    indent += lead;
    if (c === GT) {
      quoteCols.push(col);
      // The marker's optional space; a tab right after it gives one of its columns.
      afterQuote = col + 1 + (next < end && (text.charCodeAt(next) === SP || text.charCodeAt(next) === TAB) ? 1 : 0);
    }
    col += next - i;
    i = next;
  }
}

/** An open fenced code block: its character and run length, the quote columns each line must repeat, its content column. */
type Fence = { char: number; len: number; quoteCols: number[]; col: number };

/** Whether `[i, end)` holds only spaces and tabs. */
function blankFrom(text: string, i: number, end: number): boolean {
  for (; i < end; i++) { const c = text.charCodeAt(i); if (c !== SP && c !== TAB) return false; }
  return true;
}

/** The length of the run of `char` at `i`. */
function runAt(text: string, i: number, end: number, char: number): number {
  let j = i;
  while (j < end && text.charCodeAt(j) === char) j++;
  return j - i;
}

/** The fence a line opens at its content, or null: three or more ` or ~, a backtick fence's info holding no backtick. */
function fenceOpenedBy(text: string, p: Prefix, end: number): Fence | null {
  if (p.lead > 3) return null;
  const char = text.charCodeAt(p.content);
  if (char !== BACKTICK && char !== TILDE) return null;
  const len = runAt(text, p.content, end, char);
  if (len < 3) return null;
  if (char === BACKTICK && text.slice(p.content + len, end).includes('`')) return null;
  return { char, len, quoteCols: p.quoteCols, col: p.col - p.afterQuote };
}

/**
 * How a line inside `fence` reads: 'content' or 'close' while the fence holds it, 'exit' when its container ends (the
 * line is then ordinary markdown). A line keeps a quoted fence only with `>` at exactly the opening's columns, and a
 * fence in a list item only indented to the fence's own column; a closing run is the fence's character, at least as
 * long, indented at most 3 more columns, with nothing after it.
 */
function inFence(text: string, start: number, end: number, fence: Fence): 'content' | 'close' | 'exit' {
  let i = start;
  let col = 0;
  let owed = 0;
  for (const q of fence.quoteCols) {
    while (i < end && text.charCodeAt(i) === SP && col < q) { i++; col++; }
    if (col !== q || i >= end || text.charCodeAt(i) !== GT) return 'exit';
    i++; col++;
    owed = 0;
    // The marker's optional space; a tab right after it gives one of its columns.
    if (i < end && text.charCodeAt(i) === SP) { i++; col++; } else if (i < end && text.charCodeAt(i) === TAB) owed = 1;
  }
  let ws = 0;
  for (; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c === SP) { col++; ws++; } else if (c === TAB) { const w = 4 - (col % 4); col += w; ws += w; } else break;
  }
  if (i >= end) return 'content';
  ws -= owed;
  if (fence.col > 0 && ws < fence.col) return 'exit';
  if (ws <= fence.col + 3 && runAt(text, i, end, fence.char) >= fence.len && blankFrom(text, i + runAt(text, i, end, fence.char), end)) return 'close';
  return 'content';
}

/** The deepest container nesting any line can open; fenced code content is not nesting. Linear in `text`. */
export function nestingDepth(text: string): number {
  let max = 0;
  let fence: Fence | null = null;
  // An open HTML block: the marker that ends it, or null when a blank line does. No fence opens inside one.
  let html: RegExp | null | undefined;
  const n = text.length;
  let start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (start <= n) {
    let end = start;
    while (end < n) { const c = text.charCodeAt(end); if (c === 10 || c === 13) break; end++; }
    let measured = true;
    if (fence) {
      const at = inFence(text, start, end, fence);
      if (at === 'exit') fence = null;
      else {
        if (at === 'close') fence = null;
        measured = false;
      }
    }
    if (measured) {
      const p = prefixOf(text, start, end);
      max = Math.max(max, p.depth);
      if (html !== undefined) {
        if (html === null ? blankFrom(text, start, end) : html.test(text.slice(start, end))) html = undefined;
      } else if (text.charCodeAt(p.content) === 60 /* < */) {
        const rest = text.slice(p.content, end);
        const until = HTML_UNTIL.find(([open]) => open.test(rest));
        if (!until) html = null;
        else if (!until[1].test(rest.slice(2))) html = until[1];
      } else {
        fence = fenceOpenedBy(text, p, end);
      }
    }
    if (end >= n) break;
    start = text.charCodeAt(end) === 13 && text.charCodeAt(end + 1) === 10 ? end + 2 : end + 1;
  }
  return max;
}
