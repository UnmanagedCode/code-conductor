// Graceful "Resume after restart".
//
// Two halves:
//   Phase 1+2 (drainAndScheduleRestart) — run in the OLD process when the user
//   picks "Resume after restart": wind every live turn down to idle (networking
//   stays UP so in-flight hook round-trips finish and the UI shows progress),
//   then tear down networking, write the resume manifest (NO temp wipe — temps
//   are carried over), SIGKILL subprocesses without deleting their jsonl, and
//   spawn the replacement.
//   Phase 3 (restoreFromResumeManifest) — run in the NEW process on boot:
//   re-spawn (`--resume`) the carried-over sessions, staggered, splitting them
//   into conductors / conducted workers / others, and notify each so work
//   resumes. Conducted workers are NOT resumed here — their conductor re-spawns
//   them (their jsonl was preserved for exactly that).

import { spawnReplacementAndExit } from './restart.js';
import {
  writeResumeManifest,
  readResumeManifest,
  clearResumeManifest,
} from './resumeManifest.js';
import { CONDUCT_PROJECT_NAME, ensureConductProject } from './conduct.js';

// Wait-and-retry grace: after wind-down, wait this long (60 s) for every live
// instance to leave its turn on its own. If the grace elapses, log a warning
// and keep waiting (re-arming the grace) — it never force-interrupts. If an
// agent is wedged and won't finish its turn, the user can manually interrupt
// that turn (e.g. via the UI's interrupt control) to unblock the drain.
export const RESUME_DRAIN_GRACE_MS = 60000;
// Gap between staggered respawns on boot — N concurrent claude spawns is a
// resource spike on Termux/Android.
export const RESUME_STAGGER_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Message texts -------------------------------------------------------

export const WIND_DOWN_TEXT =
  '⚙️ CodeConductor is about to restart to apply changes. Stop now — do not ' +
  'start or continue any tool calls, and end your current turn immediately ' +
  'without replying. Your session is being preserved; you will be sent a ' +
  'message to resume once the restart completes. Nothing is lost.';

export const WIND_DOWN_TEXT_CONDUCTOR =
  '⚙️ CodeConductor is about to restart to apply changes. Stop now — do not ' +
  'send any further messages to your workers, and end your current turn ' +
  'immediately without replying. Every worker you are conducting has been sent ' +
  'the same stop-and-wait notice, so do not message them. Idle callbacks will ' +
  'not fire across the restart. Your session and all your workers\' sessions ' +
  'are being preserved; you will be sent a message to resume (and to resume ' +
  'your workers) once the restart completes.';

export const RESUME_TEXT =
  '✅ CodeConductor has restarted successfully. You may resume activity now — ' +
  'pick up wherever you left off before the restart.';

export function buildConductorResumeText(workers = []) {
  const lines = (Array.isArray(workers) ? workers : []).map((w) => {
    const wt = w?.worktreeName ? `worktree \`${w.worktreeName}\`` : '(no worktree)';
    return `- project \`${w?.project}\`, sessionId \`${w?.sessionId}\`, ${wt}`;
  });
  const list = lines.length ? lines.join('\n') : '- (none recorded)';
  return (
    '✅ CodeConductor has restarted successfully. You may resume activity now, ' +
    'and you should resume conducting your workers. Idle callbacks from before ' +
    'the restart were dropped, but dispatch-and-wake re-arms itself: your next ' +
    'send_prompt / approve_plan / reject_plan / answer_question to each worker ' +
    'auto-subscribes to its idle callback again, so just resume conducting — no ' +
    'manual re-subscribe step is needed. (A standalone subscribe_to_idle is ' +
    'only for re-arming without sending a new prompt.)\n\n' +
    'Your previously-conducted workers are listed below; each session has been ' +
    'preserved and can be resumed with `mcp__code-conductor__spawn_instance` ' +
    'using the matching `resume` sessionId and `worktree`:\n' +
    list
  );
}

// --- Phase 1+2: drain + restart (old process) ----------------------------

// Classify a live instance into a resume group.
function groupOf(inst) {
  if (inst.conducted) return 'worker';
  if (inst.project === CONDUCT_PROJECT_NAME) return 'conductor';
  return 'other';
}

// Resolve once every live instance has left `turn` (idle/exited/crashed), or on
// the grace timeout. Returns { timedOut, stragglers } where stragglers are the
// instances still mid-turn at timeout.
function waitAllIdle(instances, graceMs) {
  const live = [...instances.byId.values()].filter((i) => i.proc);
  const pending = new Set(live.filter((i) => i.status === 'turn'));
  if (pending.size === 0) return Promise.resolve({ timedOut: false, stragglers: [] });

  return new Promise((resolve) => {
    const listeners = new Map();
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      for (const [inst, fn] of listeners) inst.off('status', fn);
    };
    for (const inst of pending) {
      const fn = (s) => {
        if (s.status === 'turn' || s.status === 'spawning') return;
        pending.delete(inst);
        if (pending.size === 0) {
          cleanup();
          resolve({ timedOut: false, stragglers: [] });
        }
      };
      listeners.set(inst, fn);
      inst.on('status', fn);
    }
    timer = setTimeout(() => {
      cleanup();
      resolve({ timedOut: true, stragglers: [...pending] });
    }, graceMs);
  });
}

