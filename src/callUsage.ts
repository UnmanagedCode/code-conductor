// Per-API-call context figures for the `call_usage` event (docs/protocol.md).
//
// Instance._emitUi drives this from its context latch: each top-level call's
// message_start hands in the latch's reading from BEFORE that call updates it,
// so the baseline is null exactly when the latch is (a fresh session, and the
// first call after any _dropContextReading). Growth is therefore this call's
// prompt minus the previous measured call's: that call's output plus whatever
// was appended since (tool results, a user message, injected context, hook
// output). It is not attribution to any one of those.
//
// The tracker also derives the turn's growth for `turn_end`: the turn-end
// reading minus the first opened call's baseline, published only when it
// equals the sum of the turn's stamped growths (a call cut off before its
// message_delta moves the baseline without a line, and so voids the turn).
//
// Live only. Replay emits no call_usage, and neither UsageTracker, the latch
// nor the cache-miss bookkeeping reads it.

import { contextReading } from './sessionPrune.ts';
import type { UiEvent } from './parser.ts';

export class CallUsageTracker {
  // The open call — the last one whose message_start reached the tracker — and
  // its figures. Replaced by the next message_start, so an interrupted call
  // that never reached message_delta stamps nothing and leaves nothing behind.
  // Keyed by msgId: a call whose message_start the parser suppressed (one with
  // no usage at all) never opens, so its line must not inherit these.
  _msgId: string | null = null;
  _baseline: number | null = null;
  _prompt: number | null = null;
  // The turn: whether a call has opened since the last endTurn, the first
  // opened call's baseline, and the sum of the turn's stamped non-null growths
  // (null until the first, so a turn that measured nothing has no sum).
  _turnOpen = false;
  _turnBaseline: number | null = null;
  _turnSum: number | null = null;

  // `prevReading` is the latch's reading before this call; `usage` is the
  // message_start's (null on a backend whose message_start is all-zero).
  onMessageStart(msgId: unknown, prevReading: number | null, usage: unknown): void {
    if (!this._turnOpen) {
      this._turnOpen = true;
      this._turnBaseline = prevReading;
      this._turnSum = null;
    }
    this._msgId = typeof msgId === 'string' ? msgId : null;
    this._baseline = prevReading;
    this._prompt = contextReading(usage);
  }

  // The fallback reading for the open call on a zero-usage backend. A reading
  // for any other call opens nothing: its baseline was never captured.
  onContextUsage(msgId: unknown, usage: unknown): void {
    if (!this._isOpen(msgId)) return;
    const prompt = contextReading(usage);
    if (prompt != null) this._prompt = prompt;
  }

  stamp(ev: UiEvent): void {
    const open = this._isOpen(ev.msgId);
    const prompt = open ? this._prompt : null;
    const baseline = open ? this._baseline : null;
    ev.promptTokens = prompt;
    const growth = prompt != null && baseline != null ? prompt - baseline : null;
    ev.growthTokens = growth;
    if (growth != null) this._turnSum = (this._turnSum ?? 0) + growth;
  }

  // The turn's growth for `turn_end`, given its end reading; null unless it
  // equals the sum of the turn's stamped growths. Closes the turn either way.
  endTurn(contextTokens: number | null): number | null {
    const growth = this._turnOpen && this._turnBaseline != null && contextTokens != null
      ? contextTokens - this._turnBaseline : null;
    const sum = this._turnSum;
    this._turnOpen = false;
    this._turnBaseline = null;
    this._turnSum = null;
    return growth != null && sum != null && growth === sum ? growth : null;
  }

  // Leaves _turnOpen alone, so a reset mid-turn voids the turn: no later call
  // in it can re-baseline it.
  reset(): void {
    this._msgId = null;
    this._baseline = null;
    this._prompt = null;
    this._turnBaseline = null;
    this._turnSum = null;
  }

  _isOpen(msgId: unknown): boolean {
    return this._msgId !== null && msgId === this._msgId;
  }
}
