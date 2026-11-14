import express from 'express';
import { getAccountUsage } from '../accountUsage.ts';
import type { ClaudeAuthStatus } from '../claudeAuthStatus.ts';
import type { ClaudeLoginFlow } from '../claudeLogin.ts';
import { getCostSummary, getSessionStats } from '../costTracking.ts';
import { httpError, errMessage } from '../httpError.ts';
import { jsonBody } from './shared.ts';

export function mountAccount(r: express.Router, { claudeLogin, claudeAuthStatus }: { claudeLogin?: ClaudeLoginFlow | null; claudeAuthStatus?: (() => Promise<ClaudeAuthStatus>) | null }): void {
  // Account-level usage from the Anthropic OAuth endpoint. Cached server-side
  // for 180 s. allowStale lets this route serve the last retained payload
  // (with stale: true) when a fresh fetch isn't available, instead of
  // blanking the chip — see src/accountUsage.ts. Returns
  // { usage: <data>|null, stale, fetchedAt } — never exposes the raw token.
  r.get('/usage', async (_req, res, next) => {
    try {
      const result = await getAccountUsage({ allowStale: true });
      if (!result) return res.json({ usage: null, stale: false, fetchedAt: null });
      // getAccountUsage's declared union collapses to `unknown` (AccountUsageData
      // is unknown); with allowStale every non-null return is the stale-result
      // shape, so narrow to it here.
      const r = result as { data: unknown; stale: boolean; fetchedAt: number };
      res.json({ usage: r.data, stale: r.stale, fetchedAt: r.fetchedAt });
    } catch (e) { next(e); }
  });

  // Settings → Account's Claude login: the CLI's own `auth status`, and the one
  // `claude auth login` flow createServer owns (src/claudeLogin.ts). Every
  // login response is the flow's snapshot, which never carries the code.
  const loginFlow = (): ClaudeLoginFlow => {
    if (!claudeLogin) throw httpError(503, 'login flow unavailable');
    return claudeLogin;
  };
  r.get('/claude-auth/status', async (_req, res, next) => {
    try {
      if (!claudeAuthStatus) throw httpError(503, 'Claude auth status unavailable');
      // A CLI that cannot be run or answers garbage is the upstream's failure.
      res.json(await claudeAuthStatus().catch((e: unknown) => { throw httpError(502, errMessage(e)); }));
    } catch (e) { next(e); }
  });
  r.get('/claude-auth/login', (_req, res, next) => {
    try { res.json(loginFlow().snapshot()); } catch (e) { next(e); }
  });
  r.post('/claude-auth/login', (_req, res, next) => {
    try { res.json(loginFlow().start()); } catch (e) { next(e); }
  });
  r.post('/claude-auth/login/code', (req, res, next) => {
    try { res.json(loginFlow().submitCode(jsonBody(req).code)); } catch (e) { next(e); }
  });
  r.post('/claude-auth/login/cancel', (_req, res, next) => {
    try { res.json(loginFlow().cancel()); } catch (e) { next(e); }
  });

  r.get('/costs/summary', async (_req, res, next) => {
    try { res.json(await getCostSummary()); } catch (e) { next(e); }
  });

  r.get('/costs/session/:sessionId', async (req, res, next) => {
    try { res.json(await getSessionStats(req.params.sessionId)); } catch (e) { next(e); }
  });
}
