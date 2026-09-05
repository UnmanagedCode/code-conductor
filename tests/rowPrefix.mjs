// Line-aligned row tagging for the gate's live tee (card 2026-0344).
//
// `gate:systems` runs its two rows concurrently, so their output interleaves on
// one terminal. This tags each row's lines — `[1] `, `[2] ` — mapped to names by
// the banner the gate prints before either row starts.
//
// A Transform INSIDE the existing `.pipe()` chain, never a `write()` loop.
// Backpressure is the whole risk in that tee (tests/systems-gate.mjs's header,
// card 2026-0290 §5c): `process.stdout.write` is asynchronous once stdout is a
// pipe, so a fire-and-forget tee drops output under load — the exact failure the
// closing block exists to end. A Transform in the chain propagates a false write
// back to the child's stdout exactly as the direct pipe did.
//
// It buffers a partial trailing line rather than tagging chunks, because a chunk
// boundary falls wherever the kernel puts it: tagging per chunk would plant `[1] `
// mid-line. Each `push` therefore carries only WHOLE tagged lines, and `_flush`
// emits any final fragment — a runner killed mid-write must not lose its last
// line, which can be the verdict.
//
// `decodeStrings: false` because the caller has already set `setEncoding('utf8')`
// on the child stream: `✖` is three bytes and a boundary through the middle of it
// would corrupt the tee. The decoder holds the partial sequence back upstream, and
// this must not undo that by re-buffering it.

import { Transform } from 'node:stream';

export function createRowPrefix(tag) {
  let partial = '';
  return new Transform({
    decodeStrings: false,
    transform(chunk, _enc, cb) {
      partial += chunk;
      let out = '';
      let nl;
      while ((nl = partial.indexOf('\n')) !== -1) {
        out += tag + partial.slice(0, nl + 1);
        partial = partial.slice(nl + 1);
      }
      if (out !== '') this.push(out);
      cb();
    },
    flush(cb) {
      if (partial !== '') this.push(tag + partial);
      partial = '';
      cb();
    },
  });
}
