// Carrying live sessions across a stop of cc.
//
// Three parts:
//   The facts — captureResumeFacts + buildResumeEntries turn the live instance
//   set into resume entries. finishDrain writes them as the resume manifest at
//   a clean stop; the running recorder (src/runningRecord.ts) writes the same
//   entries as the running record while cc runs, so a stop with no drain (a
//   crash, a kill, a reboot) restores the same sessions.
//   The drain — run in the OLD process by runRestart (src/restart.ts) for a
//   Restart or a Shut down: drainToIdle winds every live turn down to idle
//   (networking stays UP so in-flight hook round-trips finish and the UI shows
//   progress); then either finishDrain writes the manifest (normal sessions are
//   carried over too), closes subprocesses without deleting their jsonl and removes the
//   running record, after runRestart has torn networking down, or, when the
//   relaunch's preparation fails after the drain, abortDrain hands the sessions
//   back.
//   The restore (restoreFromResumeManifest) — run in the NEW process on boot:
//   re-spawn (`--resume`) the carried-over sessions, staggered, splitting them
//   into conductors / conducted workers / others, and give each busy one its
//   continue notice — prompted at once when the source delivers `auto`, held for
//   the resume banner (src/pendingContinue.ts) when it is `gated`. Conducted
//   workers are NOT resumed here — the conductor they were spawned under is told
//   about its whole subtree and re-spawns them (their jsonl was preserved for
//   exactly that).

import { waitFor } from './waitFor.ts';
import { CLAUDE_BACKEND_ID } from './modelVersions.ts';
import { getOnOverageAction } from './appSettings.ts';
import { softInterruptDeadlineMs } from './instances.ts';
import {
  writeResumeManifest,
  clearRunningRecord,
  takeRestoreSource,
  type Deliver,
  type RestoreKind,
  type RestoreSource,
  type RunningCli,
} from './resumeManifest.ts';
import type { PendingContinue } from './pendingContinue.ts';
import { CONDUCT_PROJECT_NAME, ensureConductProject, isConductorInstance } from './conduct.ts';
import { RESTART_NOTICE_TRUNK, UNCLEAN_STOP_NOTICE_TRUNK, RESTART_ABORTED_LEAD } from '../shared/injectedTurns.ts';
import { normalizePlaybookEnforcement, type PlaybookEnforcement } from './playbooks.ts';
import type { InstanceLike, InstanceManagerLike, InstanceSummary, SubtreeRow } from './instanceTypes.ts';

// Wait-and-retry grace: after the drain's soft interrupts, wait this long (`RESUME_DRAIN_GRACE_MS`) for every live
// instance to leave its turn on its own. If the grace elapses, log a warning,
// ESCALATE any straggler still in turn to the forced tier, and keep waiting.
// (The soft arms themselves are also bounded — see softInterruptDeadlineMs —
// so a stop that never reaches a block boundary escalates on its own deadline;
// this loop is the outer backstop for a turn that is running fine but long.)
export const RESUME_DRAIN_GRACE_MS = 60000;
// Gap between staggered respawns on boot — N concurrent claude spawns is a
// resource spike on Termux/Android.
export const RESUME_STAGGER_MS = 1500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- Message texts -------------------------------------------------------

export const RESUME_TEXT =
  `${RESTART_NOTICE_TRUNK} — ` +
  'pick up wherever you left off before the restart.';

// What an unclean stop adds over a restart: no drain wound the turn down.
const MID_FLIGHT =
  ' — your turn was cut off mid-flight without being wound down, so your last tool call ' +
  'may not have finished: check its effect before you carry on.';

// The continue notice of a busy session restored after an unclean stop.
export const UNCLEAN_RESUME_TEXT = `${UNCLEAN_STOP_NOTICE_TRUNK}${MID_FLIGHT}`;

// Sent by abortDrain to every session the drain found with resumable work: its
// turn was wound down and the wakes it waited on were dropped while suspended.
export const RESTART_ABORTED_TEXT =
  `${RESTART_ABORTED_LEAD} Your turn was wound down for it: pick up where you left off, ` +
  'and re-drive any worker you were waiting on — its turn was wound down too and no wake will arrive for it.';

