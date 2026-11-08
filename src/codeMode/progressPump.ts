// The cadence of a streamed run_code call's progress notifications: one at
// start, a heartbeat every `heartbeatMs` of silence, and one per burst of log
// output, at most one per `minIntervalMs` with a trailing emit so the latest
// line is never lost. The clock and timers are injected for tests.

import { PROGRESS_LINE_CAP } from './limits.ts';

export interface ProgressPumpOptions {
  emit: (progress: number, message: string) => void;
  heartbeatMs: number;
  minIntervalMs: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ProgressPump {
  onOutput(text: string): void;
  stop(): void;
}

function elapsedLabel(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

export function startProgressPump(o: ProgressPumpOptions): ProgressPump {
  const now = o.now ?? Date.now;
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  const t0 = now();
  let stopped = false;
  let lastProgress = -1;
  let lastEmitAt = t0;
  let lastLine = '';
  let heartbeat: unknown = null;
  let trailing: unknown = null;

  function emit(message?: string): void {
    if (stopped) return;
    const elapsed = now() - t0;
    const progress = elapsed > lastProgress ? elapsed : lastProgress + 1;
    lastProgress = progress;
    lastEmitAt = now();
    const label = elapsedLabel(elapsed);
    o.emit(progress, message ?? (lastLine ? `${label} · ${lastLine.slice(0, PROGRESS_LINE_CAP)}` : label));
    armHeartbeat();
  }

  function armHeartbeat(): void {
    if (heartbeat !== null) clearTimer(heartbeat);
    heartbeat = setTimer(() => { heartbeat = null; emit(); }, o.heartbeatMs);
  }

  emit('started');

  return {
    onOutput(text) {
      if (stopped) return;
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length === 0) return;
      lastLine = lines[lines.length - 1];
      if (trailing !== null) return;
      const wait = o.minIntervalMs - (now() - lastEmitAt);
      if (wait <= 0) { emit(); return; }
      trailing = setTimer(() => { trailing = null; emit(); }, wait);
    },
    stop() {
      stopped = true;
      if (heartbeat !== null) clearTimer(heartbeat);
      if (trailing !== null) clearTimer(trailing);
      heartbeat = null;
      trailing = null;
    },
  };
}
