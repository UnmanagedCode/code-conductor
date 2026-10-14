// Whether node_modules on disk satisfies package.json. Read from the packages
// themselves — never package-lock.json nor npm's hidden lockfile:
// the failure this guards is a package absent on disk, which only the disk can
// show. One rule for every caller — the relaunch prep (src/relaunchPrep.ts),
// self-update, the cold-start build failure hint (src/webBuild.ts) and the
// container entrypoint's probe (docker/deps-complete.mjs).
//
// First offender wins, in this order:
//   1. roots — each `dependencies` / `optionalDependencies` entry, plus each
//      `devDependencies` entry when a dev root is on disk that the prod roots'
//      graph does not reach (so an `--omit=dev` install is in sync while a full
//      install sees a devDep change). `node_modules/<name>/package.json` must
//      exist (an absent optional root is fine) with a `version` inside the range;
//   2. transitive — every `dependencies` name of every reached package resolves
//      by Node's lookup (own node_modules, then each ancestor's). A missing
//      `optionalDependencies` entry is fine; present optional and peer
//      dependencies count toward reachability only;
//   3. extraneous — a top-level `node_modules/<name>` (or `@scope/<name>`) with a
//      package.json, not a symlink, not a dot-entry, and unreached: a dependency
//      removed from package.json.
//
// Ranges: `X.Y.Z`, `^X.Y.Z`, `~X.Y.Z`, `>=X.Y.Z` (an installed prerelease
// satisfies none); any other range is drift, so an unsupported one fails loudly.
// Not detected: transitive versions (existence only), extraneous packages nested
// below the top level, a missing peer, a newer in-range release, a corrupt
// package whose package.json is intact, non-npm layouts.
// Leaf module: node:fs/node:path only, so it works when node_modules is broken.

import fs from 'node:fs';
import path from 'node:path';

type Manifest = {
  version?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
type Drift = { reason: string };

function readManifest(dir: string): Manifest | null {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as Manifest; }
  catch { return null; }
}

const RANGE = /^(\^|~|>=)?(\d+)\.(\d+)\.(\d+)$/;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** Whether `range` is in the supported grammar. */
export function isSupportedRange(range: string): boolean {
  return RANGE.test(range);
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Whether `version` lies inside `range` (which must be supported). */
function satisfies(version: string, range: string): boolean {
  const r = RANGE.exec(range);
  const v = VERSION.exec(version);
  if (!r || !v || v[4]) return false;
  const want = [Number(r[2]), Number(r[3]), Number(r[4])];
  const have = [Number(v[1]), Number(v[2]), Number(v[3])];
  const op = r[1] ?? '';
  if (op === '') return cmp(have, want) === 0;
  if (cmp(have, want) < 0) return false;
  if (op === '>=') return true;
  if (op === '~') return have[0] === want[0] && have[1] === want[1];
  // ^: the left-most non-zero component is fixed.
  if (want[0] !== 0) return have[0] === want[0];
  if (want[1] !== 0) return have[0] === 0 && have[1] === want[1];
  return have[0] === 0 && have[1] === 0 && have[2] === want[2];
}

// Where Node finds `name` from the package at `rel` (repo-relative, POSIX):
// its own node_modules, then every ancestor node_modules up to the root's.
function resolve(repoRoot: string, rel: string, name: string): string | null {
  const segs = rel.split('/');
  const bases = [rel];
  for (let i = segs.length - 1; i >= 0; i--) if (segs[i] === 'node_modules') bases.push(segs.slice(0, i).join('/'));
  for (const base of bases) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (fs.existsSync(path.join(repoRoot, candidate, 'package.json'))) return candidate;
  }
  return null;
}

