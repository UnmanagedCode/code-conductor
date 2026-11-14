// InstanceManager's overage trip, stop routing and lock release. Each function
// runs as the manager (`this: InstanceManager`); the class keeps a same-name
// one-line delegate for every one, so callers and tests reach them on the manager.
import type { Instance, InstanceManager } from '../instances.ts';
import { getOnOverageAction } from '../appSettings.ts';
import { CLAUDE_BACKEND_ID } from '../modelVersions.ts';
import { usageDomainOfBackend, isMonitoredDomain } from '../usageWindowDomains.ts';

// Bounded terminal outcome for an ARMED soft interrupt, for the three callers
// that have no human behind them (the overage direct stop, the overage
// turn-start guard, the resume-restart drain). An arm normally discharges at
// the next block boundary; when the turn never ends at all — a genuinely wedged
// tool, or a gateway that withholds both a block close and any later block key
// (QuiescenceScan's R1/R2 residuals) — nothing else would ever release it, and
// these callers cannot wait forever. Manual ⏸ / interrupt_turn stay UNBOUNDED:
// a human and a conductor both already have the ⏹ escalate affordance.
//
// Exceptional, not load-bearing: it fires only for a turn that never ends.
// ORCH_SOFT_INTERRUPT_DEADLINE_MS is the test seam (same idiom as
// ORCH_OVERAGE_RESUME_BUFFER_MS) so tests never sleep out a real clock; read at
// call time, not at module load, so a test can set it after import.
const SOFT_INTERRUPT_DEADLINE_MS = 120_000;
export function softInterruptDeadlineMs(): number {
  const env = Number(process.env.ORCH_SOFT_INTERRUPT_DEADLINE_MS);
  return Number.isFinite(env) ? env : SOFT_INTERRUPT_DEADLINE_MS;
}

// Annotation on the `soft_interrupted` event the turn-start guard emits when a
// turn begins during an overage lockout. Rendered by
// web/src/conversation/format.ts as `Turn interrupted: <text>` — the observed defect was that such a turn was cut
// SILENTLY, so naming the lockout as the cause is the point. Not sent to the CLI:
// nothing may be written to a session during the window.
const OVERAGE_TURN_BLOCKED_TEXT =
  'the overage lockout is still active — this turn was stopped rather than run ' +
  'against the throttled account.';

// Arm a resume deadline IMMEDIATELY, for a session with no turn→idle transition
// for the status handler to arm on. Three callers, three reasons:
//   - a QUEUED-ONLY session (idle/new — it queued a send while the window was
//     active but was never stopped mid-work): it may already be idle;
//   - an IDLE-PARKED conductor (`_directOverageStop` with midTurn false): it is
//     never prompted and never interrupted, so it never transitions at all;
//   - the idle DRIVER of a caller whose wake the overage sever cut
//     (`_armSeveredCaller`) — the caller, or its immediate live conductor: no
//     stop reached it, so nothing else arms it.
// Deliberately touches NO preamble selector — `_overageWasStopped` /
// `_overageWasIdleParked` are the caller's to set (queued-only leaves both false).
export function _armResumeNow(this: InstanceManager, inst: Instance, resetsAt: number | null): void {
  if (inst.autoResumeAt || this._autoResumeTimers.has(inst.id)) return; // already armed
  // A worker the stop left un-armed stays un-armed: its conductor is the sole
  // driver. Backstop — prompt() refuses such a send before it can queue, so this
  // guard only catches a future second queueing path.
  if (inst._overageStoppedUnarmed) return;
  inst._overageResetsAt = Number.isFinite(Number(resetsAt)) ? resetsAt : this._overageResetsAt;
  inst.autoStoppedForOverage = true; // so cancel/flush treats it like an armed session
  this._armAutoResume(inst);         // arm() re-checks the future-resetsAt safety rail
}

// Force-reevaluate every parked overage auto-resume session against the CURRENT
// threshold — called after Settings → Models Apply raises/disables the threshold so
// a session parked under the OLD bar doesn't wait out its full deadline (which can
// be hours away, armed at window-reset). Reuses fireNow's usage-verified resolve
// unchanged; a session still over the new bar just reschedules, exactly like a
// normal sweep tick. Snapshot the keys first — fireNow synchronously deletes its own
// timers entry before doing anything async, so iterating the live map would skip
// entries.
export function reevaluateOverageResumes(this: InstanceManager): void {
  for (const id of [...this._overageResume.timers.keys()]) {
    this._overageResume.fireNow(id);
  }
}

