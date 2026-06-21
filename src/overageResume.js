// Overage auto-resume timer machine, extracted from InstanceManager as a
// composed collaborator. Owns the per-session resume-DEADLINE map; the
// per-Instance overage flags (autoResumeAt / autoStoppedForOverage /
// _overageHandled / _overageResetsAt) live on the Instance and are read/written
// here via the passed `inst`. In-memory only — deadlines are lost on
// orchestrator restart (the session just stays manually resumable). Never kills
// or respawns a process.
//
// Firing is driven by a single shared WALL-CLOCK sweep interval, NOT one
// setTimeout per session. A multi-hour setTimeout cannot survive Android
// Doze / Termux backgrounding: Node timers run off the libuv MONOTONIC clock,
// which does not advance while the process is suspended, so the deadline (in
// monotonic terms) is pushed out by however long the device slept and the
// resume fires very late or never. The sweep instead re-reads Date.now()
// (wall-clock) each tick and fires every deadline that is now due, so a
// deadline that elapsed during suspension fires on the FIRST tick after wake.

// Prompt delivered by the overage auto-resume timer to a still-alive session
// once the rate-limit window has reset (onOverage: 'stop-resume').
export const AUTO_RESUME_TEXT =
  'The rate-limit window has reset. Please continue where you left off.';

export class OverageResumeController {
  constructor(manager) {
    this.manager = manager;
    // Pending overage auto-resume DEADLINES, keyed by sessionId (survives the
    // instanceId churn the way the idle-subscription graph does), valued by the
    // wall-clock epoch-MS instant the resume should fire. Armed on the idle
    // transition after an `onOverage: 'stop-resume'` soft-interrupt; the sweep
    // fires a resume prompt once now >= the deadline. In-memory only — lost on
    // restart (the session just stays manually resumable).
    this.timers = new Map(); // sessionId → fireAtMs (epoch ms)
    // The single shared sweep interval. Started when the first deadline is
    // armed, stopped when the map empties. unref()'d so it never holds the
    // process open on its own.
    this._sweep = null;
  }

  // Arm a per-session overage auto-resume DEADLINE. Called from the status
  // handler on the idle transition after a `stop-resume` soft-interrupt. Fires
  // at `resetsAt + BUFFER` seconds with a resume prompt to the still-alive
  // session. Skips (with a notice) when resetsAt is missing or already past —
  // we never arm a negative/NaN deadline.
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
    this.timers.set(sid, fireAtMs); // record the wall-clock deadline
    this._ensureSweep();            // wall-clock sweep fires it when now >= deadline
    this.manager.emit('status', inst.summary()); // push autoResumeAt → client (badge)
  }

  // Re-arm a deadline restored from the resume manifest on boot. Unlike arm(),
  // does NOT recompute from resetsAt and does NOT skip a past deadline — a
  // deadline that elapsed while the orchestrator was down is re-inserted as-is
  // and the wall-clock sweep fires it on the first tick (the suspension-survival
  // property, applied across a full restart). Caller guarantees the session is
  // live + idle (re-armed AFTER spawn()'s flag-clear, so the clear can't wipe
  // it). No-op on a non-finite deadline.
  armRestored(inst, fireAtMs) {
    if (!Number.isFinite(fireAtMs)) return;
    inst.autoStoppedForOverage = true;
    inst.autoResumeAt = Math.round(fireAtMs / 1000); // epoch secs for the badge
    this.timers.set(inst.sessionId, fireAtMs);
    this._ensureSweep();
    this.manager.emit('status', inst.summary()); // push autoResumeAt → client (badge)
  }

  // Ensure the single shared wall-clock sweep is running. Idempotent. Cadence
  // overridable via ORCH_OVERAGE_RESUME_SWEEP_MS (ms) — a test seam so the sweep
  // can be driven fast. Mirrors the unref()'d-interval idiom in
  // src/usageOverageMonitor.js: it never holds the event loop open by itself.
  _ensureSweep() {
    if (this._sweep) return;
    const env = Number(process.env.ORCH_OVERAGE_RESUME_SWEEP_MS);
    const ms = Number.isFinite(env) && env > 0 ? env : 30_000;
    this._sweep = setInterval(() => this._tick(), ms);
    if (this._sweep.unref) this._sweep.unref();
  }

  // Stop the sweep once no deadlines remain — nothing to watch for. Called from
  // the tick, cancel, and clearAll. Idempotent.
  _maybeStopSweep() {
    if (this._sweep && this.timers.size === 0) {
      clearInterval(this._sweep);
      this._sweep = null;
    }
  }

  // One sweep cycle: fire every deadline that is now due by the WALL clock.
  // Snapshot the entries first so run()/cancel() mutating the map mid-loop is
  // safe. A deadline whose instant passed while the process was suspended is
  // due here and fires immediately — the suspension-survival property.
  _tick() {
    const now = Date.now();
    for (const [sid, fireAtMs] of [...this.timers]) {
      if (now < fireAtMs) continue;
      const inst = [...this.manager.byId.values()].find(i => i.sessionId === sid);
      if (!inst) { this.timers.delete(sid); continue; } // orphaned deadline → drop
      this.run(inst, sid); // run() owns teardown (cancel) of the fired deadline
    }
    this._maybeStopSweep();
  }

  // The body the sweep fires (extracted so it can also be triggered on-demand
  // via fireNow). Resumes the still-live session, or tears down with a notice
  // if the process vanished. No respawn, ever.
  run(inst, sid) {
    if (inst.proc) {
      // prompt() synchronously emits 'user_prompt' → cancel performs
      // the single teardown (deletes the Map entry, clears the flags, emits
      // status to drop the badge, stops the sweep if it was the last one);
      // then the resume message sends. cancel is the sole owner of
      // teardown — do NOT pre-delete here or it double-runs.
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
  // waiting out the wall-clock sweep (lets tests exercise the full arm→fire path
  // without a real multi-second sleep). Removes the deadline first so the sweep
  // can't double-fire. Returns false if nothing was armed for this session.
  fireNow(sessionId) {
    if (!this.timers.has(sessionId)) return false;
    this.timers.delete(sessionId);
    this._maybeStopSweep();
    const inst = [...this.manager.byId.values()].find(i => i.sessionId === sessionId);
    if (!inst) return false;
    this.run(inst, sessionId);
    return true;
  }

  // Cancel a pending overage auto-resume deadline and clear the instance flags.
  // Idempotent. Called on user takeover, manual respawn/kill/remove, temp-session
  // exit, shutdown, and once the deadline itself fires.
  cancel(sessionId) {
    if (this.timers.has(sessionId)) {
      this.timers.delete(sessionId);
      this._maybeStopSweep();
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

  // Clear every pending deadline and stop the sweep (orchestrator shutdown).
  // Mirrors the old inline teardown in InstanceManager.shutdown().
  clearAll() {
    this.timers.clear();
    if (this._sweep) { clearInterval(this._sweep); this._sweep = null; }
  }
}
