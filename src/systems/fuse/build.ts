// Build and refusal are ONE path: the union daemon is compiled from `union.c`
// on the first remote-worker spawn that needs it, and a host where that compile
// cannot happen refuses the spawn naming what is missing (criterion 9). cc has
// no build step and no native modules, so an out-of-band binary is less
// intrusive to `node_modules` than a native addon would be.
//
// CONTENT-ADDRESSED on BOTH sources + the compiler flags, so editing either
// rebuilds and a stale binary is impossible. That is what makes editing the
// daemon safe rather than a deployment problem: the address moves with every
// edit to either source.
//
// `policy.h` IS IN THE ADDRESS, and that is not a completeness gesture: it is
// a header, so nothing else observes an edit to it. Hash `union.c` alone and
// changing the tier resolution leaves a stale binary sitting at a live address.

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withLock } from '../../storeLock.ts';
import { httpError } from '../../httpError.ts';
import { fuseBinDir } from './plan.ts';
import { FUSE_UNAVAILABLE } from './preflight.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const UNION_SOURCE = path.join(HERE, 'union.c');
// The policy half — no libfuse, `#include`d by union.c.
export const POLICY_SOURCE = path.join(HERE, 'policy.h');

const CFLAGS = ['-Wall', '-Wextra', '-O2'];

function sh(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeoutMs ?? 120_000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

export type Toolchain =
  | { ok: true; cc: string; cflags: string[]; libs: string[] }
  | { ok: false; reason: string };

// THE ONE DETECTION. `ensureUnionBinary` builds through it and the C policy
// test skips through it, so that test can only skip where the product itself
// could not have built the daemon — a second, more permissive probe would let
// a silently skipped C test look exactly like a passing one.
export async function detectToolchain(): Promise<Toolchain> {
  const cc = await sh('gcc', ['--version']);
  if (!cc.ok) return { ok: false, reason: '`gcc --version` failed — install `gcc`' };
  const cflags = await sh('pkg-config', ['--cflags', 'fuse3']);
  if (!cflags.ok) return { ok: false, reason: `\`pkg-config --cflags fuse3\` failed — install \`libfuse3-dev\`. ${cflags.stderr.trim()}` };
  const libs = await sh('pkg-config', ['--libs', 'fuse3']);
  if (!libs.ok) return { ok: false, reason: `\`pkg-config --libs fuse3\` failed — install \`libfuse3-dev\`. ${libs.stderr.trim()}` };
  const split = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean);
  return { ok: true, cc: 'gcc', cflags: split(cflags.stdout), libs: split(libs.stdout) };
}

// Returns the path to a usable union binary, compiling it if absent.
//
// SINGLE-FLIGHT via the store lock: two concurrent remote spawns would
// otherwise both compile to the same output path, and the second `gcc` would be
// writing the file the first is about to exec.
export async function ensureUnionBinary(): Promise<string> {
  const source = await fsp.readFile(UNION_SOURCE, 'utf8');
  const policy = await fsp.readFile(POLICY_SOURCE, 'utf8');
  const tools = await detectToolchain();
  if (!tools.ok) {
    throw httpError(501, `FUSE_UNAVAILABLE: ${tools.reason}`, { code: FUSE_UNAVAILABLE });
  }
  const { cflags, libs } = tools;
  const address = createHash('sha256')
    .update(source).update('\0').update(policy).update('\0')
    .update(CFLAGS.join(' ')).update('\0')
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
    const r = await sh(tools.cc, [...CFLAGS, ...cflags, UNION_SOURCE, '-o', tmp, ...libs]);
    if (!r.ok) {
      await fsp.rm(tmp, { force: true });
      throw httpError(501, `FUSE_UNAVAILABLE: could not compile the union daemon from ${UNION_SOURCE}. gcc said:\n${r.stderr.trim() || r.stdout.trim()}`, { code: FUSE_UNAVAILABLE });
    }
    await fsp.chmod(tmp, 0o755);
    await fsp.rename(tmp, out);
    return out;
  });
}
