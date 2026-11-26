// The session a headless run last spawned its root as, recorded so a `--replay`
// (src/headless/replay.ts) can find it. The event log cannot say: a
// headless root's `session start` row carries the same human actor as a root
// started from the UI.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { orchStoreRoot, writeFileAtomic } from '../projects.ts';
import { errMsg } from '../../shared/basics.ts';

export const HEADLESS_LAST_RUN_FILE = 'headless-last-run.json';

export function headlessLastRunFile(): string {
  return path.join(orchStoreRoot(), HEADLESS_LAST_RUN_FILE);
}

/** Overwrites the marker: the newest run wins. The headless server holds the root lock, so there is one writer. */
export async function recordHeadlessRun(sessionId: string): Promise<void> {
  await writeFileAtomic(headlessLastRunFile(), `${JSON.stringify({ sessionId })}\n`);
}

/** The recorded public session id, null when no run recorded one; throws, naming the file, when it is unreadable. */
export async function readHeadlessRun(): Promise<{ sessionId: string } | null> {
  const file = headlessLastRunFile();
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`cannot read ${file}: ${errMsg(e)}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(`${file} is not valid JSON: ${errMsg(e)}`); }
  const id = (parsed as { sessionId?: unknown } | null)?.sessionId;
  if (typeof id !== 'string' || id === '') throw new Error(`${file} has no sessionId`);
  return { sessionId: id };
}
