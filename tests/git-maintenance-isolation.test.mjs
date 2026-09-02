// The regression test for `pinGitConfig` (tests/safeStoreRoot.mjs) — the run's
// git isolation. WHAT it disables, WHY that key and not the GIT_CONFIG_* env
// form, and the measurements behind both live in that function's comment and are
// deliberately not restated here (card 2026-0290 §3); the short version is that
// git's automatic repack is DETACHED, so it lands inside tree-snapshot windows
// and reds a row with no defect in the diff under test.
//
// This file exists so that dropping the pin fails immediately and by name,
// instead of surfacing as a gate reddening once every few runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';

// A `git` invocation carrying a private GIT_TRACE2_EVENT sink, so the child
// processes THIS command spawns can be counted exactly. Trace2 writes one file
// per traced process into the directory.
function gitTraced(cwd, traceDir, args) {
  execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_TRACE2_EVENT: traceDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return readdirSync(traceDir)
    .map((f) => readFileSync(path.join(traceDir, f), 'utf8'))
    .join('\n');
}

// Pins: GIT_CONFIG_GLOBAL is in effect and resolves inside this run's own
// throwaway root — WHICHEVER path established it. Two do: tests/run.mjs before
// any file forks, and ensureSafeStoreEnv() for a file run standalone. Dropping
// either one alone leaves this green (measured), because either alone still
// covers this process; that redundancy is deliberate, so the name says "is in
// effect", not "run.mjs set it". NOT claiming anything about the file's contents
// — the behavioural test below is what pins the effect, so this cannot pass by
// pointing at an empty file somewhere safe.
test('GIT_CONFIG_GLOBAL is in effect and inside this run\'s safe root', () => {
  const configured = process.env.GIT_CONFIG_GLOBAL;
  assert.ok(configured, 'GIT_CONFIG_GLOBAL is not exported — the run inherits the developer\'s global gitconfig');
  const runRoot = path.dirname(process.env.PROJECTS_ROOT);
  assert.equal(path.dirname(path.resolve(configured)), path.resolve(runRoot),
    `GIT_CONFIG_GLOBAL (${configured}) is not inside this run's root (${runRoot})`);
});

// Pins: under the run's environment, an ordinary commit spawns NO detached
// maintenance child. NOT claiming git never repacks — an EXPLICIT `git gc` or
// `git maintenance run` still works (measured: `maintenance.auto=false` does not
// gate an explicit run). The claim is only about the automatic, detached spawn,
// which is the one nothing in this repo asked for and nothing can wait on.
test('an ordinary commit spawns no detached git maintenance child', async (t) => {
  const dir = await mkdtemp('cc-gitmaint-');
  const trace = await mkdtemp('cc-gitmainttrace-');
  execFileSync('git', ['init', '-q', '--initial-branch=main', dir], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'one'], { cwd: dir });

  writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  execFileSync('git', ['add', 'b.txt'], { cwd: dir });
  const traced = gitTraced(dir, trace, ['commit', '-qm', 'two']);

  // Non-vacuity: the sink really captured this command, so "zero maintenance
  // spawns" cannot be "zero events of any kind".
  assert.match(traced, /"argv":\["git","commit"/, 'the trace sink captured nothing at all');
  const spawns = traced.split('\n').filter(
    (l) => l.includes('"event":"child_start"') && l.includes('"maintenance","run","--auto"'));
  assert.equal(spawns.length, 0,
    `git spawned ${spawns.length} detached maintenance child(ren) — pinGitConfig's ` +
    'run-scoped gitconfig is not in effect for this process');
});
