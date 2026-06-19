// Overage auto-resume timer machine, extracted from InstanceManager as a
// composed collaborator. Owns the per-session resume-timer map; the per-Instance
// overage flags (autoResumeAt / autoStoppedForOverage / _overageHandled /
// _overageResetsAt) live on the Instance and are read/written here via the passed
// `inst`. In-memory only — timers are lost on orchestrator restart (the session
// just stays manually resumable). Never kills or respawns a process.

// Prompt delivered by the overage auto-resume timer to a still-alive session
// once the rate-limit window has reset (onOverage: 'stop-resume').
export const AUTO_RESUME_TEXT =
  'The rate-limit window has reset. Please continue where you left off.';

export class OverageResumeController {
  constructor(manager) {
    this.manager = manager;
    // Pending overage auto-resume timers, keyed by sessionId (survives the
    // instanceId churn the way the idle-subscription graph does). Armed on the
    // idle transition after an `onOverage: 'stop-resume'` soft-interrupt; fires a
    // resume prompt at the rate-limit reset time. In-memory only — lost on
    // restart (the session just stays manually resumable).
    this.timers = new Map(); // sessionId → Timeout
  }

  // Arm a per-session overage auto-resume timer. Called from the status
  // handler on the idle transition after a `stop-resume` soft-interrupt. Fires
  // at `resetsAt + BUFFER` seconds with a resume prompt to the still-alive
  // session. Skips (with a notice) when resetsAt is missing or already past —
  // we never arm a negative/NaN timer.
  arm(inst) {
    // Slack past the reported reset time before resuming. Overridable via env
    // (a test seam — lets integration tests fire the resume promptly).
    const envBuf = Number(process.env.ORCH_OVERAGE_RESUME_BUFFER_MS);
    const BUFFER_MS = Number.isFinite(envBuf) ? envBuf : 5000;
    const nowMs = Date.now();
    const atMs = inst._overageResetsAt * 1000; // resetsAt is epoch SECONDS
    if (!Number.isFinite(atMs) || atMs <= nowMs) {
      inst._emitUi({ kind: 'system', subtype: 'auto_resume_skipped',
        data: { reason: 'missing or past resetsAt' } });
      inst.autoStoppedForOverage = false;
      inst._overageHandled = false;
      return;
    }
    const fireAtMs = atMs + BUFFER_MS;
    inst.autoResumeAt = Math.round(fireAtMs / 1000); // epoch secs for the badge
    const sid = inst.sessionId;
    const t = setTimeout(() => this.run(inst, sid), Math.max(0, fireAtMs - nowMs));
    this.timers.set(sid, t);
    this.manager.emit('status', inst.summary()); // push autoResumeAt → client (badge)
  }

  // The body the armed timer fires (extracted so it can also be triggered
  // on-demand via fireNow). Resumes the still-live session, or tears
  // down with a notice if the process vanished. No respawn, ever.
  run(inst, sid) {
    if (inst.proc) {
      // prompt() synchronously emits 'user_prompt' → cancel performs
      // the single teardown (clearTimeout of this already-fired timer is a no-op,
      // deletes the Map entry, clears the flags, emits status to drop the badge);
      // then the resume message sends. cancel is the sole owner of
      // teardown — do NOT pre-clear here or it double-runs.
      inst.prompt(AUTO_RESUME_TEXT).catch(() => {});
    } else {
      // Process gone (crashed / killed externally) — no send means no
      // user_prompt, so tear down explicitly. Keep it simple: no respawn.
      this.cancel(sid);
      inst._emitUi({ kind: 'system', subtype: 'auto_resume_skipped',
        data: { reason: 'session no longer running' } });
    }
  }

  // Test/control seam: fire a pending overage auto-resume immediately rather than
  // waiting out the wall-clock timer (lets tests exercise the full arm→fire path
  // without a real multi-second sleep). Clears the real timer first so it can't
  // double-fire. Returns false if nothing was armed for this session.
  fireNow(sessionId) {
    const t = this.timers.get(sessionId);
    if (!t) return false;
    clearTimeout(t);
    this.timers.delete(sessionId);
    const inst = [...this.manager.byId.values()].find(i => i.sessionId === sessionId);
    if (!inst) return false;
    this.run(inst, sessionId);
    return true;
  }

  // Cancel a pending overage auto-resume timer and clear the instance flags.
  // Idempotent. Called on user takeover, manual respawn/kill/remove, shutdown,
  // and once the timer itself fires.
  cancel(sessionId) {
    const t = this.timers.get(sessionId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(sessionId);
    }
    for (const inst of this.manager.byId.values()) {
      if (inst.sessionId !== sessionId) continue;
      const had = inst.autoResumeAt !== null || inst.autoStoppedForOverage;
      inst.autoResumeAt = null;
      inst.autoStoppedForOverage = false;
      inst._overageHandled = false;
      if (had) this.manager.emit('status', inst.summary()); // clear the badge
    }
  }

  // Clear every pending timer (orchestrator shutdown). Mirrors the old inline
  // teardown in InstanceManager.shutdown().
  clearAll() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
