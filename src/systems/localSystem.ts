// The in-process `local` System: cc's own machine, reached with `node:fs` and
// the shared detached process-group runner. It is the built-in every project
// resolves to until a remote system is registered, and its whole job is to be
// INDISTINGUISHABLE from a direct call — each method below is the code a call
// site would otherwise run, behind the interface.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runGroupedCommand } from '../groupedCommand.ts';
import type { MirrorAdvertisement } from './mirror.ts';
import { msFromNanos, requireAbsolute, typeBitsFor } from './system.ts';
import type {
  ExecOptions, ExecResult, ExecSpec, System, SystemDirent, SystemEntryKind, SystemLstat, SystemStat, WriteFileOptions,
} from './system.ts';

export const LOCAL_SYSTEM_ID = 'local';

function kindOf(s: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): SystemEntryKind {
  if (s.isDirectory()) return 'dir';
  if (s.isFile()) return 'file';
  if (s.isSymbolicLink()) return 'symlink';
  return 'other';
}

// The `code` on a thrown Node error (e.g. 'ENOENT'), or undefined — the
// narrowing point for error-code checks (catch variables are `unknown` under
// strict). Duplicated from storeLock.ts: it's four lines, and importing it
// across modules would couple every store to storeLock for one helper.
function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

// Shared mkdir-parent → write tmp(.pid.seq) → rename. Exported (and re-exported
// from src/projects.ts, where most callers import it)
// because cc's own STORE writes go through it too — the store is always local,
// so its atomic write and this system's are the same operation, not two.
//
// The tmp name must be
// unique per call: pid separates processes, the counter separates concurrent
// calls within one process (a shared name lets the winner's rename delete the
// loser's still-in-flight source file). The `unlink` below is
// required *because* the name is unique, and is only safe for that same reason.
// Concurrent writers to one target are last-write-wins, not merged or locked.
let atomicWriteSeq = 0;

