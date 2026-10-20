// The `npm test` gate: typecheck halves (`typecheck:node`, `typecheck:web` in
// package.json), then the node:test suite (tests/run.mjs), then the web Vitest
// suite, closing with one line naming each step's result.
//
//   npm test                          both halves, both suites
//   npm test -- tests/x.test.mjs web/src/y.test.ts
//                                     tests/ files to node, web/src/ files to
//                                     Vitest; only those suites and their halves
//   npm test -- --changed             the suites and halves the diff against
//                                     main selects (tests/changedScope.mjs)
//
// A red typecheck step starts no later step. The gate runs the halves itself
// because npm passes `-- <args>` to the script only, never to a lifecycle hook.
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
import { buildReach, changedPaths, classifyChanged } from './changedScope.mjs';
import { acquireTestSlot } from './testSlot.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Spawned with process.execPath rather than through node_modules/.bin: no PATH
// lookup and no Windows `.cmd` shim.
const vitestBin = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');

// The signal this gate received, if any, and the suite running when it did.
const state = { signal: null, child: null };

// A refused invocation: main prints it and exits 2.
export class UsageError extends Error {}

const HALVES = ['node', 'web'];
const FULL = { node: true, web: true, halves: HALVES };

export function parseGateArgs(argv, root = repoRoot) {
  if (argv.length === 0) return { mode: 'all' };
  if (argv.includes('--changed')) {
    if (argv.length > 1) throw new UsageError('--changed takes no other arguments');
    return { mode: 'changed' };
  }
  const node = [];
  const web = [];
  for (const arg of argv) {
    if (arg.startsWith('-')) {
      throw new UsageError(`${arg}: runner flags go to Vitest — npm run test:web -- ${arg} …; npm run test:node takes test files only`);
    }
    const rel = path.relative(root, path.resolve(root, arg)).split(path.sep).join('/');
    if (rel.startsWith('tests/')) node.push(rel);
    else if (rel.startsWith('web/src/')) web.push(rel);
    else if (rel.startsWith('web/e2e/') || rel === 'web/playwright.config.ts') {
      throw new UsageError(`${arg}: Playwright is not part of npm test — use npm run test:e2e`);
    } else {
      throw new UsageError(`${arg}: name test files under tests/ or web/src/, or use --changed`);
    }
  }
  return { mode: 'files', node, web };
}

// The scope of an 'all' or 'files' invocation: per suite true (whole suite),
// its files, or false; and the typecheck halves.
export function scopeOf(parsed) {
  if (parsed.mode === 'all') return FULL;
  const node = parsed.node.length > 0 && parsed.node;
  const web = parsed.web.length > 0 && parsed.web;
  return { node, web, halves: HALVES.filter((h) => (h === 'node' ? node : web)) };
}

// The scope of `--changed`, and the lines that say why. No diff, or no diff
// that git can produce, runs the full gate. `getReach` is called only for a
// non-empty diff.
export function changedGateScope(changed, getReach) {
  const head = 'npm test --changed:';
  if (!changed.ok) return { scope: FULL, lines: [`${head} ${changed.reason} — running the full gate`] };
  if (changed.paths.length === 0) {
    return { scope: FULL, lines: [`${head} no changes against ${changed.base} (merge-base ${changed.mergeBase}) — running the full gate`] };
  }
  const reach = getReach();
  const { suites, halves, why } = classifyChanged(changed.paths, reach);
  const list = (paths) => (paths.length > 5 ? `${paths.slice(0, 5).join(', ')} +${paths.length - 5}` : paths.join(', '));
  const lines = reach.stale.map((f) => `${head} stale WALKS_REVIEWED entry: ${f} (conservative roots used)`);
  for (const suite of HALVES) {
    if (suites.has(suite)) lines.push(`${head} ${suite} ← ${list(why.filter((w) => w.suites.includes(suite)).map((w) => w.path))}`);
  }
  const unclassified = why.filter((w) => w.rows.includes(6)).map((w) => w.path);
  if (unclassified.length > 0) lines.push(`${head} unclassified → everything: ${list(unclassified)}`);
  return { scope: { node: suites.has('node'), web: suites.has('web'), halves: [...halves] }, lines };
}

// The steps a scope runs: its typecheck halves (blocking), then its suites.
// The halves run through npm so their tsc lists stay in package.json alone.
export function planGate(scope, env = process.env) {
  const npmExecpath = env.npm_execpath;
  if (!npmExecpath) throw new UsageError('npm_execpath is unset — run the gate through npm test');
  const files = (v) => (Array.isArray(v) ? v : []);
  const steps = HALVES.filter((h) => scope.halves.includes(h)).map((h) => (
    { name: `typecheck:${h}`, cmd: process.execPath, args: [npmExecpath, 'run', `typecheck:${h}`], blocking: true }));
  if (scope.node) steps.push({ name: 'node', cmd: process.execPath, args: ['tests/run.mjs', ...files(scope.node)] });
  if (scope.web) {
    steps.push({ name: 'web', cmd: process.execPath, args: [vitestBin, 'run', '--config', 'web/vitest.config.ts', ...files(scope.web)] });
  }
  return steps;
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
    if (result.signal || (suite.blocking && result.code !== 0)) break;
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

// A signal to the gate: record it, so runSuites starts no further suite, and
// forward SIGTERM to the running suite. SIGINT is not forwarded: the terminal
// already delivered it to the whole process group, and tests/run.mjs exits on its
// FIRST SIGINT after an orphan sweep that a second one would cut short.
export function onSignal(signal) {
  state.signal ??= signal;
  if (signal === 'SIGTERM') state.child?.kill('SIGTERM');
}

async function main() {
  let steps;
  try {
    const parsed = parseGateArgs(process.argv.slice(2));
    let scope;
    if (parsed.mode === 'changed') {
      const changed = changedGateScope(changedPaths(repoRoot), () => buildReach(repoRoot));
      for (const line of changed.lines) console.log(line);
      scope = changed.scope;
    } else {
      scope = scopeOf(parsed);
    }
    steps = planGate(scope);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`npm test: ${err.message}`);
    process.exitCode = 2;
    return;
  }
  // One slot for the whole gate, so the web suite does not queue again after the
  // node suite; both typecheck halves and both suites inherit the held marker. The
  // slot is freed when the gate exits. The signal handlers come after the wait, so a
  // signal while queued takes the default exit.
  Object.assign(process.env, (await acquireTestSlot({ label: 'npm test' })).env);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => onSignal(signal));
  const { code, summary } = gateExit(steps, await runSuites(steps));
  (code === 0 ? console.log : console.error)(`\n${summary}`);
  process.exitCode = code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