// A row of the resume list (from conductedSubtreeOf). `parentSessionId` is
// absent on a row written by a build that listed direct workers only, so absent
// reads as the root — which every such row was.
interface WorkerRow {
  worktreeName?: string | null;
  project?: string | null;
  sessionId?: string | null;
  parentSessionId?: string | null;
}

// A conductor's spawn subtree and what to do with it: every session in it, each
// naming the session that spawned it. The conductor resumes the rows spawned by
// it and tells each section lead (a listed row in the conduct project) which
// rows that lead spawned. A row spawned by a listed non-conduct session is the
// conductor's to resume: a worker cannot spawn. `before` names the stop.
function subtreeBlock(rootSessionId: string, workers: WorkerRow[], before: string): string {
  const projectOf = new Map(workers.map((w) => [w.sessionId, w.project] as const));
  const lines = workers.map((w) => {
    const wt = w.worktreeName ? `worktree \`${w.worktreeName}\`` : '(no worktree)';
    const p = w.parentSessionId;
    const parent = !p || p === rootSessionId ? 'you'
      : projectOf.get(p) === CONDUCT_PROJECT_NAME ? `\`${p}\``
        : `\`${p}\` (a worker — resume it yourself)`;
    return `- project \`${w.project}\`, sessionId \`${w.sessionId}\`, ${wt}, spawned by ${parent}`;
  });
  return (
    `Every session spawned under you before ${before} is listed below. Each has ` +
    'been preserved but is NOT running. Resume the ones spawned by you with ' +
    '`mcp__code-conductor__spawn_instance` using the matching `resume` sessionId, ' +
    'then tell each section lead (a listed session in project `' + CONDUCT_PROJECT_NAME + '`) which of ' +
    'the listed sessions it spawned, so it resumes those the same way:\n' +
    lines.join('\n')
  );
}

// The restart notice for a session that had spawned workers.
export function buildWorkersResumeText(rootSessionId: string, workers: WorkerRow[]): string {
  return `${RESTART_NOTICE_TRUNK}, and you should resume the workers you had spawned.\n\n` +
    subtreeBlock(rootSessionId, workers, 'the restart');
}

// The unclean-stop notice for a session that had spawned workers.
export function buildWorkersUncleanResumeText(rootSessionId: string, workers: WorkerRow[]): string {
  return `${UNCLEAN_STOP_NOTICE_TRUNK}${MID_FLIGHT} Your workers were killed mid-turn too, and you should resume them.\n\n` +
    subtreeBlock(rootSessionId, workers, 'the stop');
}

// Appended to a notice when background work died with the stop.
export function backgroundWorkLostNote(rootSessionId: string, sessionIds: string[], cause: RestoreKind = 'restart'): string {
  const who = sessionIds.map((s) => s === rootSessionId ? 'you' : `\`${s}\``).join(', ');
  return `Background work — background Bash runs, Monitors or background subagents — was still running in ${who}. ` +
    `${cause === 'unclean' ? 'The unexpected stop' : 'The restart'} killed it, and no completion notice or wake will come for it: re-check what it was doing and re-dispatch what is still needed.`;
}

// The continue notice a busy top-level session gets after a stop of `kind`.
export function noticeFor(e: ResumeEntry, kind: RestoreKind): string {
  const unclean = kind === 'unclean';
  const text = e.workers?.length
    ? (unclean ? buildWorkersUncleanResumeText : buildWorkersResumeText)(e.sessionId, e.workers)
    : (unclean ? UNCLEAN_RESUME_TEXT : RESUME_TEXT);
  return e.backgroundWorkLost?.length ? `${text}\n\n${backgroundWorkLostNote(e.sessionId, e.backgroundWorkLost, kind)}` : text;
}

// --- Phase 1+2: drain + restart (old process) ----------------------------

// Classify a live instance into a resume group.
function groupOf(inst: InstanceLike): 'worker' | 'conductor' | 'other' {
  if (inst.conducted) return 'worker';
  if (isConductorInstance(inst)) return 'conductor';
  return 'other';
}

// Background work lives only in the CLI process: background Bash runs and
// Monitors (`backgroundJobs` — the CLI reports a Monitor as `local_bash`) and
// background subagents (`activeAgentTaskCount`). Shutdown kills it, and no
// completion notice or wake follows.
function holdsBackgroundWork(i: InstanceLike | null): boolean {
  return !!i && (i.backgroundJobs.length > 0 || i.activeAgentTaskCount > 0);
}

