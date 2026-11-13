// The boot half of carrying sessions across a stop, in the order server.ts
// runs it (startHolding):
//
//   1. prepareResumeBoot — before any instance exists, in every mode: terminate
//      the CLIs the previous process left running (reapOrphanedClis), so no
//      resumed session ever shares its transcript with its old self.
//   2. (cleanupSessionsWithoutTranscripts and createServer run here.)
//   3. startResumeLifecycle — once the port is bound, interactive mode only:
//      take the restore source (consuming the manifest and the running record),
//      start the running recorder, drop a pending notice whenever its session
//      starts a turn, and restore the sessions (fire-and-forget). A headless run
//      skips it, so it never consumes or kills the interactive server's
//      sessions: both files wait for the next interactive boot.

import type { Platform } from './platform/index.ts';
import { reapOrphanedClis } from './runningRecord.ts';
import type { RunningRecorder } from './runningRecord.ts';
import type { PendingContinue } from './pendingContinue.ts';
import { takeRestoreSource } from './resumeManifest.ts';
import { restoreFromResumeManifest } from './resumeRestart.ts';
import type { InstanceManagerLike, TurnStarted } from './instanceTypes.ts';

interface Log {
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

export async function prepareResumeBoot({ platform, log = console, termGraceMs }: { platform: Platform; log?: Log; termGraceMs?: number }): Promise<void> {
  try { await reapOrphanedClis({ platform, log, termGraceMs }); }
  catch (e) { log.warn?.('orphan-reap failed:', e instanceof Error ? e.message : String(e)); }
}

export interface ResumeLifecycle {
  // The restore's outcome; it never rejects.
  restored: Promise<{ restored: number }>;
  // Stop recording and stop dropping notices. The record stays on disk.
  dispose(): void;
}

export function startResumeLifecycle({ instances, recorder, pending, log = console, staggerMs }: {
  instances: InstanceManagerLike; recorder: RunningRecorder; pending: PendingContinue; log?: Log; staggerMs?: number;
}): ResumeLifecycle {
  // Read before the recorder's first write replaces the record.
  const source = takeRestoreSource({ log });
  recorder.start();
  const onTurn = (t: TurnStarted): void => { pending.drop(t.sessionId); };
  instances.on('turn_started', onTurn);
  const restored = restoreFromResumeManifest({ instances, log, source, pending, staggerMs })
    .catch((e: unknown) => {
      log.warn?.('resume-restart restore failed:', e instanceof Error ? e.message : String(e));
      return { restored: 0 };
    });
  return {
    restored,
    dispose() {
      instances.off('turn_started', onTurn);
      recorder.stop();
    },
  };
}
