// WHERE THE REMOTE'S BYTES COME FROM — the one interface cc's control handler
// talks to, and the S2 implementation of it.
//
// The handler (control.ts) knows about frames, the mirror and serialisation; it
// knows nothing about how a file is reached. That split is what made S3 a
// SUBSTITUTION rather than a rewrite: production passes `systemSource`
// (systemSource.ts), a real `System` handle behind the same five methods, and
// not one signature here changed for it.

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

// THE SOURCE COULD NOT BE ASKED — distinct from the source having nothing
// there. Conflating the two is how a transient EMFILE becomes an `rm` of a live
// file: the handler reads "absent", removes the mirror entry, and the reconcile
// then removes the source's.
export interface SourceError { error: string }

export function isSourceError(x: unknown): x is SourceError {
  return typeof x === 'object' && x !== null && 'error' in x;
}

export interface RemoteSource {
  // null ⇒ the source has nothing at this path. Not an error: it is the answer
  // the daemon turns into -ENOENT, and the handler uses it to remove a stale
  // mirror entry so a deleted remote file stops appearing locally.
  stat(p: string): Promise<RemoteStat | null | SourceError>;
  list(p: string): Promise<RemoteChild[] | null | SourceError>;
  fetch(p: string, dest: string): Promise<'ok' | 'absent' | 'refused'>;
  // MAKE THE SOURCE HOLD NOTHING AT `p`. Split from `push` deliberately: a
  // removal is DECLARED by the daemon on the frame, never inferred from an
  // absent mirror entry, so the two intents cannot be confused by a mirror the
  // handler is also managing as a cache.
  remove(p: string): Promise<'ok' | { error: string }>;
  // RECONCILE, not "copy this file back": make the source entry at `p` match
  // the MIRROR entry at `src`, whatever the mirror now holds there — including
  // nothing, which is how a deletion lands.
  //
  // That generality is what lets the whole set of mutating ops land through the
  // ONE `DIRTY` frame instead of a frame per op. The daemon mutates the mirror
  // and then says "the mirror at P is now authoritative"; every op it can
  // express — create, write, truncate, chmod, utimens, mkdir, symlink, unlink,
  // rmdir, and each end of a rename — is that one sentence.
  //
  // ITS DOMAIN IS EXACTLY WHAT `RemoteStat` CAN EXPRESS: file, dir, symlink,
  // absent. An op outside that — a device node, a hard link, an ownership
  // change — cannot be reconciled and is REFUSED by the daemon rather than
  // applied to the mirror alone (see union.c's `push_mirror` callers).
  push(src: string, p: string): Promise<'ok' | { error: string }>;
}

