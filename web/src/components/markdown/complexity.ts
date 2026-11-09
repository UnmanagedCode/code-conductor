// A linear pre-scan that keeps Markdown off micromark's superlinear paths. Each measure bounds one driver, and a
// document past any limit in COMPLEXITY_LIMITS shows as raw text without being parsed:
// - nesting: parse cost grows with characters × open-container depth;
// - delimiters, brackets: every `*`/`_` run, and every `]`, walks back over the earlier ones in its paragraph;
// - definitions: each link reference definition is costly (~0.1–0.2 ms);
// - restarts: each container that closes while the document goes on, and each setext heading, splices micromark's
//   document-wide event list.
//
// No measure may fall below what micromark parses: lines end where micromark ends them (LF, CRLF, a lone CR), a
// leading BOM is skipped, tabs expand to 4-column stops, and only lines micromark certainly reads as fenced code are
// skipped. Wherever this scan cannot tell, it counts.

/** The largest value of each measure Markdown still parses. */
export const COMPLEXITY_LIMITS = {
  /** Quote and list nesting on any line. */
  nesting: 32,
  /** `*` and `_` characters in one paragraph (a run of non-blank lines). */
  delimiters: 1024,
  /** `]` characters in one paragraph. */
  brackets: 1024,
  /** `]:` sequences in the document, an upper bound on its link reference definitions. */
  definitions: 256,
  /** Lines that change or leave the open containers, quotes resumed after a blank line, and setext underline candidates. */
  restarts: 512,
} as const;

export type Complexity = { -readonly [K in keyof typeof COMPLEXITY_LIMITS]: number };

const SP = 32, TAB = 9, GT = 62, DASH = 45, PLUS = 43, STAR = 42, DOT = 46, PAREN = 41, BACKTICK = 96, TILDE = 126;
const UNDERSCORE = 95, RBRACKET = 93, COLON = 58, EQUALS = 61;
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
  /** Index of the first non-blank character after the last quote marker (or of the line): where an underline may start. */
  unquoted: number;
  /** Each marker with its column: two lines open the same containers only if these match. */
  sig: string;
};

function prefixOf(text: string, start: number, end: number): Prefix {
  let i = start;
  let col = 0;
  let markers = 0;
  let indent = 0;
  const quoteCols: number[] = [];
  let afterQuote = 0;
  let unquoted = -1;
  let sig = '';
  for (;;) {
    let ws = 0;
    for (; i < end; i++) {
      const c = text.charCodeAt(i);
      if (c === SP) { col++; ws++; } else if (c === TAB) { const w = 4 - (col % 4); col += w; ws += w; } else break;
    }
    const lead = markers > 0 && ws > 0 ? ws - 1 : ws;
    if (unquoted < 0) unquoted = i;
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
    if (next < 0) return { markers, depth: markers ? markers + Math.floor(indent / 2) : 0, content: i, col, lead, quoteCols, afterQuote, unquoted, sig };
    markers++;
    sig += `${col}${text[next - 1]}`;
    indent += lead;
    if (c === GT) {
      unquoted = -1;
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

/** Whether a line's content from `i` is a setext underline: a run of `=` or of `-`, then only whitespace. */
function underline(text: string, i: number, end: number): boolean {
  const c = text.charCodeAt(i);
  if (c !== EQUALS && c !== DASH) return false;
  return blankFrom(text, i + runAt(text, i, end, c), end);
}

/** Every measure COMPLEXITY_LIMITS bounds. Linear in `text`. */
export function measureComplexity(text: string): Complexity {
  const m: Complexity = { nesting: 0, delimiters: 0, brackets: 0, definitions: 0, restarts: 0 };
  let fence: Fence | null = null;
  // An open HTML block: the marker that ends it, or null when a blank line does. No fence opens inside one.
  let html: RegExp | null | undefined;
  // The current paragraph's counts.
  let delimiters = 0;
  let brackets = 0;
  const endParagraph = () => {
    m.delimiters = Math.max(m.delimiters, delimiters);
    m.brackets = Math.max(m.brackets, brackets);
    delimiters = 0;
    brackets = 0;
  };
  // The containers the last marker line opened, and the content column the lines since have kept.
  let containers: string | null = null;
  let contentCol = 0;
  let blankSinceMarkers = false;
  let afterText = false;
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
      m.nesting = Math.max(m.nesting, p.depth);
      const blank = blankFrom(text, p.content, end) && p.markers === 0;
      if (blank) {
        blankSinceMarkers = true;
        endParagraph();
      } else if (p.markers > 0) {
        if (p.sig !== containers || (blankSinceMarkers && p.quoteCols.length > 0)) m.restarts++;
        containers = p.sig;
        contentCol = p.col;
        blankSinceMarkers = false;
      } else if (p.col < contentCol) {
        // A line indented less than the open containers' content may close them, one level per such line.
        m.restarts++;
        contentCol = p.col;
      }
      // A lone `-` underline also reads as an empty list item, so the underline may start before the content.
      if (!blank && afterText && (underline(text, p.content, end) || underline(text, p.unquoted, end))) m.restarts++;
      if (html !== undefined) {
        if (html === null ? blank : html.test(text.slice(start, end))) html = undefined;
      } else if (text.charCodeAt(p.content) === 60 /* < */) {
        const rest = text.slice(p.content, end);
        const until = HTML_UNTIL.find(([open]) => open.test(rest));
        if (!until) html = null;
        else if (!until[1].test(rest.slice(2))) html = until[1];
      } else {
        fence = fenceOpenedBy(text, p, end);
      }
      if (fence) {
        endParagraph();
        afterText = false;
      } else {
        for (let i = start; i < end; i++) {
          const c = text.charCodeAt(i);
          if (c === STAR || c === UNDERSCORE) delimiters++;
          else if (c === RBRACKET) {
            brackets++;
            if (i + 1 < end && text.charCodeAt(i + 1) === COLON) m.definitions++;
          }
        }
        afterText = !blank;
      }
    } else {
      afterText = false;
    }
    if (end >= n) break;
    start = text.charCodeAt(end) === 13 && text.charCodeAt(end + 1) === 10 ? end + 2 : end + 1;
  }
  endParagraph();
  return m;
}

/** Whether any measure of `text` is past its limit. */
export function overBudget(text: string): boolean {
  const m = measureComplexity(text);
  return (Object.keys(COMPLEXITY_LIMITS) as (keyof Complexity)[]).some((k) => m[k] > COMPLEXITY_LIMITS[k]);
}
