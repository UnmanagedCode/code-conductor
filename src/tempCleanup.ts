// Boot-time fallback for temp-session cleanup.
//
// `shutdownTempSync()` in src/instances.ts synchronously archives every live
// temp session (jsonl kept, subagents dir deleted) on the restart path. But
// the claude CLI forks subagent processes (for Task tool calls) that aren't
// tracked by the orchestrator and aren't killed alongside the parent — those
// orphans can keep writing to `<sid>/<subagent-sid>.jsonl` after our parent
// process has already exited, undoing the in-process cleanup.
//
// To cover that, `scheduleRestart` writes a manifest to
// `<orchStoreRoot>/pending-temp-cleanup.json` listing every temp session
// that needs cleanup. On boot, `sweepPendingTempCleanup` reads the manifest,
// archives each entry (jsonl kept, subagents dir deleted), then unlinks the
// manifest. Idempotent and crash-safe.
//
// Entries may omit `place` — crash-orphaned temps (recorded in
// temp-sessions.json with no live instance when the restart ran) have no
// placement on record, and migration 0036 clears the placement of any entry
// written before the manifest carried one. Those entries skip the dir cleanup
// and only get the unmarkTemp/markArchived bookkeeping (a backup for the
// fire-and-forget writes runTempCleanup already attempted in src/restart.ts).
//
// THE PLACEMENT, NOT A BARE CWD: `subAgentDirPath` needs the machine coordinate
// as well, because `/root/app3` names a different directory on each remote.

import path from 'node:path';
import { writeFileSync, readFileSync, rmSync, existsSync, renameSync } from 'node:fs';
import { orchStoreRoot, subAgentDirPath, type TranscriptPlacement } from './projects.ts';
import { unmarkTemp } from './tempSessions.ts';
import { markArchived } from './archivedSessions.ts';

export const PENDING_TEMP_CLEANUP_FILENAME = 'pending-temp-cleanup.json';

export function pendingTempCleanupPath(): string {
  return path.join(orchStoreRoot(), PENDING_TEMP_CLEANUP_FILENAME);
}

interface PendingTempCleanupEntry {
  place?: TranscriptPlacement | null;
  sessionId: string;
}

interface ManifestLogger {
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

// Synchronously write the manifest. Must be sync — the restart path calls
// this immediately before `process.exit(0)`. Sweeping always archives: keeps
// the .jsonl, marks the session archived.
export function writePendingTempCleanup(entries: PendingTempCleanupEntry[]): void {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const file = pendingTempCleanupPath();
  const payload = {
    writtenAt: new Date().toISOString(),
    entries: entries.map(({ place, sessionId }) => ({ place, sessionId })),
  };
  // Atomic tmp-write + rename so an OOM/crash mid-write can't leave a torn
  // manifest (writeFileSync truncates in place). Sync — see header.
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, file);
}

export function sweepPendingTempCleanup({ log = console }: { log?: ManifestLogger } = {}): { swept: number } {
  const file = pendingTempCleanupPath();
  if (!existsSync(file)) return { swept: 0 };

  let entries: PendingTempCleanupEntry[] = [];
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
    log.warn?.('temp-cleanup: failed to parse manifest; removing', errMsg(e));
    try { rmSync(file, { force: true }); } catch { /* ignore */ }
    return { swept: 0 };
  }

  let swept = 0;
  for (const { place, sessionId } of entries) {
    if (!sessionId) continue;
    // Always archive — never delete the .jsonl. Only the ephemeral subagent
    // dir is cleaned up, so a temp session that exited during a restart is
    // recoverable from Settings → Archived. Sidecar updates are
    // fire-and-forget from the sync boot context. place-less entries (crash-
    // orphaned temps with no known placement, and every entry migration 0036
    // cleared) have no dir to locate — bookkeeping only.
    if (place) {
      try { rmSync(subAgentDirPath(place, sessionId), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    unmarkTemp(sessionId).catch(() => {});
    markArchived(sessionId).catch(() => {});
    swept++;
  }

  try { rmSync(file, { force: true }); } catch { /* ignore */ }
  if (swept > 0) log.log?.(`temp-cleanup: swept ${swept} temp session(s) from previous run (archived)`);
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

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
