// Instance's rewind and boundary-fork paths: rewind to a prompt, undo or fork
// at a renewal divider, and the fork tail, snapshot read, source-pin checks and
// live→file ordinal the forks share. Each function runs as the instance
// (`this: Instance`); the class keeps a same-name one-line delegate for each.
// The fork entry points forkAtUserMessage/forkAtTip/_claimForkSource stay on Instance.
import { promises as fsp } from 'node:fs';
import type { ForkPin, Instance } from '../instances.ts';
import type { CreateInstanceInput } from '../instanceTypes.ts';
import { sessionFilePath, subAgentDirPath, writeFileAtomic, type TranscriptPlacement } from '../projects.ts';
import { segmentsFor, chainFor, undoRenewal, type LineageSegment } from '../sessionLineage.ts';
import { getTitle as getSessionTitle, reanchorModelSwitches } from '../sessionStore.ts';
import { renewalBoundaryAt, renewalCut } from '../renewalBoundary.ts';
import { applySessionTitle, forkTitle } from '../sessionTitles.ts';
import { hasResumableConversation } from '../transcript.ts';
import { completeLinesOf, forkSessionAtUserMessage, forkSessionWhole, truncateSessionAtUserMessage, verifyUserPrompt } from '../sessionEdit.ts';
import { currentSegmentScope, measureSegmentEchoOffset, type SeqEvent } from '../eventArchive.ts';
import { httpError } from '../httpError.ts';
import { errCode } from '../../shared/basics.ts';

// How long a fork waits for the clicked prompt's line to reach the transcript
// (Instance.forkAtUserMessage), and how often it re-checks the file's size.
// Sized against the CLI's enqueue → prompt-line gap for prompts received while
// idle, measured over the `queue-operation` enqueue `timestamp` and the following
// prompt line's `timestamp` in 1407 local session jsonls: p50 25 ms, p99 267 ms,
// max 875 ms. A steer sent mid-turn is written only when the turn drains its
// queue, so it usually exceeds this and gets PROMPT_NOT_PERSISTED.
export const FORK_PERSIST_WAIT_MS = 2000;
export const FORK_PERSIST_POLL_MS = 50;

// Message prefix of the 409 fork/rewind refuse with when a live bubble ordinal
// cannot be placed in the rotated backing file (Instance._fileOrdinalFor).
export const PROMPT_UNRESOLVED = 'prompt position unresolved';

// `code` on the 409 a renewal undo refuses with when the divider is not the one
// directly above the current segment.
export const RENEWAL_NOT_LATEST = 'RENEWAL_NOT_LATEST';
// `code` on the 409 a rewind/fork at a renewal divider refuses with when the
// pre-renewal segment's transcript is gone.
export const PRE_RENEWAL_GONE = 'PRE_RENEWAL_GONE';

function preRenewalGone(): Error {
  return httpError(409, 'the transcript from before this renewal is no longer on disk', { code: PRE_RENEWAL_GONE });
}

// A transcript's bytes, or null when the file is gone.
async function readTranscriptOrNull(file: string): Promise<Buffer | null> {
  try { return await fsp.readFile(file); }
  catch (e) {
    if (errCode(e) === 'ENOENT') return null;
    throw e;
  }
}

export function promptUnresolved(): never {
  throw httpError(409, `${PROMPT_UNRESOLVED}: can't place this prompt in the current transcript yet — retry once the turn has finished`);
}

// `code` (and message prefix) of the 409 a fork refuses with when the source's
// backing file, segment or process changed while it was waiting.
export const FORK_SOURCE_CHANGED = 'FORK_SOURCE_CHANGED';

