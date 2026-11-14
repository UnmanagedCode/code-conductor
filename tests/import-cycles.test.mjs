import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASELINE, buildGraph, compareToBaseline, runtimeSpecifiers, scanTree, sccEdges, stronglyConnected,
} from './importCycles.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('runtimeSpecifiers counts the import forms Node keeps', async (t) => {
  const counted = {
    named: "import { a } from './x.ts';",
    'default + named': "import d, { a } from './x.ts';",
    namespace: "import * as ns from './x.ts';",
    'side effect': "import './x.ts';",
    'export *': "export * from './x.ts';",
    'export * as': "export * as ns from './x.ts';",
    'export {x} from': "export { x } from './x.ts';",
    'multi-line named': "import {\n  a,\n  b,\n} from './x.ts';",
    'all-inline type specifiers': "import { type T } from './x.ts';",
    'mixed inline type': "import { type T, v } from './x.ts';",
  };
  for (const [name, src] of Object.entries(counted)) {
    await t.test(`counts ${name}`, () => {
      assert.deepEqual(runtimeSpecifiers(src), { static: ['./x.ts'], dynamic: [] });
    });
  }
  const excluded = {
    'import type': "import type { T } from './x.ts';",
    'multi-line import type': "import type {\n  A,\n} from './x.ts';",
    'export type {}': "export type { T } from './x.ts';",
    'export type *': "export type * from './x.ts';",
    'line comment': "// import { x } from './c.ts';",
    'block comment': "/*\n import { x } from './c.ts';\n*/",
    'template literal body': "const s = `\nimport { x } from './t.ts';\n`;",
    'mid-line string': "const s = \"import { x } from './s.ts'\";",
  };
  for (const [name, src] of Object.entries(excluded)) {
    await t.test(`excludes ${name}`, () => {
      assert.deepEqual(runtimeSpecifiers(src), { static: [], dynamic: [] });
    });
  }
  await t.test('dynamic import is reported separately', () => {
    assert.deepEqual(runtimeSpecifiers("const m = await import('./d.ts');"), { static: [], dynamic: ['./d.ts'] });
  });
});

test('buildGraph resolves specifiers to exact scanned paths', async (t) => {
  const src = (body) => new Map([['fx/src/a.ts', body], ['fx/src/b.ts', ''], ['fx/shared/x.ts', '']]);
  await t.test('relative edges resolve across directories', () => {
    const g = buildGraph(src("import { x } from '../shared/x.ts';\nimport './b.ts';"));
    assert.deepEqual([...g.get('fx/src/a.ts')].sort(), ['fx/shared/x.ts', 'fx/src/b.ts']);
  });
  await t.test('node: and bare packages give no edge', () => {
    const g = buildGraph(src("import fs from 'node:fs';\nimport express from 'express';"));
    assert.equal(g.get('fx/src/a.ts').size, 0);
  });
  await t.test('a dynamic-only import gives no edge', () => {
    const g = buildGraph(src("await import('./b.ts');"));
    assert.equal(g.get('fx/src/a.ts').size, 0);
  });
  await t.test('a relative specifier naming no file throws, naming file and specifier', () => {
    assert.throws(() => buildGraph(src("import './missing.ts';")), /fx\/src\/a\.ts.*\.\/missing\.ts/s);
  });
  await t.test('a .js specifier for a .ts file throws', () => {
    assert.throws(() => buildGraph(src("import './b.js';")), /\.\/b\.js/);
  });
  await t.test('@shared specifiers throw', () => {
    assert.throws(() => buildGraph(src("import { x } from '@shared/x.ts';")), /@shared\/x\.ts/);
  });
});

test('stronglyConnected reports multi-member components and self-edges only', () => {
  const g = new Map([
    ['a', new Set(['b'])], ['b', new Set(['a'])],
    ['c', new Set(['d'])], ['d', new Set()],
    ['e', new Set(['e'])],
  ]);
  assert.deepEqual(stronglyConnected(g), [['a', 'b'], ['e']]);
  assert.deepEqual(sccEdges(g, ['a', 'b']), ['a -> b', 'b -> a']);
});

test('compareToBaseline ratchet', async (t) => {
  await t.test('a cycle outside the baseline is a "new cycle" violation', () => {
    const r = compareToBaseline([['a', 'b']], []);
    assert.equal(r.violations.length, 1);
    assert.match(r.violations[0], /new cycle/);
  });
  await t.test('a baseline SCC that grew is a violation', () => {
    const r = compareToBaseline([['a', 'b', 'c', 'd']], [['a', 'b', 'c']]);
    assert.equal(r.violations.length, 1);
    assert.match(r.violations[0], /grew or merged/);
  });
  await t.test('two baseline SCCs merged is a violation', () => {
    const r = compareToBaseline([['a', 'b', 'c', 'd']], [['a', 'b'], ['c', 'd']]);
    assert.equal(r.violations.length, 1);
  });
  await t.test('a shrunk SCC is no violation but leaves a stale entry', () => {
    const r = compareToBaseline([['a', 'b']], [['a', 'b', 'c']]);
    assert.deepEqual(r.violations, []);
    assert.equal(r.stale.length, 1);
  });
  await t.test('equal sets are clean', () => {
    assert.deepEqual(compareToBaseline([['a', 'b']], [['a', 'b']]), { violations: [], stale: [] });
  });
});

test('the real server tree has no import cycle beyond BASELINE', () => {
  const { graph, sccs } = scanTree(repoRoot);
  const { violations, stale } = compareToBaseline(sccs, BASELINE, graph);
  assert.deepEqual(violations, [], 'import cycle outside BASELINE — run `node tests/importCycles.mjs` to read the SCCs; break it with a leaf module');
  assert.deepEqual(stale, [], 'BASELINE is stale — run `node tests/importCycles.mjs` and copy the current SCCs into BASELINE');
  // positive control: the scan sees real edges
  assert.ok(graph.get('src/instances.ts').has('src/backgroundJobs.ts'));
});
