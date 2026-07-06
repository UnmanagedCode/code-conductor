// Fetches account-level usage from the Anthropic OAuth endpoint and caches
// the result for 180 s so the chip/popup don't hammer the API on every render
// (the endpoint itself only replenishes ~once per 120 s and exposes no useful
// ratelimit headers, so polling less often is the only lever that works).
// Credentials are read from ~/.claude/.credentials.json (claudeAiOauth.accessToken).
// Returns null on any error (missing file, 401, network) — never throws.
//
// Callers get strict fresh-or-null by default. Passing `allowStale: true`
// (used only by the GET /api/usage route, for the UI chip) additionally serves
// the last retained payload — wrapped as { data, stale, fetchedAt } — when a
// fresh fetch isn't available, capped at `maxStaleMs` so the chip never shows
// arbitrarily old data. The overage-trip monitor and auto-resume controller
// must never see stale data (it could mis-trip a threshold or resume a session
// still under a limit), so they call getAccountUsage() with no options.
//
// No anthropic-beta header is sent: the OAuth usage endpoint graduated from
// beta (originally oauth-2025-04-20) and now rejects the stale header.

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_TTL_MS  = 180_000;
const BASE_RETRY_MS = 10_000;       // base backoff delay after a failed fetch
const MAX_RETRY_MS  = 5 * 60_000;   // ceiling for both Retry-After and exponential backoff

let _cache      = { data: null, fetchedAt: 0 };
let _retryState = { failureCount: 0, nextAllowedAt: 0 };

// Parse the Retry-After response header. Returns milliseconds to wait, or null
// if the header is absent or unparseable.
// Supports both delta-seconds ("120") and HTTP-date ("Wed, 22 Jun 2026 14:00:00 GMT").
// `now` is the caller's logical current time so tests can inject a fixed clock.
function parseRetryAfter(header, now) {
  if (!header) return null;
  const delta = Number(header);
  if (Number.isFinite(delta) && delta >= 0) return delta * 1000;
  const date = new Date(header);
  if (!isNaN(date.getTime())) return Math.max(0, date.getTime() - now);
  return null;
}

// Exponential backoff: BASE * 2^n, capped at MAX, with ±25% jitter.
// `rand` is injectable (pass 0.5 for deterministic zero-jitter in tests).
function computeBackoff(failureCount, rand) {
  const exp    = Math.min(failureCount, 8); // cap exponent; 2^8 * 10s >> MAX anyway
  const base   = BASE_RETRY_MS * Math.pow(2, exp);
  const capped = Math.min(base, MAX_RETRY_MS);
  const jitter = capped * 0.25 * (2 * rand - 1); // ±25%
  return Math.max(BASE_RETRY_MS, Math.round(capped + jitter));
}

async function readOauthToken(home = os.homedir()) {
  const credPath = path.join(home, '.claude', '.credentials.json');
  let raw;
  try {
    raw = await fsp.readFile(credPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

// Returns { data, status, retryAfterHeader } so the caller can compute the
// appropriate retry delay with access to its injected clock.
async function fetchFromApi(token) {
  const res = await fetch(USAGE_URL, {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
    // Bound the request so a hung connection can't pile up across the server-side
    // usage-poll cycles (or stall a chip refresh). Abort surfaces as a thrown
    // error → getAccountUsage()'s catch returns null.
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // Only 429 and 503 carry a meaningful Retry-After; others are ignored.
    const retryAfterHeader = (res.status === 429 || res.status === 503)
      ? res.headers.get('Retry-After')
      : null;
    return { data: null, status: res.status, retryAfterHeader };
  }
  return { data: await res.json(), status: res.status, retryAfterHeader: null };
}

// When a fresh fetch isn't available and allowStale is set, serve the last
// retained payload as long as it isn't older than maxStaleMs. Returns null
// otherwise (nothing usable to serve, stale or fresh).
function maybeServeStale(now, maxStaleMs) {
  if (_cache.data !== null && now - _cache.fetchedAt < maxStaleMs) {
    return { data: _cache.data, stale: true, fetchedAt: _cache.fetchedAt };
  }
  return null;
}

// _now and _random are test seams — production callers omit them.
//
// allowStale/maxStaleMs are opt-in (default: strict fresh-or-null, unchanged
// from before). With allowStale: true the return shape becomes
// { data, stale, fetchedAt } | null instead of the raw data | null — only the
// GET /api/usage route opts in; every other caller must keep seeing the plain
// strict shape.
export async function getAccountUsage({
  home, _now = Date.now, _random = Math.random,
  allowStale = false, maxStaleMs = 15 * 60_000,
} = {}) {
  const now = _now();

  // 1. Valid success cache.
  if (_cache.data !== null && now - _cache.fetchedAt < CACHE_TTL_MS) {
    return allowStale ? { data: _cache.data, stale: false, fetchedAt: _cache.fetchedAt } : _cache.data;
  }

  // 2. Still inside a backoff / Retry-After window.
  if (now < _retryState.nextAllowedAt) {
    return allowStale ? maybeServeStale(now, maxStaleMs) : null;
  }

  try {
    const token = await readOauthToken(home);
    if (!token) return allowStale ? maybeServeStale(now, maxStaleMs) : null;

    const { data, status, retryAfterHeader } = await fetchFromApi(token);

    if (data !== null) {
      _cache      = { data, fetchedAt: now };
      _retryState = { failureCount: 0, nextAllowedAt: 0 };
      return allowStale ? { data, stale: false, fetchedAt: now } : data;
    }

    // Non-OK response: honour Retry-After if present, else exponential backoff.
    // Floor at BASE_RETRY_MS so Retry-After: 0 (or any sub-floor value) never
    // produces an immediate re-poll.
    const retryAfterMs = parseRetryAfter(retryAfterHeader, now);
    const delay = Math.max(BASE_RETRY_MS, retryAfterMs !== null
      ? Math.min(retryAfterMs, MAX_RETRY_MS)
      : computeBackoff(_retryState.failureCount, _random()));
    _retryState = { failureCount: _retryState.failureCount + 1, nextAllowedAt: now + delay };
    console.warn(`${new Date().toISOString()} [accountUsage] Anthropic OAuth usage API returned ${status} — chip will be hidden until this resolves. Next retry in ${Math.round(delay / 1000)}s (failure #${_retryState.failureCount})`);
    return allowStale ? maybeServeStale(now, maxStaleMs) : null;

  } catch {
    // Network error / timeout — apply backoff silently (no status to report).
    const delay = computeBackoff(_retryState.failureCount, _random());
    _retryState = { failureCount: _retryState.failureCount + 1, nextAllowedAt: now + delay };
    return allowStale ? maybeServeStale(now, maxStaleMs) : null;
  }
}

// Exposed for tests so they can reset the cache and retry state between runs.
export function _resetCache() {
  _cache      = { data: null, fetchedAt: 0 };
  _retryState = { failureCount: 0, nextAllowedAt: 0 };
}
