// THE ACCEPTANCE GATE for the provider protocol.
//
//   npm run gate:systems
//
// Runs the ENTIRE test suite three times with the in-process `local` system
// replaced by a ProviderSystem speaking the wire protocol to the reference
// provider — once with both optional capabilities, once with each turned off.
//
// One gate, two claims:
//   * SUFFICIENCY — every project-scoped operation in the app really can be
//     expressed as the three primitives plus the derivations. Nothing in the
//     suite knows it is talking to a provider, so nothing is testing a
//     convenient subset.
//   * BOTH FALLBACKS RUN — a capability whose absent-behaviour has never
//     executed is a flag, not a fallback.
//
// It is a separate command rather than part of `npm test` because it IS
// `npm test`, three times over. The per-configuration protocol suites
// (tests/systems-*.test.mjs) run inside the ordinary suite and cover the same
// capability matrix at the unit level, so a plain `npm test` still exercises
// both fallbacks; this proves the whole application over them.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const provider = path.join(repoRoot, 'src', 'systems', 'referenceProvider.ts');

const CONFIGS = [
  { name: 'all capabilities', flags: [] },
  { name: 'persistentShell:false', flags: ['--no-persistent-shell'] },
  { name: 'processGroupSignal:false', flags: ['--no-process-group-signal'] },
];

function run(argv, env) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

// The gated typecheck `npm test` runs via `pretest`, done once rather than per
// configuration: it does not depend on which provider the suite talks to.
console.log('\n=== typecheck ===');
if (await run(['npm', 'run', 'typecheck'], {}) !== 0) {
  console.error('\ngate:systems FAILED — typecheck');
  process.exit(1);
}

const results = [];
for (const config of CONFIGS) {
  const argv = JSON.stringify(['node', provider, ...config.flags]);
  console.log(`\n=== suite over the reference provider: ${config.name} ===`);
  console.log(`    CC_LOCAL_SYSTEM_PROVIDER=${argv}`);
  const code = await run(['node', 'tests/run.mjs'], {
    CC_LOCAL_SYSTEM_PROVIDER: argv,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=512`.trim(),
  });
  results.push({ ...config, code });
}

console.log('\n=== gate:systems ===');
for (const r of results) console.log(`  ${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.name}`);
const failed = results.filter(r => r.code !== 0);
if (failed.length > 0) {
  console.error(`\ngate:systems FAILED in ${failed.length} of ${results.length} configuration(s)`);
  process.exit(1);
}
console.log(`\ngate:systems PASSED in all ${results.length} configurations`);
