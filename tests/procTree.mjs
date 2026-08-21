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
export function snapshot() {
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
    let pgrp = null;
    let ident = null;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // The comm field (2) is parenthesised and may itself contain spaces AND
      // parens, so the only safe split point is the LAST ')'. After it, field N
      // sits at index N-3: ppid is field 4, starttime is field 22.
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const n = Number(f[1]);
      if (Number.isInteger(n)) ppid = n;
      const g = Number(f[2]); // field 5, process group
      if (Number.isInteger(g)) pgrp = g;
      // starttime is the pid's INCARNATION identity: monotonic clock ticks
      // since boot at exec. Two processes that reuse the same pid number
      // cannot share it, which is what makes a remembered pid safe to signal
      // later (see killPids).
      if (/^\d+$/.test(f[19] ?? '')) ident = f[19];
    } catch { /* vanished between readdir and read */ }
    let raw = '';
    try { raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { /* ditto */ }
    byPid.set(pid, { pid, ppid, pgrp, ident, raw, argv: raw.split('\0').filter(Boolean) });
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

// Processes that were orphaned OUT of our own job — i.e. almost certainly a
// grandchild whose test-child parent has exited. This is the only discovery path
// that works for a file which completed inside one sampler tick (never recorded)
// AND whose child has since died (reparented, so unreachable by descendants()).
//
// Three conjuncts, and each one is load-bearing for SAFETY:
//   * same process group as us — scopes it to our job, so an unrelated system
//     daemon can never match;
//   * ppid === 1 — it has actually been orphaned. This is what excludes a
//     sibling in the user's shell PIPELINE (`node tests/run.mjs | tee log`),
//     whose parent is the still-live shell. Killing that would be catastrophic
//     and is the reason a bare same-pgrp match was rejected;
//   * started after us — it cannot be something that predates this run.
// A `detached: true` child escapes into a NEW process group and is deliberately
// NOT matched here; see the sweep note in tests/run.mjs for why that case is
// handled by abandoning the wait rather than by killing.
export function orphansInOurGroup(snap = snapshot()) {
  if (!snap.available) return [];
  const self = snap.byPid.get(process.pid);
  if (!self || self.pgrp === null || self.ident === null) return [];
  const out = [];
  for (const info of snap.byPid.values()) {
    if (info.pid === process.pid || info.pid <= 1) continue;
    if (info.pgrp !== self.pgrp) continue;
    if (info.ppid !== 1) continue;
    if (info.ident === null || Number(info.ident) <= Number(self.ident)) continue;
    out.push({ pid: info.pid, ident: info.ident, argv: info.argv });
  }
  return out;
}

// SIGKILL an explicit, already-ordered list. Entries may be a bare pid or
// `{pid, ident}`; when `ident` is present it is RE-VERIFIED against the live
// process immediately before signalling. Returns the pids actually signalled.
export function killPids(entries) {
  const killed = [];
  for (const entry of entries) {
    const pid = typeof entry === 'number' ? entry : entry.pid;
    const ident = typeof entry === 'number' ? null : entry.ident;
    // Never signal ourselves or the init/process-group sentinel. An earlier
    // revision called killTree(process.pid) at the run cap and SIGKILLed the
    // runner, turning a reportable timeout into a bare exit 137 with no verdict.
    if (pid === process.pid || pid <= 1) continue;
    // Identity re-check. A pid remembered from an earlier tick may since have
    // been recycled onto an unrelated process — unlikely at this box's
    // pid_max, but Termux is an explicit target of this repo and typically
    // runs pid_max 32768, where a long session wraps and we would otherwise
    // SIGKILL a stranger. starttime cannot collide across incarnations.
    if (ident !== null && identOf(pid) !== ident) continue;
    try {
      process.kill(pid, 'SIGKILL');
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
