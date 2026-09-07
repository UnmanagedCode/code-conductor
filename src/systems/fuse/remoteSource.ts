// WHERE THE REMOTE'S BYTES COME FROM — the one interface cc's control handler
// talks to, and the S2 implementation of it.
//
// The handler (control.ts) knows about frames, the mirror and serialisation; it
// knows nothing about how a file is reached. That split is what makes S3 a
// substitution rather than a rewrite: S3 deletes `localDirSource` and passes a
// `System`-backed implementation of the same four methods.

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { withinPosix } from '../mirror.ts';

export interface RemoteStat {
  kind: 'file' | 'dir' | 'symlink';
  size: number;
  // The POSIX permission bits only — the handler applies them to the mirror
  // entry it creates, and the entry's TYPE comes from `kind`.
  mode: number;
  mtimeMs: number;
  // Set for `symlink` only.
  target?: string;
}

export interface RemoteChild extends RemoteStat {
  name: string;
}

export interface RemoteSource {
  // null ⇒ the source has nothing at this path. Not an error: it is the answer
  // the daemon turns into -ENOENT, and the handler uses it to remove a stale
  // mirror entry so a deleted remote file stops appearing locally.
  stat(p: string): Promise<RemoteStat | null>;
  list(p: string): Promise<RemoteChild[] | null>;
  fetch(p: string, dest: string): Promise<'ok' | 'absent' | 'refused'>;
  push(src: string, p: string): Promise<'ok' | { error: string }>;
}

// ── THE S2 FAKE REMOTE, LABELLED AS ONE ─────────────────────────────────────
//
// A plain local directory. WHAT IT PROVES: the control channel, the mirror
// discipline and the tier policy — every frame, every materialisation, every
// refusal. WHAT IT DOES NOT PROVE: any transport, any latency and any `System`
// call. S3 (2026-0356) deletes it.
//
// It exists as a separate ROOT rather than as "the host filesystem" because
// criteria 3 and 4 are only checkable when the remote's bytes DIFFER from the
// host's at the same path: S1's bind-mount stand-in made them identical and the
// distinction unobservable.
export function localDirSource(root: string): RemoteSource {
  // The source is addressed by the path the WORKER sees, which is absolute in
  // the union's own space; `/` maps to `root`. A path that escapes `root` is a
  // refusal rather than a clamp — a silent clamp would serve a different file
  // than the one asked about.
  const resolve = (p: string): string | null => {
    const abs = path.posix.normalize(path.posix.join(root, p));
    return withinPosix(abs, root) === null ? null : abs;
  };

  const statAt = async (abs: string): Promise<RemoteStat | null> => {
    try {
      const st = await fsp.lstat(abs);
      if (st.isSymbolicLink()) {
        return { kind: 'symlink', size: st.size, mode: st.mode & 0o7777, mtimeMs: st.mtimeMs, target: await fsp.readlink(abs) };
      }
      if (st.isDirectory()) return { kind: 'dir', size: 0, mode: st.mode & 0o7777, mtimeMs: st.mtimeMs };
      if (st.isFile()) return { kind: 'file', size: st.size, mode: st.mode & 0o7777, mtimeMs: st.mtimeMs };
      // A device, fifo or socket has no faithful mirror representation, and a
      // regular file standing in for one would answer wrongly about what it is.
      return null;
    } catch { return null; }
  };

  return {
    async stat(p) {
      const abs = resolve(p);
      return abs === null ? null : statAt(abs);
    },
    async list(p) {
      const abs = resolve(p);
      if (abs === null) return null;
      let names: string[];
      try { names = await fsp.readdir(abs); }
      catch { return null; }
      const out: RemoteChild[] = [];
      for (const name of names) {
        const st = await statAt(path.posix.join(abs, name));
        if (st) out.push({ name, ...st });
      }
      return out;
    },
    async fetch(p, dest) {
      const abs = resolve(p);
      if (abs === null) return 'refused';
      const st = await statAt(abs);
      if (st === null) return 'absent';
      if (st.kind !== 'file') return 'ok';   // the handler already shaped it
      try { await fsp.copyFile(abs, dest); return 'ok'; }
      catch { return 'refused'; }
    },
    async push(src, p) {
      const abs = resolve(p);
      if (abs === null) return { error: `'${p}' is outside the remote root` };
      try {
        // MODE CARRIED ACROSS, and it has to be: an atomic write ends in a
        // rename, and a rename hands the replacement fresh permissions, so an
        // edited shell script silently loses its executable bit otherwise.
        const st = await fsp.stat(src);
        await fsp.mkdir(path.posix.dirname(abs), { recursive: true });
        await fsp.copyFile(src, abs);
        await fsp.chmod(abs, st.mode & 0o7777);
        return 'ok';
      } catch (e) { return { error: (e as Error).message }; }
    },
  };
}
