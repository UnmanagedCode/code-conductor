// Instance's steer/interrupt/drain controller: the deferred (soft) interrupt
// arm and its deadline, the post-abort drain window, and the pending-steer
// queue for models that cannot take a mid-turn injection. Each function runs as
// the instance (`this: Instance`); the class keeps a same-name one-line delegate
// for every one, so callers and tests reach them on the instance. The arm, drain
// and steer state stays on Instance.
import type { Instance, PendingSteer } from '../instances.ts';
import type { Actor } from '../instanceTypes.ts';
import type { PromptAuthor, UiEvent } from '../../shared/uiEvent.ts';
import { combineAuthors } from '../promptAuthor.ts';

// After an abort, the CLI's internal input queue is not cleared. Any messages
// written to stdin before it (a prompt sent mid-turn, or several) remain
// queued; the CLI dequeues them after the abort
// and starts a SPURIOUS NEW TURN for each one. The drain window catches these
// by listening for system/init on the 'event' channel (the earliest per-turn-
// start signal, firing ~39ms before the API round-trip) and immediately firing
// another control_request interrupt to sever the spurious turn.
//
// POST_ABORT_DRAIN_WINDOW_MS — how long to watch after a hard abort. Increase
// if spurious turns are observed arriving later; decrease if the window blocks
// intentional follow-up prompts that come in very quickly after an abort.
const POST_ABORT_DRAIN_WINDOW_MS = 3000;

// How long a stop on a host without a soft SIGTERM (`Platform.softSigterm` false)
// waits, after the interrupt and stdin EOF, for the CLI to exit on its own before
// a tree kill. It must exceed that exit time for a busy turn. To re-measure, on
// such a host kill an instance mid-turn (`Instance.kill`) and time from the
// interrupt write to the process `exit`; raise the constant if the measured time
// comes near it.
export const CLEAN_STOP_GRACE_MS = 5000;
// Safety cap: max spurious turns killed per window. Guards against a
// misbehaving subprocess that emits system/init in a tight loop.
const POST_ABORT_DRAIN_MAX = 20;

// Prepended to user messages delivered while the worker is mid-turn. Keeps
// the user's text verbatim but gives the worker timing context: the message
// may not have been composed in reaction to the latest output.
export const MID_TURN_NOTE =
  '<system-reminder>\n' +
  'The user sent this message while you were mid-turn. They may not have seen your ' +
  'most recent output, and you\'ve continued working since they began composing. ' +
  'This may be new direction or a reaction to earlier work — weigh it accordingly; ' +
  'don\'t assume it refers to your latest action.\n' +
  '</system-reminder>';

// The note that rides a steer delivered AFTER a block-edge stop, on a model that
// cannot take a mid-turn injection (acceptsMidTurnSteering === false). THIS
// CONSTANT IS THE ONLY PLACE THAT DECISION LIVES — the sender never knows which
// delivery mechanism ran, so the fact that the turn was cut off has to be carried
// here rather than written into each caller's text.
//
// Built by splicing an extra clause INTO MID_TURN_NOTE's <system-reminder>
// wrapper, not concatenated after it: that keeps all three signals
// isMidTurnNoteContent (src/parser.ts) matches on — leading '<system-reminder>',
// the 'mid-turn' token, trailing '</system-reminder>' — true by construction. If
// this ever becomes a second, separate block instead, replay renders it as a real
// user bubble and shifts the rewind/fork user-message index
// (docs/components/platform.md → shared/userQuestionAnswers.ts, prefix-safety invariant).
export const POST_STOP_STEER_NOTE = MID_TURN_NOTE.replace(
  '\n</system-reminder>',
  '\n\nYour turn was STOPPED at a block boundary so this message could be delivered — ' +
  'it did NOT run to completion. The work you had already finished is intact, but ' +
  'nothing past that point ran: do not read your own transcript as a completed turn. ' +
  'Decide explicitly whether to resume the interrupted work, abandon it, or clean up ' +
  'after it, and say which.\n</system-reminder>',
);

