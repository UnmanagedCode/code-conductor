// The mutation harness's Playwright route: the parser for Playwright's JSON
// report and the route's canary. Playwright is the one runner no shipped
// code-mutant adapter reads, so it is the single `custom` route of config.json.
// Pure — no I/O and no plugin import, so `npm test` loads it on a machine with
// no plugins; parse.mjs binds it to the plugin's contract.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_PW_PROJECT = 'desktop';

/** The one Playwright project every Playwright row of a run is scored under. */
export function pwProject(env: Record<string, string | undefined>): string {
  return env.CC_MUTATION_PW_PROJECT || DEFAULT_PW_PROJECT;
}

/** The report's basename in `$CODE_MUTANT_REPORT_DIR`; config.json's command writes it. */
export const PW_REPORT_FILE = 'playwright.json';
export const CANARY_NAME = 'code_mutant_canary_fires';
export const CANARY_MESSAGE = 'code-mutant canary';
export const FIRST_ERROR_MAX_BYTES = 2048;

const toPosix = (p: string): string => p.split(path.sep).join('/');
const SPEC = /^web\/e2e\/.+\.spec\.ts$/;

export function truncateBytes(text: string, max: number): string {
  let out = text.slice(0, max);
  while (Buffer.byteLength(out) > max) out = out.slice(0, -1);
  return out;
}

type PwSuite = {
  title: string;
  file?: string;
  specs?: Array<{ title: string; tests: Array<{ projectName: string; status: string }> }>;
  suites?: PwSuite[];
};
type PwReport = { config: { rootDir: string }; suites: PwSuite[]; errors: Array<{ message?: string; value?: string; stack?: string }> };

const roots = (cwd: string): string[] => {
  try { return [...new Set([cwd, fs.realpathSync(cwd)])]; } catch { return [cwd]; }
};

/** The repo-relative spec path for a report suite, or null when it is not under web/e2e/. */
function pwFile(report: PwReport, cwd: string, suiteFile: string): string | null {
  const abs = path.resolve(report.config.rootDir, suiteFile);
  for (const root of roots(cwd)) {
    const rel = toPosix(path.relative(root, abs));
    if (SPEC.test(rel)) return rel;
  }
  return null;
}

export type FailedTest = { file: string; name: string; id: string };
export type Parsed = {
  grade: 'counted';
  passed: number;
  failed: number;
  skipped: number;
  ran: number;
  failedTests: FailedTest[];
  compileError: boolean;
  files: string[];
  counts: Record<string, unknown>;
  diagnostic: string | null;
};

/**
 * `ran: 0`, no files and a diagnostic: the fail-closed reading, so an
 * unreadable report is never a pass and the plugin's ERROR detail says why.
 */
function unread(counts: Record<string, unknown>, diagnostic: string): Parsed {
  return { grade: 'counted', passed: 0, failed: 0, skipped: 0, ran: 0, failedTests: [], compileError: false, files: [], counts, diagnostic };
}

/**
 * Reads `text`, the JSON report the route's command wrote into the report dir.
 * Fails closed on: no report, unparseable JSON, a spec outside web/e2e/, or a
 * test of a project other than `project`.
 */
export function parsePlaywrightReport(
  text: string | undefined,
  { cwd, project, exitCode }: { cwd: string; project: string; exitCode: number },
): Parsed {
  const base = { exitCode, project };
  if (text === undefined) {
    return unread(base, `the command wrote no ${PW_REPORT_FILE} into $CODE_MUTANT_REPORT_DIR `
      + `(PLAYWRIGHT_JSON_OUTPUT_FILE); Playwright refuses an unknown --project, so check CC_MUTATION_PW_PROJECT=${project} `
      + 'against the projects of web/playwright.config.ts');
  }
  let report: PwReport;
  try { report = JSON.parse(text) as PwReport; } catch (e) {
    return unread(base, `${PW_REPORT_FILE} is not JSON: ${(e as Error).message}`);
  }

  const out = unread(base, '');
  const walk = (suite: PwSuite, file: string, titles: string[]): string | null => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        if (t.projectName !== project) return `${file} ran a test of project ${t.projectName}, not ${project}`;
        const id = `${file}::${[t.projectName, ...titles, spec.title].join(' > ')}`;
        out.ran++;
        if (t.status === 'expected' || t.status === 'flaky') out.passed++;
        else if (t.status === 'unexpected') {
          out.failed++;
          out.failedTests.push({ file, name: id.slice(file.length + 2), id });
        } else if (t.status === 'skipped') out.skipped++;
      }
    }
    for (const child of suite.suites ?? []) {
      const bad = walk(child, file, [...titles, child.title]);
      if (bad) return bad;
    }
    return null;
  };

  const files: string[] = [];
  for (const top of report.suites) {
    const file = pwFile(report, cwd, top.file ?? top.title);
    const bad = file === null
      ? `Playwright reported ${top.file ?? top.title}, which is not a web/e2e/**/*.spec.ts under ${cwd} (rootDir ${report.config.rootDir})`
      : walk(top, file, []);
    if (bad) return unread(base, bad);
    files.push(file!);
  }

  const first = report.errors[0];
  const firstError = first ? truncateBytes(first.message ?? first.value ?? first.stack ?? 'unknown error', FIRST_ERROR_MAX_BYTES) : null;
  out.compileError = report.errors.length > 0;
  out.files = files;
  out.counts = { ...base, errors: report.errors.length, firstError };
  if (firstError !== null && /^Error: No tests found/.test(first.message ?? '')) {
    out.diagnostic = `Playwright found no test to run: a spec outside project ${project}'s testMatch/testIgnore `
      + 'in web/playwright.config.ts is not selected; set CC_MUTATION_PW_PROJECT to a project that runs it';
  } else {
    out.diagnostic = null;
  }
  return out;
}

// ── Canary ────────────────────────────────────────────────────────────────

type Canary = { content: string; testId: string; matches: (failure: { name: string }) => boolean };

/** The test object every cc spec imports; the Playwright canary is one of its tests. */
const PW_FIXTURES = 'web/e2e/harness/fixtures.ts';

/**
 * The canary for one spec, or null for a file outside web/e2e/**\/*.spec.ts.
 * The run is pinned to one project, so the canary's name is matched exactly with
 * that project's prefix, and a second project's copy would be a defect to see.
 *
 * Playwright validates a test's ancestor hooks against that test's own fixture
 * pool and keys workers by it, so the canary is a test of PW_FIXTURES's type: a
 * root `beforeAll(({ cc }) => …)` loads, and in a cc spec the canary shares the
 * spec's worker rather than re-running its root hooks in one of its own.
 */
export function canaryFor(file: string, source: string, { project }: { project: string }): Canary | null {
  if (!SPEC.test(file)) return null;
  const fixtures = path.posix.relative(path.posix.dirname(file), PW_FIXTURES);
  const content = `${source}${source.endsWith('\n') ? '' : '\n'}
import { test as __codeMutantCanary } from '${fixtures.startsWith('.') ? fixtures : `./${fixtures}`}';
__codeMutantCanary(${JSON.stringify(CANARY_NAME)}, () => { throw new Error(${JSON.stringify(CANARY_MESSAGE)}); });
`;
  const expected = `${project} > ${CANARY_NAME}`;
  return { content, testId: `${file}::${expected}`, matches: (failure) => failure.name === expected };
}
