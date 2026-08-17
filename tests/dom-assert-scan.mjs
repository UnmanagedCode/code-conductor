// ============================================================================
// OWNERSHIP — do not delete this guard as "redundant with the tripwire".
//
// `tests/dom-assert-scan.mjs` + `tests/dom-assert-guard.test.mjs` OWN the
// invariant: *no equal-family assertion in `tests/` is written against a
// DOM-valued expression.* This guard fails at authoring time on a site that
// currently PASSES. It is the only guard that prevents re-accumulation.
// `tests/dom-assert-tripwire.mjs` cannot replace it — a latent site that
// currently passes is invisible at runtime, which is exactly how the 51 sites
// swept by card 2026-0150 accumulated under a green suite.
//
// The tripwire guards the PATH (*no DOM node ever reaches assert's serializer
// at runtime*) and covers DOM-ness this scanner is structurally blind to.
// Overlap on most sites is intentional. Neither is redundant.
// ============================================================================
//
// Why hand-rolled: no JS parser is available. `typescript@7.0.2` is the
// Go-native `tsgo` shim (its module exports only `version`/`versionMajorMinor`,
// no `createSourceFile`), there is no acorn/babel/espree in `node_modules`, and
// `CONVENTIONS.md` forbids adding a dependency. A line regex is not sufficient
// either: it over-matches prose (the comment at
// `tests/header-playbook-enforcement.test.mjs:165-169` names
// `assert.equal(node, null)` in English) and misses multi-line-formatted calls
// (`tests/notifications.test.mjs:200,208,213`). So: blank non-code, then walk
// balanced brackets.
//
// Scan direction. The obvious direction — enumerate the ~437 legitimate
// primitive-vs-null comparisons and allow-list them — is intractable: they span
// ~194 arbitrary shapes with no shared primitive signal. This scanner runs the
// INVERSE direction, keying on DOM-*producing* signals in tail position. That
// needs no allow-list and measures 0 false positives across all of `tests/`.
//
// There is deliberately NO escape hatch. With 0 measured false positives there
// is nothing to exempt (YAGNI), and an inline `// guard-ignore` comment is the
// "allow-list silently absorbs real violations" hazard reintroduced per site. A
// genuine future false positive is fixed by narrowing a signal constant below,
// in one place.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Stage 1 — blank everything that is not code.
// ---------------------------------------------------------------------------

// Returns a string of the SAME LENGTH as `src` (so offsets, and therefore line
// numbers, stay valid) with newlines preserved and the contents of comments,
// string bodies, template-literal text and regex bodies replaced by spaces.
// Delimiters (quotes, backticks, slashes) are kept so the bracket walker still
// sees well-formed call syntax. Template `${…}` expressions are left LIVE — a
// real assertion can appear inside one.
export function stripNonCode(src) {
  const n = src.length;
  const out = src.split('');
  const blank = (k) => { if (k >= 0 && k < n && out[k] !== '\n') out[k] = ' '; };
  // Open contexts. 'tpl' = template-literal text; 'sub' = a ${…} substitution
  // (code again); 'brace' = a plain { }. Popping a 'sub' reveals the 'tpl'
  // beneath it, which is what resumes blanking after the substitution closes.
  const stack = [];
  let lastSig = '';
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (stack[stack.length - 1] === 'tpl') {
      if (c === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (c === '`') { stack.pop(); lastSig = '`'; i++; continue; }
      if (c === '$' && src[i + 1] === '{') { stack.push('sub'); lastSig = '{'; i += 2; continue; }
      blank(i); i++; continue;
    }
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') { blank(i); i++; }
      continue;
    }
    if (c === '/' && c2 === '*') {
      blank(i); blank(i + 1); i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { blank(i); i++; }
      blank(i); blank(i + 1); i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;                                   // keep the opening quote
      while (i < n) {
        if (src[i] === '\\') { blank(i); blank(i + 1); i += 2; continue; }
        if (src[i] === c || src[i] === '\n') break;
        blank(i); i++;
      }
      if (src[i] === c) i++;                 // keep the closing quote
      lastSig = c;
      continue;
    }
    if (c === '`') { stack.push('tpl'); i++; continue; }
    // Regex literal vs division, disambiguated by the preceding significant
    // character (an identifier/number/`)`/`]` means the `/` is division).
    if (c === '/' && !/[\w)\]$]/.test(lastSig)) {
      i++;
      let inClass = false;
      while (i < n) {
        if (src[i] === '\\') { blank(i); blank(i + 1); i += 2; continue; }
        if (src[i] === '\n') break;
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        blank(i); i++;
      }
      if (src[i] === '/') i++;
      while (i < n && /[a-z]/.test(src[i])) { blank(i); i++; }  // flags
      lastSig = '/';
      continue;
    }
    if (c === '{') stack.push('brace');
    else if (c === '}') stack.pop();
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Stage 2 — find equal-family calls with exactly one nullish operand.
// ---------------------------------------------------------------------------

