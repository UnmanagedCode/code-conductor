// Boot-time cleanup of session records whose whole lineage is gone.
//
// A record none of whose segments (live or tombstoned) has a transcript on this
// machine lists nowhere, cannot be resumed and cannot be located — so at boot,
// before any instance exists, it is removed from `<store>/sessions.json` through
// removeSessionRecords (src/sessionStore.ts), which first writes the store's
// pre-image to `<store>/sessions.json.startup.bak`, overwritten every boot.
//
// Keeps a record whenever it cannot be sure:
//   - named by the resume manifest (an entry's sessionId or a conductor's
//     workers[]), by public id or by any segment id — restore spawns it next;
//   - any segment id failing isSessionId (no filename it could be checked as);
//   - its newest segment is younger than CLEANUP_GRACE_MS — mintPublicId writes
//     the record before the CLI writes its jsonl, and during a hot restart the
//     exiting server may still be spawning;
//   - the transcript scan throws (transcriptIdsOnDisk): nothing is removed;
//   - the scan found no transcript at all, or the pick would remove EVERY
//     record of the store: nothing is removed. A root that exists but is the
//     wrong one (a changed HOME or CLAUDE_CONFIG_DIR) scans as empty, not as an
//     error; the empty-scan check catches it even when some record is kept for
//     another reason, which would stand the every-record check down.
// Nothing else is cascaded: the session-keyed append-only logs (costs, the
// playbook ledger) hold history where a dead id is inert, as after the explicit
// session delete.

import { readResumeManifest } from './resumeManifest.ts';
import { transcriptIdsOnDisk } from './projects.ts';
import { removeSessionRecords, sessionsFile, errMsg, type SessionsDoc } from './sessionStore.ts';
import { isSessionId } from './identifiers.ts';

export const CLEANUP_GRACE_MS = 10 * 60 * 1000;

interface CleanupLog {
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

export function startupSnapshotFile(): string {
  return sessionsFile() + '.startup.bak';
}

// Every id the resume manifest will hand to restore: entry sessionIds plus each
// conductor entry's workers[].sessionId. Read only — restore owns the unlink.
function protectedIds(log: CleanupLog): Set<string> {
  const ids = new Set<string>();
  const add = (v: unknown) => { if (typeof v === 'string' && v) ids.add(v); };
  for (const entry of readResumeManifest({ log }).instances) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as { sessionId?: unknown; workers?: unknown };
    add(e.sessionId);
    if (Array.isArray(e.workers)) {
      for (const w of e.workers) if (typeof w === 'object' && w !== null) add((w as { sessionId?: unknown }).sessionId);
    }
  }
  return ids;
}

export async function cleanupSessionsWithoutTranscripts(
  { log = console, now = Date.now }: { log?: CleanupLog; now?: () => number } = {},
): Promise<{ removed: string[]; skipped?: string }> {
  try {
    const guarded = protectedIds(log);
    const present = await transcriptIdsOnDisk().catch((e: unknown) => {
      log.warn?.(`session-cleanup: transcript scan failed (${errMsg(e)}); keeping every record`);
      return null;
    });

    const pick = (doc: SessionsDoc): string[] => {
      if (present === null) return [];
      if (present.size === 0 && doc.size > 0) {
        log.warn?.('session-cleanup: no transcripts found anywhere — refusing to remove records (check HOME / CLAUDE_CONFIG_DIR)');
        return [];
      }
      const out: string[] = [];
      const t = now();
      for (const [publicId, rec] of doc) {
        if (guarded.has(publicId) || rec.segments.some(s => guarded.has(s.id))) continue;
        const bad = rec.segments.find(s => !isSessionId(s.id));
        if (bad) {
          log.warn?.(`session-cleanup: ${publicId} has an unresolvable segment id ${JSON.stringify(bad.id)}; keeping it`);
          continue;
        }
        if (rec.segments.some(s => present.has(s.id))) continue;
        const newest = Math.max(...rec.segments.map(s => Date.parse(s.at)).filter(Number.isFinite));
        if (t - newest < CLEANUP_GRACE_MS) continue;
        out.push(publicId);
      }
      if (out.length > 0 && out.length === doc.size) {
        log.warn?.('session-cleanup: every record looks transcript-less — refusing to wipe the store (check HOME / CLAUDE_CONFIG_DIR)');
        return [];
      }
      return out;
    };

    const snapshot = startupSnapshotFile();
    const result = await removeSessionRecords(pick, { snapshotFile: snapshot });
    if (result.removed.length > 0) {
      log.log?.(`session-cleanup: removed ${result.removed.length} session record(s) with no transcript left: `
        + `${result.removed.join(', ')} (pre-image: ${snapshot})`);
    }
    return result;
  } catch (e) {
    log.warn?.(`session-cleanup: failed (${errMsg(e)}); nothing removed`);
    return { removed: [] };
  }
}