// Two-tier interrupt, both tiers a real `control_request subtype:interrupt` —
// they differ only in WHEN it fires. FORCED (`force:true`) fires now, severing
// the turn and discarding whatever was in progress. SOFT (default) ARMS a
// DEFERRED interrupt: nothing goes to the CLI until the stream reaches its
// first quiescent point (no block mid-stream, every dispatched tool returned),
// so partial output and finished tool work survive and the model is never
// asked to acknowledge anything — no extra request/response round-trip is
// paid. `interrupting:true` therefore means ARMED, not stopped.
export async function interrupt(this: Instance, { force = false, deadlineMs = 0 }: { force?: boolean; deadlineMs?: number } = {}): Promise<void> {
  if (this.status !== 'turn') return;
  if (force) {
    // Also disarms any pending deferred fire: the abort is happening now, so a
    // later boundary must not send a second control_request. Rolled back in the
    // catch below if the request rejects — see there for why unconditionally.
    this._interruptFired = true;
    // `_turnForceAborted` is set BEFORE the await, and rolled back if the abort
    // is never confirmed.
    // Before is forced by ordering: the CLI's control_response ACK and the
    // abort's own `result` can arrive in the SAME stdout chunk, and stdout lines
    // are handled synchronously in a loop — so turn_end can be processed before
    // the microtask resuming this await ever runs. Setting it afterwards left
    // that turn_end reading `false` and reporting a killed turn as finished.
    // The rollback is what makes set-before safe: a flag latched on an abort
    // that never landed would tell every owner their finished work had been
    // discarded, inviting them to re-drive it.
    //
    // But it rolls back ONLY on the modes that mean "it did not land" — an
    // explicit refusal, dead stdin, `subprocess exited`. A TIMEOUT means the
    // outcome is unknown (the 5s timer deletes _pending, so a CLI that honours
    // the interrupt and ACKs late is dropped), and the two error directions are
    // not symmetric: a false INTERRUPTED costs a conductor some re-driving of
    // good work, while a false "finished its turn" hands it partial output as a
    // complete result — the failure this whole variant exists to prevent. On an
    // unknown outcome the honest report is the pessimistic one, and the cost is
    // bounded to exactly the one turn in doubt: the next turn start finds no
    // surviving wake and clears the flag, so it never reaches a later turn.
    this._turnForceAborted = true;
    try {
      await this._controlRequest({ subtype: 'interrupt' });
    } catch (e) {
      // Unconditional, unlike the qualifier below it, because on an UNKNOWN
      // outcome the safe bet runs the other way for this flag. It is the head
      // guard of _maybeFireArmedInterrupt, so latching it on an abort that may
      // never have landed shuts the SOFT tier off for the rest of the turn —
      // whereas a redundant second interrupt costs nothing. The qualifier's own
      // readers prefer the opposite bet, for the reasons set out where it is set.
      // The soft tier's failure handler clears this flag on every rejection mode
      // too.
      this._interruptFired = false;
      if (!(e as { timedOut?: boolean })?.timedOut) this._turnForceAborted = false;
      throw e;
    }
    // Open the drain window synchronously in the same microtask as the ACK.
    // Any system/init that follows (the CLI dequeuing its leftover input queue)
    // will be caught before the spurious API round-trip begins. Opening here
    // (not before the await) is safe because the CLI emits system/init only
    // AFTER the result/interrupted events that follow the control_response ACK.
    this._openDrainWindow();
    return;
  }
  // Idempotent: one arm per turn (escalate an already-armed turn with force).
  if (this.interrupting) return;
  this.interrupting = true;
  this._interruptArmed = true;
  // Snapshot BEFORE the fire attempt: "a boundary crossed since the arm" is
  // measured from here (see _maybeFireArmedInterrupt).
  this._interruptArmSeq = this._quiescence.boundarySeq;
  if (deadlineMs > 0) this._armInterruptDeadline(deadlineMs);
  this.emit('status', this.summary());
  this._maybeFireArmedInterrupt(); // fires right here if already quiescent
}

