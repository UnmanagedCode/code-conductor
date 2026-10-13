// Scratch roots: one mkdtemp'd `<tmpdir>/cc-e2e-<pid>-XXXXXX` per booted cc.
// Each is removed on every exit path of the process that made it — close(),
// normal exit, an uncaught throw, SIGINT/SIGTERM/SIGHUP — and a SIGKILL's
// leftovers are swept by the next run's globalSetup, keyed on the dead pid.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isProcessAlive } from '../../../src/storeLock.ts';

export const SCRATCH_PREFIX = 'cc-e2e-';

// root → what to run synchronously before it is removed (killing its server).
const live = new Map<string, () => void>();
let installed = false;

function cleanupAll(): void {
  for (const [root, beforeRemove] of live) {
    try { beforeRemove(); } catch { /* the removal below is what matters */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
  live.clear();
}

function install(): void {
  if (installed) return;
  installed = true;
  process.on('exit', cleanupAll);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const onSignal = (): void => {
      cleanupAll();
      process.off(sig, onSignal);
      // Re-raise only when nothing else handles it: another listener (the
      // Playwright worker's own) already ran for this delivery.
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    };
    process.on(sig, onSignal);
  }
}

export function createScratchRoot({ beforeRemove = () => {} }: { beforeRemove?: () => void } = {}): string {
  install();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${SCRATCH_PREFIX}${process.pid}-`));
  live.set(root, beforeRemove);
  return root;
}

export function releaseScratchRoot(root: string): void {
  live.delete(root);
  fs.rmSync(root, { recursive: true, force: true });
}

/** Removes the scratch roots of processes that are gone; returns what it removed. */
export function sweepStaleRoots({ tmpDir = os.tmpdir() }: { tmpDir?: string } = {}): string[] {
  const re = new RegExp(`^${SCRATCH_PREFIX}(\\d+)-[^-]+$`);
  const removed: string[] = [];
  for (const name of fs.readdirSync(tmpDir)) {
    const pid = Number(re.exec(name)?.[1]);
    if (!pid || pid === process.pid || isProcessAlive(pid)) continue;
    const p = path.join(tmpDir, name);
    fs.rmSync(p, { recursive: true, force: true });
    removed.push(p);
  }
  return removed;
}
