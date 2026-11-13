// The running record (`<store>/running-sessions.json`): what a boot restores
// from when the previous process stopped without a drain.
//
// The recorder keeps the file current while cc runs. It holds the same resume
// entries finishDrain writes into the manifest (captureResumeFacts +
// buildResumeEntries, src/resumeRestart.ts), so an unclean stop restores the
// same sessions a Restart would, plus one `clis` row per locally spawned CLI
// process for the boot-time orphan reap below. It writes on change only:
// every manager `status`, `list_changed` and `subscription_changed` event
// schedules a trailing-debounced flush, and a flush whose payload is
// byte-equal to the last write writes nothing. finishDrain removes the file at
// a clean stop; the restart and shutdown paths pause the recorder first, so
// the closing CLIs cannot write it back.
//
// The reap: a CLI is not tied to cc's lifetime (spawnOptions('child')), so one
// that outlived a crash or a kill of cc alone can still be writing its
// transcript when the next boot resumes the session. reapOrphanedClis runs at
// boot before any instance exists and terminates every recorded CLI still
// running — only after its start time (Platform.processStartTime) proves the
// pid still names the same process.

import type { Platform } from './platform/index.ts';
import { pidIsAlive } from './systems/fuse/driver.ts';
import { captureResumeFacts, buildResumeEntries } from './resumeRestart.ts';
import { readRunningRecord, readResumeManifest, writeRunningRecord, type RunningCli } from './resumeManifest.ts';
import type { InstanceLike, InstanceManagerLike } from './instanceTypes.ts';

export const RUNNING_RECORD_DEBOUNCE_MS = 250;
export const ORPHAN_CLI_TERM_GRACE_MS = 2000;
// A start-time read that answers null is retried, START_TIME_RETRY_MS after the
// first failure and doubling, until START_TIME_ATTEMPTS reads in all; the row
// stays null after that.
export const START_TIME_ATTEMPTS = 4;
export const START_TIME_RETRY_MS = 1000;
const ORPHAN_POLL_MS = 50;

