// The mutation harness's scoring layer: which runner a test file belongs to,
// what each mode runs, and how the framed output of harness/mutation/suite.ts
// becomes one counted result for code-mutant. Pure — no I/O and no plugin
// import (parse.mjs injects the plugin's adapters), so `npm test` loads it on a
// machine with no plugins.
//
// Routing is by TEST file, never by the mutated source, so a verdict does not
// depend on what language the source is in.

import path from 'node:path';

export type Group = 'node' | 'vitest' | 'playwright';

/** Each row mirrors that runner's own discovery. */
export const ROUTES: ReadonlyArray<{ group: Group; pattern: RegExp; shape: string }> = [
  // tests/run.mjs discover(): top-level *.test.mjs only.
  { group: 'node', pattern: /^tests\/[^/]+\.test\.mjs$/, shape: 'tests/<name>.test.mjs' },
  // web/vitest.config.ts include.
  { group: 'vitest', pattern: /^web\/src\/.+\.test\.tsx?$/, shape: 'web/src/**/*.test.ts(x)' },
  { group: 'playwright', pattern: /^web\/e2e\/.+\.spec\.ts$/, shape: 'web/e2e/**/*.spec.ts' },
];

/** Baseline-scope canary discovery. `--all` runs no Playwright, so no spec is listed. */
export const TEST_FILE_PATTERNS = ['tests/*.test.mjs', 'web/src/**/*.test.ts', 'web/src/**/*.test.tsx'];

export const DEFAULT_PW_PROJECT = 'desktop';

/** The one Playwright project every Playwright row of a run is scored under. */
export function pwProject(env: Record<string, string | undefined>): string {
  return env.CC_MUTATION_PW_PROJECT || DEFAULT_PW_PROJECT;
}

const toPosix = (p: string): string => p.split(path.sep).join('/');
const relPath = (repoRoot: string, abs: string): string => toPosix(path.relative(repoRoot, abs));

function groupOf(file: string): Group | null {
  return ROUTES.find((r) => r.pattern.test(file))?.group ?? null;
}

function refusal(file: string): Error {
  return new Error(`harness/mutation/suite.ts: ${file} is not a test file this harness runs; `
    + `accepted: ${ROUTES.map((r) => r.shape).join(', ')}`);
}

/** Groups the files by runner, in ROUTES order; any other file is refused. */
export function route(files: string[], repoRoot: string): Map<Group, string[]> {
  const byGroup = new Map<Group, string[]>();
  for (const given of files) {
    const file = path.isAbsolute(given) ? relPath(repoRoot, given) : given.replace(/^\.\//, '');
    const group = groupOf(file);
    if (!group) throw refusal(given);
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group)!.push(file);
  }
  return new Map(ROUTES.filter((r) => byGroup.has(r.group)).map((r) => [r.group, byGroup.get(r.group)!]));
}

export type Command = {
  group: Group | 'typecheck';
  cmd: string;
  args: string[];
  env: Record<string, string>;
  /** Where the runner writes its JSON report (Vitest, Playwright). */
  report?: string;
  /** The requested files, or null for the runner's whole discovery. */
  files: string[] | null;
};

// `npm test --ignore-scripts` skips `pretest` (the typecheck) and still runs
// `test`, so NODE_OPTIONS stays single-sourced in package.json.
function nodeCommand(files: string[] | null): Command {
  return { group: 'node', cmd: 'npm', args: ['test', '--ignore-scripts', ...(files ? ['--', ...files] : [])], env: {}, files };
}

function vitestCommand(files: string[] | null, tmpDir: string): Command {
  // Absolute: Vitest resolves a relative --outputFile against web/.
  const report = path.join(tmpDir, 'vitest.json');
  return {
    group: 'vitest', cmd: 'npx',
    args: ['vitest', 'run', '--config', 'web/vitest.config.ts', '--reporter=json', `--outputFile=${report}`, ...(files ?? [])],
    env: { NO_COLOR: '1' }, report, files,
  };
}

