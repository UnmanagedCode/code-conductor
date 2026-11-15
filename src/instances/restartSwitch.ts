// Instance's model-switch restart and the relaunch window it shares with
// rewind and prune: the live Claude switch and the restart dispatcher, the
// restart's checks, run and rollback, the window's open and close, the segment
// relaunch and its confirmation. Each function runs as the instance
// (`this: Instance`); the class keeps a same-name one-line delegate for each.
// setEffort, _assertBetweenTurns and _wipeForResume stay on Instance.
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import type { Instance } from '../instances.ts';
import type { ModelSwitchState } from '../instanceTypes.ts';
import { sessionFilePath, subAgentDirPath } from '../projects.ts';
import { appendModelSwitch, getModelSwitchesForSegment, type ModelSwitchEntry } from '../sessionStore.ts';
import { hasResumableConversation, readLastLineUuid, modelSwitchEvent } from '../transcript.ts';
import { canonicalizeModel, familyOf, CLAUDE_BACKEND_ID } from '../modelVersions.ts';
import { getBackend } from '../appSettings.ts';
import { resolveBackendLaunch, resolveClaudeBin } from '../claudeLauncher.ts';
import { resolveOnPath } from '../systems/fuse/tierTable.ts';
import type { Platform } from '../platform/index.ts';
import { httpError } from '../httpError.ts';

// `code` of the error a relaunch that was never confirmed rejects with.
export const RELAUNCH_FAILED = 'RELAUNCH_FAILED';

// How a restart switch names a `from` model that was never known — the CLI
// launched with no `--model` runs the account default.
const ACCOUNT_DEFAULT_MODEL_LABEL = '(account default)';

// The FUSE_BACKEND_UNRESOLVED refusal (see its call site in
// InstanceManager._doCreateResolved for why it exists): a remote-system
// session's backend launch command must resolve on cc's own PATH. Also run by
// Instance._beginRestartSwitch for the switch's target backend.
export function assertBackendLaunchResolvable({ backend, model, platform, project, systemId }: {
  backend: string; model: string | null; platform: Platform; project: string; systemId: string;
}): void {
  const backendRec = getBackend(backend);
  const launch = resolveBackendLaunch(backendRec, model, resolveClaudeBin(platform), platform);
  if (!resolveOnPath(launch.command)) {
    throw Object.assign(
      new Error(`FUSE_BACKEND_UNRESOLVED: cannot spawn a worker for project '${project}' on `
        + `system '${systemId}' — backend '${backend}' launches '${launch.command}', `
        + `which does not resolve on cc's own PATH. Template: ${JSON.stringify(backendRec?.template ?? '')}. `
        + `That command is the binary the chroot execs, and an exec failure inside setpriv names `
        + `nothing — so it is refused here instead. Install it on cc's machine, or fix the `
        + `backend's template in Settings → Backends.`),
      { statusCode: 501, code: 'FUSE_BACKEND_UNRESOLVED' },
    );
  }
}

