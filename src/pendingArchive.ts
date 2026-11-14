// The boot sweep of `<orchStoreRoot>/pending-archive.json`: a list of normal
// sessions to archive (jsonl kept, subagents dir deleted, segment retired), then
// the file is unlinked. Idempotent and crash-safe. cc itself writes no such
// file; a build whose restart archives normal sessions writes one on its
// restart, and this sweep consumes it on the boot that follows.
//
// Entries may omit `place` — migration 0036 clears the placement of any entry
// written before the file carried one. Those entries skip the dir cleanup and
// only get the segment retirement.
//
// THE PLACEMENT, NOT A BARE CWD: `subAgentDirPath` needs the machine coordinate
// as well, because `/root/app3` names a different directory on each remote.

import path from 'node:path';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { orchStoreRoot, subAgentDirPath, type TranscriptPlacement } from './projects.ts';
import { retireSegments } from './sessionLineage.ts';
import { errMsg } from '../shared/basics.ts';

const PENDING_ARCHIVE_FILENAME = 'pending-archive.json';

export function pendingArchivePath(): string {
  return path.join(orchStoreRoot(), PENDING_ARCHIVE_FILENAME);
}

interface PendingArchiveEntry {
  place?: TranscriptPlacement | null;
  sessionId: string;
}

interface ManifestLogger {
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

export function sweepPendingArchive({ log = console }: { log?: ManifestLogger } = {}): { swept: number } {
  const file = pendingArchivePath();
  if (!existsSync(file)) return { swept: 0 };

  let entries: PendingArchiveEntry[] = [];
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const rawList = typeof parsed === 'object' && parsed !== null ? (parsed as { entries?: unknown }).entries : undefined;
    if (Array.isArray(rawList)) {
      for (const e of rawList) {
        if (typeof e !== 'object' || e === null) continue;
        const rec = e as { place?: unknown; sessionId?: unknown };
        if (typeof rec.sessionId !== 'string' || !rec.sessionId) continue;
        entries.push({ place: readPlace(rec.place), sessionId: rec.sessionId });
      }
    }
  } catch (e) {
    log.warn?.('pending-archive: failed to parse manifest; removing', errMsg(e));
    try { rmSync(file, { force: true }); } catch { /* ignore */ }
    return { swept: 0 };
  }

  let swept = 0;
  const retire: string[] = [];
  for (const { place, sessionId } of entries) {
    if (!sessionId) continue;
    // Always archive — never delete the .jsonl. Only the ephemeral subagent
    // dir is cleaned up, so the session is recoverable from Settings → Archived.
    // place-less entries have no dir to locate — bookkeeping only.
    if (place) {
      try { rmSync(subAgentDirPath(place, sessionId), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    retire.push(sessionId);
    swept++;
  }
  // ONE store write for the whole manifest, fire-and-forget from the sync boot
  // context.
  retireSegments(retire).catch(() => {});

  try { rmSync(file, { force: true }); } catch { /* ignore */ }
  if (swept > 0) log.log?.(`pending-archive: swept ${swept} session(s) from previous run (archived)`);
  return { swept };
}

// A persisted placement, or null. Strict: a partial record is no placement at
// all, because guessing the machine half is how a sweep would delete another
// remote's subagent directory.
function readPlace(v: unknown): TranscriptPlacement | null {
  if (typeof v !== 'object' || v === null) return null;
  const p = v as { system?: unknown; remoteId?: unknown; cwd?: unknown };
  if (typeof p.system !== 'string' || !p.system) return null;
  if (typeof p.cwd !== 'string' || !p.cwd) return null;
  if (p.remoteId !== null && typeof p.remoteId !== 'string') return null;
  return { system: p.system, remoteId: p.remoteId ?? null, cwd: p.cwd };
}