export const POSITIVE_FAMILY = ['equal', 'strictEqual', 'deepEqual', 'deepStrictEqual'];
export const NEGATIVE_FAMILY = ['notEqual', 'notStrictEqual', 'notDeepEqual', 'notDeepStrictEqual'];

// Matched bare or as the final property of a dotted chain. Deliberately general
// rather than hardcoding `assert\.`: the tree holds only `assert.equal` and
// `assert.deepEqual` today, but `assert.strict.equal` would otherwise slip
// through. Longest-first alternation so `deepStrictEqual` is not shadowed.
const FAMILY_RE = new RegExp(
  '(?<![\\w$])(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)*('
  + [...NEGATIVE_FAMILY, ...POSITIVE_FAMILY].sort((a, b) => b.length - a.length).join('|')
  + ')\\s*\\(',
  'g',
);

function lineIndex(src) {
  const offsets = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') offsets.push(i + 1);
  return offsets;
}

// Binary search, not `slice(0, o).split('\n')` — the latter is O(n) per hit and
// there are hundreds of hits per run.
function lineAt(offsets, o) {
  let lo = 0, hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= o) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

// Split the argument list starting at the `(` at `open`, tracking a ()[]{}
// stack so commas nested in objects, arrays, arrow bodies and inner calls do
// not split — and so a call formatted across several lines is one unit.
function splitArgs(s, open) {
  let depth = 0;
  let start = open + 1;
  const args = [];
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) { args.push(s.slice(start, i)); return args; }
      if (depth < 0) return null;
    } else if (c === ',' && depth === 1) {
      args.push(s.slice(start, i));
      start = i + 1;
    }
  }
  return null;   // unbalanced
}

const NULLISH_RE = /^\s*(?:null|undefined)\s*$/;

