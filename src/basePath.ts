import type { NextFunction, Request, RequestHandler, Response } from 'express';

// The URL path prefix cc is hosted under behind a reverse proxy (CC_BASE_PATH).
// Fixed at startup. The server accepts a path with or without the prefix: the
// prefix is stripped from the request URL before routing, so every mount stays
// at root and loopback callers (hook URLs, CONDUCTOR_URL, /mcp) keep working.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// RFC 3986 unreserved characters only: a base is spliced into rewritten HTML
// attributes (rewritePluginHostUrls), so no quote, angle bracket or ampersand may ever pass.
const SEGMENT_RE = /^[A-Za-z0-9._~-]+$/;

// A plugin id (src/plugins/): the form `/plugins/<id>` takes in a base.
const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*$/;

const WEB_PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public');

// The first path segments cc itself serves at root: the mounts of server.ts and
// pluginThemeRouter, the upgrade dispatcher's /ws, the web build's asset dir
// and index, and every file of web/public (copied to the build root).
// tests/base-path.test.mjs checks the mounts against the source.
const ROOT_MOUNTS = ['api', 'mcp', 'ws', 'plugins', 'pluginBridge.js', 'pluginTheme.css', 'pluginTheme', 'assets', 'index.html'];

// Lowercase: Express routes case-insensitively, so `/API` reaches the same mount as `/api`.
// A missing or unreadable web/public degrades to the mounts alone, with a warning.
export function reservedRootSegments(publicDir: string = WEB_PUBLIC): Set<string> {
  let files: string[] = [];
  try { files = fs.readdirSync(publicDir); }
  catch (e) { console.warn(`CC_BASE_PATH: cannot read ${publicDir} (${(e as Error).message}); reserved names are the mounts only`); }
  return new Set([...ROOT_MOUNTS, ...files].map((n) => n.toLowerCase()));
}

// '' = root. Throws on a value that cannot be a path prefix.
// `reservedOf` is read only when a base is set: no base never touches the filesystem.
export function parseBasePath(raw?: string | null, reservedOf: () => Set<string> = reservedRootSegments): string {
  if (raw === undefined || raw === null || raw === '' || raw === '/') return '';
  if (!raw.startsWith('/')) throw new Error(`CC_BASE_PATH must start with '/': ${JSON.stringify(raw)}`);
  const trimmed = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  const segments = trimmed.slice(1).split('/');
  // `/plugins/<id>[/…]` is the one reserved prefix a base may take: cc hosted as a plugin of another cc.
  const asPlugin = segments[0] === 'plugins' && segments.length >= 2 && PLUGIN_ID_RE.test(segments[1]!);
  if (reservedOf().has(segments[0]!.toLowerCase()) && !asPlugin) {
    throw new Error(`CC_BASE_PATH ${JSON.stringify(raw)} starts with '${segments[0]}', a path cc serves at root`);
  }
  for (const seg of segments) {
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
