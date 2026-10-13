// The custom parser code-mutant loads for `runner: "custom"` (it looks for
// parse.mjs beside config.json). A binding shim and nothing else: the scoring
// itself is ./scoring.ts, which stays plugin-free so `npm test` can load it.
//
// THIS FILE IS THE ONE PLACE COUPLED TO CODE-MUTANT'S INTERNALS: the shipped
// node-test and vitest adapters (lib/adapters/index.mjs) and the canary label
// and message (lib/adapters/common.mjs). A missing export throws naming the
// plugin path rather than degrading.
//
// No scopeOf/substitute/canNameFilter is exported, on purpose: the defaults
// (node-test's file-part scopeOf, quoted-path substitute, refsNameFiles) keep a
// mutant's narrow canary eligible; an own scopeOf would push every canary back
// to baseline scope.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvePluginDir } from '../pluginDir.mjs';
import { canaryFor, parseSuiteOutput, pwProject, TEST_FILE_PATTERNS } from './scoring.ts';

const plugin = resolvePluginDir('code-mutant');
const load = (rel) => import(pathToFileURL(path.join(plugin, rel)).href);
const { SHIPPED_ADAPTERS } = await load('lib/adapters/index.mjs');
const { CANARY_LABEL, CANARY_MESSAGE } = await load('lib/adapters/common.mjs');

const nodeTest = SHIPPED_ADAPTERS?.['node-test'];
const vitest = SHIPPED_ADAPTERS?.vitest;
for (const [name, ok] of [
  ['SHIPPED_ADAPTERS["node-test"].parse', typeof nodeTest?.parse === 'function'],
  ['SHIPPED_ADAPTERS["node-test"].canary', typeof nodeTest?.canary === 'function'],
  ['SHIPPED_ADAPTERS.vitest.canary', typeof vitest?.canary === 'function'],
  ['CANARY_LABEL', typeof CANARY_LABEL === 'string'],
  ['CANARY_MESSAGE', typeof CANARY_MESSAGE === 'string'],
]) {
  if (!ok) throw new Error(`harness/mutation/parse.mjs: the code-mutant plugin at ${plugin} no longer exports ${name}`);
}

export const grade = 'counted';
export const testFilePatterns = TEST_FILE_PATTERNS;

export function parse(stdout, stderr, exitCode) {
  return parseSuiteOutput(stdout, stderr, exitCode, { nodeTest });
}

export function canary(source, { file }) {
  return canaryFor(file, source, {
    nodeTest, vitest, label: CANARY_LABEL, message: CANARY_MESSAGE, project: pwProject(process.env),
  });
}
