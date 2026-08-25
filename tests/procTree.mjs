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
  // The trailing '\0' ANCHORS the needle. /proc/<pid>/environ is a sequence of
  // NUL-terminated entries (verified: the final entry is terminated too), so this
  // makes the match exact for free. Without it, one marker being a strict prefix
  // of another means an inner runner's sweep matches an OUTER runner's marker and
  // SIGKILLs the outer run's processes — measured with an 8-char marker: the outer
  // file died at 3.8s having reported 5 of 16 cases. Nothing here should depend on
  // mkdtemp's fixed-width suffix, which is a fact of tests/safeStoreRoot.mjs and
  // not of this predicate.
  //
  // Write it as the ESCAPE '\0', never a literal NUL byte: a literal would make
  // git render every diff of this file as binary.
  const needle = `CC_TEST_RUN_ID=${marker}\0`;
  const out = [];
  for (const info of snap.byPid.values()) {
    if (info.pid === process.pid || info.pid <= 1) continue;
    if (!info.env || !info.env.includes(needle)) continue;
    out.push({ pid: info.pid, ident: info.ident, argv: info.argv });
  }
  return out;
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