// Steps 1–6 of the drain: wind down, wait-for-idle (graceful — no force),
// tear down networking, write the manifest (NO temp wipe), gracefully close
// subprocesses without deleting temp jsonl. Returns the manifest entries
// written. Split out from drainAndScheduleRestart so tests can exercise it
// without the process-exiting spawn. Pass server/wss null to skip networking
// teardown.
export async function drainToManifest({ server, wss, instances, log = console, graceMs = RESUME_DRAIN_GRACE_MS } = {}) {
  if (!instances) return [];
  const live = [...instances.byId.values()].filter((i) => i.proc);

  // (1) Snapshot conductor→worker map BEFORE draining — instance ids become
  // meaningless across the restart, so capture the workers now.
  const workersByConductor = new Map();
  for (const inst of live) {
    if (groupOf(inst) === 'conductor') {
      workersByConductor.set(inst.id, instances.conductedWorkersOf(inst.id));
    }
  }

  // Snapshot which instances had resumable work BEFORE wind-down so the manifest
  // can distinguish sessions that need a resume prompt from ones that were idle
  // with nothing pending (resurrected silently). "Resumable work" = mid-turn OR
  // idle-but-parked on a pending OUTGOING idle-subscription, i.e. a conductor
  // that ended its turn and is waiting on a worker (isIdleCaller — the caller
  // side, NOT hasIdleSubscriber which is the target side). Such a conductor has
  // durable re-conduct work (re-spawn workers, re-establish subscriptions) even
  // though it's idle, so it must still receive its restart prompt.
  const busyAtDrain = new Set(
    live.filter((i) => i.status === 'turn' || instances.isIdleCaller(i.sessionId)).map((i) => i.id),
  );

  // (2) Wind down mid-turn instances. wss/http stay UP throughout.
  for (const inst of live) {
    if (inst.status !== 'turn') continue;
    const text = groupOf(inst) === 'conductor' ? WIND_DOWN_TEXT_CONDUCTOR : WIND_DOWN_TEXT;
    try { inst.windDown(text); } catch (e) { log.warn?.('resume-restart: windDown failed', e?.message); }
  }

  // (3) Wait for all-idle — gracefully, no forced interrupt ever. If the grace
  // window expires, log a warning and keep waiting; repeat every graceMs until
  // all instances finish their turns on their own.
  { let { timedOut, stragglers } = await waitAllIdle(instances, graceMs);
    while (timedOut) {
      log.warn?.(`resume-restart: drain grace (${graceMs}ms) elapsed; ${stragglers.length} straggler(s) still in turn — waiting without forcing`);
      ({ timedOut, stragglers } = await waitAllIdle(instances, graceMs));
    }
  }

  // (4) NOW tear down networking.
  if (wss) {
    for (const ws of wss.clients) { try { ws.terminate(); } catch { /* ignore */ } }
    try { wss.close(); } catch { /* ignore */ }
  }
  if (server) { try { server.close(); } catch { /* ignore */ } }

  // (5) Build + write the manifest. NO writePendingTempCleanup / shutdownTempSync
  // — carrying temps over is scoped to this path only.
  const entries = [];
  for (const inst of instances.byId.values()) {
    // LIVE instances only — byId retains recently exited/crashed instances
    // (proc === null), which are not active sessions and must not be
    // resurrected. Idle sessions keep proc alive, so they're still included.
    if (!inst.proc || !inst.sessionId) continue;
    const s = inst.summary();
    const group = groupOf(inst);
    const entry = {
      project: s.project,
      sessionId: s.sessionId,
      cwd: s.cwd,
      mode: s.mode,
      effort: s.effort,
      thinking: s.thinking,
      model: s.model ?? null,
      worktreeName: s.worktree?.worktreeName ?? null,
      temp: !!s.temp,
      conducted: !!s.conducted,
      debug: !!s.debug,
      title: s.title ?? null,
      firstPrompt: s.firstPrompt ?? null,
      autoApprovePlan: !!s.autoApprovePlan,
      group,
      wasBusy: busyAtDrain.has(inst.id),
      // Pending overage auto-resume (in-memory-only until now). `autoResumeAt`
      // is the already-computed fire DEADLINE (epoch secs = resetsAt+buffer),
      // present iff a resume was armed; `overageStopped` is the stop-resume
      // intent. On boot these re-arm the wall-clock sweep (see
      // restoreFromResumeManifest); a deadline that elapsed during the restart
      // fires on the first post-boot tick. Both falsy for non-overage sessions.
      overageResumeAt: s.autoResumeAt ?? null,
      overageStopped: !!inst.autoStoppedForOverage,
      // Was this session stopped mid-work (full "continue" preamble) vs.
      // queued-only (softened preamble)? Carried so the resume text is right
      // after a restart.
      overageWasStopped: !!inst._overageWasStopped,
      overageResetsAt: inst._overageResetsAt ?? null,
      // Messages queued during the wait window — carried across the restart so
      // they still flush with the resume once the deadline fires.
      overageQueue: Array.isArray(inst._overageQueue) ? inst._overageQueue : [],
    };
    if (group === 'conductor') entry.workers = workersByConductor.get(inst.id) ?? [];
    entries.push(entry);
  }
  try { writeResumeManifest(entries); }
  catch (e) { log.warn?.('resume-restart: manifest write failed', e?.message); }

  // (6) Gracefully close subprocesses (stdin EOF) WITHOUT wiping temp jsonl.
  try { instances.shutdownForResumeSync(); }
  catch (e) { log.warn?.('resume-restart: shutdownForResumeSync error', e?.message); }

  return entries;
}

