// Build the web frontend (web/ → web/dist/) when its inputs changed since the
// last build. "Changed" is a content hash of every input file, stored beside the
// output, so a `git pull`, a self-update or a hand edit all rebuild while a plain
// restart does not. Vite runs as a child process — still no shell and no npx,
// the same code path on Linux, Windows and Termux — because a long-lived process
// that has just run `npm install` holds the pre-install vite in its module cache.
//
// Callers:
//   - a relaunch (src/relaunchPrep.ts) stages the build into `web/dist.next` in
//     the OLD process, before anything is torn down, and never touches what is
//     served; a failure refuses the relaunch;
//   - boot (ensureWebBuild) adopts a staged build whose stamp matches, and
//     otherwise builds web/dist itself;
//   - cc's own post-merge hook (src/webPostMerge.ts), in a separate process,
//     either makes web/dist current while the server runs (refreshWebDist) or
//     stages the build for the next start (stageWebBuild).
//
// Boot and the hook share refreshWebDist, so "make dist current" has one
// implementation. A staged build is adopted only while its stamp matches the
// current sources, so a stale stage can never override a newer build. Only a
// stale stage is ever removed, and always renamed aside first: a stage
// stamped with the current hash may be a relaunch's, prepared concurrently in
// the server while the hook runs, and is redundant with a current dist at
// worst. A whole-dir rename is atomic, so no removal can leave a partial stage
// that still carries a matching stamp.
//
// The boot build runs after the server is listening, so /api/health and the MCP
// endpoint answer at once (the Termux widget and the Windows launcher poll
// them). Output goes to a temp dir and is swapped in by rename-aside, so a
// previous build keeps serving until the new one is in place, and a failed build
// or a failed swap leaves it serving — unless the swap cannot put it back
// either, which leaves no build. Until any build exists, the UI route answers a
// self-refreshing "building" page; a failure with no build in place answers 503
// naming the error. A failure never stops the server.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { isProcessAlive } from './storeLock.ts';
import { dependencyDrift } from './depsDrift.ts';
import { runGroupedCommand, GROUP_OUTPUT_CAP, RESULT_TAIL_CAP } from './groupedCommand.ts';
import { hostPlatform } from './platform/index.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_ROOT = path.join(repoRoot, 'web');
export const WEB_DIST = path.join(WEB_ROOT, 'dist');
const STAMP = '.source-hash';

// Build output, dependencies, Playwright output and the e2e specs + fixtures
// are not inputs. Neither is any `dist.*` sibling: the staged `dist.next`, and
// the `.tmp-<pid>` / `.old-<pid>` dirs a killed build leaves behind.
const SKIP_DIRS = new Set(['dist', 'node_modules', 'test-results', 'playwright-report', 'e2e']);
const skipDir = (name: string): boolean => SKIP_DIRS.has(name) || name.startsWith('dist.');
// Where a relaunch stages the next build: beside the served one, so boot adopts
// it with one rename.
const stagedDirOf = (distDir: string): string => `${distDir}.next`;
const WEB_BUILD_TIMEOUT_MS = 300_000;

function listFiles(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!skipDir(e.name)) listFiles(p, out); }
    else if (e.isFile()) out.push(p);
  }
}

/** The build's inputs; injectable so a test can hash a fixture tree. Paths in the hash are relative to `root`. */
export type WebInputs = { root: string; dirs: string[]; files: string[] };
// The inputs of a checkout at `root`: the web app itself, the shared modules it
// imports from shared/, the root package.json and tsconfig.json the build reads
// (module resolution; shared/tsconfig.json extends the root one, and the
// transform of shared/*.ts takes its compiler options), and npm's hidden
// lockfile, which records the installed tree (a dependency change changes the
// bundle). A file input that is absent is left out.
export const webInputs = (root: string): WebInputs => ({
  root,
  dirs: [path.join(root, 'web'), path.join(root, 'shared')],
  files: ['package.json', 'tsconfig.json', path.join('node_modules', '.package-lock.json')].map((f) => path.join(root, f)),
});
const DEFAULT_INPUTS = webInputs(repoRoot);

/** Every file the hash covers, absolute and sorted. */
export function webInputFiles({ dirs, files: inputFiles }: WebInputs = DEFAULT_INPUTS): string[] {
  const files: string[] = [];
  for (const d of dirs) listFiles(d, files);
  files.push(...inputFiles.filter((f) => fs.existsSync(f)));
  return files.sort();
}

/**
 * Whether the path `rel` (relative to `inputs.root`, POSIX or native
 * separators) is one the hash would cover: the same dirs, the same skipped
 * dirs, the same files. Path arithmetic only — it does not look at the disk,
 * since a git path may be deleted — so a symlink inside an input dir counts,
 * though the hash reads regular files only there.
 */
