// A small lossless JS/TS lexer for colouring agent-authored scripts (run_code).
// Contract: the tokens' text concatenates to the input exactly, every token is
// non-empty, and scanning always terminates. A wrong reading may only
// mis-colour, never drop, duplicate or reorder characters.

export type JsTokenKind = 'comment' | 'string' | 'regex' | 'number' | 'keyword' | 'plain';
export type JsToken = { kind: JsTokenKind; text: string };

const KEYWORDS = new Set((
  'const let var function return await async if else for while do of in new try catch finally throw typeof ' +
  'instanceof class extends import export from default switch case break continue yield delete void this null ' +
  'undefined true false as type interface'
).split(' '));

// A `/` after one of these opens a regex rather than dividing.
const REGEX_AFTER_KEYWORD = new Set('return typeof case in of delete void throw new await yield else do'.split(' '));

// Template nesting past this depth is not scanned: the rest of the input is one
// `string` token, so recursion (one frame pair per level) stays bounded.
const MAX_TEMPLATE_DEPTH = 100;

const isIdStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdChar = (c: string) => /[\w$]/.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';

export function tokenizeJs(src: string): JsToken[] {
  const out: JsToken[] = [];
  const push = (kind: JsTokenKind, text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (kind === 'plain' && last?.kind === 'plain') last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  let templateDepth = 0;

  // Previous significant token, for the regex-vs-division decision.
  let prev: { kind: 'none' | 'punct' | 'closer' | 'word' | 'other'; text: string } = { kind: 'none', text: '' };

  const regexAllowed = () => {
    if (prev.kind === 'none' || prev.kind === 'punct') return true;
    if (prev.kind === 'word') return REGEX_AFTER_KEYWORD.has(prev.text);
    return false;
  };

  // Scan code from `i` until the end of input, or (when `stopAtBrace`) the
  // unmatched `}` closing a template substitution, which is left unconsumed.
  const scanCode = (stopAtBrace: boolean) => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];
      if (c === '/' && n === '/') {
        let j = i + 2;
        while (j < src.length && src[j] !== '\n') j++;
        push('comment', src.slice(i, j)); i = j; continue;
      }
      if (c === '/' && n === '*') {
        const end = src.indexOf('*/', i + 2);
        const j = end < 0 ? src.length : end + 2;
        push('comment', src.slice(i, j)); i = j; continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < src.length) {
          if (src[j] === '\\') { j = Math.min(j + 2, src.length); continue; }
          if (src[j] === c) { j++; break; }
          if (src[j] === '\n') break;
          j++;
        }
        push('string', src.slice(i, j)); i = j; prev = { kind: 'other', text: '' }; continue;
      }
      if (c === '`') { scanTemplate(); prev = { kind: 'other', text: '' }; continue; }
      if (c === '/' && regexAllowed()) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < src.length && src[j] !== '\n') {
          const d = src[j];
          if (d === '\\') { j += src[j + 1] === '\n' ? 1 : 2; continue; }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) { closed = true; j++; break; }
          j++;
        }
        j = Math.min(j, src.length);
        if (closed) {
          while (j < src.length && /[a-z]/.test(src[j])) j++;
          push('regex', src.slice(i, j)); i = j; prev = { kind: 'other', text: '' }; continue;
        }
      }
      if (isDigit(c) || (c === '.' && n !== undefined && isDigit(n))) {
        const m = /^(?:0[xX][0-9a-fA-F_]+n?|0[oO][0-7_]+n?|0[bB][01_]+n?|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?n?|\d[\d_]*\.?(?:[eE][+-]?\d+)?n?)/.exec(src.slice(i));
        const len = m ? m[0].length : 1;
        push('number', src.slice(i, i + len)); i += len; prev = { kind: 'other', text: '' }; continue;
      }
      if (isIdStart(c)) {
        let j = i + 1;
        while (j < src.length && isIdChar(src[j])) j++;
        const word = src.slice(i, j);
        push(KEYWORDS.has(word) ? 'keyword' : 'plain', word);
        i = j; prev = { kind: 'word', text: word }; continue;
      }
      if (c === '{') depth++;
      if (c === '}') {
        if (depth === 0 && stopAtBrace) return;
        depth = Math.max(0, depth - 1);
      }
      push('plain', c); i++;
      if (/\s/.test(c)) continue;
      prev = c === ')' || c === ']' || c === '}' ? { kind: 'closer', text: c } : { kind: 'punct', text: c };
    }
  };

  // At a backtick: text parts are strings, `${ … }` bodies are code.
  const scanTemplate = () => {
    let start = i;
    if (templateDepth >= MAX_TEMPLATE_DEPTH) { push('string', src.slice(i)); i = src.length; return; }
    templateDepth++;
    i++;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i = Math.min(i + 2, src.length); continue; }
      if (c === '`') { i++; push('string', src.slice(start, i)); templateDepth--; return; }
      if (c === '$' && src[i + 1] === '{') {
        push('string', src.slice(start, i));
        push('plain', '${'); i += 2;
        prev = { kind: 'punct', text: '{' };
        scanCode(true);
        if (i < src.length) { push('plain', '}'); i++; }
        start = i;
        continue;
      }
      i++;
    }
    push('string', src.slice(start, i));
    templateDepth--;
  };

  scanCode(false);
  return out;
}
