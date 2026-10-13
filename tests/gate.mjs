// The `npm test` gate. `pretest` has already typechecked; this runs the node:test
// suite (tests/run.mjs) and then the web Vitest suite, and closes with one line
// naming each suite's result.
//
//   npm test                    both suites
//   npm test -- tests/x.test.mjs  those node files only (the Vitest-only path is
//                               `npm run test:web -- <file>`)
//
// The suites run one after the other, never in parallel: peak memory is the larger
// suite's, not the sum, and tests/run.mjs already near-saturates its slots with
// deadline-bound files that flake when starved (resolveConcurrency). A red node
// suite does NOT skip the web suite — both results are always reported — but an
// interrupt starts no further suite.
//
// Vitest is spawned from this process's env, never through tests/run.mjs: run.mjs
// rewrites the env before it forks (the safe store root, CC_SKIP_WEB_BUILD, the
// git-config pin, the heap cap), and none of that may reach the web suite.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Spawned with process.execPath rather than through node_modules/.bin: no PATH
// lookup and no Windows `.cmd` shim.
const vitestBin = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');

// The signal this gate received, if any, and the suite running when it did.
const state = { signal: null, child: null };

export function planSuites(argv) {
  const node = { name: 'node', cmd: process.execPath, args: ['tests/run.mjs', ...argv] };
  if (argv.length > 0) return [node];
  return [node, { name: 'web', cmd: process.execPath, args: [vitestBin, 'run', '--config', 'web/vitest.config.ts'] }];
}

function runSuite({ name, cmd, args }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: repoRoot, stdio: 'inherit' });
    state.child = child;
    child.on('close', (code, signal) => {
      state.child = null;
      resolve({ name, code, signal });
    });
  });
}

export async function runSuites(suites) {
  const results = [];
  for (const suite of suites) {
    if (state.signal) break;
    const result = await runSuite(suite);
    results.push(result);
    if (result.signal) break;
  }
  return results;
}

// The exit code and the closing summary. An interrupted run — the gate signalled,
// or a suite ended by a signal — exits 128 + signo, as an uncaught signal would.
export function gateExit(suites, results, signal = state.signal) {
  const killedBy = signal ?? results.find((r) => r.signal)?.signal ?? null;
  const parts = suites.map(({ name }) => {
    const r = results.find((x) => x.name === name);
    if (!r) return `${name} NOT RUN`;
    if (r.signal) return `${name} FAILED (${r.signal})`;
    return r.code === 0 ? `${name} PASSED` : `${name} FAILED (exit ${r.code})`;
  });
  const green = !killedBy && results.length === suites.length && results.every((r) => r.code === 0);
  const code = killedBy ? 128 + os.constants.signals[killedBy] : green ? 0 : 1;
  const interrupted = signal ? ` (interrupted by ${signal})` : '';
  return { code, summary: `npm test: ${parts.join(' · ')}${interrupted}` };
}

async function main() {
  // SIGINT is not forwarded: the terminal already delivered it to the whole process
  // group, and tests/run.mjs exits on its FIRST SIGINT after an orphan sweep that a
  // second one would cut short.
  process.on('SIGINT', () => { state.signal ??= 'SIGINT'; });
  process.on('SIGTERM', () => {
    state.signal ??= 'SIGTERM';
    state.child?.kill('SIGTERM');
  });
  const suites = planSuites(process.argv.slice(2));
  const { code, summary } = gateExit(suites, await runSuites(suites));
  (code === 0 ? console.log : console.error)(`\n${summary}`);
  process.exitCode = code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