// Apply a CHANGED overage policy to sessions already marked under the old one.
// The policy is live authority, not just trip-time input: the
// moment it is no longer 'stop-resume', no session may carry a resumption mark.
// Iterates byId, NOT _overageResume.timers: a session mid-verify (fireNow/_tick
// delete their timers entry before awaiting fetchUsage) has no timer but is still
// marked, and a session soft-interrupted but not yet at idle has
// autoStoppedForOverage set with no deadline armed — clearing that flag is what
// stops the status handler from arming it a moment later. No-op under 'stop-resume':
// switching INTO it deliberately marks nothing (nothing records which sessions a
// plain `stop` halted, and engaging the queue gate with no deadline to flush it
// would strand every send) — it takes effect at the next trip.
export function syncOveragePolicy(this: InstanceManager): void {
  if (getOnOverageAction() === 'stop-resume') return;
  // Kills the queue gate + the _reschedule lockout push. Leaves _overageActive and
  // the clear timer alone: the fleet lands exactly where a native `stop` trip leaves it.
  this._overageResumeMode = false;
  for (const inst of [...this.byId.values()]) {
    const queued = inst._overageQueue.length;
    if (!inst.autoResumeAt && !inst.autoStoppedForOverage && !queued &&
        !inst._overageStoppedUnarmed && !this._overageResume.timers.has(inst.id)) continue;
    this._overageResume.cancel(inst.id);  // deadline + every mark flag + queue, then status emit
    if (queued) {
      inst._emitUi({ kind: 'system', subtype: 'auto_resume_skipped', data: {
        reason: `overage handling changed — ${queued} queued message(s) dropped` } });
    }
  }
}

// ---- Usage-window domain resolution (overage exemption seam) -------------
// The ROOT of an instance's agent tree: walk `callerInstanceId` UPWARD through the
// live registry until there is no parent to follow. The stop's unit is the TREE, so
// membership must be asked of the whole tree — and `agentTreeBackends` only walks
// DOWNWARD, which would answer for a subtree.
//
// Terminates in every degenerate shape rather than looping or throwing:
//   - no `callerInstanceId`      → this instance IS the root (the common case);
//   - a parent no longer in byId → stop at the deepest instance we can still see
//     (a dead conductor's tree is not reconstructible, and its own gate is gone);
//   - a cycle                    → the `seen` set breaks at the first repeat. Which
//     member it lands on does not matter: `agentTreeBackends` is itself cycle-safe
//     and reaches every member of a cycle from any of them, so all members get the
//     same verdict.
export function agentTreeRoot(this: InstanceManager, inst: Instance): Instance {
  const seen = new Set<string>();
  let cur = inst;
  while (!seen.has(cur.id)) {
    seen.add(cur.id);
    if (!cur.callerInstanceId) break;
    const parent = this.byId.get(cur.callerInstanceId);
    if (!parent) break;
    cur = parent;
  }
  return cur;
}

// The set of backend IDS used across an instance's AGENT TREE: its own backend
// plus every conducted-worker descendant (separate Instances linked by
// `callerInstanceId`, each with its own backend). In-process Agent-tool
// subagents run inside the parent CLI process — the backend (endpoint + auth)
// is fixed at launch time, so they share the parent's backend and add nothing
// new. Cycle-safe.
//
// DOWNWARD only, deliberately: it answers for the argument's own subtree. What
// makes the exemption predicate tree-WIDE is `agentTreeRoot` above, applied at the
// one call site in `_inUsageWindowFlow`.
export function agentTreeBackends(this: InstanceManager, inst: Instance): Set<string> {
  const backends = new Set<string>();
  const seen = new Set<string>();
  const stack: Instance[] = [inst];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || seen.has(cur.id)) continue;
    seen.add(cur.id);
    backends.add(cur.backend ?? CLAUDE_BACKEND_ID);
    for (const child of this.byId.values()) {
      if (child.callerInstanceId === cur.id) stack.push(child);
    }
  }
  return backends;
}

