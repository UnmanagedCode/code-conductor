// The suite's ONLY /proc reader. Both the fake-claude process-count guardrail
// and the hang guard's per-file kill watchdog go through here, so there is one
// implementation of "what is running" rather than one per caller.
//
// /proc reads are safe on this host; `pkill` / `lsof` are NOT — do not add a
// shell-based fallback here (see the note above the fake-claude budget in
// tests/run.mjs). On a non-Linux host /proc is absent and every function below
// degrades to "I can see nothing" (-1 / empty / `available:false`), never a
// throw: the guard failing must not become a new failure class. Callers that
// report on the guard's own coverage MUST check `snapshot().available` — a
// blind watchdog that claims the property is worse than one that says it
// couldn't look.
//
// One function here is async — settleResidual, which re-asks a liveness question
// over a bounded interval. Everything else is synchronous and side-effect-free
// apart from killPids/reapResidual, which signal.
//
// Everything is built on ONE snapshot() per sampling tick. The watchdog asks
// several questions each tick (peak fake-claude count, which children are
// alive, what they have spawned); answering each with its own /proc walk would
// multiply the sampler's cost by the number of questions AND let the answers
// disagree with each other mid-tick.

import { readdirSync, readFileSync } from 'node:fs';

// A single consistent read of every visible process. `available:false` means
// /proc is unreadable, which callers distinguish from "nothing is running".
export function snapshot({ environ = false } = {}) {
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch {
    return { available: false, byPid: new Map(), byParent: new Map() };
  }
  const byPid = new Map();
  const byParent = new Map();
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let ppid = null;
    let ident = null;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // The comm field (2) is parenthesised and may itself contain spaces AND
      // parens, so the only safe split point is the LAST ')'. After it, field N
      // sits at index N-3: ppid is field 4, starttime is field 22.
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const n = Number(f[1]);
      if (Number.isInteger(n)) ppid = n;
      // starttime is the pid's INCARNATION identity: monotonic clock ticks
      // since boot at exec. Two processes that reuse the same pid number
      // cannot share it, which is what makes a remembered pid safe to signal
      // later (see killPids).
      if (/^\d+$/.test(f[19] ?? '')) ident = f[19];
    } catch { /* vanished between readdir and read */ }
    let raw = '';
    try { raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { /* ditto */ }
    // environ is OPT-IN: it is one extra read per visible pid, so the 100ms
    // sampler never asks for it — only the sweep, which is rare, does.
    let env = '';
    if (environ) {
      try { env = readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch { /* not ours / vanished */ }
    }
    byPid.set(pid, { pid, ppid, ident, raw, env, argv: raw.split('\0').filter(Boolean) });
    if (ppid !== null) {
      if (!byParent.has(ppid)) byParent.set(ppid, []);
      byParent.get(ppid).push(pid);
    }
  }
  return { available: true, byPid, byParent };
}

// The pid's incarnation identity, read live. `null` when it cannot be
// determined (vanished / unreadable / non-Linux).
export function identOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return /^\d+$/.test(f[19] ?? '') ? f[19] : null;
  } catch {
    return null;
  }
}

// Direct children of `ppid`, as [{ pid, argv, ident }]. `argv` is the split
// argument vector (not a joined string) because the caller matches on an exact
// element — node:test's per-file child carries the absolute test path as its
// LAST argv entry, and substring-matching a joined cmdline would confuse
// `foo.test.mjs` with `foo.test.mjs.bak`. A process caught mid-exec has an
// empty argv (a real kernel state we observed while sampling), not a throw.
export function liveChildren(ppid, snap = snapshot()) {
  return (snap.byParent.get(ppid) ?? []).map(pid => snap.byPid.get(pid)).filter(Boolean);
}