// Clear every piece of arm state as one unit — the two flags, the arm-time
// boundary snapshot, and the deadline timer. Called from every place an arm
// ends: exit from `turn`, a (re)spawn, a resume wipe, and a failed fire.
export function _clearInterruptArm(this: Instance): void {
  this._interruptArmed = false;
  this._interruptFired = false;
  this._interruptArmSeq = 0;
  if (this._interruptDeadline) { clearTimeout(this._interruptDeadline); this._interruptDeadline = null; }
}

// The bounded terminal outcome (see SOFT_INTERRUPT_DEADLINE_MS). On expiry the
// arm is still undischarged, so escalate to the FORCED tier — and annotate
// first, naming exactly what withheld the boundary (the held block keys and
// unreturned toolUseIds), so the next report is a one-line diagnosis instead
// of a silent run-to-completion.
export function _armInterruptDeadline(this: Instance, deadlineMs: number): void {
  if (this._interruptDeadline) clearTimeout(this._interruptDeadline);
  this._interruptDeadline = setTimeout(() => {
    this._interruptDeadline = null;
    // Fired already ⇒ the request DID leave; an ACKed-but-not-honoured stop is
    // a different defect with a different flag, not this one.
    if (!this._interruptArmed || this._interruptFired) return;
    if (this.status !== 'turn' || !this.proc) return;
    const blocks = [...this._quiescence.openBlocks.keys()];
    const tools = [...this._quiescence.pendingTools];
    this._emitUi({ kind: 'system', subtype: 'stderr', data: { line:
      `interrupt deadline (${deadlineMs}ms) elapsed with the stop undelivered — forcing. `
      + `blocks still open: [${blocks.join(', ')}]; tools still unreturned: [${tools.join(', ')}]` } });
    this.interrupt({ force: true }).catch(() => {});
  }, deadlineMs);
  // Never hold the event loop open for a stop that is only a backstop.
  this._interruptDeadline.unref?.();
}

// The armed abort's boundary test. Two clauses, and they are NOT symmetric:
//
//   pendingTools empty  — STRICT. A dispatched tool must have returned its
//     result; nothing retires a span but its own tool_result or a turn
//     boundary (parser.ts). This is what keeps finished tool work from being
//     discarded, and it is why S1/S2/S3/D hold indefinitely rather than firing.
//   openBlocks empty OR a boundary crossed since the arm — the added path. On
//     a well-formed stream a block's close is its own event, so `empty` reads
//     true there and this reduces to exactly today's behaviour. On a stream
//     whose closes never arrive, the block is retired by the NEXT block's key
//     — the same event that opens that next block, so `empty` never reads
//     true and only the counter can see it. Cost: the abort lands one block
//     late instead of never.
export function _atInterruptBoundary(this: Instance): boolean {
  const q = this._quiescence;
  if (q.pendingTools.size > 0) return false;
  return q.openBlocks.size === 0 || q.boundarySeq > this._interruptArmSeq;
}

// Fire an armed deferred interrupt if the stream is at a boundary. Called
// from interrupt() (covers arming into an existing gap) and from the tail of
// _emitUi (covers every later event). Deliberately synchronous inside the
// stdout handler — same precedent as the drain listener — and NOT deferred to
// a microtask, which would drain only after the whole readline chunk and could
// let another tool dispatch first.
export function _maybeFireArmedInterrupt(this: Instance): void {
  if (!this._interruptArmed || this._interruptFired) return;
  if (this.status !== 'turn' || !this.proc) return;
  if (!this._atInterruptBoundary()) return;
  this._interruptFired = true;
  this._controlRequest({ subtype: 'interrupt' }).then(
    undefined,
    (e: Error) => {
      // Timed out or the process died mid-flight. Disarm so the UI never
      // sticks on "stopping…" with nothing coming, and clear _interruptFired
      // too: the abort never landed, so this turn must stay RE-ARMABLE (a
      // second ⏸ has to be able to try again). Both flags are cleared BEFORE
      // the annotation is emitted — _emitUi's tail re-runs this method, and an
      // armed-and-unfired state there would spin failed retries.
      this.interrupting = false;
      this._clearInterruptArm();
      this._emitUi({ kind: 'system', subtype: 'stderr',
        data: { line: `interrupt failed: ${e.message}` } });
      this.emit('status', this.summary());
    },
  );
  this._openDrainWindow();
}