// True iff the instance's ROOT agent tree touches a domain with an ACTIVE
// usage-window monitor — the single predicate every STOP-SIDE decision consults
// (routing's `live` filter, the per-instance gate, and everything the gate feeds).
// That list is stop-side only, deliberately — the one RESUME-side consumer,
// `resumeRestart.ts`'s restored-deadline re-arm, is excluded from it and carries
// its own root-scoping note there.
//
// ROOT-SCOPED: the unit of stopping is the TREE, so
// membership is resolved from the tree's root, not from the session. A tree with
// no Claude agent → e.g. {ollama} → unmonitored → EXEMPT (never auto-stopped,
// queued, or armed). A tree with any Claude agent → {anthropic} → in-flow — which
// holds for a non-Claude conductor whose workers are Claude AND, because of the
// root walk, for a non-Claude WORKER under a Claude conductor.
//
// Not the predicate for "did the monitored account emit this 429?" — see the
// stop-vs-trip split at `_handleOverageTrip`.
export function _inUsageWindowFlow(this: InstanceManager, inst: Instance): boolean {
  for (const d of this.usageWindowDomainsOf(this.agentTreeRoot(inst))) {
    if (isMonitoredDomain(d)) return true;
  }
  return false;
}

// ---- Global overage auto-stop routing -----------------------------------
// The central handler an Instance's `overage` signal lands in. One-shot per
// rate-limit window via `_overageActive`. Honours getOnOverageAction():
// 'none' does nothing at all (no flag flip, no routing). Otherwise it flips
// the flag, routes the stop across every live instance, and arms the clear
// timer so the flag releases when the window resets.
export function _handleOverageTrip(this: InstanceManager, inst: Instance | null, info: { resetsAt: number | null } | null | undefined): void {
  const action = getOnOverageAction();
  if (action === 'none') return;          // no flag flip, no routing
  // STOPPING is a TREE fact; TRIPPING is a per-session BACKEND fact. Do not unify
  // these two predicates — they answer different questions:
  //   - `_inUsageWindowFlow` (root-scoped) asks "is this session a member of a tree
  //     the stop must halt?" — the tree is the unit of stopping;
  //   - HERE we ask "did the monitored account emit this 429?", which only the
  //     EMITTING session's own backend can answer. An ollama-backed worker talks to
  //     the ollama endpoint, so its `rate_limit_event` reports ollama's window — it
  //     must not flip an anthropic lockout, even though its tree is in-flow because
  //     its conductor is Claude.
  // Strictly narrower than `_inUsageWindowFlow`: a claude-backed session is always a
  // member of its own root's tree, so this cannot admit a trip the root-scoped
  // predicate would reject. The narrowing also refuses a TRUE trip, not just false
  // ones: a custom backend that actually PROXIES the Anthropic endpoint gets a
  // namespaced `backend:<id>` domain, so its own `rate_limit_event` can no longer
  // trip the flow even in a mixed tree where a Claude ancestor previously admitted
  // it. Accepted because a proxy row is indistinguishable from any other custom
  // backend HERE: nothing at this site can tell which endpoint a launch template
  // dials. The other backstops are real but CONDITIONAL — do not read them as
  // cover. Identity-`claude` sessions' own events require such a session to exist,
  // which a pure-proxy fleet has none of. The account-global poll requires BOTH
  // the usage threshold to be ENABLED (strictly opt-in, `enabled:false` when
  // unset — `getOverageThreshold`, and `UsageOverageMonitor._tick` bails on it)
  // AND the proxy to drain the SAME account the poll watches (`getAccountUsage`
  // reads one fixed `~/.claude/.credentials.json` OAuth token, and a proxy row
  // often exists precisely to drain a different org). Default settings + an
  // all-proxy fleet ⇒ nothing trips at all.
  // The poll monitor passes inst=null (account-global) and is unaffected by either
  // predicate.
  if (inst && !isMonitoredDomain(usageDomainOfBackend(inst.backend))) return;
  if (this._overageActive) return;        // one-shot while active
  this._overageActive = true;
  this._overageResetsAt = info?.resetsAt ?? null;
  const resume = action === 'stop-resume';
  // Global queueing engages ONLY in stop-resume mode (it has a flush path).
  this._overageResumeMode = resume;
  this._routeOverageStop({ resume, resetsAt: this._overageResetsAt });
  this._armOverageClear(this._overageResetsAt);
}

