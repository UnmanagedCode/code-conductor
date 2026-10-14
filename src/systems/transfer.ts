// Copy or move ONE regular file between two System endpoints — the engine
// behind the `system_transfer` MCP tool. Pure System logic: it knows nothing of
// the registry, the store or MCP, so either endpoint may be `local` or any
// registered system, and the same code runs whichever implementation backs it.
//
// THE ORDERING INVARIANT: nothing is written before the single atomic write, so
// every refusal up to it leaves both sides untouched; and a move deletes its
// source only after that write was acknowledged, the destination re-checked and
// the source re-checked. Any refusal after the write carries `written: true`
// and has kept the source.
//
// Every member used is one docs/systems-protocol.md already defines: the
// `readFile`/`writeFile` primitives plus the `stat`, `lstat`, `realpath` and
// `unlink` derivations.

import path from 'node:path';
import { MAX_FILE_BYTES } from './protocol.ts';
import type { System } from './system.ts';

export interface TransferEndpoint { sys: System; path: string }

export type TransferCode =
  | 'SOURCE_NOT_FOUND' | 'NOT_A_FILE' | 'EFBIG' | 'SAME_FILE' | 'DEST_EXISTS' | 'DEST_NOT_A_FILE'
  | 'SOURCE_CHANGED' | 'READ_FAILED' | 'WRITE_FAILED' | 'DEST_UNVERIFIED' | 'SOURCE_NOT_REMOVED';

export type TransferResult =
  | { ok: true; bytes: number; mode: string; moved: boolean }
  | { ok: false; code: TransferCode; reason: string; errno?: string; written?: true };

// The `code` on a thrown Node error or SystemError (e.g. 'ENOENT'), or
// undefined. Duplicated from storeLock.ts: it's four lines, and importing it
// across modules would couple every store to storeLock for one helper.
function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

// A System failure carrying a code is an ANSWER about the file and becomes a
// result; one without a code is cc's own defect (a requireAbsolute violation,
// say) and is rethrown rather than dressed up as a refusal.
function coded(e: unknown): string {
  const c = errCode(e);
  if (c === undefined) throw e;
  return c;
}