export async function writeFileAtomic(filePath: string, data: string | Buffer, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${atomicWriteSeq++}.tmp`;
  try {
    await fs.writeFile(tmp, data);
    // On the TEMP file, before the rename: the target must never be observable
    // with the wrong mode, and after the rename there is no handle to fix.
    if (mode !== undefined) await fs.chmod(tmp, mode & 0o7777);
    await fs.rename(tmp, filePath);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
}

export class LocalSystem implements System {
  readonly id = LOCAL_SYSTEM_ID;
  // cc's own machine is one machine. There is no second target to name, so the
  // pin is here rather than in every reader.
  readonly remoteId = null;

  // `async` on these three so a guard violation REJECTS rather than throwing
  // synchronously: ProviderSystem's are async, and the two implementations of
  // one primitive cannot differ on whether a caller's `.catch()` sees it.
  async exec(spec: ExecSpec, opts: ExecOptions): Promise<ExecResult> {
    requireAbsolute('exec', 'cwd', opts.cwd);
    return runGroupedCommand(spec, opts);
  }

  async readFile(filePath: string): Promise<string> {
    requireAbsolute('readFile', 'path', filePath);
    return fs.readFile(filePath, 'utf8');
  }

  async readFileBytes(filePath: string, { length }: { length?: number } = {}): Promise<Buffer> {
    requireAbsolute('readFileBytes', 'path', filePath);
    if (length === undefined) return fs.readFile(filePath);
    const fh = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async writeFile(filePath: string, data: string, opts: WriteFileOptions = {}): Promise<void> {
    return this.#write('writeFile', filePath, data, opts);
  }

  // The SAME write with no string in the middle of it. Locally there is nothing
  // to encode, so this is one implementation and two entry points rather than
  // two implementations — the wire side is where the distinction bites.
  async writeFileBytes(filePath: string, data: Buffer, opts: WriteFileOptions = {}): Promise<void> {
    return this.#write('writeFileBytes', filePath, data, opts);
  }

  async #write(op: string, filePath: string, data: string | Buffer, opts: WriteFileOptions): Promise<void> {
    requireAbsolute(op, 'path', filePath);
    if (opts.atomic && opts.exclusive) {
      // Nothing needs both, and the combination has no single honest meaning:
      // an atomic write ends in a rename, which overwrites by definition.
      throw new Error(`${op}: atomic and exclusive are mutually exclusive`);
    }
    if (opts.atomic) return writeFileAtomic(filePath, data, opts.mode);
    if (opts.exclusive) {
      await fs.writeFile(filePath, data, { flag: 'wx' });
      if (opts.mode !== undefined) await fs.chmod(filePath, opts.mode & 0o7777);
      return;
    }
    await fs.writeFile(filePath, data);
    if (opts.mode !== undefined) await fs.chmod(filePath, opts.mode & 0o7777);
  }

  async stat(p: string): Promise<SystemStat | null> {
    requireAbsolute('stat', 'path', p);
    let s: Awaited<ReturnType<typeof fs.stat>>;
    try { s = await fs.stat(p); }
    catch (e) {
      // Absence is a value; a broken installation is not.
      if (errCode(e) === 'ENOENT') return null;
      throw e;
    }
    return { kind: kindOf(s), size: s.size, mode: s.mode, mtimeMs: s.mtimeMs };
  }

  async lstat(p: string): Promise<SystemLstat | null> {
    requireAbsolute('lstat', 'path', p);
    // `bigint` FOR THE NANOSECONDS, and only for them: `fs.Stats.mtimeMs` is
    // already a rounded double, so rounding it again cannot agree with the
    // wire's own integer arithmetic (see msFromNanos).
    let s: import('node:fs').BigIntStats;
    try { s = await fs.lstat(p, { bigint: true }); }
    catch (e) {
      // ENOTDIR alongside ENOENT: a non-directory component means there is no
      // entry here, which is the answer rather than a failure to get one — and
      // the derivation cannot tell the two apart either (`find` reports both as
      // a non-zero exit about the path it was given).
      const c = errCode(e);
      if (c === 'ENOENT' || c === 'ENOTDIR') return null;
      throw e;
    }
    return { ...this.#lstatOf(s), target: s.isSymbolicLink() ? await fs.readlink(p) : null };
  }

  // WHAT A DERIVATION CAN REPORT IS WHAT THIS REPORTS, in both fields, so the
  // two implementations are comparable EXACTLY rather than within a tolerance
  // that would hide a real drift:
  //
  //   mode    — `find -printf '%m'` carries permission bits alone, so the type
  //             bits come from the kind on both sides (see `typeBitsFor`).
  //   mtimeMs — through `msFromNanos`, the SAME function the wire side uses,
  //             from exact integer nanoseconds. Rounding each side in its own
  //             arithmetic disagreed on a half-millisecond boundary about once
  //             in 20k. (`stat` above is left at fs.stat's own sub-millisecond
  //             value; its callers ask about a target, and its conformance row
  //             already carries a tolerance.)
  #lstatOf(s: {
    size: bigint; mode: bigint; mtimeNs: bigint;
    isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean;
  }): SystemStat {
    const kind = kindOf(s);
    return {
      kind,
      size: Number(s.size),
      mode: (Number(s.mode) & 0o7777) | typeBitsFor(kind),
      mtimeMs: msFromNanos(Number(s.mtimeNs / 1_000_000_000n), Number(s.mtimeNs % 1_000_000_000n)),
    };
  }

  async readDir(p: string): Promise<SystemDirent[]> {
    requireAbsolute('readDir', 'path', p);
    const entries = await fs.readdir(p, { withFileTypes: true });
    // ONE STAT PER CHILD, and that is not the cost the widening exists to
    // avoid: locally these are syscalls on this machine, where the derivation's
    // 1 + N would be 1 + N ROUND TRIPS across a wire. The interface carries the
    // fields so the wire side can collapse them; this side just fills them in.
    return Promise.all(entries.map(async (e) => {
      const full = path.join(p, e.name);
      const s = await fs.lstat(full, { bigint: true });
      return {
        name: e.name,
        ...this.#lstatOf(s),
        target: s.isSymbolicLink() ? await fs.readlink(full) : null,
      };
    }));
  }

  async readlink(p: string): Promise<string> {
    requireAbsolute('readlink', 'path', p);
    return fs.readlink(p);
  }

  async symlink(target: string, p: string): Promise<void> {
    // `target` is the link's CONTENTS, read on the far side — a relative one is
    // legal and cc does not resolve it, so only `p` is checked.
    requireAbsolute('symlink', 'path', p);
    // REPLACES, matching `ln -sfn`: the derivation unlinks an existing entry
    // before linking, so this must too or the two disagree on every re-link.
    try { await fs.unlink(p); } catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
    await fs.symlink(target, p);
  }

  async removeEntry(p: string): Promise<void> {
    requireAbsolute('removeEntry', 'path', p);
    // `rm -d` in one call: unlink a file or symlink, rmdir an EMPTY directory,
    // refuse ENOTEMPTY otherwise. An absent `p` RESOLVES — the declared intent
    // is "hold nothing here", which is already true.
    try { await fs.unlink(p); return; }
    catch (e) {
      const c = errCode(e);
      if (c === 'ENOENT') return;
      // EISDIR on Linux, EPERM on macOS — the two spellings of "that is a
      // directory, use rmdir".
      if (c !== 'EISDIR' && c !== 'EPERM') throw e;
    }
    try { await fs.rmdir(p); }
    catch (e) { if (errCode(e) === 'ENOENT') return; throw e; }
  }

  async realpath(p: string): Promise<string> {
    requireAbsolute('realpath', 'path', p);
    return fs.realpath(p);
  }

  async mkdir(p: string, { recursive = false }: { recursive?: boolean } = {}): Promise<void> {
    requireAbsolute('mkdir', 'path', p);
    await fs.mkdir(p, { recursive });
  }

  async removeTree(p: string): Promise<void> {
    requireAbsolute('removeTree', 'path', p);
    await fs.rm(p, { recursive: true, force: true });
  }

  async unlink(p: string): Promise<void> {
    requireAbsolute('unlink', 'path', p);
    await fs.unlink(p);
  }

  async chmod(p: string, mode: number): Promise<void> {
    requireAbsolute('chmod', 'path', p);
    await fs.chmod(p, mode);
  }

  // cc's OWN machine advertises nothing, unconditionally. A session on a local
  // project is not redirected at all — there is no union mount and no tier table to
  // widen — so there is nothing here for an advertisement to mean.
  //
  // AND NOTHING CALLS IT, as a property of the ID rather than of this class:
  // mirror()'s only consumer is the create path's resolveMirrorScope
  // (src/instances.ts), which sits behind a redirect placement gated on
  // `id !== LOCAL_SYSTEM_ID` (src/instances.ts). So a `local` handle is never
  // asked for a mirror even when a provider is standing in for this class.
  async mirror(): Promise<MirrorAdvertisement> {
    return { mirrorRoot: null, exclude: [] };
  }
}
