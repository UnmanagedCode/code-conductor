// Fetches account-level usage from the Anthropic OAuth endpoint and caches
// the result for 60 s so the chip/popup don't hammer the API on every render.
// Credentials are read from ~/.claude/.credentials.json (claudeAiOauth.accessToken).
// Returns null on any error (missing file, 401, network) — never throws.
//
// No anthropic-beta header is sent: the OAuth usage endpoint graduated from
// beta (originally oauth-2025-04-20) and now rejects the stale header.

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_TTL_MS = 60_000;
const CACHE_NULL_TTL_MS = 10_000; // retry sooner after a failed fetch

let _cache = { data: null, fetchedAt: 0 };

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

async function fetchFromApi(token) {
  const res = await fetch(USAGE_URL, {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    console.warn(`[accountUsage] Anthropic OAuth usage API returned ${res.status} — chip will be hidden until this resolves`);
    return null;
  }
  return res.json();
}

export async function getAccountUsage({ home } = {}) {
  const now = Date.now();
  if (now - _cache.fetchedAt < (_cache.data !== null ? CACHE_TTL_MS : CACHE_NULL_TTL_MS)) {
    return _cache.data;
  }
  try {
    const token = await readOauthToken(home);
    if (!token) return null;
    const data = await fetchFromApi(token);
    _cache = { data: data ?? null, fetchedAt: now };
    return _cache.data;
  } catch {
    return null;
  }
}

// Exposed for tests so they can reset the cache between runs.
export function _resetCache() {
  _cache = { data: null, fetchedAt: 0 };
}
