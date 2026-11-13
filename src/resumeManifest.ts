// The two files a boot restores sessions from, both under the central store.
//
//   - `pending-resume.json`, the resume manifest: written by finishDrain
//     (src/resumeRestart.ts) at the end of every drain — Restart, Shut down,
//     self-update, a supervised relaunch. Its presence means the previous
//     process stopped cleanly. `deliver` says how its continue notices reach
//     the sessions: `auto` prompts each at once, `gated` holds them behind the
//     resume banner (src/pendingContinue.ts).
//   - `running-sessions.json`, the running record: rewritten by the running
//     recorder (src/runningRecord.ts) whenever the live set changes, and
//     removed by finishDrain once it has written the manifest and stopped the
//     CLIs. Its presence
//     WITHOUT a manifest means the previous process stopped without a drain —
//     a crash, a kill or a reboot.
//
// takeRestoreSource reads both once at boot and unlinks both, so a crash
// mid-restore cannot loop. Every write is a tmp-write + rename, so a crash
// mid-write never leaves a torn file; parse failures are non-fatal — the file
// is removed and treated as absent.

import path from 'node:path';
import { writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { orchStoreRoot } from './projects.ts';

export const PENDING_RESUME_FILENAME = 'pending-resume.json';
export const RUNNING_RECORD_FILENAME = 'running-sessions.json';

// How a restored session's continue notice is delivered.
export type Deliver = 'auto' | 'gated';
// Why the sessions are being restored: a drained stop, or a stop with no drain.
export type RestoreKind = 'restart' | 'unclean';

// One CLI process the running record (and a manifest) names, for the boot-time orphan reap
// (reapOrphanedClis, src/runningRecord.ts). `start` is the platform's start-time
// token (Platform.processStartTime), null until it resolved; `group` is whether
// the CLI leads its own process group.
export interface RunningCli { sessionId: string; pid: number; start: string | null; group: boolean }

export interface RestoreSource { kind: RestoreKind; deliver: Deliver; entries: unknown[] }

export function resumeManifestPath(): string {
  return path.join(orchStoreRoot(), PENDING_RESUME_FILENAME);
}

export function runningRecordPath(): string {
  return path.join(orchStoreRoot(), RUNNING_RECORD_FILENAME);
}

// The entry payloads are opaque to this module: resumeRestart.ts authors and
// re-reads them, so their shape lives there.
interface ManifestLogger {
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

// Atomic and synchronous: the drain writes immediately before process.exit.
function writeAtomic(file: string, payload: unknown): void {
  try { mkdirSync(orchStoreRoot(), { recursive: true }); } catch { /* ignore */ }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, file);
}

// The parsed object, or null when the file is absent or corrupt (a corrupt file
// is removed).
function readObject(file: string, label: string, log: ManifestLogger): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not a JSON object');
    return parsed as Record<string, unknown>;
  } catch (e) {
    log.warn?.(`${label}: failed to parse; removing`, errMsg(e));
    try { rmSync(file, { force: true }); } catch { /* ignore */ }
    return null;
  }
}

// The well-formed `clis` rows of a parsed file; malformed rows are dropped.
function parseClis(raw: unknown): RunningCli[] {
  const clis: RunningCli[] = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    if (typeof c !== 'object' || c === null) continue;
    const r = c as { sessionId?: unknown; pid?: unknown; start?: unknown; group?: unknown };
    if (typeof r.sessionId !== 'string' || !Number.isInteger(r.pid) || (r.pid as number) <= 0) continue;
    clis.push({ sessionId: r.sessionId, pid: r.pid as number, start: typeof r.start === 'string' ? r.start : null, group: r.group === true });
  }
  return clis;
}

// Synchronously write the manifest. `clis` are the CLIs live at the stop (the
// running record's rows), so the boot's orphan reap sees one that outlived it.
// No-op when there is neither an entry nor a CLI.
export function writeResumeManifest(entries: unknown[], { deliver = 'auto', clis = [] }: { deliver?: Deliver; clis?: RunningCli[] } = {}): void {
  if (!Array.isArray(entries) || (entries.length === 0 && clis.length === 0)) return;
  writeAtomic(resumeManifestPath(), { writtenAt: new Date().toISOString(), deliver, instances: entries, clis });
}

// Read the manifest without unlinking it. `present` is false when the file is
// absent or corrupt. An absent `deliver` reads `auto`.
export function readResumeManifest({ log = console }: { log?: ManifestLogger } = {}): { present: boolean; deliver: Deliver; instances: unknown[]; clis: RunningCli[] } {
  const parsed = readObject(resumeManifestPath(), 'resume-manifest', log);
  if (!parsed) return { present: false, deliver: 'auto', instances: [], clis: [] };
  return {
    present: true,
    deliver: parsed.deliver === 'gated' ? 'gated' : 'auto',
    instances: Array.isArray(parsed.instances) ? parsed.instances : [],
    clis: parseClis(parsed.clis),
  };
}

export function clearResumeManifest(): void {
  try { rmSync(resumeManifestPath(), { force: true }); } catch { /* ignore */ }
}

// Synchronously write the running record, an empty one included: its presence
// is the "cc is running" fact.
export function writeRunningRecord({ instances, clis }: { instances: unknown[]; clis: RunningCli[] }): void {
  writeAtomic(runningRecordPath(), { writtenAt: new Date().toISOString(), instances, clis });
}

// Read the running record without unlinking it; null when absent or corrupt.
// Malformed `clis` rows are dropped.
export function readRunningRecord({ log = console }: { log?: ManifestLogger } = {}): { instances: unknown[]; clis: RunningCli[] } | null {
  const parsed = readObject(runningRecordPath(), 'running-record', log);
  if (!parsed) return null;
  return { instances: Array.isArray(parsed.instances) ? parsed.instances : [], clis: parseClis(parsed.clis) };
}

export function clearRunningRecord(): void {
  try { rmSync(runningRecordPath(), { force: true }); } catch { /* ignore */ }
}

// Read both files and unlink both (at-most-once). A manifest wins over a record
// — finishDrain writes the manifest, stops the CLIs, and only then removes the
// record, so both present is a clean stop that died in between. A record alone
// is an unclean stop, always gated.
export function takeRestoreSource({ log = console }: { log?: ManifestLogger } = {}): RestoreSource | null {
  const manifest = readResumeManifest({ log });
  const record = manifest.present ? null : readRunningRecord({ log });
  clearResumeManifest();
  clearRunningRecord();
  if (manifest.present) return { kind: 'restart', deliver: manifest.deliver, entries: manifest.instances };
  if (record) return { kind: 'unclean', deliver: 'gated', entries: record.instances };
  return null;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
