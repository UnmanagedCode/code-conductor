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

test('detached-orphan: reports cleanly, then outlives itself on our stdio', () => {
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: 'inherit', detached: true });
  orphan.unref();
});