function playwrightCommand(files: string[], project: string, tmpDir: string): Command {
  const report = path.join(tmpDir, 'playwright.json');
  return {
    group: 'playwright', cmd: 'npx',
    args: ['playwright', 'test', '--config', 'web/playwright.config.ts', `--project=${project}`, '--reporter=json', ...files],
    env: { PLAYWRIGHT_JSON_OUTPUT_FILE: report, NO_COLOR: '1' }, report, files,
  };
}

/**
 * `all` (the baseline): typecheck, then the whole node and Vitest suites — no
 * Playwright, whose rows are opt-in by naming a spec. `narrow` (every mutant
 * command): only the requested files, and never a typecheck.
 */
export function planCommands(
  mode: 'all' | 'narrow',
  groups: Map<Group, string[]>,
  { project, projects, tmpDir }: { project: string; projects: string[]; tmpDir: string },
): Command[] {
  if (!projects.includes(project)) {
    throw new Error(`harness/mutation/suite.ts: CC_MUTATION_PW_PROJECT=${project} is not a project of `
      + `web/playwright.config.ts (${projects.join(', ')})`);
  }
  if (mode === 'all') {
    return [
      { group: 'typecheck', cmd: 'npm', args: ['run', 'typecheck'], env: {}, files: null },
      nodeCommand(null),
      vitestCommand(null, tmpDir),
    ];
  }
  const out: Command[] = [];
  for (const [group, files] of groups) {
    if (group === 'node') out.push(nodeCommand(files));
    else if (group === 'vitest') out.push(vitestCommand(files, tmpDir));
    else out.push(playwrightCommand(files, project, tmpDir));
  }
  return out;
}

// ── Report reduction: ids and statuses only ───────────────────────────────

type VitestReport = {
  testResults: Array<{
    name: string;
    status: string;
    assertionResults: Array<{ ancestorTitles: string[]; title: string; status: string }>;
  }>;
};
export type ReducedVitest = { files: Array<{ file: string; loadFailed: boolean; tests: Array<{ id: string; status: string }> }> };

export function reduceVitestReport(report: VitestReport, repoRoot: string, requested: string[] | null): ReducedVitest {
  const want = requested ? new Set(requested) : null;
  const files: ReducedVitest['files'] = [];
  for (const r of report.testResults) {
    // `name` is already absolute: relativise it, never prefix it.
    const file = relPath(repoRoot, r.name);
    if (want && !want.has(file)) continue;
    files.push({
      file,
      loadFailed: r.status === 'failed' && !r.assertionResults.some((a) => a.status === 'failed'),
      // Not `fullName`, which is space-joined.
      tests: r.assertionResults.map((a) => ({ id: `${file}::${[...a.ancestorTitles, a.title].join(' > ')}`, status: a.status })),
    });
  }
  return { files };
}

type PwSuite = {
  title: string;
  file?: string;
  specs?: Array<{ title: string; tests: Array<{ projectName: string; status: string }> }>;
  suites?: PwSuite[];
};
type PwReport = { config: { rootDir: string }; suites: PwSuite[]; errors: Array<{ message?: string; value?: string; stack?: string }> };
export type ReducedPlaywright = { project: string; errors: number; firstError: string | null; tests: Array<{ id: string; status: string }> };

const FIRST_ERROR_MAX_BYTES = 2048;

function truncateBytes(text: string, max: number): string {
  let out = text.slice(0, max);
  while (Buffer.byteLength(out) > max) out = out.slice(0, -1);
  return out;
}

function pwFile(report: PwReport, repoRoot: string, suiteFile: string): string {
  const file = relPath(repoRoot, path.resolve(report.config.rootDir, suiteFile));
  if (!file.startsWith('web/e2e/')) {
    throw new Error(`harness/mutation/suite.ts: Playwright reported ${file}, which is not under web/e2e/ `
      + `(rootDir ${report.config.rootDir})`);
  }
  return file;
}