// ── THE DETERMINISTIC SOURCE ────────────────────────────────────────────────
//
// A plain local directory. NOT the production source any more — that is
// `systemSource` — but not deleted either, because it has three live jobs that
// a real transport cannot do:
//
//   1. the unit suite's. `tests/fuse-control-channel.test.mjs` drives the whole
//      control channel against it with no provider and no latency.
//   2. the real lifecycle gate's. Criteria 3 and 4 are only checkable when the
//      remote's bytes DIFFER from the host's at the same path — S1's bind-mount
//      stand-in made them identical and the distinction unobservable — and that
//      gate must not need a container. `CC_FUSE_SOURCE_OVERRIDE_ROOT` selects
//      it, and `src/instances.ts` reports it loudly on the session's stream,
//      because a session using it is not talking to its system at all.
//   3. THE MEASUREMENT CONTROL: the arm the transport's cost is reported
//      against (tests/fuse-transport-bench.mjs).
//
// WHAT IT PROVES: the control channel, the mirror discipline and the tier
// policy — every frame, every materialisation, every refusal. WHAT IT DOES NOT
// PROVE: any transport, any latency and any `System` call.
export function localDirSource(root: string): RemoteSource {
  // The source is addressed by the path the WORKER sees, which is absolute in
  // the union's own space; `/` maps to `root`. A path that escapes `root` is a
  // refusal rather than a clamp — a silent clamp would serve a different file
  // than the one asked about.
  const resolve = (p: string): string | null => {
    const abs = path.posix.normalize(path.posix.join(root, p));
    return withinPosix(abs, root) === null ? null : abs;
  };

  // `null` MEANS THE SOURCE HAS NOTHING THERE, and an error means the source
  // could not be ASKED — conflating them makes the handler read an EMFILE or
  // EACCES as "absent", which then removes a live mirror entry and, at the next
  // reconcile, a live SOURCE file. An error is its own value and never reaches
  // an absence path.
  const statAt = async (abs: string): Promise<RemoteStat | null | SourceError> => {
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
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // ENOENT/ENOTDIR ARE THE ANSWER, not a failure to get one: the source
      // genuinely has nothing there. Every other errno means this machine could
      // not look, and saying "absent" to it is what removed live files.
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
      return { error: `stat '${abs}': ${err.message}` };
    }
  };

  return {
    async stat(p) {
      const abs = resolve(p);
      return abs === null ? { error: `'${p}' is outside the remote root` } : statAt(abs);
    },
    async list(p) {
      const abs = resolve(p);
      if (abs === null) return { error: `'${p}' is outside the remote root` };
      let names: string[];
      try { names = await fsp.readdir(abs); }
      catch (e) {
        const err = e as NodeJS.ErrnoException;
        // ENOENT/ENOTDIR are the source genuinely having no directory there.
        // Anything else is this machine failing to look, and answering
        // "absent" to it would unmirror the whole directory.
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
        return { error: `readdir '${abs}': ${err.message}` };
      }
      const out: RemoteChild[] = [];
      for (const name of names) {
        const st = await statAt(path.posix.join(abs, name));
        if (st === null) continue;
        if (isSourceError(st)) return st;
        out.push({ name, ...st });
      }
      return out;
    },
    async fetch(p, dest) {
      const abs = resolve(p);
      if (abs === null) return 'refused';
      const st = await statAt(abs);
      if (st !== null && isSourceError(st)) return 'refused';
      if (st === null) return 'absent';
      if (st.kind !== 'file') return 'ok';   // the handler already shaped it
      try { await fsp.copyFile(abs, dest); return 'ok'; }
      catch { return 'refused'; }
    },
    // A DECLARED removal, never one inferred from an absent mirror entry. The
    // directory case is NON-RECURSIVE by deliberate choice: the mirror may be
    // sparser than the source, so removing a directory whose source copy still
    // holds children the worker never enumerated must refuse ENOTEMPTY and
    // fail the op. A recursive delete driven by a frame is what that avoids.
    async remove(p) {
      const abs = resolve(p);
      if (abs === null) return { error: `'${p}' is outside the remote root` };
      try {
        const cur = await fsp.lstat(abs).catch(() => null);
        if (cur === null) return 'ok';
        if (cur.isDirectory()) await fsp.rmdir(abs);
        else await fsp.unlink(abs);
        return 'ok';
      } catch (e) { return { error: (e as Error).message }; }
    },
    async push(src, p) {
      const abs = resolve(p);
      if (abs === null) return { error: `'${p}' is outside the remote root` };
      try {
        const mirror = await fsp.lstat(src).catch(() => null);
        const kindOf = (st: import('node:fs').Stats): string | null =>
          st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null;
        const cur = await fsp.lstat(abs).catch(() => null);

        // AN ABSENT MIRROR ENTRY IS NOT A DELETION. `push` is reached
        // only for a DIRTY whose REMOVED bit is clear, so the mirror is
        // supposed to be holding the entry; its absence means cc's own cache
        // lost it, and the caller refuses rather than deleting the source. A
        // removal comes through `remove` above, declared on the frame.
        if (mirror === null) return { error: `the mirror holds nothing at '${p}'` };

        const kind = kindOf(mirror);
        if (kind === null) return { error: `'${p}' is a kind the mirror cannot carry` };
        await fsp.mkdir(path.posix.dirname(abs), { recursive: true });
        // A source entry of the WRONG KIND is replaced, not adjusted — a file
        // that became a directory cannot be chmod'd into one.
        if (cur && kindOf(cur) !== kind) {
          if (cur.isDirectory()) await fsp.rmdir(abs);
          else await fsp.unlink(abs);
        }
        if (kind === 'symlink') {
          await fsp.rm(abs, { force: true });
          await fsp.symlink(await fsp.readlink(src), abs);
          return 'ok';
        }
        if (kind === 'dir') {
          await fsp.mkdir(abs, { recursive: true });
          await fsp.chmod(abs, mirror.mode & 0o7777);
          return 'ok';
        }
        // MODE AND TIMES COME FROM THE MIRROR ENTRY, because the mirror entry
        // is what "make the source match it" means — not because they survive
        // an atomic write. They do not: a tmp+rename INSIDE the mirror hands
        // the replacement fresh permissions, so the mirror's own mode is
        // already the post-rename one and copying it cannot restore the
        // original. Remembering the pre-edit mode across that rename is a
        // different mechanism and is S3's (docs/architecture.md → "What
        // `fileBridge` carried, and where it has to land again").
        await fsp.copyFile(src, abs);
        await fsp.chmod(abs, mirror.mode & 0o7777);
        await fsp.utimes(abs, new Date(mirror.atimeMs), new Date(mirror.mtimeMs));
        return 'ok';
      } catch (e) { return { error: (e as Error).message }; }
    },
  };
}