// Rewind this session to before the Nth user prompt (0-indexed). Kills
// the live subprocess, truncates the persisted jsonl, wipes the in-memory
// ring buffer, broadcasts a `snapshot_reset` so subscribed clients clear
// their conversation view, then relaunches the session so the
// freshly-truncated history is replayed into the ring — and resolves only
// once that relaunch is confirmed (_awaitRelaunchConfirmed).
//
// `userMessageIndex` is the bubble's live ordinal and `expectedText` its text;
// both are checked against the file BEFORE the kill, so a refusal leaves the
// process, the ring and the file untouched.
//
// A relaunch that is never confirmed rejects with nothing left running, and
// gets no fail-safe: the truncation is the state the user asked for, and the
// failure (a missing backend, a CLI dying at startup) would recur on a retry.
// The relaunch window then archives and drops a normal session; a persistent
// one stays registered, dead and resumable.
//
// Returns { droppedText }: the prompt text of the dropped user message,
// so the frontend can prefill it back into the composer.
export async function rewindToUserMessage(this: Instance, userMessageIndex: number, expectedText: string): Promise<{ droppedText: string }> {
  // Same interlock as pruneSession, for the same reason: a rewind kills the proc
  // and rewrites the transcript, so one landing inside a renewal's reseed window
  // makes the reseed 409 and loses the handoff summary.
  this._assertNoRotationInFlight();
  if (this._mutating) {
    throw httpError(409, 'another rewind/fork is in progress');
  }
  const backingId = this.backingSessionId;
  if (!backingId) {
    throw httpError(400, 'no sessionId — instance has not yet received a turn');
  }
  if (this.status === 'turn') {
    throw httpError(409, 'cannot rewind during a running turn — interrupt first');
  }
  this._mutating = 'rewind';
  let windowOpen = false;
  let rewound = false;
  try {
    // prompt() refuses while `_mutating` is set, so no prompt lands between
    // this check and the kill — nor before the relaunch is confirmed.
    // setEffort does not check it: an `/effort` sent in that window is
    // persisted after the target and so falls in the truncated tail — and
    // truncate re-checks the target itself.
    const fileIdx = await this._fileOrdinalFor(userMessageIndex) ?? promptUnresolved();
    await verifyUserPrompt({ place: this.transcriptPlace, sessionId: backingId, userMessageIndex: fileIdx, expectedText });
    // Deliberately NOT beginRotation: this is not a `renew`/`prune` rotation
    // (no reason string, no rotation_complete event, no interaction with
    // _assertNoRotationInFlight's messaging).
    this._beginRelaunch();
    windowOpen = true;
    // Kill the subprocess first so the CLI can't flush a stale tail
    // into the jsonl mid-truncate.
    if (this.proc) await this.kill({ graceMs: 300 });

    const result = await truncateSessionAtUserMessage({
      place: this.transcriptPlace,
      sessionId: backingId,
      userMessageIndex: fileIdx,
      expectedText,
      mode: this.mode,
    });
    rewound = true;

    // A model switch anchored inside the dropped tail still happened — the
    // session stays on its model — so its divider moves to the cut rather
    // than drifting past the turns that follow.
    if (this.sessionId) {
      await reanchorModelSwitches(this.sessionId, backingId, result.survivingUuids, result.lastSurvivingUuid);
    }

    // Fresh vs resume is chosen by resumability (isResumableLine), not line
    // count. `droppedText` rides on the wipe's snapshot_reset frame so the
    // client can prefill the composer without racing the HTTP response.
    await this._relaunchSegment(backingId, result.resumable, 'rewind', { droppedText: result.droppedText });
    await this._awaitRelaunchConfirmed();

    return { droppedText: result.droppedText };
  } catch (e) {
    if (!windowOpen) throw e;
    // Reap a live-but-unconfirmed relaunch, and any pre-spawn mount scaffolding.
    await this.kill({ graceMs: 300 }).catch(() => {});
    if (!rewound) throw e;
    const err = e as { statusCode?: unknown; code?: unknown; message?: unknown };
    const refusal = typeof err?.statusCode === 'number';
    throw httpError(
      refusal ? err.statusCode as number : 500,
      `the transcript was rewound, but the session failed to relaunch: ${typeof err?.message === 'string' ? err.message : String(e)}`,
      refusal && typeof err.code === 'string' ? { code: err.code } : {},
    );
  } finally {
    this._endMutation();
    if (windowOpen) this._endRelaunch();
  }
}

