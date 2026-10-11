// @vitest-environment node
// The parity ledger's gate (`the ledger`) and the fixture tests for the three
// modules behind it: the old-UI inventory, the static title resolver and the
// ledger check. Every fixture asserts the exact result, so a check that drops
// or misnames a problem fails here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { oldUiInventory, oldUiPublicFiles } from '../../../tests/web-parity/inventory.ts';
import { parityLinks, testTitles } from '../../../tests/web-parity/titles.ts';
import { buildWorld, checkLedger, type LedgerData, type Problem, type World } from '../../../tests/web-parity/check.ts';
import { LEDGER, RULINGS, SURVIVES, type Row, type TestRef } from '../../../tests/web-parity/ledger.ts';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

/** A scratch repo root holding exactly `files`. */
function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-parity-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

// public/: old.js and vendor/lib.js are old-UI-only; shared.js is imported by
// web/src through the alias and pulls in dep.js; typed.ts is a shared .ts module.
const PUBLIC = {
  'public/old.js': 'export const x = 1;\n',
  'public/vendor/lib.js': 'export const v = 1;\n',
  'public/shared.js': "import { d } from './dep.js';\nexport const y = d;\n",
  'public/dep.js': 'export const d = 1;\n',
  'public/typed.ts': 'export const t = 1;\n',
  'web/src/a.ts': "import { y } from '@/lib/core/shared.js';\nexport const z = y;\n",
};

