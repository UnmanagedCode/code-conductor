import type http from 'node:http';
import type express from 'express';

// The framing and MIME-sniffing policy on every response cc itself produces:
// only cc's own origin may frame it. Contract: docs/protocol.md → Response headers.
export const HOST_SECURITY_HEADERS = {
  'x-frame-options': 'SAMEORIGIN',
  'content-security-policy': "frame-ancestors 'self'",
  'x-content-type-options': 'nosniff',
} as const;

const ENFORCED_FRAME_OPTIONS = /^(?:deny|sameorigin)$/i;
const FRAME_ANCESTORS = /(?:^|[;,])\s*frame-ancestors(?=[\s;,]|$)/i;

/** App-level middleware: sets HOST_SECURITY_HEADERS on every response before any route runs. */
export function hostSecurityHeaders(): express.RequestHandler {
  return (_req, res, next) => {
    for (const [name, value] of Object.entries(HOST_SECURITY_HEADERS)) res.setHeader(name, value);
    next();
  };
}

/**
 * A proxied plugin response's headers: removes cc's own policy from `res` (the plugin owns its CSP and
 * its MIME types) and returns a copy of `upstream`. Only an X-Frame-Options of exactly DENY or SAMEORIGIN
 * (trimmed, case-insensitive) or a frame-ancestors directive in its enforcing CSP counts as the plugin's own
 * framing policy; any other X-Frame-Options value (blank, ALLOW-FROM, a list) is replaced, and a page with
 * no such policy gets X-Frame-Options SAMEORIGIN, so it always has an enforceable same-origin default.
 */
export function proxiedPluginHeaders(res: http.ServerResponse, upstream: http.IncomingHttpHeaders): http.IncomingHttpHeaders {
  for (const name of Object.keys(HOST_SECURITY_HEADERS)) res.removeHeader(name);
  const headers = { ...upstream };
  const declared = ENFORCED_FRAME_OPTIONS.test(String(headers['x-frame-options'] ?? '').trim())
    || FRAME_ANCESTORS.test(String(headers['content-security-policy'] ?? ''));
  if (!declared) headers['x-frame-options'] = HOST_SECURITY_HEADERS['x-frame-options'];
  return headers;
}
