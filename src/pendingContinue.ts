// The continue notices a gated restore holds back for the resume banner.
//
// A restore whose source is gated (a Restart or Shut down from the power menu,
// or an unclean stop) respawns the same sessions as an automatic one but does
// not prompt them: each busy session's notice is stored here, in
// `<store>/pending-continue.json`, until the user clicks Continue (each notice
// is sent to its session) or Dismiss (none is). The file is independent of the
// resume manifest and the running record, so a notice outlives any number of
// further restarts or crashes until it is clicked away or its session moves on:
// a turn starting on a session drops that session's notice (src/resumeBoot.ts
// wires it), since the session no longer stands where the notice found it.
//
// Every operation is a synchronous read-modify-write with an atomic write, so
// two tabs clicking Continue at once cannot both take the same notices.

import path from 'node:path';
import { writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { orchStoreRoot } from './projects.ts';
import type { RestoreKind } from './resumeManifest.ts';
import type { InstanceManagerLike } from './instanceTypes.ts';

export const PENDING_CONTINUE_FILENAME = 'pending-continue.json';

export interface PendingNotice {
  sessionId: string;
  kind: RestoreKind;
  // The exact text Continue sends to the session.
  text: string;
  // The conductor's subtree when the notice was stored, by sessionId; the
  // boot-time cleanup keeps these records (src/sessionCleanup.ts).
  workers: string[];
  // ISO timestamp of the restore that stored it.
  at: string;
}

export interface PendingContinue {
  // Store a notice, replacing any held for the same session.
  add(notice: PendingNotice): void;
  // Drop the session's notice; true when there was one.
  drop(sessionId: string): boolean;
  // Every notice, removing them all.
  take(): PendingNotice[];
  list(): PendingNotice[];
}

interface Log {
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

export function pendingContinuePath(): string {
  return path.join(orchStoreRoot(), PENDING_CONTINUE_FILENAME);
}

// The stored notices without changing anything; a corrupt file is removed and
// reads as empty.
export function readPendingNotices({ log = console }: { log?: Log } = {}): PendingNotice[] {
  const file = pendingContinuePath();
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const raw = typeof parsed === 'object' && parsed !== null ? (parsed as { notices?: unknown }).notices : undefined;
    if (!Array.isArray(raw)) throw new Error('no notices array');
    const out: PendingNotice[] = [];
    for (const n of raw) {
      if (typeof n !== 'object' || n === null) continue;
      const r = n as Partial<Record<keyof PendingNotice, unknown>>;
      if (typeof r.sessionId !== 'string' || typeof r.text !== 'string') continue;
      out.push({
        sessionId: r.sessionId,
        kind: r.kind === 'unclean' ? 'unclean' : 'restart',
        text: r.text,
        workers: Array.isArray(r.workers) ? r.workers.filter((w): w is string => typeof w === 'string') : [],
        at: typeof r.at === 'string' ? r.at : '',
      });
    }
    return out;
  } catch (e) {
    log.warn?.('pending-continue: failed to parse; removing', e instanceof Error ? e.message : String(e));
    try { rmSync(file, { force: true }); } catch { /* ignore */ }
    return [];
  }
}

function writeNotices(notices: PendingNotice[]): void {
  const file = pendingContinuePath();
  if (notices.length === 0) { rmSync(file, { force: true }); return; }
  try { mkdirSync(orchStoreRoot(), { recursive: true }); } catch { /* ignore */ }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify({ notices }));
  renameSync(tmp, file);
}

// `onChange` fires after every operation that changed the stored set.
export function createPendingContinue({ onChange = () => {}, log = console }: { onChange?: () => void; log?: Log } = {}): PendingContinue {
  const changed = () => { try { onChange(); } catch (e) { log.warn?.('pending-continue: onChange failed', e); } };
  return {
    add(notice) {
      writeNotices([...readPendingNotices({ log }).filter((n) => n.sessionId !== notice.sessionId), notice]);
      changed();
    },
    drop(sessionId) {
      const all = readPendingNotices({ log });
      const kept = all.filter((n) => n.sessionId !== sessionId);
      if (kept.length === all.length) return false;
      writeNotices(kept);
      changed();
      return true;
    },
    take() {
      const all = readPendingNotices({ log });
      if (all.length === 0) return [];
      writeNotices([]);
      changed();
      return all;
    },
    list() {
      return readPendingNotices({ log });
    },
  };
}

// Continue: take every notice, then send each to its session if it is live; a
// notice whose session is not live is dropped (the user stopped it).
export function continuePendingNotices({ pending, instances, log = console }: {
  pending: PendingContinue; instances: InstanceManagerLike; log?: Log;
}): { sent: string[]; dropped: string[] } {
  const sent: string[] = [];
  const dropped: string[] = [];
  for (const n of pending.take()) {
    const inst = instances.liveForSession(n.sessionId);
    if (!inst) { dropped.push(n.sessionId); continue; }
    sent.push(n.sessionId);
    inst.prompt(n.text).catch((e: unknown) =>
      log.warn?.(`pending-continue: sending the notice to ${n.sessionId} failed`, e instanceof Error ? e.message : String(e)));
  }
  return { sent, dropped };
}
