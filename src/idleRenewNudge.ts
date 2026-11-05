// Idle-renewal nudge: once per idle stretch, shortly before a top-level
// conductor's prompt cache expires, inject one turn asking it whether to
// `renew_session` while the cache is still warm (the text and its marker:
// shared/idleRenewNudge.ts). Opt-in, from Settings → Models
// (getConductorIdleNudge in src/appSettings.ts).
//
// A STRETCH starts at a real turn's end. A nudge-chain turn (the nudge, and the
// `/clear` + reseed of a renewal it caused — Instance `_turnNudgeChain`) never
// starts one, so a nudge cannot re-arm itself: the stretch stays spent until
// the next real turn ends.
//
// Firing is a single shared WALL-CLOCK sweep, not a long setTimeout per
// session, for the reason src/overageResume.ts gives: a monotonic timer does
// not advance while the device sleeps. A stretch whose cache is already cold
// when the sweep sees it (device sleep, a late enable, a lowered threshold) is
// spent without a send. In-memory only: every session cc resumes after a
// restart is a new Instance with no entry, so a restart never bursts nudges.

import { isTopLevelConductor } from '../shared/conductors.ts';
import { buildIdleRenewNudge, PROMPT_CACHE_TTL_MINUTES } from '../shared/idleRenewNudge.ts';
import type { UiEvent } from '../shared/uiEvent.ts';
import { renewalDeferredBy } from './sessionRenew.ts';
import { isDeadStatus } from './instances.ts';

export const IDLE_NUDGE_SWEEP_MS = 30_000;
const MINUTE_MS = 60_000;

// The instance facts the controller reads (Instance satisfies it).
export interface NudgeInstance {
  readonly project: string;
  readonly conducted: boolean;
  readonly proc: unknown;
  readonly status: string;
  readonly pristine: boolean;
  readonly rotationPending: boolean;
  readonly renewalPending: boolean;
  readonly relaunching: boolean;
  readonly rewriteBlocksPrompts: boolean;
  readonly steerPending: boolean;
  readonly activeAgentTaskCount: number;
  readonly taskNotificationPending: boolean;
  readonly autoStoppedForOverage: boolean;
  readonly autoResumeAt: number | null;
  readonly _overageQueue: unknown[];
  readonly lastTurnEndWasNudgeChain: boolean;
  overageReportedNow(now: number): boolean;
  prompt(text: string, attachments: unknown[], opts: { internal: boolean; annotateIfMidTurn: boolean; idleNudge: boolean }): Promise<unknown>;
  _emitUi(ev: UiEvent): void;
}

export interface NudgeManager {
  readonly byId: ReadonlyMap<string, NudgeInstance>;
  readonly _overageActive: boolean;
}

export interface NudgeTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

interface NudgeDeps {
  manager: NudgeManager;
  now: () => number;
  // Read whenever the sweep starts, so a test's seam applies to it.
  timers: () => NudgeTimers;
  // Read at every tick: a saved threshold applies to stretches already running.
  setting: () => { enabled: boolean; value: number };
}

interface Stretch { since: number; spent: boolean }

export class IdleRenewNudgeController {
  #deps: NudgeDeps;
  #stretches = new Map<string, Stretch>();
  #sweep: { handle: unknown; timers: NudgeTimers } | null = null;
  #suspended = false;

  constructor(deps: NudgeDeps) {
    this.#deps = deps;
  }

  onEvent({ id, ev }: { id: string; ev: UiEvent | null }): void {
    if (ev?.kind !== 'turn_end') return;
    const inst = this.#deps.manager.byId.get(id);
    if (!inst || !isTopLevelConductor(inst) || inst.lastTurnEndWasNudgeChain) return;
    this.#stretches.set(id, { since: this.#deps.now(), spent: false });
    this.#ensureSweep();
  }