function refuse(code: TransferCode, reason: string, extra: { errno?: string; written?: true } = {}): TransferResult {
  return { ok: false, code, reason, ...extra };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const KIND_WORD = { dir: 'a directory', symlink: 'a symlink', other: 'a special file (fifo, socket or device)', file: 'a file' } as const;

// The directory ENTRY a path names: its parent realpath'd, its leaf kept. Two
// spellings that reach one file through a symlinked parent get one key, while a
// symlink leaf stays distinct from its target.
async function entryKey(e: TransferEndpoint): Promise<string> {
  return path.posix.join(await e.sys.realpath(path.posix.dirname(e.path)), path.posix.basename(e.path));
}

function sameEndpoint(a: System, b: System): boolean {
  return a.id === b.id && a.remoteId === b.remoteId;
}

export async function transferFile(
  src: TransferEndpoint, dst: TransferEndpoint, { move, overwrite }: { move: boolean; overwrite: boolean },
): Promise<TransferResult> {
  // 1–3: the source, followed through links, typed and sized BEFORE it is
  // opened — a fifo would hang the read and a device stream forever.
  let st;
  try { st = await src.sys.stat(src.path); }
  catch (e) {
    const c = coded(e);
    if (c === 'ENOTDIR') return refuse('SOURCE_NOT_FOUND', `no file at '${src.path}': ${errMsg(e)}`);
    return refuse('READ_FAILED', `cannot stat '${src.path}': ${errMsg(e)}`, { errno: c });
  }
  if (!st) return refuse('SOURCE_NOT_FOUND', `no file at '${src.path}'`);
  if (st.kind !== 'file') return refuse('NOT_A_FILE', `'${src.path}' is ${KIND_WORD[st.kind]}, not a regular file`);
  if (st.size > MAX_FILE_BYTES) {
    return refuse('EFBIG', `'${src.path}' is ${st.size} bytes, above the ${MAX_FILE_BYTES}-byte per-file cap`);
  }

  // 4–7: what is at the destination, NOT followed — a symlink there is an entry
  // to replace, never a path to write through.
  let dl;
  try { dl = await dst.sys.lstat(dst.path); }
  catch (e) { return refuse('WRITE_FAILED', `cannot inspect '${dst.path}': ${errMsg(e)}`, { errno: coded(e) }); }
  if (dl) {
    if (sameEndpoint(src.sys, dst.sys)) {
      let same: boolean;
      try { same = (await entryKey(src)) === (await entryKey(dst)); }
      catch (e) { return refuse('READ_FAILED', `cannot resolve '${src.path}' / '${dst.path}': ${errMsg(e)}`, { errno: coded(e) }); }
      // Without this a move+overwrite through an alias writes the file over
      // itself and then deletes it.
      if (same) return refuse('SAME_FILE', `'${src.path}' and '${dst.path}' are the same directory entry`);
    }
    if (!overwrite) return refuse('DEST_EXISTS', `'${dst.path}' already exists (${KIND_WORD[dl.kind]}); pass overwrite:true to replace it`);
    if (dl.kind === 'dir' || dl.kind === 'other') {
      return refuse('DEST_NOT_A_FILE', `'${dst.path}' is ${KIND_WORD[dl.kind]}; only a file or a symlink is replaced`);
    }
  }

  // 8: the bytes, bounded by the stat — LocalSystem's read has no cap of its own.
  let bytes: Buffer;
  try { bytes = await src.sys.readFileBytes(src.path, { length: st.size }); }
  catch (e) {
    const c = coded(e);
    if (c === 'ENOENT') return refuse('SOURCE_NOT_FOUND', `'${src.path}' disappeared before it was read`);
    if (c === 'EFBIG') return refuse('EFBIG', errMsg(e));
    return refuse('READ_FAILED', `cannot read '${src.path}': ${errMsg(e)}`, { errno: c });
  }
  if (bytes.length !== st.size) {
    return refuse('SOURCE_CHANGED', `'${src.path}' changed while it was read (${st.size} bytes stat'd, ${bytes.length} read); nothing was written`);
  }

  // 9: the one write. Atomic, so it lands whole or not at all and replaces a
  // destination symlink rather than following it; only the rwx bits carry.
  const mode = st.mode & 0o777;
  try { await dst.sys.writeFileBytes(dst.path, bytes, { atomic: true, mode }); }
  catch (e) {
    const c = coded(e);
    if (c === 'EFBIG') return refuse('EFBIG', errMsg(e));
    return refuse('WRITE_FAILED', `cannot write '${dst.path}': ${errMsg(e)}`, { errno: c });
  }
  const done = { ok: true as const, bytes: bytes.length, mode: '0' + mode.toString(8).padStart(3, '0') };
  if (!move) return { ...done, moved: false };

  // 11: the destination shows what was written.
  let v;
  try { v = await dst.sys.lstat(dst.path); }
  catch (e) {
    return refuse('DEST_UNVERIFIED', `wrote '${dst.path}' but cannot re-check it: ${errMsg(e)}; the source was kept`,
      { errno: coded(e), written: true });
  }
  if (!v || v.kind !== 'file' || v.size !== bytes.length) {
    return refuse('DEST_UNVERIFIED', `wrote '${dst.path}' but it does not show the ${bytes.length}-byte file; the source was kept`, { written: true });
  }

  // 12: the source is still what was read — deleting one appended to during the
  // copy would lose the new bytes.
  let st2;
  try { st2 = await src.sys.stat(src.path); }
  catch (e) {
    return refuse('SOURCE_CHANGED', `cannot re-check '${src.path}': ${errMsg(e)}; the source was kept`,
      { errno: coded(e), written: true });
  }
  if (!st2 || st2.size !== st.size || st2.mtimeMs !== st.mtimeMs) {
    return refuse('SOURCE_CHANGED', `'${src.path}' changed during the move; the destination holds the copy and the source was kept`, { written: true });
  }

  // 13: one entry, never followed — a symlinked source loses the link only.
  try { await src.sys.unlink(src.path); }
  catch (e) {
    const c = coded(e);
    if (c !== 'ENOENT') {
      return refuse('SOURCE_NOT_REMOVED', `copied to '${dst.path}' but cannot remove '${src.path}': ${errMsg(e)}`,
        { errno: c, written: true });
    }
  }
  return { ...done, moved: true };
}