export async function drainAndScheduleRestart({ server, wss, instances, log = console, graceMs = RESUME_DRAIN_GRACE_MS } = {}) {
  try {
    await drainToManifest({ server, wss, instances, log, graceMs });
  } catch (e) {
    log.error?.('resume-restart: drain failed; restarting anyway', e);
  }
  // (7) Respawn + exit (shared with the normal restart path).
  spawnReplacementAndExit({ log });
}

// --- Phase 3: restore on boot (new process) ------------------------------

// Resolve once the instance reaches idle (loadHistory done) or exited/crashed.
function waitForIdleOnce(inst, { timeoutMs = 60000 } = {}) {
  if (inst.status === 'idle') return Promise.resolve('idle');
  if (inst.status === 'exited' || inst.status === 'crashed') return Promise.resolve(inst.status);
  return new Promise((resolve) => {
    let timer = null;
    const done = (st) => { if (timer) clearTimeout(timer); inst.off('status', fn); resolve(st); };
    const fn = (s) => {
      if (s.status === 'idle' || s.status === 'exited' || s.status === 'crashed') done(s.status);
    };
    inst.on('status', fn);
    timer = setTimeout(() => done('timeout'), timeoutMs);
  });
}

export async function restoreFromResumeManifest({ instances, log = console, staggerMs = RESUME_STAGGER_MS } = {}) {
  if (!instances) return { restored: 0 };
  // Read + unlink first: at-most-once, so a crash mid-restore can't loop.
  const { instances: entries } = readResumeManifest({ log });
  clearResumeManifest();
  if (!entries.length) return { restored: 0 };

  if (entries.some((e) => e.group === 'conductor')) {
    try { await ensureConductProject(); } catch (e) { log.warn?.('resume-restart: ensureConductProject failed', e?.message); }
  }

  let restored = 0;
  let first = true;
  for (const e of entries) {
    // Group 2 — conducted workers: left untouched; their conductor re-spawns
    // them (jsonl preserved). Skip in the boot loop.
    if (e.group === 'worker') continue;
    if (!first) await sleep(staggerMs);
    first = false;
    try {
      const inst = await instances.create({
        project: e.project,
        resume: e.sessionId,
        mode: e.mode,
        effort: e.effort,
        thinking: e.thinking,
        model: e.model ?? undefined,
        worktree: e.worktreeName ?? null,
        temp: !!e.temp,
        conducted: !!e.conducted,
        debug: !!e.debug,
        autoApprovePlan: !!e.autoApprovePlan,
        callerInstanceId: null,
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
      if (e.overageStopped && Number.isFinite(e.overageResumeAt)) {
        inst._overageResetsAt = e.overageResetsAt ?? null;
        inst._overageWasStopped = !!e.overageWasStopped; // preamble select survives restart
        // Restore queued messages BEFORE re-arming so armRestored's status emit
        // carries the restored queuedCount (badge shows "· N queued").
        inst._overageQueue = Array.isArray(e.overageQueue) ? e.overageQueue : [];
        try { instances._armRestoredAutoResume(inst, e.overageResumeAt * 1000); }
        catch (err) { log.warn?.('resume-restart: overage re-arm failed', err?.message); }
      }
      // Only re-prompt sessions that were mid-turn when the drain began.
      // Idle sessions are resurrected silently — they have nothing to resume.
      // Skip overage-stopped sessions: the sweep delivers AUTO_RESUME_TEXT once
      // the window resets, so a RESUME_TEXT here would double-prompt.
      if (e.wasBusy !== false && !e.overageStopped) {
        const text = e.group === 'conductor' ? buildConductorResumeText(e.workers) : RESUME_TEXT;
        try { await inst.prompt(text); } catch (err) { log.warn?.('resume-restart: notify failed', err?.message); }
      }
      restored++;
    } catch (err) {
      log.warn?.(`resume-restart: failed to resume ${e.sessionId}: ${err?.message}`);
    }
  }
  if (restored > 0) log.log?.(`resume-restart: resumed ${restored} session(s) from previous run`);
  return { restored };
}