// Read-and-clear, called by IdleSubscriptionHub.onTurnStart when NO armed wake
// survived into this turn — i.e. nothing is left that the qualifier could
// describe. That is the hub's single home for the qualifier's lifetime; the only
// other clear is in prompt(), for the case a wake DID survive but a new
// instruction superseded the abort anyway.
export function consumeTurnForceAborted(this: Instance): boolean {
  const was = this._turnForceAborted;
  this._turnForceAborted = false;
  return was;
}

// Send `text` by whichever route this model can actually receive. Which route ran
// is deliberately NOT on the RESULT SHAPE: on both routes the send is pending
// until the answering turn, so a caller has nothing to branch on, and reporting it
// would leak the delivery mechanism into the contract. The routes ARE
// transcript-distinguishable — prompt() emits `user_echo` synchronously, a parked
// steer only at the block edge — which is why send_prompt's description tells
// a conductor that a send it cannot yet see has not failed. Never waits
// for a block edge: a parked steer resolves as soon as it is queued, because the
// stop is unbounded and every caller here is answering a request that must return
// promptly (the WS ack times out in 10s). A parked delivery that fails is
// annotated into the session's own transcript by _flushPendingSteers.
//
// NOT async, and the live branch returns prompt()'s OWN promise rather than a
// wrapper: callers must be able to await the send and run in the SAME microtask
// its completion lands in: the idle wake ARMS inside prompt() → _setStatus, so a
// caller that resumed a tick later could not observe the turn it just started.
export function promptOrQueueSteer(this: Instance, text: string, attachments: unknown[] = [], { author, actor }: { author?: PromptAuthor; actor?: Actor } = {}): Promise<void> {
  this._endPristine();
  if (this.needsPostStopSteer) {
    void this.queueSteerAfterStop(text, { attachments, author, actor }).catch(() => {});
    return Promise.resolve();
  }
  return this.prompt(text, attachments, { author, actor });
}