// Resolve once every live instance has left `turn` (idle/exited/crashed), or on
// the grace timeout. Returns { timedOut, stragglers } where stragglers are the
// instances still mid-turn at timeout.
// A restart model switch counts as busy for its whole run, process-less gap
// included: the manifest must carry the model it settles on, not one it has not
// confirmed (Instance.switchModel).
function waitAllIdle(instances: InstanceManagerLike, graceMs: number): Promise<{ timedOut: boolean; stragglers: InstanceLike[] }> {
  const all = [...instances.byId.values()];
  const pending = new Set(all.filter((i) => (i.proc && i.status === 'turn') || i.modelSwitch));
  return waitFor<{ timedOut: boolean; stragglers: InstanceLike[] }>({
    initial: () => pending.size === 0 ? { value: { timedOut: false, stragglers: [] } } : null,
    // The N-listener case is exactly why subscribe() returns an opaque teardown
    // rather than naming one event: the helper never has to know how many.
    subscribe: (settle) => {
      const listeners: Array<[InstanceLike, (s: InstanceSummary) => void]> = [];
      for (const inst of pending) {
        function fn(s: InstanceSummary): void {
          if (s.modelSwitch || s.status === 'turn' || s.status === 'spawning') return;
          pending.delete(inst);
          if (pending.size === 0) settle({ timedOut: false, stragglers: [] });
        }
        listeners.push([inst, fn]);
        inst.on('status', fn);
      }
      return () => { for (const [inst, fn] of listeners) inst.off('status', fn); };
    },
    timeoutMs: graceMs,
    onTimeout: () => ({ timedOut: true, stragglers: [...pending] }),
  });
}

// The live-set facts the resume entries are built from: what drainToIdle
// captures before the stop for finishDrain or abortDrain, and what the running
// recorder captures at each flush.
export interface ResumeFacts {
  // Each top-level conductor's spawn subtree, by instance id.
  subtreeOf: Map<string, SubtreeRow[]>;
  // Instance ids with resumable work.
  busy: Set<string>;
}
export type DrainState = ResumeFacts;

// Capture the facts from the live instances. A hand-spawned session gets no
// subtree (it cannot spawn), so it gets the plain notice.
export function captureResumeFacts(instances: InstanceManagerLike): ResumeFacts {
  const live = [...instances.byId.values()].filter((i) => i.proc);
  const subtreeOf = new Map<string, SubtreeRow[]>();
  for (const inst of live) {
    if (groupOf(inst) === 'conductor') subtreeOf.set(inst.id, instances.conductedSubtreeOf(inst.id));
  }
  // "Resumable work" distinguishes sessions that need a continue notice from
  // ones that were idle with nothing pending (resurrected silently): mid-turn OR
  // idle-but-parked on an armed OUTGOING idle wake, i.e. a conductor
  // that ended its turn and is waiting on a worker (isIdleCaller — the caller
  // side — the same fact list()/the sidebar surface as `awaitingWake`: true while
  // an armed wake is PENDING, which is wider than "its worker is mid-turn" and
  // deliberately covers the held states, a deferred turn_end and a dropped
  // idle-drain settle, where the target is already idle), and a wake already
  // consumed but not yet taken in by the CLI, or held for a mid-turn recipient
  // (`_inFlight` / `_parked` / `_deferredWakes` in the idle hub). Such a conductor has
  // durable re-conduct work (re-spawn workers, re-drive them) even
  // though it's idle, so it must still receive its notice. A stop widens this
  // for top-level sessions whose background work it kills — in
  // buildResumeEntries, since an aborted restart kills none.
  const busy = new Set(
    live.filter((i) => i.status === 'turn' || instances.isIdleCaller(i.id)).map((i) => i.id),
  );
  return { subtreeOf, busy };
}

