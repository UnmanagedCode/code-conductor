// The old-UI test inventory: every test the cutover deletes or must edit, so
// every file the parity ledger must account for. The criterion is computed
// from the tree, never listed (docs/frontend-testing.md → Parity ledger).
import fs from 'node:fs';
import path from 'node:path';
import { eachNode, parseProgram, type Node } from './ast.ts';

const LIB_CORE = '@/lib/core/';

/** Repo-relative, `/`-separated paths of every file under `dir` (none when it is absent). */
function walk(root: string, dir: string): string[] {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();
}

/** A source file's string literals, template-literal parts, and module specifiers. */
function sourceStrings(file: string, code: string): { strings: string[]; imports: string[] } {
  const strings: string[] = [];
  const imports: string[] = [];
  eachNode(parseProgram(file, code), (n: Node) => {
    if (n.type === 'Literal' && typeof n.value === 'string') strings.push(n.value);
    else if (n.type === 'TemplateElement' && typeof n.value.cooked === 'string') strings.push(n.value.cooked);
    if ((n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration' || n.type === 'ExportNamedDeclaration'
      || n.type === 'ImportExpression') && n.source?.type === 'Literal' && typeof n.source.value === 'string') {
      imports.push(n.source.value);
    }
  });
  return { strings, imports };
}

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

/**
 * `public/` files only the old UI uses, relative to `public/`: every file there
 * minus the shared set — each `public/*.ts`, and the closure of the `@/lib/core/*`
 * modules `web/src` names, through their own relative imports.
 */
export function oldUiPublicFiles(root: string): string[] {
  const all = walk(root, 'public').map((f) => f.slice('public/'.length));
  const shared = new Set(all.filter((f) => !f.includes('/') && f.endsWith('.ts')));
  const queue: string[] = [];
  for (const f of walk(root, 'web/src').filter((f) => /\.tsx?$/.test(f))) {
    for (const s of sourceStrings(f, read(root, f)).strings) {
      if (s.startsWith(LIB_CORE)) queue.push(path.posix.normalize(s.slice(LIB_CORE.length)));
    }
  }
  while (queue.length) {
    const f = queue.pop()!;
    if (shared.has(f) || !all.includes(f)) continue;
    shared.add(f);
    for (const spec of sourceStrings(`public/${f}`, read(root, `public/${f}`)).imports) {
      if (spec.startsWith('./') || spec.startsWith('../')) queue.push(path.posix.join(path.posix.dirname(f), spec));
    }
  }
  return all.filter((f) => !shared.has(f));
}

/** Whether one file's strings reference old-UI-only file `x` (§ the criterion's two forms). */
function references(strings: string[], x: string): boolean {
  const mentionsPublic = strings.some((s) => s === 'public' || s.endsWith('/public') || s.endsWith('/public/') || s.includes('public/'));
  return strings.some((s) => s === `public/${x}` || s.endsWith(`/public/${x}`)
    || (mentionsPublic && !s.includes('web/') && (s === x || s.endsWith(`/${x}`))));
}

/**
 * The old-UI test files, sorted, repo-relative: each top-level `tests/*.test.mjs`
 * that references an old-UI-only `public/` file itself or through the
 * `tests/*.mjs` helpers it imports, plus every `web/e2e/legacy/**\/*.spec.ts`.
 */
export function oldUiInventory(root: string): string[] {
  const old = oldUiPublicFiles(root);
  const cache = new Map<string, { strings: string[]; imports: string[] }>();
  const scan = (rel: string) => {
    let hit = cache.get(rel);
    if (!hit) cache.set(rel, hit = sourceStrings(rel, read(root, rel)));
    return hit;
  };
  const reachesOld = (start: string): boolean => {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length) {
      const rel = queue.pop()!;
      if (seen.has(rel)) continue;
      seen.add(rel);
      const { strings, imports } = scan(rel);
      if (old.some((x) => references(strings, x))) return true;
      for (const spec of imports) {
        if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
        const dep = path.posix.join(path.posix.dirname(rel), spec);
        if (path.posix.dirname(dep) === 'tests' && dep.endsWith('.mjs') && fs.existsSync(path.join(root, dep))) queue.push(dep);
      }
    }
    return false;
  };
  const tests = walk(root, 'tests').filter((f) => /^tests\/[^/]+\.test\.mjs$/.test(f) && reachesOld(f));
  const legacy = walk(root, 'web/e2e/legacy').filter((f) => f.endsWith('.spec.ts'));
  return [...tests, ...legacy].sort();
}
