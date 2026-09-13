// THE REMOTE SOURCE OVER A REAL `System` HANDLE — the substitution
// `remoteSource.ts` was built as an interface for, and the first thing in this
// epic that crosses a wire.
//
// NO ROOT ARGUMENT, AND THAT IS THE WHOLE POINT. A path `P` from the
// daemon is the path ON THE SYSTEM: one spelling, no `root + P` arithmetic, and
// therefore no place for one to be wrong. `localDirSource` needs a root because
// it is pretending; this does not because it is not.
//
// THE ABSENT-VS-UNREACHABLE DISTINCTION IS THE MOST IMPORTANT THING IN THIS
// FILE. `remoteSource.ts`'s own header records why: swallowing an EMFILE into
// `null` told the handler "absent", which removed a live mirror entry and then,
// at the reconcile, a live SOURCE file. Only ENOENT and ENOTDIR may become
// `null` here. ETRANSPORT, EACCES, ETIMEDOUT, EUNKNOWN — every one is
// `{error}`, which the handler turns into a REFUSED reply and no mutation.

import { promises as fsp } from 'node:fs';
import { SystemError } from '../protocol.ts';
import type { System, SystemLstat } from '../system.ts';
import type { RemoteChild, RemoteSource, RemoteStat, SourceError } from './remoteSource.ts';

// The two codes that mean "the source genuinely has nothing at this path", and
// the ONLY two. Named once so a reader can see the whole allow-list at a
// glance rather than finding it spelled three times.
function isAbsence(e: unknown): boolean {
  return e instanceof SystemError && (e.code === 'ENOENT' || e.code === 'ENOTDIR');
}

function reason(op: string, p: string, e: unknown): SourceError {
  const code = e instanceof SystemError ? `${e.code}: ` : '';
  return { error: `${op} '${p}': ${code}${e instanceof Error ? e.message : String(e)}` };
}

// A `SystemLstat` as the mirror can carry it, or null for a kind it cannot. A
// device, fifo or socket has no faithful mirror representation, and a regular
// file standing in for one would answer wrongly about what it is — the same
// judgement `localDirSource` makes, so the two sources agree.
function asRemoteStat(st: SystemLstat): RemoteStat | null {
  if (st.kind === 'symlink') {
    return { kind: 'symlink', size: st.size, mode: st.mode & 0o7777, mtimeMs: st.mtimeMs, target: st.target ?? '' };
  }
  if (st.kind === 'dir') return { kind: 'dir', size: st.size, mode: st.mode & 0o7777, mtimeMs: st.mtimeMs };
  if (st.kind === 'file') return { kind: 'file', size: st.size, mode: st.mode & 0o7777, mtimeMs: st.mtimeMs };
  return null;
}