/** The spec files a Playwright report ran, repo-relative. */
export function playwrightReportFiles(report: PwReport, repoRoot: string): string[] {
  return report.suites.map((s) => pwFile(report, repoRoot, s.file ?? s.title));
}

/**
 * Whether a `--list` report shows the project selecting `file`: true, false, or
 * null when the listing failed for another reason (a spec that does not load).
 * Playwright reports an empty selection as an error ("No tests found"), so a
 * run report alone cannot tell a refusal from a compile error.
 */
export function listingSelects(report: PwReport | null, repoRoot: string, file: string): boolean | null {
  if (!report) return null;
  if (playwrightReportFiles(report, repoRoot).includes(file)) return true;
  const other = report.errors.some((e) => !/^Error: No tests found/.test(e.message ?? ''));
  return other ? null : false;
}

export function reducePlaywrightReport(
  report: PwReport, repoRoot: string, requested: string[] | null, project: string,
): ReducedPlaywright {
  const want = requested ? new Set(requested) : null;
  const tests: ReducedPlaywright['tests'] = [];
  const walk = (suite: PwSuite, file: string, titles: string[]): void => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        tests.push({ id: `${file}::${[t.projectName, ...titles, spec.title].join(' > ')}`, status: t.status });
      }
    }
    for (const child of suite.suites ?? []) walk(child, file, [...titles, child.title]);
  };
  for (const top of report.suites) {
    const file = pwFile(report, repoRoot, top.file ?? top.title);
    if (want && !want.has(file)) continue;
    walk(top, file, []);
  }
  const first = report.errors[0];
  return {
    project,
    errors: report.errors.length,
    firstError: first ? truncateBytes(first.message ?? first.value ?? first.stack ?? 'unknown error', FIRST_ERROR_MAX_BYTES) : null,
    tests,
  };
}

// ── Framed output ─────────────────────────────────────────────────────────

const HEADER = /^@@cc-mutation-suite (\S+)((?: \S+=\S*)*)@@$/;

/** One section of suite.ts's stdout: a header line, then the body verbatim. */
export function frame(header: string, body: string): string {
  return `@@cc-mutation-suite ${header}@@\n${body}\n`;
}

type Section = { name: string; attrs: Record<string, string>; body: string };

