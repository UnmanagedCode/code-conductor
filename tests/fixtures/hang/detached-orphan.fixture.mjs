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
// Being detached, it is not in the runner's process group. The only thing that
// still identifies it is the run marker in its environment (processesWithMarker
// in tests/procTree.mjs).
import test from 'node:test';
import { spawn } from 'node:child_process';

// The holder SELF-TERMINATES. That is deliberate hygiene, not part of the
// behaviour under test: an immortal holder would leak one live process onto the
// box on EVERY suite run — this card's own failure class, in this card's own
// fixture, which it has already shipped twice.
//
// ITS LIFETIME IS AN INPUT, because the shape's validity depends on an
// inequality: if the stall grace ever exceeded the holder's life the holder would
// die first, the stream would end by itself, and this fixture would PASS while
// proving nothing (demonstrated: grace pushed past the holder makes it pass at
// 60.2s). The test owns that inequality and asserts it, passing the lifetime in
// here so there is one source for it rather than two that can drift.
const HOLDER_LIFETIME_MS = Number(process.env.CC_TEST_HOLDER_LIFETIME_MS ?? 60_000);

test('detached-orphan: reports cleanly, then outlives itself on our stdio', () => {
  const orphan = spawn(process.execPath,
    ['-e', `setTimeout(() => process.exit(0), ${HOLDER_LIFETIME_MS})`],
    { stdio: 'inherit', detached: true });
  orphan.unref();
});