export function isWebInput({ root, dirs, files }: WebInputs, rel: string): boolean {
  const abs = path.join(root, ...rel.split('/'));
  if (files.includes(abs)) return true;
  return dirs.some((d) => {
    const r = path.relative(d, abs);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) return false;
    return !r.split(path.sep).slice(0, -1).some(skipDir);
  });
}

/** The inputs as git pathspecs relative to `root` (POSIX): every dir and file the hash reads under. */
export function inputPaths({ root, dirs, files }: WebInputs): string[] {
  return [...dirs, ...files].map((p) => path.relative(root, p).split(path.sep).join('/'));
}

export function webSourceHash(inputs: WebInputs = DEFAULT_INPUTS): string {
  const { root } = inputs;
  const files = webInputFiles(inputs);
  const h = createHash('sha256');
  for (const f of files) {
    // Path relative + POSIX-separated so the hash is identical across hosts.
    h.update(path.relative(root, f).split(path.sep).join('/'));
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

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Removes `<dist>.tmp-<pid>` / `<dist>.old-<pid>` siblings a killed process left
// behind, and the same under the staged `<dist>.next`, in one read of the
// parent (os.tmpdir() in tests, which can be huge). Only a pid that is no
// longer running: another live server's tmp may be a build in flight. Best
// effort, one entry at a time.
function sweepLeftovers(distDir: string, log: Pick<Console, 'error'>): void {
  const parent = path.dirname(distDir);
  const base = path.basename(distDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${base}(?:\\.next)?\\.(?:tmp|old)-(\\d+)$`);
  let names: string[];
  try { names = fs.readdirSync(parent); } catch { return; }
  for (const name of names) {
    const pid = Number(re.exec(name)?.[1]);
    if (!pid || pid === process.pid || isProcessAlive(pid)) continue;
    try { fs.rmSync(path.join(parent, name), { recursive: true, force: true }); }
    catch (e) { log.error(`web: could not remove the leftover ${path.join(parent, name)}: ${errText(e)}`); }
  }
}

// Rename-aside, so a failed swap never loses the previous build: dist moves to
// dist.old-<pid>, the new build moves in, and only then is the old one removed
// (best effort: the new build is live by then). If the new one cannot move in,
// the old one is moved back before rethrowing; if that fails too, both errors
// are reported, the original first, and no build is in place.
function swapIn(tmp: string, distDir: string, log: Pick<Console, 'error'>): void {
  const old = `${distDir}.old-${process.pid}`;
  fs.rmSync(old, { recursive: true, force: true });
  const hadPrevious = fs.existsSync(distDir);
  if (hadPrevious) fs.renameSync(distDir, old);
  try { fs.renameSync(tmp, distDir); }
  catch (e) {
    if (hadPrevious) {
      try { fs.renameSync(old, distDir); }
      catch (restoreErr) {
        throw new Error(`${errText(e)}; restoring the previous build also failed: ${errText(restoreErr)} (it is left at ${old})`, { cause: e });
      }
    }
    throw e;
  }
  try { fs.rmSync(old, { recursive: true, force: true }); }
  catch (e) { log.error(`web: the new build is live, but the previous one could not be removed from ${old}: ${errText(e)}`); }
}

/** Builds the UI into `outDir`; injectable so a test can stand in for Vite. */
export type WebBuilder = (outDir: string, opts: { onChunk?: (text: string) => void }) => Promise<void>;

/**
 * `vite build` in a child of this node. `root` (the repo root by default) is
 * the child's cwd and where vite is resolved from. Throws on a missing vite or
 * a failed build, the latter carrying the output's `tail`.
 */
export async function runViteBuild(outDir: string, { onChunk, root = repoRoot }: { onChunk?: (text: string) => void; root?: string } = {}): Promise<void> {
  const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(vite)) throw new Error('vite is not installed (node_modules/vite/bin/vite.js missing) — run npm install');
  const r = await runGroupedCommand({
    argv: [process.execPath, vite, 'build', '--config', 'web/vite.config.ts', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'],
  }, {
    cwd: root, env: { ...process.env, NODE_ENV: 'production' }, timeoutMs: WEB_BUILD_TIMEOUT_MS, cap: GROUP_OUTPUT_CAP, onChunk,
  }, hostPlatform);
  if (r.code !== 0) {
    throw Object.assign(new Error(`vite build failed (exit ${r.code}${r.timedOut ? ', timed out' : ''})`), { tail: r.output.trimEnd().slice(-RESULT_TAIL_CAP) });
  }
}

// Remove `dir` by renaming it aside to `<dir>.old-<pid>` first, so a reader
// never sees it half-deleted. A dir that is already gone is fine; a failure is
// logged, never thrown.
function removeAside(dir: string, log: Pick<Console, 'error'>): void {
  const aside = `${dir}.old-${process.pid}`;
  try {
    fs.rmSync(aside, { recursive: true, force: true });
    fs.renameSync(dir, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.error(`web: could not remove ${dir}: ${errText(e)}`);
    return;
  }
  try { fs.rmSync(aside, { recursive: true, force: true }); }
  catch (e) { log.error(`web: could not remove ${aside}: ${errText(e)}`); }
}

// Build into `<dir>.tmp-<pid>`, stamp it, then swap it in as `dir`. The tmp is
// removed on failure — including a refusal by `guard`, which runs between the
// finished build and the swap.
async function buildInto(
  dir: string, hash: string, build: WebBuilder, onChunk: ((text: string) => void) | undefined, log: Pick<Console, 'error'>,
  guard?: SwapGuard,
): Promise<void> {
  const tmp = `${dir}.tmp-${process.pid}`;
  try {
    await build(tmp, { onChunk });
    fs.writeFileSync(path.join(tmp, STAMP), hash + '\n');
    await checkGuard(guard, hash);
    swapIn(tmp, dir, log);
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort: the failure is what gets reported */ }
    throw e;
  }
}

/**
 * Asked just before a build stamped `stamp` is swapped in as `<dist>`: null to
 * swap, or why the sources it was built from are no longer the ones it may
 * serve (src/swapGuard.ts). A build is made from the mutable working tree, so a
 * merge or an edit landing while it ran would otherwise go live unexamined.
 */
export type SwapGuard = (stamp: string) => Promise<string | null>;

/** A swap refused by its SwapGuard: nothing was swapped, and the refused build is gone. */
export class SourcesMovedError extends Error {}

async function checkGuard(guard: SwapGuard | undefined, stamp: string): Promise<void> {
  const moved = guard ? await guard(stamp) : null;
  if (moved) throw new SourcesMovedError(moved);
}

// How many web builds THIS process has running: boot's ensureWebBuild and a
// relaunch's stage. The server withholds its boot commit from a merge hook
// while one runs (src/bootCommit.ts), so the hook stages instead of racing
// this process's swap of the same dirs.
let buildsRunning = 0;
export const webBuildRunning = (): boolean => buildsRunning > 0;

/**
 * The relaunch's half: make `<dist>.next` hold a build of the current sources
 * unless `<dist>` already does. Never touches `<dist>` or the serving state, so
 * this process keeps serving its own build, whose server code a newer UI would
 * not match. Throws on failure, leaving no staged or tmp dir behind.
 */
export async function stageWebBuild(
  { onChunk, distDir = WEB_DIST, inputs = DEFAULT_INPUTS, build = runViteBuild, log = console }:
  { onChunk?: (text: string) => void; distDir?: string; inputs?: WebInputs; build?: WebBuilder; log?: Pick<Console, 'error'> } = {},
): Promise<{ staged: boolean }> {
  buildsRunning++;
  try { return await stageUnlocked({ onChunk, distDir, inputs, build, log }); }
  finally { buildsRunning--; }
}

async function stageUnlocked(
  { onChunk, distDir, inputs, build, log }:
  { onChunk?: (text: string) => void; distDir: string; inputs: WebInputs; build: WebBuilder; log: Pick<Console, 'error'> },
): Promise<{ staged: boolean }> {
  const staged = stagedDirOf(distDir);
  const hash = webSourceHash(inputs);
  if (builtHash(distDir) === hash) return { staged: false };
  if (builtHash(staged) === hash) return { staged: true };
  try { await buildInto(staged, hash, build, onChunk, log); }
  catch (e) {
    // Another process (a relaunch, or cc's post-merge hook) staged the same
    // sources meanwhile: its stage is whole — the stamp is written before the
    // rename — so it is kept, not deleted as this one's failure.
    if (builtHash(staged) === hash) return { staged: true };
    // A failed swap can leave a half-replaced staged dir; a stage is all or nothing.
    removeAside(staged, log);
    throw e;
  }
  return { staged: true };
}

export type RefreshOutcome = 'up-to-date' | 'adopted-staged' | 'built';

/**
 * Make `<dist>` hold a build of the current sources: already current, adopt
 * `<dist>.next` when its stamp matches, else build. Then removes `<dist>.next`
 * if it is stale (stamped with another hash). Throws on a failed build or swap,
 * leaving the previous `<dist>` in place (see swapIn). Every swap — the
 * adoption and the fresh build alike — first asks `guard`; a refusal throws
 * SourcesMovedError with `<dist>` untouched, an adopted stage left where it
 * was and a fresh build discarded.
 */
export async function refreshWebDist(
  { distDir = WEB_DIST, inputs = DEFAULT_INPUTS, build = runViteBuild, onChunk, log = console, guard }:
  {
    distDir?: string; inputs?: WebInputs; build?: WebBuilder; onChunk?: (text: string) => void;
    log?: Pick<Console, 'log' | 'error'>; guard?: SwapGuard;
  } = {},
): Promise<RefreshOutcome> {
  const staged = stagedDirOf(distDir);
  const hash = webSourceHash(inputs);
  let outcome: RefreshOutcome;
  if (builtHash(distDir) === hash) outcome = 'up-to-date';
  else if (builtHash(staged) === hash) {
    await checkGuard(guard, hash);
    swapIn(staged, distDir, log);
    outcome = 'adopted-staged';
  } else {
    log.log('web: frontend sources changed — building web/dist …');
    await buildInto(distDir, hash, build, onChunk, log, guard);
    outcome = 'built';
  }
  if (fs.existsSync(staged) && builtHash(staged) !== hash) removeAside(staged, log);
  return outcome;
}

export type WebState = { phase: 'idle' | 'building' | 'ready' | 'failed'; error: string | null };
const state: WebState = { phase: 'idle', error: null };

const failureText = (e: unknown): string => {
  const tail = (e as { tail?: unknown })?.tail;
  return typeof tail === 'string' && tail ? `${errText(e)}\n${tail}` : errText(e);
};

// `guard` is asked before the boot build's swap only while a previous build is
// in place: with none, a build of moved sources still beats no UI at all.
export async function ensureWebBuild(
  { log = console, distDir = WEB_DIST, inputs = DEFAULT_INPUTS, build = runViteBuild, drift = () => dependencyDrift(repoRoot), guard }:
  {
    log?: Pick<Console, 'log' | 'error'>; distDir?: string; inputs?: WebInputs; build?: WebBuilder;
    drift?: () => { reason: string } | null; guard?: SwapGuard;
  } = {},
): Promise<WebState> {
  const started = Date.now();
  // Counted from the first statement: start() calls this synchronously after
  // listen, so no merge hook can run before it reads as running.
  buildsRunning++;
  // Everything, the input hash included, is inside the try: start() fires this
  // unawaited, so a rejection would be unhandled and take the server down.
  try {
    sweepLeftovers(distDir, log);
    state.phase = 'building';
    let output = '';
    const hasPrevious = () => fs.existsSync(path.join(distDir, 'index.html'));
    const bootGuard: SwapGuard | undefined = guard && (async (stamp) => (hasPrevious() ? guard(stamp) : null));
    const outcome = await refreshWebDist({ distDir, inputs, build, log, guard: bootGuard, onChunk: (t) => { output += t; } });
    if (output.trim()) log.log(output.trimEnd());
    Object.assign(state, { phase: 'ready', error: null });
    if (outcome === 'adopted-staged') log.log('web: adopted the build staged before restart');
    if (outcome === 'built') log.log(`web: built in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (e) {
    if (e instanceof SourcesMovedError) {
      // Only reachable with a previous build in place, which keeps serving.
      Object.assign(state, { phase: 'ready', error: null });
      log.log(`web: kept the previous build — the sources moved during the boot build (${e.message}); the next start builds them`);
      return { ...state };
    }
    let error = failureText(e);
    let d: { reason: string } | null = null;
    try { d = drift(); } catch { /* the hint is best effort */ }
    if (d) error += `\n— node_modules does not satisfy package.json: ${d.reason}; run npm install`;
    Object.assign(state, { phase: 'failed', error });
    const stale = fs.existsSync(path.join(distDir, 'index.html'));
    log.error([
      '='.repeat(60),
      `WARNING  web frontend build failed — ${stale ? 'serving the previous build' : 'the UI is unavailable (API still up)'}`,
      '='.repeat(60),
      state.error,
      '='.repeat(60),
    ].join('\n'));
  } finally {
    buildsRunning--;
  }
  return { ...state };
}

const BUILDING_PAGE = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Code Conductor</title>
<body style="font:16px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#1c1917;color:#f5f5f4">
<p>Building the interface&hellip; this page refreshes by itself.</p></body>`;

/**
 * Mounted at the root: serves the built UI, or the building / failed page while
 * there is none. `distDir` and `getState` are injectable for tests.
 */
export function webHandler(
  { distDir = WEB_DIST, getState = () => state }: { distDir?: string; getState?: () => WebState } = {},
): express.Router {
  const router = express.Router();
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