describe('inventory', () => {
  it('the old-UI-only public files are every public file minus the .ts modules and the @/lib/core closure', () => {
    expect(oldUiPublicFiles(tree(PUBLIC))).toEqual(['old.js', 'vendor/lib.js']);
  });

  it('a test naming public/<old>.js in a string is inventoried', () => {
    const root = tree({
      ...PUBLIC,
      'tests/a.test.mjs': "const p = 'public/old.js';\n",
      'tests/b.test.mjs': "import { x } from '../public/old.js';\n",
      'tests/c.test.mjs': "const p = 'public/vendor/lib.js';\n",
      'tests/nested/d.test.mjs': "const p = 'public/old.js';\n",
      'tests/e.test.mjs': "const p = 'src/old.js';\n",
    });
    expect(oldUiInventory(root)).toEqual(['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/c.test.mjs']);
  });

  it('a test reaching an old file only through an imported tests/ helper is inventoried, and the helper itself is not', () => {
    const root = tree({
      ...PUBLIC,
      'tests/c.test.mjs': "import './h1.mjs';\n",
      'tests/h1.mjs': "export * from './h2.mjs';\n",
      'tests/h2.mjs': "export const f = '../public/old.js';\n",
      'tests/d.test.mjs': "await import('./h3.mjs');\n",
      'tests/h3.mjs': "export const f = 'public/old.js';\n",
      'tests/e.test.mjs': "import { c } from './clean.mjs';\n",
      'tests/clean.mjs': "export const c = 'nothing';\n",
    });
    expect(oldUiInventory(root)).toEqual(['tests/c.test.mjs', 'tests/d.test.mjs']);
  });

  it('a test naming only a module web/src imports via @/lib/core is not inventoried, nor one naming that module\'s own relative import', () => {
    const root = tree({
      ...PUBLIC,
      'tests/shared.test.mjs': "import { y } from '../public/shared.js';\n",
      'tests/dep.test.mjs': "const p = 'public/dep.js';\n",
      'tests/ctl.test.mjs': "const p = 'public/old.js';\n",
    });
    expect(oldUiInventory(root)).toEqual(['tests/ctl.test.mjs']);
  });

  it('a test naming a public/*.ts module is not inventoried', () => {
    const root = tree({
      ...PUBLIC,
      'tests/typed.test.mjs': "import { t } from '../public/typed.ts';\n",
      'tests/ctl.test.mjs': "const p = 'public/old.js';\n",
    });
    expect(oldUiInventory(root)).toEqual(['tests/ctl.test.mjs']);
  });

  it('a mention inside a comment does not inventory a test', () => {
    const root = tree({
      ...PUBLIC,
      'tests/comment.test.mjs': "// public/old.js\n/* import '../public/old.js'; */\nconst a = 1;\n",
      'tests/ctl.test.mjs': "const p = 'public/old.js';\n",
    });
    expect(oldUiInventory(root)).toEqual(['tests/ctl.test.mjs']);
  });

  it("path.join(ROOT, 'public', 'old.js') is inventoried; a bare 'old.js' in a file that never mentions public is not", () => {
    const root = tree({
      ...PUBLIC,
      'tests/join.test.mjs': "import path from 'node:path';\nconst p = path.join(ROOT, 'public', 'old.js');\n",
      'tests/pub.test.mjs': "const PUB = `${ROOT}/public/`;\nconst p = path.join(PUB, 'old.js');\n",
      'tests/pubdir.test.mjs': "const PUB = ROOT + '/public';\nconst p = PUB + '/vendor/lib.js';\n",
      'tests/bare.test.mjs': "const p = 'old.js';\n",
      'tests/web.test.mjs': "const a = 'public';\nconst p = 'web/src/old.js';\n",
    });
    expect(oldUiInventory(root)).toEqual(['tests/join.test.mjs', 'tests/pub.test.mjs', 'tests/pubdir.test.mjs']);
  });

  it('a .ts file nested under public/ is not shared: a test naming it is inventoried', () => {
    const root = tree({
      ...PUBLIC,
      'public/sub/nested.ts': 'export const n = 1;\n',
      'tests/nested.test.mjs': "const p = 'public/sub/nested.ts';\n",
    });
    expect(oldUiPublicFiles(root)).toEqual(['old.js', 'sub/nested.ts', 'vendor/lib.js']);
    expect(oldUiInventory(root)).toEqual(['tests/nested.test.mjs']);
  });

  it("a string exactly 'public/X' inventories a test where no other form can: X under a web/ directory", () => {
    // 'public/web/page.js' contains web/, so the bare-name form is excluded, and
    // it has no leading slash, so it does not end with '/public/web/page.js'.
    const root = tree({
      ...PUBLIC,
      'public/web/page.js': 'export const w = 1;\n',
      'tests/direct.test.mjs': "const p = 'public/web/page.js';\n",
    });
    expect(oldUiInventory(root)).toEqual(['tests/direct.test.mjs']);
  });

  it("a string containing public/ counts as a mention of public for a bare name in another string", () => {
    const root = tree({
      ...PUBLIC,
      'tests/mention.test.mjs': "const dir = 'public/assets-dir';\nconst p = 'old.js';\n",
      'tests/bare.test.mjs': "const p = 'old.js';\n",
    });
    expect(oldUiInventory(root)).toEqual(['tests/mention.test.mjs']);
  });

  it('every web/e2e/legacy/**/*.spec.ts is inventoried; other web/e2e specs are not', () => {
    const root = tree({
      ...PUBLIC,
      'web/e2e/legacy/a.spec.ts': "test('a', () => {});\n",
      'web/e2e/legacy/sub/b.spec.ts': "test('b', () => {});\n",
      'web/e2e/legacy/helper.ts': 'export const h = 1;\n',
      'web/e2e/other.spec.ts': "test('o', () => {});\n",
      'web/e2e/parity/p.spec.ts': "parity('r', 'p', async () => {});\n",
    });
    expect(oldUiInventory(root)).toEqual(['web/e2e/legacy/a.spec.ts', 'web/e2e/legacy/sub/b.spec.ts']);
  });
});

