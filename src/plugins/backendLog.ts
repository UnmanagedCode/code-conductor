import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from '../projects.ts';
import { isSlug } from '../identifiers.ts';
import { errCode } from '../../shared/basics.ts';
import { rotateFile } from '../logRotation.ts';

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
  return rotateFile(current, previous);
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

export { trimLog } from '../logRotation.ts';
