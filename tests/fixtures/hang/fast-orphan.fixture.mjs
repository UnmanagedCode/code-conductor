// A leak from a file too fast to be sampled: the file completes in ~30ms, well
// inside one 100ms sampler tick, so the orphan is never recorded by parentage;
// and its parent exits immediately, so the orphan is reparented to init and no
// descendants() walk from the runner can reach it either.
//
// Unlike detached-orphan.fixture.mjs the child is NOT detached — but that buys
// nothing for identification, and process-group membership has identified
// nothing since card 2026-0190 replaced that heuristic (see the note on
// processesWithMarker in tests/procTree.mjs for why it was unsafe). The parent
// exits immediately regardless, so the orphan is reparented to init and escapes
// a lineage walk exactly as a detached one would. The only thing that still
// identifies it is the run marker in its environment (processesWithMarker in
// tests/procTree.mjs) — which makes this fixture the UNIQUE pin on that source.
// Neither sibling substitutes: orphan-grandchild's holder is non-detached AND
// its parent outlives it, so the sampler records it under fileDescendants and
// the LINEAGE source still sweeps it; detached-orphan is marker-only too, but
// its case asserts the STREAM STALL, which bounds the run with no /proc at all.
//
// It is unref()'d so Layer B sees no ref'd handle and the file reports normally,
// which is what made the old `reported`-gated sweep switch itself off.
import test from 'node:test';
import { spawn } from 'node:child_process';

test('fast-orphan: leaks a marker-only orphan from a sub-tick file', () => {
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: 'inherit' });
  orphan.unref();
});