// Steps 1–3 of the drain: snapshot, suspend wakes, soft-stop, wait for all-idle
// (never forced). Every live turn has ended when it resolves; networking is
// untouched.
export async function drainToIdle({ instances, log = console, graceMs = RESUME_DRAIN_GRACE_MS }: {
  instances: InstanceManagerLike; log?: RestartLog; graceMs?: number;
}): Promise<DrainState> {
  const live = [...instances.byId.values()].filter((i) => i.proc);

  // (1) Snapshot the facts BEFORE draining — instance ids become meaningless
  // across the restart, and a drained session is no longer mid-turn.
  const facts = captureResumeFacts(instances);

  // From here on no wake is delivered: a session the drain winds down must not
  // wake its owner into a turn this process would only kill in finishDrain. Every
  // wait it ends is carried by the resume text instead.
  instances.suspendWakes();

  // (2) Stop mid-turn instances — the SOFT tier, so completed work and finished
  // tool results survive and no tool_use is left dangling. wss/http stay UP
  // throughout. A stop, not a steer: a wind-down message is silently dropped by a
  // model that cannot take a mid-turn injection, and step 3 waits forever without
  // forcing, so a swallowed steer hangs the restart indefinitely. The explanation
  // the steer used to carry is re-delivered on boot by RESUME_TEXT /
  // buildWorkersResumeText, which is its durable owner either way.
  for (const inst of live) {
    if (inst.status !== 'turn') continue;
    // BOUNDED: nothing here is watching the arm, so an undischargeable one must
    // escalate on its own rather than hold the drain open forever.
    inst.interrupt({ deadlineMs: softInterruptDeadlineMs() })
      .catch((e: unknown) => log.warn?.('resume-restart: interrupt failed', errMsg(e)));
  }

  // (3) Wait for all-idle. Step 2's stop is the armed SOFT tier — it lands at the
  // model's next block edge — and this loop never escalates to FORCED. If the grace
  // window expires, log a warning and keep waiting; repeat every graceMs until
  // all instances finish their turns on their own.
  { let { timedOut, stragglers } = await waitAllIdle(instances, graceMs);
    while (timedOut) {
      log.warn?.(`resume-restart: drain grace (${graceMs}ms) elapsed; ${stragglers.length} straggler(s) still in turn — escalating`);
      for (const inst of live) {
        // Already forced once ⇒ leave it alone; a second control_request buys
        // nothing and the turn is already severed as far as we can sever it.
        // No status check: BOTH tiers are contracted to no-op off-turn
        // (docs/protocol.md → Two-tier interrupt), pinned for the forced tier by
        // tests/instances.test.mjs → 'forced interrupt is a no-op when not in a
        // turn'. Re-adding one here would duplicate a guarantee the callee owns.
        if (inst.turnForceAborted) continue;
        inst.interrupt({ force: true })
          .catch((e: unknown) => log.warn?.('resume-restart: forced interrupt failed', errMsg(e)));
      }
      ({ timedOut, stragglers } = await waitAllIdle(instances, graceMs));
    }
  }

  return facts;
}