// Undo the renewal at the divider labelled `label` (a `segment_seam`'s
// segmentId), as if it had failed: the pre-renewal segment, cut before the
// turn that requested the renewal (renewalCut; a typed `/clear` is restored
// whole), becomes the live backing segment again — un-archived, `persistent`
// restored — and the post-renewal run leaves the chain with its files. Only
// the divider directly above the current segment can be undone. The same
// kill → rewrite → wipe → relaunch sequence as rewindToUserMessage, logged
// with cause `rewind`; nothing is prefilled, since the dropped prompt is the
// renewal request and resending it would ask for a renewal again.
//
// Every refusal comes before the kill. A failure before the record is
// rewritten puts the pre segment's file back to its exact pre-undo bytes and
// relaunches the untouched post-renewal segment — so a retry cuts at the same
// place. Only the truncate and the record write sit in that window; the
// model-switch re-anchor runs after the commit, so nothing else needs undoing.
// A failure after the commit gets no fail-safe, as with rewind.
export async function rewindAcrossRenewal(this: Instance, label: string): Promise<{ droppedText: null }> {
  this._assertNoRotationInFlight();
  if (this._mutating) {
    throw httpError(409, 'another rewind/fork/prune is in progress');
  }
  const liveId = this.backingSessionId;
  const publicId = this.sessionId;
  if (!liveId || !publicId) {
    throw httpError(400, 'no sessionId — instance has not yet received a turn');
  }
  if (this.status === 'turn') {
    throw httpError(409, 'cannot rewind during a running turn — interrupt first');
  }
  this._mutating = 'rewind';
  let windowOpen = false;
  let committed = false;
  let preFile: string | null = null;
  let preBytes: Buffer | null = null;
  let preTouched = false;
  let relaunchStarted = false;
  try {
    const place = this.transcriptPlace;
    const b = renewalBoundaryAt(await chainFor(publicId), label);
    // The post run always reaches the chain's end, so an older divider's run
    // holds a later renewal; the latest one's holds only its prune copies.
    if (b.post.slice(1).some(s => s.reason === 'renew') || (b.post.at(-1) as LineageSegment).id !== liveId) {
      throw httpError(409, 'only the most recent renewal can be undone — fork from this divider instead',
        { code: RENEWAL_NOT_LATEST });
    }
    const pre = b.pre.id;
    preFile = sessionFilePath(place, pre);
    preBytes = b.pre.dropped ? null : await readTranscriptOrNull(preFile);
    if (preBytes === null) throw preRenewalGone();
    const postText = (await readTranscriptOrNull(sessionFilePath(place, b.post[0].id)))?.toString('utf8') ?? '';
    const cut = renewalCut(preBytes.toString('utf8'), postText);

    this._beginRelaunch();
    windowOpen = true;
    if (this.proc) await this.kill({ graceMs: 300 });

    let resumable: boolean;
    let truncated: Awaited<ReturnType<typeof truncateSessionAtUserMessage>> | null = null;
    if (cut) {
      preTouched = true;
      truncated = await truncateSessionAtUserMessage({
        place, sessionId: pre, userMessageIndex: cut.userMessageIndex, expectedText: cut.text, mode: this.mode,
      });
      resumable = truncated.resumable;
    } else {
      resumable = await hasResumableConversation({ place, sessionId: pre });
    }
    await undoRenewal(publicId, { pre, post: b.post.map(s => s.id), persistent: this.persistent });
    committed = true;

    // In memory first, so no reader sees the deleted post segment as live.
    // Set explicitly: a non-resumable relaunch starts `--session-id` from it.
    this.backingSessionId = pre;
    this._segments = (await segmentsFor(publicId)).map(s => s.id);
    this.lastRotatedAt = null;
    this.rotationReason = null;
    // The post run is discarded with its files. A failed removal leaves an
    // orphan file no record names: warned, not fatal — the undo has landed.
    for (const s of b.post) {
      for (const target of [sessionFilePath(place, s.id), subAgentDirPath(place, s.id)]) {
        await fsp.rm(target, { recursive: true, force: true })
          .catch((e: unknown) => console.warn(`instances: could not remove ${target}: ${(e as Error).message}`));
      }
    }
    if (truncated) await reanchorModelSwitches(publicId, pre, truncated.survivingUuids, truncated.lastSurvivingUuid);
    relaunchStarted = true;
    await this._relaunchSegment(pre, resumable, 'rewind');
    await this._awaitRelaunchConfirmed();
    return { droppedText: null };
  } catch (e) {
    if (!windowOpen) throw e;
    await this.kill({ graceMs: 300 }).catch(() => {});
    if (!committed) {
      if (preTouched && preFile && preBytes) {
        await writeFileAtomic(preFile, preBytes)
          .catch((re: unknown) => console.warn(`instances: could not restore ${preFile}: ${(re as Error).message}`));
      }
      // The record still names the post-renewal segment, untouched: run it again.
      this._wipeForResume();
      try {
        await this.launch({ resume: liveId, cause: 'rewind' });
        await this._awaitRelaunchConfirmed();
      } catch {
        await this.kill({ graceMs: 300 }).catch(() => {});
      }
      throw e;
    }
    const err = e as { statusCode?: unknown; code?: unknown; message?: unknown };
    const refusal = typeof err?.statusCode === 'number';
    throw httpError(
      refusal ? err.statusCode as number : 500,
      `the renewal was undone, but ${relaunchStarted ? 'the session failed to relaunch' : 'finishing it failed'}: `
        + (typeof err?.message === 'string' ? err.message : String(e)),
      refusal && typeof err.code === 'string' ? { code: err.code } : {},
    );
  } finally {
    this._endMutation();
    if (windowOpen) this._endRelaunch();
  }
}

