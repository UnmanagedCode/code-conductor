// Whether node_modules on disk matches package-lock.json. Read from the
// packages themselves, not npm's hidden lockfile: the failure this guards is a
// package absent on disk, which only the disk can show. One rule for every
// caller — the relaunch prep (src/relaunchPrep.ts), self-update, the cold-start
// build failure hint (src/webBuild.ts) and the container entrypoint's probe
// (docker/deps-complete.mjs).
//
// For each lock `packages` entry under `node_modules/`:
//   - `link` / `inBundle` entries are skipped (npm does not install them there);
//   - `dev` entries count only when some dev entry is on disk, so an
//     `--omit=dev` install is in sync while a full install sees a devDep bump;
//   - an `optional` / `devOptional` entry may be absent (platform bindings);
//   - otherwise `<key>/package.json` must exist with the lock's `version`.
// Extraneous packages on disk are ignored. Leaf module: node:fs/node:path only.

import fs from 'node:fs';
import path from 'node:path';

type LockEntry = { version?: string; dev?: boolean; optional?: boolean; devOptional?: boolean; link?: boolean; inBundle?: boolean };

function installedVersion(repoRoot: string, key: string): string | null {
  try {
    const pkg: { version?: unknown } = JSON.parse(fs.readFileSync(path.join(repoRoot, key, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch { return null; }
}

/** `null` when in sync (or no lock pins anything), else `{ reason }` naming the first offender in lock order. */
export function dependencyDrift(repoRoot: string): { reason: string } | null {
  let raw: string;
  try { raw = fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { reason: `package-lock.json is unreadable: ${(e as Error).message}` };
  }
  let packages: Record<string, LockEntry>;
  try { packages = (JSON.parse(raw) as { packages?: Record<string, LockEntry> }).packages ?? {}; }
  catch (e) { return { reason: `package-lock.json is unreadable: ${(e as Error).message}` }; }

  const entries = Object.entries(packages).filter(([key, e]) => key.startsWith('node_modules/') && !e.link && !e.inBundle);
  const devOnDisk = entries.some(([key, e]) => e.dev && installedVersion(repoRoot, key) !== null);
  for (const [key, e] of entries) {
    if (e.dev && !devOnDisk) continue;
    const version = installedVersion(repoRoot, key);
    if (version === null) {
      if (e.optional || e.devOptional) continue;
      return { reason: `${key} missing` };
    }
    if (version !== e.version) return { reason: `${key} ${version} ≠ lock ${e.version}` };
  }
  return null;
}