export function systemSource(system: System, opts: { log?: (line: string) => void } = {}): RemoteSource {
  const note = (line: string): void => opts.log?.(`cc-union source[${system.id}]: ${line}`);

  return {
    // ONE ROUND TRIP. `lstat` already folds ENOENT and ENOTDIR into `null`, so
    // an absence arrives here as a value and only a real failure throws.
    async stat(p) {
      try {
        const st = await system.lstat(p);
        return st === null ? null : asRemoteStat(st);
      } catch (e) {
        note(`stat '${p}' failed: ${String(e)}`);
        return reason('stat', p, e);
      }
    },

    // ONE ROUND TRIP FOR THE WHOLE DIRECTORY, which is what the widened
    // `SystemDirent` exists for: the mode, size, mtime and symlink target of
    // every child ride the same `find`, where a name-and-kind listing would
    // cost a second round trip PER CHILD.
    async list(p) {
      let kids;
      try { kids = await system.readDir(p); }
      catch (e) {
        // ENOENT/ENOTDIR are the source genuinely having no directory here.
        // Anything else is cc failing to ask, and answering "absent" to that
        // would unmirror the whole directory.
        if (isAbsence(e)) return null;
        note(`list '${p}' failed: ${String(e)}`);
        return reason('list', p, e);
      }
      const out: RemoteChild[] = [];
      for (const c of kids) {
        const st = asRemoteStat(c);
        if (st !== null) out.push({ name: c.name, ...st });
      }
      return out;
    },

    async fetch(p, dest) {
      let bytes: Buffer;
      try { bytes = await system.readFileBytes(p); }
      catch (e) {
        if (e instanceof SystemError && e.code === 'ENOENT') return 'absent';
        note(`fetch '${p}' failed: ${String(e)}`);
        return 'refused';
      }
      // The handler has already `#shape`d `dest` to the source's size and mode,
      // so this overwrites IN PLACE and keeps that inode — which is what the
      // revalidate fingerprint is recorded against.
      try { await fsp.writeFile(dest, bytes); return 'ok'; }
      catch (e) { note(`fetch '${p}' could not land in the mirror: ${String(e)}`); return 'refused'; }
    },

    // A DECLARED removal, never one inferred from an absent mirror entry.
    // `removeEntry` is non-recursive by contract and resolves on an absent
    // path, so both halves of `localDirSource`'s behaviour come from the
    // interface rather than from a branch here.
    async remove(p) {
      try { await system.removeEntry(p); return 'ok'; }
      catch (e) { note(`remove '${p}' failed: ${String(e)}`); return reason('remove', p, e); }
    },

    // RECONCILE: make the source entry at `p` match the MIRROR entry at `src`.
    async push(src, p) {
      let mirror;
      try { mirror = await fsp.lstat(src); }
      catch {
        // AN ABSENT MIRROR ENTRY IS NOT A DELETION — a removal is declared on
        // the frame. Byte-identical to localDirSource's wording, so a caller
        // (and a test) cannot tell the two sources apart by it.
        return { error: `the mirror holds nothing at '${p}'` };
      }
      const kind = mirror.isSymbolicLink() ? 'symlink' : mirror.isDirectory() ? 'dir' : mirror.isFile() ? 'file' : null;
      if (kind === null) return { error: `'${p}' is a kind the mirror cannot carry` };
      const mode = mirror.mode & 0o7777;
      // `atomic` creates the parent and renames over the target, and `mode` is
      // what makes the write PRESERVING — the rename installs the temp file, so
      // without it an edited script comes back 0644
      // (docs/systems-protocol.md §6).
      const land = async (): Promise<void> => {
        if (kind === 'symlink') return system.symlink(await fsp.readlink(src), p);
        if (kind === 'dir') {
          // A SYMLINK AT `p` IS THE ONE KIND CHANGE THE RETRY BELOW CANNOT
          // REACH, because nothing fails. Measured: `mkdir -p` over a
          // symlink-to-directory exits 0 leaving the link, and `chmod` then
          // FOLLOWS it — so the push returns 'ok' with the source holding a
          // link where the mirror says directory, and with a mode change
          // landed on a directory nobody named. A success reported having
          // landed somewhere else, which is the class this epic exists to
          // close, and a result comparison cannot catch it because both
          // sources answer 'ok': only the landed KIND differs.
          //
          // Neither `mkdir` nor `chmod` has a no-follow form to reach for, so
          // the kind is asked for. ONE extra round trip, on the DIR arm only —
          // a file push, the hot path, still costs one.
          const at = await system.lstat(p);
          if (at !== null && at.kind !== 'dir') await system.removeEntry(p);
          await system.mkdir(p, { recursive: true });
          return system.chmod(p, mode);
        }
        return system.writeFileBytes(p, await fsp.readFile(src), { atomic: true, mode });
      };
      try {
        await land();
        return 'ok';
      } catch (e) {
        // A SOURCE ENTRY OF THE WRONG KIND IS REPLACED, NOT ADJUSTED — a file
        // that became a directory cannot be renamed over, and a directory that
        // became a file cannot be `mkdir`'d. `localDirSource` unlinks the
        // wrong-kind entry first and this must too, or the two sources answer
        // differently for the same mirror state and the deterministic suite
        // stops standing in for the transport.
        //
        // A SECOND ROUND TRIP, ONLY ON THE KIND CHANGE. The first attempt is
        // the probe: a stat-then-branch would pay for one on every push, and
        // a kind change is rare. `removeEntry` is non-recursive, so a
        // non-empty directory refuses ENOTEMPTY here exactly as
        // `localDirSource`'s `rmdir` does.
        //
        // WHAT ACTUALLY REACHES HERE, in the shape this file has today, is
        // EISDIR ALONE: a file whose source copy is a directory, where the
        // atomic write's rename cannot land.
        //
        // EEXIST AND ENOTDIR ARE UNPRODUCEABLE AS THIS STANDS, and that is
        // written down rather than discovered again: `ln -sfnT`'s `-f`
        // REPLACES whatever entry it finds (providerSystem.ts), and the dir
        // arm above pre-cleans a wrong-kind entry before `mkdir`, so neither
        // path can raise them. They are KEPT because each is one token in a
        // condition and each becomes live again the moment either of those two
        // shapes changes — dropping `-f`, or dropping the pre-clean — and a
        // guard that has to be re-derived after such a change is a guard that
        // will be missing. A mutant of the EEXIST arm is therefore EQUIVALENT,
        // not surviving.
        //
        // Retried ONCE. A second failure is the answer.
        const code = e instanceof SystemError ? e.code : null;
        if (code === 'EISDIR' || code === 'EEXIST' || code === 'ENOTDIR') {
          try {
            await system.removeEntry(p);
            await land();
            return 'ok';
          } catch (again) {
            note(`push '${p}' failed after replacing a wrong-kind entry: ${String(again)}`);
            return reason('push', p, again);
          }
        }
        note(`push '${p}' failed: ${String(e)}`);
        return reason('push', p, e);
      }
    },
  };
}
