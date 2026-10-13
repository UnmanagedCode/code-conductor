// The web build needs no devDependency: every package web/vite.config.ts and the
// modules Vite bundles import is a `dependencies` key of package.json. The
// bundled modules are found by walking the import graph from web/index.html's
// module scripts — through relative paths and the `@/` / `@shared/` aliases —
// so a test helper that only tests import is not counted. The container
// installs with `npm install --omit=dev`, so a devDependency imported here would
// fail the build on exactly that host. Type-only imports are erased before
// bundling and are exempt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const WEB = path.join(ROOT, 'web');

// The bare specifiers a file imports at runtime: static (minus `import type` /
// `export type`), side-effect, dynamic, and CSS `@import`.
function runtimeSpecifiers(src) {
  const out = [];
  for (const m of src.matchAll(/^\s*(?:import|export)\s+(type\s)?[^'";]*?\sfrom\s*['"]([^'"]+)['"]/gm)) if (!m[1]) out.push(m[2]);
  for (const m of src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) out.push(m[1]);
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  for (const m of src.matchAll(/^\s*@import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]);
  return out;
}

// The package a bare specifier resolves into, or null for a relative path, an
// alias (`@/`, `@shared/`) or a node builtin.
function packageOf(spec) {
  if (/^(\.|\/|@\/|@shared\/|node:)/.test(spec) || builtinModules.includes(spec.split('/')[0])) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// The file a non-package specifier imported from `from` loads, or null for a
// package. Throws on one it cannot find, so a resolver gap fails loudly instead
// of shrinking the graph.
function resolveLocal(spec, from) {
  const bare = spec.replace(/\?.*$/, '');
  let base;
  if (bare.startsWith('@/')) base = path.join(WEB, 'src', bare.slice(2));
  else if (bare.startsWith('@shared/')) base = path.join(ROOT, 'shared', bare.slice('@shared/'.length));
  else if (bare.startsWith('.')) base = path.resolve(path.dirname(from), bare);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  throw new Error(`cannot resolve ${spec} from ${path.relative(ROOT, from)}`);
}

test('the specifier scan reads each import form and skips type-only imports', () => {
  const src = [
    "import { a } from 'pkg-a';",
    "import type { T } from 'types-only';",
    "import {\n  b,\n  c,\n} from '@scope/pkg-b/sub';",
    "export { d } from 'pkg-d';",
    "export type { U } from 'types-too';",
    "import 'side-effect';",
    "const m = await import('dyn');",
    "@import 'css-pkg';",
    "import x from './local';",
  ].join('\n');
  assert.deepEqual(runtimeSpecifiers(src).map(packageOf).filter(Boolean).sort(),
    ['@scope/pkg-b', 'css-pkg', 'dyn', 'pkg-a', 'pkg-d', 'side-effect']);
  assert.deepEqual(['@/x', '@shared/y', './z', 'node:fs', 'path'].map(packageOf), [null, null, null, null, null]);
});

test('every package the web build imports is a runtime dependency, never a devDependency', () => {
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const entries = [...html.matchAll(/<script\s+type="module"\s+src="\/([^"]+)"/g)].map((m) => path.join(WEB, m[1]));
  assert.ok(entries.length > 0, 'fixture check: index.html names a module entry');
  const seen = new Set();
  const used = new Map();
  const queue = [path.join(WEB, 'vite.config.ts'), ...entries];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(tsx?|css)$/.test(file)) continue;
    for (const spec of runtimeSpecifiers(fs.readFileSync(file, 'utf8'))) {
      const name = packageOf(spec);
      if (name) { if (!used.has(name)) used.set(name, path.relative(ROOT, file)); continue; }
      if (spec.startsWith('node:')) continue;
      const local = resolveLocal(spec, file);
      if (local) queue.push(local);
    }
  }
  for (const known of ['vite', 'react', '@vitejs/plugin-react', 'tailwindcss', 'sonner']) {
    assert.ok(used.has(known), `fixture check: the scan finds ${known}`);
  }
  assert.ok([...seen].some((f) => f.startsWith(path.join(ROOT, 'shared'))), 'fixture check: the walk reaches shared/ through @shared/');
  assert.ok(![...seen].some((f) => /\.test\.tsx?$/.test(f)), 'fixture check: no test file is bundled');
  const missing = [...used].filter(([name]) => !(name in (pkg.dependencies ?? {}))).map(([name, file]) => `${name} (${file})`);
  assert.deepEqual(missing, []);
});
