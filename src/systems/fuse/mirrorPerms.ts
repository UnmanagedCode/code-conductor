// cc's PERMISSIONS ON ITS OWN MIRROR TREE, under read-only source modes.
//
// A source `/`, `/root` or `.git` object at 0555/0444 would leave cc's own
// (non-root) uid unable to write into or over its own mirror entries. The rule:
//
//  - MIRROR DIRECTORIES ALWAYS CARRY OWNER rwx (`widenDirMode`). The worker's
//    local view of a directory's owner bits is therefore widened; that is
//    accepted, because a worker's Bash runs on the remote and sees true modes.
//  - MIRROR FILES KEEP THE SOURCE'S MODE. A read-only one is never opened for
//    write: it is refreshed by `replaceViaScratch`, a temp file in a scratch
//    directory renamed over it.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';

const OWNER_RWX = 0o700;

// `mode` with owner rwx added; group, other, setgid and sticky bits are kept.
export const widenDirMode = (mode: number): number => mode | OWNER_RWX;

// A leaf-only mutex per key: `run` serialises callers on one key, and `fn` must
// not take another `KeyedLock` key, so no lock order exists to get wrong.
export class KeyedLock {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = prev.then(() => new Promise<void>((r) => { release = r; }));
    this.#tails.set(key, tail);
    await prev;
    try { return await fn(); }
    finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

// `rm -rf` that survives read-only directories BELOW `p`: on EACCES, give every
// directory in the subtree owner rwx (best-effort) and remove again. It never
// touches `p`'s parent — mirror directories are widened by invariant — so a
// read-only parent makes the second attempt throw, for the caller to log.
export async function removeOwnedTree(p: string): Promise<void> {
  try { await fsp.rm(p, { recursive: true, force: true }); return; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EACCES') throw e; }
  const open = async (dir: string): Promise<void> => {
    const st = await fsp.lstat(dir).catch(() => null);
    if (!st || !st.isDirectory()) return;
    if ((st.mode & OWNER_RWX) !== OWNER_RWX) await fsp.chmod(dir, widenDirMode(st.mode & 0o7777)).catch(() => {});
    for (const n of await fsp.readdir(dir).catch(() => [] as string[])) await open(path.join(dir, n));
  };
  await open(p);
  await fsp.rm(p, { recursive: true, force: true });
}

// Replace `dest` by RENAME from a temp file in `scratch`. `write` fills the temp
// and returns whether to install it; `mode` and `mtimeMs` are set before the
// rename so a later STAT sees a matching fingerprint. A reader holding the old
// inode is undisturbed, and the temp never appears in the mirror. `scratch`
// must be on `dest`'s filesystem.
export async function replaceViaScratch(
  scratch: string, dest: string, mode: number, mtimeMs: number,
  write: (tmp: string) => Promise<boolean>,
): Promise<void> {
  await fsp.mkdir(scratch, { recursive: true, mode: OWNER_RWX });
  const tmp = path.join(scratch, randomUUID());
  try {
    if (!(await write(tmp))) return;
    await fsp.chmod(tmp, mode);
    await fsp.utimes(tmp, new Date(mtimeMs), new Date(mtimeMs));
    await fsp.rename(tmp, dest);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}