function sections(stdout: string): Section[] {
  const out: Section[] = [];
  let current: { name: string; attrs: Record<string, string>; lines: string[] } | null = null;
  const close = (): void => {
    if (current) out.push({ name: current.name, attrs: current.attrs, body: current.lines.join('\n').replace(/\n$/, '') });
  };
  for (const line of stdout.split('\n')) {
    const m = HEADER.exec(line);
    if (m) {
      close();
      const attrs: Record<string, string> = {};
      for (const kv of m[2].trim().split(' ').filter(Boolean)) {
        const at = kv.indexOf('=');
        attrs[kv.slice(0, at)] = kv.slice(at + 1);
      }
      current = { name: m[1], attrs, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  close();
  return out;
}

export type FailedTest = { file: string; name: string; id: string };
export type Counted = {
  grade: 'counted';
  passed: number;
  failed: number;
  skipped: number;
  ran: number;
  failedTests: FailedTest[];
  compileError: boolean;
  counts: Record<string, unknown>;
};
type NodeTestAdapter = { parse(stdout: string, stderr: string, exitCode: number): Counted };

const VITEST_SKIPPED = new Set(['skipped', 'pending', 'todo', 'disabled']);

function splitId(id: string): FailedTest {
  const at = id.indexOf('::');
  return { file: id.slice(0, at), name: id.slice(at + 2), id };
}

/**
 * Merges every section into one counted result: counts summed, failedTests
 * concatenated, compileError OR-ed. A section that is absent contributes
 * nothing, so a refused invocation reads `ran: 0`, never a pass.
 */
export function parseSuiteOutput(stdout: string, _stderr: string, exitCode: number, { nodeTest }: { nodeTest: NodeTestAdapter }): Counted {
  const all = sections(stdout);
  const total: Counted = { grade: 'counted', passed: 0, failed: 0, skipped: 0, ran: 0, failedTests: [], compileError: false,
    counts: { exitCode, sections: all.map((s) => [s.name, s.attrs]) } };
  const add = (r: Omit<Counted, 'grade' | 'counts'>): void => {
    total.passed += r.passed;
    total.failed += r.failed;
    total.skipped += r.skipped;
    total.ran += r.ran;
    total.failedTests.push(...r.failedTests);
    total.compileError ||= r.compileError;
  };

  const nodeOut = all.find((s) => s.name === 'node-stdout');
  if (nodeOut) {
    const nodeErr = all.find((s) => s.name === 'node-stderr');
    add(nodeTest.parse(nodeOut.body, nodeErr?.body ?? '', Number(nodeOut.attrs.exit)));
  }

  const vitest = all.find((s) => s.name === 'vitest');
  if (vitest) {
    const reduced = JSON.parse(vitest.body) as ReducedVitest;
    const r = { passed: 0, failed: 0, skipped: 0, ran: 0, failedTests: [] as FailedTest[], compileError: false };
    for (const f of reduced.files) {
      if (f.loadFailed) {
        // Mirrors the node-test adapter: a file that never loaded is one failing
        // "test" named by the file, and a compile error.
        r.failed++; r.ran++; r.compileError = true;
        r.failedTests.push({ file: f.file, name: f.file, id: f.file });
      }
      for (const t of f.tests) {
        r.ran++;
        if (t.status === 'passed') r.passed++;
        else if (t.status === 'failed') { r.failed++; r.failedTests.push(splitId(t.id)); }
        else if (VITEST_SKIPPED.has(t.status)) r.skipped++;
      }
    }
    add(r);
  }

  const pw = all.find((s) => s.name === 'playwright');
  if (pw) {
    const reduced = JSON.parse(pw.body) as ReducedPlaywright;
    const r = { passed: 0, failed: 0, skipped: 0, ran: 0, failedTests: [] as FailedTest[], compileError: reduced.errors > 0 };
    for (const t of reduced.tests) {
      r.ran++;
      if (t.status === 'expected' || t.status === 'flaky') r.passed++;
      else if (t.status === 'unexpected') { r.failed++; r.failedTests.push(splitId(t.id)); }
      else if (t.status === 'skipped') r.skipped++;
    }
    add(r);
  }

  const typecheck = all.find((s) => s.name === 'typecheck');
  if (typecheck && Number(typecheck.attrs.exit) !== 0) total.compileError = true;

  return total;
}

// ── Canary ────────────────────────────────────────────────────────────────

type Canary = { content: string; testId: string; matches: (failure: { name: string }) => boolean };
type CanaryAdapter = { canary(source: string, opts: { file: string }): Canary };

/**
 * The canary for one test file, by its runner. Playwright's is ours: the run is
 * pinned to one project, so the canary's name is matched exactly with that
 * project's prefix, and a second project's copy would be a defect to see.
 */
export function canaryFor(
  file: string,
  source: string,
  { nodeTest, vitest, label, message, project }:
  { nodeTest: CanaryAdapter; vitest: CanaryAdapter; label: string; message: string; project: string },
): Canary {
  const group = groupOf(file);
  if (group === 'node') return nodeTest.canary(source, { file });
  if (group === 'vitest') return vitest.canary(source, { file });
  if (group !== 'playwright') throw refusal(file);
  const name = `${label}_fires`;
  const content = `${source}${source.endsWith('\n') ? '' : '\n'}
import { test as __codeMutantCanary } from '@playwright/test';
__codeMutantCanary(${JSON.stringify(name)}, () => { throw new Error(${JSON.stringify(message)}); });
`;
  const expected = `${project} > ${name}`;
  return { content, testId: `${file}::${expected}`, matches: (failure) => failure.name === expected };
}
