// When a session transcript was last *actually* active — the `timestamp` on the
// LAST timestamped record in the jsonl, not the file's mtime.
//
// "Last in file order", not "newest by value": records are appended in real
// time, so the two agree except where interleaved sidechain records land a few
// ms out of order. Immaterial to ordering between sessions, and reading in file
// order is what lets the scan stop at the first hit instead of parsing the
// whole tail.
//
// Why mtime is wrong: the Claude CLI appends untimestamped bookkeeping records
// (`last-prompt`, `mode`, `ai-title`, `queue-operation`) as its process exits,
// and `writeSessionMetadata` appends its own marker pair. When a batch of live
// subprocesses dies together — a server drain/restart — every one of those
// files gets an mtime within milliseconds of the others, hours or days after
// the sessions they describe actually stopped. Sorting on mtime then sorts on
// noise and collapses distinct sessions into one indistinguishable minute.
// Those bookkeeping records carry no `timestamp`, so a reverse scan skips past
// them and lands on real content.
//
// The reader is a bounded tail read, and its result is memoized per file, so a
// fan-out across every project costs readdir + stat + a Map lookup in the
// steady state — the property the "no opens" walk was protecting.

import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';

// Enough tail to clear the untimestamped bookkeeping records plus the final
// real record. A record longer than this (a huge tool result as the very last
// content) falls back to mtime rather than reading the whole file: the fallback
// is today's value, so the pathological case degrades to current behaviour.
const TAIL_BYTES = 64 * 1024;

// Bounded so a long-lived server fanning out over every project can't grow the
// map without limit as sessions are created and deleted. ~200 bytes an entry,
// and ~6x the transcript count of a busy projects root, so eviction is the rare
// case rather than the steady state.
export const LAST_ACTIVITY_CACHE_MAX = 5000;

// The identity + change-detection tuple, all read off the stat the caller
// already has.
//
// `ctimeMs` is what makes the key sound. It cannot be rolled back from
// userspace — there is no syscall to set it, and utimes bumps it — so it
// invalidates even an in-place rewrite that restores mtime and preserves size,
// which `mtimeMs`/`size` alone would miss. `mtimeMs`/`size` are what make the
// common case (an append) invalidate without depending on ctime semantics.
//
// `dev`/`ino` are REDUNDANT against every writer in this repo: the two that
// replace a transcript (sessionEdit's fork, sessionPrune) go tmp+rename, and a
// rename-over sets a fresh ctime, so ctime already catches them. They are kept
// as a cheap guard against a future writer that replaces a file without moving
// ctime — not because any current path needs them. No test isolates them,
// because with ctime in the key the case isn't constructible.
//
// Together these leave no reachable stale entry, which is why there is no TTL:
// a TTL would only be a hedge against an unsound key.
interface Entry {
  dev: number;
  ino: number;
  ctimeMs: number;
  mtimeMs: number;
  size: number;
  lastActivity: number;
}

function matches(e: Entry, st: Stats): boolean {
  return e.dev === st.dev && e.ino === st.ino && e.ctimeMs === st.ctimeMs
    && e.mtimeMs === st.mtimeMs && e.size === st.size;
}

// The `timestamp` on the last timestamped record within the file's final
// TAIL_BYTES, as epoch ms, or null when the tail holds no parseable one.
async function readTailTimestamp(full: string, size: number): Promise<number | null> {
  const fh = await fs.open(full, 'r');
  try {
    const len = Math.min(TAIL_BYTES, size);
    if (len <= 0) return null;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, size - len);
    // The first line is very likely a fragment of a record straddling the read
    // boundary; it simply fails to parse and the scan continues past it.
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj: unknown;
      try { obj = JSON.parse(line); } catch { continue; }
      if (typeof obj !== 'object' || obj === null) continue;
      const ts = (obj as { timestamp?: unknown }).timestamp;
      if (typeof ts !== 'string') continue;
      const parsed = Date.parse(ts);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  } finally {
    await fh.close();
  }
}

export interface LastActivityCache {
  // Epoch ms. Takes the caller's existing Stats so this adds no stat call.
  lastActivityOf(full: string, st: Stats): Promise<number>;
  // Whether a path is still resident — i.e. has not been evicted. Says nothing
  // about whether the entry is still VALID for the file's current stat.
  has(full: string): boolean;
  size(): number;
}

// LRU over a plain Map: Map iterates in insertion order, so re-inserting on a
// hit makes `keys().next()` the least-recently-USED key rather than merely the
// oldest-inserted one.
export function createLastActivityCache({ max = LAST_ACTIVITY_CACHE_MAX }: { max?: number } = {}): LastActivityCache {
  const cache = new Map<string, Entry>();
  return {
    async lastActivityOf(full: string, st: Stats): Promise<number> {
      const hit = cache.get(full);
      if (hit && matches(hit, st)) {
        cache.delete(full);
        cache.set(full, hit);
        return hit.lastActivity;
      }
      let ts: number | null = null;
      try { ts = await readTailTimestamp(full, st.size); }
      catch { /* unreadable tail — fall back to mtime below */ }
      const lastActivity = ts ?? st.mtimeMs;
      cache.delete(full);
      cache.set(full, {
        dev: st.dev, ino: st.ino, ctimeMs: st.ctimeMs,
        mtimeMs: st.mtimeMs, size: st.size, lastActivity,
      });
      if (cache.size > max) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      return lastActivity;
    },
    has(full: string): boolean { return cache.has(full); },
    size(): number { return cache.size; },
  };
}

// In-memory only, process-lifetime. Never persisted: it is derivable from the
// transcripts in one bounded pass, and a persisted copy would be a second
// source of truth that could outlive the files it describes.
const shared = createLastActivityCache();

export function lastActivityOf(full: string, st: Stats): Promise<number> {
  return shared.lastActivityOf(full, st);
}
