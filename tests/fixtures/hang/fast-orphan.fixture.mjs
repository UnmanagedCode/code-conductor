// A leak from a file too fast to be sampled: the file completes in ~30ms, well
// inside one 100ms sampler tick, so the orphan is never recorded by parentage;
// and its parent exits immediately, so the orphan is reparented to init and no
// descendants() walk from the runner can reach it either.
//
// Unlike detached-orphan.fixture.mjs the child is NOT detached, so it stays in
// the runner's process group — which is what makes it identifiable and killable
// (see orphansInOurGroup in tests/procTree.mjs). It is unref()'d so Layer B sees
// no ref'd handle and the file reports normally, which is what made the old
// `reported`-gated sweep switch itself off.
import test from 'node:test';
import { spawn } from 'node:child_process';

test('fast-orphan: leaks a same-process-group orphan from a sub-tick file', () => {
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: 'inherit' });
  orphan.unref();
});