describe('titles', () => {
  it('nested describe/it, test.describe, it.skip, node:test t.test and .each(...) resolve to a > b full titles; a template title keeps its raw ${…} text', () => {
    const code = [
      "describe('a', () => {",
      "  it('b', () => {});",
      "  describe.skip('c', () => { test.only('d', async () => {}); });",
      "  it.each([1, 2])('e %s', (n) => {});",
      "  test.for([1])('l', () => {});",
      "  it.skip('f', function () {});",
      '});',
      "test.describe('g', () => { test.describe.serial('h', () => { test('i', async ({ page }) => {}); }); });",
      "test('j', async (t) => { await t.test('k', () => {}); });",
      'suite(\'s\', () => { it(`tmpl ${x} y`, () => {}); });',
    ].join('\n');
    expect(testTitles('tests/x.test.mjs', code)).toEqual([
      'a', 'a > b', 'a > c', 'a > c > d', 'a > e %s', 'a > l', 'a > f',
      'g', 'g > h', 'g > h > i', 'j', 'j > k', 's', 's > tmpl ${x} y',
    ]);
  });

  it('the filename picks the parser language', () => {
    const code = "const el = <div />;\nit('jsx', (): void => {});\n";
    expect(testTitles('web/src/x.test.tsx', code)).toEqual(['jsx']);
  });

  it('a one-hop wrapper resolves its titles and subtests; a wrapper of a wrapper and a helper passing a literal title make no wrapper', () => {
    const code = [
      'function wtest(name, fn) { test(name, async (t) => fn(t)); }',
      'const w = (n, f) => it(n, f);',
      'const wf = function (n, f) { describe(n, f); };',
      'function w2(n, f) { wtest(n, f); }',
      "function commit(m, f) { test('fixed', f); }",
      "wtest('W', async (t) => { await t.test('s', () => {}); });",
      "w('A', () => {});",
      "wf('F', () => { it('g', () => {}); });",
      "w2('x', () => {});",
      "commit('y', () => {});",
    ].join('\n');
    expect(testTitles('tests/x.test.mjs', code)).toEqual(['fixed', 'W', 'W > s', 'A', 'F', 'F > g']);
  });

  it("a function whose inner test call passes something other than its own first parameter is no wrapper", () => {
    const code = [
      'function f(name, fn) { test(other, fn); }',
      "f('x', () => {});",
      "test('t', () => {});",
    ].join('\n');
    expect(testTitles('tests/x.test.mjs', code)).toEqual(['t']);
  });

  it('a non-string first argument adds no level; test.describe.configure, test.use, test.step, test.skip(cond, msg) and test.todo add no title', () => {
    const code = [
      "describe(label, () => { it('x', () => {}); });",
      "test.describe.configure({ mode: 'serial' });",
      'test.use({ viewport: null });',
      "test('outer', async () => { await test.step('step', async () => {}); });",
      "test.skip(cond, 'msg');",
      "test.todo('t');",
    ].join('\n');
    expect(testTitles('web/e2e/x.spec.ts', code)).toEqual(['x', 'outer']);
  });

  it("parity('row', 'T', fn) yields its two halves under the enclosing describes and a literal call; non-literal arguments are recorded as null", () => {
    const code = [
      "describe('D', () => { parity('row', 'T', async () => {}); });",
      "parity(id, 'U', async () => {});",
      "parity('row2', name, async () => {});",
    ].join('\n');
    expect(testTitles('web/e2e/parity/x.spec.ts', code)).toEqual([
      'D', 'D > T > legacy', 'D > T > next', 'U > legacy', 'U > next',
    ]);
    expect(parityLinks('web/e2e/parity/x.spec.ts', code)).toEqual([
      { rowId: 'row', title: 'T' }, { rowId: null, title: 'U' }, { rowId: 'row2', title: null },
    ]);
  });
});

// A consistent fixture: one whole-file row, a file split into an explicit
// ported row and a 'rest' row, a mixed file with a dropped row and a SURVIVES
// title, and a docs row. Each test below changes one thing.
const OLD = 'tests/old.test.mjs';
const SPLIT = 'tests/split.test.mjs';
const MIXED = 'tests/mixed.test.mjs';
const NEW = 'web/src/x.test.ts';
const PAR = 'web/e2e/parity/a.spec.ts';
const TITLES: Record<string, string[]> = {
  [OLD]: ['o1'],
  [SPLIT]: ['s1', 's2', 's3'],
  [MIXED]: ['m-old', 'm-server'],
  [NEW]: ['n', 'n > a', 'n > b'],
  [PAR]: ['P > legacy', 'P > next'],
  'tests/shared.test.mjs': ['sh'],
  'web/e2e/legacy/a.spec.ts': ['t'],
  'web/src/x.ts': ['foo'],
};

function data(): LedgerData {
  const ledger: Row<string>[] = [
    { id: 'old/R1', old: { file: OLD }, behaviour: 'b', viewports: ['desktop'], area: 'header', status: { kind: 'missing' } },
    {
      id: 'split/R1', old: { file: SPLIT, tests: ['s1'] }, behaviour: 'b', viewports: ['desktop', 'phone'], area: 'sidebar',
      status: { kind: 'ported', by: [`${NEW}::n > a`, `${PAR}::P > next`, 'tests/shared.test.mjs::sh', `${MIXED}::m-server`] },
    },
    { id: 'split/R2', old: { file: SPLIT, tests: 'rest' }, behaviour: 'b', viewports: ['phone'], area: 'sidebar', status: { kind: 'regressed', evidence: 'e' } },
    { id: 'mixed/R1', old: { file: MIXED, tests: ['m-old'] }, behaviour: 'b', viewports: ['desktop'], area: 'views', status: { kind: 'dropped', ruling: 'r1' } },
    { id: 'doc/X', old: { doc: 'docs/features.md', section: 'UI elements' }, behaviour: 'b', viewports: ['desktop'], area: 'composer', status: { kind: 'missing' } },
  ];
  return {
    ledger,
    survives: [{ file: MIXED, tests: ['m-server'], note: 'server' }],
    rulings: { r1: { date: '2026-10-01', ruling: 'drop it' } },
  };
}