// Returns [{fn, subject, line}] for every equal-family call (positive AND
// negative — the caller filters) where exactly one of the first two arguments
// is the literal `null` or `undefined`.
export function findNullishEqualityCalls(stripped) {
  const offsets = lineIndex(stripped);
  const hits = [];
  FAMILY_RE.lastIndex = 0;
  let m;
  while ((m = FAMILY_RE.exec(stripped)) !== null) {
    const open = m.index + m[0].length - 1;
    const args = splitArgs(stripped, open);
    if (!args || args.length < 2) continue;
    const aNull = NULLISH_RE.test(args[0]);
    const bNull = NULLISH_RE.test(args[1]);
    if (aNull === bNull) continue;           // both or neither — not our shape
    hits.push({
      fn: m[1],
      subject: (aNull ? args[1] : args[0]).trim(),
      line: lineAt(offsets, m.index),
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Stage 3 — classify a subject expression by its TAIL production.
// ---------------------------------------------------------------------------
//
// Keying on the tail is what makes this sound: a `.textContent` or `.length`
// access AFTER a DOM signal replaces the tail, so `root.querySelector('a').length`
// correctly does not match.
//
// KNOWN FALSE NEGATIVES — read this before "fixing" the recall number.
// Measured against the real pre-sweep tree (`tests/` at 6de56a3^1): 46 of the
// 50 converted sites are recovered, at 0 false positives over the 437
// legitimate primitive-vs-null comparisons on the current tree.
//
// The 4 residual occurrences are 3 distinct expressions — `conv.emptyNode`,
// `main.leadingAssistantWrap` (x2) and `batch.leadingWrap`. An equal-family
// assertion whose subject is a plain property access, or a bare identifier with
// no DOM-valued definition in the same file, is INDISTINGUISHABLE from those
// 437 primitives: `main.leadingAssistantWrap` has exactly the shape of
// `inst.autoResumeAt`. Their DOM-ness lives in the RETURN VALUES of `public/`
// code and is not present in the test's syntax at all, so no amount of scanner
// work reaches them. They are covered by `tests/dom-assert-tripwire.mjs` at
// runtime; do NOT close the gap with a hand-maintained name list, which rots
// and would flag the primitives it collides with.

// `x.name(…)` yields a node.
const NODE_CALLS = new Set([
  'querySelector', 'closest', 'getElementById', 'elementFromPoint',
  'createElement', 'cloneNode', 'appendChild', 'insertBefore',
  'removeChild', 'replaceChild', 'getRootNode',
]);

// `x.name` is a node.
const NODE_PROPS = new Set([
  'parentElement', 'parentNode', 'previousElementSibling', 'nextElementSibling',
  'firstElementChild', 'lastElementChild', 'firstChild', 'lastChild',
  'nextSibling', 'previousSibling', 'offsetParent', 'shadowRoot', 'ownerDocument',
]);

// `x.name` is a node ONLY when x is a document. Receiver scoping is
// load-bearing: an unscoped `.body` was the only source of false positives in
// measurement — 5 of them, all HTTP response bodies. Requiring a `document`
// receiver is what takes the false-positive count to 0.
const DOC_PROPS = new Set(['body', 'head', 'documentElement', 'activeElement']);

// `xs.pick(…)` is a node ONLY when the receiver chain carries a collection
// signal. Also load-bearing: `[...root.querySelectorAll('.x')].find(…)` is DOM,
// `list.body.find(…)` (an HTTP response body) is not; unscoped `.find` conflates
// them.
const PICKS = new Set(['find', 'at', 'pop', 'shift', 'item', 'namedItem']);
const COLLECTION_RE = /(?:\?\.|\.)\s*(?:querySelectorAll|getElementsBy[A-Za-z]*)\s*\(|(?:\?\.|\.)\s*(?:children|childNodes)\b/;

function hasCollectionSignal(expr) {
  return COLLECTION_RE.test(expr);
}

function isDocumentReceiver(receiver) {
  const t = receiver.replace(/\s+/g, '');
  return t === 'document' || /(?:\?\.|\.)ownerDocument$/.test(t);
}

// Walk back from a closing bracket to its match.
function matchBackward(s, closeIdx) {
  let depth = 0;
  for (let i = closeIdx; i >= 0; i--) {
    const c = s[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const TRAILING_PROP_RE = /(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)\s*$/;
const BARE_IDENT_RE = /^[A-Za-z_$][\w$]*$/;

// Decompose the tail production of an expression.
function tailAccess(expr) {
  const s = expr.trim();
  if (!s) return null;
  const last = s[s.length - 1];
  if (last === ')') {
    const open = matchBackward(s, s.length - 1);
    if (open < 0) return null;
    const head = s.slice(0, open);
    const m = TRAILING_PROP_RE.exec(head);
    if (!m) return null;                     // `fn(…)` / `(expr)` — no method name
    return { kind: 'call', name: m[1], receiver: head.slice(0, m.index).trim() };
  }
  if (last === ']') {
    const open = matchBackward(s, s.length - 1);
    if (open < 0) return null;
    return { kind: 'index', receiver: s.slice(0, open).trim() };
  }
  const m = TRAILING_PROP_RE.exec(s);
  if (m) return { kind: 'prop', name: m[1], receiver: s.slice(0, m.index).trim() };
  if (BARE_IDENT_RE.test(s)) return { kind: 'ident', name: s };
  return null;
}

// Returns a short signal name when the expression's tail produces a DOM node,
// otherwise null. `domNames` is the per-file index from `collectDomNames`.
export function domValuedTail(subject, domNames = new Set()) {
  const t = tailAccess(subject);
  if (!t) return null;
  if (t.kind === 'call') {
    if (NODE_CALLS.has(t.name)) return `call:${t.name}`;
    if (PICKS.has(t.name) && hasCollectionSignal(t.receiver)) return `pick:${t.name}`;
    return null;
  }
  if (t.kind === 'prop') {
    if (NODE_PROPS.has(t.name)) return `prop:${t.name}`;
    if (DOC_PROPS.has(t.name) && isDocumentReceiver(t.receiver)) return `doc:${t.name}`;
    return null;
  }
  if (t.kind === 'index') {
    if (hasCollectionSignal(t.receiver)) return 'index:collection';
    if (domValuedTail(t.receiver, domNames)) return 'index:node';
    return null;
  }
  if (t.kind === 'ident') return domNames.has(t.name) ? `name:${t.name}` : null;
  return null;
}

// ---------------------------------------------------------------------------
// Per-file index of locally-bound DOM names.
// ---------------------------------------------------------------------------
//
// Resolves `assert.equal(btn, null)` through `const btn = wrap.querySelector(…)`.
// PER FILE, so an unrelated `const btn = mk('button')` elsewhere cannot
// contaminate it. Within a file a name counts as DOM if it has ANY DOM-valued
// definition — biased toward catching; measured to cost 0 false positives.
//
// Object-literal properties count too, and are not decoration: the pre-sweep
// site `assert.equal(btn, null)` at `tests/blocks.test.mjs` binds its name
// through `return { block, btn: block.body.querySelector('.tts-speak') }` and a
// declaration-only index misses it. The property arm requires the name to
// follow `{`, `,` or a line start so a ternary's `cond ? a : node` does not
// index `a`.

const DECL_RE = /(?<![\w$])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)|(?:[{,]|^)\s*([A-Za-z_$][\w$]*)\s*:(?!:)/gm;
// Trailing characters that mean the initializer continues onto the next line.
const CONTINUES_RE = /[.,+\-*/%&|?:=<>!({[]$/;

function initializerAt(src, from) {
  let depth = 0;
  let sig = '';
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') { depth++; sig = c; continue; }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth < 0) return src.slice(from, i);
      sig = c;
      continue;
    }
    if (depth === 0) {
      if (c === ';' || c === ',') return src.slice(from, i);
      if (c === '\n' && sig && !CONTINUES_RE.test(sig)) return src.slice(from, i);
    }
    if (!/\s/.test(c)) sig = c;
  }
  return src.slice(from);
}

export function collectDomNames(stripped) {
  const names = new Set();
  DECL_RE.lastIndex = 0;
  let m;
  while ((m = DECL_RE.exec(stripped)) !== null) {
    const init = initializerAt(stripped, m.index + m[0].length);
    if (domValuedTail(init, names)) names.add(m[1] || m[2]);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Public entry points.
// ---------------------------------------------------------------------------

// Only the positive family is a violation. `notEqual(node, null)` and friends
// can only FAIL when the operand is already nullish, so no node ever reaches
// the serializer — flagging them would be a false positive by construction.
const POSITIVE = new Set(POSITIVE_FAMILY);

export function scanSource(src, file = '<source>') {
  const stripped = stripNonCode(src);
  const domNames = collectDomNames(stripped);
  const out = [];
  for (const hit of findNullishEqualityCalls(stripped)) {
    if (!POSITIVE.has(hit.fn)) continue;
    const signal = domValuedTail(hit.subject, domNames);
    if (signal) out.push({ file, line: hit.line, fn: hit.fn, subject: hit.subject, signal });
  }
  return out;
}

export function scanFile(filePath) {
  return scanSource(readFileSync(filePath, 'utf8'), filePath);
}

// Non-recursive over `*.mjs`, mirroring `discover()` in `tests/run.mjs`.
// `tests/fixtures/` holds only `.json`/`.jsonl` — nothing to scan.
export function scanTestsDir(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.mjs')) continue;
    out.push(...scanSource(readFileSync(path.join(dir, name), 'utf8'), name));
  }
  return out;
}
