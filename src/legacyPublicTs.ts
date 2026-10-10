// Serves the shared public/*.ts modules to the old UI as plain JS: GET/HEAD
// /<name>.ts and /legacy/<name>.ts answer the file in `dir` with its types
// stripped. Anything else falls through to the static mounts.
//
// Transitional: remove this module and its mount in server.ts when the old UI
// stops being served.
//
// The first strip prints Node's one ExperimentalWarning for
// stripTypeScriptTypes; that is accepted, and nothing suppresses warnings.
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import type { RequestHandler } from 'express';

// No slash, dot or `%` in the name, so no subdirectory or traversal is reachable.
const MODULE_PATH = /^\/(?:legacy\/)?([A-Za-z0-9_-]+)\.ts$/;

export function legacyPublicTs(dir: string): RequestHandler {
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const m = MODULE_PATH.exec(req.path);
    if (!m) return next();
    const name = m[1];
    try {
      let source: string;
      try {
        source = await fs.readFile(path.join(dir, `${name}.ts`), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return next();
        throw err;
      }
      let js: string;
      try {
        js = stripTypeScriptTypes(source);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        return next(new Error(`cannot strip public/${name}.ts: ${msg}`, { cause }));
      }
      res.type('text/javascript');
      res.set('Cache-Control', 'no-cache');
      res.send(js);
    } catch (err) {
      next(err);
    }
  };
}