export async function setModel(this: Instance, model: string): Promise<unknown> {
  // Live "Change model" sends a set_model control_request to the RUNNING
  // process, whose endpoint + auth are fixed at launch time — so only a
  // Claude session switching to a Claude model goes live. switchModel routes
  // every other pair to a restart; reaching here off `claude` is a bug.
  if (this.backend !== CLAUDE_BACKEND_ID) {
    throw new Error('setModel is the live Claude path — switchModel restarts every other pair');
  }
  // Before any await, so a mid-turn frame writes no control_request.
  this._assertBetweenTurns('change model');
  // Only a NAME-PREFIX test here, not a catalog allow-list: the one
  // production surface (the WS `model` frame, via switchModel) already
  // refused any Claude id outside the catalog (isKnownBinding). For a direct
  // caller passing an out-of-catalog `claude-*` id, capacity is what keeps it
  // safe: an id the catalog can't price resolves to unknown, and the session
  // keeps the window it already held (see _refreshModelCapabilities).
  if (!model || !familyOf(model)) throw new Error('invalid model');
  // Canonicalize the incoming pick rather than trusting the client to have
  // baked the launch tag: the tag is catalog policy and the client now sends
  // bare version ids. The backend is `claude` — the guard above refused
  // every other.
  const canonical = canonicalizeModel(model, CLAUDE_BACKEND_ID) as string;
  await this._controlRequest({ subtype: 'set_model', model: canonical });
  // Read `from` AFTER the round-trip, not before it: a `message_start` (or a
  // `system/init`) reporting a different model can land inside the await — a
  // turn started during the round-trip, or the CLI's own `/model` — and
  // _trackModel will already have announced THAT switch. A `from` captured
  // before the await names a model the transcript has since moved off, so the
  // notice either skips a step (an M1→M2 notice followed by M1→M3) or repeats
  // one the CLI report already made. `from` is by definition the model
  // immediately preceding the assignment below.
  const from = this.model;
  this.model = canonical;
  // Capacity moves with the model.
  this._refreshModelCapabilities({ carryKnownWindow: true });
  // The picker highlights the tier the session is already on, so re-selecting
  // it must emit no notice and blank no chip. Compare CANONICAL forms: the
  // client sends a bare version id and the catalog may add a launch tag, so a
  // raw-string compare false-positives on every re-select of a tagged model.
  // A null `from` (the model was never known) skips the announce, consistent
  // with _trackModel's silent-adopt branch.
  if (from && from !== canonical) this._announceModelSwitch(from, canonical);
  // The jsonl names the old model until a turn runs on this one, so a cold
  // resume before that reads the record.
  this._recordBackend().catch(() => {});
  this.emit('status', this.summary());
  this._writeSessionMetadata().catch(() => {});
  return this.model;
}

// The WS "Change model" entry point. Claude→Claude goes live through
// setModel. Every other pair — within a substitution backend, or onto another
// backend in either direction — restarts the CLI on the target backend's
// launch template and env (a substitution model is baked into the wrapper's
// argv and the context env at launch, so no control_request can reach it).
// cc does no transcript compatibility check across providers.
// Resolves once a restart is ACCEPTED ({restart:true}); its outcome arrives as
// events. Refusals throw synchronously-checked errors.
export async function switchModel(this: Instance, { model, backend, effort }: { model: string; backend: string; effort: string | null }): Promise<{ restart: boolean }> {
  // Same text and code as spawn()'s own refusal; a removal racing past this
  // check fails there and takes the switch's rollback.
  if (!getBackend(backend)) {
    throw httpError(422, `backend '${backend}' no longer exists — re-add it in Settings → Backends`, { code: 'BACKEND_GONE' });
  }
  if (this.backend === CLAUDE_BACKEND_ID && backend === CLAUDE_BACKEND_ID) {
    await this.setModel(model);
    return { restart: false };
  }
  return this._beginRestartSwitch({ model, backend, effort });
}

// Every check runs and `_mutating` is claimed with no await in between (fork's
// discipline), so two frames cannot both start a restart.
export function _beginRestartSwitch(this: Instance, { model, backend, effort }: { model: string; backend: string; effort: string | null }): { restart: boolean } {
  this._assertNoRotationInFlight();
  if (this._mutating) {
    throw httpError(409, 'another rewind/fork/prune/model switch is in progress');
  }
  if (!this.proc) throw httpError(409, 'not running');
  const busy = (why: string): Error => httpError(409, `cannot switch model ${why} — switching restarts the session`,
    { code: 'SESSION_BUSY' });
  // Also covers a pending steer or interrupt: `interrupting` clears on any exit
  // from 'turn', and a parked steer is flushed (into a new turn) on the
  // microtask after it is queued or after the turn_end it waited for.
  if (this.status !== 'idle') throw busy('during a running turn');
  if (this._activeAgentTasks.size > 0 || this._backgroundJobs.size > 0) {
    throw busy('while background work is running (the restart would kill it)');
  }
  // Canonicalized against the TARGET backend: a Claude target gets its
  // catalog launch tag, a substitution id stays byte-exact.
  const to = canonicalizeModel(model, backend) as string;
  // Re-selecting the running pair: nothing to restart, nothing to record.
  if (!to || (to === this.model && backend === this.backend)) return { restart: false };
  // A remote-system session relaunches inside its chroot, where an
  // unresolvable launch command fails naming nothing — create()'s guard,
  // applied to the target pair.
  const placement = this._redirectPlacement;
  if (placement && !this._launcher.inProcess) {
    assertBackendLaunchResolvable({ backend, model: to, platform: this._platform, project: placement.project, systemId: placement.systemId });
  }
  // A Claude session whose model was never known (a resume with no record
  // and no model in its jsonl, before its first system/init) runs the
  // account default: name it so wherever the switch is persisted or shown —
  // a null `from` would fail the ledger's parse and drop the divider. The
  // rollback restores this.model itself, never this label.
  const from = this.model ?? ACCOUNT_DEFAULT_MODEL_LABEL;
  const fromBackend = this.backend;
  this._mutating = 'model_switch';
  this._modelSwitch = { from, to, fromBackend, toBackend: backend };
  this._modelSwitchFailure = null;
  this.emit('status', this.summary());
  this._modelSwitchRun = this._runRestartSwitch({ from, to, fromBackend, toBackend: backend, effort });
  return { restart: true };
}

