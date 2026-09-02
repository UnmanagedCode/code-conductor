// The run must not leave a DETACHED git process running behind its own back.
//
// card 2026-0290 §3: git spawns `git maintenance run --auto --quiet --detach`
// after ordinary write commands. It is detached, so it outlives the command that
// spawned it and repacks whenever it lands — including inside a window in which
// a test has already taken a "before" tree snapshot and is about to take the
// "after" one. `assertTreeUnchanged`/`snapshotTree` guard several assertion sites
// across the systems suites; a repack lands there as a spurious diff (`.git/info/refs`,
// `objects/info/packs`, `multi-pack-index`, `pack-*.{idx,pack,rev}` appear, every
// loose object disappears) and reds the gate with no defect in the diff under test.
//
// Measured on this host at fe610017: 765 such spawns per `npm test`.
//
// tests/run.mjs pins the whole run to a run-scoped gitconfig that disables it.
// This file is the regression test for that pin: it fails the moment the export
// is dropped, instead of the pin's absence being discovered by a gate reddening
// once every few runs.

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

// Pins: the run exports GIT_CONFIG_GLOBAL, and it resolves inside this run's own
// throwaway root. NOT claiming anything about the file's contents — the
// behavioural test below is what pins the effect, so this cannot pass by
// pointing at an empty file somewhere safe.
test('the run pins GIT_CONFIG_GLOBAL inside its own safe root', () => {
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
    `git spawned ${spawns.length} detached maintenance child(ren) — the run-scoped ` +
    'gitconfig from tests/run.mjs is not in effect');
});
