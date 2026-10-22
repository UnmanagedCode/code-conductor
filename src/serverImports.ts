// What the running server's code imports, read from a commit: the files
// server.ts and src/ reach through their import statements, transitively.
// Used by src/webPostMerge.ts to tell a changed path the server loads from one
// only the UI build reads.
//
// Resolution is Node's for cc's sources: a relative specifier names the exact
// file (cc imports `.ts` paths as written — allowImportingTsExtensions), with
// no extension or index probing and no `.js` → `.ts` mapping; a bare package
// name or a `node:` builtin is no edge. Anything else — a non-literal
// `import(`, a `require(`, the `@shared/` alias, an absolute path, a URL, a `#`
// subpath import, a specifier naming no file — makes the whole walk unknown,
// which the caller reads as "may load anything".

import path from 'node:path';
import { runGit } from './worktrees.ts';
import { localSystem } from './systems/registry.ts';
import type { System } from './systems/system.ts';

// chains: each reached path → its shortest import chain [root, …, path].
export type ServerImports = { chains: Map<string, string[]> } | { unknown: string };

const CODE_EXTS = ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs'];
// A dynamic import whose argument is not one plain string literal.
const OPAQUE_IMPORT = /\bimport\s*\((?!\s*(['"])[^'"\n]*\1\s*\))/;
const REQUIRE = /\brequire\s*\(/;
const SPECIFIER = /\b(?:from|import)\s*(?:\(\s*)?(['"])([^'"\n]*)\1/g;
// A specifier Node reads as a URL, `node:` included.
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const isRoot = (p: string) => p === 'server.ts' || p.startsWith('src/');

/**
 * Walk the import graph from server.ts and every src/ path in `files`
 * (breadth-first, in `files` order). `text` holds each file's text, or only
 * the lines that can carry an import: every rule below needs `import`,
 * `require` or `from` on the line. A file with no text has no edges.
 */
export function walkServerImports(files: ReadonlySet<string>, text: ReadonlyMap<string, string>): ServerImports {
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  for (const f of files) if (isRoot(f)) { parent.set(f, null); queue.push(f); }
  for (let i = 0; i < queue.length; i++) {
    const file = queue[i];
    for (const raw of (text.get(file) ?? '').split('\n')) {
      const line = raw.trim();
      if (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;
      const unknown = (why: string): ServerImports => ({ unknown: `${file}: ${why}: ${line}` });
      // These reasons are code lines this walk scans in its own source: neither
      // may contain what OPAQUE_IMPORT or REQUIRE match, or cc's own walk goes
      // unknown. Only server-imports' real-tree tests would notice.
      if (OPAQUE_IMPORT.test(line)) return unknown('a dynamic import of no plain string literal');
      if (REQUIRE.test(line)) return unknown('a CommonJS require call');
      for (const [, , spec] of line.matchAll(SPECIFIER)) {
        if (spec.startsWith('node:')) continue;
        if (spec.startsWith('@shared/')) return unknown(`'${spec}' is a path alias Node cannot resolve`);
        if (spec.startsWith('/') || spec.startsWith('#') || URL_SCHEME.test(spec)) return unknown(`'${spec}' is not a relative path or a package`);
        if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
        if (!files.has(target)) return unknown(`'${spec}' names no file in the tree`);
        if (parent.has(target)) continue;
        parent.set(target, file);
        queue.push(target);
      }
    }
  }
  const chains = new Map<string, string[]>();
  for (const p of queue) {
    const up = parent.get(p);
    chains.set(p, up == null ? [p] : [...chains.get(up)!, p]);
  }
  return { chains };
}

/**
 * walkServerImports over the tree of commit `rev` in the repo at `root`. A git
 * read that fails is unknown; one that never answered throws (runGit).
 */
export async function serverImportsAt(root: string, rev: string, system: System = localSystem()): Promise<ServerImports> {
  const git = (args: string[]) => runGit(system, root, args);
  const tree = await git(['ls-tree', '-r', '-z', '--name-only', rev]);
  if (tree.code !== 0) return { unknown: `git ls-tree ${rev} failed: ${tree.stderr.trim()}` };
  const files = tree.stdout.split('\0').filter(Boolean);
  const grep = await git([
    '-c', 'grep.lineNumber=false', '-c', 'grep.column=false',
    'grep', '-I', '-z', '--no-color', '-E', 'import|require|from', rev, '--', ...CODE_EXTS.map((e) => '*' + e),
  ]);
  // Only exit 0 is read. git grep's "no line matched" exit 1 is also what a
  // grep killed at the output fence (GIT_OUTPUT_LIMIT_BYTES), killed by a
  // signal, or unable to start returns, and read as no match any of them
  // would clear every gated path. A boot commit with no import line at all
  // proves nothing either, since server.ts always has one.
  if (grep.code !== 0) return { unknown: `git grep ${rev} failed (exit ${grep.code}): ${grep.stderr.trim()}` };
  const text = new Map<string, string>();
  // Each record is `<rev>:<path>\0<line>\n`.
  for (const rec of grep.stdout.split('\n')) {
    const nul = rec.indexOf('\0');
    if (nul < 0) continue;
    const p = rec.slice(rev.length + 1, nul);
    text.set(p, (text.has(p) ? text.get(p) + '\n' : '') + rec.slice(nul + 1));
  }
  return walkServerImports(new Set(files), text);
}
