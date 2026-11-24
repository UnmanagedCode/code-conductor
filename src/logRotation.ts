import { promises as fs } from 'node:fs';
import path from 'node:path';
import { errCode } from '../shared/basics.ts';
import { createKeyedQueue } from './keyedQueue.ts';

// Generic file mechanisms for cc-owned logs. Callers own the policy (paths, caps).

// One generation: `previous` is overwritten. Creates current's parent; a missing current is fine.
export async function rotateFile(current: string, previous: string): Promise<void> {
  await fs.mkdir(path.dirname(current), { recursive: true });
  try { await fs.rename(current, previous); }
  catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
}

// Over `maxBytes`: keep the newest `keepBytes`, behind a marker line. Returns
// whether it trimmed.
//
// Everything runs on ONE descriptor, opened 'r+' on the file as it is now:
//  - single inode: size, tail read, truncate and rewrite all act on that one
//    file. A start that rotates the log while a trim is in flight renames the
//    file out from under the path, so the trim lands on the old run's file
//    (now the rotated file) and can never truncate the new `backend.log` or
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
// to cooperate — and this is the same class, with the same one-write window. A
// racing child record longer than the rewrite can leave its suffix after the tail.
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
    // FileHandle.write may write less than asked: loop until the whole buffer is out.
    for (let done = 0; done < out.length;) {
      const { bytesWritten } = await fh.write(out, done, out.length - done, done);
      done += bytesWritten;
    }
    return true;
  } finally { await fh.close(); }
}

const appendQueue = createKeyedQueue();

// Appends `data` to `file`. If `file` is already over `maxBytes`, it is first renamed to `previous`
// (rotateFile), so `file` restarts at this call's first byte. All calls for one file are serialised
// in-process, in call order. A failure (stat other than ENOENT, rename, append) rejects to its own
// caller and does not block the next call.
export function appendRotating(file: string, data: Buffer, { maxBytes, previous }: { maxBytes: number; previous: string }): Promise<void> {
  return appendQueue(path.resolve(file), async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    let size = 0;
    try { size = (await fs.stat(file)).size; }
    catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
    if (size > maxBytes) await rotateFile(file, previous);
    await fs.appendFile(file, data);
  });
}