// One resume entry per live, prompted session.
export function buildResumeEntries(instances: InstanceManagerLike, { subtreeOf, busy }: ResumeFacts): ResumeEntry[] {
  const entries: ResumeEntry[] = [];
  for (const inst of instances.byId.values()) {
    // LIVE instances only — byId retains recently exited/crashed instances
    // (proc === null), which are not active sessions and must not be
    // resurrected. Idle sessions keep proc alive, so they're still included.
    if (!inst.proc || !inst.sessionId) continue;
    // Never prompted, so there is no transcript to --resume (src/pristine.ts).
    if (inst.pristine) continue;
    const s = inst.summary();
    const group = groupOf(inst);
    const workers = subtreeOf.get(inst.id) ?? [];
    // Background work a stop kills, held by a top-level session itself or
    // anywhere in its spawn subtree. Conducted sessions are left to their chain.
    const lost = group === 'worker' ? [] : [
      ...(holdsBackgroundWork(inst) ? [inst.sessionId] : []),
      ...workers.filter((w) => holdsBackgroundWork(instances.liveForSession(w.sessionId))).map((w) => w.sessionId),
    ];
    // summary() is the loosely-typed InstanceSummary (index signature), so each
    // field the manifest carries is narrowed here at point of use — the values
    // are app-authored and well-formed.
    const entry: ResumeEntry = {
      project: s.project,
      sessionId: s.sessionId as string,
      cwd: s.cwd as string,
      mode: s.mode,
      effort: (s.effort ?? null) as string | null,
      thinking: (s.thinking ?? null) as string | null,
      model: (s.model ?? null) as string | null,
      // Last known context capacity. A FALLBACK for the restored session, used
      // only if the model's custom-model row is gone by the time we boot; live
      // registry resolution wins otherwise.
      contextWindowTokens: (s.contextWindowTokens ?? null) as number | null,
      // Backend id. The session store's recorded backend is the authority on
      // resume; carried here too as belt-and-braces so a restart reconstructs it
      // directly. The model itself rides in `model` above (recovered from jsonl
      // uniformly for every backend).
      backend: (s.backend ?? CLAUDE_BACKEND_ID) as string,
      worktreeName: ((s.worktree as { worktreeName: string | null } | null)?.worktreeName ?? null),
      persistent: !!s.persistent,
      conducted: !!s.conducted,
      debug: !!s.debug,
      title: (s.title ?? null) as string | null,
      firstPrompt: (s.firstPrompt ?? null) as string | null,
      autoApprovePlan: !!s.autoApprovePlan,
      // Carried because losing it is a SILENT downgrade: a conductor that comes
      // back permissive after a restart is unenforced with nothing saying so —
      // exactly the invisible drift playbooks exist to catch.
      playbookEnforcement: normalizePlaybookEnforcement(s.playbookEnforcement),
      group,
      wasBusy: busy.has(inst.id) || lost.length > 0,
      // Pending overage auto-resume (in-memory-only until now). `autoResumeAt`
      // is the already-computed fire DEADLINE (epoch secs = resetsAt+buffer),
      // present iff a resume was armed; `overageStopped` is the stop-resume
      // intent. On boot these re-arm the wall-clock sweep (see
      // restoreFromResumeManifest); a deadline that elapsed during the restart
      // fires on the first post-boot tick. Both falsy for non-overage sessions.
      overageResumeAt: (s.autoResumeAt ?? null) as number | null,
      overageStopped: !!inst.autoStoppedForOverage,
      // Was this session stopped mid-work (full "continue" preamble) vs.
      // queued-only (softened preamble)? Carried so the resume text is right
      // after a restart.
      overageWasStopped: !!inst._overageWasStopped,
      // The third preamble selector (the stop found the session already idle),
      // carried for the same reason: losing it resumes an idle-parked conductor on
      // "continue where you left off", which was never true for it. ADDITIVE — a
      // pre-upgrade manifest reads `false`, which is the TRUE value: the old code
      // prompted an idle conductor instead, so no session was ever idle-parked.
      overageIdleParked: !!inst._overageWasIdleParked,
      // The two conductor resume-text selectors, carried for the same reason as
      // overageWasStopped: losing either delivers a resume prompt missing a fact the
      // conductor must act on — it then waits forever for a wake nothing will send,
      // or never re-drives a worker nothing else will restart.
      //
      // KEY NAME: `overageStoppedWorkers` is the pre-rename spelling of what is now
      // `_overageDroppedCallbacks`. Deliberately NOT renamed — a manifest written
      // before the rename is read during exactly the restart it exists for, and a
      // schema mismatch there is unrecoverable.
      overageStoppedWorkers: !!inst._overageDroppedCallbacks,
      overageUnarmedWorkers: !!inst._overageUnarmedWorkers,
      overageResetsAt: inst._overageResetsAt ?? null,
      // Messages queued during the wait window — carried across the restart so
      // they still flush with the resume once the deadline fires.
      overageQueue: Array.isArray(inst._overageQueue) ? inst._overageQueue : [],
    };
    if (workers.length) entry.workers = workers;
    if (lost.length) entry.backgroundWorkLost = lost;
    entries.push(entry);
  }
  return entries;
}

