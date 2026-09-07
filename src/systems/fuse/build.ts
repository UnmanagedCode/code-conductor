// Build and refusal are ONE path: the union daemon is compiled from `union.c`
// on the first remote-worker spawn that needs it, and a host where that compile
// cannot happen refuses the spawn naming what is missing (criterion 9). cc has
// no build step and no native modules, so an out-of-band binary is less
// intrusive to `node_modules` than a native addon would be.
//
// CONTENT-ADDRESSED on the source + the compiler flags, so editing `union.c`
// rebuilds and a stale binary is impossible. That is what makes editing the
// daemon safe rather than a deployment problem — `union.c` is a FORK of the
// frozen S3 instrument and diverges from it by design now (see PROVENANCE.md's
// ledger), so the address moves with every row added there.

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withLock } from '../../storeLock.ts';
import { httpError } from '../../httpError.ts';
import { fuseBinDir } from './plan.ts';
import { FUSE_UNAVAILABLE } from './preflight.ts';

export const UNION_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'union.c');

const CFLAGS = ['-Wall', '-Wextra', '-O2'];

function sh(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeoutMs ?? 120_000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

async function pkgConfig(flag: '--cflags' | '--libs'): Promise<string[]> {
  const r = await sh('pkg-config', [flag, 'fuse3']);
  if (!r.ok) {
    throw httpError(501, `FUSE_UNAVAILABLE: \`pkg-config ${flag} fuse3\` failed — install \`libfuse3-dev\`. ${r.stderr.trim()}`, { code: FUSE_UNAVAILABLE });
  }
  return r.stdout.trim().split(/\s+/).filter(Boolean);
}

// Returns the path to a usable union binary, compiling it if absent.
//
// SINGLE-FLIGHT via the store lock: two concurrent remote spawns would
// otherwise both compile to the same output path, and the second `gcc` would be
// writing the file the first is about to exec.
export async function ensureUnionBinary(): Promise<string> {
  const source = await fsp.readFile(UNION_SOURCE, 'utf8');
  const cflags = await pkgConfig('--cflags');
  const libs = await pkgConfig('--libs');
  const address = createHash('sha256')
    .update(source).update('\0').update(CFLAGS.join(' ')).update('\0')
    .update(cflags.join(' ')).update('\0').update(libs.join(' '))
    .digest('hex').slice(0, 32);
  const out = path.join(fuseBinDir(), `union-${address}`);
  try { await fsp.access(out); return out; }
  catch { /* not built yet */ }

  return withLock(path.join(fuseBinDir(), 'build'), async () => {
    // Re-check inside the lock: the holder we queued behind may have built it.
    try { await fsp.access(out); return out; }
    catch { /* still ours to build */ }
    await fsp.mkdir(fuseBinDir(), { recursive: true });
    // Compile to a temp name and rename, so a concurrent reader outside the
    // lock never sees a partially written binary at the addressed path.
    const tmp = `${out}.tmp.${process.pid}`;
    const r = await sh('gcc', [...CFLAGS, ...cflags, UNION_SOURCE, '-o', tmp, ...libs]);
    if (!r.ok) {
      await fsp.rm(tmp, { force: true });
      throw httpError(501, `FUSE_UNAVAILABLE: could not compile the union daemon from ${UNION_SOURCE}. gcc said:\n${r.stderr.trim() || r.stdout.trim()}`, { code: FUSE_UNAVAILABLE });
    }
    await fsp.chmod(tmp, 0o755);
    await fsp.rename(tmp, out);
    return out;
  });
}
