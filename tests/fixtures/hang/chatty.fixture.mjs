// A completely HEALTHY file that produces ~4MB of stdout.
//
// It exists to exercise the slow-stdout-consumer shape, not any defect. The
// ledger settles from events on the SOURCE stream (which fire at push time),
// while the wait is on the COMPOSED reporter, whose `end` is deferred by
// backpressure from `reporter.pipe(process.stdout)`. Piped into a pager or onto a
// slow disk, every file settles while `end` is still blocked — and the stall
// check must NOT read that as a leaked process.
//
// THE VOLUME MATTERS AND IS NOT ARBITRARY. Measured: at ~200KB the runner still
// finishes in ~120ms even with a fully paused reader, because the OS pipe (64KB)
// plus libuv's in-memory write queue absorb everything and `run.mjs`'s closing
// `process.exit()` discards the remainder — so the false positive does NOT
// reproduce and a test built at that size would pass against the broken code.
// At ~4MB backpressure genuinely defers `end`, and with the gate removed the run
// declares STREAM STALLED and exits 1 at ~1.8s. Do not shrink this fixture — a
// shrink now goes loud red rather than silently green, via the
// `wallMs > PAUSE * 0.9` assertion in the slow-consumer case of
// tests/hang-guard-run-cap.test.mjs (measured 4022ms at 400 tests vs 117ms at 20).
//
// Nothing here leaks, nothing hangs, and the run must be green.
import test from 'node:test';

const CHUNK = 'x'.repeat(1024);

for (let i = 0; i < 400; i++) {
  test(`chatty: emits a lot of stdout (${i})`, () => {
    // ~10KB per test x 400 tests ≈ 4MB.
    for (let j = 0; j < 10; j++) console.log(`${i}:${j}:${CHUNK}`);
  });
}
