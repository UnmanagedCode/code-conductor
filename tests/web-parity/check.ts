// The ledger check: proves tests/web-parity/ledger.ts accounts for every old-UI
// test file, every ported ref names a real new-UI test, every split file is
// partitioned exactly, and every drop carries a recorded user ruling.
import fs from 'node:fs';
import path from 'node:path';
import { oldUiInventory } from './inventory.ts';
import { parityLinks, testTitles } from './titles.ts';
import type { Row, Ruling, Survivor } from './ledger.ts';

export type ProblemKind = 'unaccounted' | 'stale-row' | 'bad-ref' | 'unresolved-ref' | 'unruled-drop' | 'duplicate-id'
  | 'partition' | 'unknown-section' | 'unknown-parity-row' | 'bad-parity-call';
export type Problem = { kind: ProblemKind; subject: string; detail: string };

export type LedgerData = {
  ledger: readonly Row<string>[];
  survives: readonly Survivor[];
  rulings: Readonly<Record<string, Ruling>>;
};

export type ParityCall = { file: string; rowId: string | null; title: string | null };

export type World = {
  /** The old-UI test files (inventory.ts). */
  inventory: readonly string[];
  /** A test file's full titles; null when there is no such file. */
  titlesOf(file: string): readonly string[] | null;
  parityCalls: readonly ParityCall[];
  /** The `### ` headings of docs/features.md. */
  featureSections: ReadonlySet<string>;
};

const TEST_FILE = [/^web\/src\/.+\.test\.tsx?$/, /^web\/e2e\/.+\.spec\.ts$/, /^tests\/[^/]+\.test\.mjs$/];
const LEGACY_SPECS = 'web/e2e/legacy/';
const PARITY_SPECS = 'web/e2e/parity';

