// Per-project git-facts cache with short-TTL and in-flight coalescing.
//
// Problem: GET /api/projects fans out concurrent git subprocesses (isGitRepo,
// listWorktrees, getWorktreeMergeStatus×N, getProjectUpstreamStatus) for every
// project on every request. The sidebar re-fetches on every `t:'projects'`
// broadcast, which fires on almost every instance status change. On Termux the
// git subprocess startup cost starves the event loop.
//
// Solution:
//   1. In-flight coalescing — concurrent requests share one computation so a
//      simultaneous burst of refreshes triggers only one git fan-out.
//   2. Short TTL (default 2 s) — sequential refreshes within the TTL are served
//      from the cache. Staleness is bounded and acceptable for passive sidebar
//      updates; targeted invalidate() calls cover every user-triggered mutation
//      (merge/sync/worktree delete/instance spawn-exit) so those always see fresh
//      state immediately.
//
// A generation counter prevents an in-flight result that completes after an
// invalidate() call from being written back as fresh data.

const PRODUCTION_TTL_MS = 2000;

// Mutable so tests can call _resetForTest(0) for pure-coalescing semantics
// without any TTL caching (integration tests need exact, uncached responses).
let _ttlMs = PRODUCTION_TTL_MS;

// Map<string, { data: any, ts: number, inflight: Promise|null, gen: number }>
const _entries = new Map();

/**
 * Return cached git facts for `key`, or compute them via `computeFn()`.
 *
 * - If a fresh entry (age < _ttlMs) exists, return it immediately.
 * - If a computation is already in-flight, return the same Promise (coalescing).
 * - Otherwise start computeFn(), store the in-flight Promise, cache the result.
 */
export async function getOrCompute(key, computeFn) {
  const entry = _entries.get(key);
  const now = Date.now();

  if (entry?.data !== null && entry?.ts && now - entry.ts < _ttlMs) {
    return entry.data;
  }

  if (entry?.inflight) {
    return entry.inflight;
  }

  const gen = entry?.gen ?? 0;

  const inflight = computeFn()
    .then((data) => {
      const cur = _entries.get(key);
      if (cur?.gen === gen) {
        _entries.set(key, { data, ts: Date.now(), inflight: null, gen });
      }
      return data;
    })
    .catch((err) => {
      const cur = _entries.get(key);
      if (cur?.gen === gen) {
        _entries.set(key, { data: null, ts: 0, inflight: null, gen });
      }
      throw err;
    });

  _entries.set(key, { data: entry?.data ?? null, ts: entry?.ts ?? 0, inflight, gen });
  return inflight;
}

/**
 * Invalidate the cached entry for a single project. Any in-flight computation
 * for this key will complete but its result will not be stored. The next call
 * to getOrCompute() starts a fresh computation.
 */
export function invalidate(key) {
  const entry = _entries.get(key);
  _entries.set(key, { data: null, ts: 0, inflight: null, gen: (entry?.gen ?? 0) + 1 });
}

/**
 * Invalidate all cached entries. Called on list_changed (instance spawn/exit)
 * since we don't know which project was affected.
 */
export function invalidateAll() {
  for (const [key, entry] of _entries) {
    _entries.set(key, { data: null, ts: 0, inflight: null, gen: (entry.gen ?? 0) + 1 });
  }
}

/**
 * Reset state for tests. Clears all entries and sets the TTL.
 * Default ttlMs=0 gives pure-coalescing semantics: requests that overlap an
 * in-flight computation coalesce, but completed results are never served from
 * cache — integration tests always get exact, live data.
 */
export function _resetForTest(ttlMs = 0) {
  _entries.clear();
  _ttlMs = ttlMs;
}