// Fork from before the renewal at the divider labelled `label`: a new session
// holding the pre-renewal segment cut as rewindAcrossRenewal cuts it (whole
// for a typed `/clear`), leaving THIS session untouched. Any divider, not just
// the latest. The fork is one segment: its scroll-back stops at the pre
// segment.
export async function forkAtRenewal(this: Instance, label: string): Promise<{ newSessionId: string; createArgs: CreateInstanceInput }> {
  // Allowed mid-turn, like a fork from a message, and with no post-read
  // turn-start re-check (forkAtTip's): that guards a snapshot of the LIVE file,
  // while this reads a retired segment no turn writes. Its only writer,
  // rewindAcrossRenewal, is excluded by this `_mutating` claim. The pin is
  // unused for the same reason.
  this._claimForkSource({ requireIdle: false });
  let pre: string;
  let newSessionId: string;
  try {
    const place = this.transcriptPlace;
    const b = renewalBoundaryAt(await chainFor(this.sessionId ?? ''), label);
    pre = b.pre.id;
    const raw = b.pre.dropped ? null : await readTranscriptOrNull(sessionFilePath(place, pre));
    if (raw === null) throw preRenewalGone();
    const preText = completeLinesOf(raw.toString('utf8'));
    const postText = (await readTranscriptOrNull(sessionFilePath(place, b.post[0].id)))?.toString('utf8') ?? '';
    const cut = renewalCut(preText, postText);
    ({ newSessionId } = cut
      ? await forkSessionAtUserMessage({
        place, sessionId: pre, snapshot: preText,
        userMessageIndex: cut.userMessageIndex, expectedText: cut.text, mode: this.mode,
      })
      : await forkSessionWhole({ place, sessionId: pre, snapshot: preText, mode: this.mode }));
  } finally {
    this._endMutation();
  }
  return { newSessionId, createArgs: await this._finishFork(pre, newSessionId, undefined) };
}

// Both forks' tail, once the copy is written and the claim released: title
// the fork after its source and derive the create() arguments it must be
// spawned with. `prefill` rides along only when defined.
export async function _finishFork(this: Instance, backingId: string, newSessionId: string, prefill: string | undefined): Promise<CreateInstanceInput> {
  // The fork starts titled after its source (forkTitle). Written before the
  // caller's create() so spawn's _hydrateTitle finds it on the new record.
  const title = forkTitle(await getSessionTitle(backingId));
  if (title) await applySessionTitle(null, newSessionId, title);
  // `backend` is REQUIRED here, not optional: the fork copies the jsonl
  // but records no backend for the new sessionId, so
  // create()'s session-store recovery finds nothing. Omitting it silently
  // falls back to the identity `claude` backend while this.model keeps the
  // substitution backend's foreign model id — and because that model is
  // non-null, the BACKEND_MODEL_MISSING guard never fires, so the fork
  // launches a real `claude --model <foreign-id>` against the Anthropic
  // account. contextWindowTokens rides along as the last-known fallback.
  return {
    project: this.project,
    resume: newSessionId,
    mode: this.mode,
    effort: this.effort,
    thinking: this.thinking,
    backend: this.backend,
    model: this.model,
    contextWindowTokens: this.contextWindowTokens,
    worktree: this.worktree?.worktreeName ?? null,
    // EXPLICIT, not inferable: the fork writes no persistent
    // flag for the new id, and create()'s store recovery only ORs persistent
    // in when the flag is already falsy AND the resumed id is marked — so
    // without this the fork of a persistent session comes out silently
    // normal. Set, spawn() marks the new backing id and the child stays
    // listed when it exits; unset, it archives on its own exit.
    // Fork deliberately takes no `_exitSuppressed` the way rewind and
    // prune do: those kill their source and respawn it, so the archive
    // would fire on a session about to come back. Fork never kills
    // anything, so a source exiting mid-fork is a REAL exit and must
    // archive — and that archive's writes (sub-agent dir + the SOURCE
    // transcript's segment flags) are disjoint
    // from this fork's (source jsonl read-only, new id's jsonl + metadata
    // written).
    persistent: this.persistent,
    ...(prefill !== undefined ? { prefill } : {}),
  };
}