// Deliver `text` to a model that cannot take a mid-turn injection: stop the
// running turn at the next block edge (the SOFT tier — completed work and
// finished tool results survive, no dangling tool_use), then send the text as a
// fresh turn carrying POST_STOP_STEER_NOTE. Resolves once the text has actually
// reached the CLI; rejects if it never can (the process died first).
//
// Off-turn this is just a prompt on the next microtask — interrupt() no-ops
// when the status is not 'turn', so nothing else would ever wake the queue.
// Coalescing is free: interrupt() is idempotent while armed, so N queued steers
// arm exactly ONE abort and are delivered as one joined message.
//
// Every mid-turn injection site routes here on a model that needs it, through
// promptOrQueueSteer.
export async function queueSteerAfterStop(this: Instance, text: string, opts: { attachments?: unknown[]; author?: PromptAuthor; actor?: Actor } = {}): Promise<void> {
  const entry: PendingSteer = { text, attachments: opts.attachments, author: opts.author, actor: opts.actor, resolve: () => {}, reject: () => {} };
  const p = new Promise<void>((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
  this._pendingSteers.push(entry);
  if (this.status !== 'turn') queueMicrotask(() => this._flushPendingSteers());
  else await this.interrupt();
  return p;
}

// Send every parked steer as ONE fresh turn. Called from the turn_end branch
// (the stop landed, or the turn ended on its own first — one path for both) and
// from queueSteerAfterStop when there was no turn to stop.
export function _flushPendingSteers(this: Instance): void {
  if (!this._pendingSteers.length) return;
  // Drained BEFORE any await, so a second trigger in the same window delivers
  // nothing twice.
  const entries = this._pendingSteers.splice(0);
  const atts = entries.flatMap(e => Array.isArray(e.attachments) ? e.attachments : []);
  // One line, one marker: see combineAuthors.
  const author = combineAuthors(entries.map(e => e.author));
  // The turn's actor: the one sender when every parked steer had the same one.
  // Steers from DIFFERENT conductors open a turn no single conductor owns —
  // `{type:'conductor'}` with no sessionId, never the root, who may be
  // neither sender. Any other mix falls back to the combined author.
  const same = entries.every(e => JSON.stringify(e.actor) === JSON.stringify(entries[0].actor));
  const actor: Actor | undefined = same ? entries[0].actor : author === 'conductor' ? { type: 'conductor' } : undefined;
  this.prompt(entries.map(e => e.text).join('\n\n'), atts, { midTurnNote: POST_STOP_STEER_NOTE, author, ...(actor ? { actor } : {}) }).then(
    () => {
      for (const e of entries) e.resolve();
      // prompt() can return WITHOUT starting a turn (the overage queue
      // intercept), so no turn_end is coming to flush a wake deferred behind
      // this steer. Say so rather than let it strand.
      if (this.status !== 'turn') this._emitSteerSettled();
    },
    (err: Error) => {
      this._emitUi({ kind: 'system', subtype: 'stderr',
        data: { line: `deferred steer delivery failed: ${err.message}` } });
      for (const e of entries) e.reject(err);
      this._emitSteerSettled();
    },
  );
}

// Announce that the steer queue drained without a turn to end. IdleSubscriptionHub
// treats this exactly like the turn_end it was waiting for, so a wake deferred
// behind a steer is never stranded by a failed or overage-queued delivery.
export function _emitSteerSettled(this: Instance): void {
  this._emitUi({ kind: 'system', subtype: 'steer_settled', data: { pending: this._pendingSteers.length } });
}

// Open a drain window after a hard abort. Attaches a one-time-per-event
// listener on 'event' that watches for system/init — the earliest signal
// that the CLI has dequeued a leftover message and started a spurious new
// turn. On each hit, fires _controlRequest interrupt immediately (before
// the API round-trip) and slides the window deadline so a queue of N
// messages is fully drained. Closes automatically when the window elapses
// with no new turn-start, or earlier when an explicit prompt() is called.
export function _openDrainWindow(this: Instance): void {
  this._closeDrainWindow(); // cancel any prior window
  let drainCount = 0;

  const onEvent = (ev: UiEvent): void => {
    if (ev.kind !== 'system' || ev.subtype !== 'init') return;
    if (drainCount >= POST_ABORT_DRAIN_MAX) {
      console.error(
        `[code-conductor] post-abort drain safety cap (${POST_ABORT_DRAIN_MAX}) reached on instance ${this.id} — closing window`,
      );
      this._closeDrainWindow();
      return;
    }
    drainCount += 1;
    this._emitUi({ kind: 'system', subtype: 'drain_abort', data: { count: drainCount } });
    // Slide the window: another queued message could follow, extend deadline.
    // _drainTimer is always set by the time an event can fire (the listener
    // is attached before the initial timer below), so the guard is type-level.
    if (this._drainTimer) clearTimeout(this._drainTimer);
    this._drainTimer = setTimeout(() => this._closeDrainWindow(), POST_ABORT_DRAIN_WINDOW_MS);
    this._drainTimer.unref?.();
    // Kill the spurious turn immediately, before any API round-trip.
    this._controlRequest({ subtype: 'interrupt' }).catch(() => {});
  };

  this._drainListener = onEvent;
  this.on('event', onEvent);

  this._drainTimer = setTimeout(() => this._closeDrainWindow(), POST_ABORT_DRAIN_WINDOW_MS);
  this._drainTimer.unref?.(); // don't keep the process alive for the window alone
}

export function _closeDrainWindow(this: Instance): void {
  if (this._drainTimer) { clearTimeout(this._drainTimer); this._drainTimer = null; }
  if (this._drainListener) { this.off('event', this._drainListener); this._drainListener = null; }
}

// A stop where SIGTERM is not soft must not cut a busy turn off: interrupt it so
// the CLI records the interrupted turn. Callers end stdin next; the pipe orders
// the two writes. That turn's turn_end is not a turn finishing — see _stopInterruptedTurn.
export function interruptTurnForStop(this: Instance): void {
  if (this.status !== 'turn') return;
  this._stopInterruptedTurn = true;
  this._controlRequest({ subtype: 'interrupt' }, { timeout: CLEAN_STOP_GRACE_MS }).catch(() => {});
}