/** The tree at `root`: the inventory, and titles read lazily per file. */
export function buildWorld(root: string): World {
  const memo = new Map<string, readonly string[] | null>();
  const titlesOf = (file: string) => {
    if (!memo.has(file)) {
      const abs = path.join(root, file);
      memo.set(file, fs.existsSync(abs) ? testTitles(file, fs.readFileSync(abs, 'utf8')) : null);
    }
    return memo.get(file)!;
  };
  const parityDir = path.join(root, PARITY_SPECS);
  const specs = fs.existsSync(parityDir) ? fs.readdirSync(parityDir).filter((f) => f.endsWith('.spec.ts')).sort() : [];
  const parityCalls = specs.flatMap((f) => {
    const file = `${PARITY_SPECS}/${f}`;
    return parityLinks(file, fs.readFileSync(path.join(root, file), 'utf8')).map((l) => ({ file, ...l }));
  });
  const features = fs.readFileSync(path.join(root, 'docs/features.md'), 'utf8');
  const featureSections = new Set([...features.matchAll(/^### (.+)$/gm)].map((m) => m[1]));
  return { inventory: oldUiInventory(root), titlesOf, parityCalls, featureSections };
}

/** Whether `date` is a calendar date written YYYY-MM-DD. */
function isRealDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

const fileOf = (r: Row<string>) => ('file' in r.old ? r.old : null);

/** Why `ref` is not a new-UI guard, or null when it may stand as one. */
function badRef(ref: string, data: LedgerData, world: World): string | null {
  const at = ref.indexOf('::');
  if (at < 0) return 'no "::" between file and title';
  const file = ref.slice(0, at);
  const title = ref.slice(at + 2);
  if (!TEST_FILE.some((re) => re.test(file))) return 'not a test file';
  if (file.startsWith(LEGACY_SPECS)) return 'an old-UI legacy spec';
  if (file.startsWith('tests/') && world.inventory.includes(file)
    && !data.survives.some((s) => s.file === file && s.tests.includes(title))) {
    return 'an old-UI test file, and the title is not in its SURVIVES';
  }
  if (world.parityCalls.some((c) => c.file === file && c.title !== null
    && (title === `${c.title} > legacy` || title.endsWith(` > ${c.title} > legacy`)))) {
    return "the old UI's half of a parity scenario";
  }
  return null;
}

export function checkLedger(data: LedgerData, world: World): Problem[] {
  const problems: Problem[] = [];
  const push = (kind: Problem['kind'], subject: string, detail: string) => problems.push({ kind, subject, detail });

  const ids = new Map<string, number>();
  for (const r of data.ledger) ids.set(r.id, (ids.get(r.id) ?? 0) + 1);
  for (const [id, n] of ids) if (n > 1) push('duplicate-id', id, `${n} rows share this id`);

  for (const row of data.ledger) {
    const src = fileOf(row);
    if (src && !world.inventory.includes(src.file)) push('stale-row', row.id, `${src.file} is not an old-UI test file`);
    if ('doc' in row.old && !world.featureSections.has(row.old.section)) {
      push('unknown-section', row.id, `no "### ${row.old.section}" heading in docs/features.md`);
    }
    const status = row.status;
    if (status.kind === 'ported') {
      for (const ref of status.by) {
        const bad = badRef(ref, data, world);
        if (bad) { push('bad-ref', row.id, `${ref}: ${bad}`); continue; }
        const at = ref.indexOf('::');
        const titles = world.titlesOf(ref.slice(0, at));
        if (titles === null) push('unresolved-ref', row.id, `${ref}: no such file`);
        else if (!titles.includes(ref.slice(at + 2))) push('unresolved-ref', row.id, `${ref}: no such test title`);
      }
    }
    if (status.kind === 'dropped') {
      const id = status.ruling;
      const ruling = Object.hasOwn(data.rulings, id) ? data.rulings[id] : undefined;
      if (!ruling) push('unruled-drop', row.id, `ruling "${id}" is not recorded`);
      else if (!ruling.ruling.trim()) push('unruled-drop', row.id, `ruling "${id}" has no text`);
      else if (!isRealDate(ruling.date)) push('unruled-drop', row.id, `ruling "${id}" has no valid YYYY-MM-DD date`);
    }
  }

  for (const file of world.inventory) {
    if (!data.ledger.some((r) => fileOf(r)?.file === file)) push('unaccounted', file, 'no ledger row names this old-UI test file');
  }

  const files = [...new Set(data.ledger.flatMap((r) => fileOf(r)?.file ?? []))];
  for (const file of files) {
    const rows = data.ledger.filter((r) => fileOf(r)?.file === file);
    const survivors = data.survives.filter((s) => s.file === file);
    for (const r of rows) {
      if (r.status.kind === 'ported' && !Array.isArray(fileOf(r)!.tests)) {
        push('partition', file, `${r.id} is ported but does not list its titles`);
      }
    }
    const split = rows.length > 1 || survivors.length > 0 || rows.some((r) => fileOf(r)!.tests !== undefined);
    const titles = world.titlesOf(file);
    if (!split || titles === null) continue;
    const rest = rows.filter((r) => fileOf(r)!.tests === 'rest');
    for (const r of rows) if (fileOf(r)!.tests === undefined) push('partition', file, `${r.id} omits tests in a split file`);
    if (rest.length > 1) push('partition', file, `more than one 'rest' row: ${rest.map((r) => r.id).join(', ')}`);
    const listed = new Set<string>();
    for (const r of rows) {
      const tests = fileOf(r)!.tests;
      if (!Array.isArray(tests)) continue;
      for (const t of tests) {
        if (!titles.includes(t)) push('partition', file, `${r.id} lists "${t}", which is not a title of this file`);
        listed.add(t);
      }
    }
    for (const s of survivors) {
      for (const t of s.tests) {
        if (!titles.includes(t)) push('partition', file, `SURVIVES lists "${t}", which is not a title of this file`);
        const owner = rows.find((r) => { const tests = fileOf(r)!.tests; return Array.isArray(tests) && tests.includes(t); });
        if (owner) push('partition', file, `"${t}" is in SURVIVES and in ${owner.id}`);
        listed.add(t);
      }
    }
    const coversAll = rest.length > 0 || rows.some((r) => fileOf(r)!.tests === undefined);
    const missing = titles.filter((t) => !listed.has(t));
    if (!coversAll && missing.length) push('partition', file, `titles in no row: ${missing.map((t) => `"${t}"`).join(', ')}`);
  }

  const rowIds = new Set(data.ledger.map((r) => r.id));
  for (const c of world.parityCalls) {
    if (c.rowId === null) push('bad-parity-call', c.file, 'the row id is not a literal');
    else if (!rowIds.has(c.rowId)) push('unknown-parity-row', c.file, `parity('${c.rowId}') names no ledger row`);
    if (c.title === null) push('bad-parity-call', c.file, 'the title is not a literal');
  }
  return problems;
}