// Steps 4–6 of the drain, after the caller has torn networking down: write the
// manifest (normal sessions are carried over, not archived), gracefully close
// subprocesses without archiving any session, then remove the running record — the manifest is
// now the clean-stop fact. `clis` (the running recorder's rows) ride in the
// manifest, so a CLI that ignores EOF past the stop's grace is still reaped at
// the next boot. Returns the manifest entries written.
export function finishDrain(
  { instances, log = console }: { instances: InstanceManagerLike; log?: RestartLog },
  facts: DrainState,
  { deliver = 'auto', clis = [] }: { deliver?: Deliver; clis?: RunningCli[] } = {},
): ResumeEntry[] {
  // (4) Build + write the manifest.
  const entries = buildResumeEntries(instances, facts);
  try { writeResumeManifest(entries, { deliver, clis }); }
  catch (e) { log.warn?.('resume-restart: manifest write failed', errMsg(e)); }

  // (5) Gracefully close subprocesses (stdin EOF) WITHOUT archiving normal sessions.
  try { instances.shutdownForResumeSync(); }
  catch (e) { log.warn?.('resume-restart: shutdownForResumeSync error', errMsg(e)); }

  // (6) Drop the record only now. A crash anywhere before this leaves both
  // files: the boot restores from the manifest, and the orphan reap — which
  // reads only the record — still terminates any CLI the stop left running.
  clearRunningRecord();

  return entries;
}

// The drain without networking or a relaunch: drainToIdle, then finishDrain.
export async function drainToManifest({ instances, log = console, graceMs = RESUME_DRAIN_GRACE_MS, deliver = 'auto' }: {
  instances?: InstanceManagerLike | null; log?: RestartLog; graceMs?: number; deliver?: Deliver;
} = {}): Promise<ResumeEntry[]> {
  if (!instances) return [];
  return finishDrain({ instances, log }, await drainToIdle({ instances, log, graceMs }), { deliver });
}

// The restart was refused after drainToIdle: deliver wakes again, and tell every
// live non-worker session that had resumable work — the set a restore would have
// prompted — to carry on. Workers are left to their conductor, as on a restore.
// No manifest is written and nothing is spawned.
export function abortDrain({ instances, log = console }: { instances: InstanceManagerLike; log?: RestartLog }, { busy }: DrainState): void {
  instances.resumeWakes();
  for (const id of busy) {
    const inst = instances.byId.get(id);
    if (!inst?.proc || groupOf(inst) === 'worker') continue;
    inst.prompt(RESTART_ABORTED_TEXT)
      .catch((e: unknown) => log.warn?.('resume-restart: abort notice failed', errMsg(e)));
  }
}

// --- Phase 3: restore on boot (new process) ------------------------------

// Resolve once the instance reaches idle (loadHistory done) or exited/crashed.
function waitForIdleOnce(inst: InstanceLike, { timeoutMs = 60000 }: { timeoutMs?: number } = {}): Promise<string> {
  return waitFor<string>({
    initial: () => {
      if (inst.status === 'idle') return { value: 'idle' };
      if (inst.status === 'exited' || inst.status === 'crashed') return { value: inst.status };
      return null;
    },
    subscribe: (settle) => {
      function fn(s: InstanceSummary): void {
        if (s.status === 'idle' || s.status === 'exited' || s.status === 'crashed') settle(s.status);
      }
      inst.on('status', fn);
      return () => inst.off('status', fn);
    },
    timeoutMs,
    // This one RESOLVES on timeout — the caller treats 'timeout' as a status.
    onTimeout: () => 'timeout',
  });
}

