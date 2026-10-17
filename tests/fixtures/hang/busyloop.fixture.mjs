// A wedge no in-child mechanism can reach: the event loop never turns, so the
// per-test timeout timer cannot fire and even --test-force-exit's exit handler
// never runs. Only Layer A's SIGKILL from the parent ends this.
//
// The marker is held back by the quiet reporter while the file is running, so
// its arrival proves the held output is printed on both ends this file meets:
// the per-file kill and the run cap.
import test from 'node:test';
import { writeSync } from 'node:fs';

test('busyloop: never yields the event loop', () => {
  writeSync(2, 'busyloop: entering the spin\n');
  for (;;) { /* spin forever */ }
});