// kill → relaunch on `to` → confirm, mirroring rewindToUserMessage's sequence.
// spawn() reads this.backend and this.model for the launch template, the
// argv, the context env and the session record, so setting them before
// launch() is what makes the new pair both the one that runs and the one a
// cold resume comes back on. On failure the session is resumed again on the
// previous pair — it was idle and healthy there a moment ago — and the
// record is rewritten to it. Never rejects.
export async function _runRestartSwitch(this: Instance, { from, to, fromBackend, toBackend, effort }: ModelSwitchState & { effort: string | null }): Promise<void> {
  const prev = {
    backend: this.backend, model: this.model, effort: this.effort,
    contextWindowTokens: this.contextWindowTokens, acceptsMidTurnSteering: this.acceptsMidTurnSteering,
  };
  const publicId = this.sessionId as string;
  const segment = this.backingSessionId as string;
  const crossed = fromBackend !== toBackend;
  const backends = crossed ? { fromBackend, toBackend } : {};
  // How a log line names each side: the model alone, or `<model> on <backend>`
  // when the switch crossed backends.
  const fromName = crossed ? `${from} on ${fromBackend}` : from;
  const toName = crossed ? `${to} on ${toBackend}` : to;
  const entry = (ok: boolean, afterUuid: string | null, { error, cancelled }: { error?: string; cancelled?: true } = {}): ModelSwitchEntry => ({
    id: randomUUID(), at: new Date().toISOString(), segment, afterUuid, from, to, ok,
    ...(error ? { error } : {}), ...(cancelled ? { cancelled } : {}), ...backends,
  });
  // Neither process's exit is an exit cause — that outcome is the switch's.
  // The window's suppression ends at confirmation; `_relaunching` is held for
  // the whole run (see the confirmation below).
  this._beginRelaunch();
  // The process being replaced's terminal latch: spawn() swaps in a new one,
  // which is how the failure path tells "the relaunch was killed" (a user's
  // Terminate) from the `_killing` this run's own kill left behind.
  const replacedLatch = this._procEnded;
  let afterUuid: string | null = null;
  let resumable = false;
  try {
    resumable = await hasResumableConversation({ place: this.transcriptPlace, sessionId: segment });
    // A segment that cannot be resumed is deleted before its `--session-id`
    // relaunch, so any line in it is no anchor: the divider leads (null).
    afterUuid = resumable ? await readLastLineUuid({ place: this.transcriptPlace, sessionId: segment }) : null;
    try {
      await this.kill({ graceMs: 300 });
      this.backend = toBackend;
      this.model = to;
      this.effort = effort;
      // Window and mid-turn steering re-resolve for the new pair; nothing is
      // carried from the old one.
      this._refreshModelCapabilities();
      // The jsonl's newest usage was measured on `from`; against `to`'s window
      // it is a known-wrong reading (prune's rule). Consumed by the relaunch's
      // replay, which only a resume runs.
      this._skipUsageSeed = resumable;
      await this._relaunchSegment(segment, resumable, 'model-switch');
      await this._awaitRelaunchConfirmed();
    } catch (err) {
      const cancelled = this._procEnded !== replacedLatch && this._killing;
      const error = err instanceof Error ? err.message : String(err);
      if (this.proc) await this.kill({ graceMs: 300 });
      this.backend = prev.backend;
      this.model = prev.model;
      this.effort = prev.effort;
      this.contextWindowTokens = prev.contextWindowTokens;
      this.acceptsMidTurnSteering = prev.acceptsMidTurnSteering;
      // A launch that never reached its replay left the flag set; `from`'s
      // own reading is the right one to seed.
      this._skipUsageSeed = false;
      // A launch that failed after spawn() left `to` recorded; one that failed
      // before it never rewrote the record. Either way the record names the
      // previous pair, restored above.
      await this._recordBackend();
      // The attempt's replay may still be running (spawn() does not await it):
      // let it finish before the outcome is recorded or emitted, so its divider
      // follows every replayed line and that replay's own ledger read predates
      // the entry written below.
      await this._replayDone;
      if (cancelled) {
        // A Terminate that landed mid-switch is the user's stop, not a failure:
        // no failure chip, no re-resume. Its divider goes to the ring now (the
        // ring is not rebuilt, so no replay will put it there).
        const stop = entry(false, afterUuid, { cancelled: true });
        await appendModelSwitch(publicId, stop);
        this._emitUi(modelSwitchEvent(stop));
        return;
      }
      await appendModelSwitch(publicId, entry(false, afterUuid, { error }));
      this._modelSwitchFailure = { from, to, fromBackend, toBackend, error };
      try {
        // The ledger already holds the failure, so this replay splices its
        // divider exactly once — no live emit.
        await this._relaunchSegment(segment, resumable, 'model-switch');
        await this._awaitRelaunchConfirmed();
      } catch (again) {
        if (this.proc) await this.kill({ graceMs: 300 }).catch(() => {});
        this._modelSwitchFailure = {
          from, to, fromBackend, toBackend,
          error: `${error}; resuming on ${fromName} also failed: ${again instanceof Error ? again.message : String(again)}`,
        };
      }
      return;
    }
    // Confirmed: the session runs on `to`. Nothing below can make the SWITCH
    // fail — a failure to record or announce it is logged, and the session
    // stays on `to`. Only the exit suppression ends here, ahead of
    // _endRelaunch: an exit from now on records its cause and `launch_failed`
    // (both gate on it). `_relaunching` is held to `finally` with `_mutating`:
    // until the switch settles, an exit must not wake the owner and a resume
    // must not reclaim this instance.
    this._exitSuppressed = false;
    const ok = entry(true, afterUuid);
    const confirmedButFailed = (what: string, err: unknown): void => {
      console.warn(`instances: model switch ${fromName} → ${toName} on ${this.sessionId} is confirmed, but ${what} failed: `
        + `${err instanceof Error ? err.message : String(err)}`);
    };
    try {
      await appendModelSwitch(publicId, ok);
    } catch (err) {
      confirmedButFailed('recording it in the session ledger (its transcript divider will not survive a replay)', err);
    }
    try {
      this._dropContextReading();
      this._emitUi(modelSwitchEvent(ok));
    } catch (err) {
      confirmedButFailed('announcing it', err);
    }
  } catch (err) {
    // Only the store reads/writes of the failure path and the pre-kill reads
    // land here; the session's state is whatever the step before left, and the
    // failure is surfaced, not swallowed.
    const error = err instanceof Error ? err.message : String(err);
    this._modelSwitchFailure = { from, to, fromBackend, toBackend, error };
    console.warn(`instances: model switch ${fromName} → ${toName} on ${this.sessionId} failed: ${error}`);
  } finally {
    this._endMutation();
    this._modelSwitch = null;
    this._endRelaunch();
  }
}