// Every transitive descendant of `pid`, nearest-first (BFS order). `pid` itself
// is never included, so a caller can never accidentally act on itself.
export function descendants(pid, snap = snapshot()) {
  const out = [];
  const seen = new Set([pid]);
  const queue = [pid];
  while (queue.length > 0) {
    for (const child of snap.byParent.get(queue.shift()) ?? []) {
      if (seen.has(child)) continue; // pid reuse / cycle paranoia
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

// The ONE expression of what a CC_TEST_RUN_ID entry looks like in a
// /proc/<pid>/environ blob, anchored at BOTH ends. Every predicate below reads it
// from here, and tests/reapOrphans.mjs imports it, so the suite has exactly one
// answer to "is this pid ours" and one licence to kill.
//
// environ is a sequence of NUL-terminated entries (verified: the final entry is
// terminated too), so:
//   * `(?:^|\0)` rules out a variable whose NAME merely ENDS with ours —
//     `PREV_CC_TEST_RUN_ID=<marker>` satisfies a plain `includes` on the needle,
//     and a licence to kill must not be granted by a name collision;
//   * the trailing `\0` rules out a marker that merely STARTS WITH the one asked
//     about. Without it an inner runner's sweep matches an OUTER runner's marker
//     and SIGKILLs the outer run's processes — measured with an 8-char marker:
//     the outer file died at 3.8s having reported 5 of 16 cases. Nothing here
//     depends on mkdtemp's fixed-width suffix, which is a fact of
//     tests/safeStoreRoot.mjs and not of this predicate.
// Both written as escapes, never literal NUL bytes: a literal renders every diff
// of this file binary. No `g` flag, so `exec` is stateless and the constant is
// safe to share across callers.
export const MARKER_RE = /(?:^|\0)CC_TEST_RUN_ID=([^\0]*)\0/;

// The marker carried by `env`, or null. The single place either predicate below
// decides what a blob says about itself.
function markerIn(env) {
  return typeof env === 'string' ? (MARKER_RE.exec(env)?.[1] ?? null) : null;
}

// Every process carrying THIS run's marker in its environment — i.e. every
// descendant of this runner at any depth, however it was spawned.
//
// This is an EXACT IDENTITY, not a heuristic. tests/run.mjs exports a
// run-unique CC_TEST_RUN_ID (minted by mkdtemp) into the environment before any
// child forks, so every descendant inherits it, and /proc/<pid>/environ reflects
// the environment as of exec — which means:
//   * it survives `setsid`/`detached: true`, which escapes the process group
//     (verified: readable on a detached child whose pgrp had become its own pid);
//   * it survives reparenting to init, since it has nothing to do with lineage;
//   * it survives a file completing inside one sampler tick, since nothing has
//     to have been observed beforehand;
//   * it cannot match a stranger, a system daemon, a sibling in the user's shell
//     pipeline, or a DIFFERENT concurrent run of this suite — each mints its own.
//
// It deliberately replaced a process-group/ppid/start-time heuristic. That
// heuristic was unsafe: a process group is a job boundary only under interactive
// job control, and under `sh -c`, CI, or an agent harness (how this runner is
// actually executed) the runner inherits its parent's group, so the group spans
// unrelated work that the conjuncts could not reliably exclude.
//
// NOTE on the marker choice: PROJECTS_ROOT looks like a ready-made marker and is
// NOT usable. bootServer reassigns it per server to a path outside the run root,
// so a grandchild spawned mid-test inherits the reassigned value (measured).
// CC_TEST_RUN_ID exists precisely because nothing else OVERWRITES it: run.mjs
// exports it per run, and tests/safeStoreRoot.mjs mints one (with `??=`) only for
// a standalone file run that inherited none.
//
// Pure over `snap`: pass a synthesised snapshot to test it without processes.
export function processesWithMarker(marker, snap = snapshot({ environ: true })) {
  if (!marker || !snap.available) return [];
  // MARKER_RE, not a plain `includes` on the needle. THIS is the predicate that
  // holds the kill authority — it feeds sweepOrphans on all four of its triggers
  // — so it is the one that must carry the tighter anchoring, not merely share it
  // with a narrower caller. An earlier revision anchored only the single-pid
  // variant below, which left the loose predicate doing the killing.
  const out = [];
  for (const info of snap.byPid.values()) {
    if (info.pid === process.pid || info.pid <= 1) continue;
    if (markerIn(info.env) !== marker) continue;
    out.push({ pid: info.pid, ident: info.ident, argv: info.argv });
  }
  return out;
}


// processesWithMarker's identity, asked about ONE pid — the same question over
// one /proc/<pid>/environ read instead of a whole /proc walk. Both go through
// markerIn/MARKER_RE and apply the same pid <= 1 and self sentinels, so
// `hasMarker(pid, m)` and `processesWithMarker(m).some(p => p.pid === pid)` agree
// on every input; a caller cannot get a looser verdict by choosing the cheaper
// call. That equivalence is pinned in tests/orphan-reaper.test.mjs — keep it, it
// is what stops one of the two being widened alone.
//
// IT EXISTS TO BE A LICENCE TO KILL. A test that reaps its own child in a
// teardown hook must first establish the child IS its own: fake/injected `spawn`
// stand-ins carry synthetic pids (tests/plugins-supervisor.test.mjs uses
// 900001 + n). pid_max here is 4194304 and live pids have long since wrapped past
// that band — one unrelated live process sat at 1089935 while this was written —
// so a synthetic pid, or the process GROUP -900001, names a stranger. Do not
// re-derive that from a pid census: the point is the WRAP, not any one figure.
// The alternative — a caller-supplied "this one is fake" flag — relocates kill
// authority to the caller instead of closing the class, so it is not offered.
//
// FAILS CLOSED: a vanished pid, an unreadable environ, an absent or empty marker
// all answer false. `read` is injectable so the licence table can be driven
// without real processes.
export function hasMarker(pid, marker, read = p => readFileSync(`/proc/${p}/environ`, 'utf8')) {
  if (!marker) return false;
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  let env;
  try { env = read(pid); } catch { return false; }
  return markerIn(env) === marker;
}

// SIGKILL an explicit, already-ordered list. Entries may be a bare pid or
// `{pid, ident}`; when `ident` is present it is RE-VERIFIED against the live
// process immediately before signalling. Returns the pids actually signalled.
export function killPids(entries, { identOf: identFn = identOf, kill = (pid) => process.kill(pid, 'SIGKILL'), self = process.pid } = {}) {
  const killed = [];
  for (const entry of entries) {
    const pid = typeof entry === 'number' ? entry : entry.pid;
    // `?? null` normalises BOTH null and undefined to "no identity recorded".
    // Without it, an entry written as `{pid}` (no ident key) took the
    // identity-check branch, compared undefined against a live starttime, and was
    // silently SKIPPED — i.e. a process we meant to kill best-effort survived.
    const ident = typeof entry === 'number' ? null : (entry.ident ?? null);
    // Never signal ourselves or the init/process-group sentinel. An earlier
    // revision called killTree(process.pid) at the run cap and SIGKILLed the
    // runner, turning a reportable timeout into a bare exit 137 with no verdict.
    if (pid === self || pid <= 1) continue;
    // Identity re-check. A pid remembered from an earlier tick may since have
    // been recycled onto an unrelated process — unlikely at this box's
    // pid_max, but Termux is an explicit target of this repo and typically
    // runs pid_max 32768, where a long session wraps and we would otherwise
    // SIGKILL a stranger. starttime cannot collide across incarnations.
    if (ident !== null && identFn(pid) !== ident) continue;
    try {
      kill(pid);
      killed.push(pid);
    } catch { /* already gone, or not ours to kill */ }
  }
  return killed;
}

// SIGKILL every descendant of `pid`, leaves-first, WITHOUT touching `pid`.
// Leaves first so a supervisor-shaped parent cannot respawn a child we already
// killed, and so a grandchild holding an inherited stdio pipe is gone before
// the parent that would otherwise be reaped while the pipe stays open.
export function killDescendants(pid, snap = snapshot()) {
  const ordered = [...descendants(pid, snap)].reverse();
  return killPids(ordered.map(p => ({ pid: p, ident: snap.byPid.get(p)?.ident ?? null })));
}

// killDescendants + `pid` itself, last.
export function killTree(pid, snap = snapshot()) {
  return [...killDescendants(pid, snap), ...killPids([{ pid, ident: snap.byPid.get(pid)?.ident ?? null }])];
}

// Of `hits`, the entries STILL carrying `marker` after a bounded settle. Used by
// tests/run.mjs's run-end residual check, which asks it about the set a fresh
// /proc walk just produced.
//
// WHY A LIVE RE-VERIFY AND NOT THE WALK'S OWN ANSWER. `hits` comes from
// processesWithMarker, i.e. from a snapshot, and a snapshot is not evidence of
// liveness: that walk's readdirSync('/proc') samples the pid list microseconds
// after the sweep's kills, so a pid landing early in a ~2700-pid iteration is
// read INSIDE its own death window and reported as alive. Observed at load 25 as
// a false RESIDUAL, with SWEPT naming the same pid on an otherwise healthy run;
// reproducible deterministically (walk, SIGKILL, wait 50ms — the cached environ
// still names it, a live read refuses it). So each candidate is asked again,
// directly.
//
// The re-verify cannot fail the same way round. The stale-snapshot bug produced a
// false ALIVE; a false answer here would need environ to stop answering while the
// process lives, which on Linux means it is gone.
//
// THE BOUND IS THE SECOND CONCERN, not the fix: it only decides how long a
// genuinely-signalled process may take to die. RESIDUAL_SETTLE_MS
// (tests/hangGuardConfig.mjs) owns that number and the reason it is a choice
// rather than a guarantee.
//
// `hasMarker` / `now` / `sleep` are injected so the loop is table-testable with no
// /proc and no real waiting — see tests/orphan-reaper.test.mjs. The production
// path takes every default.
export async function settleResidual(hits, marker, {
  hasMarker: hasMarkerFn = hasMarker,
  settleMs = 0,
  stepMs = 10,
  now = () => Date.now(),
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
} = {}) {
  // The healthy path pays NOTHING — not a sleep, not even a clock read. This is
  // why the settle is free on the overwhelming majority of runs, and it is
  // asserted rather than assumed.
  if (hits.length === 0) return hits;
  const deadline = now() + settleMs;
  for (;;) {
    hits = hits.filter(h => hasMarkerFn(h.pid, marker));
    // Both exits matter: empty means they died, the deadline means one did not
    // and must be REPORTED rather than waited out forever.
    if (hits.length === 0 || now() >= deadline) return hits;
    await sleep(stepMs);
  }
}

// Reap a residual set and describe what happened. Every entry is already licensed
// — it matched this run's marker on a live re-read — so this is the step that
// turns "detected" into "HELD": without it the caller prints its diagnostic, reds
// the run, and then lets teardown remove the run root out from under a live
// process, which is the (deleted)-cwd state the whole ordering exists to prevent.
//
// It is a named unit rather than two inline lines because inline it was
// UNTESTABLE: deleting the kill left every test in the suite green, since the
// diagnostic still printed and the run still went red. Returning `reaped`
// alongside the message puts the action in a return value, so removing or
// short-circuiting it fails a test. The message embeds both counts, so a reap
// that silently signals nothing reads as `RESIDUAL 1 … SIGKILLed 0`.
export function reapResidual(residual, { kill = killPids } = {}) {
  const reaped = kill(residual);
  return {
    reaped,
    message:
      `RESIDUAL ${residual.length} marked process(es) still alive at teardown ` +
      `(pids ${residual.map(r => r.pid).join(',')}); SIGKILLed ${reaped.length}.`,
  };
}

// How many processes anywhere on the box have `substr` in their cmdline.
// Returns -1 when /proc is unavailable, which callers use to distinguish
// "nothing running" from "cannot tell".
export function countMatching(substr, snap = snapshot()) {
  if (!snap.available) return -1;
  let n = 0;
  // Match against the raw NUL-separated command line: the caller is asking a
  // substring question about the whole line, not about one argument.
  for (const info of snap.byPid.values()) if (info.raw.includes(substr)) n++;
  return n;
}
