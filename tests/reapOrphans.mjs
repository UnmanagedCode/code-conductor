// One-off reaper for test processes this suite has already leaked (card
// 2026-0226). NOT part of `npm test`: it is an implicitly destructive action, and
// after the run-end and signal sweeps in tests/run.mjs nothing new accumulates,
// so what remains is a fixed historical residue plus whatever a SIGKILLed run
// leaves — no in-process handler can run for SIGKILL, which is the one hole the
// sweeps cannot close and the only standing reason this file exists.
//
//   node tests/reapOrphans.mjs --dry-run                  # print, kill nothing
//   node tests/reapOrphans.mjs                            # reap
//   node tests/reapOrphans.mjs --id cc-testrun-XXXXXX     # a run whose root survives
//
// DO NOT REPLACE THIS WITH `pkill -f 'node server.mjs'`. It was tried as a
// one-off and it worked, but it is not safe as routine cleanup: a NAME match hits
// the live children a running suite spawned — manufacturing failures that read
// as real reds — and unrelated apps on a shared box. It is also what destroyed
// the evidence for the `server.mjs` family during this card's own inventory.
//
// This file reaps PROCESSES only. Stale /tmp/cc-testrun-* directories are a
// separate, structural leak (ensureSafeStoreEnv mints a root that nothing
// removes) tracked as card 2026-0227 — deliberately not folded in here.

import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshot, killPids, MARKER_RE } from './procTree.mjs';
import { RUN_ROOT_SHAPE } from './safeStoreRoot.mjs';

// Every process we are LICENSED to kill, ordered descending by pid so children
// (higher pids, generally) go before parents. The order is a courtesy only —
// every entry is independently licensed, so a partial pass kills nothing it
// should not have.
//
// A pid is licensed iff ALL of these hold. Nothing here looks at a NAME, a
// process GROUP, a PPID, or a START TIME: every one of those is a heuristic that
// can name a stranger, and card 2026-0190 already removed such a heuristic from
// this suite for being unsafe.
//
//   * `snap.available` — a partial or failed /proc read must yield NOTHING, never
//     everything. This is the conjunct standing between "I cannot see" and a kill
//     list, so it is checked before the loop rather than relied on downstream.
//   * `pid > 1` and `pid !== process.pid` — init and ourselves, always.
//   * its environ carries a well-formed, anchored CC_TEST_RUN_ID entry.
//   * the captured id is shaped like a run root (RUN_ROOT_SHAPE, imported from
//     tests/safeStoreRoot.mjs rather than re-declared — a second copy could
//     widen while the original did not). This excludes an ad-hoc marker some
//     other tool exported under the same variable name.
//   * `!rootExists(id)` — the owning run reached removeSafeRoot, so it is
//     PROVABLY over. This is the conjunct that makes the whole thing safe to run
//     while a suite is in progress: a live run's root is still on disk.
//
// `rootExists` is injected, which is also how `--id` works: it asks "is the
// owning run still going?" and the CLI answers it either from the filesystem or,
// for a run that was SIGKILLed before it could remove its own root, from the id
// the operator named.
export function staleRunTargets(snap, rootExists) {
  if (!snap.available) return [];
  const out = [];
  for (const info of snap.byPid.values()) {
    if (!Number.isInteger(info.pid) || info.pid <= 1 || info.pid === process.pid) continue;
    const m = MARKER_RE.exec(info.env ?? '');
    if (!m) continue;
    const marker = m[1];
    if (!RUN_ROOT_SHAPE.test(marker)) continue;
    if (rootExists(marker)) continue;
    out.push({ pid: info.pid, ident: info.ident, marker, argv: info.argv });
  }
  return out.sort((a, b) => b.pid - a.pid);
}

// --- CLI --------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const idAt = argv.indexOf('--id');
  const onlyId = idAt >= 0 ? argv[idAt + 1] : null;

  if (idAt >= 0 && !RUN_ROOT_SHAPE.test(onlyId ?? '')) {
    console.error(`--id needs a run marker shaped like cc-testrun-XXXXXX, got ${JSON.stringify(onlyId)}`);
    process.exit(2);
  }

  const tmp = realpathSync(os.tmpdir());
  // With --id the operator asserts that run is over (its root may still exist
  // because it was SIGKILLed before removeSafeRoot); every OTHER run is treated
  // as live, so a typo narrows the kill list to nothing rather than widening it.
  const rootExists = onlyId !== null
    ? (marker) => marker !== onlyId
    : (marker) => existsSync(path.join(tmp, marker));

  const snap = snapshot({ environ: true });
  if (!snap.available) {
    console.error('reapOrphans: /proc is unreadable — refusing to guess. Nothing was killed.');
    process.exit(1);
  }

  const targets = staleRunTargets(snap, rootExists);
  for (const t of targets) {
    console.log(`${dryRun ? 'would reap' : 'reaping'} pid=${t.pid} marker=${t.marker} :: ${t.argv.join(' ')}`);
  }
  if (targets.length === 0) {
    console.log(onlyId !== null
      ? `reapOrphans: no live process carries marker ${onlyId}.`
      : 'reapOrphans: no processes from a finished run are alive. Nothing to do.');
    process.exit(0);
  }
  if (dryRun) {
    console.log(`reapOrphans: ${targets.length} target(s); --dry-run, nothing killed.`);
    process.exit(0);
  }
  // killPids re-verifies each pid's starttime identity immediately before
  // signalling, so a pid recycled between the snapshot and now is skipped.
  const killed = killPids(targets);
  console.log(`reapOrphans: SIGKILLed ${killed.length} of ${targets.length} target(s).`);
}
