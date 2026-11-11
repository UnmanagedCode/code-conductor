// The pre-flight over a run_code program: literal `cc.<tool>(` and
// `cc.<ns>.<tool>(` call sites are looked up against the live registry before
// anything runs, so a typo refuses the whole program instead of failing it
// half-way through a chain of side effects. It errs only toward NOT refusing:
// anything the scanner cannot read with certainty (computed names, bracket
// form, template substitutions) falls through to the runtime's TOOL_UNKNOWN.

import { RESERVED_METHODS } from './runtimeApi.ts';

export interface LiteralPath { path: string; segments: string[] }

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'await', 'yield', 'else', 'do']);

// A program that binds its own `cc` is not calling the injected object, so its
// call sites are not looked up. Only real binding positions count: a
// `function`'s parameter list, arrow parameters, a method shorthand's,
// `catch (cc)`, `const`/`let`/`var` (destructuring included, a `for` head's
// included), `function cc` / `class cc`, and a plain `cc =`. `if (cc) {`, `while (cfg.cc) {` and call
// arguments are not bindings. A destructuring assignment `({ cc } = obj)` goes
// undetected, which only means the pre-check still runs.
const CONTROL_KEYWORDS = ['if', 'while', 'for', 'switch', 'catch', 'with', 'return', 'typeof', 'await', 'function', 'else', 'do', 'new', 'delete', 'void', 'throw', 'in', 'of', 'yield', 'case'];
const BARE_CC = /(?<![.\w$])cc(?![\w$])/;
const OWN_CC_SHAPES: RegExp[] = [
  /\b(?:const|let|var)\s+cc(?![\w$])/,
  /\b(?:const|let|var)\s*[{[][^}\]]*(?<![.\w$])cc(?![\w$])[^}\]]*[}\]]/,
  /\b(?:function|class)\s*\*?\s*cc(?![\w$])/,
  /(?<![.\w$])cc\s*=>/,
  /\bcatch\s*\(\s*cc(?![\w$])/,
  /(?<![.\w$])cc\s*=(?![=>])/,
];
const METHOD_SHORTHAND = new RegExp(
  `(?<![.\\w$])(?!(?:${CONTROL_KEYWORDS.join('|')})(?![\\w$]))[A-Za-z_$][\\w$]*\\s*\\(([^()]*)\\)\\s*\\{`, 'g');
function bindsOwnCc(clean: string): boolean {
  if (OWN_CC_SHAPES.some(re => re.test(clean))) return true;
  // Parameter lists: `function f(…cc…)` and `(…cc…) =>`.
  for (const m of clean.matchAll(/\bfunction\s*\*?\s*[\w$]*\s*\(([^()]*)\)|\(([^()]*)\)\s*=>/g)) {
    if (BARE_CC.test(m[1] ?? m[2] ?? '')) return true;
  }
  // Method shorthand: `m(cc) {` in an object literal or a class body. A control
  // keyword before the parentheses (`if (cc) {`) is a condition, not a method.
  for (const m of clean.matchAll(METHOD_SHORTHAND)) {
    if (BARE_CC.test(m[1])) return true;
  }
  return false;
}

const IDENT_START = /[A-Za-z_$]/;

// `code` with every comment and string/template literal blanked to spaces
// (newlines kept), so a regex over the result only sees real code.
function blankNonCode(code: string): string {
  const out = code.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  // Whether the `/` at `i` may open a regular-expression literal. Where regex
  // and division are both readable the answer is yes: a literal is blanked, so
  // that reading can only fail to refuse, never refuse wrongly. Only an operand
  // before it (an identifier, a number) that is not a keyword makes it a division.
  function startsRegex(i: number): boolean {
    let j = i - 1;
    while (j >= 0 && /\s/.test(code[j])) j--;
    if (j < 0) return true;
    if (/[\w$]/.test(code[j])) {
      let k = j;
      while (k >= 0 && /[\w$]/.test(code[k])) k--;
      return KEYWORDS_BEFORE_REGEX.has(code.slice(k + 1, j + 1));
    }
    return true;
  }
  // The index just past a regex literal opening at `i` (flags included), or -1
  // when no closing `/` precedes the end of the line.
  function regexEnd(i: number): number {
    let j = i + 1;
    let inClass = false;
    while (j < code.length && code[j] !== '\n') {
      const c = code[j];
      if (c === '\\') j += 2;
      // A quote before the closing `/` means this was division, not a pattern:
      // read as one, its span could end inside a string.
      else if (c === '"' || c === "'" || c === '`') return -1;
      else if (c === '[') { inClass = true; j++; }
      else if (c === ']') { inClass = false; j++; }
      else if (c === '/' && !inClass) { j++; while (j < code.length && /[a-z]/i.test(code[j])) j++; return j; }
      else j++;
    }
    return -1;
  }
  // Scans code from `i` until `endBrace` closes (a template substitution) or
  // the input ends; returns the index it stopped at.
  function scan(start: number, inSubstitution: boolean): number {
    let i = start;
    let depth = 0;
    while (i < code.length) {
      const c = code[i];
      const n = code[i + 1];
      if (c === '/' && n === '/') {
        const e = code.indexOf('\n', i);
        const end = e === -1 ? code.length : e;
        blank(i, end);
        i = end;
      } else if (c === '/' && n === '*') {
        const e = code.indexOf('*/', i + 2);
        const end = e === -1 ? code.length : e + 2;
        blank(i, end);
        i = end;
      } else if (c === '/' && startsRegex(i)) {
        // Read as a regex, or — when that reading bails — blanked to the end of
        // the line: resuming after the `/` could pair a quote inside the span with
        // a later string and expose that string's text as code. Blanking can only
        // miss a call, never refuse a valid program.
        const end = regexEnd(i);
        // Inside a template substitution the fallback is one character: blanking
        // to the end of the line would skip the substitution's closing `}` and
        // leave the scan running to the end of the program.
        const eol = code.indexOf('\n', i) === -1 ? code.length : code.indexOf('\n', i);
        const stop = end > i ? end : inSubstitution ? i + 1 : Math.max(i + 1, eol);
        blank(i, stop);
        i = stop;
      } else if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < code.length && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
        const end = Math.min(j + 1, code.length);
        blank(i, end);
        i = end;
      } else if (c === '`') {
        let j = i + 1;
        while (j < code.length && code[j] !== '`') {
          if (code[j] === '\\') j += 2;
          else if (code[j] === '$' && code[j + 1] === '{') j = scan(j + 2, true) + 1;
          else j++;
        }
        const end = Math.min(j + 1, code.length);
        blank(i, end);
        i = end;
      } else if (inSubstitution && c === '{') { depth++; i++; }
      else if (inSubstitution && c === '}') {
        if (depth === 0) return i;
        depth--; i++;
      } else i++;
    }
    return i;
  }
  scan(0, false);
  return out.join('');
}