// Route a single overage stop across all live instances. EVERY session it
// touches gets `_directOverageStop` — nothing is sent to anything: the account is
// throttled, so a message into it is exactly the burn the stop exists to prevent
// A mid-turn session is soft-interrupted; an idle one has no
// turn to interrupt and is instead severed, marked, and armed for resume on the
// spot.
export function _routeOverageStop(this: InstanceManager, { resume, resetsAt }: { resume: boolean; resetsAt: number | null }): void {
  // Exempt instances whose ROOT agent tree is purely in an unmonitored
  // usage-window domain (e.g. ollama-only): they consume no monitored account
  // window, so they are never stopped/marked. A Claude conductor's ollama-only
  // worker is NOT such a case — its root tree contains the conductor's `claude`,
  // so it is stopped along with the conductor.
  const live = [...this.byId.values()].filter(i => i.proc && this._inUsageWindowFlow(i));
  // Pass 1: resolve which conductors are in control and which workers they protect.
  // In control = mid-turn, holding a wake (`isIdleCaller`), or a JOB WAITER: an
  // idle conductor whose worker holds a live background job holds no wake now,
  // but the job's exit re-invokes that worker and re-arms one — and the guard
  // then severs it. Stopping it here arms it at the trip, so its resume is
  // badged from the start. A job that never ends (a promoted dev server) still
  // counts, which costs that conductor one idle-parked resume turn per reset.
  const jobWaiting = this._jobWaiters();
  const inControlConductors = new Map<string, Instance>();  // conductor id → conductor instance
  const protectedWorkers = new Set<string>(); // worker ids owned by an in-control conductor
  for (const inst of live) {
    if (!inst.conducted) continue;
    const conductor = this._ownerConductor(inst);
    const inControl = conductor && conductor.proc &&
      (conductor.status === 'turn' || this.isIdleCaller(conductor.id) || jobWaiting.has(conductor.id));
    if (inControl) {
      inControlConductors.set(conductor.id, conductor);
      protectedWorkers.add(inst.id);
    }
  }
  // Pass 2: stop each in-control conductor once (it owns ≥1 protected worker).
  // Mid-turn OR idle — `_directOverageStop` handles both, and the idle case is
  // reachable ONLY from here (Pass 3 skips anything not `status === 'turn'`).
  for (const conductor of inControlConductors.values()) {
    this._directOverageStop(conductor, { resume, resetsAt });
  }
  // Pass 3: stop every other mid-turn instance — plain sessions, conducted
  // workers (with or without an in-control conductor), and the Conduct
  // orchestrator when it has no in-control workers (it tripped itself, or its
  // workers were momentarily idle). Only Pass 2's conductors are skipped; their
  // workers are NOT: the conductor is not asked to halt them, so they are stopped
  // directly.
  //
  // ONE branch: a `.conduct` orchestrator is never `conducted`,
  // so it is never a protected worker ⇒ `unarmed` is false for it ⇒ it takes
  // exactly the arming the old conductor branch gave it, and `if (!unarmed)
  // continue` skips the owner-marking that does not apply.
  for (const inst of live) {
    if (inControlConductors.has(inst.id)) continue;
    if (inst.status !== 'turn') continue;
    // A worker owned by an in-control conductor is stopped but deliberately
    // left UN-ARMED: its conductor is the sole driver on resume (told so by
    // UNARMED_WORKERS_CLAUSE, src/overageResume.ts). Arming it too would have the
    // conductor's re-drive land mid-turn on a worker that just self-resumed —
    // the very mid-turn injection this whole path exists to avoid.
    const unarmed = protectedWorkers.has(inst.id);
    this._directOverageStop(inst, { resume, resetsAt, armResume: resume && !unarmed });
    // ASSIGNED, never latched: a later trip can find this worker un-protected
    // (its conductor gone, or idle with no wake armed), and a stale `true` then refuses
    // every send to an ordinary session that `Stop & resume` says should queue —
    // while the only thing that would clear it is the send it refuses. Worse, a
    // later trip can ARM it, leaving the refusal contradicting a resume timer
    // that demonstrably will fire.
    inst._overageStoppedUnarmed = unarmed;
    if (!unarmed) continue;
    // Its conductor is marked too: severForOverageStop only reports a severed
    // CALLBACK, and a conductor can own workers while holding no subscription.
    const owner = this._ownerConductor(inst);
    if (owner) owner._overageUnarmedWorkers = true;
  }
}