// Breadth-first from `roots` (repo-relative package dirs, already present),
// adding every package reached to `seen`. The first missing required
// dependency is returned.
function walk(repoRoot: string, roots: string[], seen: Set<string>): Drift | null {
  const queue = roots.filter((r) => !seen.has(r));
  for (const r of queue) seen.add(r);
  while (queue.length) {
    const rel = queue.shift()!;
    const m = readManifest(path.join(repoRoot, rel)) ?? {};
    const required = Object.keys(m.dependencies ?? {});
    const optional = new Set(Object.keys(m.optionalDependencies ?? {}));
    const names = [...new Set([...required, ...optional, ...Object.keys(m.peerDependencies ?? {})])];
    for (const name of names) {
      const found = resolve(repoRoot, rel, name);
      if (!found) {
        if (required.includes(name) && !optional.has(name)) return { reason: `${name} missing, required by ${rel}` };
        continue;
      }
      if (!seen.has(found)) { seen.add(found); queue.push(found); }
    }
  }
  return null;
}

// Every top-level installed package dir (repo-relative), sorted.
function topLevel(repoRoot: string): string[] {
  const out: string[] = [];
  const list = (rel: string): fs.Dirent[] => {
    try { return fs.readdirSync(path.join(repoRoot, rel), { withFileTypes: true }); } catch { return []; }
  };
  for (const e of list('node_modules')) {
    if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
    if (e.name.startsWith('@') && e.isDirectory()) {
      for (const s of list(`node_modules/${e.name}`)) {
        if (!s.name.startsWith('.') && !s.isSymbolicLink()) out.push(`node_modules/${e.name}/${s.name}`);
      }
    } else out.push(`node_modules/${e.name}`);
  }
  return out.filter((rel) => fs.existsSync(path.join(repoRoot, rel, 'package.json'))).sort();
}

/** `null` when in sync (or there is no package.json), else `{ reason }` naming the first offender. */
export function dependencyDrift(repoRoot: string): Drift | null {
  let raw: string;
  try { raw = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { reason: `package.json is unreadable: ${(e as Error).message}` };
  }
  let pkg: Manifest;
  try { pkg = JSON.parse(raw) as Manifest; }
  catch (e) { return { reason: `package.json is unreadable: ${(e as Error).message}` }; }

  const optional = pkg.optionalDependencies ?? {};
  const prod = { ...pkg.dependencies, ...optional };
  const dev = pkg.devDependencies ?? {};
  const present = (name: string): boolean => fs.existsSync(path.join(repoRoot, 'node_modules', name, 'package.json'));

  const checkRoots = (ranges: Record<string, string>): Drift | null => {
    for (const [name, range] of Object.entries(ranges)) {
      if (!isSupportedRange(range)) return { reason: `package.json range for ${name} ("${range}") is not supported` };
      const key = `node_modules/${name}`;
      const m = present(name) ? readManifest(path.join(repoRoot, key)) : null;
      if (!m) {
        if (name in optional) continue;
        return { reason: `${key} missing` };
      }
      const version = typeof m.version === 'string' ? m.version : '(no version)';
      if (!satisfies(version, range)) return { reason: `${key} ${version} does not satisfy ${range}` };
    }
    return null;
  };

  const rootDirs = (names: string[]): string[] => names.filter(present).map((n) => `node_modules/${n}`);
  const seen = new Set<string>();
  const prodDrift = checkRoots(prod);
  if (prodDrift) return prodDrift;
  const prodWalk = walk(repoRoot, rootDirs(Object.keys(prod)), seen);
  // A dev root the prod graph also needs (an optional peer, say) stays on disk
  // under --omit=dev, so only an unreached one says a full install is here.
  const devInstalled = Object.keys(dev).some((n) => present(n) && !seen.has(`node_modules/${n}`));
  if (devInstalled) {
    const devDrift = checkRoots(dev);
    if (devDrift) return devDrift;
  }
  if (prodWalk) return prodWalk;
  if (devInstalled) {
    const devWalk = walk(repoRoot, rootDirs(Object.keys(dev)), seen);
    if (devWalk) return devWalk;
  }
  for (const rel of topLevel(repoRoot)) {
    if (!seen.has(rel)) return { reason: `${rel} is extraneous` };
  }
  return null;
}
