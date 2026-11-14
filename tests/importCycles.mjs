// Runtime import-cycle scanner for the server sources, plus the committed
// BASELINE of cycles still allowed. `tests/import-cycles.test.mjs` enforces it.
//
// Hand-rolled: `typescript@7` is the Go `tsgo` shim with no parser API and the
// project adds no dependency. Blank comments and template text, then match
// import/export-from statements anchored at line start.
//
// Edges: static imports that Node's type stripping keeps — everything except
// `import type` / `export type … from`. `import { type A } from` keeps its edge
// (verbatimModuleSyntax still loads the module). Dynamic `import()` is lazy, so
// it is not an edge (it is how a cycle is broken). Specifiers resolve to exact
// paths; an unresolvable relative / `@shared` / absolute / `#` specifier throws.
//
// Updating BASELINE: after legitimately shrinking an SCC, run
// `node tests/importCycles.mjs`, copy the printed SCC member lists into BASELINE
// and commit them with the change (the stale check fails until you do).
// BASELINE must never gain an entry or a member: break the new cycle instead,
// with a leaf module or a dynamic import.
//
// CLI: `node tests/importCycles.mjs [root]` prints the SCCs;
// `--check` also exits 1 on a violation or a stale BASELINE entry.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOTS = ['server.ts', 'src', 'shared', 'migrations'];
const CODE = /\.(?:ts|mts|cts|tsx|mjs|js|cjs)$/;
const DECL = /\.d\.m?ts$/;

export const BASELINE = [];

const REGEX_AFTER = new Set([...'(,=:[!&|?{};+-*%<>~^']);
// blank comments and template-literal text (newlines kept); strings & regexes kept
export function blankNonCode(src) {
  let out = ''; let i = 0; let last = '';
  const keepTo = (j) => { out += src.slice(i, j); i = j; };
  function code(stopBrace) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i], n = src[i + 1];
      if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') { i++; } continue; }
      if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; out += src.slice(i, end).replace(/[^\n]/g, ' '); i = end; continue; }
      if (c === '\'' || c === '"') { let j = i + 1; while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1; keepTo(Math.min(j + 1, src.length)); last = c; continue; }
      if (c === '`') { out += '`'; i++; template(); last = '`'; continue; }
      if (c === '/' && (last === '' || REGEX_AFTER.has(last))) { let j = i + 1, cls = false; while (j < src.length && src[j] !== '\n') { const d = src[j]; if (d === '\\') { j += 2; continue; } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) { j++; break; } j++; } while (j < src.length && /\w/.test(src[j])) j++; keepTo(j); last = 'r'; continue; }
      if (stopBrace) { if (c === '{') depth++; else if (c === '}') { if (depth === 0) { out += '}'; i++; return; } depth--; } }
      out += c; i++; if (!/\s/.test(c)) last = c;
    }
  }
  function template() {
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { out += '  '; i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') { out += '${'; i += 2; code(true); continue; }
      out += src[i] === '\n' ? '\n' : ' '; i++;
    }
    if (i < src.length) { out += '`'; i++; }
  }
  code(false);
  return out;
}

const ID = '[\\w$]+';
const NAMED = '\\{[^}]*\\}';
const CLAUSE = `(?:${ID}\\s*,\\s*(?:${NAMED}|\\*\\s*as\\s+${ID})|${NAMED}|\\*\\s*as\\s+${ID}|${ID})`;
const STATIC = new RegExp(`^[ \\t]*(?:import\\s+(type\\s+)?${CLAUSE}\\s*from|export\\s+(type\\s+)?(?:${NAMED}|\\*(?:\\s*as\\s+${ID})?)\\s*from|import)\\s*(['"])([^'"\\n]+)\\3`, 'gm');
const DYN = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;

export function runtimeSpecifiers(source) {
  const t = blankNonCode(source);
  const stat = [];
  for (const m of t.matchAll(STATIC)) if (!m[1] && !m[2]) stat.push(m[4]);
  const dynamic = [...t.matchAll(DYN)].map(m => m[2]);
  return { static: stat, dynamic };
}

export function buildGraph(texts) {
  const graph = new Map();
  for (const [file, source] of texts) {
    const edges = new Set();
    for (const spec of runtimeSpecifiers(source).static) {
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('./') && !spec.startsWith('../')) {
        if (spec.startsWith('@shared') || spec.startsWith('/') || spec.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(spec)) {
          throw new Error(`${file}: cannot resolve import specifier '${spec}'`);
        }
        continue; // bare package
      }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      if (!texts.has(target)) throw new Error(`${file}: import specifier '${spec}' names no scanned file (${target})`);
      edges.add(target);
    }
    graph.set(file, edges);
  }
  return graph;
}

export function stronglyConnected(graph) {
  let idx = 0;
  const index = new Map(), low = new Map(), on = new Set(), stack = [], out = [];
  const visit = (v) => {
    index.set(v, idx); low.set(v, idx); idx++; stack.push(v); on.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const c = []; let w;
      do { w = stack.pop(); on.delete(w); c.push(w); } while (w !== v);
      if (c.length > 1 || (graph.get(v) ?? new Set()).has(v)) out.push(c.sort());
    }
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return out.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

export function sccEdges(graph, scc) {
  const lines = [];
  for (const a of scc) for (const b of graph.get(a) ?? []) if (scc.includes(b)) lines.push(`${a} -> ${b}`);
  return lines;
}

export function compareToBaseline(sccs, baseline, graph = new Map()) {
  const violations = [], stale = [];
  const subset = (a, b) => a.every(x => b.includes(x));
  for (const c of sccs) {
    if (baseline.some(b => subset(c, b))) continue;
    const kind = baseline.some(b => c.some(x => b.includes(x))) ? 'grew or merged' : 'new cycle';
    violations.push(`${kind}: ${c.join(' ')}\n  ${sccEdges(graph, c).join('\n  ')}`);
  }
  for (const b of baseline) {
    if (!sccs.some(c => c.length === b.length && c.every((x, i) => x === b[i]))) {
      stale.push(`shrunk or gone — set BASELINE to the current SCCs: ${b.join(' ')}`);
    }
  }
  return { violations, stale };
}

function listFiles(root, rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [rel];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? listFiles(root, `${rel}/${e.name}`)
    : CODE.test(e.name) && !DECL.test(e.name) ? [`${rel}/${e.name}`] : []);
}

export function scanTree(root) {
  const files = ROOTS.flatMap(r => listFiles(root, r)).sort();
  const texts = new Map(files.map(f => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
  const graph = buildGraph(texts);
  return { files, graph, sccs: stronglyConnected(graph) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const root = args.find(a => !a.startsWith('--')) ?? '.';
  const { files, graph, sccs } = scanTree(root);
  console.log(`files ${files.length}, static edges ${[...graph.values()].reduce((n, s) => n + s.size, 0)}`);
  console.log(`${sccs.length} SCCs, sizes [${sccs.map(c => c.length)}]`);
  for (const c of sccs) {
    console.log(`  [${c.length}] ${c.join(' ')}`);
    for (const e of sccEdges(graph, c)) console.log(`      ${e}`);
  }
  if (check) {
    const { violations, stale } = compareToBaseline(sccs, BASELINE, graph);
    for (const v of violations) console.log(`VIOLATION ${v}`);
    for (const s of stale) console.log(`STALE ${s}`);
    process.exit(violations.length || stale.length ? 1 : 0);
  }
}
