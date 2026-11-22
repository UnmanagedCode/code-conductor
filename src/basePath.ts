import type { NextFunction, Request, RequestHandler, Response } from 'express';

// The URL path prefix cc is hosted under behind a reverse proxy (CC_BASE_PATH).
// Fixed at startup. The server accepts a path with or without the prefix: the
// prefix is stripped from the request URL before routing, so every mount stays
// at root and loopback callers (hook URLs, CONDUCTOR_URL, /mcp) keep working.

// RFC 3986 pchar minus '%': a literal segment character.
const SEGMENT_RE = /^[A-Za-z0-9\-._~!$&'()*+,;=:@]+$/;

// '' = root. Throws on a value that cannot be a path prefix.
export function parseBasePath(raw?: string | null): string {
  if (raw === undefined || raw === null || raw === '' || raw === '/') return '';
  if (!raw.startsWith('/')) throw new Error(`CC_BASE_PATH must start with '/': ${JSON.stringify(raw)}`);
  const trimmed = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  for (const seg of trimmed.slice(1).split('/')) {
    if (seg === '' || seg === '.' || seg === '..' || !SEGMENT_RE.test(seg)) {
      throw new Error(`CC_BASE_PATH has an invalid segment ${JSON.stringify(seg)}: ${JSON.stringify(raw)}`);
    }
  }
  return trimmed;
}

// `url` is a request target (path + optional query). A bare base redirects to
// the trailing-slash form so relative asset URLs resolve under it.
export function stripBasePath(base: string, url: string): { url: string } | { redirect: string } {
  if (base === '') return { url };
  if (url === base) return { redirect: `${base}/` };
  if (url.startsWith(`${base}?`)) return { redirect: `${base}/${url.slice(base.length)}` };
  if (url.startsWith(`${base}/`)) return { url: url.slice(base.length) };
  return { url };
}

export function basePathMiddleware(base: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (base === '') return next();
    const r = stripBasePath(base, req.url);
    if ('redirect' in r) {
      res.redirect(301, r.redirect);
      return;
    }
    req.url = r.url;
    next();
  };
}