// One read of a fork's pinned source file, cut to its complete lines (an
// unterminated tail is a write in progress). `size` is the raw byte length
// read — what the wait compares the file's size against; the text's length
// differs whenever the file holds multibyte characters or a partial line.
export async function _readForkSnapshot(this: Instance, file: string, sessionId: string): Promise<{ text: string; size: number }> {
  let buf: Buffer;
  try { buf = await fsp.readFile(file); }
  catch (e) {
    if (errCode(e) === 'ENOENT') throw httpError(404, `session ${sessionId} not found`);
    throw e;
  }
  return { text: completeLinesOf(buf.toString('utf8')), size: buf.length };
}

// A fork's pin no longer names this instance's live source: its backing id,
// current segment or process changed (a rotation, a crash or a respawn).
export function _forkSourceChanged(this: Instance, pin: ForkPin): boolean {
  return this.backingSessionId !== pin.id || currentSegmentScope(this).startSeq !== pin.startSeq
    || this.proc !== pin.proc;
}

export function _assertForkSourceUnchanged(this: Instance, pin: ForkPin): void {
  if (!this._forkSourceChanged(pin)) return;
  throw httpError(409, 'the session\'s transcript rotated or restarted while the fork was waiting — '
    + 'nothing was written; fork again from the current transcript', { code: FORK_SOURCE_CHANGED });
}

// A fork's wait between reads: sleeps FORK_PERSIST_POLL_MS before every size
// probe, and returns once the pinned file's size differs from `size`, the
// deadline passes, the source changes or the file is gone.
export async function _awaitForkSourceGrowth(this: Instance, pin: ForkPin, size: number, deadline: number): Promise<void> {
  for (;;) {
    await new Promise(r => setTimeout(r, FORK_PERSIST_POLL_MS));
    if (Date.now() >= deadline || this._forkSourceChanged(pin)) return;
    const now = await this._forkSourceSize(pin.file);
    if (now === null || now !== size) return;
  }
}

// The pinned file's size in bytes, or null once it is gone. The test seam
// for the wait's poll rate.
export async function _forkSourceSize(this: Instance, file: string): Promise<number | null> {
  try { return (await fsp.stat(file)).size; }
  catch (e) {
    if (errCode(e) === 'ENOENT') return null;
    throw e;
  }
}

// A bubble's live ordinal → the backing file's prompt ordinal, or null when it
// cannot be placed. Without a live rotation (the current segment's ring
// content starts at seq 0: single segment, or a ring refilled from this file
// by resume/rewind/prune) the two are the same. After one, the offset is
// measured from the current segment's ring content only — an earlier
// segment's echo must not calibrate it. `snapshot` (fork) supplies that ring
// content — null for a segment starting at seq 0 — and the file text from the
// read the copy comes from, so the offset is calibrated on those very bytes;
// without it (rewind) both are taken now.
export async function _fileOrdinalFor(this: Instance, liveIndex: number, snapshot?: {
  sessionId: string; place: TranscriptPlacement; ring: SeqEvent[] | null; text: string;
}): Promise<number | null> {
  let offset: number | null;
  if (snapshot) {
    if (!snapshot.ring) return liveIndex;
    offset = await measureSegmentEchoOffset({
      place: snapshot.place, sessionId: snapshot.sessionId, ring: snapshot.ring, text: snapshot.text,
    });
  } else {
    const scope = currentSegmentScope(this);
    if (scope.startSeq === 0) return liveIndex;
    offset = await measureSegmentEchoOffset({
      place: this.transcriptPlace, sessionId: this.backingSessionId as string,
      ring: this.ringSnapshot().filter(e => e._seq >= scope.startSeq),
    });
  }
  if (offset === null) return null;
  const fileIdx = liveIndex + offset;
  if (fileIdx < 0) throw httpError(400, `userMessageIndex ${liveIndex} out of range (it precedes the current transcript)`);
  return fileIdx;
}
