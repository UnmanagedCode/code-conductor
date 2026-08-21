// Reaches RUN-CAP territory with NO sweepable orphan, so the cap itself is the
// only thing that can end the run. Pins that the cap timer is REF'D: an unref'd
// cap cannot fire once the loop has otherwise drained, and the runner would then
// exit 0 naturally, skipping the verdict entirely — a silent green.
//
// Mechanism: hold the inherited stdio open from a process that is NOT a
// descendant and NOT reachable through our channels — a `setsid`-style
// double-fork would still be channel-discoverable, so instead this file keeps
// its OWN stdio write end alive in a process that closes every inherited fd
// except a dup of stderr, which it never writes to. See the sweep note in
// tests/run.mjs for why channel discovery is otherwise exhaustive.
import test from 'node:test';
import { spawn } from 'node:child_process';

test('stream-never-ends: leaves the report channel held by an unreachable holder', () => {
  // stdio:'ignore' for stdin/stdout but INHERIT stderr, then detach+unref.
  // Nothing here is a ref'd handle, nothing is a live descendant.
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: ['ignore', 'ignore', 'inherit'], detached: true });
  holder.unref();
});