  // One sweep pass. Public as the test seam.
  tick(): void {
    if (this.#suspended || !this.#deps.setting().enabled) { this.#stopSweep(); return; }
    const now = this.#deps.now();
    const thresholdMs = this.#deps.setting().value * MINUTE_MS;
    for (const [id, s] of this.#stretches) {
      if (s.spent || now - s.since < thresholdMs) continue;
      const inst = this.#deps.manager.byId.get(id);
      if (!inst) { this.#stretches.delete(id); continue; }
      // Before the drop: a relaunch (model switch, crash respawn) passes through
      // no proc and a dead status on the same Instance, and the stretch it keeps
      // is still owed its nudge once the relaunch lands.
      if (inst.relaunching) continue;
      if (!inst.proc || isDeadStatus(inst.status)) { this.#stretches.delete(id); continue; }
      // Overage before the busy check: a queued overage message also reads as
      // busy (renewalDeferredBy), but it means the cache is already cold.
      if (this.#inOverage(inst, now)) { s.spent = true; continue; }
      if (this.#busy(inst)) continue;
      s.spent = true;
      if (now - s.since >= PROMPT_CACHE_TTL_MINUTES * MINUTE_MS) continue;
      this.#fire(inst, Math.floor((now - s.since) / MINUTE_MS));
    }
    if (!this.#hasUnspent()) this.#stopSweep();
  }

  // Re-read the setting after a save: start or stop the sweep.
  sync(): void {
    if (this.#deps.setting().enabled) this.#ensureSweep();
    else this.#stopSweep();
  }

  // The resume-restart drain: no nudge may start a turn until resume().
  suspend(): void { this.#suspended = true; this.#stopSweep(); }
  resume(): void { this.#suspended = false; this.#ensureSweep(); }

  purge(instanceId: string): void {
    this.#stretches.delete(instanceId);
    if (!this.#hasUnspent()) this.#stopSweep();
  }

  clearAll(): void {
    this.#stretches.clear();
    this.#stopSweep();
  }

  // Transient: the stretch stays unspent and the next tick looks again. Work
  // the CLI will re-invoke the session for (subagents, a task notification)
  // ends in a real turn, which restarts the stretch anyway.
  #busy(inst: NudgeInstance): boolean {
    return inst.status !== 'idle' || inst.pristine || inst.rotationPending || inst.renewalPending
      || inst.relaunching || inst.rewriteBlocksPrompts || inst.steerPending
      || renewalDeferredBy(inst) !== null;
  }

  // In overage the cache lives minutes, not an hour: it is already cold.
  #inOverage(inst: NudgeInstance, now: number): boolean {
    return this.#deps.manager._overageActive || inst.autoStoppedForOverage || inst.autoResumeAt != null
      || (inst._overageQueue?.length ?? 0) > 0 || inst.overageReportedNow(now);
  }

  #fire(inst: NudgeInstance, idleMinutes: number): void {
    const report = (err: unknown): void => {
      inst._emitUi({ kind: 'system', subtype: 'stderr',
        data: { line: `idle-renewal nudge delivery failed: ${err instanceof Error ? err.message : String(err)}` } });
    };
    try {
      inst.prompt(buildIdleRenewNudge(idleMinutes), [], { internal: true, annotateIfMidTurn: false, idleNudge: true })
        .catch(report);
    } catch (err) { report(err); }
  }

  #hasUnspent(): boolean {
    for (const s of this.#stretches.values()) if (!s.spent) return true;
    return false;
  }

  #ensureSweep(): void {
    if (this.#sweep || this.#suspended || !this.#hasUnspent() || !this.#deps.setting().enabled) return;
    const timers = this.#deps.timers();
    const handle = timers.setInterval(() => this.tick(), IDLE_NUDGE_SWEEP_MS);
    (handle as { unref?: () => void } | null)?.unref?.();
    this.#sweep = { handle, timers };
  }

  #stopSweep(): void {
    if (!this.#sweep) return;
    this.#sweep.timers.clearInterval(this.#sweep.handle);
    this.#sweep = null;
  }
}
