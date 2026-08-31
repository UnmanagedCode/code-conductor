// Output accounting for one `exec`, shared by BOTH implementations of the
// primitive: the in-process runner (src/groupedCommand.ts) and the wire one
// (src/systems/providerSystem.ts).
//
// It lives on its own because the two must be indistinguishable. Every subtlety
// here — the per-stream decoder, the tail cap that also clips the interleaved
// `output`, the head cap that keeps DRAINING after it stops retaining, the
// max-buffer fence that is a FAILURE rather than a truncation — is behaviour
// callers already depend on, and a second copy of it would drift on the first
// bug fixed in one of them.

import { StringDecoder } from 'node:string_decoder';
import type { SystemErrorCode } from './protocol.ts';
import type { ExecOptions, ExecResult, ExecStream } from './system.ts';

export type StreamName = ExecStream;

// The accounting subset of ExecOptions. Taking the whole ExecOptions would drag
// cwd/env/timeout in, which are the SPAWN half and belong to the caller.
export type ExecAccounting = Pick<ExecOptions, 'cap' | 'headCapBytes' | 'maxBufferBytes' | 'onChunk'>;

export class ExecOutputCollector {
  #stdout = '';
  #stderr = '';
  #output = '';
  #truncated = false;
  // Bytes retained so far under a HEAD cap, shared across both streams. Whole
  // chunks are kept until the budget is met, so retention can overshoot by at
  // most one chunk; past that the streams are still drained (the command runs to
  // completion) but nothing more is kept.
  #headBytes = 0;
  // Bytes seen across both streams, and whether they crossed maxBufferBytes.
  // Crossing it KILLS the command: the ceiling is a fence, not a cap, so there
  // is nothing to gain by letting it keep producing output nobody will keep —
  // and the memory it was about to cost is the whole point.
  #seenBytes = 0;
  #overflowed = false;
  readonly #decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };
  readonly #opts: ExecAccounting;
  readonly #onOverflow: () => void;

  constructor(opts: ExecAccounting, onOverflow: () => void) {
    this.#opts = opts;
    this.#onOverflow = onOverflow;
  }

  get overflowed(): boolean { return this.#overflowed; }

  #clip(s: string): string {
    const { cap } = this.#opts;
    if (cap === undefined || s.length <= cap) return s;
    this.#truncated = true;
    return s.slice(-cap);
  }

  push(which: StreamName, chunk: Buffer): void {
    const { maxBufferBytes, headCapBytes, onChunk } = this.#opts;
    let d = chunk;
    if (maxBufferBytes !== undefined) {
      // Everything after the fence is discarded, so the failure carries exactly
      // the first `maxBufferBytes` of output.
      if (this.#overflowed) return;
      const room = maxBufferBytes - this.#seenBytes;
      this.#seenBytes += d.length;
      if (this.#seenBytes > maxBufferBytes) {
        this.#overflowed = true;
        d = d.subarray(0, Math.max(0, room));
        this.#onOverflow();
        if (d.length === 0) return;
      }
    }
    if (headCapBytes !== undefined) {
      if (this.#headBytes >= headCapBytes) { this.#truncated = true; return; }
      this.#headBytes += d.length;
      if (this.#headBytes >= headCapBytes) this.#truncated = true;
    }
    const s = this.#decoders[which].write(d);
    if (!s) return;
    if (which === 'out') this.#stdout = this.#clip(this.#stdout + s);
    else this.#stderr = this.#clip(this.#stderr + s);
    this.#output = this.#clip(this.#output + s);
    // AFTER the caps, deliberately: a streaming consumer must see exactly what
    // is retained, or a capped command would show a live tail the buffered
    // result does not contain.
    onChunk?.(s, which);
  }

  // On a spawn error the message becomes the diagnostic. It fills whichever
  // buffers are still empty — in practice all of them, since the error fires
  // before any data — so `output`-reading and `stderr`-reading callers both see
  // it without either clobbering real output.
  result(
    code: number,
    { timedOut, spawnError, spawnErrorCode, transportFailure, durationMs, descendantsMaySurvive }: {
      timedOut: boolean; spawnError?: string; spawnErrorCode?: SystemErrorCode; transportFailure?: true;
      durationMs: number; descendantsMaySurvive?: boolean;
    },
  ): ExecResult {
    let stderr = this.#stderr;
    let output = this.#output;
    let truncated = this.#truncated;
    if (spawnError) {
      if (!stderr) stderr = spawnError;
      if (!output) output = spawnError;
    }
    if (this.#overflowed) {
      // Loud, and in the field callers read the diagnostic from: `stderr ||
      // stdout` is the near-universal shape here, so leaving stderr empty would
      // promote megabytes of partial output into an error message.
      const msg = `output exceeded the ${this.#opts.maxBufferBytes}-byte limit — command killed`;
      stderr = stderr ? `${stderr}\n${msg}` : msg;
      truncated = true;
    }
    return {
      // An overflow is a FAILURE, not a truncated success (see maxBufferBytes):
      // the exit code the killed child reports is meaningless, so it is 1.
      code: timedOut ? 124 : this.#overflowed ? 1 : code,
      stdout: this.#stdout, stderr, output,
      timedOut, truncated,
      durationMs,
      spawnError: spawnError ?? null,
      ...(spawnErrorCode ? { spawnErrorCode } : {}),
      ...(transportFailure ? { transportFailure: true as const } : {}),
      ...(descendantsMaySurvive ? { descendantsMaySurvive: true as const } : {}),
      ...(this.#overflowed ? { outputOverflowed: true as const } : {}),
    };
  }
}