// The owning conductor of a conducted worker: callerInstanceId is the
// conductor's instanceId, mapped back through the live registry — which is
// exactly the key isIdleCaller() uses. Null when the conductor is gone.
export function _ownerConductor(this: InstanceManager, worker: Instance): Instance | null {
  const callerId = worker.callerInstanceId;
  if (!callerId) return null;
  return this.byId.get(callerId) ?? null;
}

// The ONE stop path, for every session routing touches — mid-turn or idle.
// NOTHING is sent here: the account is throttled, so a message into it is the
// burn the stop exists to prevent. For stop-resume, mark the
// instance so its resume arms. `armResume` defaults to `resume` and splits off
// only for a conductor's own worker, which is stopped un-armed.
//
// The event carries `armResume`, NOT the routing mode:
// web/src/conversation/format.ts renders `resume:true` as "Auto-resuming at ⟨time⟩", which for an un-armed worker names
// a resume that will never happen — and contradicts its own null `autoResumeAt`
// badge.
export function _directOverageStop(this: InstanceManager, inst: Instance, { resume, resetsAt, armResume = resume }: { resume: boolean; resetsAt: number | null; armResume?: boolean }): void {
  // Read BEFORE the interrupt — which is the SOFT tier and changes no status
  // synchronously, but reading first makes that independent of the tier.
  const midTurn = inst.status === 'turn';
  if (armResume) {
    inst.autoStoppedForOverage = true;
    // The preamble selector: stopped mid-work gets "continue where you left off";
    // an already-idle session had nothing of its own interrupted and must not be
    // told otherwise (src/overageResume.ts → overageResumeKind).
    inst._overageWasStopped = midTurn;
    inst._overageWasIdleParked = !midTurn;
    inst._overageResetsAt = resetsAt;
  }
  inst._emitUi({ kind: 'system', subtype: 'auto_stop_overage', data: { resume: armResume, resetsAt } });
  this._severOverageWakes(inst);
  // Harmless no-op when the session is already idle: interrupt() returns
  // immediately on `status !== 'turn'`, so nothing reaches stdin and no status
  // frame is emitted. Pinned by tests/overage-action.test.mjs.
  // BOUNDED (see softInterruptDeadlineMs): no human is behind this stop, so an
  // arm that never reaches a boundary escalates instead of latching for the turn.
  inst.interrupt({ deadlineMs: softInterruptDeadlineMs() }).catch(() => {});
  // An idle session makes no turn→idle transition for the status handler to arm
  // on, and it is never prompted either, so this is its arming at the stop (a
  // later sever skips it as already armed). Armed through the same controller
  // entry point a queued-only session uses.
  if (armResume && !midTurn) this._armResumeNow(inst, resetsAt);
}

// Sever the idle-wake graph around a session, and MARK every caller that loses a
// wait — marked, not notified: the mark only reaches a caller that has a resume
// prompt of its own to carry it, which an un-armed or plain-`stop` caller does
// not. So each marked caller's sole driver — its immediate live conductor, else the
// caller itself — is also ARMED when nothing else will arm it (`_armSeveredCaller`): an idle conductor
// whose wake is cut has no stop and no turn→idle transition, and would otherwise
// wait out the window with no resume.
// The purge is bidirectional, so a third session waiting ON this one loses its
// wait too and is marked as well.
//
// Why sever at all: a wake is an `internal:true` prompt, which the overage queue
// intercept deliberately does NOT hold, so it would start a fresh turn inside the
// lockout. TWO callers, both of which need it for a different reason:
//   - `_directOverageStop` — the stopped session's own turn_end must wake nobody,
//     and nothing may later wake it (including via the heartbeat, well inside a
//     five-hour window, on a target Pass 3 left running).
//   - `_guardOverageTurnStart` — spawn ownership SURVIVES purge(): `ownersOf`
//     re-adds the parent from `callerInstanceId` on every call, so a severed
//     worker whose turn starts again re-arms its conductor's wake at
//     `onTurnStart`. Without severing here, the guard's own interrupt then wakes
//     that conductor with an `internal:true` stub — violating the
//     no-prompt-into-a-throttled-account rule from inside the turn-start
//     lockout guard.
export function _severOverageWakes(this: InstanceManager, inst: Instance): void {
  for (const callerId of this._idleHub.severForOverageStop(inst.id)) {
    const caller = this.byId.get(callerId);
    if (!caller) continue;
    caller._overageDroppedCallbacks = true;
    this._armSeveredCaller(caller);
  }
}