// THE relaunch window, shared by rewind, prune and the restart model switch:
// opened immediately before the kill, closed by _endRelaunch once the
// relaunch is confirmed (_awaitRelaunchConfirmed) or abandoned. Inside it no
// exit archives a normal session and no status emit (the kill's exit, the
// attempt's own crash, launch()'s _hydrateAwaitingUser) drops it from the
// manager — the manager's exit drop reads `_exitSuppressed`.
export function _beginRelaunch(this: Instance): void {
  this._exitSuppressed = true;
  this._relaunching = true;
}

// Still suppressed ⇒ the relaunch was never confirmed, so any exit it ended in
// was suppressed: archive a normal session left without a process here, as
// its exit would have (the status emit then lets the manager drop it).
export function _endRelaunch(this: Instance): void {
  const suppressed = this._exitSuppressed;
  this._exitSuppressed = false;
  this._relaunching = false;
  if (suppressed && !this.proc && !this.persistent) this.emit('exit_archive', this._retireOnExit());
  this.emit('status', this.summary());
}

// Wipe and relaunch `segment` on the current this.model. A segment with no
// conversation has nothing to `--resume` (the CLI would exit): relaunch under
// the same id with `--session-id`, after removing the stub the CLI would
// refuse that id over and any stale sub-agent dir.
export async function _relaunchSegment(this: Instance, segment: string, resumable: boolean, cause: 'rewind' | 'model-switch', wipeExtra: Record<string, unknown> = {}): Promise<void> {
  this._wipeForResume(wipeExtra);
  if (resumable) { await this.launch({ resume: segment, cause }); return; }
  await fsp.rm(sessionFilePath(this.transcriptPlace, segment), { force: true });
  await fsp.rm(subAgentDirPath(this.transcriptPlace, segment), { recursive: true, force: true });
  await this._seedUnanchoredSwitches(segment);
  await this.launch({ cause });
}

