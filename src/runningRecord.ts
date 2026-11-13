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

import { hostPlatform, type Platform } from './platform/index.ts';
import { pidIsAlive } from './systems/fuse/driver.ts';
import { captureResumeFacts, buildResumeEntries } from './resumeRestart.ts';
import { readRunningRecord, writeRunningRecord, type RunningCli } from './resumeManifest.ts';
import type { InstanceLike, InstanceManagerLike } from './instanceTypes.ts';

export const RUNNING_RECORD_DEBOUNCE_MS = 250;
export const ORPHAN_CLI_TERM_GRACE_MS = 2000;
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
  instances, platform = hostPlatform, log = console, debounceMs = RUNNING_RECORD_DEBOUNCE_MS,
}: { instances: InstanceManagerLike; platform?: Platform; log?: Log; debounceMs?: number }): RunningRecorder {
  let state: 'new' | 'running' | 'paused' | 'stopped' = 'new';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastJson: string | null = null;
  // Start times by CLI process handle, so a later process reusing a pid never
  // inherits an earlier one's start. A null is cached too: the host cannot tell.
  const starts = new WeakMap<object, string | null>();
  const resolving = new WeakSet<object>();
  const group = !!platform.spawnOptions('child').detached;

  const resolveStart = (inst: InstanceLike): string | null => {
    const proc = inst.proc as object;
    if (starts.has(proc)) return starts.get(proc) ?? null;
    if (!resolving.has(proc) && typeof inst.pid === 'number') {
      resolving.add(proc);
      // cc holds the child, so its pid cannot be reused while this resolves.
      platform.processStartTime(inst.pid)
        .catch(() => null)
        .then((t) => { starts.set(proc, t); resolving.delete(proc); schedule(); });
    }
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
      writeRunningRecord(payload);
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
 * Terminate every CLI the running record names that is still the process the
 * record saw. Reads the record without consuming it. SIGTERM first, through the
 * platform's kill helpers; then up to `termGraceMs` for the pids to go, and a
 * SIGKILL for any survivor whose start time still matches. Never throws.
 */
export async function reapOrphanedClis({
  platform = hostPlatform, log = console, termGraceMs = ORPHAN_CLI_TERM_GRACE_MS,
}: { platform?: Platform; log?: Log; termGraceMs?: number } = {}): Promise<ReapResult> {
  const result: ReapResult = { terminated: [], unverifiable: [], reused: [] };
  const record = readRunningRecord({ log });
  if (!record) return result;
  const signal = (c: RunningCli, sig: 'SIGTERM' | 'SIGKILL'): void => {
    if (c.group) platform.killGroup(c.pid, sig);
    else platform.killProcess(c.pid, sig);
  };
  const signalled: RunningCli[] = [];
  for (const c of record.clis) {
    const now = c.start === null ? null : await platform.processStartTime(c.pid).catch(() => null);
    if (now === null) {
      if (pidIsAlive(c.pid)) {
        result.unverifiable.push(c.pid);
        log.warn?.(`orphan-reap: session ${c.sessionId}'s CLI pid ${c.pid} is still running but its identity cannot be verified; leaving it running`);
      }
      continue;
    }
    if (now !== c.start) {
      result.reused.push(c.pid);
      log.log?.(`orphan-reap: pid ${c.pid} (session ${c.sessionId}) now names another process; left alone`);
      continue;
    }
    try {
      signal(c, 'SIGTERM');
      signalled.push(c);
      result.terminated.push(c.pid);
      log.log?.(`orphan-reap: terminated session ${c.sessionId}'s CLI pid ${c.pid}, left running by the previous process`);
    } catch (e) {
      if (!isEsrch(e)) log.warn?.(`orphan-reap: signalling pid ${c.pid} failed`, e instanceof Error ? e.message : String(e));
    }
  }
  const deadline = Date.now() + termGraceMs;
  let survivors = signalled.filter((c) => pidIsAlive(c.pid));
  while (survivors.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, ORPHAN_POLL_MS));
    survivors = survivors.filter((c) => pidIsAlive(c.pid));
  }
  for (const c of survivors) {
    if (await platform.processStartTime(c.pid).catch(() => null) !== c.start) continue;
    try { signal(c, 'SIGKILL'); }
    catch (e) { if (!isEsrch(e)) log.warn?.(`orphan-reap: SIGKILL of pid ${c.pid} failed`, e instanceof Error ? e.message : String(e)); }
  }
  return result;
}
