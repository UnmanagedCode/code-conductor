// Server-side usage poller — a first-class, equal-footing trigger source for the
// overage auto-stop, alongside the stream `rate_limit_event`. The stream event is
// only emitted by Anthropic near its own high threshold (~90%, isUsingOverage), so
// a LOW configured stop threshold (e.g. 25%, to conserve) is invisible to it — only
// a live usage poll (`getAccountUsage()`) knows utilization at 25%. This monitor
// polls on an interval, compares the FIVE-HOUR window's live utilization against the
// configured `overageThresholdPct`, and on a crossing drives the EXACT same stop
// machinery the stream trip uses: `manager._handleOverageTrip(null, { resetsAt })`.
//
// It writes NO parallel stop logic and injects NO prompts directly — everything
// routes through `_handleOverageTrip` → `_routeOverageStop`, so conductor/conducted/
// plain routing, the `internal:true` steer prompts, dedup, and resume are all
// inherited unchanged. Dedup across the two sources is the manager's `_overageActive`
// one-shot: whichever source reaches `_handleOverageTrip` first wins; the other
// no-ops until the window-reset clear timer releases the flag.

import { getAccountUsage } from './accountUsage.js';
import { getOverageThreshold, getOnOverageAction, usageOverThreshold } from './appSettings.js';
import { parseResetEpochSecs } from './instances.js';

// Default poll cadence. Aligned with the 180 s success cache in accountUsage.js so a
// tick rarely forces a real network fetch beyond what the chip already triggers.
const DEFAULT_POLL_MS = 180_000;

export class UsageOverageMonitor {
  // `fetchUsage` is injectable purely as a test seam (defaults to the real
  // cached fetcher). The monitor never throws out of a tick.
  constructor(manager, { fetchUsage = getAccountUsage } = {}) {
    this.manager = manager;
    this.fetchUsage = fetchUsage;
    this.timer = null;
  }

  // Begin polling. Idempotent. Cadence overridable via ORCH_USAGE_POLL_MS (ms).
  // The timer is unref()'d so it never holds the event loop / process open.
  start() {
    if (this.timer) return;
    const env = Number(process.env.ORCH_USAGE_POLL_MS);
    const ms = Number.isFinite(env) && env > 0 ? env : DEFAULT_POLL_MS;
    this.timer = setInterval(() => { this._tick().catch(() => {}); }, ms);
    if (this.timer.unref) this.timer.unref();
  }

  // Stop polling. Idempotent. Wired into BOTH manager shutdown paths
  // (shutdown / shutdownForResumeSync).
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // Force one poll cycle on demand (Settings → Models Apply, when a lower threshold
  // may already be crossed) rather than waiting up to ORCH_USAGE_POLL_MS for the next
  // tick. Reuses _tick() so the forced check goes through the exact same
  // _handleOverageTrip path as the periodic poll — no parallel stop logic.
  forceTick() {
    return this._tick();
  }

  // One poll cycle. Heavily gated so we don't fetch (or false-trip) when there's
  // nothing to do; resolves without throwing on any error. Trips on the FIVE-HOUR
  // window ONLY, and derives the resume reset from that SAME window — keeping the
  // trip window and the resume window identical (consistent with the stream path's
  // five-hour resume timing).
  async _tick() {
    const m = this.manager;
    if (m._overageActive) return;                  // already tripped this window (stream or poll)
    const t = getOverageThreshold();
    if (!t.enabled) return;                         // poll path is strictly opt-in
    if (getOnOverageAction() === 'none') return;    // no action configured → nothing to stop
    const anyLive = [...m.byId.values()].some(i => i.proc && i.status === 'turn');
    if (!anyLive) return;                           // nothing mid-turn to stop

    let usage;
    try { usage = await this.fetchUsage(); }        // getAccountUsage never throws, but an
    catch { return; }                               // aborted/rejected fetch must not false-trip
    if (!usage) return;                             // null on error/timeout → bail (no trip)
    const win = usage.five_hour;
    if (!win || typeof win.utilization !== 'number') return;
    // Same "still over the bar?" logic the resume verify uses (usageOverThreshold):
    // five_hour utilization is a 0–100 PERCENT compared directly against the percent
    // threshold. (The stream path divides by 100 — its rate_limit_info.utilization is
    // a 0–1 fraction, a different shape.) Equivalent to the old `util < t.value` guard
    // here since the threshold is enabled (value ≤ 99, so the >=100 proxy is subsumed).
    if (usageOverThreshold(usage) !== true) return;

    const resetsAt = parseResetEpochSecs(win);      // five_hour.resets_at (ISO) → epoch secs
    m._handleOverageTrip(null, { resetsAt });       // SAME machinery as the stream trip
  }
}
