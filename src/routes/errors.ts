import express from 'express';
import { errMessage } from '../httpError.ts';

// Upper bound, in characters, on everything the trailing error middleware logs
// for one error (its line plus, for a 5xx, the stack frames). Some refusals
// quote a caller-supplied value in their message, which may be megabytes.
export const ROUTE_ERROR_LOG_MAX = 4096;
const ROUTE_ERROR_URL_MAX = 512;
const ROUTE_ERROR_MESSAGE_MAX = 1024;
const ROUTE_ERROR_FRAMES_MAX = 12;
const ROUTE_ERROR_FRAME_MAX = 160;

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// The one log entry for a route error: method, route, status and the clipped
// message, then (5xx only) the clipped stack frames — never the message again,
// which `stack` leads with.
function routeErrorLog(method: string, url: string, status: number, err: unknown): string {
  let out = `routes: ${method} ${clip(url, ROUTE_ERROR_URL_MAX)} → ${status}: ${clip(errMessage(err), ROUTE_ERROR_MESSAGE_MAX)}`;
  const stack = (err as { stack?: unknown } | null)?.stack;
  if (status >= 500 && typeof stack === 'string') {
    const frames = stack.split('\n').filter(l => /^\s+at /.test(l)).slice(0, ROUTE_ERROR_FRAMES_MAX);
    if (frames.length) out += '\n' + frames.map(f => clip(f, ROUTE_ERROR_FRAME_MAX)).join('\n');
  }
  return clip(out, ROUTE_ERROR_LOG_MAX);
}

// A thrown error's `code` reaches the body only on a deliberate refusal — one that
// carries a `statusCode` (httpError, systemRefusal); a raw fs/OS errno stays internal.
export function errorBody(err: unknown): { error: string; code?: string } {
  const e = err as { statusCode?: unknown; code?: unknown } | null;
  const code = e && typeof e === 'object' && typeof e.statusCode === 'number' && typeof e.code === 'string' ? e.code : undefined;
  return { error: errMessage(err), ...(code !== undefined ? { code } : {}) };
}

// The trailing error middleware: every route's next(err) lands here.
export function mountErrorHandler(r: express.Router): void {
  r.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (err as { statusCode?: number } | null)?.statusCode ?? 500;
    const entry = routeErrorLog(req.method, req.originalUrl, status, err);
    if (status >= 500) console.error(entry); else console.warn(entry);
    res.status(status).json(errorBody(err));
  });
}
