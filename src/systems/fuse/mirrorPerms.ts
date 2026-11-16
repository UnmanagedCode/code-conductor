// cc's WRITE ACCESS TO ITS OWN MIRROR TREE, under read-only source modes.
//
// THE MIRROR ENTRY'S ON-DISK MODE IS THE SOURCE'S, and it must stay so: the
// driver answers getattr/access from the mirror entry under
// `default_permissions`, so a widened mode would be what the worker sees and
// what a DIRTY pushes back to the source. A source `/`, `/root` or `.git`
// object at 0555/0444 therefore leaves cc itself unable to write into or over
// its own entries. cc takes owner write for the length of ONE operation and
// puts the mode back, rather than ever widening an entry for good.
//
// LOCK ORDER: ancestor → descendant only, and NO lock is held across a call
// that takes another one. `DirGrants.inDir` runs its callback under the
// directory's lock, so a callback must not call back into `DirGrants` for the
// same or another directory (remove with `removeOwnedTree`, not the locking
// wrappers). Break this and two shapes deadlock on each other.

import path from 'node:path';
import { promises as fsp } from 'node:fs';

const OWNER_RWX = 0o700;
const isEacces = (e: unknown): boolean => (e as NodeJS.ErrnoException | undefined)?.code === 'EACCES';
// The map key: trailing slashes and `..` normalised away.
const keyOf = (p: string): string => path.resolve(p);

export class DirGrants {
  // dir → tail of its promise chain, a per-directory mutex.
  readonly #locks = new Map<string, Promise<unknown>>();

  #locked<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const key = keyOf(dir);
    const run = (this.#locks.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    this.#locks.set(key, tail);
    void tail.then(() => { if (this.#locks.get(key) === tail) this.#locks.delete(key); });
    return run;
  }

  // Run `fn` — an operation creating, removing or listing entries DIRECTLY in
  // `dir`. It runs with no lock and no chmod first; only an EACCES takes the
  // grant: owner rwx for one retry, then the mode is put back unless someone
  // else changed it meanwhile (a worker's own chmod stays).
  async inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    try { return await fn(); }
    catch (e) {
      if (!isEacces(e)) throw e;
      return this.#locked(dir, async () => {
        const st = await fsp.lstat(dir).catch(() => null);
        if (!st || !st.isDirectory() || (st.mode & OWNER_RWX) === OWNER_RWX) throw e;
        const orig = st.mode & 0o7777;
        const granted = orig | OWNER_RWX;
        await fsp.chmod(dir, granted);
        try { return await fn(); }
        finally {
          const now = await fsp.lstat(dir).catch(() => null);
          if (now && (now.mode & 0o7777) === granted) await fsp.chmod(dir, orig).catch(() => {});
        }
      });
    }
  }

  // Set a directory's mode, serialised with any grant on it so a shape landing
  // mid-grant cannot revoke the write a child operation is relying on.
  setDirMode(dir: string, mode: number): Promise<void> {
    return this.#locked(dir, () => fsp.chmod(dir, mode));
  }

  // `mkdir -p`, granting on the deepest existing ancestor when it is read-only.
  async mkdirp(dir: string): Promise<void> {
    try { await fsp.mkdir(dir, { recursive: true }); return; }
    catch (e) { if (!isEacces(e)) throw e; }
    let anc = path.dirname(dir);
    for (;;) {
      const st = await fsp.lstat(anc).catch(() => null);
      if (st) break;
      const up = path.dirname(anc);
      if (up === anc) break;
      anc = up;
    }
    await this.inDir(anc, () => fsp.mkdir(dir, { recursive: true }).then(() => {}));
  }
}

// Rewrite a file that lacks owner write: add it, run `fn`, then set `finalMode`
// — also when `fn` throws. No lock: the control channel serialises per path
// and this touches only the file's own mode.
export async function withOwnerWrite<T>(file: string, finalMode: number, fn: () => Promise<T>): Promise<T> {
  const st = await fsp.lstat(file).catch(() => null);
  if (!st || !st.isFile()) return fn();
  const cur = st.mode & 0o7777;
  if (cur & 0o200) return fn();
  await fsp.chmod(file, cur | 0o200);
  try { return await fn(); }
  finally { await fsp.chmod(file, finalMode).catch(() => {}); }
}

// `rm -rf` that survives read-only directories BELOW `p`: on EACCES, give every
// directory in the subtree owner rwx (best-effort) and remove again. A
// read-only PARENT of `p` is the caller's grant (`DirGrants.inDir`). Throws if
// the second attempt fails so the caller can log it.
export async function removeOwnedTree(p: string): Promise<void> {
  try { await fsp.rm(p, { recursive: true, force: true }); return; }
  catch (e) { if (!isEacces(e)) throw e; }
  const open = async (dir: string): Promise<void> => {
    const st = await fsp.lstat(dir).catch(() => null);
    if (!st || !st.isDirectory()) return;
    if ((st.mode & OWNER_RWX) !== OWNER_RWX) await fsp.chmod(dir, (st.mode & 0o7777) | OWNER_RWX).catch(() => {});
    for (const n of await fsp.readdir(dir).catch(() => [] as string[])) await open(path.join(dir, n));
  };
  await open(p);
  await fsp.rm(p, { recursive: true, force: true });
}
