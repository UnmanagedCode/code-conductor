// The orphan shape the per-file `reported` gate used to switch the sweep OFF.
//
// Critically different from orphan-grandchild.fixture.mjs: that one leaks a
// REF'D ChildProcess, so Layer B trips, exits the child, and the file never
// reports — which meant it only ever exercised the sub-case that did not need
// sweeping. Here the child is `detached` and `unref()`'d, so Layer B sees no
// ref'd handle and stays silent, the child exits cleanly, and the file's
// summary ARRIVES. The orphan still holds our inherited stdio, so the stream
// never ends.
//
// It also completes in ~35ms — under one 100ms sampler tick — so the orphan is
// never recorded by parentage either, and is reparented to init immediately.
// Only channel-based discovery can find it.
import test from 'node:test';
import { spawn } from 'node:child_process';

// The holder SELF-TERMINATES after 60s. That is deliberate hygiene, not part of
// the behaviour under test: a detached orphan is by design the one shape the
// sweep cannot identify or kill (see the sweep note in tests/run.mjs), so an
// immortal holder here would leak one live process onto the box on EVERY suite
// run — this card's own failure class, in this card's own fixture. 60s is far
// beyond the stall grace the test actually measures (ORPHAN_SWEEP_MS, squeezed
// to ~1.5s under test), so the outcome being pinned is unaffected.
test('detached-orphan: reports cleanly, then outlives itself on our stdio', () => {
  const orphan = spawn(process.execPath,
    ['-e', 'setTimeout(() => process.exit(0), 60_000)'],
    { stdio: 'inherit', detached: true });
  orphan.unref();
});
