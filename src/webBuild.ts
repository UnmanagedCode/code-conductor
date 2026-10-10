// Build the web frontend (web/ → web/dist/) at boot when its inputs changed
// since the last build. "Changed" is a content hash of every input file, stored
// beside the output, so a `git pull`, a self-update or a hand edit all rebuild
// while a plain restart does not. Runs Vite in-process: no shell, no npx, the
// same code path on Linux, Windows and Termux.
//
// The build runs after the server is listening, so /api/health and the MCP
// endpoint answer at once (the Termux widget and the Windows launcher poll
// them). Output goes to a temp dir and is swapped in whole, so a previous build
// keeps serving until the new one is complete. Until any build exists, the UI
// route answers a self-refreshing "building" page; a failed build answers 503
// naming the error. A failure never stops the server.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WEB_BASE } from '../web/base.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_ROOT = path.join(repoRoot, 'web');
export const WEB_DIST = path.join(WEB_ROOT, 'dist');
/** The Express mount for the web UI: WEB_BASE without its trailing slash. */
export const WEB_MOUNT = WEB_BASE.slice(0, -1);
const STAMP = '.source-hash';

// Inputs: the web app itself, the shared modules it imports from public/, and
// the lockfile (a dependency bump changes the bundle).
const INPUT_DIRS = [WEB_ROOT, path.join(repoRoot, 'public')];
const INPUT_FILES = [path.join(repoRoot, 'package-lock.json')];
// Build output, dependencies and Playwright output are not inputs; a killed
// build leaves a `dist.tmp-<pid>` behind, which must not trigger a rebuild either.
const SKIP_DIRS = new Set(['dist', 'node_modules', 'test-results', 'playwright-report']);
const skipDir = (name: string): boolean => SKIP_DIRS.has(name) || name.startsWith('dist.tmp-');

function listFiles(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!skipDir(e.name)) listFiles(p, out); }
    else if (e.isFile()) out.push(p);
  }
}

export function webSourceHash(): string {
  const files: string[] = [];
  for (const d of INPUT_DIRS) listFiles(d, files);
  files.push(...INPUT_FILES.filter((f) => fs.existsSync(f)));
  files.sort();
  const h = createHash('sha256');
  for (const f of files) {
    // Path relative + POSIX-separated so the hash is identical across hosts.
    h.update(path.relative(repoRoot, f).split(path.sep).join('/'));
    h.update('\0');
    h.update(fs.readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex');
}

function builtHash(distDir: string): string | null {
  try {
    if (!fs.existsSync(path.join(distDir, 'index.html'))) return null;
    return fs.readFileSync(path.join(distDir, STAMP), 'utf8').trim();
  } catch { return null; }
}

export type WebState = { phase: 'idle' | 'building' | 'ready' | 'failed'; error: string | null };
const state: WebState = { phase: 'idle', error: null };

export async function ensureWebBuild(
  { log = console, distDir = WEB_DIST }: { log?: Pick<Console, 'log' | 'error'>; distDir?: string } = {},
): Promise<WebState> {
  const started = Date.now();
  const tmp = `${distDir}.tmp-${process.pid}`;
  // Everything, the input hash included, is inside the try: start() fires this
  // unawaited, so a rejection would be unhandled and take the server down.
  try {
    const hash = webSourceHash();
    if (builtHash(distDir) === hash) { Object.assign(state, { phase: 'ready', error: null }); return { ...state }; }
    state.phase = 'building';
    log.log('web: frontend sources changed — building web/dist …');
    const { build } = await import('vite');
    await build({ configFile: path.join(WEB_ROOT, 'vite.config.ts'), logLevel: 'warn', build: { outDir: tmp, emptyOutDir: true } });
    fs.writeFileSync(path.join(tmp, STAMP), hash + '\n');
    fs.rmSync(distDir, { recursive: true, force: true });
    fs.renameSync(tmp, distDir);
    Object.assign(state, { phase: 'ready', error: null });
    log.log(`web: built in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort: the failure below is what gets reported */ }
    Object.assign(state, { phase: 'failed', error: e instanceof Error ? e.message : String(e) });
    const stale = fs.existsSync(path.join(distDir, 'index.html'));
    log.error([
      '='.repeat(60),
      `WARNING  web frontend build failed — ${stale ? 'serving the previous build' : 'the UI is unavailable (API still up)'}`,
      '='.repeat(60),
      state.error,
      '='.repeat(60),
    ].join('\n'));
  }
  return { ...state };
}

const BUILDING_PAGE = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Code Conductor</title>
<body style="font:16px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#1c1917;color:#f5f5f4">
<p>Building the interface&hellip; this page refreshes by itself.</p></body>`;

/**
 * Mounted at WEB_MOUNT: serves the built UI, or the building / failed page while
 * there is none. `distDir` and `getState` are injectable for tests.
 */
export function webHandler(
  { distDir = WEB_DIST, getState = () => state }: { distDir?: string; getState?: () => WebState } = {},
): express.Router {
  const router = express.Router();
  // The document must sit inside the UI's service-worker scope (WEB_BASE), so
  // the bare mount redirects. express.static only does that once a build exists.
  router.use((req, res, next) => {
    const q = req.originalUrl.indexOf('?');
    if ((q === -1 ? req.originalUrl : req.originalUrl.slice(0, q)) !== WEB_MOUNT) return next();
    res.redirect(301, WEB_BASE + (q === -1 ? '' : req.originalUrl.slice(q)));
  });
  router.use(express.static(distDir));
  router.get('/', (_req, res) => {
    const { phase, error } = getState();
    if (phase === 'failed') {
      res.status(503).type('text/plain').send(`The web frontend failed to build:\n\n${error}\n\nThe server log has the details.`);
    } else {
      res.status(503).type('html').send(BUILDING_PAGE);
    }
  });
  return router;
}