function world(over: Partial<World> = {}): World {
  return {
    inventory: [MIXED, OLD, SPLIT],
    titlesOf: (f) => TITLES[f] ?? null,
    parityCalls: [{ file: PAR, rowId: 'split/R1', title: 'P' }],
    featureSections: new Set(['UI elements', 'Plugins']),
    ...over,
  };
}

/** `data()` with one change applied to its row `id`. */
function withRow(id: string, change: (r: Row<string>) => Row<string>): LedgerData {
  const d = data();
  return { ...d, ledger: d.ledger.map((r) => (r.id === id ? change(r) : r)) };
}
const ported = (...by: string[]) => ({ kind: 'ported' as const, by: by as unknown as readonly [TestRef, ...TestRef[]] });

describe('checkLedger', () => {
  it('a consistent fixture ledger has no problems', () => {
    expect(checkLedger(data(), world())).toEqual([]);
  });

  it('an inventory file with no row is unaccounted', () => {
    expect(checkLedger(data(), world({ inventory: [MIXED, OLD, SPLIT, 'tests/new.test.mjs'] }))).toEqual([
      { kind: 'unaccounted', subject: 'tests/new.test.mjs', detail: 'no ledger row names this old-UI test file' },
    ]);
  });

  it('a row naming a file outside the inventory is a stale row', () => {
    const d = data();
    d.ledger = [...d.ledger, { ...d.ledger[0], id: 'typo/R1', old: { file: 'tests/typo.test.mjs' } }];
    expect(checkLedger(d, world())).toEqual([
      { kind: 'stale-row', subject: 'typo/R1', detail: 'tests/typo.test.mjs is not an old-UI test file' },
    ]);
  });

  it('a ref whose title or file is absent is unresolved', () => {
    const title = withRow('split/R1', (r) => ({ ...r, status: ported(`${NEW}::n > zz`) }));
    expect(checkLedger(title, world())).toEqual([
      { kind: 'unresolved-ref', subject: 'split/R1', detail: `${NEW}::n > zz: no such test title` },
    ]);
    const file = withRow('split/R1', (r) => ({ ...r, status: ported('web/src/gone.test.ts::n > a') }));
    expect(checkLedger(file, world())).toEqual([
      { kind: 'unresolved-ref', subject: 'split/R1', detail: 'web/src/gone.test.ts::n > a: no such file' },
    ]);
  });

  it('a ref that is not a new-UI guard is a bad ref, one case per reason; a ref to a SURVIVES title is accepted', () => {
    const cases: [string, string][] = [
      [`${NEW} n > a`, 'no "::" between file and title'],
      ['web/src/x.ts::foo', 'not a test file'],
      ['web/e2e/legacy/a.spec.ts::t', 'an old-UI legacy spec'],
      [`${MIXED}::m-old`, 'an old-UI test file, and the title is not in its SURVIVES'],
      [`${PAR}::P > legacy`, "the old UI's half of a parity scenario"],
    ];
    for (const [ref, reason] of cases) {
      const d = withRow('split/R1', (r) => ({ ...r, status: ported(ref) }));
      expect(checkLedger(d, world()), ref).toEqual([{ kind: 'bad-ref', subject: 'split/R1', detail: `${ref}: ${reason}` }]);
    }
    const ok = withRow('split/R1', (r) => ({ ...r, status: ported(`${MIXED}::m-server`) }));
    expect(checkLedger(ok, world())).toEqual([]);
  });

  it('a dropped row needs a recorded ruling with text and a real YYYY-MM-DD date', () => {
    const nope = withRow('mixed/R1', (r) => ({ ...r, status: { kind: 'dropped', ruling: 'nope' } }));
    expect(checkLedger(nope, world())).toEqual([
      { kind: 'unruled-drop', subject: 'mixed/R1', detail: 'ruling "nope" is not recorded' },
    ]);
    const bad = (ruling: { date: string; ruling: string }) => ({ ...data(), rulings: { r1: ruling } });
    expect(checkLedger(bad({ date: '2026-10-01', ruling: '  ' }), world())).toEqual([
      { kind: 'unruled-drop', subject: 'mixed/R1', detail: 'ruling "r1" has no text' },
    ]);
    for (const date of ['2026-13-01', '2026-02-30', 'yesterday']) {
      expect(checkLedger(bad({ date, ruling: 'drop it' }), world()), date).toEqual([
        { kind: 'unruled-drop', subject: 'mixed/R1', detail: 'ruling "r1" has no valid YYYY-MM-DD date' },
      ]);
    }
    expect(checkLedger(bad({ date: '2024-02-29', ruling: 'drop it' }), world())).toEqual([]);
  });

  it('a parity call whose row id or title is not a literal is a bad parity call, one case each', () => {
    expect(checkLedger(data(), world({ parityCalls: [{ file: PAR, rowId: null, title: 'P' }] }))).toEqual([
      { kind: 'bad-parity-call', subject: PAR, detail: 'the row id is not a literal' },
    ]);
    expect(checkLedger(data(), world({ parityCalls: [{ file: PAR, rowId: 'split/R1', title: null }] }))).toEqual([
      { kind: 'bad-parity-call', subject: PAR, detail: 'the title is not a literal' },
    ]);
  });

  it('two rows with one id are a duplicate id', () => {
    const d = data();
    d.ledger = [...d.ledger, { ...d.ledger[4], id: 'old/R1' }];
    expect(checkLedger(d, world())).toEqual([{ kind: 'duplicate-id', subject: 'old/R1', detail: '2 rows share this id' }]);
  });

  it('a row with an empty id is reported by its position, and is no duplicate of another empty id', () => {
    const d = data();
    d.ledger = [...d.ledger, { ...d.ledger[4], id: '' }, { ...d.ledger[4], id: '' }];
    expect(checkLedger(d, world())).toEqual([
      { kind: 'empty-id', subject: 'LEDGER[5]', detail: 'the row id is empty' },
      { kind: 'empty-id', subject: 'LEDGER[6]', detail: 'the row id is empty' },
    ]);
  });

  it('every SURVIVES entry is validated, whether or not its file has a row', () => {
    const lone = 'tests/lone.test.mjs';
    const titles = (f: string) => (f === lone ? ['l1'] : TITLES[f] ?? null);
    const missingTitle = { ...data(), survives: [...data().survives, { file: lone, tests: ['l1', 'zz'], note: 'n' }] };
    expect(checkLedger(missingTitle, world({ inventory: [lone, MIXED, OLD, SPLIT], titlesOf: titles }))).toEqual([
      { kind: 'unaccounted', subject: lone, detail: 'no ledger row names this old-UI test file' },
      { kind: 'partition', subject: lone, detail: 'SURVIVES lists "zz", which is not a title of this file' },
    ]);
    const stale = { ...data(), survives: [...data().survives, { file: 'tests/gone.test.mjs', tests: ['g'], note: 'n' }] };
    expect(checkLedger(stale, world())).toEqual([
      { kind: 'stale-survivor', subject: 'tests/gone.test.mjs', detail: 'SURVIVES names a file that is not an old-UI test file' },
    ]);
  });

  it('a file with one whole-file row and a SURVIVES entry is split, so the row omitting tests is a partition problem', () => {
    const d = { ...data(), survives: [...data().survives, { file: OLD, tests: ['o1'], note: 'n' }] };
    expect(checkLedger(d, world())).toEqual([
      { kind: 'partition', subject: OLD, detail: 'old/R1 omits tests in a split file' },
    ]);
  });

  it('partition: each break of the granularity rule is reported, one case each; a rest row completes the cover', () => {
    const cases: [string, LedgerData, Problem][] = [
      ['a row of a split file omits tests',
        withRow('split/R2', (r) => ({ ...r, old: { file: SPLIT } })),
        { kind: 'partition', subject: SPLIT, detail: 'split/R2 omits tests in a split file' }],
      ['two rest rows',
        (() => { const d = data(); d.ledger = [...d.ledger, { ...d.ledger[2], id: 'split/R3' }]; return d; })(),
        { kind: 'partition', subject: SPLIT, detail: "more than one 'rest' row: split/R2, split/R3" }],
      ['a listed title not in the file',
        withRow('split/R1', (r) => ({ ...r, old: { file: SPLIT, tests: ['s1', 'zz'] } })),
        { kind: 'partition', subject: SPLIT, detail: 'split/R1 lists "zz", which is not a title of this file' }],
      ['a SURVIVES title not in the file',
        { ...data(), survives: [{ file: MIXED, tests: ['m-server', 'zz'], note: 'n' }] },
        { kind: 'partition', subject: MIXED, detail: 'SURVIVES lists "zz", which is not a title of this file' }],
      ['a ported row using rest',
        (() => {
          const d = data();
          d.ledger = d.ledger.map((r) => r.id === 'split/R1' ? { ...r, old: { file: SPLIT, tests: 'rest' as const } }
            : r.id === 'split/R2' ? { ...r, old: { file: SPLIT, tests: ['s2', 's3'] } } : r);
          return d;
        })(),
        { kind: 'partition', subject: SPLIT, detail: 'split/R1 is ported but does not list its titles' }],
      ['a ported whole-file row',
        withRow('old/R1', (r) => ({ ...r, status: ported(`${NEW}::n > b`) })),
        { kind: 'partition', subject: OLD, detail: 'old/R1 is ported but does not list its titles' }],
      ['a SURVIVES title also in a row',
        withRow('mixed/R1', (r) => ({ ...r, old: { file: MIXED, tests: ['m-old', 'm-server'] } })),
        { kind: 'partition', subject: MIXED, detail: '"m-server" is in SURVIVES and in mixed/R1' }],
      ['explicit rows not covering every title',
        withRow('split/R2', (r) => ({ ...r, old: { file: SPLIT, tests: ['s2'] } })),
        { kind: 'partition', subject: SPLIT, detail: 'titles in no row: "s3"' }],
    ];
    for (const [name, d, problem] of cases) expect(checkLedger(d, world()), name).toEqual([problem]);
    const restCovers = withRow('split/R2', (r) => ({ ...r, old: { file: SPLIT, tests: ['s2', 's3'] } }));
    expect(checkLedger(restCovers, world())).toEqual([]);
  });

  it('a docs row whose section is not a ### heading is an unknown section', () => {
    const d = withRow('doc/X', (r) => ({ ...r, old: { doc: 'docs/features.md', section: 'Nope' } }));
    expect(checkLedger(d, world())).toEqual([
      { kind: 'unknown-section', subject: 'doc/X', detail: 'no "### Nope" heading in docs/features.md' },
    ]);
  });

  it('a parity link to an unknown row is an unknown parity row', () => {
    expect(checkLedger(data(), world({ parityCalls: [{ file: PAR, rowId: 'nope/R1', title: 'P' }] }))).toEqual([
      { kind: 'unknown-parity-row', subject: PAR, detail: "parity('nope/R1') names no ledger row" },
    ]);
  });
});

