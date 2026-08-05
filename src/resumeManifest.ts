// Resume-after-restart manifest.
//
// The graceful "Resume after restart" path (src/resumeRestart.ts) drains every
// live instance to idle, then — instead of wiping temp sessions like the normal
// restart — writes this manifest capturing everything boot needs to bring each
// session back via `claude --resume`. On boot, `restoreFromResumeManifest`
// reads it, re-spawns the carried-over sessions, and notifies each one.
//
// Mirrors src/tempCleanup.ts: a single JSON file under the central store,
// written synchronously immediately before `process.exit(0)`, read once on
// boot and then unlinked so a crash mid-restore can't loop. Parse failures are
// non-fatal — the file is removed and treated as empty.

import path from 'node:path';
import { writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { orchStoreRoot } from './projects.ts';

export const PENDING_RESUME_FILENAME = 'pending-resume.json';

export function resumeManifestPath(): string {
  return path.join(orchStoreRoot(), PENDING_RESUME_FILENAME);
}

// The manifest payload is an opaque blob to this module: resumeRestart.ts
// authors and re-reads the instance records, so the shape lives there.
interface ManifestLogger {
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

// Synchronously write the manifest. Must be sync — the drain path calls this
// immediately before `process.exit(0)`. No-op for an empty/invalid list.
export function writeResumeManifest(entries: unknown[]): void {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const file = resumeManifestPath();
  try { mkdirSync(orchStoreRoot(), { recursive: true }); } catch { /* ignore */ }
  const payload = {
    writtenAt: new Date().toISOString(),
    instances: entries,
  };
  // Atomic tmp-write + rename so an OOM/crash mid-write can't leave a torn
  // manifest (writeFileSync truncates in place). Sync — see header.
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, file);
}

// Read the manifest. Returns { instances: [] } when absent or corrupt (and
// removes a corrupt file). Does NOT unlink a good file — call clearResumeManifest
// for that, so the read + delete are explicit and ordered by the caller.
export function readResumeManifest({ log = console }: { log?: ManifestLogger } = {}): { instances: unknown[] } {
  const file = resumeManifestPath();
  if (!existsSync(file)) return { instances: [] };
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const rawInstances = typeof parsed === 'object' && parsed !== null
      ? (parsed as { instances?: unknown }).instances
      : undefined;
    const instances = Array.isArray(rawInstances) ? rawInstances : [];
    return { instances };
  } catch (e) {
    log.warn?.('resume-manifest: failed to parse; removing', errMsg(e));
    try { rmSync(file, { force: true }); } catch { /* ignore */ }
    return { instances: [] };
  }
}

export function clearResumeManifest(): void {
  try { rmSync(resumeManifestPath(), { force: true }); } catch { /* ignore */ }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