// After a wipe that NO replay follows (`launch({})`): put the segment's
// null-anchored ledger dividers into the ring as the replay would have. The
// archive (loadPersistedTranscript) leads with them, so without this the ring
// lacks them and its seq space runs one short of the archive's — a false
// `history_gap` and an event dropped at the archive/ring cut.
export async function _seedUnanchoredSwitches(this: Instance, segment: string): Promise<void> {
  for (const e of await getModelSwitchesForSegment(segment)) {
    if (e.afterUuid === null) this._emitUi(modelSwitchEvent(e, { replayed: true }), { replayed: true });
  }
}

// Resolves once the relaunched process has come up idle AND outlived
// `_relaunchGraceMs`; rejects (RELAUNCH_FAILED, 500) with _lastExitCause() if
// it ends first, or when it has not come up idle by `_relaunchIdleDeadlineMs`.
export function _awaitRelaunchConfirmed(this: Instance): Promise<void> {
  const ended = this._procEnded;
  return new Promise<void>((resolve, reject) => {
    let graceDone = false;
    let done = false;
    const finish = (cause: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      this.off('status', onStatus);
      if (cause !== null) reject(httpError(500, cause, { code: RELAUNCH_FAILED })); else resolve();
    };
    const onStatus = (): void => { if (graceDone && this.proc && this.status === 'idle') finish(null); };
    const timer = setTimeout(() => { graceDone = true; onStatus(); }, this._relaunchGraceMs);
    const idleMs = this._relaunchIdleDeadlineMs;
    const deadline = setTimeout(() => finish(`the relaunched CLI did not come up idle within ${idleMs}ms`), idleMs);
    this.on('status', onStatus);
    void ended.then(async () => { if (!done) finish(await this._lastExitCause()); });
  });
}

// Why the last launch ended: its last stderr line, else its spawn_error, else
// its exit code/signal.
export async function _lastExitCause(this: Instance): Promise<string> {
  const r = this._lastExitReport;
  if (!r) return 'the relaunched CLI exited';
  const line = (await r.stderr).split('\n').map(l => l.trim()).filter(Boolean).at(-1);
  return line ?? r.spawnError ?? `the relaunched CLI exited code=${r.code} signal=${r.signal}`;
}
