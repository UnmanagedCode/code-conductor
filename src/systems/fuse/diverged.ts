// THE DIVERGED RECORD AND THE RESCUE OF ITS BYTES.
//
// A push that fails leaves the worker's only copy of a file in
// `<rundir>/mirror/<p>` (control.ts keeps the claim so cc never re-shapes it).
// The control server lists every such path in `<rundir>/diverged.json`, and
// teardown — whichever path reaches it: the session's own, the boot sweep or the
// runtime sweep — copies those files to `<store>/systems/fuse/recovered/
// <runDirName>/<remote path>` BEFORE it reclaims the run directory.
//
// RECORD FORMAT: `{"schema":1,"paths":["/abs/remote/path", …]}`, sorted and
// de-duplicated.
//
// WHAT IS COPIED: regular files only. A symlink is reported by its target and
// never recreated, so no symlink can exist under `recovered/` for a later rescue
// to be redirected through; a directory's files have entries of their own.
// NOTHING IS OVERWRITTEN: an existing copy with the same bytes makes the copy
// done (a retry is idempotent), different bytes go to `<dst>.1`, `.2`, …

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { withinPosix } from '../mirror.ts';
import { DIVERGED_RECORD_NAME, fuseRecoveredRoot, writeJsonAtomic } from './plan.ts';

const SCHEMA = 1;
const MAX_SUFFIX = 99;

export async function writeDivergedRecord(file: string, paths: Iterable<string>): Promise<void> {
  await writeJsonAtomic(file, { schema: SCHEMA, paths: [...new Set(paths)].sort() });
}

// `[]` when there is no record; throws a reason when there is one that cannot be
// trusted, so the caller keeps the mirror rather than guessing.
export async function readDivergedRecord(file: string): Promise<string[]> {
  let text: string;
  try { text = await fsp.readFile(file, 'utf8'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`diverged record ${file} is unreadable: ${(e as Error).message}`);
  }
  let v: unknown;
  try { v = JSON.parse(text); }
  catch (e) { throw new Error(`diverged record ${file} is unreadable: ${(e as Error).message}`); }
  const rec = v as { schema?: unknown; paths?: unknown } | null;
  if (!rec || rec.schema !== SCHEMA || !Array.isArray(rec.paths) || !rec.paths.every((p) => typeof p === 'string')) {
    throw new Error(`diverged record ${file} is unreadable: not a schema-${SCHEMA} list of paths`);
  }
  return rec.paths as string[];
}

export interface RescueResult {
  // The directory the bytes went to, or null when nothing was copied.
  dir: string | null;
  rescued: { path: string; at: string }[];
  failed: { path: string; error: string }[];
  skipped: { path: string; why: string }[];
}

const within = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

async function sameBytes(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
  if (sa.size !== sb.size) return false;
  const [ba, bb] = await Promise.all([fsp.readFile(a), fsp.readFile(b)]);
  return ba.equals(bb);
}

// Copy `src` to the first free candidate of `dst`, never replacing anything:
// the copy lands under a temp name and is PUBLISHED by `link`, which refuses to
// clobber (EEXIST → the next candidate).
async function publish(src: string, dst: string): Promise<string> {
  for (let n = 0; n <= MAX_SUFFIX; n++) {
    const candidate = n === 0 ? dst : `${dst}.${n}`;
    if (await fsp.lstat(candidate).then(() => true, () => false)) {
      if (await sameBytes(src, candidate).catch(() => false)) return candidate;
      continue;
    }
    const tmp = `${dst}.rescue-${process.pid}`;
    await fsp.copyFile(src, tmp);
    try { await fsp.link(tmp, candidate); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    } finally { await fsp.rm(tmp, { force: true }); }
    return candidate;
  }
  throw new Error(`more than ${MAX_SUFFIX} different copies of ${dst} already exist`);
}

// `extraPaths` is the live server's in-memory set, unioned with the record's so
// a failed record write cannot lose bytes.
export async function rescueDiverged(opts: { rundir: string; dest: string; extraPaths?: string[] }): Promise<RescueResult> {
  const { rundir, dest } = opts;
  const mirror = path.join(rundir, 'mirror');
  const result: RescueResult = { dir: null, rescued: [], failed: [], skipped: [] };
  const record = path.join(rundir, DIVERGED_RECORD_NAME);

  let paths: string[];
  try { paths = await readDivergedRecord(record); }
  catch (e) { result.failed.push({ path: record, error: (e as Error).message }); return result; }
  paths = [...new Set([...paths, ...(opts.extraPaths ?? [])])].sort();

  let realMirror: string | null | undefined;     // undefined: not resolved yet
  let realDest: string | null = null;
  const prepareDest = async (): Promise<string> => {
    if (realDest) return realDest;
    for (const d of [fuseRecoveredRoot(), dest]) {
      await fsp.mkdir(d, { recursive: true, mode: 0o700 });
      await fsp.chmod(d, 0o700);
    }
    return (realDest = await fsp.realpath(dest));
  };

  for (const p of paths) {
    try {
      if (!path.posix.isAbsolute(p)) { result.failed.push({ path: p, error: 'not an absolute path' }); continue; }
      const src = path.posix.normalize(path.posix.join(mirror, p));
      const rel = withinPosix(src, mirror);
      if (rel === null || rel === '') { result.failed.push({ path: p, error: 'escapes the mirror' }); continue; }

      if (realMirror === undefined) realMirror = await fsp.realpath(mirror).catch(() => null);
      if (realMirror === null) { result.skipped.push({ path: p, why: 'nothing in the mirror' }); continue; }
      const realParent = await fsp.realpath(path.dirname(src)).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' || e.code === 'ENOTDIR' ? null : Promise.reject(e)));
      if (realParent === null) { result.skipped.push({ path: p, why: 'nothing in the mirror' }); continue; }
      if (!within(realParent, realMirror)) { result.failed.push({ path: p, error: 'a mirror ancestor resolves outside the mirror' }); continue; }

      const st = await fsp.lstat(src).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
      if (st === null) { result.skipped.push({ path: p, why: 'nothing in the mirror' }); continue; }
      if (st.isSymbolicLink()) { result.skipped.push({ path: p, why: `a symlink to ${await fsp.readlink(src)}; not copied` }); continue; }
      if (st.isDirectory()) { result.skipped.push({ path: p, why: 'a directory; its files are rescued by their own entries' }); continue; }
      if (!st.isFile()) { result.skipped.push({ path: p, why: 'not a regular file; not copied' }); continue; }

      const base = await prepareDest();
      const dst = path.join(dest, rel);
      await fsp.mkdir(path.dirname(dst), { recursive: true, mode: 0o700 });
      if (!within(await fsp.realpath(path.dirname(dst)), base)) { result.failed.push({ path: p, error: 'the destination resolves outside the rescue directory' }); continue; }

      let at: string;
      try { at = await publish(src, dst); }
      catch (e) {
        // The mirror is cc's own (the daemon setfsuids to cc's uid) and is about
        // to be deleted, so opening an unreadable file up is free.
        if ((e as NodeJS.ErrnoException).code !== 'EACCES') throw e;
        await fsp.chmod(src, (st.mode & 0o7777) | 0o400);
        at = await publish(src, dst);
      }
      result.rescued.push({ path: p, at });
    } catch (e) {
      result.failed.push({ path: p, error: (e as Error).message });
    }
  }
  if (result.rescued.length) result.dir = dest;
  return result;
}
