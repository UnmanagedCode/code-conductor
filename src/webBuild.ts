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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_ROOT = path.join(repoRoot, 'web');
export const WEB_DIST = path.join(WEB_ROOT, 'dist');
const STAMP = '.source-hash';

// Inputs: the web app itself, the shared modules it imports from public/, and
// the lockfile (a dependency bump changes the bundle).
const INPUT_DIRS = [WEB_ROOT, path.join(repoRoot, 'public')];
const INPUT_FILES = [path.join(repoRoot, 'package-lock.json')];
const SKIP_DIRS = new Set(['dist', 'node_modules']);

function listFiles(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) listFiles(p, out); }
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

function builtHash(): string | null {
  try {
    if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))) return null;
    return fs.readFileSync(path.join(WEB_DIST, STAMP), 'utf8').trim();
  } catch { return null; }
}

type WebState = { phase: 'idle' | 'building' | 'ready' | 'failed'; error: string | null };
const state: WebState = { phase: 'idle', error: null };

export async function ensureWebBuild({ log = console }: { log?: Pick<Console, 'log' | 'error'> } = {}): Promise<WebState> {
  const hash = webSourceHash();
  if (builtHash() === hash) { state.phase = 'ready'; return { ...state }; }
  const started = Date.now();
  state.phase = 'building';
  log.log('web: frontend sources changed — building web/dist …');
  const tmp = `${WEB_DIST}.tmp-${process.pid}`;
  try {
    const { build } = await import('vite');
    await build({ configFile: path.join(WEB_ROOT, 'vite.config.ts'), logLevel: 'warn', build: { outDir: tmp, emptyOutDir: true } });
    fs.writeFileSync(path.join(tmp, STAMP), hash + '\n');
    fs.rmSync(WEB_DIST, { recursive: true, force: true });
    fs.renameSync(tmp, WEB_DIST);
    Object.assign(state, { phase: 'ready', error: null });
    log.log(`web: built in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    Object.assign(state, { phase: 'failed', error: e instanceof Error ? e.message : String(e) });
    const stale = fs.existsSync(path.join(WEB_DIST, 'index.html'));
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

/** Serves web/dist, or the building / failed page while there is none. */
export function webHandler(): express.Router {
  const router = express.Router();
  router.use(express.static(WEB_DIST));
  router.get('/', (_req, res) => {
    if (state.phase === 'failed') {
      res.status(503).type('text/plain').send(`The web frontend failed to build:\n\n${state.error}\n\nThe server log has the details.`);
    } else {
      res.status(503).type('html').send(BUILDING_PAGE);
    }
  });
  return router;
}
