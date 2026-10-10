// Live mode's credentials: an access-token-only copy of the CLI's credentials
// file, and the one-field global config a fresh CLAUDE_CONFIG_DIR needs. Both
// functions take every path explicitly; nothing here defaults to the live
// config dir, and both refuse to write inside it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerSecret } from './redact.ts';

// The claudeAiOauth fields the copy keeps. An allowlist, so the refresh token
// and any field a later CLI adds stay behind.
const KEPT_FIELDS = ['accessToken', 'expiresAt', 'scopes', 'subscriptionType', 'rateLimitTier'] as const;

const DEFAULT_BUDGET_MIN = 60;

/** How long the copied access token must stay valid: CC_E2E_LIVE_BUDGET_MIN minutes, default 60. */
export function liveBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CC_E2E_LIVE_BUDGET_MIN;
  if (raw === undefined || raw === '') return DEFAULT_BUDGET_MIN * 60_000;
  const min = Number(raw);
  if (!Number.isFinite(min) || min < 0) throw new Error(`CC_E2E_LIVE_BUDGET_MIN must be a number of minutes, got ${JSON.stringify(raw)}`);
  return min * 60_000;
}

const inside = (dir: string, p: string): boolean => {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export function prepareLiveCredentials(
  { source, dest, now, budgetMs }: { source: string; dest: string; now: number; budgetMs: number },
): { expiresAt: number } {
  if (inside(path.dirname(source), dest)) {
    throw new Error(`live mode: refusing to write the credentials copy to ${dest}, inside the live config dir ${path.dirname(source)}`);
  }
  let raw: string;
  try { raw = fs.readFileSync(source, 'utf8'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`live mode: no Claude credentials at ${source}; log in first`);
    throw new Error(`live mode: cannot read ${source}: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  let oauth: Record<string, unknown> | undefined;
  try { oauth = (JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth; }
  catch { throw new Error(`live mode: ${source} is not JSON`); }
  const token = oauth?.accessToken;
  const expiresAt = oauth?.expiresAt;
  if (typeof token !== 'string' || token === '' || typeof expiresAt !== 'number') {
    throw new Error(`live mode: credentials file has no access token (${source})`);
  }
  registerSecret(token);
  if (expiresAt < now + budgetMs) {
    throw new Error(`live mode: the access token expires at ${new Date(expiresAt).toISOString()}, inside the `
      + `${budgetMs / 60_000} min budget (CC_E2E_LIVE_BUDGET_MIN); refresh it by using the CLI, then re-run`);
  }
  const kept: Record<string, unknown> = {};
  for (const k of KEPT_FIELDS) if (oauth![k] !== undefined) kept[k] = oauth![k];
  fs.writeFileSync(dest, JSON.stringify({ claudeAiOauth: kept }), { mode: 0o600 });
  fs.chmodSync(dest, 0o600);
  return { expiresAt };
}

// The CLI reads its global config from <CLAUDE_CONFIG_DIR>/.claude.json once
// the dir is pinned; a fresh one has none, so the first-run onboarding flag is
// seeded. Only that flag: nothing is read from, or copied out of, the live one.
export function seedLiveGlobalConfig({ dest, liveConfigDir }: { dest: string; liveConfigDir: string }): void {
  if (inside(liveConfigDir, dest) || path.resolve(dest) === path.join(os.homedir(), '.claude.json')) {
    throw new Error(`live mode: refusing to seed ${dest}, a live Claude config location`);
  }
  fs.writeFileSync(dest, JSON.stringify({ hasCompletedOnboarding: true }));
}
