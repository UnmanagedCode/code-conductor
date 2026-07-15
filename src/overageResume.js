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

import { getAccountUsage } from './accountUsage.js';
import { usageOverThreshold } from './appSettings.js';

// Prompt delivered by the overage auto-resume timer to a still-alive session
// once the rate-limit window has reset (onOverage: 'stop-resume').
export const AUTO_RESUME_TEXT =
  'The rate-limit window has reset. Please continue where you left off.';

// Softened preamble for a queued-only session (idle/new — never stopped
// mid-work), so it doesn't get told to "continue where you left off".
const QUEUED_ONLY_RESUME_TEXT =
  'The rate-limit window has reset. Delivering the messages you queued while paused:';

// Build the single prompt the resume delivers. With no queued messages it is
// just AUTO_RESUME_TEXT (the unchanged single-resume behavior). With queued
// messages it prepends the reset preamble, then lists each queued message as a
// short numbered, clock-stamped item so the model sees what the user typed
// while the session was paused. `wasStopped` picks the preamble: a session
// stopped mid-work resumes with "continue where you left off"; a queued-only
// session gets the softened line.
function buildCombinedResumeText(queue, wasStopped = true) {
  if (!queue.length) return AUTO_RESUME_TEXT;
  const preamble = wasStopped ? AUTO_RESUME_TEXT : QUEUED_ONLY_RESUME_TEXT;
  const fmt = (ts) => {
    try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
    catch { return ''; }
  };
  const lines = queue.map((e, i) => {
    const stamp = e.ts ? ` [${fmt(e.ts)}]` : '';
    const body = (e.text && e.text.trim()) ? e.text.trim()
      : (e.attachments?.length ? '(attachment)' : '(empty)');
    return `${i + 1}.${stamp} ${body}`;
  });
  return `${preamble}\n\nWhile paused you queued ${queue.length} message${queue.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}

// After this many CONSECUTIVE "can't confirm" usage fetches (null / backoff /
// malformed payload), a due session fails OPEN and resumes anyway rather than
// parking forever behind a persistently-unavailable usage API. At the 60s recheck
// cadence that's ~5 minutes — aligned with accountUsage.js's MAX_RETRY_MS ceiling.
const FAIL_OPEN_AFTER = 5;

export class OverageResumeController {
  // `fetchUsage` is injectable purely as a test seam (defaults to the real cached
  // fetcher, which self-guards its own cache + backoff — we never force-fresh it).
  constructor(manager, { fetchUsage = getAccountUsage } = {}) {
    this.manager = manager;
    this.fetchUsage = fetchUsage;
    // Pending overage auto-resume DEADLINES, keyed by the stable instanceId,
    // valued by the wall-clock epoch-MS instant the resume should fire. Armed on
    // the idle transition after an `onOverage: 'stop-resume'` soft-interrupt; the
    // sweep POLLS usage once due and only resumes when the account is verified
    // under the overage bar (else it reschedules). In-memory only — lost on
    // restart (restore re-arms off the freshly-created Instance's id, see
    // resumeRestart.js; the session otherwise stays manually resumable).
    this.timers = new Map(); // instanceId → fireAtMs (epoch ms)
    // Instances with an in-flight usage-verify (a deadline that came due and is
    // awaiting the fetch result). Guards the sweep from re-firing them on the next
    // tick while the await is pending.
    this._checking = new Set();
    // instanceId → consecutive "can't confirm" fetch count (reset on any resolved
    // verify). Drives the fail-open bound.
    this._failCount = new Map();
    // Re-entrancy guard so overlapping sweep ticks can't open a second usage fetch:
    // a whole tick body (fetch + resolve all due sessions) runs at most once at a time.
    this._ticking = false;
    // The single shared sweep interval. Started when the first deadline is
    // armed, stopped when the map empties. unref()'d so it never holds the
    // process open on its own.
    this._sweep = null;
  }

  // Recheck cadence for a parked (still-over / can't-confirm) session. Overridable
  // via ORCH_OVERAGE_RECHECK_MS (a test seam, like the sweep/buffer envs). Default
  // 60s is independent of accountUsage.js's 180s success cache — most recheck ticks
  // just re-read the cached value (cheap no-op), so a shorter cadence here doesn't
  // add real network pressure; it just keeps FAIL_OPEN_AFTER's ~5-minute bound
  // aligned with accountUsage.js's MAX_RETRY_MS ceiling (see FAIL_OPEN_AFTER above).
  _recheckMs() {
    const env = Number(process.env.ORCH_OVERAGE_RECHECK_MS);
    return Number.isFinite(env) && env > 0 ? env : 60_000;
  }

  // Arm a per-session overage auto-resume DEADLINE. Called from the status
  // handler on the idle transition after a `stop-resume` soft-interrupt. Fires a
  // usage-VERIFIED resume once due (the sweep polls usage and only resumes when the
  // account is confirmed under the overage bar). A missing/past resetsAt is NOT a
  // dead-end anymore: it schedules the first usage-check at `now + recheck` instead
  // of giving up — the verify decides whether to resume. `auto_resume_skipped` now
  // fires ONLY for the genuine "process gone" case (in run()).
  arm(inst) {
    // Slack past the reported reset time before the FIRST check. Overridable via env
    // (a test seam — lets integration tests fire the resume promptly).
    const envBuf = Number(process.env.ORCH_OVERAGE_RESUME_BUFFER_MS);
    const BUFFER_MS = Number.isFinite(envBuf) ? envBuf : 5000;
    const nowMs = Date.now();
    const atMs = inst._overageResetsAt * 1000; // resetsAt is epoch SECONDS
    // Missing/past resetsAt → check in `recheck` ms rather than arming a negative
    // deadline; a valid future resetsAt → first check at resetsAt + buffer.
    const fireAtMs = (!Number.isFinite(atMs) || atMs <= nowMs)
      ? nowMs + this._recheckMs()
      : atMs + BUFFER_MS;
    inst.autoResumeAt = Math.round(fireAtMs / 1000); // epoch secs for the badge
    this.timers.set(inst.id, fireAtMs); // record the wall-clock deadline
    this._ensureSweep();                // wall-clock sweep checks it when now >= deadline
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
    this.timers.set(inst.id, fireAtMs);
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
    this._sweep = setInterval(() => { this._tick().catch(() => {}); }, ms);
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

  // One sweep cycle. Collects every deadline now due by the WALL clock, then does a
  // SINGLE usage fetch shared across all of them (coalesced: many parked sessions
  // must not each hit the API — accountUsage.js has no in-flight dedup, only a 60s
  // cache) and resolves each. A deadline whose instant passed while the process was
  // suspended is due here on the first tick after wake — the suspension-survival
  // property. `_ticking` prevents an overlapping tick from opening a second fetch;
  // `_checking` prevents re-collecting a session already mid-verify.
  async _tick() {
    if (this._ticking) return;
    const now = Date.now();
    const due = [];
    for (const [id, fireAtMs] of [...this.timers]) {
      if (now < fireAtMs) continue;
      if (this._checking.has(id)) continue;
      const inst = this.manager.byId.get(id);
      if (!inst) { this.timers.delete(id); continue; } // orphaned deadline → drop
      due.push([id, inst]);
    }
    if (due.length) {
      this._ticking = true;
      for (const [id] of due) this._checking.add(id);
      let usage = null;
      // ONE fetch per cycle. getAccountUsage self-guards its cache/backoff and never
      // throws, but the injected test seam might — treat any error as "can't confirm".
      try { usage = await this.fetchUsage(); } catch { usage = null; }
      for (const [id, inst] of due) {
        try { this._resolveDue(inst, id, usage); }
        catch { /* never let one session's teardown abort the sweep */ }
        finally { this._checking.delete(id); }
      }
      this._ticking = false;
    }
    this._maybeStopSweep();
  }

  // Decide what a due deadline does given the shared usage snapshot: resume (verified
  // under the bar, or failed-open), or reschedule (still over / can't-confirm). The
  // process-gone case routes to run() which emits the sole surviving auto_resume_skipped.
  _resolveDue(inst, id, usage) {
    if (inst.proc) {
      // Still alive → usage-gate the resume.
      const over = usage == null ? null : usageOverThreshold(usage);
      if (over === true) { this._reschedule(inst, id); return; } // still throttled — park on
      if (over === null) {                                        // can't confirm (null/backoff/malformed)
        const n = (this._failCount.get(id) ?? 0) + 1;
        if (n < FAIL_OPEN_AFTER) { this._failCount.set(id, n); this._reschedule(inst, id); return; }
        // n >= FAIL_OPEN_AFTER → fail open: resume rather than park behind a dead API.
      }
    }
    // Alive + verified under the bar (or failed-open), OR process gone: run() flushes
    // + tears down the deadline (gone → emits the sole surviving auto_resume_skipped).
    // Either way a deadline was removed, so ask the manager to lift the global lockout
    // iff no sessions remain parked.
    this._failCount.delete(id);
    this.run(inst, id);
    this.manager._maybeReleaseOverageLock();
  }

  // Park a still-over / can't-confirm session on a fresh recheck deadline instead of
  // resuming. `max(resetsAt, now + recheck)`: keep resetsAt if it's still further out,
  // else recheck ~1 min out. Also pushes the manager's global _overageResetsAt forward
  // so the frontend/queue lockout gate (which requires a FUTURE resetsAt) stays engaged
  // while sessions are parked — the lockout must not lift out from under an active park.
  _reschedule(inst, id) {
    const now = Date.now();
    const atMs = Number(inst._overageResetsAt) * 1000; // epoch secs → ms
    const fireAtMs = Math.max(Number.isFinite(atMs) ? atMs : 0, now + this._recheckMs());
    this.timers.set(id, fireAtMs);
    inst.autoResumeAt = Math.round(fireAtMs / 1000); // badge reflects the next recheck
    this._ensureSweep();
    if (this.manager._overageResumeMode) this.manager._overageResetsAt = inst.autoResumeAt;
    this.manager.emit('status', inst.summary());
  }

  // The body the sweep fires (extracted so it can also be triggered on-demand
  // via fireNow). Resumes the still-live session, or tears down with a notice
  // if the process vanished. No respawn, ever.
  run(inst, id) {
    if (inst.proc) {
      // Deliver any messages the user queued during the wait window as ONE
      // combined prompt alongside the resume text. Snapshot + empty the queue
      // FIRST, then cancel() (the single teardown: deletes the Map entry, clears
      // flags, emits status to drop the badge + queuedCount, stops the sweep if
      // last). The resume send is `internal:true` so it BYPASSES the prompt()
      // queue intercept — critical for the global lockout: the window may still
      // be active with a future resetsAt when this fires (the _fireAutoResumeNow
      // path, or a per-session deadline that beats the global clear), and the
      // GLOBAL gate would otherwise re-queue the resume prompt forever. internal
      // also skips the user_prompt emit — fine, cancel() already did the teardown.
      const queue = inst._overageQueue.slice();
      inst._overageQueue = [];
      const attachments = queue.flatMap(e => Array.isArray(e.attachments) ? e.attachments : []);
      const text = buildCombinedResumeText(queue, inst._overageWasStopped);
      this.cancel(id);
      if (queue.length) {
        inst._emitUi({ kind: 'system', subtype: 'auto_resume', data: { count: queue.length } });
      }
      inst.prompt(text, attachments, { internal: true }).catch(() => {});
    } else {
      // Process gone (crashed / killed externally) — no send means no
      // user_prompt, so tear down explicitly. Keep it simple: no respawn.
      this.cancel(id);
      inst._emitUi({ kind: 'system', subtype: 'auto_resume_skipped',
        data: { reason: 'session no longer running' } });
    }
  }

  // Test/control seam: bring a pending overage auto-resume due immediately rather
  // than waiting out the wall-clock sweep (lets tests exercise the full arm→verify→
  // fire path without a real multi-second sleep). Removes the deadline + marks the
  // session checking so the sweep can't double-fire, then runs the SAME usage-verified
  // resolve as the sweep (fire-and-forget the async fetch; the resume/reschedule lands
  // asynchronously — tests waitFor the outcome). Returns false if nothing was armed
  // (or the session vanished); true if a due deadline was picked up.
  fireNow(instanceId) {
    if (!this.timers.has(instanceId)) return false;
    const inst = this.manager.byId.get(instanceId);
    if (!inst) { this.timers.delete(instanceId); this._maybeStopSweep(); return false; }
    if (this._checking.has(instanceId)) return true; // already resolving
    this._checking.add(instanceId);
    this.timers.delete(instanceId);
    this._maybeStopSweep();
    (async () => {
      let usage = null;
      try { usage = await this.fetchUsage(); } catch { usage = null; }
      try { this._resolveDue(inst, instanceId, usage); }
      catch { /* swallow — mirror the sweep's per-session isolation */ }
      finally { this._checking.delete(instanceId); }
    })();
    return true;
  }

  // Cancel a pending overage auto-resume deadline and clear the instance flags.
  // Idempotent. Called on user takeover, manual respawn/kill/remove, temp-session
  // exit, shutdown, and once the deadline itself fires. The flag-clear is skipped
  // when the instance is already gone from byId (e.g. remove() deletes it before
  // cancelling) — there is nothing left to update, and the deadline delete by
  // instanceId still runs.
  cancel(instanceId) {
    this._failCount.delete(instanceId);
    if (this.timers.has(instanceId)) {
      this.timers.delete(instanceId);
      this._maybeStopSweep();
    }
    const inst = this.manager.byId.get(instanceId);
    if (inst) {
      const had = inst.autoResumeAt !== null || inst.autoStoppedForOverage ||
        inst._overageQueue.length > 0;
      inst.autoResumeAt = null;
      inst.autoStoppedForOverage = false;
      inst._overageWasStopped = false;
      inst._overageHandled = false;
      // Drop any queued messages — the session is being torn down or resumed
      // (run() already snapshot-emptied the queue before this call, so this is
      // the kill/remove/temp-exit/shutdown cleanup path).
      inst._overageQueue = [];
      if (had) this.manager.emit('status', inst.summary()); // clear the badge + queuedCount
    }
  }

  // Clear every pending deadline and stop the sweep (orchestrator shutdown).
  // Mirrors the old inline teardown in InstanceManager.shutdown().
  clearAll() {
    this.timers.clear();
    this._checking.clear();
    this._failCount.clear();
    if (this._sweep) { clearInterval(this._sweep); this._sweep = null; }
  }
}