describe('buildWorld', () => {
  it('reads the inventory, titles on demand, the parity specs and the features headings from the tree', () => {
    const root = tree({
      ...PUBLIC,
      'tests/a.test.mjs': "test('one', () => {});\nconst p = 'public/old.js';\n",
      'web/src/n.test.ts': "describe('n', () => { it('a', () => {}); });\n",
      'web/e2e/parity/s.spec.ts': "parity('a/R1', 'T', async () => {});\n",
      'web/e2e/parity/helper.ts': "parity('skip/R1', 'H', async () => {});\n",
      'docs/features.md': '# F\n\n### UI elements\n\ntext ### Not a heading\n#### Deeper\n### Plugins\n',
    });
    const w = buildWorld(root);
    expect(w.inventory).toEqual(['tests/a.test.mjs']);
    expect(w.titlesOf('tests/a.test.mjs')).toEqual(['one']);
    expect(w.titlesOf('web/src/n.test.ts')).toEqual(['n', 'n > a']);
    expect(w.titlesOf('web/src/gone.test.ts')).toBe(null);
    expect(w.parityCalls).toEqual([{ file: 'web/e2e/parity/s.spec.ts', rowId: 'a/R1', title: 'T' }]);
    expect([...w.featureSections]).toEqual(['UI elements', 'Plugins']);
  });
});

describe('the ledger', () => {
  it('accounts for every old-UI test, resolves every ported ref and records a ruling for every drop', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const problems = checkLedger({ ledger: LEDGER, survives: SURVIVES, rulings: RULINGS }, buildWorld(root));
    expect(problems, problems.map((p) => `${p.kind} ${p.subject}: ${p.detail}`).join('\n')).toEqual([]);
    // One synchronous parse of the whole tree: a few seconds alone, far more
    // under a loaded full run, so it outgrows vitest's default.
  }, 30_000);
});
