// The suite's ONLY /proc reader. Both the fake-claude process-count guardrail
// and the hang guard's per-file kill watchdog go through here, so there is one
// implementation of "what is running" rather than one per caller.
//
// /proc reads are safe on this host; `pkill` / `lsof` are NOT — do not add a
// shell-based fallback here (see the note above countFakeClaudeProcs's caller
// in tests/run.mjs). On a non-Linux host /proc is absent and every function
// below degrades to "I can see nothing" (-1 / empty), never a throw: the guard
// failing must not become a new failure class.
//
// Everything is built on ONE snapshot() per sampling tick. The watchdog asks
// several questions each tick (peak fake-claude count, which children are
// alive, what they have spawned); answering each with its own /proc walk would
// multiply the sampler's cost by the number of questions AND let the answers
// disagree with each other mid-tick.

import { readdirSync, readFileSync } from 'node:fs';

// A single consistent read of every visible process. `null` pids means /proc is
// unavailable, which callers distinguish from "nothing is running".
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
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Field 4 is the parent pid. The comm field (2) is parenthesised and may
      // itself contain spaces AND parens, so the only safe split point is the
      // LAST ')'.
      const n = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (Number.isInteger(n)) ppid = n;
    } catch { /* vanished between readdir and read */ }
    let raw = '';
    try { raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { /* ditto */ }
    byPid.set(pid, { pid, ppid, raw, argv: raw.split('\0').filter(Boolean) });
    if (ppid !== null) {
      if (!byParent.has(ppid)) byParent.set(ppid, []);
      byParent.get(ppid).push(pid);
    }
  }
  return { available: true, byPid, byParent };
}

// Direct children of `ppid`, as [{ pid, argv }]. `argv` is the split argument
// vector (not a joined string) because the caller matches on an exact
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

// SIGKILL an explicit list of pids, LEAVES-LAST callers beware: pass the list
// already ordered. Returns the pids actually signalled.
export function killPids(pids) {
  const killed = [];
  for (const pid of pids) {
    // Never signal ourselves or the process group. An earlier revision called
    // killTree(process.pid) at the run cap and SIGKILLed the runner, which
    // turned a reportable timeout into a bare exit 137 with no verdict.
    if (pid === process.pid || pid <= 1) continue;
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
  return killPids([...descendants(pid, snap)].reverse());
}

// killDescendants + `pid` itself, last.
export function killTree(pid, snap = snapshot()) {
  return killPids([...descendants(pid, snap)].reverse().concat(pid));
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
