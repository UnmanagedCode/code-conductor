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
// Live only. Replay emits no call_usage, and neither UsageTracker, the latch
// nor the cache-miss bookkeeping reads it.

import { contextReading } from './sessionPrune.ts';
import type { UiEvent } from './parser.ts';

export class CallUsageTracker {
  // The open call's figures. Replaced by the next message_start, so an
  // interrupted call that never reached message_delta stamps nothing and leaves
  // nothing behind.
  _baseline: number | null = null;
  _prompt: number | null = null;

  // `prevReading` is the latch's reading before this call; `usage` is the
  // message_start's (null on a backend whose message_start is all-zero).
  onMessageStart(prevReading: number | null, usage: unknown): void {
    this._baseline = prevReading;
    this._prompt = contextReading(usage);
  }

  // The fallback reading for the same call on a zero-usage backend.
  onContextUsage(usage: unknown): void {
    const prompt = contextReading(usage);
    if (prompt != null) this._prompt = prompt;
  }

  stamp(ev: UiEvent): void {
    ev.promptTokens = this._prompt;
    ev.growthTokens = this._prompt != null && this._baseline != null ? this._prompt - this._baseline : null;
  }

  reset(): void {
    this._baseline = null;
    this._prompt = null;
  }
}
