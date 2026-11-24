import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from '../projects.ts';
import { isSlug } from '../identifiers.ts';
import { errCode } from '../../shared/basics.ts';

// A plugin backend's stdout+stderr file. cc opens it and hands the descriptor to
// the child as fds 1 and 2, so cc holds no pipe the child writes into: a backend
// that outlives the cc that spawned it keeps a valid stdout/stderr, and a direct
// process.stdout.write into it cannot die on EPIPE. Stateless — the supervisor
// and the registry decide when to rotate, read and trim.
//
//   <orchStoreRoot()>/plugins/logs/<id>/backend.log       the current run
//   <orchStoreRoot()>/plugins/logs/<id>/backend.prev.log  the run before it
//
// cc-owned, deliberately NOT under data/<id>/, which is plugin-owned.

export const LOG_MAX_BYTES = 8 * 1024 * 1024;  // a running backend's log is trimmed past this
export const LOG_KEEP_BYTES = 1024 * 1024;     // …down to its newest this-many bytes
export const LOG_TAIL_BYTES = 64 * 1024;       // what GET /api/plugins/:id/log returns

export interface BackendLogPaths { current: string; previous: string }

export interface LogTail { exists: boolean; size: number; text: string; truncated: boolean }

// Recomputed per call (follows PROJECTS_ROOT) and absolute; slug-guarded like
// pluginDataDir so traversal-safety does not rest on callers.
export function backendLogPaths(id: string): BackendLogPaths {
  if (!isSlug(id)) throw new Error(`backendLogPaths: '${id}' is not a valid plugin id`);
  const dir = path.resolve(orchStoreRoot(), 'plugins', 'logs', id);
  return { current: path.join(dir, 'backend.log'), previous: path.join(dir, 'backend.prev.log') };
}

// One generation is kept: the previous run's log is overwritten.
export async function rotateBackendLog({ current, previous }: BackendLogPaths): Promise<void> {
  await fs.mkdir(path.dirname(current), { recursive: true });
  try { await fs.rename(current, previous); }
  catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
}

// O_APPEND is load-bearing: the child's duplicated fds share this open file
// description, so after trimLog truncates, the child's next write lands at the
// new end of file instead of leaving a NUL-filled hole at its old offset.
export async function openBackendLog(current: string): Promise<fs.FileHandle> {
  return fs.open(current, 'a', 0o600);
}

async function readRange(file: string, from: number, length: number): Promise<Buffer> {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, from);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

// The last `maxBytes` of the file, or the bytes from `fromOffset` on when that is
// shorter. A cut tail drops its partial first line. UTF-8 with replacement.
export async function readLogTail(file: string, maxBytes: number, fromOffset = 0): Promise<LogTail> {
  let size: number;
  try { size = (await fs.stat(file)).size; }
  catch (e) {
    if (errCode(e) === 'ENOENT') return { exists: false, size: 0, text: '', truncated: false };
    throw e;
  }
  const start = Math.max(Math.min(fromOffset, size), size - maxBytes);
  const buf = await readRange(file, start, size - start);
  let text = buf.toString('utf8');
  const truncated = start > Math.min(fromOffset, size);
  if (truncated) {
    const nl = text.indexOf('\n');
    text = nl === -1 ? '' : text.slice(nl + 1);
  }
  return { exists: true, size, text, truncated };
}

// Over `maxBytes`: keep the newest `keepBytes`, behind a marker line. Returns
// whether it trimmed.
//
// Everything runs on ONE descriptor, opened 'r+' on the file as it is now:
//  - single inode: size, tail read, truncate and rewrite all act on that one
//    file. A start that rotates the log while a trim is in flight renames the
//    file out from under the path, so the trim lands on the old run's file
//    (now `backend.prev.log`) and can never truncate the new `backend.log` or
//    put the old run's tail into it. Re-resolving the path between steps would
//    reopen that window;
//  - 'r+' rather than 'a+': it never creates (a missing file stays missing) and
//    is write-capable, which truncation needs on Windows — libuv opens 'a'/'a+'
//    with FILE_APPEND_DATA only, and SetEndOfFile requires write access.
//
// The child's own descriptors stay O_APPEND (openBackendLog), so after the
// truncate its next write lands at the new end of file, never at a stale offset.
// What our non-append fd gives up: the retained tail is written at offset 0, so
// a line the child wrote in the gap between our truncate and our write is
// overwritten (lost). Before, it would have survived ahead of the tail. A child
// write racing a trim could always be lost or misplaced — a child cannot be asked
// to cooperate — and this is the same class, with the same one-write window.
export async function trimLog(file: string, { maxBytes, keepBytes }: { maxBytes: number; keepBytes: number }): Promise<boolean> {
  let fh: fs.FileHandle;
  try { fh = await fs.open(file, 'r+'); }
  catch (e) { if (errCode(e) === 'ENOENT') return false; throw e; }
  try {
    const { size } = await fh.stat();
    if (size <= maxBytes) return false;
    const kept = Buffer.alloc(Math.min(keepBytes, size));
    const { bytesRead } = await fh.read(kept, 0, kept.length, size - kept.length);
    const tail = kept.subarray(0, bytesRead);
    const marker = `[cc ${new Date().toISOString()}: log trimmed, ${size - tail.length} bytes dropped]\n`;
    const out = Buffer.concat([Buffer.from(marker), tail]);
    await fh.truncate(0);
    await fh.write(out, 0, out.length, 0);
    return true;
  } finally { await fh.close(); }
}
