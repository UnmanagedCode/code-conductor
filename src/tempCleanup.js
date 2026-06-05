// Boot-time fallback for temp-session cleanup.
//
// `shutdownTempSync()` in src/instances.js synchronously deletes every live
// temp session's jsonl + subagents dir on the restart path. But the claude
// CLI forks subagent processes (for Task tool calls) that aren't tracked by
// the orchestrator and aren't killed alongside the parent — those orphans
// can keep writing to `<sid>/<subagent-sid>.jsonl` after our parent process
// has already exited, undoing the in-process cleanup.
//
// To cover that, `scheduleRestart` writes a manifest to
// `<orchStoreRoot>/pending-temp-cleanup.json` listing every temp session
// that needs cleanup. On boot, `sweepPendingTempCleanup` reads the manifest,
// deletes each entry's jsonl + subagents dir, then unlinks the manifest.
// Idempotent and crash-safe.

import path from 'node:path';
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { orchStoreRoot, claudeProjectsRoot, encodeCwd } from './projects.js';
import { deleteTitle as deleteSessionTitle } from './sessionTitles.js';
import { unmarkConducted } from './conductedSessions.js';

export const PENDING_TEMP_CLEANUP_FILENAME = 'pending-temp-cleanup.json';

export function pendingTempCleanupPath() {
  return path.join(orchStoreRoot(), PENDING_TEMP_CLEANUP_FILENAME);
}

// Synchronously write the manifest. Must be sync — the restart path calls
// this immediately before `process.exit(0)`.
export function writePendingTempCleanup(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const file = pendingTempCleanupPath();
  const payload = {
    writtenAt: new Date().toISOString(),
    entries: entries.map(({ cwd, sessionId }) => ({ cwd, sessionId })),
  };
  writeFileSync(file, JSON.stringify(payload));
}

export function sweepPendingTempCleanup({ log = console } = {}) {
  const file = pendingTempCleanupPath();
  if (!existsSync(file)) return { swept: 0 };

  let entries = [];
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch (e) {
    log.warn?.('temp-cleanup: failed to parse manifest; removing', e?.message);
    try { rmSync(file, { force: true }); } catch { /* ignore */ }
    return { swept: 0 };
  }

  const root = claudeProjectsRoot();
  let swept = 0;
  for (const { cwd, sessionId } of entries) {
    if (!cwd || !sessionId) continue;
    const dir = path.join(root, encodeCwd(cwd));
    try { rmSync(path.join(dir, `${sessionId}.jsonl`), { force: true }); } catch { /* ignore */ }
    try { rmSync(path.join(dir, sessionId), { recursive: true, force: true }); } catch { /* ignore */ }
    // Sidecar title cleanup is fire-and-forget — sweep is called from
    // sync boot context and the title write doesn't block startup.
    deleteSessionTitle(sessionId).catch(() => {});
    unmarkConducted(sessionId).catch(() => {});
    swept++;
  }

  try { rmSync(file, { force: true }); } catch { /* ignore */ }
  if (swept > 0) log.log?.(`temp-cleanup: swept ${swept} stale temp session(s) from previous run`);
  return { swept };
}