// Arm the SOLE DRIVER of a caller that just lost a wake to the overage sever,
// idle-parked: the sever interrupted none of its own work.
//
// The driver resolves as routing's does (Pass 1/2): a conducted caller's IMMEDIATE
// live owner (`_ownerConductor`, one hop — never further), else the caller itself.
// A conducted caller with a live owner is therefore NEVER armed here, whatever order
// the severs come in: arming it too would have its conductor's re-drive land
// mid-turn on a session that just self-resumed. That holds a level up as well — a
// severed sub-conductor arms its own owner, not itself. The driver is marked
// `_overageDroppedCallbacks` so its resume tells it to re-check, rather than wait
// on a wake nothing will send. The owner shares the caller's root tree, so the
// flow check below holds for the driver too.
//
// Gated on the lockout's mode flags plus tree membership, NOT `_overageGate().active`:
// the gate's future-`resetsAt` rail would make this a no-op on a trip with no reset
// time, where routing still arms (and arm() rechecks soon).
//
// Every check runs BEFORE the arming writes — a stray `autoStoppedForOverage` with
// no deadline holds `_maybeReleaseOverageLock` forever.
export function _armSeveredCaller(this: InstanceManager, caller: Instance): void {
  if (!this._overageActive || !this._overageResumeMode) return; // plain Stop, or released
  if (!caller.proc || !this._inUsageWindowFlow(caller)) return;  // dead, or root-exempt
  // Already armed — or marked by a stop and arming at its idle transition. The
  // `autoResumeAt` / timer terms are defensive: every arming sets the flag first.
  const armed = (i: Instance) =>
    i.autoStoppedForOverage || i.autoResumeAt != null || this._autoResumeTimers.has(i.id);
  // An armed CALLER carries the clause on its own resume (the sever loop has marked
  // it), so no driver is resolved and its owner is untouched. This is what keeps a
  // routed session's own sever — `_directOverageStop` sets the flag before severing —
  // and a queued-only session's later sever from arming a second driver above it.
  if (armed(caller)) return;
  const owner = caller.conducted ? this._ownerConductor(caller) : null;
  const driver = owner?.proc ? owner : caller;
  driver._overageDroppedCallbacks = true;
  if (armed(driver)) return;
  // A worker Pass 3 stopped un-armed stays un-armed even once its owner is gone
  // (the driver is then the worker itself): the `_armResumeNow` backstop fires only
  // after the selectors below were written, and the mid-turn branch bypasses it
  // entirely.
  if (driver._overageStoppedUnarmed) return;
  driver._overageWasStopped = false;
  driver._overageWasIdleParked = true;
  driver._overageResetsAt = this._overageResetsAt;
  // Mid-turn: the status handler arms it at idle, as for a routed mid-turn stop.
  if (driver.status === 'turn') driver.autoStoppedForOverage = true;
  else this._armResumeNow(driver, this._overageResetsAt);
}

// Turn-start lockout guard. A turn that begins during an overage
// stop-resume lockout is stopped rather than run against the throttled account —
// wired at the turn-START seam rather than per send site, because the observed
// defect was workers re-invoked by a path the enumerated sites did not cover.
//
// Every scope condition falls out of `_overageGate().active`, which is the single
// owner of them: it ANDs `_overageActive`, `_overageResumeMode` (so plain `Stop` is
// out), a FUTURE finite `resetsAt` (the safety rail), and the root-scoped
// `_inUsageWindowFlow` (so a ROOT-exempt session is out — a non-Claude worker under
// a Claude conductor is in, and this guard is its backstop).
export function _guardOverageTurnStart(this: InstanceManager, inst: Instance): void {
  if (!(inst._overageGate ? inst._overageGate().active : false)) return;
  // The auto-resume's own fire is the one turn that MUST run. Tested by FLAG, not
  // by re-deriving whether the lockout is still live at this instant: it may or may
  // not be, depending on the interleaving (see OverageResumeController.run).
  if (inst._overageResumeFiring) return;
  inst._emitUi({ kind: 'system', subtype: 'soft_interrupted', data: { text: OVERAGE_TURN_BLOCKED_TEXT } });
  this._severOverageWakes(inst);
  // SOFT tier — never force:true up front, but BOUNDED: this caller is automatic.
  inst.interrupt({ deadlineMs: softInterruptDeadlineMs() }).catch(() => {});
}