// `source` is what takeRestoreSource read (startResumeLifecycle, src/resumeBoot.ts,
// takes it before the recorder starts); omitted, this takes it itself. A gated
// source stores each busy session's notice in `pending` instead of prompting it.
// Every top-level session is in `pending.restoring` from the synchronous start of
// this call until the loop has settled it, so a Continue meanwhile keeps its
// notice. `wait` is the stagger's sleep (a test holds the loop with it).
export async function restoreFromResumeManifest({ instances, log = console, staggerMs = RESUME_STAGGER_MS, source, pending = null, wait = sleep }: {
  instances?: InstanceManagerLike | null; log?: RestartLog; staggerMs?: number;
  source?: RestoreSource | null; pending?: PendingContinue | null; wait?: (ms: number) => Promise<void>;
} = {}): Promise<{ restored: number }> {
  if (!instances) return { restored: 0 };
  // Read + unlink first: at-most-once, so a crash mid-restore can't loop.
  const src = source === undefined ? takeRestoreSource({ log }) : source;
  if (!src || !src.entries.length) return { restored: 0 };
  // Both files are app-authored (buildResumeEntries writes exactly ResumeEntry),
  // so a single boundary cast narrows the unknown[] read.
  const entries = src.entries as ResumeEntry[];

  const restoring = pending?.restoring;
  for (const e of entries) if (e.group !== 'worker') restoring?.add(e.sessionId);
  let restored = 0;
  try {
    if (entries.some((e) => e.group === 'conductor')) {
      try { await ensureConductProject(); } catch (e) { log.warn?.('resume-restart: ensureConductProject failed', errMsg(e)); }
    }

    let first = true;
    for (const e of entries) {
      // Group 2 — conducted workers: left untouched; the conductor they
      // were spawned under re-spawns them (jsonl preserved); workers of a hand-spawned session stay stopped, resumable from the UI. Skip in the boot loop.
      if (e.group === 'worker') continue;
      if (!first) await wait(staggerMs);
      first = false;
      try {
        // The browser's anchor auto-resume can attach a carried-over session before
        // the staggered restore reaches it. Adopt that instance so the session still
        // gets its restart prompt; this loop is its only sender, so it arrives once.
        // No await separates this check from create()'s synchronous guards, so a
        // resume still in flight is coalesced there rather than refused.
        const attached = instances.liveForSession(e.sessionId);
        if (attached) {
          log.log?.(`resume-restart: ${e.sessionId} was already attached; delivering its restart prompt there`);
          // The browser created it with the defaults; bring it to what the create()
          // below would have set. Debug has no runtime disable, so it is only raised.
          attached.setPlaybookEnforcement(normalizePlaybookEnforcement(e.playbookEnforcement));
          attached.setAutoApprovePlan(!!e.autoApprovePlan);
          if (e.debug) {
            const r = attached.enableDebug();
            if (!r.ok) log.warn?.(`resume-restart: ${e.sessionId}: enabling debug failed: ${r.reason}`);
          }
        }
        const inst = attached ?? await instances.create({
          project: e.project,
          resume: e.sessionId,
          mode: e.mode,
          effort: e.effort,
          thinking: e.thinking,
          model: e.model ?? undefined,
          contextWindowTokens: e.contextWindowTokens ?? undefined,
          backend: e.backend ?? undefined,
          worktree: e.worktreeName ?? null,
          persistent: !!e.persistent,
          conducted: !!e.conducted,
          debug: !!e.debug,
          autoApprovePlan: !!e.autoApprovePlan,
          // Normalized on the READ side, not just where the manifest is written:
          // this file is the one store a PREVIOUS build's retired 'off' can reach
          // this process through, and it is read exactly once before being deleted,
          // which is why absorbing it here needs no migration.
          playbookEnforcement: normalizePlaybookEnforcement(e.playbookEnforcement),
          callerInstanceId: null,
          launchCause: 'restore',
        });
        if (e.title) inst.setTitle(e.title);
        if (e.firstPrompt && !inst.firstPrompt) {
          inst.firstPrompt = e.firstPrompt;
          inst.emit('status', inst.summary());
        }
        const st = await waitForIdleOnce(inst);
        if (st !== 'idle') {
          log.warn?.(`resume-restart: ${e.sessionId} came up '${st}'; skipping resume notification`);
          continue;
        }
        // Re-arm a pending overage auto-resume. Done AFTER the session is live +
        // idle (well past create()→spawn()'s flag-clear, so the clear can't wipe
        // it) and fire-and-forget like the resume notification below — no new
        // await on the boot hot path. armRestored re-inserts the persisted
        // deadline as-is; the wall-clock sweep fires it on the first tick if it
        // already elapsed during the restart.
        // `_inUsageWindowFlow(inst)` guards against re-arming an auto-resume onto a
        // now-exempt (e.g. ollama-only) restored session — such a session never
        // persisted overageStopped:true, so this is belt-and-braces. Its root scoping
        // (card 2026-0212) cannot change the answer here: restored entries are created
        // with `callerInstanceId: null` and worker-group entries are skipped above, so
        // the root of a restored instance is always itself.
        //
        // Policy beats a persisted mark: pending-resume.json records the MARK,
        // settings.json records the POLICY. If the operator moved off stop-resume, the
        // mark is dead — do not revive it (card 2026-0231). Under 'stop-resume'
        // honourMark === e.overageStopped, so behaviour is byte-identical to before.
        const honourMark = !!e.overageStopped && getOnOverageAction() === 'stop-resume';
        if (honourMark && typeof e.overageResumeAt === 'number' && Number.isFinite(e.overageResumeAt) && instances._inUsageWindowFlow(inst)) {
          inst._overageResetsAt = e.overageResetsAt ?? null;
          inst._overageWasStopped = !!e.overageWasStopped; // preamble select survives restart
          inst._overageWasIdleParked = !!e.overageIdleParked;
          inst._overageDroppedCallbacks = !!e.overageStoppedWorkers; // pre-rename key, see the writer
          inst._overageUnarmedWorkers = !!e.overageUnarmedWorkers;
          // Restore queued messages BEFORE re-arming so armRestored's status emit
          // carries the restored queuedCount (badge shows "· N queued").
          inst._overageQueue = Array.isArray(e.overageQueue) ? e.overageQueue : [];
          try { instances._armRestoredAutoResume(inst, (e.overageResumeAt ?? 0) * 1000); }
          catch (err) { log.warn?.('resume-restart: overage re-arm failed', errMsg(err)); }
        }
        // Only notify sessions that had work in flight at the stop (wasBusy).
        // Idle sessions are resurrected silently — they have nothing to resume.
        // Skip overage-stopped sessions: the sweep delivers the resume preamble their
        // restored selectors resolve to (overageResumeKind — an idle-parked entry gets
        // IDLE_PARKED_RESUME_TEXT, not AUTO_RESUME_TEXT) once the window resets, so a
        // notice here would double-prompt. A mark DECLINED by the policy gate above
        // is not skipped: it falls back to the ordinary path, which is exactly what a
        // plain-`stop` session gets.
        if (e.wasBusy !== false && !honourMark) {
          const text = noticeFor(e, src.kind);
          if (src.deliver === 'auto') {
            try { await inst.prompt(text); } catch (err) { log.warn?.('resume-restart: notify failed', errMsg(err)); }
          } else if (pending) {
            pending.add({ sessionId: e.sessionId, kind: src.kind, text, workers: e.workers?.map((w) => w.sessionId) ?? [], at: new Date().toISOString() });
          } else {
            log.warn?.(`resume-restart: ${e.sessionId}: a gated notice with no pending store; dropped`);
          }
        }
        restored++;
      } catch (err) {
        log.warn?.(`resume-restart: failed to resume ${e.sessionId}: ${errMsg(err)}`);
      } finally {
        restoring?.delete(e.sessionId);
      }
    }
  } finally {
    for (const e of entries) restoring?.delete(e.sessionId);
  }
  if (restored > 0) log.log?.(`resume-restart: resumed ${restored} session(s) from previous run`);
  return { restored };
}

