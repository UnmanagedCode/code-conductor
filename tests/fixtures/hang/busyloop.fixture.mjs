// A wedge no in-child mechanism can reach: the event loop never turns, so the
// per-test timeout timer cannot fire and even --test-force-exit's exit handler
// never runs. Only Layer A's SIGKILL from the parent ends this.
import test from 'node:test';

test('busyloop: never yields the event loop', () => {
  for (;;) { /* spin forever */ }
});