// Arm the global clear: release `_overageActive` when the rate-limit window
// resets, so a later overage can trip again. Covers the plain-`stop` case
// (no resume timer) and is the backstop for stop-resume too. Skips when
// resetsAt is missing/past (the flag then clears only on manual resume).
// ORCH_OVERAGE_RESUME_BUFFER_MS doubles as the test seam (shared with the
// resume controller) so tests don't sleep out the wall clock.
export function _armOverageClear(this: InstanceManager, resetsAt: number | null): void {
  if (this._overageClearTimer) { clearTimeout(this._overageClearTimer); this._overageClearTimer = null; }
  const atMs = Number(resetsAt) * 1000; // epoch seconds → ms
  if (!Number.isFinite(atMs)) return;
  const envBuf = Number(process.env.ORCH_OVERAGE_RESUME_BUFFER_MS);
  const bufMs = Number.isFinite(envBuf) ? envBuf : 5000;
  const delay = Math.max(0, atMs + bufMs - Date.now());
  // BACKSTOP only: fires _maybeReleaseOverageLock, which no-ops while any session
  // is still parked-and-rechecking (its resume verify drives the real release) and
  // clears only the "no session ever armed a deadline" case (e.g. plain `stop`, or
  // a stop-resume trip whose sole live session died before arming). This is the fix
  // for the old bug where the clock lifted the lockout at the ORIGINAL resetsAt while
  // sessions were still throttled: parked sessions keep timers, so this now no-ops.
  this._overageClearTimer = setTimeout(() => this._maybeReleaseOverageLock(), delay);
}

// Release the global overage lockout iff nothing is parked anymore — i.e. every
// per-session resume has resolved (usage-verified resumed, failed-open resumed, or
// torn down because the process vanished). Ties the global release to the SAME
// usage-verified sweep that resumes sessions, so the lockout and the resumes can't
// disagree. Called by the resume controller after each deadline-removing outcome
// and by the clock backstop.
export function _maybeReleaseOverageLock(this: InstanceManager): void {
  if (!this._overageActive) return;
  if (this._overageResume.timers.size > 0) return; // sessions still parked/rechecking
  // A session soft-interrupted for overage but not yet at idle (so no deadline armed
  // yet) will arm imminently — don't lift the lockout out from under it. This also
  // closes the backstop race when resetsAt is past/immediate: autoStoppedForOverage
  // is set synchronously at trip time, before the session round-trips to idle.
  for (const inst of this.byId.values()) {
    if (inst.proc && inst.autoStoppedForOverage) return;
  }
  this._clearOverage();
}

// Release the global overage one-shot and re-enable per-instance trip
// detection. Called by the clear timer (window reset) and on manual resume of
// an overage-stopped session.
export function _clearOverage(this: InstanceManager): void {
  if (this._overageClearTimer) { clearTimeout(this._overageClearTimer); this._overageClearTimer = null; }
  this._overageActive = false;
  this._overageResetsAt = null;
  this._overageResumeMode = false;
  // Drop the paused state everywhere: re-enable per-instance trip detection and
  // push a fresh summary for every session so composers that were showing the
  // paused banner (incl. not-yet-queued sessions surfacing it via the gate)
  // drop it now. Armed sessions with queued messages are flushed independently
  // by the resume sweep — this is just the banner/gate teardown.
  for (const inst of this.byId.values()) {
    inst._overageHandled = false;
    // The un-armed refusal's lifetime IS this window (overageSendRefused ANDs the
    // flag with gate.active), so the release ends it. Pass 3's per-trip assignment
    // cannot cover this: it sits behind `if (inst.status !== 'turn') continue`, so a
    // worker that is idle at the next trip is never visited. Left set, the flag
    // outlives its meaning twice over — `summary()` reports it ungated, and this
    // loop's own emit re-renders the composer with Send disabled under "messages
    // can't be queued here" while the server would accept that send; the human
    // cannot clear it, because the only per-session clear needs a successful
    // non-internal prompt and the button that would send one is the disabled one.
    inst._overageStoppedUnarmed = false;
    this.emit('status', inst.summary());
  }
}