// A resume entry (built from summary()/instance fields by buildResumeEntries,
// restored on boot). Fields are typed to the exact shapes it writes.
export interface ResumeEntry {
  project: string;
  sessionId: string;
  cwd: string;
  mode: string;
  effort: string | null;
  thinking: string | null;
  model: string | null;
  contextWindowTokens: number | null;
  backend: string;
  worktreeName: string | null;
  persistent: boolean;
  conducted: boolean;
  debug: boolean;
  title: string | null;
  firstPrompt: string | null;
  autoApprovePlan: boolean;
  playbookEnforcement: PlaybookEnforcement;
  group: 'conductor' | 'worker' | 'other';
  wasBusy: boolean;
  overageResumeAt: number | null;
  overageStopped: boolean;
  overageWasStopped: boolean;
  overageIdleParked: boolean;
  overageStoppedWorkers: boolean;
  overageUnarmedWorkers: boolean;
  overageResetsAt: number | null;
  overageQueue: unknown[];
  workers?: Array<{ project: string; sessionId: string; worktreeName: string | null; parentSessionId?: string | null }>;
  // Sessions (the root's own included) whose background work was live when the
  // manifest was written; present only when non-empty. ADDITIVE — absent on a
  // pre-upgrade manifest, which reads as "none lost".
  backgroundWorkLost?: string[];
}

interface RestartLog {
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  log?: (...args: unknown[]) => void;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