interface Log {
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

export interface RunningRecorder {
  // Subscribe and write at once.
  start(): void;
  // Cancel a scheduled write and write nothing until resume().
  pause(): void;
  // Write the current state at once and keep recording.
  resume(): void;
  // Unsubscribe for good.
  stop(): void;
  // The `clis` rows for the live set now, with the start times already read
  // (no new read): what finishDrain writes into the manifest.
  clis(): RunningCli[];
}

// The record's `clis` rows: every instance with a live CLI process the local
// launcher spawned and a pid. A FUSE-wrapped instance is left out: its worker
// and daemon pids are in the FUSE run record, which sweepFuseLeftovers verifies
// and kills at boot.
export function cliRows(
  instances: Iterable<InstanceLike>,
  { group, startOf }: { group: boolean; startOf: (inst: InstanceLike) => string | null },
): RunningCli[] {
  const rows: RunningCli[] = [];
  for (const inst of instances) {
    if (!inst.proc || inst._fuse || typeof inst.pid !== 'number') continue;
    rows.push({ sessionId: inst.sessionId ?? inst.id, pid: inst.pid, start: startOf(inst), group });
  }
  return rows;
}

export function createRunningRecorder({
  instances, platform, log = console, debounceMs = RUNNING_RECORD_DEBOUNCE_MS, write = writeRunningRecord,
  startRetryMs = START_TIME_RETRY_MS, setTimer = (fn, ms) => setTimeout(fn, ms),
}: {
  instances: InstanceManagerLike; platform: Platform; log?: Log; debounceMs?: number; startRetryMs?: number;
  // Schedules a start-time retry; a test observes the delays through it.
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  // The file write; a test counts calls through it.
  write?: typeof writeRunningRecord;
}): RunningRecorder {
  let state: 'new' | 'running' | 'paused' | 'stopped' = 'new';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastJson: string | null = null;
  // Start times by CLI process handle, so a later process reusing a pid never
  // inherits an earlier one's start. Only a read value is cached; a null read
  // is retried with backoff (START_TIME_ATTEMPTS), and the row stays null
  // meanwhile and after.
  const starts = new WeakMap<object, string>();
  const failures = new WeakMap<object, number>();
  const resolving = new WeakSet<object>();
  const retries = new Set<ReturnType<typeof setTimeout>>();
  const group = !!platform.spawnOptions('child').detached;

  // A read counts only while `proc` is still the instance's live CLI: cc holds
  // the child, so its pid cannot be reused until the exit that clears `proc`.
  const read = (inst: InstanceLike, proc: object, pid: number): void => {
    if (state === 'stopped' || inst.proc !== proc) return;
    resolving.add(proc);
    platform.processStartTime(pid)
      .catch(() => null)
      .then((t) => {
        resolving.delete(proc);
        if (inst.proc !== proc) return;
        if (t !== null) { starts.set(proc, t); schedule(); return; }
        const failed = (failures.get(proc) ?? 0) + 1;
        failures.set(proc, failed);
        if (failed >= START_TIME_ATTEMPTS || state === 'stopped') return;
        const timer = setTimer(() => { retries.delete(timer); read(inst, proc, pid); }, startRetryMs * 2 ** (failed - 1));
        retries.add(timer);
      });
  };

  const resolveStart = (inst: InstanceLike): string | null => {
    const proc = inst.proc as object;
    const known = starts.get(proc);
    if (known !== undefined) return known;
    if (!resolving.has(proc) && !failures.has(proc) && typeof inst.pid === 'number') read(inst, proc, inst.pid);
    return null;
  };

  const flush = (): void => {
    if (state !== 'running') return;
    try {
      const payload = {
        instances: buildResumeEntries(instances, captureResumeFacts(instances)),
        clis: cliRows(instances.byId.values(), { group, startOf: resolveStart }),
      };
      const json = JSON.stringify(payload);
      if (json === lastJson) return;
      write(payload);
      lastJson = json;
    } catch (e) {
      log.warn?.('running-record: write failed', e instanceof Error ? e.message : String(e));
    }
  };

  function schedule(): void {
    if (state !== 'running' || timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, debounceMs);
  }
  const cancel = (): void => { if (timer) { clearTimeout(timer); timer = null; } };
  const onChange = (): void => schedule();

  return {
    start() {
      if (state !== 'new') return;
      state = 'running';
      instances.on('status', onChange);
      instances.on('list_changed', onChange);
      instances.on('subscription_changed', onChange);
      flush();
    },
    pause() {
      if (state !== 'running') return;
      state = 'paused';
      cancel();
    },
    resume() {
      if (state !== 'paused') return;
      state = 'running';
      lastJson = null;
      flush();
    },
    stop() {
      if (state === 'stopped') return;
      if (state !== 'new') {
        instances.off('status', onChange);
        instances.off('list_changed', onChange);
        instances.off('subscription_changed', onChange);
      }
      state = 'stopped';
      cancel();
      for (const t of retries) clearTimeout(t);
      retries.clear();
    },
    clis() {
      return cliRows(instances.byId.values(), { group, startOf: (inst) => starts.get(inst.proc as object) ?? null });
    },
  };
}

export interface ReapResult {
  // Pids signalled (the same process the record named).
  terminated: number[];
  // Pids alive whose identity could not be read: left running.
  unverifiable: number[];
  // Pids alive as a different process: left alone.
  reused: number[];
}

const isEsrch = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === 'ESRCH';

/**
 * Terminate every CLI the running record or the resume manifest names that is
 * still the process the file saw. Reads both without consuming either; a pid
 * in both is reaped once, from a row with a known start when either has one. The manifest's rows cover a CLI
 * that outlived a clean stop (finishDrain removes the record); the record's, a
 * stop with no drain. Every row is read concurrently, and each row is signalled
 * in its own continuation, right after its own read matched, so no check is
 * older than its signal by more than that one read: SIGTERM through the
 * platform's kill helpers, then up to `termGraceMs` for the pids to go, then a
 * concurrent re-read of each survivor and a SIGKILL right after a match. The
 * whole reap takes at most about two reads (START_TIME_TIMEOUT_MS each, where a
 * read runs a helper process) plus `termGraceMs`. Never throws.
 */
export async function reapOrphanedClis({
  platform, log = console, termGraceMs = ORPHAN_CLI_TERM_GRACE_MS,
}: { platform: Platform; log?: Log; termGraceMs?: number }): Promise<ReapResult> {
  const result: ReapResult = { terminated: [], unverifiable: [], reused: [] };
  // Both files describe one boot's live set, so a pid is one CLI: its rows with
  // a known start (deduplicated by start) win over a null-start row for it; two
  // different known starts are both kept, and the start check sorts them out.
  const byPid = new Map<number, Map<string | null, RunningCli>>();
  for (const c of [...(readRunningRecord({ log })?.clis ?? []), ...readResumeManifest({ log }).clis]) {
    const starts = byPid.get(c.pid) ?? new Map<string | null, RunningCli>();
    starts.set(c.start, c);
    byPid.set(c.pid, starts);
  }
  const rows: RunningCli[] = [];
  for (const starts of byPid.values()) {
    const known = [...starts.values()].filter((c) => c.start !== null);
    rows.push(...(known.length ? known : [...starts.values()]));
  }
  if (rows.length === 0) return result;
  const signal = (c: RunningCli, sig: 'SIGTERM' | 'SIGKILL'): void => {
    if (c.group) platform.killGroup(c.pid, sig);
    else platform.killProcess(c.pid, sig);
  };
  const readStart = (pid: number): Promise<string | null> => platform.processStartTime(pid).catch(() => null);
  const signalled: RunningCli[] = [];
  await Promise.all(rows.map(async (c) => {
    const now = c.start === null ? null : await readStart(c.pid);
    if (now === null) {
      if (pidIsAlive(c.pid)) {
        result.unverifiable.push(c.pid);
        log.warn?.(`orphan-reap: session ${c.sessionId}'s CLI pid ${c.pid} is still running but its identity cannot be verified; leaving it running`);
      }
      return;
    }
    if (now !== c.start) {
      result.reused.push(c.pid);
      log.log?.(`orphan-reap: pid ${c.pid} (session ${c.sessionId}) now names another process; left alone`);
      return;
    }
    try {
      signal(c, 'SIGTERM');
      signalled.push(c);
      result.terminated.push(c.pid);
      log.log?.(`orphan-reap: terminated session ${c.sessionId}'s CLI pid ${c.pid}, left running by the previous process`);
    } catch (e) {
      if (!isEsrch(e)) log.warn?.(`orphan-reap: signalling pid ${c.pid} failed`, e instanceof Error ? e.message : String(e));
    }
  }));
  const deadline = Date.now() + termGraceMs;
  let survivors = signalled.filter((c) => pidIsAlive(c.pid));
  while (survivors.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, ORPHAN_POLL_MS));
    survivors = survivors.filter((c) => pidIsAlive(c.pid));
  }
  await Promise.all(survivors.map(async (c) => {
    if (await readStart(c.pid) !== c.start) return;
    try { signal(c, 'SIGKILL'); }
    catch (e) { if (!isEsrch(e)) log.warn?.(`orphan-reap: SIGKILL of pid ${c.pid} failed`, e instanceof Error ? e.message : String(e)); }
  }));
  return result;
}
