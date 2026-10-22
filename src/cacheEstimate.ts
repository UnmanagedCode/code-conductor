// The cache-read estimate for a non-Claude backend whose calls report no cache
// read (docs/architecture.md → src/cacheEstimate.ts).
//
// Such a backend counts every call's whole context as input, so a turn's
// `result.usage` reads cache_read 0 however much the provider actually served
// from cache. Each call's cached share is estimated as
//   min(P, B)   with P = this call's prompt, B = the previous call's prompt + output
// — the cache holds the previous call's context including what it generated,
// and this call's new input is P − cached. A first call (no B), a prompt that
// shrank below the previous one, and the first call after a reset count as
// uncached. The turn's sum then re-splits `result.usage.input_tokens` into
// uncached input + cache read; the reported total is never changed.
//
// Instance._emitUi feeds it each top-level call's final message_delta figures
// (the parser's `call_usage`) and the resume seed; Instance._handleStdoutLine
// reads it at turn_end. Claude sessions never consult it.

import { promptTokenSum } from './parser.ts';
import type { Usage } from '../shared/usage.ts';

// One call's final usage as `call_usage` carries it; null is a key the
// message_delta did not send.
export interface CallCacheUsage {
  inputTokens: number | null;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

export interface CacheEstimate {
  inputTokens: number;
  cacheReadTokens: number;
}

export class CacheEstimator {
  // Set by the first call whose delta carries cache_read_input_tokens: from
  // then on a keyless call is a genuine miss reported as zero, not an
  // unreported read. Survives reset(); cleared by resetCapability().
  _reportsCache = false;
  _baseline: number | null = null;
  _prevPrompt: number | null = null;
  _turnSum = 0;
  _turnEstimated = false;

  onCall(call: CallCacheUsage): void {
    if (call.cacheReadTokens !== null) this._reportsCache = true;
    if (call.inputTokens === null) {
      // No prompt size, so neither this call nor the next can be estimated.
      this._baseline = null;
      this._prevPrompt = null;
      return;
    }
    const prompt = call.inputTokens + (call.cacheCreationTokens ?? 0) + (call.cacheReadTokens ?? 0);
    if (!this._reportsCache) {
      const shrank = this._prevPrompt !== null && prompt < this._prevPrompt;
      this._turnSum += this._baseline === null || shrank ? 0 : Math.min(prompt, this._baseline);
      this._turnEstimated = true;
    }
    this._baseline = prompt + call.outputTokens;
    this._prevPrompt = prompt;
  }

  // The resume seed: the replayed transcript's last assistant usage is the
  // context the provider last cached.
  seed(usage: Usage): void {
    const prompt = promptTokenSum(usage);
    this._baseline = prompt + (usage.output_tokens ?? 0);
    this._prevPrompt = prompt;
  }

  // The context was replaced (compaction, /clear, model switch, rewind /
  // respawn / prune): nothing of the next call is cached. The turn's sum so far
  // stands — those calls were estimated against the context they ran on.
  reset(): void {
    this._baseline = null;
    this._prevPrompt = null;
  }

  // The {backend, model} pair changed: what the old one reported says nothing
  // about the new one.
  resetCapability(): void {
    this.reset();
    this._reportsCache = false;
    this._turnSum = 0;
    this._turnEstimated = false;
  }

  // The turn's re-split of `usage.input_tokens`, or null when nothing was
  // estimated, there is no usage, or the turn reports a cache read of its own.
  // Closes the turn either way.
  endTurn(usage: Usage | null): CacheEstimate | null {
    const sum = this._turnSum;
    const estimated = this._turnEstimated;
    this._turnSum = 0;
    this._turnEstimated = false;
    if (!estimated || !usage || typeof usage.input_tokens !== 'number') return null;
    if ((usage.cache_read_input_tokens ?? 0) > 0) return null;
    if (sum > usage.input_tokens) {
      console.warn(`cache-estimate: estimated cache read ${sum} exceeds the turn's reported input ${usage.input_tokens}; not estimating`);
      return null;
    }
    return { inputTokens: usage.input_tokens - sum, cacheReadTokens: sum };
  }
}