const CALL_SITE = /(?<![\w$.])cc\s*\.\s*([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?\s*\(/g;

export function literalPaths(code: string): LiteralPath[] {
  const clean = blankNonCode(code);
  if (bindsOwnCc(clean)) return [];
  const seen = new Set<string>();
  const paths: LiteralPath[] = [];
  for (const m of clean.matchAll(CALL_SITE)) {
    if (!IDENT_START.test(m[1])) continue;
    const segments = m[2] === undefined ? [m[1]] : [m[1], m[2]];
    const path = `cc.${segments.join('.')}`;
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push({ path, segments });
  }
  return paths;
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// The (up to three) candidates nearest `name`: within an edit distance of
// max(2, a third of its length), or sharing a substring with it.
export function closeMatches(name: string, candidates: Iterable<string>): string[] {
  const limit = Math.max(2, Math.floor(name.length / 3));
  const scored: Array<{ c: string; d: number }> = [];
  for (const c of candidates) {
    const d = levenshtein(name, c);
    const sub = name.length >= 3 && (c.includes(name) || name.includes(c));
    if (d <= limit || sub) scored.push({ c, d: sub ? Math.min(d, 1) : d });
  }
  return scored.sort((x, y) => x.d - y.d || x.c.localeCompare(y.c)).slice(0, 3).map(s => s.c);
}

export interface UnknownPath { path: string; suggestions: string[] }

const RESERVED = new Set<string>(RESERVED_METHODS);
const PLUGIN_SEP = '__';

// `names` is every callable wire name: a core tool's bare name, or a plugin
// tool's `<id>__<tool>`. `members` (plugin id → names) are the plugin names only
// a program can call; they count exactly like plugin tools.
export function checkPaths(paths: LiteralPath[], names: ReadonlySet<string>, members: ReadonlyMap<string, ReadonlySet<string>> = new Map()): UnknownPath[] {
  const core = [...names].filter(n => !n.includes(PLUGIN_SEP));
  const memberWires = [...members].flatMap(([id, ms]) => [...ms].map(m => `${id}${PLUGIN_SEP}${m}`));
  const plugin = [...new Set([...names].filter(n => n.includes(PLUGIN_SEP)).concat(memberWires))];
  const coreSet = new Set(core);
  const unknown: UnknownPath[] = [];
  for (const { path, segments } of paths) {
    const [a, b] = segments;
    if (RESERVED.has(a) || coreSet.has(a)) continue;
    if (b === undefined) {
      unknown.push({ path, suggestions: closeMatches(a, core).map(n => `cc.${n}`) });
      continue;
    }
    const id = a.replaceAll('_', '-');
    if (names.has(`${id}${PLUGIN_SEP}${b}`) || members.get(id)?.has(b)) continue;
    const inNamespace = plugin.filter(n => n.startsWith(`${id}${PLUGIN_SEP}`));
    const suggestions = inNamespace.length > 0
      ? closeMatches(b, inNamespace.map(n => n.slice(id.length + PLUGIN_SEP.length))).map(t => `cc.${a}.${t}`)
      : closeMatches(id, new Set(plugin.map(n => n.slice(0, n.indexOf(PLUGIN_SEP))))).map(ns => `cc.${ns.replaceAll('-', '_')}`);
    unknown.push({ path, suggestions });
  }
  return unknown;
}
