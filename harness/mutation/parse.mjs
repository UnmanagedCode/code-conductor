// The custom parser code-mutant loads for the config.json route with
// `runner: "custom"` (it looks for parse.mjs beside config.json): Playwright,
// which no shipped adapter reads. A binding and nothing else; the parsing is
// ./playwright.ts, which stays plugin-free so `npm test` can load it, and this
// file imports nothing from the plugin.
//
// No scopeOf, substitute, canNameFilter or testFilePatterns is exported, on
// purpose: the defaults keep a mutant's narrow canary eligible (an own scopeOf
// would push every canary back to baseline scope), and the route's `tests`
// globs in config.json are its file patterns.

import { canaryFor, parsePlaywrightReport, pwProject, PW_REPORT_FILE } from './playwright.ts';

export const grade = 'counted';
export const readsReportDir = true;
export const REQUIRED_FLAGS = `PLAYWRIGHT_JSON_OUTPUT_FILE="$CODE_MUTANT_REPORT_DIR/${PW_REPORT_FILE}"`;

export function parse(stdout, stderr, exitCode, context) {
  return parsePlaywrightReport(context?.reports?.[PW_REPORT_FILE], {
    cwd: context?.cwd ?? process.cwd(), project: pwProject(process.env), exitCode,
  });
}

export function canary(source, { file }) {
  return canaryFor(file, source, { project: pwProject(process.env) });
}
