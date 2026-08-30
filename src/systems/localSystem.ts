// The in-process `local` System: cc's own machine, reached with `node:fs` and
// the shared detached process-group runner. It is the built-in every project
// resolves to until a remote system is registered, and its whole job is to be
// INDISTINGUISHABLE from the direct calls it replaced — each method below is
// the code that used to sit at the call site, moved behind the interface.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runGroupedCommand } from '../groupedCommand.ts';
import { requireAbsolute } from './system.ts';
import type {
  ExecOptions, ExecResult, ExecSpec, System, SystemDirent, SystemEntryKind, SystemStat, WriteFileOptions,
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
// from src/projects.ts, where it used to live and where most callers import it)
// because cc's own STORE writes go through it too — the store is always local,
// so its atomic write and this system's are the same operation, not two.
//
// The tmp name must be
// unique per call: pid separates processes, the counter separates concurrent
// calls within one process (board 2026-0156 — a shared name let the winner's
// rename delete the loser's still-in-flight source file). The `unlink` below is
// required *because* the name is unique, and is only safe for that same reason.
// Concurrent writers to one target are last-write-wins, not merged or locked.
let atomicWriteSeq = 0;

export async function writeFileAtomic(filePath: string, data: string, mode?: number): Promise<void> {
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
    requireAbsolute('writeFile', 'path', filePath);
    if (opts.atomic && opts.exclusive) {
      // Nothing needs both, and the combination has no single honest meaning:
      // an atomic write ends in a rename, which overwrites by definition.
      throw new Error('writeFile: atomic and exclusive are mutually exclusive');
    }
    if (opts.atomic) return writeFileAtomic(filePath, data, opts.mode);
    if (opts.exclusive) {
      await fs.writeFile(filePath, data, { encoding: 'utf8', flag: 'wx' });
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

  async readDir(p: string): Promise<SystemDirent[]> {
    requireAbsolute('readDir', 'path', p);
    const entries = await fs.readdir(p, { withFileTypes: true });
    return entries.map(e => ({ name: e.name, kind: kindOf(e) }));
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
}
